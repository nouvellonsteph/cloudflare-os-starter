import type { RpcTarget } from "cloudflare:workers";

/** Read-only access to one configured bsport company. No method changes provider data. */
export interface BsportCompanySession extends RpcTarget {
  /** Class bookings, including canceled bookings unless filtered. */
  bookings(): Promise<BsportBookings>;
  /** Scheduled classes. With no start boundaries, bsport defaults to now through 30 days from now. */
  classes(): Promise<BsportClasses>;
  /** Selected customer profiles, excluding medical, identity-document and payment-provider fields. */
  customers(): Promise<BsportCustomers>;
  /** Subscriptions held by customers, not products offered for sale. */
  subscriptions(): Promise<BsportSubscriptions>;
  /** Subscription products offered by the company. */
  subscriptionProducts(): Promise<BsportSubscriptionProducts>;
  /** Class-pass products, not purchased customer entitlements. */
  classPassProducts(): Promise<BsportClassPassProducts>;
  /** Appointment-pass products, not purchased customer entitlements. */
  appointmentPassProducts(): Promise<BsportAppointmentPassProducts>;
  /** Purchased class passes and their recorded credits and validity. */
  customerClassPasses(): Promise<BsportCustomerClassPasses>;
  /** Purchased appointment passes. */
  customerAppointmentPasses(): Promise<BsportCustomerAppointmentPasses>;
  /** Invoice metadata, amounts and grouped lines; invoice IDs are strings. */
  invoices(): Promise<BsportInvoices>;
}

/** One collection only. IDs cannot select another company or collection. */
export interface BsportCollection<T, Filter, Id = number> extends RpcTarget {
  /** All supplied filters are combined. Pages are live reads, not a consistent snapshot. */
  list(options?: Filter): Promise<BsportCursor<BsportEntry<T>>>;
  /** Opens one record; its details read fails if inaccessible or outside this collection. */
  get(id: Id): Promise<BsportResource<T>>;
}
/** Exactly one record; no parent, sibling or cross-company navigation. */
export interface BsportResource<T> extends RpcTarget {
  /** Reads supported fields. Throws if this record is no longer accessible. */
  getDetails(): Promise<T>;
}
/** Supported details and a directly usable read capability. */
export interface BsportEntry<T> { details: T; resource: BsportResource<T>; }
/** Call next() until null; an empty array is not exhaustion. Dispose the cursor when finished. */
export interface BsportCursor<T> extends RpcTarget { next(): Promise<T[] | null>; }
/** Page size 1–100, default 50. Dates are YYYY-MM-DD; datetimes require a UTC offset. */
export interface BsportPageOptions { pageSize?: number; }
/** Status names correspond to provider filter codes 0–3. */
export type BsportBookingStatus = "active" | "canceled-by-manager" | "canceled-by-customer" | "class-canceled";
/** Datetimes retain UTC offsets. Monetary values elsewhere are signed decimal strings in major units. */
export interface BsportBooking {
  id: number; companyId: number; customerId: number; classId: number;
  customerClassPassId: number | null; venueId: number | null;
  classStartsAt: string; createdAt: string; canceledAt: string | null;
  status: BsportBookingStatus | null; hasAttended: boolean; isNoShow: boolean;
  creditsConsumed: number; isCreditRefunded: boolean;
}
/** Before/after datetime boundaries are inclusive. */
export interface BsportBookingFilter extends BsportPageOptions {
  ids?: number[]; customerId?: number; classId?: number; customerClassPassId?: number;
  classStartsAfter?: string; classStartsBefore?: string; createdAfter?: string; createdBefore?: string;
  status?: BsportBookingStatus; hasAttended?: boolean;
  venueIds?: number[]; teacherIds?: number[]; serviceIds?: number[];
}
/** Scheduled class, not a roster of customer profiles. */
export interface BsportClass {
  id: number; companyId: number; name: string; description: string;
  startsAt: string; durationMinutes: number; isCanceled: boolean;
  isBookableByCustomers: boolean; capacity: number; currentBookings: number;
  waitlistSize: number; maxWaitlistSize: number; creditPrice: number;
  serviceId: number | null; venueId: number | null; teacherId: number | null; substituteTeacherId: number | null;
  bookableFrom: string | null; bookableUntil: string | null; cancelableUntil: string | null;
}
/** Start boundaries are inclusive; omitted boundaries default to now / 30 days from now at bsport. */
export interface BsportClassFilter extends BsportPageOptions {
  startsAfter?: string; startsBefore?: string; serviceId?: number; venueId?: number;
  teacherId?: number; currentTeacherId?: number;
}
/** Structured subset, not a full export of the bsport profile. */
export interface BsportCustomer {
  id: number; firstName: string; lastName: string; fullName: string;
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
/** Subscription held by a customer. */
export interface BsportSubscription {
  id: number; customerId: number; subscriptionProductId: number | null; name: string;
  status: BsportSubscriptionStatus; benefitKind: BsportBenefitKind; benefitId: number;
  createdAt: string; firstBillingDate: string | null; lastBillingDate: string | null;
  recurrentPrice: string; joiningFeePrice: string; hasDiscount: boolean | null;
  recurrenceBasis: number; recurrenceUnit: BsportRecurrenceUnit; cycleInvoiceCount: number;
  autoRenewalEnabled: boolean; isWithinCommitmentPeriod: boolean;
  /** At most two relevant invoices, not complete invoice history. */
  recentOrUpcomingInvoiceIds: string[];
}
/** Supply benefitKind and benefitId together, or omit both. */
export interface BsportSubscriptionFilter extends BsportPageOptions {
  ids?: number[]; customerId?: number; benefitKind?: BsportBenefitKind; benefitId?: number;
}
/** Catalogue product, before customer-specific discounts. */
export interface BsportSubscriptionProduct {
  id: number; companyId: number; name: string; description: string;
  benefitKind: BsportBenefitKind; benefitId: number; recurrentPrice: string; joiningFeePrice: string;
  recurrenceBasis: number; recurrenceUnit: BsportRecurrenceUnit; cycleInvoiceCount: number;
  autoRenewalEnabled: boolean; isDisabled: boolean; isManagerOnly: boolean;
}
/** Supply benefitKind and benefitId together, or omit both. */
export interface BsportSubscriptionProductFilter extends BsportPageOptions {
  ids?: number[]; benefitKind?: BsportBenefitKind; benefitId?: number; isDisabled?: boolean; isManagerOnly?: boolean;
}
/** Product rules, not a customer's remaining credits. */
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
/** Appointment-pass product; credits are finite. */
export interface BsportAppointmentPassProduct {
  id: number; name: string; description: string | null; price: string; currency: string;
  credits: number; isDisabled: boolean; isManagerOnly: boolean;
  durationDays: number; durationMonths: number; durationYears: number;
}
/** Name is a case-insensitive substring match. */
export interface BsportAppointmentPassProductFilter extends BsportPageOptions { name?: string; isDisabled?: boolean; }
/** Purchased class pass; recorded credits do not establish booking eligibility. */
export interface BsportCustomerClassPass {
  id: number; customerId: number; classPassProductId: number; purchasedDate: string;
  startingDate: string | null; endingDate: string | null; usedCredits: number;
  /** Zero for unlimited passes: inspect the related product before interpreting this. */
  recordedAvailableCredits: number;
  isDisabled: boolean;
}
/** hasCreditsAvailable includes unlimited passes but ignores expiry and deactivation. */
export interface BsportCustomerClassPassFilter extends BsportPageOptions {
  ids?: number[]; customerIds?: number[]; classPassProductId?: number;
  purchasedAfterDate?: string; purchasedBeforeDate?: string; isDisabled?: boolean; hasCreditsAvailable?: boolean;
}
/** Purchased appointment pass. */
export interface BsportCustomerAppointmentPass {
  id: number; customerId: number; appointmentPassProductId: number; purchasedAt: string;
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
  id: string; companyId: number; customerId: number; legalIdentifier: string | null;
  status: BsportInvoiceStatus; currency: string; totalAmount: string; paidAmount: string; pendingAmount: string; outstandingAmount: string;
  createdAt: string; issuedAt: string | null; canceledAt: string | null; sourceInvoiceId: string | null; lines: BsportInvoiceLine[];
}
/** Monetary values remain signed decimal strings, including on reverse invoices. */
export interface BsportInvoiceLine {
  itemId: number; itemType: string; description: string; quantity: number;
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
