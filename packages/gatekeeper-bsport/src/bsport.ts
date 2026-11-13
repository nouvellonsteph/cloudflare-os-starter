import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, ResourceDescription,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, connectMutationError, escapeHtml, htmlResponse, INVALID_LINK_HTML, PAGE_STYLE } from "@gadgets/gatekeeper-kit/connect-pages";
import { generateNonce, isLiveNonce, type TimedNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { commitStagedCredentials, discardStagedCredentials, peekStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { companyId, ensureConfigured, isAllowedEmail, type BsportEnv } from "./env.js";
import { verifyOwner, type OwnerIdentity } from "./identity.js";
import { parseResourceUrl, resourceType, resourceUrl, supportedResources, validateSubresources, type Resource } from "./resources.js";
import { BsportClient, BsportError } from "./client.js";
import { ReadContext, sessionFor, type Session } from "./sessions.js";
import TYPES from "./types.txt";
import CONFIGURATOR from "./generated/bsport-configurator-ui.txt";
import { BSPORT_ICON } from "./logo.js";

const FLOW_TTL = 10 * 60 * 1000;
type Props = { accountId: string };
type BindingProps = Props & { resource: Resource };
type Entitlement = OwnerIdentity & { company: number; client: string; franchisor: string | null; issuer: string; audience: string };
type Flow = TimedNonce & { reconnect: boolean };

@validateRpc()
class ConfiguratorUi extends RpcTarget { ready(): void {} }

function account(env: BsportEnv, id: string): DurableObjectStub<BsportAccount> {
  return env.BSPORT_ACCOUNTS.get(env.BSPORT_ACCOUNTS.idFromString(id));
}

/** Entitlements pin the source/tenant and identity realm, so a config edit cannot retarget old grants. */
function entitlement(identity: OwnerIdentity, env: BsportEnv): Entitlement {
  return { ...identity, company: companyId(env), client: env.BSPORT_CLIENT_ID, franchisor: env.BSPORT_FRANCHISOR_ID ?? null, issuer: env.CF_ACCESS_ISS, audience: env.CF_ACCESS_AUD };
}

function validEntitlement(value: Entitlement | undefined, env: BsportEnv): value is Entitlement {
  return value !== undefined && isAllowedEmail(env, value.email) &&
    value.company === companyId(env) && value.client === env.BSPORT_CLIENT_ID && value.franchisor === (env.BSPORT_FRANCHISOR_ID ?? null) &&
    value.issuer === env.CF_ACCESS_ISS && value.audience === env.CF_ACCESS_AUD;
}

/** Per-connection identity, status and single-use handoff state. The API key never enters storage. */
@validateRpc()
export class BsportAccount extends DurableObject<BsportEnv> {
  @skipRpcValidation()
  async begin(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("callback")) throw new Error("Connection already initialized.");
    ensureConfigured(this.env);
    this.ctx.storage.kv.put("callback", callback);
    return this.#newFlow(false);
  }

  async #newFlow(reconnect: boolean): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("bsport connection is revoked.");
    discardStagedCredentials(this.ctx.storage.kv);
    const flow: Flow = { value: generateNonce(), expiresAt: Date.now() + FLOW_TTL, reconnect };
    this.ctx.storage.kv.put("flow", flow);
    await this.ctx.storage.setAlarm(flow.expiresAt + FLOW_TTL);
    const url = new URL(`${this.env.BASE_URL}/connect`);
    url.searchParams.set("account", this.ctx.id.toString());
    url.searchParams.set("nonce", flow.value);
    return { url: url.href };
  }

  async assertLive(): Promise<void> {
    ensureConfigured(this.env);
    if (this.ctx.storage.kv.get("revoked") || !validEntitlement(this.ctx.storage.kv.get<Entitlement>("owner"), this.env)) {
      throw new Error("bsport connection is not authorized.");
    }
  }

  async sameConnection(expectedAccount: string): Promise<boolean> {
    if (expectedAccount !== this.ctx.id.toString() || this.ctx.storage.kv.get("revoked")) return false;
    await this.assertLive();
    return true;
  }

  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
    this.ctx.storage.kv.delete("owner");
    this.ctx.storage.kv.delete("flow");
    discardStagedCredentials(this.ctx.storage.kv);
  }

  async reconnect(): Promise<{ url: string }> {
    if (this.ctx.storage.kv.get("revoked") || !this.ctx.storage.kv.get("owner")) throw new Error("Connect a new bsport account.");
    ensureConfigured(this.env);
    return this.#newFlow(true);
  }

  async commitReconnect(stageId: string): Promise<void> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("bsport connection is revoked.");
    const staged = commitStagedCredentials<Entitlement>(this.ctx.storage.kv, Date.now(), stageId);
    const owner = this.ctx.storage.kv.get<Entitlement>("owner");
    if (!validEntitlement(staged ?? undefined, this.env) || owner?.subject !== staged!.subject || owner.email !== staged!.email) throw new Error("Invalid bsport reconnect stage.");
    this.ctx.storage.kv.put("owner", staged);
  }

  /** The shared key is service authentication, never a collaborator entitlement. */
  async permits(expectedAccount: string, values: string[]): Promise<boolean> {
    validateSubresources(values, companyId(this.env));
    if (!await this.sameConnection(expectedAccount)) return false;
    try {
      await new BsportClient(this.env).verifyAccess(values);
    } catch (error) {
      // Expired credentials (401), rate limits and outages are indeterminate and propagate.
      if (error instanceof BsportError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
    await this.assertLive();
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const identity = await verifyOwner(request, this.env);
    if (!identity) return htmlResponse("Owner authentication required.", 403);
    const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (this.ctx.storage.kv.get("revoked") || !isLiveNonce(flow, nonce, Date.now())) return htmlResponse(INVALID_LINK_HTML, 400);
    const owner = this.ctx.storage.kv.get<Entitlement>("owner");
    if (flow!.reconnect && (owner?.subject !== identity.subject || owner.email !== identity.email)) return htmlResponse("Owner authentication required.", 403);
    if (request.method === "GET") {
      const response = htmlResponse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect bsport</title><style>${PAGE_STYLE}</style><body><main><h1>Connect bsport read-only</h1><p>Allow this connection to read company ${companyId(this.env)} using the deployment-managed key. No token is entered here. Results remain private to this connection.</p><form method="post"><button type="submit">Connect as ${escapeHtml(identity.email)}</button></form></main></body></html>`);
      response.headers.set("Referrer-Policy", "same-origin");
      return response;
    }
    if (request.method !== "POST") return htmlResponse("Method not allowed.", 405);
    if (connectMutationError(request, { origin: this.env.BASE_URL, contentType: "application/x-www-form-urlencoded" })) return htmlResponse("Invalid connection request.", 403);
    // Consume synchronously before the callback RPC can interleave with another POST.
    this.ctx.storage.kv.delete("flow");
    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Connection unavailable.");
    const grant = entitlement(identity, this.env);
    const user = this.ctx.exports.BsportUser({ props: { accountId: this.ctx.id.toString() } });
    const stageId = flow!.reconnect ? stageCredentials(this.ctx.storage.kv, grant, Date.now()) : undefined;
    if (!flow!.reconnect) this.ctx.storage.kv.put("owner", grant);
    try {
      const handoff = stageId ? await callback.reconnectComplete(stageId) : await callback.complete(user);
      if (this.ctx.storage.kv.get("revoked")) return htmlResponse(INVALID_LINK_HTML, 400);
      if (handoff.targetOrigin !== new URL(this.env.BASE_URL).origin) throw new Error("Invalid connection handoff.");
      return htmlResponse(connectHandoffPageHtml(handoff));
    } catch {
      if (stageId) discardStagedCredentials(this.ctx.storage.kv, stageId);
      else await this.revoke();
      return htmlResponse("Connection unavailable. Start again from the Workshop.", 503);
    }
  }

  async alarm(): Promise<void> {
    // Abandoned flows keep no provider credentials; unfinished connection objects are wiped.
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (flow && flow.expiresAt <= Date.now()) this.ctx.storage.kv.delete("flow");
    if (!peekStagedCredentials(this.ctx.storage.kv, Date.now())) discardStagedCredentials(this.ctx.storage.kv);
    if (!this.ctx.storage.kv.get("owner") && !this.ctx.storage.kv.get("flow") && !this.ctx.storage.kv.get("revoked")) await this.ctx.storage.deleteAll();
  }
}

@validateRpc()
export class BsportVerifier extends WorkerEntrypoint<BsportEnv, Props> implements GatekeeperUserVerifier {
  async permits(expectedAccount: string, values: string[]): Promise<boolean> {
    validateSubresources(values, companyId(this.env));
    return account(this.env, this.ctx.props.accountId).permits(expectedAccount, values);
  }
}

@validateRpc()
export class BsportUser extends WorkerEntrypoint<BsportEnv, Props> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    await account(this.env, this.ctx.props.accountId).assertLive();
    return { displayName: "bsport private read-only connection", avatar: BSPORT_ICON };
  }
  async getSupportedResources(): Promise<SupportedResource[]> {
    await account(this.env, this.ctx.props.accountId).assertLive();
    return supportedResources(companyId(this.env));
  }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<Session>>; resource: SupportedResource }> {
    await account(this.env, this.ctx.props.accountId).assertLive();
    const resource = parseResourceUrl(url, companyId(this.env));
    const pattern = resourceUrl({ ...resource, id: undefined }) + (resource.id === undefined ? "" : "/:recordId");
    return { class: this.ctx.exports.BsportGatekeeper({ props: { accountId: this.ctx.props.accountId, resource } }), resource: supportedResources(resource.company).find(r => r.urlPattern === pattern)! };
  }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    if (!(await this.getSupportedResources()).some(r => r.urlPattern === pattern)) throw new Error("Unsupported bsport resource.");
    // Generated scripts are CSP-hashed. Never substitute deployment values into their HTML.
    return { iframeHtml: CONFIGURATOR, ui: new RpcStub(new ConfiguratorUi()) };
  }
  async revoke(): Promise<void> { await account(this.env, this.ctx.props.accountId).revoke(); }
  async reconnect(): Promise<{ url: string }> { return account(this.env, this.ctx.props.accountId).reconnect(); }
  async commitReconnect(stageId: string): Promise<void> { await account(this.env, this.ctx.props.accountId).commitReconnect(stageId); }
  async ensureResources(patterns: string[]): Promise<{ url?: string }> {
    const supported = await this.getSupportedResources();
    if (patterns.some(p => !supported.some(r => r.urlPattern === p))) throw new Error("Unsupported bsport resource.");
    return {};
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<BsportVerifier>> {
    return this.ctx.exports.BsportVerifier({ props: this.ctx.props });
  }
}

@validateRpc()
export class BsportGatekeeper extends DurableObject<BsportEnv, BindingProps> implements Gatekeeper<Session> {
  async describe(): Promise<ResourceDescription> {
    const resource = this.ctx.props.resource;
    if (resource.company !== companyId(this.env)) throw new Error("Wrong bsport company.");
    return { url: resourceUrl(resource), title: "bsport read-only", snippet: "Private, read-only access to the selected bsport resource.", suggestedBindingName: "BSPORT", tsType: resourceType(resource) };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async getHistoricalSubresources(): Promise<string[]> { return []; }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async verifyObserverAccess(observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[], values: string[]): Promise<{ allowedObserverIds: string[] }> {
    validateSubresources(values, companyId(this.env));
    const results = await Promise.all(observers.map(async observer => ({
      id: observer.id, allowed: await (observer.verifier as Fetcher<BsportVerifier>).permits(this.ctx.props.accountId, values),
    })));
    return { allowedObserverIds: results.filter(r => r.allowed).map(r => r.id) };
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<Session> {
    const resource = parseResourceUrl(resourceUrl(this.ctx.props.resource), companyId(this.env));
    const stub = account(this.env, this.ctx.props.accountId);
    await stub.assertLive();
    return sessionFor(new ReadContext(new BsportClient(this.env), resource.company, queue.dup(), () => stub.assertLive()), resource);
  }
  async applyAction(_id: number): Promise<void> { throw new Error("bsport is read-only."); }
  async rejectAction(_id: number): Promise<void> { throw new Error("bsport is read-only."); }
  async revertAction(_id: number): Promise<void> { throw new Error("bsport is read-only."); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<BsportEnv> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "bsport", url: "https://bsport.io", logo: BSPORT_ICON, providesAuth: false,
      tagline: "Private studio data, read-only", description: "Read bookings, classes, customers, subscriptions, passes and invoices. Only the deployment-approved owner can connect; sharing a workspace does not share these results." };
  }
  @skipRpcValidation()
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    ensureConfigured(this.env);
    // This method bypasses automatic validation for its persistent callback capability.
    if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) ||
        (options.resourceUrlPatterns !== undefined && (!Array.isArray(options.resourceUrlPatterns) || options.resourceUrlPatterns.length > 100 || options.resourceUrlPatterns.some(p => typeof p !== "string"))))) throw new Error("Invalid bsport connect options.");
    if (options?.resourceUrlPatterns !== undefined && options.resourceUrlPatterns.some(p => !supportedResources(companyId(this.env)).some(r => r.urlPattern === p))) throw new Error("Unsupported bsport resource.");
    if (options?.resourceUrlPatterns?.length === 0) throw new Error("Select a bsport resource to connect.");
    const id = this.env.BSPORT_ACCOUNTS.newUniqueId();
    return this.env.BSPORT_ACCOUNTS.get(id).begin(callback);
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return supportedResources(companyId(this.env)); }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async versionTag(): Promise<string | undefined> { return workerVersionTag(this.env); }
}
