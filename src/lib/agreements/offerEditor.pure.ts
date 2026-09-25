/**
 * The offer editor's own vocabulary — pure, so its reading of the composer is
 * tested beside the composer.
 *
 *  - **Where a gap belongs.** The composer names each thing that stops an
 *    offer being issued by a key: an offer path (`customer.legalName`,
 *    `addons.2`, `usage.apiBasis`) or, for the backstops, a document field tag
 *    (`contacts.legal`). The editor places each one beside the input that
 *    clears it and under the section that holds that input, so an operator is
 *    never told what is missing without being shown where.
 *  - **What the issuing profile still lacks.** Every offer copies the profile
 *    when it is prepared, so a gap in the profile becomes a gap in every offer
 *    raised from it. The profile page and the list both say so up front.
 *  - **Money as it is typed.** The offer stores integer cents; an operator
 *    types dollars.
 *  - **One view of an offer**, whether it is being composed live or read back
 *    from the snapshot of what was issued, so the page renders both the same
 *    way.
 */
import {
  formatAud,
  formatLongDate,
  isoDate,
  parseIsoDate,
  standardBaseCents,
} from "./subscriptionPricing.pure";
import {
  fieldValueText,
  FIELD_LABELS,
  newSubscriptionOffer,
  SUBSCRIPTION_FIELD_TAGS,
  type AdditionalLineTag,
  type ComposeGap,
  type ComposedOffer,
  type ComposedTotals,
  type IssuingProfile,
  type ServiceDisclosure,
  type SubscriptionFieldTag,
  type SubscriptionOffer,
  type UsageAuthority,
} from "./subscriptionOffer.pure";
import {
  A3_INCLUDED,
  a3Item,
  catalogTier,
  SUBSCRIPTION_TEMPLATES,
  type SubscriptionTierSlug,
} from "./subscriptionTemplates";
import type { IssuedSnapshot } from "./subscriptionIssue.pure";

/* ───────────────────────────── sections ───────────────────────────── */

export type OfferSection =
  | "order"
  | "customer"
  | "signatory"
  | "purchases"
  | "charges"
  | "usage"
  | "service"
  | "departures";

/** The editor's sections, in page order, with the document part each completes. */
export const OFFER_SECTIONS: ReadonlyArray<{ id: OfferSection; title: string; part: string }> = [
  { id: "order", title: "Order", part: "Section 01 · package, term and activation" },
  { id: "customer", title: "Customer", part: "Section 01 · the contracting entity" },
  { id: "signatory", title: "Authorised representative", part: "Section 03 · acceptance" },
  { id: "purchases", title: "Seats and additional purchases", part: "Schedule A4 · lines" },
  { id: "charges", title: "Support and one-off charges", part: "Section 02 · price" },
  { id: "usage", title: "Usage and spend authority", part: "Schedule A4 · authorities" },
  { id: "service", title: "Service disclosures", part: "Schedule E5 · and section 03" },
  { id: "departures", title: "Departures and documents", part: "Section 03 · negotiated terms" },
];

/**
 * Document field tags whose text comes from exactly one input, mapped to it.
 * A backstop or bracket gap keyed by the field is then shown where the text
 * was typed. Fields composed from several inputs are not listed; their gaps
 * stay at section level.
 */
const FIELD_TAG_INPUT: Partial<Record<SubscriptionFieldTag, string>> = {
  "customer.legal_name": "customer.legalName",
  "customer.identifier": "customer.identifier",
  "customer.address": "customer.address",
  "customer.notice_email": "customer.noticeEmail",
  "customer.billing_contact": "customer.billingContact",
  "signatory.name": "signatory.name",
  "signatory.role": "signatory.role",
  "signatory.email": "signatory.email",
  "offer.correction_route": "service.correctionRoute",
  "order.special_conditions_summary": "specialConditions",
  "usage.variable_allowance": "usage.variableAllowance",
  "usage.variable_basis_payer_cap": "usage.variableBasis",
  "usage.aml_allowance_or_disabled": "usage.amlAllowance",
  "usage.aml_basis_payer_cap": "usage.amlBasis",
  "usage.communications_allowance_or_disabled": "usage.commsAllowance",
  "usage.communications_basis_payer_cap": "usage.commsBasis",
  "usage.api_storage_allowance": "usage.apiAllowance",
  "usage.api_storage_basis_payer_cap": "usage.apiBasis",
  "usage.buffer_amount_or_zero": "usage.buffer",
  "service.profile": "service.serviceProfile",
  "service.supabase": "service.supabase",
  "service.edge": "service.edge",
  "service.processing": "service.processing",
  "service.lifecycle": "service.lifecycle",
  "contacts.legal": "service.legalContact",
  "contacts.support": "service.supportContact",
  "contacts.privacy": "service.privacyContact",
  "service.continuations": "service.continuations",
  "price.support_fee": "supportFee.description",
};

/** The input a gap is cleared at: an offer path, or the gap's own key when none is known. */
export function inputOfGap(key: string): string {
  return FIELD_TAG_INPUT[key as SubscriptionFieldTag] ?? key;
}

/** The section a gap belongs to. Anything unrecognised is an Order matter. */
export function sectionOfGap(key: string): OfferSection {
  const input = inputOfGap(key);
  if (input.startsWith("customer.")) return "customer";
  if (input.startsWith("signatory.")) return "signatory";
  if (
    input.startsWith("addons.") ||
    input === "seats.summary" ||
    input === "scope.selected_addons" ||
    input === "price.recurring_extras"
  ) {
    return "purchases";
  }
  if (
    input.startsWith("supportFee.") ||
    input.startsWith("oneOffCharges.") ||
    input === "price.activation_charges"
  ) {
    return "charges";
  }
  if (
    input.startsWith("usage.") ||
    input === "rateCard" ||
    input === "scope.aml_summary" ||
    input === "credits.cycle_display"
  ) {
    return "usage";
  }
  if (input.startsWith("service.") || input === "order.applicable_documents") return "service";
  if (input === "specialConditions" || input === "additionalDocuments") return "departures";
  return "order";
}

/** Gap messages keyed by the input that clears them. */
export function gapsByInput(gaps: readonly ComposeGap[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of gaps) {
    const key = inputOfGap(g.key);
    const list = out.get(key) ?? [];
    if (!list.includes(g.message)) list.push(g.message);
    out.set(key, list);
  }
  return out;
}

/** How many gaps each section holds. */
export function gapCountsBySection(gaps: readonly ComposeGap[]): Record<OfferSection, number> {
  const counts = Object.fromEntries(OFFER_SECTIONS.map((s) => [s.id, 0])) as Record<
    OfferSection,
    number
  >;
  for (const g of gaps) counts[sectionOfGap(g.key)] += 1;
  return counts;
}

/* ───────────────────────────── standing facts ───────────────────────────── */

export type FieldSpec<K extends string> = {
  key: K;
  label: string;
  /** Where the text lands in the document, and what it has to say. */
  hint: string;
  rows: number;
  /** The schema's own length limit, so the input stops where the server would refuse. */
  max: number;
  /** Only required when the offer has AML, or enables communications. */
  when?: "aml" | "comms";
};

/** Schedule E5 and the section 03 routes, in the document's order. */
export const SERVICE_FIELDS: ReadonlyArray<FieldSpec<keyof ServiceDisclosure>> = [
  {
    key: "serviceProfile",
    label: "Service profile and effective date",
    hint: "E5 — the profile name, its version and the date it takes effect.",
    rows: 2,
    max: 600,
  },
  {
    key: "supabase",
    label: "Supabase location and account model",
    hint: "E5 — region, project model (dedicated or shared) and who holds the account.",
    rows: 3,
    max: 1200,
  },
  {
    key: "edge",
    label: "Cloudflare / cloud hosting profile",
    hint: "E5 — where the application is served from and under whose account.",
    rows: 3,
    max: 1200,
  },
  {
    key: "processing",
    label: "Additional processing and risk scope",
    hint: "E5 — sub-processors and processing beyond the standard service.",
    rows: 3,
    max: 1200,
  },
  {
    key: "lifecycle",
    label: "Retention, recovery and export",
    hint: "E5 — retention periods, backup and recovery, and how an export is delivered.",
    rows: 3,
    max: 1500,
  },
  {
    key: "legalContact",
    label: "Legal notices contact",
    hint: "E5 — a monitored address for legal notices.",
    rows: 2,
    max: 600,
  },
  {
    key: "supportContact",
    label: "Support, security and escalation",
    hint: "E5 — support hours and routes, security reporting and escalation.",
    rows: 2,
    max: 800,
  },
  {
    key: "privacyContact",
    label: "Privacy enquiries",
    hint: "E5 — the privacy contact and where the Privacy Notice is published.",
    rows: 2,
    max: 600,
  },
  {
    key: "continuations",
    label: "Supplied continuations",
    hint: "E5 — the Disclosure Records and continuation sheets supplied with the offer.",
    rows: 3,
    max: 1500,
  },
  {
    key: "correctionRoute",
    label: "Correction route",
    hint: "Section 03 — where the customer asks for a corrected offer. Also named in the DocuSign invitation.",
    rows: 2,
    max: 600,
  },
  {
    key: "applicableDocuments",
    label: "Standing applicable documents",
    hint: "Section 03 — the documents every offer carries, including the E5 record.",
    rows: 3,
    max: 1500,
  },
];

/** Schedule A4's authorities, in the document's order. */
export const USAGE_FIELDS: ReadonlyArray<FieldSpec<keyof UsageAuthority>> = [
  {
    key: "variableAllowance",
    label: "Variable agents / AI / data — included",
    hint: "A4 — what variable use is included. Defaults to the included Subscription Tokens only.",
    rows: 2,
    max: 800,
  },
  {
    key: "variableBasis",
    label: "Variable agents / AI / data — extra basis, payer and cap",
    hint: "A4 — the rate, who pays and the period cap. No authority means no additional spend.",
    rows: 2,
    max: 800,
  },
  {
    key: "amlAllowance",
    label: "AML verification / screening / monitoring — included",
    hint: "A4 — the approved checks and monitoring. Required with AML.",
    rows: 2,
    max: 800,
    when: "aml",
  },
  {
    key: "amlBasis",
    label: "AML — extra basis, payer and cap",
    hint: "A4 — the rate for checks beyond the allowance, who pays and the cap.",
    rows: 2,
    max: 800,
    when: "aml",
  },
  {
    key: "commsAllowance",
    label: "Email / SMS / voice / recording — included",
    hint: "A4 — the enabled actions and allowance. Required when a communications module is in scope.",
    rows: 2,
    max: 800,
    when: "comms",
  },
  {
    key: "commsBasis",
    label: "Communications — extra basis, payer and cap",
    hint: "A4 — the rate beyond the allowance, who pays and the cap.",
    rows: 2,
    max: 800,
    when: "comms",
  },
  {
    key: "apiAllowance",
    label: "API calls / storage / exceptional provider use — included",
    hint: "A4 — the included API calls and storage.",
    rows: 2,
    max: 800,
  },
  {
    key: "apiBasis",
    label: "API and storage — extra basis, payer and cap",
    hint: "A4 — the rate beyond the allowance, who pays and the cap.",
    rows: 2,
    max: 800,
  },
  {
    key: "buffer",
    label: "In-flight reservations / buffers",
    hint: "A4 — the reservation buffer, or Zero.",
    rows: 1,
    max: 400,
  },
];

export type ProfileGap = {
  key: string;
  label: string;
  /** `required` — every offer raised from the profile would carry this gap. */
  weight: "required" | "conditional" | "recommended";
  note: string;
};

/**
 * What the issuing profile does not yet state, weighed by what it costs: a
 * `required` fact is a gap on every offer raised from the profile; a
 * `conditional` one only where the offer enables what it governs; a
 * `recommended` one is typed per offer instead.
 *
 * Variable use and the buffer are absent from this list on purpose: an offer
 * starts with the agreement's own zero authority where the profile is silent.
 */
export function issuingProfileGaps(profile: IssuingProfile): ProfileGap[] {
  const blank = (s: string | undefined) => !s || !s.trim();
  const gaps: ProfileGap[] = [];
  for (const f of SERVICE_FIELDS) {
    if (blank(profile.service[f.key])) {
      gaps.push({
        key: `service.${f.key}`,
        label: f.label,
        weight: "required",
        note: "Printed in every offer.",
      });
    }
  }
  for (const f of USAGE_FIELDS) {
    if (f.key === "variableAllowance" || f.key === "variableBasis" || f.key === "buffer") continue;
    if (!blank(profile.usage[f.key])) continue;
    gaps.push({
      key: `usage.${f.key}`,
      label: f.label,
      weight: f.when === "comms" ? "conditional" : "required",
      note:
        f.when === "comms"
          ? "Needed for Scale and for any offer with Email Copilot, Call Logs or Marketing."
          : f.when === "aml"
            ? "Needed for every offer with AML."
            : "Needed for every offer.",
    });
  }
  if (blank(profile.defaultPaymentMethod)) {
    gaps.push({
      key: "defaultPaymentMethod",
      label: "Default payment method",
      weight: "recommended",
      note: "Otherwise typed on each offer.",
    });
  }
  return gaps;
}

/** Whether an offer's standing facts are the profile's as it stands now. */
export function serviceMatchesProfile(offer: SubscriptionOffer, profile: IssuingProfile): boolean {
  const fresh = newSubscriptionOffer(offer.tier, profile);
  return SERVICE_FIELDS.every(
    (f) => (offer.service[f.key] ?? "").trim() === (fresh.service[f.key] ?? "").trim(),
  );
}

/** The offer with its E5 disclosures and routes replaced by the profile's. */
export function withProfileService(
  offer: SubscriptionOffer,
  profile: IssuingProfile,
): SubscriptionOffer {
  return { ...offer, service: { ...newSubscriptionOffer(offer.tier, profile).service } };
}

/** The offer with its A4 authorities reset to the profile's (and the zero defaults). */
export function withProfileUsage(
  offer: SubscriptionOffer,
  profile: IssuingProfile,
): SubscriptionOffer {
  return { ...offer, usage: { ...newSubscriptionOffer(offer.tier, profile).usage } };
}

/* ───────────────────────────── money ───────────────────────────── */

/**
 * Dollars as an operator types them — "1,234.56", "$99", "49.5" — to integer
 * cents. Blank is zero. Anything else, or more than two decimals, is null so
 * the input can say so rather than round an amount somebody typed.
 */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!t) return 0;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Cents as the input shows them: blank for zero, otherwise two decimals without grouping. */
export function dollarsInputText(cents: number): string {
  if (!cents) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/* ───────────────────────────── tiers ───────────────────────────── */

export type TierSummary = {
  tier: SubscriptionTierSlug;
  name: string;
  seats: string;
  includedSeats: number;
  withAmlCents: number;
  withoutAmlCents: number;
  tokens: number;
  included: string[];
  templateVersion: string;
};

/** A tier as the new-offer dialog presents it, from the template and the catalogue. */
export function tierSummary(tier: SubscriptionTierSlug): TierSummary {
  const t = SUBSCRIPTION_TEMPLATES[tier];
  const c = catalogTier(tier);
  return {
    tier,
    name: t.tierName,
    seats: `${c.seatMin}–${c.seatMax} seats`,
    includedSeats: c.seatMax,
    withAmlCents: standardBaseCents(tier, true),
    withoutAmlCents: standardBaseCents(tier, false),
    tokens: t.includedTokensPerCycle,
    included: A3_INCLUDED[tier].map((k) => a3Item(k)?.label ?? k),
    templateVersion: t.version,
  };
}

/** Whether a tier's own inclusions, or any purchased line, enables communications. */
export function communicationsInScope(offer: SubscriptionOffer): boolean {
  return (
    A3_INCLUDED[offer.tier].some((k) => Boolean(a3Item(k)?.enablesCommunications)) ||
    offer.addons.some((l) => Boolean(a3Item(l.itemKey)?.enablesCommunications))
  );
}

/* ───────────────────────────── one view of an offer ───────────────────────────── */

export type OfferView = {
  /** Every Order field as the document prints it. */
  fields: Record<string, string>;
  lines: IssuedSnapshot["lines"];
  /** Schedule A4's printed record for each line, in order. */
  records: Array<{ label: string; record: Record<string, string> }>;
  totals: ComposedTotals;
  dates: IssuedSnapshot["dates"];
  gaps: ComposeGap[];
  warnings: string[];
};

/** A live composition, in the snapshot's shape. */
export function composedView(composed: ComposedOffer): OfferView {
  const fields: Record<string, string> = {};
  for (const tag of SUBSCRIPTION_FIELD_TAGS) fields[tag] = fieldValueText(composed.fields[tag]);
  const d = composed.dates;
  return {
    fields,
    lines: composed.lines.map((l) => ({
      key: l.key,
      label: l.label,
      quantity: l.quantity,
      unitCents: l.unitCents,
      discountCents: l.discountCents,
      monthlyCents: l.monthlyCents,
      committed: l.committed,
    })),
    records: composed.lines.map((l) => ({ label: l.label, record: { ...l.record } })),
    totals: composed.totals,
    dates: d
      ? {
          activation: isoDate(d.activation),
          anchorDay: d.anchorDay,
          nextRenewal: isoDate(d.nextRenewal),
          firstCycleEnd: isoDate(d.firstCycleEnd),
          commitmentAnniversary: d.commitmentAnniversary ? isoDate(d.commitmentAnniversary) : null,
          commitmentLastDay: d.commitmentLastDay ? isoDate(d.commitmentLastDay) : null,
        }
      : null,
    gaps: composed.gaps,
    warnings: composed.warnings,
  };
}

/**
 * The issued offer, read back from its snapshot: nothing is outstanding on a
 * record. The snapshot keeps each line's figures but not its printed A4
 * record — those are reproduced from the frozen offer, and the issued
 * document's digest is what proves they match — so the caller passes them.
 */
export function snapshotView(
  snapshot: IssuedSnapshot,
  records: OfferView["records"] = [],
): OfferView {
  return {
    fields: { ...snapshot.fields },
    lines: snapshot.lines,
    records,
    totals: snapshot.totals,
    dates: snapshot.dates,
    gaps: [],
    warnings: snapshot.warnings,
  };
}

/** A snapshot as stored, or null when the value is not one this build can read. */
export function readIssuedSnapshot(value: unknown): IssuedSnapshot | null {
  const s = value as Partial<IssuedSnapshot> | null;
  if (
    !s ||
    typeof s !== "object" ||
    s.schema !== 1 ||
    typeof s.issuedAt !== "string" ||
    !s.fields ||
    !s.totals ||
    !s.document
  ) {
    return null;
  }
  return s as IssuedSnapshot;
}

/** The review table's rows: every field with the template's own label. */
export function reviewRows(view: OfferView): Array<{ tag: string; label: string; text: string }> {
  return SUBSCRIPTION_FIELD_TAGS.map((tag) => ({
    tag,
    label: FIELD_LABELS[tag],
    text: view.fields[tag] ?? "",
  }));
}

/** Schedule A4's row labels for one additional-purchase record, as the template prints them. */
export const ADDITIONAL_LINE_LABELS: Readonly<Record<AdditionalLineTag, string>> = {
  "addon.id_buyer_scope": "Purchase and scope",
  "addon.quantity_price_discount_total": "Quantity and monthly charge",
  "addon.dates_and_term": "Start, renewal and line term",
  "addon.immediate_and_commitment": "Immediate adjustment / fixed commitment",
  "addon.usage_and_costs": "Included use and external costs",
  "addon.permissions_and_terms": "Permissions and applicable terms",
};

/** "1 October 2026", from a stored YYYY-MM-DD; the input itself when it is not one. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = parseIsoDate(iso);
  return d ? formatLongDate(d) : iso;
}

/** "$1,234.56". Re-exported so the page formats money exactly as the document does. */
export const aud = formatAud;
