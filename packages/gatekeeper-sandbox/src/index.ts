import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { ActionJournal, stageAction } from "@gadgets/gatekeeper-kit/actions";
import { workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AccountDescription, ActionDescription, AppUiContext, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions,
  GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier, GitCache, ResourceDescription,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AppApi } from "./app-api.js";
import type { CommandStatus, SandboxSession, WorkspaceEntry } from "./types.js";
import { SandboxWorkspace, workspacePath, type SandboxEnv } from "./workspace.js";
import APP_HTML from "./generated/app.txt";
import CONFIGURATOR_HTML from "./generated/sandbox-configurator-ui.txt";
import TYPES from "./types.txt";

export { SandboxWorkspace };

const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#302c60"/><path d="m8 11 6 5-6 5m9 0h7" fill="none" stroke="#dcd8ff" stroke-width="2" stroke-linejoin="round"/></svg>',
  ),
};
const WORKSPACE_URL = "https://sandbox.cloudflare.internal/workspace";
const RESOURCE: SupportedResource = {
  id: "workspace",
  urlPattern: WORKSPACE_URL,
  title: "Linux workspace",
  description: "Read files and request edits and commands in your private Linux workspace.",
  icon: ICON,
};
const PRIVATE_WORKSPACE = "sandbox/workspace";
const MAX_AGENT_INPUT = 16 * 1024;
type Props = { accountId: string };

type Action =
  | { type: "write"; path: string; content: string }
  | { type: "command"; argv: string[]; cwd: string };

function workspace(env: SandboxEnv, props: Props): DurableObjectStub<SandboxWorkspace> {
  return env.WORKSPACES.getByName(props.accountId);
}

/** Only implemented methods are present on the browser-facing capability. */
@validateRpc()
class WorkspaceApp extends RpcTarget implements AppApi {
  #driver: DurableObjectStub<SandboxWorkspace>;

  constructor(driver: DurableObjectStub<SandboxWorkspace>) {
    super();
    this.#driver = driver;
  }

  status() { return this.#driver.status(); }
  listFiles(path: string) { return this.#driver.listFiles(path); }
  readFile(path: string) { return this.#driver.readFile(path); }
  writeFile(path: string, base64: string) { return this.#driver.writeFile(path, base64); }
  makeDirectory(path: string) { return this.#driver.makeDirectory(path); }
  rename(path: string, name: string) { return this.#driver.rename(path, name); }
  remove(path: string) { return this.#driver.remove(path); }
  openTerminal(cols: number, rows: number) { return this.#driver.openTerminal(cols, rows); }
  readTerminal(id: string, cursor: number) { return this.#driver.readTerminal(id, cursor); }
  sendTerminal(id: string, data: string) { return this.#driver.sendTerminal(id, data); }
  resizeTerminal(id: string, cols: number, rows: number) { return this.#driver.resizeTerminal(id, cols, rows); }
  stopTerminal() { return this.#driver.stopTerminal(); }
  saveAndStop() { return this.#driver.saveAndStop(); }
}

@validateRpc()
class WorkspaceConfigurator extends RpcTarget {
  async resourceUrl(): Promise<string> { return WORKSPACE_URL; }
}

@validateRpc()
class AgentSession extends RpcTarget implements SandboxSession {
  #driver: DurableObjectStub<SandboxWorkspace>;
  #queue: RpcStub<ApprovalQueue>;
  #journal: ActionJournal<Action>;
  #commandStatus: (id: number) => CommandStatus;

  constructor(
    driver: DurableObjectStub<SandboxWorkspace>,
    queue: RpcStub<ApprovalQueue>,
    journal: ActionJournal<Action>,
    commandStatus: (id: number) => CommandStatus,
  ) {
    super();
    this.#driver = driver;
    this.#queue = queue;
    this.#journal = journal;
    this.#commandStatus = commandStatus;
  }

  async #authorize(title: string, description: string): Promise<void> {
    await this.#driver.assertLive();
    await this.#queue.authorizeObservation({
      title,
      description,
      subresources: [PRIVATE_WORKSPACE],
      containsRestrictedData: true,
      ownerInvitesOnly: true,
    });
  }

  async listFiles(path = ""): Promise<WorkspaceEntry[]> {
    workspacePath(path, true);
    await this.#authorize("List sandbox files", "List files in the private Linux workspace.");
    return this.#driver.listFiles(path);
  }

  async readFile(path: string): Promise<string> {
    workspacePath(path);
    await this.#authorize("Read a sandbox file", "Read a file from the private Linux workspace.");
    const bytes = Uint8Array.fromBase64(await this.#driver.readFile(path));
    if (bytes.length > 64 * 1024) throw new Error("Agent reads are limited to 64 KiB per file.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  }

  async #submit(action: Action, description: Pick<ActionDescription, "title" | "description" | "fields">): Promise<number> {
    // Keep the approval and its payload private to the workspace before submitting the action.
    await this.#authorize("Use the private sandbox", "Check access to submit a private workspace action.");
    await this.#driver.assertLive();
    return stageAction(this.#journal, this.#queue, action, {
      ...description, descriptionIsComplete: true, implementsRevert: false, awaitDecision: true,
      // File replacement may remove the old contents. Commands are arbitrary code and use billed compute.
      autoApprovable: false,
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    workspacePath(path);
    if (new TextEncoder().encode(content).length > MAX_AGENT_INPUT) throw new Error("Agent writes are limited to 16 KiB.");
    await this.#submit({ type: "write", path, content }, {
      title: "Write a sandbox file",
      description: "Create or replace a file inside the private Linux workspace.",
      fields: [{ kind: "inline", label: "Path", value: path }, { kind: "text", label: "Contents", value: content }],
    });
  }

  async runCommand(argv: string[], cwd = ""): Promise<number> {
    workspacePath(cwd, true);
    const command = JSON.stringify(argv);
    if (!argv[0] || argv.length > 128 || argv.some(arg => arg.includes("\0")) ||
        new TextEncoder().encode(command).length > MAX_AGENT_INPUT) throw new Error("Invalid command arguments.");
    return this.#submit({ type: "command", argv, cwd }, {
      title: "Run a sandbox command",
      description: "Run a command in the private Linux workspace.",
      fields: [{ kind: "json", label: "Arguments", value: command }, { kind: "inline", label: "Working directory", value: cwd }],
    });
  }

  async commandStatus(id: number): Promise<CommandStatus> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid command reference.");
    await this.#authorize("Read sandbox command status", "Read the status and output of a private workspace command.");
    return this.#commandStatus(id);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

/** An explicitly connected gadget's approval journal and agent capability. */
@validateRpc()
export class SandboxGatekeeper extends DurableObject<SandboxEnv, Props> implements Gatekeeper<SandboxSession> {
  #journal = new ActionJournal<Action>(this.ctx.storage.kv, { namespace: "sandbox", maxPending: 30 });
  #running = new Set<number>();

  async describe(): Promise<ResourceDescription> {
    return {
      url: WORKSPACE_URL,
      title: RESOURCE.title,
      snippet: RESOURCE.description,
      tsType: "SandboxSession",
      suggestedBindingName: "SANDBOX",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async getHistoricalSubresources(): Promise<string[]> { return []; }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    _observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: [] };
  }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<SandboxSession> {
    const driver = workspace(this.env, this.ctx.props);
    await driver.assertLive();
    return new AgentSession(driver, queue.dup(), this.#journal, id => this.#status(id));
  }

  #status(id: number): CommandStatus {
    const result = this.ctx.storage.kv.get<CommandStatus>(`result:${id}`);
    if (result) return result;
    if (this.#running.has(id)) return { state: "running" };
    const entry = this.#journal.get(id);
    if (entry?.action.type !== "command") return { state: "expired" };
    return { state: entry.state === "pending" || entry.state === "staged" ? "pending" : "interrupted" };
  }

  #saveResult(id: number, status: CommandStatus): void {
    this.ctx.storage.transactionSync(() => {
      const ids = this.ctx.storage.kv.get<number[]>("resultIds") ?? [];
      if (!ids.includes(id)) ids.push(id);
      while (ids.length > 20) this.ctx.storage.kv.delete(`result:${ids.shift()}`);
      this.ctx.storage.kv.put("resultIds", ids);
      this.ctx.storage.kv.put(`result:${id}`, status);
    });
  }

  async applyAction(id: number, _cache: RpcStub<GitCache>): Promise<void> {
    if (this.#journal.wasApplied(id)) return;
    const entry = this.#journal.get(id);
    if (!entry) throw new Error("Sandbox action is unavailable.");
    if (this.#running.has(id)) throw new Error("Sandbox action is already running.");
    if (this.ctx.storage.kv.get<CommandStatus>(`result:${id}`)?.state === "finished") {
      this.#journal.retire(id);
      return;
    }
    if (entry.state !== "staged" && entry.state !== "pending") {
      throw new Error("The sandbox action may have run before it was interrupted. Check the workspace before resubmitting.");
    }
    const driver = workspace(this.env, this.ctx.props);
    this.#journal.markClaimed(id);
    this.#running.add(id);
    try {
      await this.ctx.storage.sync();
      const { action } = entry;
      if (action.type === "write") {
        await driver.writeFile(action.path, new TextEncoder().encode(action.content).toBase64());
      } else {
        const result = await driver.runCommand(action.argv, action.cwd);
        this.#saveResult(id, { state: "finished", result });
      }
      this.#journal.retire(id);
    } catch {
      const message = "The sandbox action did not finish. Check the workspace before resubmitting.";
      this.#journal.markFailed(id, message, { outcome: "unknown" });
      throw new Error(message);
    } finally {
      this.#running.delete(id);
    }
  }

  async rejectAction(id: number): Promise<void> {
    if (this.#running.has(id)) throw new Error("Sandbox action is already running.");
    const entry = this.#journal.get(id);
    if (entry?.action.type === "command") {
      this.#saveResult(id, { state: entry.state === "claimed" || entry.state === "failed" ? "interrupted" : "rejected" });
    }
    this.#journal.remove(id);
  }

  async revertAction(_id: number): Promise<void> { throw new Error("Sandbox actions cannot be reverted."); }
}

@validateRpc()
export class SandboxVerifier extends WorkerEntrypoint<SandboxEnv> implements GatekeeperUserVerifier {
  verify(): void {}
}

/** Account capability created by the authenticated Workshop user. */
@validateRpc()
export class SandboxAccount extends WorkerEntrypoint<SandboxEnv, Props> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Sandbox", avatar: ICON, providesUi: { title: "Sandbox", icon: ICON } };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<SandboxSession>>; resource: SupportedResource }> {
    if (url !== WORKSPACE_URL) throw new Error("Unknown sandbox resource.");
    await workspace(this.env, this.ctx.props).assertLive();
    return { class: this.ctx.exports.SandboxGatekeeper({ props: this.ctx.props }), resource: RESOURCE };
  }

  async startResourceConfigurator(type: string): Promise<GatekeeperUiFrame> {
    if (type !== RESOURCE.id && type !== WORKSPACE_URL) throw new Error("Unknown sandbox resource type.");
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new WorkspaceConfigurator()) };
  }

  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const driver = workspace(this.env, this.ctx.props);
    await driver.assertLive();
    return { iframeHtml: APP_HTML, ui: new RpcStub(new WorkspaceApp(driver)) };
  }

  async ensureResources(_patterns: string[]): Promise<{}> { return {}; }
  async revoke(): Promise<void> { await workspace(this.env, this.ctx.props).revoke(); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  async reconnect(): Promise<{ url: string }> { throw new Error("Sandbox has no credentials to reconnect."); }
  async commitReconnect(_stageId: string): Promise<void> { throw new Error("Sandbox has no connect flow."); }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SandboxVerifier({});
  }
}

/** Advertises the optional Sandbox account and explicit workspace connection. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<SandboxEnv> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Sandbox",
      url: "https://developers.cloudflare.com/sandbox/",
      logo: ICON,
      tagline: "Work inside a private Linux workspace",
      description: "Open a terminal, manage files, and let a connected gadget request commands and edits.",
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> { return workerVersionTag(this.env); }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // Workshop stages the account for the initiating user and requires its one-time flow nonce
    // when redeeming the ticket. With no external provider, the popup can open the handoff directly.
    const account = this.ctx.exports.SandboxAccount({ props: { accountId: crypto.randomUUID() } });
    const handoff = await callback.complete(account);
    const url = new URL("/connect/handoff", handoff.targetOrigin);
    url.hash = encodeURIComponent(handoff.ticket);
    return { url: url.href };
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return [RESOURCE]; }
}

export default {
  fetch(): Response { return new Response("Not found", { status: 404 }); },
} satisfies ExportedHandler<SandboxEnv>;
