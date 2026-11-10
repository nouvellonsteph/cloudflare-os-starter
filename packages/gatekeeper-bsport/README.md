# bsport read-only Gatekeeper

Wrapper-owned integration for **one production bsport company**. It does not edit the pinned
`cloudflare-os/` submodule or replace the starter's custom example. It is opt-in under
`gatekeepers.bsport` and builds in the starter workspace.

The vendor logo and connected-account avatar use the official 256×256 bsport icon embedded in
[`src/logo.ts`](src/logo.ts), with no external image requests. Source: the `apple-touch-icon`
linked by [bsport's website](https://pro.bsport.io/),
[`favicon-big.png`](https://cdn.prod.website-files.com/698617c87d83f488db5cae4d/6986188a088732a51f143fed_favicon-big.png).
The asset remains bsport's trademark.

## Capabilities

[`src/types.d.ts`](src/types.d.ts) is the agent-facing contract. Bind the whole company, one
collection, or exactly one record:

```text
bsport://production/companies/42
bsport://production/companies/42/bookings
bsport://production/companies/42/bookings/123
```

The company session opens bookings, classes, customers, customer subscriptions, subscription
products, class-pass products, appointment-pass products, customer class passes, customer
appointment passes, and invoices. Collections support typed `list()` filters and `get(id)`;
records expose only `getDetails()`. Lists return cursors: drain until `null`, not an empty array,
and dispose cursors and record capabilities when finished. Invoice IDs are UUID strings; other
record IDs are positive safe integers.

Money stays in signed decimal strings in major units. A subscription is not proof of payment;
recorded pass balances are not computed eligibility. Booking status and subscription billing/discount
fields preserve provider nulls. Unfiltered classes use bsport's now-to-30-days-ahead default.
Appointment-pass product name filters are substring matches, not exact matches.

No writes, arbitrary URLs, caller-selected credentials/tenants, expansions, hooks, invoice PDFs,
medical notes, identity documents, birth dates, emergency contacts or payment-provider IDs are
exposed. Customer lists request only the mapped fields. Detail endpoints can return extra fields;
these are discarded during mapping, never logged or stored by this Worker. Free-text descriptions
are provider content, not instructions to trust.

## Private access and lifecycle

- The API key authenticates the service; **it does not grant collaborators access**. Only a
  signed Access JWT for `BSPORT_OWNER_EMAIL` may enroll. The owner confirms a short-lived,
  single-use connection link, then completes the normal Workshop handoff in that browser's session.
- The account stores the verified email/subject, tenant/client/franchisor and Access realm,
  status, callback and temporary flow/stage state. It never stores the API key or provider records.
  Reconnect stages stay inert until Workshop commits the matching ticket's stage ID. New reconnects
  supersede prior stages; failed initial callbacks revoke the connection.
- Every data-bearing read, including empty and terminal pages, authorizes an observation with
  `containsRestrictedData: true` and explicit canonical subresources: `environment/production/company/42`
  plus each disclosed record, e.g. `environment/production/company/42/bookings/123`.
- `verifyObserverAccess()` permits only the originating connection with a live deployment-pinned
  entitlement, and probes bsport detail access for every reported record (a one-row bookings query
  for company-only requirements). Sharing a workspace or making another connection with the same
  key does not qualify. `403`/`404` deny; `401`, rate limits, transport failures and outages propagate
  as indeterminate failures. No verdict cache or legacy observer roster is kept.
- Existing sessions and children recheck entitlement on reads, including after queue authorization.
  Removing the owner, changing tenant/client/franchisor or Access realm, or revoking the connection
  blocks old grants on their next use. Reconnect requires the original email and subject. Rotating
  the same company's key does not change entitlement; provider access is checked live.

Private-only is not DLP: an authorized owner's agent can still reproduce data elsewhere. Existing
copies cannot be erased by revoking this connector. Workshop stores disclosed data and its audit
history under its own retention policy; this Worker has no durable provider-data cache.

## Configuration and secure setup

This is a **template**, not an instruction to change production settings:

```jsonc
"gatekeepers": {
  "bsport": {
    "name": "acme-os-gk-bsport",
    "vars": {
      "BSPORT_COMPANY_ID": "42",
      "BSPORT_CLIENT_ID": "provider-issued-client-id",
      "BSPORT_OWNER_EMAIL": "owner@example.com"
      // "BSPORT_FRANCHISOR_ID": "7" // only for the confirmed franchise credential type
    }
  }
}
```

The wrapper derives `BASE_URL`, `CF_ACCESS_ISS` and `CF_ACCESS_AUD` from the validated deployment.
It refuses credential values in vars, unknown vars and tenant/realm overrides. The bsport Worker
has no public route, workers.dev or Preview URL; only the Access-protected Router reaches its
`/gatekeeper/bsport/connect` handler. Its base compatibility date matches the pinned wrapper
runtime. Generated observability inherits `deployment.jsonc`: review logs, traces, retention and
exporters before production. No provider bodies, credentials or identity artifacts should be logged.

Before any live validation or deployment, confirm together:

1. Company ID and client ID, company-versus-franchise credential type and any franchisor ID.
2. The approved Access owner's email and final, stable Worker name.
3. Exact account, protected hostname, existing Worker ownership and compatible Cloudflare OS
   version. The parent platform upgrade's migration/rollback gates remain separate.
4. Explicit approval for production deployment and secret installation (both mutate production).

Only then may a human set `BSPORT_API_KEY` interactively on the **already deployed, confirmed**
Worker using `pnpm cf-os secrets bsport`. This is an API key, not OAuth; there is no provider
redirect URI. Alternatively use Wrangler's interactive `secret put BSPORT_API_KEY` with the
confirmed account selector and Worker name. Installing a secret immediately creates/deploys a
new Worker version. Never paste the value in chat, a config, browser code, an RPC argument,
command-line arguments, a log or Git. Confirm only the secret's name, not its value.

Keep the connector disabled until an approved owner read, denied identity, separate connection,
shared-workspace denial, reconnect and revocation have been verified against approved test data.
Provider permissions and field compatibility have **not** been proven by synthetic tests. No API
call or deployment is implied by a passing local check.

## HTTP boundary and verification

`src/client.ts` is the only provider HTTP boundary. It constructs GET routes at
`https://public.production.bsport.io/api/v2/management/` with `X-Api-Key`, `X-Client-ID`,
`X-Company-ID`, and optional fixed `X-Franchisor-ID`. Redirects are rejected. Filters are
allowlisted, pages have at most 100 records (default 50), responses at most 2 MiB, and numeric
page indices at most 100,000. Each request times out after 15 seconds and retries once only for
502/503/504. Access probes deduplicate records, run at most four concurrent requests, stop scheduling
on failure and settle all in-flight requests. Large historical observer sets can therefore be slow
and consume provider quota; they are never silently truncated.

```sh
pnpm --filter gatekeeper-bsport test:run
pnpm exec vp run -F gatekeeper-bsport --no-cache build
pnpm lint
pnpm test
```

Both test entrypoints generate the CSP-hashed picker before testing. Tests run in workerd with
synthetic identities and mocked provider/JWKS requests, and include actual faceted Gatekeeper,
session and approval-queue RPC paths. Expected RPC rejection tests can print workerd's exception
diagnostics; Vitest still must finish without failed tests or unhandled-error reports. Never
disable unhandled-error checking to make the suite pass.
