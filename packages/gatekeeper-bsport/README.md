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

## Entity relationships and efficient reads

The relationship guide and field-level lookup instructions live in **`src/types.d.ts`**, not
just this README: its `types.txt` symlink is returned by vendor and bound Gatekeeper
`getTypeScriptTypes()`, so Cloudflare OS agents receive the guide with the callable API.
No automatic expansion is performed. An expanded object here means the **supported mapped
details** from another collection, not the provider's full raw object or extra private fields.

### Collection and endpoint names

These are the fixed provider routes under `/api/v2/management/`; use the Gatekeeper methods,
not raw HTTP. Each collection has `list(options)` and `get(id)`; read a returned resource with
`getDetails()`. A list entry already has its mapped object in `entry.details`.

| Company method | Provider route | Entity returned |
| --- | --- | --- |
| `customers()` | `clients/` | Client profile: `firstName`, `lastName`, `fullName`, selected contact/balance fields |
| `bookings()` | `bookings/` | Booking linking a customer, scheduled class, and optionally a purchased class pass |
| `classes()` | `classes/` | Scheduled class: `name`, start time, duration, capacity and reference IDs |
| `subscriptions()` | `client-subscriptions/` | Customer-held subscription; **not** a catalogue subscription product |
| `subscriptionProducts()` | `subscriptions/` | Subscription catalogue product and benefit reference |
| `customerClassPasses()` | `client-class-passes/` | Purchased class pass: holder, product ID, recorded credits and validity |
| `classPassProducts()` | `class-passes/` | Class-pass catalogue product: `name`, price and product rules |
| `customerAppointmentPasses()` | `client-appointment-passes/` | Purchased appointment pass: holder, product ID and recorded credits |
| `appointmentPassProducts()` | `appointment-passes/` | Appointment-pass catalogue product: `name`, price and product rules |
| `invoices()` | `invoices/` | Invoice metadata, amounts and grouped lines; UUID IDs |

Provider `client_id` on records is exposed as **`customerId`**. Provider `firstname`, `lastname`
and `fullname` become `firstName`, `lastName` and `fullName`. This customer ID is unrelated to
the integration's configured `BSPORT_CLIENT_ID` / `X-Client-ID` value. Callers use camelCase
Gatekeeper fields and filters, not provider snake_case names.

bsport omits `phone_number` when no phone is stored, even when requested in the list's `fields`.
Both customer lists and detail reads normalize that absence to `phoneNumber: null`; explicit
null, empty-string and stored phone values retain their meaning. Other missing or malformed
customer fields still fail validation. A customer field mismatch reports only its fixed schema
path, e.g. `Invalid bsport response. Invalid field: customers.joined_date.`, never the value or
provider body. A generic invalid-response error alone is not evidence of a permission denial;
non-200 provider responses are reported separately as `bsport read failed (HTTP <status>).`.

### ID → object lookup map

In this table, `company` means an **already-granted** `BsportCompanySession` for the same
company. `collection.get(id)` opens a resource; call `getDetails()` to obtain its fields.
Lookup chains are conceptual: await the collection and resource first, then their methods;
the executable example below shows the required asynchronous steps.

| Source field | Target collection and ID | Useful resolved fields / next relation |
| --- | --- | --- |
| `customerId` on a booking, customer subscription, purchased pass or invoice | `company.customers()` → `get(customerId)` | `firstName`, `lastName`, `fullName`, `email`; customer IDs identify clients |
| `booking.classId` | `company.classes()` → `get(classId)` | `name`, `startsAt`, `durationMinutes`; this is a scheduled class, not a service |
| `booking.customerClassPassId` (non-null) | `company.customerClassPasses()` → `get(customerClassPassId)` | Holder's `customerId`, `classPassProductId`, recorded credits and validity |
| `customerClassPass.classPassProductId` | `company.classPassProducts()` → `get(classPassProductId)` | Product `name`, price, unlimited flag and rules; **not** the purchased-pass ID |
| `customerAppointmentPass.appointmentPassProductId` | `company.appointmentPassProducts()` → `get(appointmentPassProductId)` | Product `name`, price and rules; **not** the purchased-pass ID |
| `subscription.subscriptionProductId` (non-null) | `company.subscriptionProducts()` → `get(subscriptionProductId)` | Catalogue `name`, benefit and recurrence rules; customer subscription fields remain authoritative for that holding |
| `benefitId` on a subscription or subscription product, with `benefitKind: "class-pass"` | `company.classPassProducts()` → `get(benefitId)` | Class-pass **product**, not a customer's purchased pass |
| `benefitId` with `benefitKind: "appointment-pass"` | `company.appointmentPassProducts()` → `get(benefitId)` | Appointment-pass **product**, not a customer's purchased pass |
| `subscription.recentOrUpcomingInvoiceIds[]` | `company.invoices()` → `get(id)` | At most two invoice references, not complete history; use `invoices().list({ customerId })` for history |
| `invoice.sourceInvoiceId` (non-null) | `company.invoices()` → `get(sourceInvoiceId)` | Related source invoice; retain UUID string IDs |

For example, the complete pass-name chain is:

```text
booking.customerClassPassId
  → customerClassPasses().get(id).getDetails()
  → purchasedPass.classPassProductId
  → classPassProducts().get(id).getDetails()
  → product.name
```

There is no generic `passId`: distinguish the purchased-pass ID from its product ID and the
pass kind. Never resolve a class-pass ID through the appointment-pass collection. Numeric IDs
can coincide across different collections without identifying the same entity.

**Unresolvable references:** `benefitKind: "pack"` has no pack resolver in this connector.
`teacherId`, `substituteTeacherId`, `venueId`, `serviceId` and `companyId` have no matching
profile/catalogue collection here; teacher IDs must not be treated as customer IDs.
`invoice.lines[].itemId` with `itemType` is not a documented universal foreign key: do not
guess a product endpoint from its number. Skip null links; retain an explicit unresolved
reference when a linked record is missing/inaccessible rather than inventing its name.

### Join recipes without per-row request explosions

1. **Select the source rows first.** For a class roster use `bookings().list({ classId })`, then
   resolve distinct `customerId` values to names. Use explicit date/status filters for the
   question being answered; canceled bookings are included unless filtered. A class list
   without start boundaries covers now through 30 days ahead, not history; use
   `startsAfter`/`startsBefore` for history or `classes().get(classId)` for known IDs.
2. **Use data already returned.** Reuse `entry.details` from each source/related list instead
   of calling `entry.resource.getDetails()` again. Deduplicate related IDs across source rows.
   Maintain operation-local maps keyed by company + collection + ID; do not reuse private
   profiles across users or treat old data as proof of current access.
3. **Batch only where supported.** `ids` accepts 1–100 IDs on `customers`, `bookings`,
   `subscriptions`, `subscriptionProducts`, `classPassProducts`, `customerClassPasses`,
   `customerAppointmentPasses` and `invoices`. Chunk distinct IDs, skip empty chunks and set
   `pageSize: 100`; still drain every cursor until `null`, even after an empty page.
   `classes` and `appointmentPassProducts` do **not** have an `ids` filter. Reuse a relevant
   filtered listing or call `get(id).getDetails()` once per distinct needed ID, with bounded
   concurrency (e.g. four in flight), rather than launching an unbounded `Promise.all`.
4. **Use the correct reverse filter.** Bookings, customer subscriptions, purchased appointment
   passes and invoices accept singular `customerId`; purchased class passes accept plural
   `customerIds`. `ids` always filters that collection's own records, not the related customers.
   Subscription `benefitKind` and `benefitId` filters must be supplied together. Filters combine
   with AND. Use the declared typed filters; do not send `expand[]`, `include` or guessed keys.
5. **Release capabilities and preserve errors.** Dispose collections, cursors and every list
   entry's `resource`, including when only using `details`. Missing/inaccessible related data
   is not a reason to discard the original row. Do not turn authentication, rate-limit, transport
   or provider errors into empty results, and do not retry them in an unbounded loop.

To join **one** booking (provided as `booking`) using an already-granted company session:

```ts
using customers = await company.customers();
using classes = await company.classes();
using customer = await customers.get(booking.customerId);
using scheduledClass = await classes.get(booking.classId);
const [profile, classDetails] = await Promise.all([customer.getDetails(), scheduledClass.getDetails()]);
// profile.firstName / profile.lastName / profile.fullName; classDetails.name
```

For many bookings, collect distinct customer IDs and batch `customers().list({ ids, pageSize: 100 })`
instead. Scope still applies: a record-only or collection-only binding cannot open sibling
collections. Request the necessary collections/records through the normal connection flow;
documentation does not grant broader access. Joined reads are live and not a transactional snapshot.

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
`X-Company-ID`, and optional fixed `X-Franchisor-ID`. Fetch uses Workers-supported `redirect: "manual"`
and rejects non-200 responses, including redirects, without following them. Filters are
allowlisted, pages have at most 100 records (default 50), responses at most 2 MiB, and numeric
page indices at most 100,000. Each request times out after 15 seconds and retries once only for
502/503/504. Access probes deduplicate records, run at most four concurrent requests, stop scheduling
on failure and settle all in-flight requests. Large historical observer sets can therefore be slow
and consume provider quota; they are never silently truncated.

The default HTTP fetcher is bound to `globalThis`: native Workers `fetch` rejects a client
instance as its receiver. An incorrect receiver is sanitized as `bsport read unavailable.`,
just like other transport exceptions; provider HTTP rejections instead report their status.
Workers does not support `redirect: "error"`; that option also throws before sending a request.

```sh
pnpm --filter gatekeeper-bsport test:run
pnpm exec vp run -F gatekeeper-bsport --no-cache build
pnpm lint
pnpm test
```

Both test entrypoints generate the CSP-hashed picker before testing. Tests run in workerd with
synthetic identities and mocked provider/JWKS requests. Native-fetch regression tests intercept
outbound I/O without replacing `fetch`, exercising pages, details, access probes and redirect rejection; all
other native outbound requests are rejected locally. Tests also include actual faceted Gatekeeper,
session and approval-queue RPC paths. Expected RPC rejection tests can print workerd's exception
diagnostics; Vitest still must finish without failed tests or unhandled-error reports. Never
disable unhandled-error checking to make the suite pass.
