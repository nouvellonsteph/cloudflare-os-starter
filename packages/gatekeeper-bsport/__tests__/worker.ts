import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { ApprovalQueue, ConnectHandoff, GatekeeperUser, HookController, HookDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { BsportEnv } from "../src/env.js";
import type { Session } from "../src/sessions.js";
import type { BsportGatekeeper } from "../src/bsport.js";

export type TestExports = typeof import("cloudflare:workers").exports & {
  TestCallback(options: { props?: { fail?: boolean; wrongOrigin?: boolean; revokeAccount?: string } }): Fetcher<TestCallback>;
};

export { default } from "../src/index.js";
export { BsportAccount, BsportGatekeeper, BsportUser, BsportVerifier, GatekeeperVendor } from "../src/index.js";

@validateRpc()
export class TestCallback extends WorkerEntrypoint<BsportEnv, { fail?: boolean; wrongOrigin?: boolean; revokeAccount?: string }> {
  async #handoff(ticket: string): Promise<ConnectHandoff> {
    if (this.ctx.props?.fail) throw new Error("private-callback-error");
    if (this.ctx.props?.revokeAccount) await this.env.BSPORT_ACCOUNTS.get(this.env.BSPORT_ACCOUNTS.idFromString(this.ctx.props.revokeAccount)).revoke();
    return { targetOrigin: this.ctx.props?.wrongOrigin ? "https://evil.example" : "https://os.example.com", ticket };
  }
  @skipRpcValidation()
  async complete(_user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> { return this.#handoff("test-ticket"); }
  async reconnectComplete(_stageId: string): Promise<ConnectHandoff> { return this.#handoff("reconnect-ticket"); }
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(): Promise<void> {}
}

class TestQueue extends RpcTarget implements ApprovalQueue {
  entries: ObservationDescription[] = [];
  denied = false;
  async authorizeObservation(value: ObservationDescription): Promise<void> {
    this.entries.push(value);
    if (this.denied) throw new Error("collaborator denied");
  }
  submitAction(..._args: Parameters<ApprovalQueue["submitAction"]>): ReturnType<ApprovalQueue["submitAction"]> { throw new Error("read-only"); }
  async bindHook<Hook extends RpcTarget>(_controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>, _description: HookDescription): Promise<void> { throw new Error("read-only"); }
  getGitCache(..._args: Parameters<ApprovalQueue["getGitCache"]>): ReturnType<ApprovalQueue["getGitCache"]> { throw new Error("read-only"); }
}

/** Creates the real class returned by the user, as an Overseer would, with a per-session queue. */
export class TestHooks extends DurableObject<BsportEnv> {
  #queue = new TestQueue();
  async open(accountId: string, url: string): Promise<Session> {
    const user = this.ctx.exports.BsportUser({ props: { accountId } });
    const binding = await user.getGatekeeperClassFor(url);
    const facet = this.ctx.facets.get<BsportGatekeeper>("binding", () => ({ class: binding.class }));
    using queue = new RpcStub<ApprovalQueue>(this.#queue);
    // Workers' Stub<T> erases bindHook's generic parameter; this target implements the full
    // interface and the read path only calls authorizeObservation().
    return facet.startSession(queue as unknown as Parameters<typeof facet.startSession>[0]);
  }
  async observations(): Promise<ObservationDescription[]> { return this.#queue.entries; }
  async deny(value: boolean): Promise<void> { this.#queue.denied = value; }
}
