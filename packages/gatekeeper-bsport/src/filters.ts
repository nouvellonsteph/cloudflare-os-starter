import { recordId, type Collection } from "./resources.js";

type Field = readonly [query: string, kind: "id" | "ids" | "invoiceIds" | "text" | "bool" | "date" | "datetime" | "bookingStatus" | "benefit" | "invoiceStatus"];
const common = { ids: ["ids", "ids"] } satisfies Record<string, Field>;
const customer = { customerId: ["client_id", "id"] } satisfies Record<string, Field>;
const benefit = { benefitId: ["benefit_id", "id"], benefitKind: ["benefit_type", "benefit"] } satisfies Record<string, Field>;
const disabled = { isDisabled: ["is_disabled", "bool"] } satisfies Record<string, Field>;
const manager = { isManagerOnly: ["is_manager_only", "bool"] } satisfies Record<string, Field>;
const created = { createdAfter: ["created_after", "datetime"], createdBefore: ["created_before", "datetime"] } satisfies Record<string, Field>;

const FIELDS: Record<Collection, Record<string, Field>> = {
  bookings: { ...common, ...customer, ...created,
    classId: ["class_id", "id"], customerClassPassId: ["client_class_pass_id", "id"],
    classStartsAfter: ["class_start_after", "datetime"], classStartsBefore: ["class_start_before", "datetime"],
    status: ["booking_status_code", "bookingStatus"], hasAttended: ["has_attended", "bool"],
    venueIds: ["venue_ids", "ids"], teacherIds: ["teacher_ids", "ids"], serviceIds: ["service_ids", "ids"],
  },
  classes: { startsAfter: ["starts_after", "datetime"], startsBefore: ["starts_before", "datetime"],
    serviceId: ["service_id", "id"], venueId: ["venue_id", "id"], teacherId: ["teacher_id", "id"], currentTeacherId: ["current_teacher_id", "id"],
  },
  customers: { ...common, email: ["email", "text"], isArchived: ["is_archived", "bool"], joinedAfterDate: ["joined_after_date", "date"], joinedBeforeDate: ["joined_before_date", "date"] },
  subscriptions: { ...common, ...customer, ...benefit },
  subscriptionProducts: { ...common, ...benefit, ...disabled, ...manager },
  classPassProducts: { ...common, ...disabled, ...manager, name: ["name", "text"], nameContains: ["name_contains", "text"], isNewCustomerOnly: ["is_new_client_only", "bool"] },
  appointmentPassProducts: { ...disabled, name: ["name", "text"] },
  customerClassPasses: { ...common, ...disabled, customerIds: ["client_ids", "ids"], classPassProductId: ["class_pass_id", "id"],
    purchasedAfterDate: ["purchased_after_date", "date"], purchasedBeforeDate: ["purchased_before_date", "date"], hasCreditsAvailable: ["has_credits_available", "bool"],
  },
  customerAppointmentPasses: { ...common, ...customer, ...disabled, appointmentPassProductId: ["appointment_pass_id", "id"],
    purchasedAfter: ["purchased_after", "datetime"], purchasedBefore: ["purchased_before", "datetime"], isRefunded: ["is_refunded", "bool"],
  },
  invoices: { ...customer, ...created, ids: ["ids", "invoiceIds"], status: ["status", "invoiceStatus"], issuedAfter: ["issued_after", "datetime"], issuedBefore: ["issued_before", "datetime"] },
};

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function isDatetime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

export const BOOKING_STATUSES = ["active", "canceled-by-manager", "canceled-by-customer", "class-canceled"] as const;

function encode(kind: Field[1], value: unknown): string {
  if (kind === "id") return String(recordId("bookings", value as number));
  if (kind === "ids" || kind === "invoiceIds") {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error("ID filters require 1–100 IDs.");
    return value.map(id => String(recordId(kind === "ids" ? "bookings" : "invoices", id))).join(",");
  }
  if (kind === "bool" && typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex -- Refuse control characters in caller-supplied filters.
    if (kind === "text" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (kind === "date" && isDate(value)) return value;
    if (kind === "datetime" && isDatetime(value)) return value;
    if (kind === "bookingStatus" && BOOKING_STATUSES.includes(value as typeof BOOKING_STATUSES[number])) return String(BOOKING_STATUSES.indexOf(value as typeof BOOKING_STATUSES[number]));
    if (kind === "benefit" && ["class-pass", "appointment-pass", "pack"].includes(value)) return value.replaceAll("-", "_");
    if (kind === "invoiceStatus" && ["draft", "open", "paid", "voided", "refunded"].includes(value)) return value;
  }
  throw new Error("Invalid bsport filter value.");
}

/** Allowlist and semantic validation augment RPC shape validation; raw query objects never reach fetch. */
export function filterQuery(collection: Collection, options: object = {}): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === "pageSize") {
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("pageSize must be 1–100.");
      query.set("page_size", String(value));
      continue;
    }
    const field = FIELDS[collection][key];
    if (!field || !Object.hasOwn(FIELDS[collection], key)) throw new Error("Unsupported bsport filter.");
    query.set(field[0], encode(field[1], value));
  }
  if (query.has("benefit_type") !== query.has("benefit_id")) throw new Error("Supply benefitKind and benefitId together.");
  if (!query.has("page_size")) query.set("page_size", "50");
  return query;
}
