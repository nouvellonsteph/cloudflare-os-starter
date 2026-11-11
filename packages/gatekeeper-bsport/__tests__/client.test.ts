import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { BsportClient } from "../src/client.js";
import type { BsportEnv } from "../src/env.js";
import { filterQuery } from "../src/filters.js";
import { COLLECTIONS, parseResourceUrl, resourceUrl, subresources, supportedResources, validateSubresources, type Collection } from "../src/resources.js";
import { mapRecord } from "../src/mapping.js";
import { fixtures, INVOICE_ID } from "./fixtures.js";

const settings = env as BsportEnv;
describe("fixed, read-only provider boundary", () => {
  // The test config intercepts outbound I/O, not global fetch or the client fetcher.
  it("reads a page with native Workers fetch and its required receiver", async () => {
    await expect(new BsportClient(settings).page("bookings", { pageSize: 1 }, 1)).resolves.toEqual({
      records: [mapRecord("bookings", fixtures.bookings, 42)], next: null,
    });
  });

  it("reads details with native Workers fetch and its required receiver", async () => {
    await expect(new BsportClient(settings).details("bookings", 1)).resolves.toEqual(mapRecord("bookings", fixtures.bookings, 42));
  });

  it("verifies company and record access with native Workers fetch", async () => {
    const client = new BsportClient(settings);
    await expect(client.verifyAccess(subresources(42))).resolves.toBeUndefined();
    await expect(client.verifyAccess(subresources(42, "bookings", [1]))).resolves.toBeUndefined();
  });

  it("rejects a native-fetch redirect without following it or disclosing its location", async () => {
    await expect(new BsportClient(settings).details("bookings", 2)).rejects.toThrow(/^bsport read failed \(HTTP 302\)\.$/);
  });

  it.each(Object.keys(COLLECTIONS) as Collection[])("GETs only the configured company's %s and maps its fields", async collection => {
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://public.production.bsport.io");
      expect(url.pathname).toBe(`/api/v2/management/${COLLECTIONS[collection][0]}/`);
      expect(options?.method).toBe("GET"); expect(options?.redirect).toBe("manual");
      const headers = new Headers(options?.headers);
      expect(headers.get("X-Api-Key")).toBe("fake-test-key");
      expect(headers.get("X-Client-ID")).toBe("test-client"); expect(headers.get("X-Company-ID")).toBe("42");
      expect(headers.has("X-Franchisor-ID")).toBe(false);
      expect(url.searchParams.has("expand[]")).toBe(false);
      if (collection === "customers") expect(url.searchParams.get("fields")).not.toMatch(/notes|birth_date|payment|official|emergency|unsubscribe/);
      return Response.json({ results: [fixtures[collection]], next_page: null });
    });
    const page = await new BsportClient(settings, fetcher).page(collection, {}, 1);
    expect(page.records).toHaveLength(1); expect(page.next).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE|fake-test-key|invoice_pdf|private.pdf/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a fixed franchise header only when explicitly configured", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_u, options) => {
      expect(new Headers(options?.headers).get("X-Franchisor-ID")).toBe("7");
      return Response.json(fixtures.bookings);
    });
    await new BsportClient({ ...settings, BSPORT_FRANCHISOR_ID: "7" }, fetcher).details("bookings", 1);
  });

  it.each(["filtered list", "unfiltered list", "detail"] as const)("reads customer names from a %s when bsport omits phone_number", async method => {
    // ClientListOutput and ClientOutput both omit phone_number when no phone is stored.
    const { phone_number: _phone, ...customer } = fixtures.customers;
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(method === "detail" ? "/api/v2/management/clients/1/" : "/api/v2/management/clients/");
      if (method !== "detail") {
        expect(url.searchParams.get("fields")?.split(",")).toContain("phone_number");
        expect(url.searchParams.get("ids")).toBe(method === "filtered list" ? "1,2" : null);
      }
      return Response.json(method === "detail" ? customer : { results: [customer], next_page: null });
    });
    const client = new BsportClient(settings, fetcher);
    const details = method === "detail" ? await client.details("customers", 1) :
      (await client.page("customers", method === "filtered list" ? { ids: [1, 2], pageSize: 100 } : { pageSize: 1 }, 1)).records[0];
    expect(details).toMatchObject({ id: 1, firstName: "Alex", lastName: "Example", fullName: "Alex Example", phoneNumber: null });
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE|notes|official_document_id|payment_backend|emergency_contact|unsubscribe_link/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { field: "phone_number", value: { private: "PRIVATE PHONE" } },
    { field: "firstname", value: undefined },
    { field: "joined_date", value: null },
    { field: "total_unpaid_amount", value: 1 },
  ])("rejects malformed customer $field with only a fixed field name in the error", async ({ field, value }) => {
    const customer = { ...fixtures.customers, [field]: value };
    const fetcher = vi.fn<typeof fetch>(async input => Response.json(new URL(String(input)).pathname.endsWith("/clients/") ?
      { results: [customer], next_page: null } : customer));
    const client = new BsportClient(settings, fetcher);
    for (const read of [() => client.details("customers", 1), () => client.page("customers", { pageSize: 1 }, 1)]) {
      const result = read();
      await expect(result).rejects.toEqual(new Error(`Invalid bsport response. Invalid field: customers.${field}.`));
      await expect(result).rejects.not.toHaveProperty("cause");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", "+33123456789"])("preserves an explicit customer phone value %s", phone => {
    expect(mapRecord("customers", { ...fixtures.customers, phone_number: phone }, 42)).toMatchObject({ phoneNumber: phone });
  });

  it.each([401, 403, 404, 429, 500, 302])("sanitizes HTTP %s without retrying or disclosing a response body", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("secret-token-and-private-body", { status, headers: { location: "https://evil.example" } }));
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds transient retries and hides raw transport errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private", { status: 503 }));
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => { throw new Error("private-token"); });
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow(/^bsport read unavailable\.$/);
  });

  it.each([
    { status: 403, headers: new Headers(), expected: "bsport read failed (HTTP 403).", calls: 1 },
    { status: 503, headers: new Headers(), expected: "bsport read failed (HTTP 503).", calls: 2 },
    { status: 200, headers: new Headers({ "content-type": "text/html" }), expected: "Invalid bsport response.", calls: 1 },
    { status: 200, headers: new Headers({ "content-length": String(3 * 1024 * 1024) }), expected: "Invalid bsport response.", calls: 1 },
  ])("sanitizes cancellation failures for HTTP $status", async ({ status, headers, expected, calls }) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      cancel() { throw new Error("private-provider-stream-error"); },
    }), { status, headers }));
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow(expected);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it("does not expose invalid credential header values in platform errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixtures.bookings));
    await expect(new BsportClient({ ...settings, BSPORT_API_KEY: "synthetic-private\r\nvalue" }, fetcher).details("bookings", 1))
      .rejects.toThrow(/^Invalid bsport credential configuration\.$/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example/?token=x", 1, 0, -1, 2.5, 100001, undefined])("rejects unsafe next_page %s", async next => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [], next_page: next }));
    await expect(new BsportClient(settings, fetcher).page("bookings", {}, 1)).rejects.toThrow("Invalid bsport response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts empty nonterminal pages and never follows a provider URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [], next_page: 2, next: "https://evil.example" }));
    await expect(new BsportClient(settings, fetcher).page("bookings", {}, 1)).resolves.toEqual({ records: [], next: 2 });
  });

  it.each([
    () => new Response("not json", { headers: { "content-type": "application/json" } }),
    () => new Response("x", { headers: { "content-type": "text/html" } }),
    () => Response.json({ results: Array(101).fill(fixtures.bookings), next_page: null }),
    () => new Response("x", { headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) } }),
    () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ])("rejects malformed or oversized provider data", async response => {
    await expect(new BsportClient(settings, async () => response()).page("bookings", {}, 1)).rejects.toThrow("Invalid bsport response");
  });

  it("refuses cross-company response records, mismatched IDs and missing credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...fixtures.bookings, company_id: 43 }));
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow("outside");
    fetcher.mockImplementation(async () => Response.json({ ...fixtures.bookings, id: 2 }));
    await expect(new BsportClient(settings, fetcher).details("bookings", 1)).rejects.toThrow("Invalid bsport response");
    fetcher.mockClear();
    await expect(new BsportClient({ ...settings, BSPORT_API_KEY: undefined }, fetcher).details("bookings", 1)).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates live detail probes and uses a bounded company-only query", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixtures.bookings));
    const client = new BsportClient(settings, fetcher);
    await client.verifyAccess([...subresources(42, "bookings", [1, 2]), ...subresources(42, "bookings", [1])].filter(value => !value.endsWith("bookings/2")));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ results: [], next_page: null }));
    await client.verifyAccess(subresources(42));
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("page_size")).toBe("1");
  });

  it("settles in-flight probes, stops new ones and preserves indeterminate failures", async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { releases.push(resolve); }));
    let settled = false;
    const result = new BsportClient(settings, fetcher).verifyAccess(subresources(42, "bookings", [1, 2, 3, 4, 5, 6]));
    const completed = result.then(() => { settled = true; }, () => { settled = true; });
    expect(releases).toHaveLength(4);
    releases[0](new Response(null, { status: 403 }));
    // Drain the response-cancel/error microtasks without releasing other probes.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(settled).toBe(false);
    releases[1](new Response(null, { status: 500 }));
    releases[2](Response.json({ ...fixtures.bookings, id: 3 }));
    releases[3](Response.json({ ...fixtures.bookings, id: 4 }));
    await expect(result).rejects.toThrow("HTTP 500");
    await completed;
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("typed filters and provider semantics", () => {
  it.each([
    ["bookings", { url: "https://evil.example" }], ["bookings", { method: "POST" }], ["customers", { company_id: 43 }],
    ["classes", { pageSize: 101 }], ["classes", { pageSize: 0 }], ["classes", { startsAfter: "2026-11-10T12:00:00" }],
    ["customers", { joinedAfterDate: "2026-02-30" }], ["subscriptions", { benefitId: 1 }], ["subscriptions", { benefitKind: "pack" }],
    ["bookings", { ids: [] }], ["bookings", { ids: Array(101).fill(1) }], ["bookings", { ids: [-1] }],
    ["invoices", { ids: [1] }], ["classPassProducts", { name: "x\r\nX-Company-ID: 43" }], ["classes", { customerId: 1 }],
  ] as [Collection, object][])("refuses unsupported %s filters before HTTP", (collection, options) => {
    expect(() => filterQuery(collection, options)).toThrow();
  });
  it("maps exact query names, booking status codes and benefit kinds", () => {
    expect(Object.fromEntries(filterQuery("bookings", { status: "canceled-by-customer", customerId: 2, hasAttended: false, venueIds: [1, 3] }))).toEqual({ booking_status_code: "2", client_id: "2", has_attended: "false", venue_ids: "1,3", page_size: "50" });
    expect(filterQuery("subscriptions", { benefitKind: "class-pass", benefitId: 2 }).get("benefit_type")).toBe("class_pass");
    expect(filterQuery("invoices", { ids: [INVOICE_ID] }).get("ids")).toBe(INVOICE_ID);
  });
  it("preserves signed money, nullable statuses, unlimited balances and recurrence semantics", () => {
    expect(mapRecord("invoices", fixtures.invoices, 42)).toMatchObject({ status: null, totalAmount: "-49.00", lines: [{ totalAmount: "-49.00" }] });
    expect(mapRecord("subscriptions", fixtures.subscriptions, 42)).toMatchObject({ status: "not-started", firstBillingDate: null, hasDiscount: null, recurrenceBasis: 2, recurrenceUnit: "month", cycleInvoiceCount: 12, recentOrUpcomingInvoiceIds: [INVOICE_ID] });
    expect(mapRecord("classPassProducts", fixtures.classPassProducts, 42)).toMatchObject({ credits: null, isUnlimited: true, startsOn: "purchase" });
    expect(mapRecord("customerClassPasses", fixtures.customerClassPasses, 42)).toMatchObject({ recordedAvailableCredits: 0 });
    expect(mapRecord("bookings", { ...fixtures.bookings, booking_status_code: null }, 42)).toMatchObject({ status: null });
  });
  it("does not coerce malformed provider fields or accept expansions", () => {
    expect(() => mapRecord("customers", { ...fixtures.customers, total_unpaid_amount: 1 }, 42)).toThrow();
    expect(() => mapRecord("bookings", { ...fixtures.bookings, client_id: { id: 2, notes: "private" } }, 42)).toThrow();
    expect(() => mapRecord("bookings", { ...fixtures.bookings, booking_status_code: "new-unknown-status" }, 42)).toThrow();
    for (const benefit of ["unknown", "toString", "constructor", "__proto__"]) {
      expect(() => mapRecord("subscriptions", { ...fixtures.subscriptions, benefit_type: benefit }, 42)).toThrow("Invalid bsport response.");
    }
  });
});

describe("capability locators and observation identities", () => {
  it("round-trips every company, collection and item without granting ancestors", () => {
    expect(supportedResources(42)).toHaveLength(21);
    for (const collection of Object.keys(COLLECTIONS) as Collection[]) {
      for (const resource of [{ company: 42, collection }, { company: 42, collection, id: collection === "invoices" ? INVOICE_ID : 1 }]) {
        expect(parseResourceUrl(resourceUrl(resource), 42)).toEqual(resource);
        validateSubresources(subresources(42, collection, [collection === "invoices" ? INVOICE_ID : 1]), 42);
      }
    }
  });
  it.each(["bsport://staging/companies/42", "bsport://production/companies/43", "https://evil.example", "bsport://production/companies/42/bookings/../customers", "bsport://production/companies/42/bookings/01", "bsport://production/companies/42/bookings/1?company=43", "bsport://production/companies/42/invoices/1"])("rejects locator %s", url => expect(() => parseResourceUrl(url, 42)).toThrow());
  it.each([[], ["global"], ["environment/staging/company/42"], ["environment/production/company/43"], ["environment/production/company/42/unknown/1"], ["environment/production/company/42/bookings/01"]].map(values => ({ values })))("refuses unknown or cross-tenant observation IDs: $values", ({ values }) => expect(() => validateSubresources(values, 42)).toThrow());
});
