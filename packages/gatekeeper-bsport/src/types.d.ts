import type { RpcTarget } from "cloudflare:workers";

/**
 * Read-only access to one configured bsport company. No method changes provider data.
 *
 * ID relationships and expansion:
 * - bsport calls customer profiles "clients"; this API calls them customers. Provider client_id
 *   becomes customerId, firstname becomes firstName, and lastname becomes lastName.
 *   customerId is unrelated to the integration's configured BSPORT_CLIENT_ID / X-Client-ID.
 * - Related objects are NOT embedded. Use the collection named by each field's documentation,
 *   then get(id).getDetails() to read its supported object, e.g. customers for customerId.
 *   get(id) alone returns a resource, not its details. IDs are scoped to their collection and
 *   company: a purchased-pass ID is not a product ID, even if their numeric values coincide.
 *   Lookup paths below are conceptual: await the collection, then get(id), then getDetails()
 *   separately, as in the example; do not call methods on unresolved promises.
 * - A booking's customerId -> customers(); classId -> classes(); non-null customerClassPassId
 *   -> customerClassPasses() -> classPassProductId -> classPassProducts(). Customer names live
 *   on BsportCustomer.firstName/lastName/fullName, class names on BsportClass.name, and pass
 *   product names on BsportClassPassProduct.name or BsportAppointmentPassProduct.name.
 * - A customer's subscription -> subscriptionProductId -> subscriptionProducts() when non-null.
 *   On either subscription type, benefitKind selects benefitId's PRODUCT collection:
 *   "class-pass" -> classPassProducts(); "appointment-pass" -> appointmentPassProducts();
 *   "pack" has no resolver here. A benefitId is not a purchased customer pass ID.
 * - Invoice customerId -> customers(); recentOrUpcomingInvoiceIds and non-null sourceInvoiceId
 *   -> invoices(). Invoice IDs stay UUID strings. Invoice line itemId has no universal resolver.
 * - No teacher, venue, service, pack or company-profile collection is exposed. Keep their IDs
 *   as references; do not substitute customers/classes or invent endpoints or names.
 * - These joins require already-granted access to the target collections in the same company.
 *   A collection-only or record-only binding cannot open siblings or navigate to its company.
 *   Request the missing collection/resource through the normal connection flow if needed.
 *
 * Efficient reads:
 * - Filter the source collection first, e.g. bookings().list({ classId, pageSize: 100 }) for a
 *   class roster, or bookings().list({ customerId, classStartsAfter, classStartsBefore }).
 *   For historical classes supply startsAfter/startsBefore; an unfiltered class list defaults
 *   to now through 30 days ahead. Direct classes().get(classId) does not have this list window.
 * - Cursor entries already contain details. Do not call entry.resource.getDetails() for every
 *   row unless a fresh read is necessary. Call next() until null, not until an empty array.
 * - Deduplicate related IDs and reuse details already read during the current operation, keyed
 *   by company + collection + ID. For collections with an ids filter, use nonempty batches of
 *   at most 100 IDs with pageSize: 100 and drain every cursor. Skip empty batches.
 * - ids is supported by customers, bookings, subscriptions, subscriptionProducts,
 *   classPassProducts, customerClassPasses, customerAppointmentPasses and invoices.
 *   classes and appointmentPassProducts do NOT support ids: get each distinct needed ID with
 *   bounded concurrency (e.g. four reads), or reuse a suitably filtered listing already read.
 * - Customer filters on bookings/subscriptions/customerAppointmentPasses/invoices are singular
 *   customerId; customerClassPasses instead accepts customerIds (1–100 IDs). Filters combine
 *   with AND. Supply subscription benefitKind/benefitId filters together, or omit both.
 *   No generic expand/include, joins, arbitrary filters or name search for customers.
 * - Treat null foreign keys as absent. A missing/inaccessible related record stays unresolved;
 *   never guess a name, silently drop its source row, or treat an outage as an empty result.
 * - Dispose collection, cursor and record capabilities when finished, including resource
 *   capabilities in list entries even when only details were used. Do not retain profile data
 *   across users or assume prior reads prove current access; reads are live, not a snapshot.
 *
 * @example Resolve one booking using an already-granted company session and booking details.
 * ```ts
 * using customers = await company.customers();
 * using classes = await company.classes();
 * using customer = await customers.get(booking.customerId);
 * using scheduledClass = await classes.get(booking.classId);
 * const [profile, classDetails] = await Promise.all([customer.getDetails(), scheduledClass.getDetails()]);
 * // profile.firstName / profile.lastName / profile.fullName identify the customer.
 * // classDetails.name identifies the scheduled class; booking.id remains the booking ID.
 * ```
 */
export interface BsportCompanySession extends RpcTarget {
  /** Class bookings, including canceled bookings unless filtered. Resolve customerId/classId via customers()/classes(). */
  bookings(): Promise<BsportBookings>;
  /** Scheduled classes. With no start boundaries, bsport defaults to now through 30 days from now. */
  classes(): Promise<BsportClasses>;
  /** bsport clients: resolve customerId here for firstName/lastName/fullName and selected contact fields. */
  customers(): Promise<BsportCustomers>;
  /** Subscriptions held by customers, not catalogue products; subscriptionProductId points to subscriptionProducts(). */
  subscriptions(): Promise<BsportSubscriptions>;
  /** Subscription catalogue, not customer subscriptions. benefitKind selects the product collection for benefitId. */
  subscriptionProducts(): Promise<BsportSubscriptionProducts>;
  /** Class-pass catalogue: names and product rules for classPassProductId or a class-pass benefitId, not purchased-pass IDs. */
  classPassProducts(): Promise<BsportClassPassProducts>;
  /** Appointment-pass catalogue: names and product rules for appointmentPassProductId or an appointment-pass benefitId. */
  appointmentPassProducts(): Promise<BsportAppointmentPassProducts>;
  /** Purchased class passes: booking.customerClassPassId resolves here; classPassProductId then resolves the product. */
  customerClassPasses(): Promise<BsportCustomerClassPasses>;
  /** Purchased appointment passes: customerId resolves the holder; appointmentPassProductId resolves the product. */
  customerAppointmentPasses(): Promise<BsportCustomerAppointmentPasses>;
  /** Invoice metadata, amounts and grouped lines; invoice IDs are strings. */
  invoices(): Promise<BsportInvoices>;
}

/** One collection only. IDs cannot select another company or collection. */
export interface BsportCollection<T, Filter, Id = number> extends RpcTarget {
  /** All supplied filters are combined (AND). Only Filter's declared keys are accepted; list entries include details already. */
  list(options?: Filter): Promise<BsportCursor<BsportEntry<T>>>;
  /** Opens one record in this collection, not a related collection. Call getDetails() on the result to read its fields. */
  get(id: Id): Promise<BsportResource<T>>;
}
/** Exactly one record; no parent, sibling or cross-company navigation. Foreign-key IDs do not grant target access. */
export interface BsportResource<T> extends RpcTarget {
  /** Reads supported fields. Throws if this record is no longer accessible. */
  getDetails(): Promise<T>;
}
/** Supported details already read, plus a resource capability for a fresh read. Dispose resource even if using only details. */
export interface BsportEntry<T> { details: T; resource: BsportResource<T>; }
/** Call next() until null; an empty array is not exhaustion. Dispose the cursor when finished. */
export interface BsportCursor<T> extends RpcTarget { next(): Promise<T[] | null>; }
/** Page size 1–100, default 50. ID-array filters contain 1–100 IDs. Dates are YYYY-MM-DD; datetimes require a UTC offset. */
export interface BsportPageOptions { pageSize?: number; }
/** Status names correspond to provider filter codes 0–3. */
export type BsportBookingStatus = "active" | "canceled-by-manager" | "canceled-by-customer" | "class-canceled";
/** Datetimes retain UTC offsets. Monetary values elsewhere are signed decimal strings in major units. */
export interface BsportBooking {
  id: number; companyId: number;
  /** Provider client_id -> customers().get(customerId).getDetails(); names are firstName/lastName/fullName there. */
  customerId: number;
  /** classes().get(classId).getDetails() -> name, startsAt, durationMinutes and capacity. Not a serviceId. */
  classId: number;
  /** customerClassPasses().get(customerClassPassId).getDetails() -> classPassProductId, credits and validity. Null means no linked pass. */
  customerClassPassId: number | null;
  /** Reference only: no venue lookup collection is exposed. */
  venueId: number | null;
  classStartsAt: string; createdAt: string; canceledAt: string | null;
  status: BsportBookingStatus | null; hasAttended: boolean; isNoShow: boolean;
  creditsConsumed: number; isCreditRefunded: boolean;
}
/** Before/after datetime boundaries are inclusive. customerId is a customer profile ID; classId is a scheduled class ID. */
export interface BsportBookingFilter extends BsportPageOptions {
  ids?: number[]; customerId?: number; classId?: number; customerClassPassId?: number;
  classStartsAfter?: string; classStartsBefore?: string; createdAfter?: string; createdBefore?: string;
  status?: BsportBookingStatus; hasAttended?: boolean;
  venueIds?: number[]; teacherIds?: number[]; serviceIds?: number[];
}
/** Scheduled class. Use bookings().list({ classId: id }) for its bookings, then customers() for attendee names. */
export interface BsportClass {
  id: number; companyId: number; name: string; description: string;
  startsAt: string; durationMinutes: number; isCanceled: boolean;
  isBookableByCustomers: boolean; capacity: number; currentBookings: number;
  waitlistSize: number; maxWaitlistSize: number; creditPrice: number;
  /** References only: no service, venue or teacher lookup collection is exposed. Teacher IDs are not customer IDs. */
  serviceId: number | null; venueId: number | null; teacherId: number | null; substituteTeacherId: number | null;
  bookableFrom: string | null; bookableUntil: string | null; cancelableUntil: string | null;
}
/** Start boundaries are inclusive; omitted boundaries default to now / 30 days from now at bsport. No ids filter; get(id) for exact IDs. */
export interface BsportClassFilter extends BsportPageOptions {
  startsAfter?: string; startsBefore?: string; serviceId?: number; venueId?: number;
  teacherId?: number; currentTeacherId?: number;
}
/**
 * bsport client profile (provider /clients/), not a booking or pass. Its id matches customerId
 * on bookings, subscriptions, purchased class/appointment passes and invoices.
 * Use those collections' customerId filters (customerIds for customerClassPasses) for reverse lookups.
 * Structured subset only; no medical, identity-document or payment-provider fields.
 */
export interface BsportCustomer {
  id: number;
  /** Provider firstname / lastname / fullname; resolve a customerId here instead of displaying the numeric ID as a name. */
  firstName: string; lastName: string; fullName: string;
  email: string | null; phoneNumber: string | null; joinedDate: string;
  isArchived: boolean; referenceNumber: string; emailMarketingAccepted: boolean; smsMarketingAccepted: boolean;
  accountBalance: string | null; totalUnpaidAmount: string;
}
/** Email matches the entire address ignoring case and surrounding spaces; no name search. */
export interface BsportCustomerFilter extends BsportPageOptions {
  ids?: number[]; email?: string; isArchived?: boolean; joinedAfterDate?: string; joinedBeforeDate?: string;
}
/** Subscription lifecycle, not proof its invoices are paid. */
export type BsportSubscriptionStatus = "not-started" | "started" | "stopped" | "paused" | "ended";
/** Pack products have no corresponding read endpoint in bsport V2. */
export type BsportBenefitKind = "class-pass" | "appointment-pass" | "pack";
/** Invoice spacing is recurrenceBasis times this unit, not cycleInvoiceCount. */
export type BsportRecurrenceUnit = "day" | "week" | "month" | "year";
/** Subscription held by a customer (/client-subscriptions/). Its id is not a subscription catalogue product ID. */
export interface BsportSubscription {
  id: number;
  /** customers().get(customerId).getDetails() -> firstName/lastName/fullName. */
  customerId: number;
  /** Provider subscription_id -> subscriptionProducts().get(subscriptionProductId).getDetails(); skip if null. */
  subscriptionProductId: number | null;
  name: string; status: BsportSubscriptionStatus;
  /** Discriminator for benefitId: class-pass -> classPassProducts(); appointment-pass -> appointmentPassProducts(); pack -> no resolver. */
  benefitKind: BsportBenefitKind;
  /** PRODUCT ID in benefitKind's collection. Read that collection's get(benefitId).getDetails(); not a purchased customer pass ID. */
  benefitId: number;
  createdAt: string; firstBillingDate: string | null; lastBillingDate: string | null;
  recurrentPrice: string; joiningFeePrice: string; hasDiscount: boolean | null;
  recurrenceBasis: number; recurrenceUnit: BsportRecurrenceUnit; cycleInvoiceCount: number;
  autoRenewalEnabled: boolean; isWithinCommitmentPeriod: boolean;
  /** At most two UUIDs -> invoices().get(id).getDetails(); not complete invoice history. Use invoices().list({ customerId }) for that instead. */
  recentOrUpcomingInvoiceIds: string[];
}
/** Supply benefitKind and benefitId together, or omit both. */
export interface BsportSubscriptionFilter extends BsportPageOptions {
  ids?: number[]; customerId?: number; benefitKind?: BsportBenefitKind; benefitId?: number;
}
/** Catalogue product (/subscriptions/), before customer-specific discounts. Distinct from a customer's BsportSubscription. */
export interface BsportSubscriptionProduct {
  id: number; companyId: number; name: string; description: string;
  /** Discriminator for benefitId: class-pass -> classPassProducts(); appointment-pass -> appointmentPassProducts(); pack -> no resolver. */
  benefitKind: BsportBenefitKind;
  /** PRODUCT ID in benefitKind's collection; resolve with its get(benefitId).getDetails(), not customerClassPasses/customerAppointmentPasses. */
  benefitId: number;
  recurrentPrice: string; joiningFeePrice: string;
  recurrenceBasis: number; recurrenceUnit: BsportRecurrenceUnit; cycleInvoiceCount: number;
  autoRenewalEnabled: boolean; isDisabled: boolean; isManagerOnly: boolean;
}
/** Supply benefitKind and benefitId together, or omit both. */
export interface BsportSubscriptionProductFilter extends BsportPageOptions {
  ids?: number[]; benefitKind?: BsportBenefitKind; benefitId?: number; isDisabled?: boolean; isManagerOnly?: boolean;
}
/** Class-pass product name/rules, not a customer's remaining credits. id matches purchased classPassProductId or a class-pass benefitId. */
export interface BsportClassPassProduct {
  id: number; companyId: number; name: string; description: string | null;
  price: string; credits: number | null; isUnlimited: boolean;
  isDisabled: boolean; isManagerOnly: boolean; isNewCustomerOnly: boolean;
  durationDays: number | null; durationMonths: number | null; durationYears: number | null;
  startsOn: "first-booking" | "first-attendance" | "purchase";
  validityPeriod: { startDate: string | null; endDate: string | null; isEmpty: boolean } | null;
}
/** Product visibility and name filters; name and nameContains ignore case. */
export interface BsportClassPassProductFilter extends BsportPageOptions {
  ids?: number[]; name?: string; nameContains?: string; isDisabled?: boolean; isManagerOnly?: boolean; isNewCustomerOnly?: boolean;
}
/** Appointment-pass product name/rules; credits are finite. id matches purchased appointmentPassProductId or an appointment-pass benefitId. */
export interface BsportAppointmentPassProduct {
  id: number; name: string; description: string | null; price: string; currency: string;
  credits: number; isDisabled: boolean; isManagerOnly: boolean;
  durationDays: number; durationMonths: number; durationYears: number;
}
/** Name is a case-insensitive substring match. No ids filter; use get(id) for a known product ID. */
export interface BsportAppointmentPassProductFilter extends BsportPageOptions { name?: string; isDisabled?: boolean; }
/** Purchased class pass; recorded credits do not establish booking eligibility. */
export interface BsportCustomerClassPass {
  /** Purchased-pass ID; this is booking.customerClassPassId, NOT the catalogue classPassProductId. */
  id: number;
  /** customers().get(customerId).getDetails() -> the holder's firstName/lastName/fullName. */
  customerId: number;
  /** Provider class_pass_id -> classPassProducts().get(classPassProductId).getDetails() -> name, price and product rules. */
  classPassProductId: number;
  purchasedDate: string;
  startingDate: string | null; endingDate: string | null; usedCredits: number;
  /** Zero for unlimited passes: inspect the related product before interpreting this. */
  recordedAvailableCredits: number;
  isDisabled: boolean;
}
/** customerIds filters holders; ids filters purchased passes. hasCreditsAvailable includes unlimited passes but ignores expiry/deactivation. */
export interface BsportCustomerClassPassFilter extends BsportPageOptions {
  ids?: number[]; customerIds?: number[]; classPassProductId?: number;
  purchasedAfterDate?: string; purchasedBeforeDate?: string; isDisabled?: boolean; hasCreditsAvailable?: boolean;
}
/** Purchased appointment pass. */
export interface BsportCustomerAppointmentPass {
  /** Purchased appointment-pass ID, NOT its catalogue appointmentPassProductId. */
  id: number;
  /** customers().get(customerId).getDetails() -> the holder's firstName/lastName/fullName. */
  customerId: number;
  /** Provider appointment_pass_id -> appointmentPassProducts().get(appointmentPassProductId).getDetails() -> name, price and product rules. */
  appointmentPassProductId: number;
  purchasedAt: string;
  usedCredits: number; recordedAvailableCredits: number; validityExtensionDays: number; isDisabled: boolean; isRefunded: boolean;
}
/** purchasedAfter/purchasedBefore are inclusive offset-bearing datetimes, not dates. */
export interface BsportCustomerAppointmentPassFilter extends BsportPageOptions {
  ids?: number[]; customerId?: number; appointmentPassProductId?: number;
  purchasedAfter?: string; purchasedBefore?: string; isDisabled?: boolean; isRefunded?: boolean;
}
/** null is a legacy invoice without lifecycle status. */
export type BsportInvoiceStatus = "draft" | "open" | "paid" | "voided" | "refunded" | null;
/** Invoice metadata and grouped lines. No PDF downloads. Amounts are signed decimal strings in major units. */
export interface BsportInvoice {
  id: string; companyId: number;
  /** customers().get(customerId).getDetails() -> firstName/lastName/fullName. */
  customerId: number;
  legalIdentifier: string | null;
  status: BsportInvoiceStatus; currency: string; totalAmount: string; paidAmount: string; pendingAmount: string; outstandingAmount: string;
  createdAt: string; issuedAt: string | null; canceledAt: string | null;
  /** Related source invoice UUID -> invoices().get(sourceInvoiceId).getDetails(); skip if null. */
  sourceInvoiceId: string | null;
  lines: BsportInvoiceLine[];
}
/** Monetary values remain signed decimal strings, including on reverse invoices. */
export interface BsportInvoiceLine {
  /** Provider line item reference, interpreted with itemType. No universal itemId-to-collection resolver; do not guess a join. */
  itemId: number;
  itemType: string; description: string; quantity: number;
  taxIncludedUnitAmount: string; taxIncludedAmount: string; discountAmount: string; totalAmount: string;
}
/** Invoice IDs are UUID strings. Created/issued boundaries are inclusive datetimes with UTC offsets. */
export interface BsportInvoiceFilter extends BsportPageOptions {
  ids?: string[]; customerId?: number; status?: Exclude<BsportInvoiceStatus, null>;
  createdAfter?: string; createdBefore?: string; issuedAfter?: string; issuedBefore?: string;
}

/** Bookings collection. */
export type BsportBookings = BsportCollection<BsportBooking, BsportBookingFilter>;
/** Classes collection. */
export type BsportClasses = BsportCollection<BsportClass, BsportClassFilter>;
/** Customers collection. */
export type BsportCustomers = BsportCollection<BsportCustomer, BsportCustomerFilter>;
/** Customer subscriptions collection. */
export type BsportSubscriptions = BsportCollection<BsportSubscription, BsportSubscriptionFilter>;
/** Subscription catalogue collection. */
export type BsportSubscriptionProducts = BsportCollection<BsportSubscriptionProduct, BsportSubscriptionProductFilter>;
/** Class-pass catalogue collection. */
export type BsportClassPassProducts = BsportCollection<BsportClassPassProduct, BsportClassPassProductFilter>;
/** Appointment-pass catalogue collection. */
export type BsportAppointmentPassProducts = BsportCollection<BsportAppointmentPassProduct, BsportAppointmentPassProductFilter>;
/** Purchased class-pass collection. */
export type BsportCustomerClassPasses = BsportCollection<BsportCustomerClassPass, BsportCustomerClassPassFilter>;
/** Purchased appointment-pass collection. */
export type BsportCustomerAppointmentPasses = BsportCollection<BsportCustomerAppointmentPass, BsportCustomerAppointmentPassFilter>;
/** Invoices collection. */
export type BsportInvoices = BsportCollection<BsportInvoice, BsportInvoiceFilter, string>;
/** One booking. */
export type BsportBookingResource = BsportResource<BsportBooking>;
/** One class. */
export type BsportClassResource = BsportResource<BsportClass>;
/** One customer. */
export type BsportCustomerResource = BsportResource<BsportCustomer>;
/** One customer subscription. */
export type BsportSubscriptionResource = BsportResource<BsportSubscription>;
/** One subscription product. */
export type BsportSubscriptionProductResource = BsportResource<BsportSubscriptionProduct>;
/** One class-pass product. */
export type BsportClassPassProductResource = BsportResource<BsportClassPassProduct>;
/** One appointment-pass product. */
export type BsportAppointmentPassProductResource = BsportResource<BsportAppointmentPassProduct>;
/** One purchased class pass. */
export type BsportCustomerClassPassResource = BsportResource<BsportCustomerClassPass>;
/** One purchased appointment pass. */
export type BsportCustomerAppointmentPassResource = BsportResource<BsportCustomerAppointmentPass>;
/** One invoice. */
export type BsportInvoiceResource = BsportResource<BsportInvoice>;
