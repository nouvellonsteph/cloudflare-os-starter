import { companyId, ensureConfigured, type BsportEnv } from "./env.js";
import { filterQuery } from "./filters.js";
import { COLLECTIONS, recordId, validateSubresources, type Collection } from "./resources.js";
import { parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { CUSTOMER_FIELDS, invalidResponse, mapRecord, object, type Details } from "./mapping.js";

const ORIGIN = "https://public.production.bsport.io";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGE = 100_000;
const PROBE_BATCH_SIZE = 4;
// Leave headroom within bsport's 20 GETs per second, per endpoint and tenant.
const PROBE_BATCH_INTERVAL_MS = 300;
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000];

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Sanitized failures never carry provider bodies, URLs, headers or underlying fetch errors. */
export class BsportError extends Error {
  constructor(readonly status: number) {
    super(status === 429
      ? "bsport rate limit reached (HTTP 429). Wait a few seconds before retrying."
      : `bsport read failed (HTTP ${status}).`);
  }
}

/** Cleanup must not replace a sanitized failure with a provider stream error. */
async function discardBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* The body is already unusable. */ }
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BYTES) {
    await discardBody(response);
    return invalidResponse();
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !response.body) {
    await discardBody(response);
    return invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); return invalidResponse(); }
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(joined));
  } catch { return invalidResponse(); }
  finally { reader.releaseLock(); }
}

/** The only provider HTTP boundary: constructed, allowlisted GETs, fixed origin and tenant. */
export class BsportClient {
  /** Native Workers fetch requires the global receiver when called as a stored method. */
  constructor(
    readonly env: BsportEnv,
    readonly fetcher: typeof fetch = fetch.bind(globalThis),
    readonly beforeRequest?: (collection: Collection) => Promise<void>,
  ) {}

  /** Internal live access probes; their data never crosses to an agent or into durable storage. */
  async verifyAccess(values: string[]): Promise<void> {
    validateSubresources(values, companyId(this.env));
    const records = [...new Set(values)].map(value => parseSubresourceId(value).fragments[2]).filter(value => value !== undefined);
    if (!records.length) {
      await this.page("bookings", { pageSize: 1 }, 1);
      return;
    }
    for (let index = 0; index < records.length; index += PROBE_BATCH_SIZE) {
      const started = Date.now();
      const batch = records.slice(index, index + PROBE_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(record => {
        const collection = record.name as Collection;
        return this.details(collection, collection === "invoices" ? record.id : Number(record.id));
      }));
      // Settle the batch before deciding: an indeterminate failure takes precedence over denial.
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      const uncertain = errors.find(error => !(error instanceof BsportError && [403, 404].includes(error.status)));
      if (uncertain !== undefined) throw uncertain;
      if (errors.length) throw errors[0];
      const remaining = PROBE_BATCH_INTERVAL_MS - (Date.now() - started);
      if (index + PROBE_BATCH_SIZE < records.length && remaining > 0) {
        await wait(remaining);
      }
    }
  }

  async #get(collection: Collection, id: number | string | undefined, query: URLSearchParams): Promise<unknown> {
    ensureConfigured(this.env);
    const route = COLLECTIONS[collection]?.[0];
    if (!route) throw new Error("Unknown bsport collection.");
    const url = new URL(`/api/v2/management/${route}/` + (id === undefined ? "" : `${recordId(collection, id)}/`), ORIGIN);
    url.search = query.toString();
    let headers: Headers;
    try {
      headers = new Headers({
        "Accept": "application/json", "X-Api-Key": this.env.BSPORT_API_KEY!,
        "X-Client-ID": this.env.BSPORT_CLIENT_ID, "X-Company-ID": this.env.BSPORT_COMPANY_ID,
      });
      if (this.env.BSPORT_FRANCHISOR_ID) headers.set("X-Franchisor-ID", this.env.BSPORT_FRANCHISOR_ID);
    } catch { throw new Error("Invalid bsport credential configuration."); }
    let rateLimitRetries = 0;
    let retriedServerError = false;
    for (;;) {
      if (this.beforeRequest) await this.beforeRequest(collection);
      let response: Response;
      try {
        // Workers supports manual, not error; reject redirects below without following them.
        response = await this.fetcher(url, { method: "GET", headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      } catch { throw new Error("bsport read unavailable."); }
      if (response.status !== 200) {
        await discardBody(response);
        if (response.status === 429 && rateLimitRetries < RATE_LIMIT_BACKOFF_MS.length) {
          await wait(RATE_LIMIT_BACKOFF_MS[rateLimitRetries++]);
          continue;
        }
        if (!retriedServerError && [502, 503, 504].includes(response.status)) {
          retriedServerError = true;
          continue;
        }
        throw new BsportError(response.status);
      }
      return readJson(response);
    }
  }

  async details(collection: Collection, id: number | string): Promise<Details> {
    const normalized = recordId(collection, id);
    return mapRecord(collection, await this.#get(collection, normalized, new URLSearchParams()), companyId(this.env), normalized);
  }

  async page(collection: Collection, options: object, page: number): Promise<{ records: Details[]; next: number | null }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new Error("bsport pagination limit reached; narrow the filters.");
    const query = filterQuery(collection, options);
    query.set("page", String(page));
    if (collection === "customers") query.set("fields", CUSTOMER_FIELDS);
    const data = object(await this.#get(collection, undefined, query));
    if (!Array.isArray(data.results) || data.results.length > Number(query.get("page_size"))) return invalidResponse();
    const next = data.next_page;
    if (next !== null && (typeof next !== "number" || !Number.isSafeInteger(next) || next <= page || next > MAX_PAGE)) return invalidResponse();
    return { records: data.results.map(row => mapRecord(collection, row, companyId(this.env))), next: next as number | null };
  }
}
