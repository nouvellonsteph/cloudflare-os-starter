import { describe, expect, it } from "vitest";
import spec from "../src/configurator/bsport-configurator-ui.js";
import { COLLECTIONS, parseResourceUrl, resourceUrl, type Collection, type Resource } from "../src/resources.js";
import { INVOICE_ID } from "./fixtures.js";
import HTML from "../src/generated/bsport-configurator-ui.txt";

describe("resource picker", () => {
  it("prefills and round-trips every concrete company, collection and record", () => {
    const resources: Resource[] = [{ company: 42 }, ...(Object.keys(COLLECTIONS) as Collection[]).flatMap(collection => [
      { company: 42, collection }, { company: 42, collection, id: collection === "invoices" ? INVOICE_ID : 1 },
    ])];
    for (const resource of resources) {
      const url = resourceUrl(resource);
      const values = spec.initialValuesFromResourceUrl({ resourceUrl: url, resourceUrlPattern: url, ui: null });
      expect(spec.isReady({ values })).toBe(true);
      expect(spec.resourceUrl({ values, ui: null })).toBe(url);
      expect(parseResourceUrl(url, 42)).toEqual(resource);
    }
  });
  it("defaults to the host's selected scope, never to a hardcoded company or a broader scope", () => {
    const acceptedResourceUrlPatterns = ["bsport://production/companies/42/bookings"];
    expect(spec.isReady({ values: spec.initial, acceptedResourceUrlPatterns })).toBe(true);
    expect(spec.resourceUrl({ values: spec.initial, acceptedResourceUrlPatterns, ui: null })).toBe(acceptedResourceUrlPatterns[0]);
    for (const url of ["bsport://production/companies/43/bookings", "bsport://production/companies/42", "bsport://production/companies/42/customers", "bsport://production/companies/42/bookings/1"]) {
      expect(spec.isReady({ values: { url }, acceptedResourceUrlPatterns })).toBe(false);
    }
    expect(spec.isReady({ values: spec.initial })).toBe(false);
    expect(spec.isReady({ values: spec.initial, acceptedResourceUrlPatterns: [] })).toBe(false);
  });
  it.each(["bookings/01", "unknown", "invoices/1", "bookings/1?x=1", "bookings/0", "bookings/9007199254740992", "bookings/:recordId"])("refuses invalid selection %s", suffix => {
    expect(spec.isReady({ values: { url: `bsport://production/companies/42/${suffix}` } })).toBe(false);
  });
  it("ships unmodified scripts matching the generated CSP hashes", async () => {
    for (const match of HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
      const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
      expect(HTML).toContain(`'sha256-${base64}'`);
    }
    expect(HTML).not.toContain("__BSPORT_DEFAULT_URL__");
    expect(HTML).toContain("connect-src 'none'");
  });
});
