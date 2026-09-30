/**
 * A subscription offer: what the operator prepares, and every Order field of
 * the approved template composed from it.
 *
 * Three sources feed one document, and they are kept apart on purpose:
 *
 *  - **The offer** — the customer, the selected tier, AML option, term and
 *    payment arrangement, extra seats, additional lines, one-off charges and
 *    the usage and spend authorities. Typed by an operator for one lead.
 *  - **The issuing profile** — facts only Aurixa can state and that do not
 *    change per customer: the Schedule E5 service profile and disclosures,
 *    the monitored contact routes, the correction route, the applicable
 *    documents. Maintained by an administrator and COPIED into each offer when
 *    it is prepared, so an offer records what it said even after the profile
 *    moves on.
 *  - **The platform** — prices (the approved template's own Schedule A3 and
 *    the commercial catalogue's tier prices) and the live report rate card.
 *    Never typed, so the Order cannot quote a price the platform does not
 *    charge.
 *
 * `composeSubscriptionOffer` is pure. It always returns every field (so the
 * editor can show the document taking shape) together with a list of GAPS —
 * each a thing that stops the offer being issued. A document is produced only
 * from a composition with no gaps (`toDocumentFill` refuses otherwise), which
 * is clause 1.2 of the agreement itself: "An uncompleted template is not an
 * offer."
 */
import { z } from "zod";
import type { DocumentFill, FieldSegment, FieldValue } from "./docxFill.pure";
import {
  COMMITMENT_MONTHS,
  formatAud,
  formatCount,
  formatLongDate,
  gstContainedCents,
  isCommitted,
  ordinal,
  parseIsoDate,
  priceBase,
  readIdentifier,
  serviceDates,
  type BasePricing,
  type ServiceDates,
  type SubscriptionTerm,
} from "./subscriptionPricing.pure";
import {
  A3_INCLUDED,
  a3Item,
  catalogTier,
  EXTRA_SEAT_KEY,
  isIncludedInTier,
  SUBSCRIPTION_ANCHORS,
  SUBSCRIPTION_TEMPLATES,
  type SubscriptionTierSlug,
} from "./subscriptionTemplates";

/* ───────────────────────────── vocabulary ───────────────────────────── */

/** Every plain-text control the three templates declare, in document order. */
export const SUBSCRIPTION_FIELD_TAGS = [
  "customer.legal_name",
  "customer.identifier",
  "order.aml_option",
  "customer.address",
  "order.term_label",
  "customer.notice_email",
  "customer.billing_contact",
  "price.headline_amount",
  "price.headline_basis",
  "price.base_summary",
  "price.recurring_extras",
  "price.support_fee",
  "price.total_label",
  "price.total_monthly_incl_gst",
  "price.activation_charges",
  "price.minimum_label",
  "price.minimum_fixed_commitment",
  "price.post_term_summary",
  "order.start_and_renewal",
  "payment.arrangement",
  "seats.summary",
  "scope.selected_addons",
  "scope.aml_summary",
  "credits.cycle_display",
  "offer.correction_route",
  "signatory.name",
  "signatory.role",
  "signatory.email",
  "order.special_conditions_summary",
  "order.applicable_documents",
  "signatory.esign_reference",
  "usage.report_slugs_and_credit_costs",
  "usage.variable_allowance",
  "usage.variable_basis_payer_cap",
  "usage.aml_allowance_or_disabled",
  "usage.aml_basis_payer_cap",
  "usage.communications_allowance_or_disabled",
  "usage.communications_basis_payer_cap",
  "usage.api_storage_allowance",
  "usage.api_storage_basis_payer_cap",
  "usage.buffer_amount_or_zero",
  "service.profile",
  "service.supabase",
  "service.edge",
  "service.processing",
  "service.lifecycle",
  "contacts.legal",
  "contacts.support",
  "contacts.privacy",
  "service.continuations",
] as const;

export type SubscriptionFieldTag = (typeof SUBSCRIPTION_FIELD_TAGS)[number];

/** Each field as the template labels it, for gaps and the review table. */
export const FIELD_LABELS: Readonly<Record<SubscriptionFieldTag, string>> = {
  "customer.legal_name": "Customer",
  "customer.identifier": "Legal identifier",
  "order.aml_option": "AML option",
  "customer.address": "Business address",
  "order.term_label": "Term and payment",
  "customer.notice_email": "Legal notices",
  "customer.billing_contact": "Billing contact",
  "price.headline_amount": "Selected payment amount",
  "price.headline_basis": "Payment basis and first payment",
  "price.base_summary": "Selected base and discount",
  "price.recurring_extras": "Purchased users and modules",
  "price.support_fee": "Support",
  "price.total_label": "Monthly total label",
  "price.total_monthly_incl_gst": "Monthly total / equivalent if prepaid",
  "price.activation_charges": "Due at activation",
  "price.minimum_label": "Minimum fixed charges label",
  "price.minimum_fixed_commitment": "Minimum fixed charges",
  "price.post_term_summary": "After the commitment",
  "order.start_and_renewal": "Your service dates",
  "payment.arrangement": "Actual payment schedule",
  "seats.summary": "Named internal users",
  "scope.selected_addons": "Optional scope",
  "scope.aml_summary": "AML/CTF support",
  "credits.cycle_display": "Token cycle",
  "offer.correction_route": "Correction route",
  "signatory.name": "Representative",
  "signatory.role": "Role",
  "signatory.email": "Verified signing email",
  "order.special_conditions_summary": "Negotiated departures",
  "order.applicable_documents": "Additional applicable documents",
  "signatory.esign_reference": "Electronic acceptance",
  "usage.report_slugs_and_credit_costs": "Fixed report / comparison jobs (A4)",
  "usage.variable_allowance": "Variable agents / AI / data — included (A4)",
  "usage.variable_basis_payer_cap": "Variable agents / AI / data — extra basis, payer and cap (A4)",
  "usage.aml_allowance_or_disabled": "AML verification / screening / monitoring — included (A4)",
  "usage.aml_basis_payer_cap":
    "AML verification / screening / monitoring — extra basis, payer and cap (A4)",
  "usage.communications_allowance_or_disabled": "Email / SMS / voice / recording — included (A4)",
  "usage.communications_basis_payer_cap":
    "Email / SMS / voice / recording — extra basis, payer and cap (A4)",
  "usage.api_storage_allowance": "API calls / storage / exceptional provider use — included (A4)",
  "usage.api_storage_basis_payer_cap":
    "API calls / storage / exceptional provider use — extra basis, payer and cap (A4)",
  "usage.buffer_amount_or_zero": "In-flight reservations / buffers (A4)",
  "service.profile": "Profile and effective date (E5)",
  "service.supabase": "Supabase location / account model (E5)",
  "service.edge": "Cloudflare / cloud hosting profile (E5)",
  "service.processing": "Additional processing and risk scope (E5)",
  "service.lifecycle": "Retention, recovery and export (E5)",
  "contacts.legal": "Legal notices contact (E5)",
  "contacts.support": "Support / security / escalation contact (E5)",
  "contacts.privacy": "Privacy enquiries contact (E5)",
  "service.continuations": "Supplied continuations (E5)",
};

/** The repeating Schedule A4 section: one record per additional line. */
export const ADDITIONAL_LINES_TAG = "purchases.additional_lines";

export const ADDITIONAL_LINE_TAGS = [
  "addon.id_buyer_scope",
  "addon.quantity_price_discount_total",
  "addon.dates_and_term",
  "addon.immediate_and_commitment",
  "addon.usage_and_costs",
  "addon.permissions_and_terms",
] as const;

export type AdditionalLineTag = (typeof ADDITIONAL_LINE_TAGS)[number];

/** Clause A4's own words for an Order with no additions. */
export const NO_ADDITIONAL_PURCHASES = "No additional purchases.";

/* ───────────────────────────── schemas ───────────────────────────── */

const text = (max: number) => z.string().max(max).default("");

export const addonLineSchema = z.object({
  /** Client-generated key, stable while the operator edits. */
  id: z.string().min(1).max(64),
  itemKey: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(999).default(1),
  /** An accepted monthly discount on this line, never more than its gross amount. */
  discountMonthlyCents: z.number().int().min(0).max(100_000_000).default(0),
  /** "committed" fixes the line to the base commitment's end (clause 5.4). */
  term: z.enum(["flexible", "committed"]).default("flexible"),
  purchaser: text(300),
  scope: text(1500),
  usageAndCosts: text(1500),
  permissions: text(1500),
});

export type AddonLine = z.infer<typeof addonLineSchema>;

export const serviceDisclosureSchema = z.object({
  /** E5 "Profile and effective date". */
  serviceProfile: text(600),
  /** E5 "Supabase location / account model". */
  supabase: text(1200),
  /** E5 "Cloudflare / cloud hosting profile". */
  edge: text(1200),
  /** E5 "Additional processing and risk scope". */
  processing: text(1200),
  /** E5 "Retention, recovery and export". */
  lifecycle: text(1500),
  legalContact: text(600),
  supportContact: text(800),
  privacyContact: text(600),
  /** E5 "Supplied continuations". */
  continuations: text(1500),
  /** Section 03's "Correction route". */
  correctionRoute: text(600),
  /** Section 03's "Additional applicable documents" — the standing list. */
  applicableDocuments: text(1500),
});

export type ServiceDisclosure = z.infer<typeof serviceDisclosureSchema>;

export const usageAuthoritySchema = z.object({
  variableAllowance: text(800),
  variableBasis: text(800),
  amlAllowance: text(800),
  amlBasis: text(800),
  commsAllowance: text(800),
  commsBasis: text(800),
  apiAllowance: text(800),
  apiBasis: text(800),
  buffer: text(400),
});

export type UsageAuthority = z.infer<typeof usageAuthoritySchema>;

export const subscriptionOfferSchema = z.object({
  schema: z.literal(1).default(1),
  tier: z.enum(["launch", "growth", "scale"]),
  aml: z.enum(["with", "without"]).default("with"),
  term: z.enum(["flexible", "committed_monthly", "committed_annual"]).default("flexible"),
  /** YYYY-MM-DD — the planned paid activation. */
  activationDate: text(10),
  paymentMethod: text(300),
  customer: z
    .object({
      legalName: text(300),
      identifier: text(80),
      address: text(500),
      noticeEmail: text(254),
      billingContact: text(300),
    })
    .default({}),
  signatory: z
    .object({
      name: text(200),
      role: text(200),
      email: text(254),
    })
    .default({}),
  extraSeats: z.number().int().min(0).max(500).default(0),
  addons: z.array(addonLineSchema).max(40).default([]),
  supportFee: z
    .object({
      monthlyCents: z.number().int().min(0).max(100_000_000).default(0),
      description: text(500),
    })
    .default({}),
  oneOffCharges: z
    .array(
      z.object({
        description: z.string().max(300),
        amountCents: z.number().int().min(0).max(100_000_000),
      }),
    )
    .max(20)
    .default([]),
  usage: usageAuthoritySchema.default({}),
  service: serviceDisclosureSchema.default({}),
  /** "Negotiated departures" — express legal departures, or blank for None. */
  specialConditions: text(4000),
  /** Documents supplied with THIS offer, beyond the profile's standing list. */
  additionalDocuments: text(1500),
});

export type SubscriptionOffer = z.infer<typeof subscriptionOfferSchema>;

/** Aurixa's standing facts, maintained once and copied into each new offer. */
export const issuingProfileSchema = z.object({
  service: serviceDisclosureSchema.default({}),
  usage: usageAuthoritySchema.default({}),
  defaultPaymentMethod: text(300),
});

export type IssuingProfile = z.infer<typeof issuingProfileSchema>;

/**
 * The spend-authority defaults an offer starts with where the profile states
 * nothing. Each is the agreement's own zero case — A4: "No recorded authority
 * means no additional spend; included use continues" — so a default can never
 * authorise money; it can only fail to authorise it.
 */
export const ZERO_AUTHORITY_USAGE: Readonly<Partial<UsageAuthority>> = {
  variableAllowance:
    "Within the included Subscription Tokens under clause 22; no separate variable-use allowance",
  variableBasis: "No extra-use authority: no extra rate, no authorised payer, period cap $0.00",
  buffer: "Zero",
};

/** A new offer for a tier, seeded from the issuing profile. */
export function newSubscriptionOffer(
  tier: SubscriptionTierSlug,
  profile: IssuingProfile,
  seed: Partial<Pick<SubscriptionOffer, "customer" | "signatory">> = {},
): SubscriptionOffer {
  const usage: Record<string, string> = { ...profile.usage };
  for (const [k, v] of Object.entries(ZERO_AUTHORITY_USAGE)) {
    if (!usage[k]?.trim() && v) usage[k] = v;
  }
  return subscriptionOfferSchema.parse({
    tier,
    paymentMethod: profile.defaultPaymentMethod,
    customer: seed.customer ?? {},
    signatory: seed.signatory ?? {},
    usage,
    service: profile.service,
  });
}

/* ───────────────────────────── composition ───────────────────────────── */

export type RateCardRow = { slug: string; name: string; credit_cost: number };
export type RateCard = { rows: readonly RateCardRow[]; version: string };

export type ComposeContext = {
  /** The offer reference printed beside the electronic acceptance. */
  offerReference: string;
  /** The live report rate card; null when it could not be read. */
  rateCard: RateCard | null;
  /** Today, YYYY-MM-DD — only used to warn about a past activation date. */
  today?: string;
  /**
   * An internal review copy rather than the issued offer. The acceptance
   * field then says so in words, where a signer would look, because a
   * completed copy that reads exactly like the offer is one somebody could
   * forward and have signed by hand — and clause 1.2 makes Aurixa's offer the
   * AUTHORISED ISSUE of the completed document, not any copy of it.
   */
  preview?: boolean;
};

export type ComposeGap = { key: string; message: string };

export type ComposedLine = {
  key: string;
  label: string;
  quantity: number;
  unitCents: number;
  discountCents: number;
  monthlyCents: number;
  committed: boolean;
  record: Record<AdditionalLineTag, string>;
};

export type ComposedTotals = {
  base: BasePricing;
  recurringExtrasCents: number;
  supportCents: number;
  /** Base (or its monthly equivalent when prepaid) + extras + support. */
  monthlyTotalCents: number;
  monthlyGstCents: number;
  oneOffTotalCents: number;
  firstPaymentCents: number;
  dueAtActivationCents: number;
  minimumFixedCents: number;
  /** After the commitment: standard base + continuing extras; null when flexible. */
  postTermMonthlyCents: number | null;
};

export type ComposedOffer = {
  fields: Record<SubscriptionFieldTag, FieldValue>;
  lines: ComposedLine[];
  totals: ComposedTotals;
  dates: ServiceDates | null;
  gaps: ComposeGap[];
  warnings: string[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function blank(s: string | undefined | null): boolean {
  return !s || !s.trim();
}

function amlLabel(aml: "with" | "without"): string {
  return aml === "with" ? "With AML" : "Without AML";
}

const TERM_LABEL: Record<SubscriptionTerm, string> = {
  flexible: "Flexible — month to month",
  committed_monthly: "12-month commitment — 15% off the base; 12 monthly instalments",
  committed_annual: "12-month commitment — 15% off the base; one annual prepayment of the base",
};

function seatWord(n: number): string {
  return n === 1 ? "seat" : "seats";
}

/** Printed in a preview's acceptance field in place of the signing instruction. */
export const PREVIEW_ACCEPTANCE_NOTICE =
  "PREVIEW ONLY — an internal review copy, not an offer. Do not sign this copy.";

/** The electronic-acceptance value: the offer reference, room to sign, and the two anchors. */
function esignValue(reference: string, preview = false): FieldSegment[] {
  const lead = preview
    ? `${PREVIEW_ACCEPTANCE_NOTICE} The issued offer is signed through DocuSign for offer ${reference}.`
    : `Signed through DocuSign for offer ${reference}. Your authorised representative signs below.`;
  return [
    {
      text: `${lead}\n\n\n\nSignature:  `,
    },
    { anchor: SUBSCRIPTION_ANCHORS.clientSignature },
    { text: "\nDate signed:  " },
    { anchor: SUBSCRIPTION_ANCHORS.clientDate },
  ];
}

/** A field value as plain text, anchors shown as what DocuSign places there. */
export function fieldValueText(value: FieldValue): string {
  if (typeof value === "string") return value;
  return value
    .map((s) =>
      "anchor" in s
        ? s.anchor === SUBSCRIPTION_ANCHORS.clientSignature
          ? "⟨DocuSign signature⟩"
          : s.anchor === SUBSCRIPTION_ANCHORS.clientDate
            ? "⟨DocuSign date⟩"
            : "⟨DocuSign field⟩"
        : s.text,
    )
    .join("");
}

export function composeSubscriptionOffer(
  offer: SubscriptionOffer,
  ctx: ComposeContext,
): ComposedOffer {
  const gaps: ComposeGap[] = [];
  const warnings: string[] = [];
  const gap = (key: string, message: string) => gaps.push({ key, message });

  const template = SUBSCRIPTION_TEMPLATES[offer.tier];
  const tierName = template.tierName;
  const catalog = catalogTier(offer.tier);
  const withAml = offer.aml === "with";
  const committed = isCommitted(offer.term);
  const base = priceBase(offer.tier, withAml, offer.term);

  /* ── customer, signatory, dates ── */
  const c = offer.customer;
  if (blank(c.legalName)) gap("customer.legalName", "Enter the customer's legal name.");
  if (blank(c.identifier))
    gap("customer.identifier", "Enter the customer's ABN, ACN or other legal identifier.");
  const identifier = readIdentifier(c.identifier);
  if (!blank(c.identifier) && !identifier.valid) {
    gap(
      "customer.identifier",
      `${identifier.display} fails the ${identifier.kind === "abn" ? "ABR" : "ASIC"} check-digit test — check the number.`,
    );
  }
  if (blank(c.address)) gap("customer.address", "Enter the confirmed business address.");
  if (blank(c.noticeEmail)) gap("customer.noticeEmail", "Enter the legal-notice email.");
  else if (!EMAIL.test(c.noticeEmail.trim()))
    gap("customer.noticeEmail", "The legal-notice email is not a valid address.");

  const s = offer.signatory;
  if (blank(s.name)) gap("signatory.name", "Enter the authorised representative's name.");
  if (blank(s.role)) gap("signatory.role", "Enter the authorised representative's role.");
  if (blank(s.email))
    gap("signatory.email", "Enter the verified signing email — DocuSign sends the envelope there.");
  else if (!EMAIL.test(s.email.trim()))
    gap("signatory.email", "The signing email is not a valid address.");

  const activation = parseIsoDate(offer.activationDate);
  if (!activation) gap("activationDate", "Choose the planned activation date.");
  const dates = activation ? serviceDates(activation, offer.term) : null;
  if (activation && ctx.today && offer.activationDate < ctx.today) {
    warnings.push("The activation date is in the past. Clause 4.5 does not allow backdating.");
  }
  if (blank(offer.paymentMethod))
    gap("paymentMethod", "Enter the payment method (for example, card through Stripe).");

  /* ── additional lines ── */
  const lines: ComposedLine[] = [];
  const purchaser = c.legalName.trim() || "the Customer";
  const lineDates = (lineCommitted: boolean): string => {
    if (!dates) return "Effective at paid activation";
    const renew = `renews monthly with the base on the ${ordinal(dates.anchorDay)}`;
    const end =
      lineCommitted && dates.commitmentLastDay
        ? `committed to the base commitment end — last day ${formatLongDate(dates.commitmentLastDay)}`
        : "flexible — removable from the next renewal";
    return `Effective at paid activation (${formatLongDate(dates.activation)}); ${renew}; ${end}`;
  };
  const immediate = (monthly: number, lineCommitted: boolean): string => {
    const first = `Immediate charge ${formatAud(monthly)} in the first payment`;
    if (!lineCommitted) return `${first}; no fixed commitment`;
    const remaining = monthly * (COMMITMENT_MONTHS - 1);
    return `${first}; remaining fixed line charges ${COMMITMENT_MONTHS - 1} × ${formatAud(monthly)} = ${formatAud(remaining)} (${formatAud(monthly * COMMITMENT_MONTHS)} fixed in total)`;
  };

  if (offer.extraSeats > 0) {
    const seat = a3Item(EXTRA_SEAT_KEY);
    const unit = seat?.referenceMonthlyCents ?? 0;
    const monthly = unit * offer.extraSeats;
    const n = offer.extraSeats;
    lines.push({
      key: EXTRA_SEAT_KEY,
      label: "Additional User Seat",
      quantity: n,
      unitCents: unit,
      discountCents: 0,
      monthlyCents: monthly,
      committed: false,
      record: {
        "addon.id_buyer_scope": `A4-1 Additional User Seat; purchaser ${purchaser}; ${n} named internal user ${seatWord(n)} beyond the ${catalog.seatMax} included in ${tierName}; approved additional seats only`,
        "addon.quantity_price_discount_total": `${n} × ${formatAud(unit)} = ${formatAud(monthly)}; no discount; monthly total ${formatAud(monthly)} incl. GST`,
        "addon.dates_and_term": lineDates(false),
        "addon.immediate_and_commitment": immediate(monthly, false),
        "addon.usage_and_costs":
          "Seat capacity only; adds no Subscription Tokens, checks or spending authority",
        "addon.permissions_and_terms":
          "Named internal users only; client-only and partner-only access are distinct from internal seats",
      },
    });
  }

  const seen = new Set<string>();
  offer.addons.forEach((line, index) => {
    const item = a3Item(line.itemKey);
    const where = `addons.${index}`;
    if (!item) {
      gap(where, `Line ${index + 1} names an item that is not in Schedule A3.`);
      return;
    }
    if (item.kind === "seat") {
      gap(where, "Additional seats are set with the seat count, not as a separate line.");
      return;
    }
    if (item.kind === "independent_contract") {
      gap(
        where,
        `${item.label} needs its own purchaser and paid agreement — it cannot be ordered under a tier agreement.`,
      );
      return;
    }
    if (item.kind === "not_for_sale" || item.referenceMonthlyCents === null) {
      gap(where, `${item.label} is not for sale.`);
      return;
    }
    if (isIncludedInTier(offer.tier, item.key)) {
      gap(
        where,
        `${item.label} is already included in ${tierName} — an included item has no separate access fee.`,
      );
      return;
    }
    if (seen.has(item.key)) {
      gap(where, `${item.label} is listed twice — combine the lines and set a quantity.`);
      return;
    }
    seen.add(item.key);

    const unit = item.referenceMonthlyCents;
    const gross = unit * line.quantity;
    if (line.discountMonthlyCents > gross) {
      gap(
        where,
        `The discount on ${item.label} is larger than its ${formatAud(gross)} monthly charge.`,
      );
    }
    const discount = Math.min(line.discountMonthlyCents, gross);
    const monthly = gross - discount;
    const lineCommitted = line.term === "committed";
    if (lineCommitted && !committed) {
      gap(
        where,
        `${item.label} is marked committed, but only a 12-month committed term can fix a line.`,
      );
    }
    if (item.requiresScope && blank(line.scope)) {
      gap(
        where,
        `${item.label} needs its identified scope — Schedule A3 requires ${item.key === "advanced-forms-builder" ? "an identified incremental, ready scope" : "stated customer-facing boundaries"}.`,
      );
    }
    const scope =
      line.scope.trim() ||
      `Standard ${item.label} functionality as described in Schedules A3 and B; no setup dependencies recorded`;
    const quantityText =
      line.quantity === 1
        ? `1 × ${formatAud(unit)} = ${formatAud(gross)}`
        : `${line.quantity} × ${formatAud(unit)} = ${formatAud(gross)}`;
    const discountText = discount > 0 ? `accepted discount ${formatAud(discount)}` : "no discount";
    const number = lines.length + 1;
    lines.push({
      key: item.key,
      label: item.label,
      quantity: line.quantity,
      unitCents: unit,
      discountCents: discount,
      monthlyCents: monthly,
      committed: lineCommitted,
      record: {
        "addon.id_buyer_scope": `A4-${number} ${item.label}; purchaser ${line.purchaser.trim() || purchaser}; ${scope}`,
        "addon.quantity_price_discount_total": `${quantityText}; ${discountText}; monthly total ${formatAud(monthly)} incl. GST`,
        "addon.dates_and_term": lineDates(lineCommitted && committed),
        "addon.immediate_and_commitment": immediate(monthly, lineCommitted && committed),
        "addon.usage_and_costs":
          line.usageAndCosts.trim() ||
          "Access only; no separate included quota, provider-cost basis or extra-spend authority (additional spend $0.00)",
        "addon.permissions_and_terms":
          line.permissions.trim() ||
          "No additional data, partner or regulated-service permissions; Schedule B product terms apply as issued with this Agreement",
      },
    });
  });

  /* ── support and one-offs ── */
  const supportCents = offer.supportFee.monthlyCents;
  if (supportCents > 0 && blank(offer.supportFee.description)) {
    gap("supportFee.description", "Describe the support the monthly support fee buys.");
  }
  offer.oneOffCharges.forEach((charge, i) => {
    if (blank(charge.description))
      gap(`oneOffCharges.${i}`, `One-off charge ${i + 1} needs a description.`);
    if (charge.amountCents <= 0)
      gap(`oneOffCharges.${i}`, `One-off charge ${i + 1} needs an amount.`);
  });

  /* ── totals ── */
  const recurringExtrasCents = lines.reduce((n, l) => n + l.monthlyCents, 0);
  const committedLinesCents = lines
    .filter((l) => l.committed && committed)
    .reduce((n, l) => n + l.monthlyCents, 0);
  const flexibleExtrasCents = recurringExtrasCents - committedLinesCents + supportCents;
  const monthlyTotalCents = base.netMonthlyCents + recurringExtrasCents + supportCents;
  const oneOffTotalCents = offer.oneOffCharges.reduce((n, o) => n + Math.max(0, o.amountCents), 0);
  const firstPaymentCents =
    offer.term === "committed_annual"
      ? (base.annualPrepaymentCents ?? 0) + recurringExtrasCents + supportCents
      : monthlyTotalCents;
  const dueAtActivationCents = firstPaymentCents + oneOffTotalCents;
  const minimumFixedCents = committed
    ? base.committedTotalCents +
      committedLinesCents * COMMITMENT_MONTHS +
      flexibleExtrasCents +
      oneOffTotalCents
    : firstPaymentCents + oneOffTotalCents;
  const postTermMonthlyCents = committed
    ? base.standardMonthlyCents + recurringExtrasCents + supportCents
    : null;

  const totals: ComposedTotals = {
    base,
    recurringExtrasCents,
    supportCents,
    monthlyTotalCents,
    monthlyGstCents: gstContainedCents(monthlyTotalCents),
    oneOffTotalCents,
    firstPaymentCents,
    dueAtActivationCents,
    minimumFixedCents,
    postTermMonthlyCents,
  };

  /* ── usage and service authorities ── */
  const inScope = (predicate: (key: string) => boolean): boolean =>
    lines.some((l) => predicate(l.key)) || A3_INCLUDED[offer.tier].some(predicate);
  const communicationsEnabled = inScope((k) => Boolean(a3Item(k)?.enablesCommunications));
  const u = offer.usage;
  const requireUsage = (key: keyof UsageAuthority, what: string) => {
    if (blank(u[key])) gap(`usage.${key}`, `State ${what} (Schedule A4).`);
  };
  requireUsage("variableAllowance", "the variable agents / AI / data allowance");
  requireUsage("variableBasis", "the variable-use extra basis, payer and cap");
  requireUsage("apiAllowance", "the included API calls and storage");
  requireUsage("apiBasis", "the API and storage extra basis, payer and cap");
  requireUsage("buffer", "the in-flight reservation buffer, or Zero");
  if (withAml) {
    requireUsage("amlAllowance", "the approved AML checks and monitoring allowance");
    requireUsage("amlBasis", "the AML extra-check basis, payer and cap");
  }
  if (communicationsEnabled) {
    requireUsage("commsAllowance", "the enabled email / SMS / voice actions and allowance");
    requireUsage("commsBasis", "the communications extra-use basis, payer and cap");
  }

  const sv = offer.service;
  const requireService = (key: keyof ServiceDisclosure, what: string) => {
    if (blank(sv[key])) gap(`service.${key}`, `Complete ${what}.`);
  };
  requireService("serviceProfile", "the E5 service profile, version and effective date");
  requireService("supabase", "the E5 Supabase location and account model");
  requireService("edge", "the E5 Cloudflare / hosting profile");
  requireService("processing", "the E5 additional processing and risk scope");
  requireService("lifecycle", "the E5 retention, recovery and export facts");
  requireService("legalContact", "the monitored legal-notice contact");
  requireService("supportContact", "the support, security and escalation routes");
  requireService("privacyContact", "the privacy contact and Privacy Notice");
  requireService("continuations", "the supplied Disclosure Records and continuations");
  requireService("correctionRoute", "the verified correction route");
  requireService(
    "applicableDocuments",
    "the additional applicable documents (including the E5 record)",
  );

  const rateCard = ctx.rateCard;
  if (!rateCard || rateCard.rows.length === 0 || blank(rateCard.version)) {
    gap(
      "rateCard",
      "The report rate card could not be read — A4 must state each task's token cost and the rate-card version.",
    );
  }

  /* ── field text ── */
  const f = (cents: number) => formatAud(cents);
  const long = (d: { y: number; m: number; d: number } | null | undefined) =>
    d ? formatLongDate(d) : "";
  const anchorNote = dates && dates.anchorDay > 28 ? ` (the last day of any shorter month)` : "";

  const extrasList = lines.map((l) => {
    if (l.key === EXTRA_SEAT_KEY) {
      return `${l.quantity} additional user ${seatWord(l.quantity)} × ${f(l.unitCents)} = ${f(l.monthlyCents)}`;
    }
    const gross = l.unitCents * l.quantity;
    const head =
      l.quantity === 1
        ? `${l.label} ${f(gross)}`
        : `${l.quantity} × ${l.label} at ${f(l.unitCents)} = ${f(gross)}`;
    const disc =
      l.discountCents > 0
        ? ` − ${f(l.discountCents)} accepted discount = ${f(l.monthlyCents)}`
        : "";
    return `${head}${disc}${l.committed && committed ? " (committed)" : ""}`;
  });

  const oneOffText = offer.oneOffCharges
    .filter((o) => o.amountCents > 0)
    .map((o) => `${o.description.trim() || "one-off charge"} ${f(o.amountCents)}`);

  const x09 = inScope((k) => Boolean(a3Item(k)?.invokesX09));
  const applicableDocuments = [
    sv.applicableDocuments.trim(),
    x09 ? "X09 Marketplace & Commercial Product Supplement, as reproduced in this Agreement" : "",
    offer.additionalDocuments.trim(),
  ]
    .filter(Boolean)
    .join("; ");

  const selectedAddons = lines.length
    ? `${lines
        .map((l) =>
          l.key === EXTRA_SEAT_KEY
            ? `${l.quantity} additional user ${seatWord(l.quantity)}`
            : l.quantity > 1
              ? `${l.quantity} × ${l.label}`
              : l.label,
        )
        .join("; ")} — scope and setup conditions for each are recorded in Schedule A4`
    : "None";

  const headlineBasis = (() => {
    const due = `${f(dueAtActivationCents)} due at activation`;
    if (offer.term === "committed_annual") {
      return `annual prepayment of the discounted ${tierName} base, incl. GST · ${due}${recurringExtrasCents + supportCents > 0 ? ` (with the first month of extras)` : ""}`;
    }
    if (offer.term === "committed_monthly")
      return `per month for 12 months, incl. GST, monthly in advance · ${due}`;
    return `per month, incl. GST, monthly in advance · ${due}`;
  })();

  const baseSummary = committed
    ? `Standard ${tierName} base (${amlLabel(offer.aml)}) ${f(base.standardMonthlyCents)} − 15% commitment discount ${f(base.discountMonthlyCents)} = net base ${f(base.netMonthlyCents)} per month${base.annualPrepaymentCents !== null ? `; ${f(base.annualPrepaymentCents)} prepaid for 12 months` : ""}`
    : `Standard ${tierName} base (${amlLabel(offer.aml)}) ${f(base.standardMonthlyCents)}; no commitment discount on a flexible term; net base ${f(base.netMonthlyCents)} per month`;

  const minimumText = committed
    ? [
        `Committed base 12 × ${f(base.netMonthlyCents)} = ${f(base.committedTotalCents)}`,
        committedLinesCents > 0
          ? `committed lines 12 × ${f(committedLinesCents)} = ${f(committedLinesCents * COMMITMENT_MONTHS)}`
          : "",
        flexibleExtrasCents > 0
          ? `first month of flexible extras and support ${f(flexibleExtrasCents)}`
          : "",
        oneOffTotalCents > 0 ? `one-off charges ${f(oneOffTotalCents)}` : "",
      ]
        .filter(Boolean)
        .join("; ") + `. Total minimum fixed charges ${f(minimumFixedCents)}.`
    : `No fixed term. Minimum: the first monthly payment of ${f(firstPaymentCents)}${oneOffTotalCents > 0 ? ` plus one-off charges of ${f(oneOffTotalCents)}` : ""}; total ${f(minimumFixedCents)}.`;

  const startAndRenewal = dates
    ? `Activation ${long(dates.activation)} — if paid activation is recorded on another date, every date here moves with it (clause 5.3). Renews monthly on the ${ordinal(dates.anchorDay)}${anchorNote}; next renewal ${long(dates.nextRenewal)}. ` +
      (dates.commitmentAnniversary && dates.commitmentLastDay
        ? `The 12-month commitment ends immediately before ${long(dates.commitmentAnniversary)} (its last day is ${long(dates.commitmentLastDay)}).`
        : "No commitment end.")
    : "";

  const method = offer.paymentMethod.trim();
  const paymentArrangement = dates
    ? offer.term === "committed_annual"
      ? `${f(base.annualPrepaymentCents ?? 0)} base prepayment due ${long(dates.activation)}` +
        (recurringExtrasCents + supportCents > 0
          ? `; extras and support ${f(recurringExtrasCents + supportCents)} monthly in advance on the ${ordinal(dates.anchorDay)} from ${long(dates.activation)}`
          : "; no monthly extras") +
        (oneOffTotalCents > 0
          ? `; one-off charges ${f(oneOffTotalCents)} due ${long(dates.activation)}`
          : "") +
        `. Payment method: ${method}. The prepayment covers the discounted ${tierName} base only. Refund treatment: an ordinary cancellation takes effect at the commitment end (clause 6.1); on an elective early release or an exit right, unused prepayment is applied once and any excess refunded (clauses 6 and 7.8).`
      : `${f(monthlyTotalCents)} monthly in advance on the ${ordinal(dates.anchorDay)} of each month from ${long(dates.activation)}${committed ? " — the committed base for 12 instalments, extras while they continue" : ""}` +
        (oneOffTotalCents > 0
          ? `; one-off charges ${f(oneOffTotalCents)} due ${long(dates.activation)}`
          : "") +
        `. Payment method: ${method}.`
    : "";

  const amlAllowanceText = withAml ? u.amlAllowance.trim() : "Not selected — Without AML";
  const amlBasisText = withAml
    ? u.amlBasis.trim()
    : "Not applicable — no AML check or monitoring spend is authorised";
  const commsAllowanceText = communicationsEnabled
    ? u.commsAllowance.trim()
    : "Not selected — no chargeable email, SMS, voice or recording use is enabled by this offer";
  const commsBasisText = communicationsEnabled
    ? u.commsBasis.trim()
    : "Not applicable — no extra-use authority; period cap $0.00";

  const rateCardText =
    rateCard && rateCard.rows.length
      ? `${rateCard.rows.map((r) => `${r.name} ${formatCount(r.credit_cost)} ${r.credit_cost === 1 ? "token" : "tokens"}`).join("; ")}. Rate-card version ${rateCard.version}.`
      : "";

  const fields: Record<SubscriptionFieldTag, FieldValue> = {
    "customer.legal_name": c.legalName.trim(),
    "customer.identifier": identifier.display,
    "order.aml_option": amlLabel(offer.aml),
    "customer.address": c.address.trim(),
    "order.term_label": TERM_LABEL[offer.term],
    "customer.notice_email": c.noticeEmail.trim(),
    "customer.billing_contact": c.billingContact.trim() || "Same as legal notices",
    "price.headline_amount":
      offer.term === "committed_annual" ? f(base.annualPrepaymentCents ?? 0) : f(monthlyTotalCents),
    "price.headline_basis": headlineBasis,
    "price.base_summary": baseSummary,
    "price.recurring_extras": lines.length
      ? `${extrasList.join("; ")}. Extras ${f(recurringExtrasCents)} per month.`
      : "None",
    "price.support_fee":
      supportCents > 0
        ? `Standard Support included; ${offer.supportFee.description.trim()} ${f(supportCents)} per month (not discounted)`
        : "Standard Support included",
    "price.total_label":
      offer.term === "committed_annual" ? "Monthly equivalent if prepaid" : "Monthly total",
    "price.total_monthly_incl_gst":
      offer.term === "committed_annual"
        ? `${f(monthlyTotalCents)} per month equivalent, including GST of ${f(totals.monthlyGstCents)} — the base is prepaid annually, so this equivalent is informational and not an additional charge`
        : `${f(monthlyTotalCents)} per month, including GST of ${f(totals.monthlyGstCents)}`,
    "price.activation_charges": `First payment ${f(firstPaymentCents)}; ${oneOffText.length ? `one-off charges: ${oneOffText.join("; ")}` : "no one-off charges"}; total due at activation ${f(dueAtActivationCents)}`,
    "price.minimum_label": committed
      ? "Minimum fixed charges (12-month commitment)"
      : "Minimum fixed charges",
    "price.minimum_fixed_commitment": minimumText,
    "price.post_term_summary":
      committed && dates?.commitmentAnniversary && postTermMonthlyCents !== null
        ? `From ${long(dates.commitmentAnniversary)}: month to month at the standard ${tierName} base of ${f(base.standardMonthlyCents)} (${amlLabel(offer.aml)})${recurringExtrasCents + supportCents > 0 ? ` plus continuing extras of ${f(recurringExtrasCents + supportCents)}` : ""} — ${f(postTermMonthlyCents)} per month — unless cancelled or recommitted (clauses 5.8–5.9)`
        : committed
          ? ""
          : "N/A — flexible month-to-month term",
    "order.start_and_renewal": startAndRenewal,
    "payment.arrangement": paymentArrangement,
    "seats.summary": `${catalog.seatMax} included + ${offer.extraSeats} purchased = ${catalog.seatMax + offer.extraSeats} named internal users; approved capacity ${catalog.seatMax + offer.extraSeats}`,
    "scope.selected_addons": selectedAddons,
    "scope.aml_summary": withAml
      ? `With AML — compliance workflow, case and evidence records, permitted verification and screening connections, monitoring and Compliance Passport within Schedule A2. Checks and monitoring: ${u.amlAllowance.trim()}`
      : `Without AML — the AML capabilities in Schedule A2 are not supplied; all other ${tierName} entitlements remain`,
    "credits.cycle_display": dates
      ? `${formatCount(template.includedTokensPerCycle)} Subscription Tokens granted at paid activation for the first Billing Cycle (${long(dates.activation)} to ${long(dates.firstCycleEnd)}); the next grant is on ${long(dates.nextRenewal)}, then each monthly cycle — including when the base is prepaid`
      : "",
    "offer.correction_route": sv.correctionRoute.trim(),
    "signatory.name": s.name.trim(),
    "signatory.role": s.role.trim(),
    "signatory.email": s.email.trim(),
    "order.special_conditions_summary": offer.specialConditions.trim() || "None",
    "order.applicable_documents": applicableDocuments,
    "signatory.esign_reference": esignValue(ctx.offerReference, ctx.preview),
    "usage.report_slugs_and_credit_costs": rateCardText,
    "usage.variable_allowance": u.variableAllowance.trim(),
    "usage.variable_basis_payer_cap": u.variableBasis.trim(),
    "usage.aml_allowance_or_disabled": amlAllowanceText,
    "usage.aml_basis_payer_cap": amlBasisText,
    "usage.communications_allowance_or_disabled": commsAllowanceText,
    "usage.communications_basis_payer_cap": commsBasisText,
    "usage.api_storage_allowance": u.apiAllowance.trim(),
    "usage.api_storage_basis_payer_cap": u.apiBasis.trim(),
    "usage.buffer_amount_or_zero": u.buffer.trim(),
    "service.profile": sv.serviceProfile.trim(),
    "service.supabase": sv.supabase.trim(),
    "service.edge": sv.edge.trim(),
    "service.processing": sv.processing.trim(),
    "service.lifecycle": sv.lifecycle.trim(),
    "contacts.legal": sv.legalContact.trim(),
    "contacts.support": sv.supportContact.trim(),
    "contacts.privacy": sv.privacyContact.trim(),
    "service.continuations": sv.continuations.trim(),
  };

  // Square brackets are how the templates mark an unfilled placeholder, and
  // the issuing gate refuses any document still carrying one. Typed text with
  // a bracket would be refused there with a message about placeholders, so
  // name the actual field here instead.
  const bracketed = (value: FieldValue) => /[[\]]/.test(fieldValueText(value));
  for (const tag of SUBSCRIPTION_FIELD_TAGS) {
    if (bracketed(fields[tag])) {
      gap(
        tag,
        `Remove the square brackets from ${FIELD_LABELS[tag]} — brackets mark unfilled placeholders.`,
      );
    }
  }
  lines.forEach((line, i) => {
    if (Object.values(line.record).some(bracketed)) {
      gap(
        `addons.${i}`,
        `Remove the square brackets from the ${line.label} record — brackets mark unfilled placeholders.`,
      );
    }
  });

  // A field that composed to nothing is a gap even if no rule above named it:
  // the fill engine would refuse it, and the operator deserves to hear why
  // before pressing Send. Only a backstop — every input that can leave a field
  // empty already has its own gap, so this speaks only when none did.
  if (!gaps.length) {
    for (const tag of SUBSCRIPTION_FIELD_TAGS) {
      const value = fields[tag];
      if (!fieldValueText(value).trim()) gap(tag, `${FIELD_LABELS[tag]} would be empty.`);
    }
  }

  return { fields, lines, totals, dates, gaps: dedupeGaps(gaps), warnings };
}

function dedupeGaps(gaps: ComposeGap[]): ComposeGap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const k = `${g.key}|${g.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class IncompleteOfferError extends Error {
  gaps: ComposeGap[];
  constructor(gaps: ComposeGap[]) {
    super(`offer_incomplete: ${gaps.map((g) => g.message).join(" ")}`);
    this.name = "IncompleteOfferError";
    this.gaps = gaps;
  }
}

/** The fill for the Word template. Refuses a composition with any gap. */
export function toDocumentFill(composed: ComposedOffer): DocumentFill {
  if (composed.gaps.length) throw new IncompleteOfferError(composed.gaps);
  return {
    fields: composed.fields,
    repeating: {
      [ADDITIONAL_LINES_TAG]: {
        items: composed.lines.map((l) => l.record),
        whenEmpty: NO_ADDITIONAL_PURCHASES,
      },
    },
  };
}

/** A human reference for an offer: AUR-SA-YYYYMMDD-XXXXXX, no ambiguous characters. */
export function newOfferReference(now: Date, random: (n: number) => Uint8Array): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = random(6);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `AUR-SA-${ymd}-${suffix}`;
}

/** The document title and email subject for an offer. */
export function offerTitle(tier: SubscriptionTierSlug, customerLegalName: string): string {
  const name = customerLegalName.trim() || "Customer";
  return `Aurixa Systems ${SUBSCRIPTION_TEMPLATES[tier].tierName} Subscription Agreement — ${name}`;
}
