import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { BsportClient } from "../src/client.js";
import type { BsportEnv } from "../src/env.js";
import { CompanySession, CollectionSession, PageCursor, ReadContext, RecordSession, sessionFor, type ObservationQueue } from "../src/sessions.js";
import { subresources } from "../src/resources.js";
import { fixtures } from "./fixtures.js";

function setup(responses = [{ results: [fixtures.bookings], next_page: null as number | null }]) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(responses.shift()!));
  let live = true;
  let denied = false;
  const authorizations: unknown[] = [];
  const dispose = vi.fn();
  const queue: ObservationQueue = {
    async authorizeObservation(value) { authorizations.push(value); if (denied) throw new Error("collaborator denied"); },
    dup() { return { ...this }; }, [Symbol.dispose]: dispose,
  };
  const context = new ReadContext(new BsportClient(env as BsportEnv, fetcher), 42, queue, async () => { if (!live) throw new Error("revoked"); });
  return { context, authorizations, fetcher, dispose, revoke: () => { live = false; }, deny: () => { denied = true; }, allow: () => { denied = false; } };
}

describe("private observations on every data-bearing call", () => {
  it("does not disclose a page until authorization resolves, then audits child detail reads too", async () => {
    const state = setup();
    const collection = new CollectionSession(state.context, "bookings");
    const cursor = await collection.list();
    expect(state.authorizations).toEqual([]); expect(state.fetcher).not.toHaveBeenCalled();
    const entries = await cursor.next();
    expect(state.authorizations).toEqual([{ title: "Read bsport page", description: "Read a page of supported bsport records.", containsRestrictedData: true, subresources: subresources(42, "bookings", [1]) }]);
    state.fetcher.mockImplementation(async () => Response.json(fixtures.bookings));
    await entries![0].resource.getDetails();
    expect(state.authorizations).toHaveLength(2);
    expect(state.authorizations[1]).toMatchObject({ subresources: subresources(42, "bookings", [1]), containsRestrictedData: true });
    expect(entries![0].resource).not.toHaveProperty("customers");
  });

  it("preserves the company dependency on empty and repeatedly terminal pages", async () => {
    const state = setup([{ results: [], next_page: 2 }, { results: [], next_page: null }]);
    const cursor = new PageCursor(state.context, "bookings", {});
    expect(await cursor.next()).toEqual([]); expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toBeNull(); expect(await cursor.next()).toBeNull();
    expect(state.authorizations).toHaveLength(4);
    for (const value of state.authorizations) expect(value).toMatchObject({ containsRestrictedData: true, subresources: subresources(42) });
    expect(state.fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(state.fetcher.mock.calls[1][0])).searchParams.get("page")).toBe("2");
  });

  it("does not advance a denied page or disclose its item capabilities", async () => {
    const state = setup([{ results: [fixtures.bookings], next_page: 2 }, { results: [], next_page: null }]);
    const cursor = new PageCursor(state.context, "bookings", {});
    state.deny(); await expect(cursor.next()).rejects.toThrow("collaborator denied");
    state.allow(); await cursor.next();
    for (const [url] of state.fetcher.mock.calls) expect(new URL(String(url)).searchParams.get("page")).toBe("1");
  });

  it("serializes concurrent cursor reads and retains each read's authorization", async () => {
    const state = setup([{ results: [], next_page: 2 }, { results: [], next_page: null }]);
    const cursor = new PageCursor(state.context, "bookings", {});
    await Promise.all([cursor.next(), cursor.next()]);
    expect(state.fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(state.authorizations).toHaveLength(2);
  });

  it("revokes existing cursors and child capabilities, including terminal pages", async () => {
    const state = setup();
    const collection = new CollectionSession(state.context, "bookings");
    const cursor = await collection.list(); const child = await collection.get(1);
    await cursor.next(); state.revoke();
    await expect(cursor.next()).rejects.toThrow("revoked");
    await expect(child.getDetails()).rejects.toThrow("revoked");
    expect(state.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks entitlement after authorization, before returning provider data", async () => {
    const state = setup();
    const context = new ReadContext(state.context.client, 42, {
      ...state.context.queue,
      async authorizeObservation() { state.revoke(); },
    }, state.context.check);
    const cursor = new PageCursor(context, "bookings", {});
    await expect(cursor.next()).rejects.toThrow("revoked");
  });

  it("narrow sessions expose no parent, sibling, mutation or arbitrary HTTP methods", async () => {
    const state = setup();
    const company = sessionFor(state.context, { company: 42 });
    const collection = sessionFor(state.context, { company: 42, collection: "bookings" });
    const item = sessionFor(state.context, { company: 42, collection: "bookings", id: 1 });
    expect(company).toBeInstanceOf(CompanySession); expect(collection).toBeInstanceOf(CollectionSession); expect(item).toBeInstanceOf(RecordSession);
    for (const method of ["customers", "classes", "invoices", "bookings", "fetch", "request", "create", "delete", "update", "getParent"]) {
      expect(collection).not.toHaveProperty(method); expect(item).not.toHaveProperty(method);
    }
    expect(item).not.toHaveProperty("list"); expect(item).not.toHaveProperty("get");
    (collection as CollectionSession)[Symbol.dispose](); expect(state.dispose).toHaveBeenCalledTimes(1);
  });

  it("checks a collection-specific filter allowlist even through the union RPC implementation", async () => {
    const state = setup();
    await expect(new CollectionSession(state.context, "classes").list({ customerId: 1 })).rejects.toThrow("Unsupported");
    expect(state.fetcher).not.toHaveBeenCalled();
  });
});
