import { env } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BsportEnv } from "../src/env.js";
import type { BsportBookings, BsportCompanySession, BsportResource, BsportBooking, BsportCustomer } from "../src/types.js";
import type { TestHooks } from "./worker.js";
import { fixtures } from "./fixtures.js";
import { subresources } from "../src/resources.js";

const settings = env as BsportEnv & { TEST_HOOKS: DurableObjectNamespace<TestHooks> };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in test."); })));
afterEach(() => vi.unstubAllGlobals());
async function rpcResult<T>(result: PromiseLike<T>): Promise<T> { return await result; }

async function setup(suffix = "") {
  const accountId = settings.BSPORT_ACCOUNTS.newUniqueId();
  const account = settings.BSPORT_ACCOUNTS.get(accountId);
  await runInDurableObject(account, (_instance, state) => { state.storage.kv.put("owner", {
    email: "owner@example.com", subject: "owner-subject", company: 42, client: "test-client", franchisor: null,
    issuer: settings.CF_ACCESS_ISS, audience: settings.CF_ACCESS_AUD,
  }); });
  const hooks = settings.TEST_HOOKS.get(settings.TEST_HOOKS.newUniqueId());
  const session = await hooks.open(accountId.toString(), `bsport://production/companies/42${suffix}`);
  return { account, hooks, session };
}

describe("real Gatekeeper session RPC", () => {
  it("resolves the documented booking -> customer/class/purchased-pass -> product relationships", async () => {
    const records = new Map<string, object>([
      ["/bookings/1/", { ...fixtures.bookings, client_class_pass_id: 11 }],
      ["/clients/2/", { ...fixtures.customers, id: 2 }],
      ["/classes/3/", { ...fixtures.classes, id: 3 }],
      ["/client-class-passes/11/", { ...fixtures.customerClassPasses, id: 11, class_pass_id: 21 }],
      ["/class-passes/21/", { ...fixtures.classPassProducts, id: 21 }],
    ]);
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      const record = records.get(url.pathname.replace("/api/v2/management", ""));
      if (!record) throw new Error("Unexpected relationship lookup in test.");
      return Response.json(record);
    });
    vi.stubGlobal("fetch", fetcher);
    const { session } = await setup();
    using company = session as RpcStub<BsportCompanySession>;
    using bookings = await company.bookings();
    using bookingResource = await bookings.get(1);
    const booking = await bookingResource.getDetails();
    using customers = await company.customers();
    using classes = await company.classes();
    using customer = await customers.get(booking.customerId);
    using scheduledClass = await classes.get(booking.classId);
    const [profile, classDetails] = await Promise.all([customer.getDetails(), scheduledClass.getDetails()]);
    expect(profile).toMatchObject({ id: booking.customerId, firstName: "Alex", lastName: "Example", fullName: "Alex Example" });
    expect(classDetails).toMatchObject({ id: booking.classId, name: "Pilates" });
    if (booking.customerClassPassId === null) throw new Error("Expected a linked pass in the fixture.");
    using purchasedPasses = await company.customerClassPasses();
    using purchasedPass = await purchasedPasses.get(booking.customerClassPassId);
    const passDetails = await purchasedPass.getDetails();
    expect(passDetails.customerId).toBe(profile.id);
    using products = await company.classPassProducts();
    using product = await products.get(passDetails.classPassProductId);
    expect(await product.getDetails()).toMatchObject({ id: 21, name: "Unlimited", isUnlimited: true });
    expect(passDetails.id).not.toBe(passDetails.classPassProductId);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("joins a roster with one distinct-customer batch using list details without per-row reads", async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/management/bookings/") {
        expect(url.searchParams.get("class_id")).toBe("3");
        return Response.json({ results: [
          fixtures.bookings, { ...fixtures.bookings, id: 2 }, { ...fixtures.bookings, id: 3, client_id: 4 },
        ], next_page: null });
      }
      expect(url.pathname).toBe("/api/v2/management/clients/");
      expect(url.searchParams.get("ids")).toBe("2,4");
      expect(url.searchParams.get("page_size")).toBe("100");
      return Response.json({ results: [
        { ...fixtures.customers, id: 2 }, { ...fixtures.customers, id: 4, fullname: "Sam Example" },
      ], next_page: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const { session } = await setup();
    using company = session as RpcStub<BsportCompanySession>;
    using bookings = await company.bookings();
    using bookingCursor = await bookings.list({ classId: 3, pageSize: 100 });
    const rows: BsportBooking[] = [];
    for (;;) {
      const entries = await bookingCursor.next();
      if (entries === null) break;
      for (const entry of entries) {
        using _resource = entry.resource;
        rows.push(entry.details);
      }
    }
    const ids = [...new Set(rows.map(booking => booking.customerId))];
    const profiles = new Map<number, BsportCustomer>();
    if (ids.length) {
      using customers = await company.customers();
      using customerCursor = await customers.list({ ids, pageSize: 100 });
      for (;;) {
        const entries = await customerCursor.next();
        if (entries === null) break;
        for (const entry of entries) {
          using _resource = entry.resource;
          profiles.set(entry.details.id, entry.details);
        }
      }
    }
    expect(rows.map(booking => ({ bookingId: booking.id, customerName: profiles.get(booking.customerId)?.fullName ?? null }))).toEqual([
      { bookingId: 1, customerName: "Alex Example" }, { bookingId: 2, customerName: "Alex Example" }, { bookingId: 3, customerName: "Sam Example" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("binds company, collection and record sessions, with per-read queue authorization", async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [fixtures.bookings], next_page: null }));
    vi.stubGlobal("fetch", fetcher);
    const { hooks, session } = await setup();
    using company = session as RpcStub<BsportCompanySession>;
    using collection = await company.bookings();
    using cursor = await collection.list();
    expect(await hooks.observations()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const entries = await cursor.next();
    expect(entries![0].details).toMatchObject({ id: 1 });
    expect(await hooks.observations()).toMatchObject([{ containsRestrictedData: true, subresources: subresources(42, "bookings", [1]) }]);
    fetcher.mockImplementation(async () => Response.json(fixtures.bookings));
    using child = entries![0].resource;
    expect(await child.getDetails()).toMatchObject({ id: 1 });
    expect(await cursor.next()).toBeNull();
    expect(await hooks.observations()).toHaveLength(3);
    const narrow = await setup("/bookings");
    using bookings = narrow.session as RpcStub<BsportBookings>;
    using record = await bookings.get(1);
    expect(await record.getDetails()).toMatchObject({ id: 1 });
    const single = await setup("/bookings/1");
    using bound = single.session as RpcStub<BsportResource<BsportBooking>>;
    expect(await bound.getDetails()).toMatchObject({ id: 1 });
  });

  it("denies disclosure, retries the same page, and revokes already minted children", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [fixtures.bookings], next_page: null }));
    vi.stubGlobal("fetch", fetcher);
    const { account, hooks, session } = await setup("/bookings");
    using collection = session as RpcStub<BsportBookings>;
    using cursor = await collection.list();
    using child = await collection.get(1);
    await hooks.deny(true);
    await expect(rpcResult(cursor.next())).rejects.toThrow("collaborator denied");
    await hooks.deny(false);
    const entries = await cursor.next();
    entries![0].resource[Symbol.dispose]();
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("page"))).toEqual(["1", "1"]);
    await account.revoke();
    await expect(rpcResult(child.getDetails())).rejects.toThrow("not authorized");
    await expect(rpcResult(cursor.next())).rejects.toThrow("not authorized");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed RPC arguments and nonexistent methods before provider I/O", async () => {
    const fetcher = vi.fn(async () => { throw new Error("Unexpected provider call"); });
    vi.stubGlobal("fetch", fetcher);
    const { session } = await setup("/bookings");
    using collection = session as RpcStub<BsportBookings>;
    // Deliberately cross the RPC boundary with untyped input, as an untrusted caller can.
    const untyped = collection as unknown as { get(id: unknown): Promise<unknown>; list(options: unknown): Promise<unknown>; customers(): Promise<unknown> };
    for (const id of [null, {}, true, -1, "1/../../customers"]) await expect(rpcResult(untyped.get(id))).rejects.toThrow();
    for (const options of [null, [], { method: "POST" }, { company_id: 43 }, { status: "wrong" }, { customerId: "1" }]) await expect(rpcResult(untyped.list(options))).rejects.toThrow();
    await expect(rpcResult(untyped.customers())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
