import type * as T from "./types.js";
import { BOOKING_STATUSES, isDate, isDatetime } from "./filters.js";
import { recordId, type Collection } from "./resources.js";

export type Details = T.BsportBooking | T.BsportClass | T.BsportCustomer | T.BsportSubscription |
  T.BsportSubscriptionProduct | T.BsportClassPassProduct | T.BsportAppointmentPassProduct |
  T.BsportCustomerClassPass | T.BsportCustomerAppointmentPass | T.BsportInvoice;

type Decoder<V = unknown> = (value: unknown) => V;
type Schema<Value> = { [K in keyof Value]-?: readonly [source: string, decode: Decoder<Value[K]>] };
export function invalidResponse(): never { throw new Error("Invalid bsport response."); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
const text: Decoder<string> = v => typeof v === "string" && v.length <= 100_000 ? v : invalidResponse();
const integer: Decoder<number> = v => typeof v === "number" && Number.isSafeInteger(v) ? v : invalidResponse();
const id: Decoder<number> = v => integer(v) > 0 ? v as number : invalidResponse();
const bool: Decoder<boolean> = v => typeof v === "boolean" ? v : invalidResponse();
const money: Decoder<string> = v => typeof v === "string" && /^-?\d{1,12}(?:\.\d{1,2})?$/.test(v) ? v : invalidResponse();
const date: Decoder<string> = v => typeof v === "string" && isDate(v) ? v : invalidResponse();
const datetime: Decoder<string> = v => typeof v === "string" && isDatetime(v) ? v : invalidResponse();
const invoiceId: Decoder<string> = v => typeof v === "string" ? recordId("invoices", v) as string : invalidResponse();
const nullable = <V>(decoder: Decoder<V>): Decoder<V | null> => v => v === null ? null : decoder(v);
const enumeration = <V extends string>(values: readonly V[]): Decoder<V> => v => values.includes(v as V) ? v as V : invalidResponse();
const benefit: Decoder<T.BsportBenefitKind> = v => {
  if (v === "class_pass") return "class-pass";
  if (v === "appointment_pass") return "appointment-pass";
  if (v === "pack") return "pack";
  return invalidResponse();
};
const unit = enumeration(["day", "week", "month", "year"] as const);
const bookingStatus: Decoder<T.BsportBookingStatus> = v => {
  const index = ["OK", "Canceled by manager", "Canceled by client", "Class canceled"].indexOf(text(v));
  return BOOKING_STATUSES[index] ?? invalidResponse();
};
const subscriptionStatus: Decoder<T.BsportSubscriptionStatus> = v =>
  (["not-started", "started", "stopped", "paused", "ended"] as const)[integer(v)] ?? invalidResponse();
const startMethod: Decoder<T.BsportClassPassProduct["startsOn"]> = v =>
  (["first-booking", "first-attendance", "purchase"] as const)[integer(v)] ?? invalidResponse();

function decode<Value>(schema: Schema<Value>, value: unknown): Value {
  const raw = object(value);
  // Only these named, decoded fields leave this boundary; never spread provider JSON.
  return Object.fromEntries(Object.entries(schema).map(([key, spec]) => {
    const [source, decoder] = spec as readonly [string, Decoder];
    return [key, decoder(raw[source])];
  })) as Value;
}

const booking = {
  id: ["id", id], companyId: ["company_id", id], customerId: ["client_id", id], classId: ["class_id", id],
  customerClassPassId: ["client_class_pass_id", nullable(id)], venueId: ["venue_id", nullable(id)],
  classStartsAt: ["class_start_at", datetime], createdAt: ["created_at", datetime], canceledAt: ["canceled_at", nullable(datetime)],
  status: ["booking_status_code", nullable(bookingStatus)], hasAttended: ["has_attended", bool], isNoShow: ["is_no_show", bool],
  creditsConsumed: ["credit_consumed", integer], isCreditRefunded: ["is_credit_refunded", bool],
} satisfies Schema<T.BsportBooking>;
const classes = {
  id: ["id", id], companyId: ["company_id", id], name: ["name", text], description: ["description", text],
  startsAt: ["starts_at", datetime], durationMinutes: ["duration_in_minutes", integer], isCanceled: ["is_canceled", bool],
  isBookableByCustomers: ["is_bookable_by_clients", bool], capacity: ["max_capacity", integer], currentBookings: ["current_bookings", integer],
  waitlistSize: ["current_waitlist_size", integer], maxWaitlistSize: ["max_waitlist_size", integer], creditPrice: ["credit_price", integer],
  serviceId: ["service_id", nullable(id)], venueId: ["venue_id", nullable(id)], teacherId: ["teacher_id", nullable(id)], substituteTeacherId: ["substitute_teacher_id", nullable(id)],
  bookableFrom: ["bookable_from", nullable(datetime)], bookableUntil: ["bookable_until", nullable(datetime)], cancelableUntil: ["cancelable_until", nullable(datetime)],
} satisfies Schema<T.BsportClass>;
const customers = {
  id: ["id", id], firstName: ["firstname", text], lastName: ["lastname", text], fullName: ["fullname", text],
  email: ["email", nullable(text)], phoneNumber: ["phone_number", nullable(text)], joinedDate: ["joined_date", date],
  isArchived: ["is_archived", bool], referenceNumber: ["client_reference_number", text],
  emailMarketingAccepted: ["is_email_accepted", bool], smsMarketingAccepted: ["is_sms_accepted", bool],
  accountBalance: ["client_account_balance", nullable(money)], totalUnpaidAmount: ["total_unpaid_amount", money],
} satisfies Schema<T.BsportCustomer>;
/** Ask for only the supported customer fields on lists, instead of downloading medical notes. */
export const CUSTOMER_FIELDS = Object.values(customers).map(([source]) => source).join(",");
const subscriptionCommon = {
  id: ["id", id], name: ["name", text], benefitKind: ["benefit_type", benefit], benefitId: ["benefit_id", id],
  recurrentPrice: ["recurrent_price", money], joiningFeePrice: ["join_fee_price", money],
  recurrenceBasis: ["recurrence_basis", integer], recurrenceUnit: ["interval_unit", unit], cycleInvoiceCount: ["interval_count", integer],
  autoRenewalEnabled: ["is_auto_renewal_activated", bool],
} as const;
const subscriptions = {
  ...subscriptionCommon, customerId: ["client_id", id], subscriptionProductId: ["subscription_id", nullable(id)],
  status: ["status", subscriptionStatus], createdAt: ["created_at", datetime],
  firstBillingDate: ["first_billing_date", nullable(date)], lastBillingDate: ["last_billing_date", nullable(date)],
  hasDiscount: ["has_discount", nullable(bool)], isWithinCommitmentPeriod: ["is_within_commitment_period", bool],
  recentOrUpcomingInvoiceIds: ["invoice_ids", v => Array.isArray(v) && v.length <= 2 ? v.map(invoiceId) : invalidResponse()],
} satisfies Schema<T.BsportSubscription>;
const subscriptionProducts = {
  ...subscriptionCommon, companyId: ["company_id", id], description: ["description", text],
  isDisabled: ["is_disabled", bool], isManagerOnly: ["is_manager_only", bool],
} satisfies Schema<T.BsportSubscriptionProduct>;
const classPassProducts = {
  id: ["id", id], companyId: ["company_id", id], name: ["name", text], description: ["description", nullable(text)],
  price: ["price", money], credits: ["credits", nullable(integer)], isUnlimited: ["is_unlimited", bool],
  isDisabled: ["is_disabled", bool], isManagerOnly: ["is_manager_only", bool], isNewCustomerOnly: ["is_new_client_only", bool],
  durationDays: ["duration_days", nullable(integer)], durationMonths: ["duration_months", nullable(integer)], durationYears: ["duration_years", nullable(integer)],
  startsOn: ["start_date_method", startMethod],
  validityPeriod: ["validity_period", nullable(v => decode({ startDate: ["start_date", nullable(date)], endDate: ["end_date", nullable(date)], isEmpty: ["is_empty", bool] }, v))],
} satisfies Schema<T.BsportClassPassProduct>;
const appointmentPassProducts = {
  id: ["id", id], name: ["name", text], description: ["description", nullable(text)], price: ["price", money], currency: ["currency", text],
  credits: ["credits", integer], isDisabled: ["is_disabled", bool], isManagerOnly: ["is_manager_only", bool],
  durationDays: ["duration_days", integer], durationMonths: ["duration_months", integer], durationYears: ["duration_years", integer],
} satisfies Schema<T.BsportAppointmentPassProduct>;
const customerClassPasses = {
  id: ["id", id], customerId: ["client_id", id], classPassProductId: ["class_pass_id", id], purchasedDate: ["purchased_date", date],
  startingDate: ["starting_date", nullable(date)], endingDate: ["ending_date", nullable(date)], usedCredits: ["used_credits_amount", integer],
  recordedAvailableCredits: ["available_credits_amount", integer], isDisabled: ["is_disabled", bool],
} satisfies Schema<T.BsportCustomerClassPass>;
const customerAppointmentPasses = {
  id: ["id", id], customerId: ["client_id", id], appointmentPassProductId: ["appointment_pass_id", id], purchasedAt: ["purchased_at", datetime],
  usedCredits: ["used_credits_amount", integer], recordedAvailableCredits: ["available_credits_amount", integer],
  validityExtensionDays: ["validity_extension_days", integer], isDisabled: ["is_disabled", bool], isRefunded: ["is_refunded", bool],
} satisfies Schema<T.BsportCustomerAppointmentPass>;
const line = {
  itemId: ["id", integer], itemType: ["item_type", text], description: ["description", text], quantity: ["quantity", integer],
  taxIncludedUnitAmount: ["tax_included_unit_amount", money], taxIncludedAmount: ["tax_included_amount", money], discountAmount: ["voucher_applied", money], totalAmount: ["line_total", money],
} satisfies Schema<T.BsportInvoiceLine>;
const invoices = {
  id: ["id", invoiceId], companyId: ["company_id", id], customerId: ["client_id", id], legalIdentifier: ["legal_identifier", nullable(text)],
  status: ["status", nullable(enumeration(["draft", "open", "paid", "voided", "refunded"] as const))], currency: ["currency", text],
  totalAmount: ["total_amount", money], paidAmount: ["paid_amount", money], pendingAmount: ["pending_amount", money], outstandingAmount: ["outstanding_amount", money],
  createdAt: ["created_at", datetime], issuedAt: ["issued_at", nullable(datetime)], canceledAt: ["canceled_at", nullable(datetime)], sourceInvoiceId: ["source_invoice_id", nullable(invoiceId)],
  lines: ["line_items", v => {
    const items = object(v);
    if (!Array.isArray(items.data) || items.data.length > 1000 || items.line_count !== items.data.length) return invalidResponse();
    return items.data.map(item => decode<T.BsportInvoiceLine>(line, item));
  }],
} satisfies Schema<T.BsportInvoice>;

const MAPPERS: Record<Collection, (raw: unknown) => Details> = {
  bookings: raw => decode<T.BsportBooking>(booking, raw), classes: raw => decode<T.BsportClass>(classes, raw),
  customers: raw => decode<T.BsportCustomer>(customers, raw), subscriptions: raw => decode<T.BsportSubscription>(subscriptions, raw),
  subscriptionProducts: raw => decode<T.BsportSubscriptionProduct>(subscriptionProducts, raw),
  classPassProducts: raw => decode<T.BsportClassPassProduct>(classPassProducts, raw),
  appointmentPassProducts: raw => decode<T.BsportAppointmentPassProduct>(appointmentPassProducts, raw),
  customerClassPasses: raw => decode<T.BsportCustomerClassPass>(customerClassPasses, raw),
  customerAppointmentPasses: raw => decode<T.BsportCustomerAppointmentPass>(customerAppointmentPasses, raw),
  invoices: raw => decode<T.BsportInvoice>(invoices, raw),
};

export function mapRecord(collection: Collection, raw: unknown, company: number, expectedId?: number | string): Details {
  const result = MAPPERS[collection](raw);
  if ("companyId" in result && result.companyId !== company) throw new Error("Record is outside the configured bsport company.");
  if (expectedId !== undefined && result.id !== expectedId) return invalidResponse();
  return result;
}
