import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** Fixed route, agent type, and label for every allowed collection. No URL comes from a caller. */
export const COLLECTIONS = {
  bookings: ["bookings", "Bookings", "BsportBooking"],
  classes: ["classes", "Classes", "BsportClass"],
  customers: ["clients", "Customers", "BsportCustomer"],
  subscriptions: ["client-subscriptions", "Subscriptions", "BsportSubscription"],
  subscriptionProducts: ["subscriptions", "SubscriptionProducts", "BsportSubscriptionProduct"],
  classPassProducts: ["class-passes", "ClassPassProducts", "BsportClassPassProduct"],
  appointmentPassProducts: ["appointment-passes", "AppointmentPassProducts", "BsportAppointmentPassProduct"],
  customerClassPasses: ["client-class-passes", "CustomerClassPasses", "BsportCustomerClassPass"],
  customerAppointmentPasses: ["client-appointment-passes", "CustomerAppointmentPasses", "BsportCustomerAppointmentPass"],
  invoices: ["invoices", "Invoices", "BsportInvoice"],
} as const;
export type Collection = keyof typeof COLLECTIONS;
export type Resource = { company: number; collection?: Collection; id?: number | string };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCollection(value: string): value is Collection {
  return Object.hasOwn(COLLECTIONS, value);
}

export function recordId(collection: Collection, id: number | string): number | string {
  if (collection === "invoices") {
    if (typeof id === "string" && UUID.test(id)) return id.toLowerCase();
  } else if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
    return id;
  }
  throw new Error("Invalid bsport record ID.");
}

export function resourceUrl(resource: Resource): string {
  return `bsport://production/companies/${resource.company}` +
    (resource.collection ? `/${resource.collection}` + (resource.id === undefined ? "" : `/${resource.id}`) : "");
}

export function parseResourceUrl(value: string, company: number): Resource {
  const prefix = resourceUrl({ company });
  if (value === prefix || value === `${prefix}/`) return { company };
  if (!value.startsWith(`${prefix}/`)) throw new Error("Resource is outside the configured bsport company.");
  const parts = value.slice(prefix.length + 1).replace(/\/$/, "").split("/");
  if (parts.length > 2 || !isCollection(parts[0])) throw new Error("Invalid bsport resource.");
  const collection = parts[0];
  if (parts.length === 1) return { company, collection };
  const id = recordId(collection, collection === "invoices" ? parts[1] : Number(parts[1]));
  if (String(id) !== parts[1]) throw new Error("Invalid bsport record ID.");
  return { company, collection, id };
}

export function supportedResources(company: number): SupportedResource[] {
  const root = resourceUrl({ company });
  return [
    ...Object.entries(COLLECTIONS).flatMap(([collection, [, label]]) => [
      { urlPattern: `${root}/${collection}/:recordId`, title: `bsport ${label} record`, description: "Read one record only." },
      { urlPattern: `${root}/${collection}`, title: `bsport ${label}`, description: "Read this collection only." },
    ]),
    { urlPattern: root, title: "bsport company", description: "Read all ten supported collections in the configured company." },
  ];
}

export function resourceType(resource: Resource): string {
  if (!resource.collection) return "BsportCompanySession";
  const [, label, type] = COLLECTIONS[resource.collection];
  return resource.id === undefined ? `Bsport${label}` : `${type}Resource`;
}

/** Every observation includes the company, even an empty or terminal page. */
export function subresources(company: number, collection?: Collection, ids: (string | number)[] = []): string[] {
  const fragments = [{ name: "environment", id: "production" }, { name: "company", id: String(company) }];
  return [formatSubresourceId({ fragments }), ...ids.map(id => formatSubresourceId({
    fragments: [...fragments, { name: collection!, id: String(recordId(collection!, id)) }],
  }))];
}

/** Accept exactly the kinds and immutable tenant identities this Worker reports. */
export function validateSubresources(values: string[], company: number): void {
  if (values.length === 0 || values.length > 10_000) throw new Error("Invalid bsport subresources.");
  for (const value of values) {
    const { namespace, fragments: f } = parseSubresourceId(value);
    if (namespace !== undefined || (f.length !== 2 && f.length !== 3) ||
        f[0].name !== "environment" || f[0].id !== "production" ||
        f[1].name !== "company" || f[1].id !== String(company)) throw new Error("Invalid bsport subresource.");
    if (f.length === 3) {
      if (!isCollection(f[2].name)) throw new Error("Unknown bsport subresource.");
      const parsed = recordId(f[2].name, f[2].name === "invoices" ? f[2].id : Number(f[2].id));
      if (String(parsed) !== f[2].id) throw new Error("Invalid bsport subresource ID.");
    }
  }
}
