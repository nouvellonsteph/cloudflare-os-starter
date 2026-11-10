import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type * as T from "./types.js";
import { BsportClient } from "./client.js";
import { filterQuery } from "./filters.js";
import { recordId, subresources, type Collection, type Resource } from "./resources.js";
import type { Details } from "./mapping.js";

export type Filters = T.BsportBookingFilter | T.BsportClassFilter | T.BsportCustomerFilter |
  T.BsportSubscriptionFilter | T.BsportSubscriptionProductFilter | T.BsportClassPassProductFilter |
  T.BsportAppointmentPassProductFilter | T.BsportCustomerClassPassFilter | T.BsportCustomerAppointmentPassFilter | T.BsportInvoiceFilter;

export type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> & {
  dup(): ObservationQueue;
  [Symbol.dispose](): void;
};

/** A reading session's authorizer follows every child, without retaining another chat's queue. */
export class ReadContext {
  constructor(readonly client: BsportClient, readonly company: number, readonly queue: ObservationQueue, readonly check: () => Promise<void>) {}
  dup(): ReadContext { return new ReadContext(this.client, this.company, this.queue.dup(), this.check); }
  async authorize(observation: ObservationDescription & { subresources: string[] }): Promise<void> {
    await this.check();
    await this.queue.authorizeObservation({ ...observation, containsRestrictedData: true });
    // A revoke may interleave with the Workshop's authorization RPC.
    await this.check();
  }
  dispose(): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class RecordSession extends RpcTarget implements T.BsportResource<Details> {
  readonly #context: ReadContext;
  readonly #collection: Collection;
  readonly #id: number | string;
  constructor(context: ReadContext, collection: Collection, id: number | string) {
    super(); this.#context = context; this.#collection = collection; this.#id = recordId(collection, id);
  }
  async getDetails(): Promise<Details> {
    await this.#context.check();
    const details = await this.#context.client.details(this.#collection, this.#id);
    await this.#context.authorize({
      title: "Read bsport record", description: "Read the supported fields of one bsport record.",
      subresources: subresources(this.#context.company, this.#collection, [this.#id]),
    });
    return details;
  }
  [Symbol.dispose](): void { this.#context.dispose(); }
}

@validateRpc()
export class PageCursor extends RpcTarget implements T.BsportCursor<T.BsportEntry<Details>> {
  readonly #context: ReadContext;
  readonly #collection: Collection;
  readonly #options: Filters;
  #page: number | null = 1;
  #tail: Promise<void> = Promise.resolve();
  constructor(context: ReadContext, collection: Collection, options: Filters) {
    super(); this.#context = context; this.#collection = collection; this.#options = structuredClone(options);
  }
  async next(): Promise<T.BsportEntry<Details>[] | null> {
    // Serialize overlapping next() calls so a page cannot be skipped, duplicated or advanced on denial.
    const result = this.#tail.then(async () => {
      await this.#context.check();
      if (this.#page === null) {
        await this.#context.authorize({ title: "Read bsport page", description: "Confirm the end of a bsport listing.", subresources: subresources(this.#context.company) });
        return null;
      }
      const page = await this.#context.client.page(this.#collection, this.#options, this.#page);
      await this.#context.authorize({
        title: "Read bsport page", description: "Read a page of supported bsport records.",
        subresources: subresources(this.#context.company, this.#collection, page.records.map(row => row.id)),
      });
      this.#page = page.next;
      return page.records.map(details => ({ details, resource: new RecordSession(this.#context.dup(), this.#collection, details.id) }));
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
  [Symbol.dispose](): void { this.#context.dispose(); }
}

@validateRpc()
export class CollectionSession extends RpcTarget implements T.BsportCollection<Details, Filters, number | string> {
  readonly #context: ReadContext;
  readonly #collection: Collection;
  constructor(context: ReadContext, collection: Collection) { super(); this.#context = context; this.#collection = collection; }
  async list(options: Filters = {}): Promise<T.BsportCursor<T.BsportEntry<Details>>> {
    filterQuery(this.#collection, options);
    await this.#context.check();
    return new PageCursor(this.#context.dup(), this.#collection, options);
  }
  async get(id: number | string): Promise<T.BsportResource<Details>> {
    const normalized = recordId(this.#collection, id);
    await this.#context.check();
    return new RecordSession(this.#context.dup(), this.#collection, normalized);
  }
  [Symbol.dispose](): void { this.#context.dispose(); }
}

@validateRpc()
export class CompanySession extends RpcTarget implements T.BsportCompanySession {
  readonly #context: ReadContext;
  constructor(context: ReadContext) { super(); this.#context = context; }
  /** The fixed collection tag selects its mapper and allowlist; RPC validates the union shape. */
  async bookings(): Promise<T.BsportBookings> { return new CollectionSession(this.#context.dup(), "bookings") as T.BsportBookings; }
  async classes(): Promise<T.BsportClasses> { return new CollectionSession(this.#context.dup(), "classes") as T.BsportClasses; }
  async customers(): Promise<T.BsportCustomers> { return new CollectionSession(this.#context.dup(), "customers") as T.BsportCustomers; }
  async subscriptions(): Promise<T.BsportSubscriptions> { return new CollectionSession(this.#context.dup(), "subscriptions") as T.BsportSubscriptions; }
  async subscriptionProducts(): Promise<T.BsportSubscriptionProducts> { return new CollectionSession(this.#context.dup(), "subscriptionProducts") as T.BsportSubscriptionProducts; }
  async classPassProducts(): Promise<T.BsportClassPassProducts> { return new CollectionSession(this.#context.dup(), "classPassProducts") as T.BsportClassPassProducts; }
  async appointmentPassProducts(): Promise<T.BsportAppointmentPassProducts> { return new CollectionSession(this.#context.dup(), "appointmentPassProducts") as T.BsportAppointmentPassProducts; }
  async customerClassPasses(): Promise<T.BsportCustomerClassPasses> { return new CollectionSession(this.#context.dup(), "customerClassPasses") as T.BsportCustomerClassPasses; }
  async customerAppointmentPasses(): Promise<T.BsportCustomerAppointmentPasses> { return new CollectionSession(this.#context.dup(), "customerAppointmentPasses") as T.BsportCustomerAppointmentPasses; }
  async invoices(): Promise<T.BsportInvoices> { return new CollectionSession(this.#context.dup(), "invoices") as T.BsportInvoices; }
  [Symbol.dispose](): void { this.#context.dispose(); }
}

export type Session = T.BsportCompanySession | T.BsportCollection<Details, Filters, number | string> | T.BsportResource<Details>;
export function sessionFor(context: ReadContext, resource: Resource): Session {
  if (!resource.collection) return new CompanySession(context);
  return resource.id === undefined ? new CollectionSession(context, resource.collection) : new RecordSession(context, resource.collection, resource.id);
}
