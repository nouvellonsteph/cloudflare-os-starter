import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as main from "../src/index.js";
import type { BsportEnv } from "../src/env.js";
import { approvedIdentity } from "../src/identity.js";
import { subresources } from "../src/resources.js";
import { fixtures } from "./fixtures.js";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import type { TestExports } from "./worker.js";

const entrypoints = exports as TestExports;
const settings = env as BsportEnv;
const owner = { email: "owner@example.com", subject: "owner-subject", company: 42, client: "test-client", franchisor: null, issuer: settings.CF_ACCESS_ISS, audience: settings.CF_ACCESS_AUD };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in test."); })));
afterEach(() => vi.unstubAllGlobals());

// Vitest inspects promise properties. Consume workerd's pipelined RPC thenable once, without
// exposing it to matcher introspection, and assert on the ordinary promise it resolves/rejects.
async function rpcResult<T>(result: PromiseLike<T>): Promise<T> { return await result; }

async function connected() {
  const id = settings.BSPORT_ACCOUNTS.newUniqueId();
  const stub = settings.BSPORT_ACCOUNTS.get(id);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.kv.put("owner", owner);
    state.storage.kv.put("callback", entrypoints.TestCallback({}));
  });
  return { id: id.toString(), stub, user: entrypoints.BsportUser({ props: { accountId: id.toString() } }) };
}

describe("owner-only connection authority", () => {
  it("embeds the official square logo for both vendor and account without network requests", async () => {
    const vendor = await entrypoints.GatekeeperVendor({}).describe();
    const { user } = await connected();
    expect((await user.describe()).avatar).toEqual(vendor.logo);
    expect(vendor.logo?.url).toMatch(/^data:image\/png;base64,/);
    const bytes = Uint8Array.from(atob(vendor.logo!.url.split(",")[1]), c => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(digest, b => b.toString(16).padStart(2, "0")).join("")).toBe("86a8f67856ec55ee0f390b26365c973f679b5a426a72919dc9606d5523a992af");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exports the complete set of Worker entrypoints, without auto-provisioning", async () => {
    expect(Object.keys(main).toSorted()).toEqual(["BsportAccount", "BsportGatekeeper", "BsportUser", "BsportVerifier", "GatekeeperVendor", "default"]);
    const vendor = entrypoints.GatekeeperVendor({});
    expect(await vendor.describe()).toMatchObject({ providesAuth: false });
    expect(await vendor.describe()).not.toHaveProperty("autoProvisionsAccount");
    await expect(rpcResult((vendor as unknown as { createAccount(): Promise<unknown> }).createAccount())).rejects.toThrow();
    await expect(rpcResult(vendor.connectAccount(entrypoints.TestCallback({}), { resourceUrlPatterns: [] }))).rejects.toThrow("Select");
  });

  it("the same connected account is permitted, a second connection with the same key is not", async () => {
    const fetcher = vi.fn(async () => Response.json(fixtures.customers));
    vi.stubGlobal("fetch", fetcher);
    const first = await connected(); const second = await connected();
    const values = subresources(42, "customers", [1]);
    const mine = await first.user.getVerifier(); const other = await second.user.getVerifier();
    expect(await mine.permits(first.id, values)).toBe(true);
    expect(await other.permits(first.id, values)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await first.user.revoke();
    expect(await mine.permits(first.id, values)).toBe(false);
    await expect(rpcResult(first.stub.assertLive())).rejects.toThrow("not authorized");
    await expect(rpcResult(first.user.reconnect())).rejects.toThrow("new bsport account");
  });

  it("refuses invalid subresources even for the originating account", async () => {
    const first = await connected();
    const verifier = await first.user.getVerifier();
    for (const values of [["global"], subresources(43), ["environment/production/company/42/password/1"]]) {
      await expect(rpcResult(verifier.permits(first.id, values))).rejects.toThrow();
    }
  });

  it("pins tenant, client and identity realm and notices owner removal without a cache", async () => {
    const first = await connected();
    for (const changed of [{ ...owner, company: 43 }, { ...owner, client: "other-client" }, { ...owner, franchisor: "7" }, { ...owner, issuer: "https://other.example" }, { ...owner, audience: "other-aud" }, { ...owner, email: "other@example.com" }]) {
      await runInDurableObject(first.stub, (_instance, state) => { state.storage.kv.put("owner", changed); });
      await expect(rpcResult(first.stub.assertLive())).rejects.toThrow("not authorized");
    }
  });

  it("rejects unvalidated headers, forged JWTs and the wrong owner", async () => {
    const id = settings.BSPORT_ACCOUNTS.newUniqueId();
    const stub = settings.BSPORT_ACCOUNTS.get(id);
    const { url } = await stub.begin(entrypoints.TestCallback({}));
    expect((await stub.fetch(new Request(url, { headers: { "cf-access-authenticated-user-email": owner.email } }))).status).toBe(403);
    expect((await stub.fetch(new Request(url, { headers: { "cf-access-jwt-assertion": "forged" } }))).status).toBe(403);
    expect(approvedIdentity({ sub: "x", email: "other@example.com", iat: 1, exp: Date.now() / 1000 + 60 }, settings)).toBeNull();
    expect(approvedIdentity({ sub: "x", email: owner.email, iat: 1, exp: 1 }, settings)).toBeNull();
  });

  it("lets allow-listed emails connect with the shared key and still refuses everyone else", async () => {
    const live = { iat: 1, exp: Date.now() / 1000 + 60 };
    expect(approvedIdentity({ sub: "f", email: "FRIEND@example.com", ...live }, settings)).toEqual({ email: "friend@example.com", subject: "f" });
    expect(approvedIdentity({ sub: "s", email: "second@example.com", ...live }, settings)).toEqual({ email: "second@example.com", subject: "s" });
    expect(approvedIdentity({ sub: "o", email: owner.email, ...live }, settings)?.email).toBe(owner.email);
    expect(approvedIdentity({ sub: "x", email: "stranger@example.com", ...live }, settings)).toBeNull();
    expect(approvedIdentity({ sub: "x", email: "friend@example.com.evil.test", ...live }, settings)).toBeNull();
    expect(approvedIdentity({ sub: "x", email: "friend@example.com", iat: 1, exp: 1 }, settings)).toBeNull();
    // Removing an email from the list blocks its stored entitlement on the next read.
    const { stub } = await connected();
    await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("owner", { ...owner, email: "friend@example.com" }); });
    await rpcResult(stub.assertLive());
    await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("owner", { ...owner, email: "removed@example.com" }); });
    await expect(rpcResult(stub.assertLive())).rejects.toThrow("not authorized");
  });

  it("validates signed Access claims and completes only a same-origin, single-use handoff", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "owner-test", alg: "RS256", use: "sig" };
    const fetcher = vi.fn<typeof fetch>(async input => {
      expect(String(input)).toBe("https://example.cloudflareaccess.com/cdn-cgi/access/certs");
      return Response.json({ keys: [jwk] });
    });
    vi.stubGlobal("fetch", fetcher);
    const sign = (email = owner.email, audience = settings.CF_ACCESS_AUD, issuer = settings.CF_ACCESS_ISS, expiry = "5m") => new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "owner-test" }).setSubject(owner.subject).setIssuer(issuer)
      .setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
    const id = settings.BSPORT_ACCOUNTS.newUniqueId(); const stub = settings.BSPORT_ACCOUNTS.get(id);
    const { url } = await stub.begin(entrypoints.TestCallback({}));
    const headers = { "cf-access-jwt-assertion": await sign() };
    const get = await stub.fetch(new Request(url, { headers }));
    expect(get.status).toBe(200); expect(await get.text()).toContain("No token is entered here");
    await expect(rpcResult(stub.assertLive())).rejects.toThrow("not authorized");
    for (const token of [await sign("other@example.com"), await sign(owner.email, "wrong-aud"), await sign(owner.email, settings.CF_ACCESS_AUD, "https://evil.example"), await sign(owner.email, settings.CF_ACCESS_AUD, settings.CF_ACCESS_ISS, "-5m")]) {
      expect((await stub.fetch(new Request(url, { headers: { "cf-access-jwt-assertion": token } }))).status).toBe(403);
    }
    const post = (origin: string, address = url) => stub.fetch(new Request(address, { method: "POST", headers: { ...headers, origin, "content-type": "application/x-www-form-urlencoded" } }));
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("https://os.example.com", url.replace(/nonce=[^&]+/, "nonce=wrong"))).status).toBe(400);
    const responses = await Promise.all([post("https://os.example.com"), post("https://os.example.com")]);
    expect(responses.map(reply => reply.status).toSorted()).toEqual([200, 400]);
    const response = responses.find(reply => reply.status === 200)!;
    expect(response.status).toBe(200); const html = await response.text();
    expect(html).toContain("/connect/handoff#"); expect(html).toContain("test-ticket"); expect(html).not.toContain("fake-test-key");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(stub.assertLive()).resolves.toBeUndefined();
    expect((await post("https://os.example.com")).status).toBe(400);
    await runInDurableObject(stub, (_instance, state) => {
      const stored = JSON.stringify([...state.storage.kv.list()]);
      expect(stored).not.toContain("fake-test-key");
      expect(state.storage.kv.get("flow")).toBeUndefined();
    });
    // A re-verified owner may stage the current deployment identity, but it stays inert until
    // the Workshop commits the exact stage named by its single-use restore ticket.
    await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("owner", { ...owner, client: "old-client" }); });
    const reconnect = await stub.reconnect();
    const restored = await post("https://os.example.com", reconnect.url);
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain("reconnect-ticket");
    const stageId = await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.assertLive()).rejects.toThrow("not authorized");
      return state.storage.kv.get<{ stageId: string }>("stagedCredentials")!.stageId;
    });
    await stub.commitReconnect(stageId);
    await rpcResult(stub.assertLive());
    const expired = await stub.reconnect();
    await runInDurableObject(stub, (_instance, state) => {
      const flow = state.storage.kv.get<object>("flow")!;
      state.storage.kv.put("flow", { ...flow, expiresAt: Date.now() - 1 });
    });
    expect((await post("https://os.example.com", expired.url)).status).toBe(400);
    for (const props of [{ fail: true }, { wrongOrigin: true }]) {
      const failed = settings.BSPORT_ACCOUNTS.get(settings.BSPORT_ACCOUNTS.newUniqueId());
      const flow = await failed.begin(entrypoints.TestCallback({ props }));
      const failure = await failed.fetch(new Request(flow.url, { method: "POST", headers: { ...headers, origin: "https://os.example.com", "content-type": "application/x-www-form-urlencoded" } }));
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain("private-callback-error");
      await runInDurableObject(failed, (_instance, state) => {
        expect(state.storage.kv.get("owner")).toBeUndefined();
        expect(state.storage.kv.get("revoked")).toBe(true);
        expect(state.storage.kv.get("flow")).toBeUndefined();
      });
    }
    await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("callback", entrypoints.TestCallback({ props: { fail: true } })); });
    const retry = await stub.reconnect();
    expect((await post("https://os.example.com", retry.url)).status).toBe(503);
    await runInDurableObject(stub, (instance, state) => {
      expect(state.storage.kv.get("stagedCredentials")).toBeUndefined();
      return instance.assertLive();
    });
    await runInDurableObject(stub, (_instance, state) => { state.storage.kv.put("callback", entrypoints.TestCallback({ props: { revokeAccount: id.toString() } })); });
    const revoked = await stub.reconnect();
    expect((await post("https://os.example.com", revoked.url)).status).toBe(400);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.kv.get("revoked")).toBe(true);
      expect(state.storage.kv.get("stagedCredentials")).toBeUndefined();
    });
  });

  it("expires unused nonces and refuses unmatched reconnect stages", async () => {
    const first = await connected();
    await expect(rpcResult(first.user.commitReconnect("arbitrary-stage"))).rejects.toThrow("Invalid");
    const { url } = await first.user.reconnect();
    expect(url).toContain("nonce=");
    await first.user.revoke();
    await runInDurableObject(first.stub, (_instance, state) => {
      expect(state.storage.kv.get("flow")).toBeUndefined(); expect(state.storage.kv.get("stagedCredentials")).toBeUndefined();
    });
  });

  it("batches actual gatekeeper observer checks and never grants another connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [], next_page: null })));
    const first = await connected(); const second = await connected();
    await runInDurableObject(first.stub, async (_instance, state) => {
      const gatekeeper = state.facets.get<main.BsportGatekeeper>("observer-test", () => ({
        class: state.exports.BsportGatekeeper({ props: { accountId: first.id, resource: { company: 42, collection: "bookings" } } }),
      }));
      const observers = [{ id: "owner", verifier: state.exports.BsportVerifier({ props: { accountId: first.id } }) }, { id: "collaborator", verifier: state.exports.BsportVerifier({ props: { accountId: second.id } }) }];
      expect(await gatekeeper.verifyObserverAccess(observers, subresources(42))).toEqual({ allowedObserverIds: ["owner"] });
      expect(await gatekeeper.getHistoricalSubresources()).toEqual([]);
      await gatekeeper.addObserver("collaborator", observers[1].verifier);
      await gatekeeper.removeObserver("collaborator");
      expect(await gatekeeper.getHistoricalSubresources()).toEqual([]);
      expect(await gatekeeper.getAutoApprovableActions()).toEqual([]);
    });
  });

  it.each([401, 429, 500, 503])("propagates indeterminate provider HTTP %s instead of allowing or silently denying", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-error", { status })));
    const first = await connected();
    await runInDurableObject(first.stub, async instance => {
      await expect(instance.permits(first.id, subresources(42))).rejects.toThrow(`HTTP ${status}`);
    });
  });

  it.each([403, 404])("denies definite provider HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-error", { status })));
    const first = await connected();
    expect(await first.stub.permits(first.id, subresources(42))).toBe(false);
  });

  it("does not allow on a transport error, or on revocation during a provider probe", async () => {
    const first = await connected();
    await runInDurableObject(first.stub, async instance => {
      await expect(instance.permits(first.id, subresources(42))).rejects.toThrow("unavailable");
    });
    await runInDurableObject(first.stub, async instance => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        await instance.revoke();
        return Response.json({ results: [], next_page: null });
      }));
      await expect(instance.permits(first.id, subresources(42))).rejects.toThrow("not authorized");
    });
  });

  it("commits only a matching live reconnect stage and survives eviction", async () => {
    const first = await connected();
    await runInDurableObject(first.stub, async (instance, state) => {
      const stage = stageCredentials(state.storage.kv, owner, Date.now());
      await expect(instance.commitReconnect("mismatched")).rejects.toThrow("Invalid");
      expect(state.storage.kv.get("stagedCredentials")).toBeDefined();
      await instance.commitReconnect(stage);
      await expect(instance.commitReconnect(stage)).rejects.toThrow("Invalid");
      const expired = stageCredentials(state.storage.kv, owner, Date.now() - 600_001);
      await expect(instance.commitReconnect(expired)).rejects.toThrow("Invalid");
      const wrongOwner = stageCredentials(state.storage.kv, { ...owner, subject: "other" }, Date.now());
      await expect(instance.commitReconnect(wrongOwner)).rejects.toThrow("Invalid");
      expect(state.storage.kv.get("owner")).toEqual(owner);
    });
    await evictDurableObject(first.stub);
    await first.stub.assertLive();
  });

  it("new reconnects supersede old flows/stages, and stale alarms do not erase a fresh flow", async () => {
    const first = await connected();
    const { url: old } = await first.user.reconnect();
    await runInDurableObject(first.stub, (_instance, state) => { stageCredentials(state.storage.kv, owner, Date.now()); });
    const { url: fresh } = await first.user.reconnect();
    expect(old).not.toBe(fresh);
    await runInDurableObject(first.stub, async (instance, state) => {
      expect(state.storage.kv.get("stagedCredentials")).toBeUndefined();
      await instance.alarm();
      expect(state.storage.kv.get("flow")).toMatchObject({ value: new URL(fresh).searchParams.get("nonce") });
      state.storage.kv.put("flow", { value: "expired", expiresAt: Date.now() - 1, reconnect: true });
      await instance.alarm();
      expect(state.storage.kv.get("flow")).toBeUndefined();
      expect(state.storage.kv.get("owner")).toEqual(owner);
    });
  });
});
