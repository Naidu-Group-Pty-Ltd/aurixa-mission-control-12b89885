/**
 * Issuing a Subscription Agreement: the envelope DocuSign receives and the
 * snapshot Mission Control keeps — with no network in either.
 *
 * The agreement fixes two things this module has to honour.
 *
 *  - **One signer, and no countersignature.** Clause 1.2: "Your authorised
 *    representative accepts by signature … No Aurixa countersignature is
 *    required unless the Order requires one." So the envelope has exactly one
 *    signer — the representative the Order names — and Aurixa's countersigner
 *    (when one is configured) is a CARBON COPY: they receive the completed
 *    document, they do not sign it. The Service Level Agreement's second
 *    signer does not carry over.
 *
 *  - **The commercial snapshot is kept before the purchase activates.** Same
 *    clause: "We retain the accepted document and commercial snapshot before
 *    activating the purchase." `buildIssuedSnapshot` is that snapshot: every
 *    composed field as the document prints it, the lines, totals and dates,
 *    the rate card the A4 costs came from, the template's identity and digest,
 *    and the digests of the exact document sent. It is written before the
 *    envelope is created, and the database refuses to change it after.
 *
 * Tabs are placed on the two invisible anchors the fill engine paints into
 * the acceptance field. Unlike the SLA's tabs they are STRICT
 * (`anchorIgnoreIfNotPresent: "false"`): the issue step has already asserted
 * each anchor appears exactly once, so a missing one is a defect, and DocuSign
 * refusing the envelope is the right outcome — not an envelope that has
 * nowhere to sign.
 */
import { MODULES } from "@/lib/pricing/aurixa-catalog";
import type { IssuedDocumentMeta } from "./docxPackage.pure";
import { isoDate, parseIsoDate } from "./subscriptionPricing.pure";
import {
  fieldValueText,
  offerTitle,
  SUBSCRIPTION_FIELD_TAGS,
  type ComposedOffer,
  type RateCard,
  type SubscriptionOffer,
} from "./subscriptionOffer.pure";
import {
  A3_INCLUDED,
  a3Item,
  isIncludedInTier,
  SUBSCRIPTION_ANCHORS,
  SUBSCRIPTION_TEMPLATES,
  type SubscriptionTierSlug,
} from "./subscriptionTemplates";

/** DocuSign refuses an email subject longer than this. */
export const DOCUSIGN_SUBJECT_MAX = 100;

/** Envelope custom fields: how an envelope is traced back to its agreement. */
export const AGREEMENT_ID_CUSTOM_FIELD = "mc_agreement_id";
export const OFFER_REFERENCE_CUSTOM_FIELD = "mc_offer_reference";

/** The retained signed records' bucket (see the 20260925100000 migration). */
export const AGREEMENT_RECORDS_BUCKET = "agreement-records";

export function envelopeSubject(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= DOCUSIGN_SUBJECT_MAX) return clean;
  return `${clean.slice(0, DOCUSIGN_SUBJECT_MAX - 1).trimEnd()}…`;
}

/** The issued document's file name, as the signer sees it in DocuSign. */
export function issuedDocumentName(tier: SubscriptionTierSlug, offerReference: string): string {
  return `Aurixa ${SUBSCRIPTION_TEMPLATES[tier].tierName} Subscription Agreement ${offerReference}.docx`;
}

/** A preview's file name says what it is before anyone opens it. */
export function previewDocumentName(tier: SubscriptionTierSlug, offerReference: string): string {
  return `PREVIEW - Aurixa ${SUBSCRIPTION_TEMPLATES[tier].tierName} Subscription Agreement ${offerReference}.docx`;
}

/** The signed record's object path: one per agreement and envelope. */
export function signedRecordPath(agreementId: string, envelopeId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");
  return `subscription/${safe(agreementId)}/${safe(envelopeId)}-signed.pdf`;
}

type AnchorTab = Record<string, string>;

function strictAnchorTab(
  anchor: string,
  yOffset: string,
  extra: Record<string, string> = {},
): AnchorTab {
  return {
    anchorString: anchor,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: yOffset,
    anchorIgnoreIfNotPresent: "false",
    anchorCaseSensitive: "true",
    anchorMatchWholeWord: "false",
    ...extra,
  };
}

export type SubscriptionEnvelopeInput = {
  agreementId: string;
  offerReference: string;
  tier: SubscriptionTierSlug;
  /** `offerTitle(...)` — the document's own title. */
  title: string;
  documentBase64: string;
  signer: { name: string; email: string };
  customerLegalName: string;
  /** Section 03's correction route, named in the invitation. */
  correctionRoute: string;
  /** Aurixa's copy of the completed document; null when none is configured. */
  carbonCopy: { name: string | null; email: string } | null;
};

export function buildSubscriptionEnvelopeDefinition(
  input: SubscriptionEnvelopeInput,
): Record<string, unknown> {
  const tierName = SUBSCRIPTION_TEMPLATES[input.tier].tierName;
  const signer = {
    email: input.signer.email.trim(),
    name: input.signer.name.trim(),
    recipientId: "1",
    routingOrder: "1",
    tabs: {
      // The acceptance field leaves blank lines above "Signature:"; the
      // signature sits in them, the date prints on its own anchor.
      signHereTabs: [
        strictAnchorTab(SUBSCRIPTION_ANCHORS.clientSignature, "-30", { scaleValue: "0.7" }),
      ],
      dateSignedTabs: [
        strictAnchorTab(SUBSCRIPTION_ANCHORS.clientDate, "-2", {
          font: "Helvetica",
          fontSize: "Size10",
        }),
      ],
    },
  };
  const recipients: Record<string, unknown> = { signers: [signer] };
  if (input.carbonCopy) {
    recipients.carbonCopies = [
      {
        email: input.carbonCopy.email.trim(),
        name: input.carbonCopy.name?.trim() || "Aurixa Systems",
        recipientId: "2",
        routingOrder: "2",
      },
    ];
  }
  const correction = input.correctionRoute.trim();
  return {
    emailSubject: envelopeSubject(input.title),
    emailBlurb:
      `Dear ${signer.name},\n\n` +
      `Aurixa Systems has issued the attached ${tierName} Subscription Agreement for ` +
      `${input.customerLegalName.trim()} (offer ${input.offerReference}). Please review the complete ` +
      `offer and its schedules before you sign.\n\n` +
      (correction
        ? `If anything in the offer is not right, please do not sign — contact ${correction} and we will issue a corrected offer.\n\n`
        : "") +
      `Kind regards,\nAurixa Systems`,
    documents: [
      {
        documentBase64: input.documentBase64,
        name: issuedDocumentName(input.tier, input.offerReference),
        fileExtension: "docx",
        documentId: "1",
      },
    ],
    recipients,
    customFields: {
      textCustomFields: [
        {
          name: AGREEMENT_ID_CUSTOM_FIELD,
          value: input.agreementId,
          show: "false",
          required: "false",
        },
        {
          name: OFFER_REFERENCE_CUSTOM_FIELD,
          value: input.offerReference,
          show: "false",
          required: "false",
        },
      ],
    },
    status: "sent",
  };
}

/* ───────────────────────────── the snapshot ───────────────────────────── */

export type IssuedSnapshot = {
  schema: 1;
  offerReference: string;
  issuedAt: string;
  tier: SubscriptionTierSlug;
  template: { id: string; version: string; path: string; sha256: string };
  document: {
    name: string;
    /** SHA-256 of the exact .docx bytes DocuSign received. */
    sha256: string;
    bytes: number;
    /**
     * SHA-256 of the completed `word/document.xml`. Unlike the package bytes
     * (whose compression is the runtime's), this depends only on the offer
     * and the template, so a re-issue of the same snapshot can be proved to
     * say the same thing.
     */
    documentXmlSha256: string;
  };
  signer: { name: string; email: string };
  carbonCopy: string | null;
  rateCard: RateCard;
  /** Every Order field as the document prints it. */
  fields: Record<string, string>;
  lines: Array<{
    key: string;
    label: string;
    quantity: number;
    unitCents: number;
    discountCents: number;
    monthlyCents: number;
    committed: boolean;
  }>;
  totals: ComposedOffer["totals"];
  dates: {
    activation: string;
    anchorDay: number;
    nextRenewal: string;
    firstCycleEnd: string;
    commitmentAnniversary: string | null;
    commitmentLastDay: string | null;
  } | null;
  warnings: string[];
};

export function buildIssuedSnapshot(input: {
  offerReference: string;
  issuedAt: string;
  tier: SubscriptionTierSlug;
  composed: ComposedOffer;
  rateCard: RateCard;
  document: IssuedSnapshot["document"];
  signer: { name: string; email: string };
  carbonCopy: string | null;
}): IssuedSnapshot {
  const t = SUBSCRIPTION_TEMPLATES[input.tier];
  const fields: Record<string, string> = {};
  for (const tag of SUBSCRIPTION_FIELD_TAGS)
    fields[tag] = fieldValueText(input.composed.fields[tag]);
  const d = input.composed.dates;
  return {
    schema: 1,
    offerReference: input.offerReference,
    issuedAt: input.issuedAt,
    tier: input.tier,
    template: { id: t.id, version: t.version, path: t.path, sha256: t.sha256 },
    document: input.document,
    signer: { name: input.signer.name.trim(), email: input.signer.email.trim() },
    carbonCopy: input.carbonCopy,
    rateCard: { rows: input.rateCard.rows.map((r) => ({ ...r })), version: input.rateCard.version },
    fields,
    lines: input.composed.lines.map((l) => ({
      key: l.key,
      label: l.label,
      quantity: l.quantity,
      unitCents: l.unitCents,
      discountCents: l.discountCents,
      monthlyCents: l.monthlyCents,
      committed: l.committed,
    })),
    totals: input.composed.totals,
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
    warnings: [...input.composed.warnings],
  };
}

/* ───────────────────────────── issuing mechanics ───────────────────────────── */

/**
 * The calendar day an offer is issued on, in Sydney. The agreement is an
 * Australian document and its dates are Australian dates: a Worker's clock is
 * UTC, and a morning send in Sydney is the previous day there.
 */
export function issuingDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The completed document's properties. A preview says what it is in the
 * title a file browser shows, before anyone opens it — the same reason its
 * acceptance field does.
 */
export function issuedDocumentMeta(input: {
  tier: SubscriptionTierSlug;
  offerReference: string;
  customerLegalName: string;
  issuedAt: string;
  preview: boolean;
}): IssuedDocumentMeta {
  const t = SUBSCRIPTION_TEMPLATES[input.tier];
  const title = offerTitle(input.tier, input.customerLegalName);
  return {
    title: input.preview ? `PREVIEW — ${title}` : title,
    subject: `${t.tierName} Subscription Agreement offer ${input.offerReference}`,
    keywords: `Aurixa Systems, ${t.tierName}, Subscription Agreement, ${input.offerReference}`,
    description: input.preview
      ? "Internal review copy — not an offer. The issued offer is sent through DocuSign."
      : `Offer ${input.offerReference}, issued by Aurixa Systems Pty Ltd from template ${t.id} (${t.version}).`,
    issuedAt: input.issuedAt,
  };
}

/**
 * How long a send may hold its claim before another press may take it over.
 * Generous: completing and uploading a ~3 MB document is seconds, and taking
 * a claim over always asks DocuSign first whether the envelope exists.
 */
export const STALE_SEND_CLAIM_MS = 10 * 60_000;

export type SendClaimState =
  /** Never issued: the send may claim it. */
  | "unclaimed"
  /** An envelope is recorded: this offer has been sent. */
  | "sent"
  /** Another send holds the claim and may still be running. */
  | "in_flight"
  /** A claim was left behind by a send that never finished recording. */
  | "stale";

export function sendClaimState(
  row: { issued_at: string | null; docusign_envelope_id: string | null },
  now: number,
): SendClaimState {
  if (row.docusign_envelope_id) return "sent";
  if (!row.issued_at) return "unclaimed";
  const at = Date.parse(row.issued_at);
  if (!Number.isFinite(at)) return "stale";
  return now - at >= STALE_SEND_CLAIM_MS ? "stale" : "in_flight";
}

/**
 * From DocuSign's envelope search, the envelope a lost send created, if any.
 * Voided envelopes are passed over: one is an offer the operator withdrew,
 * not the one being recovered. The latest remaining one wins.
 */
export function pickRecoveredEnvelope(
  body: unknown,
): { envelopeId: string; status: string; sentDateTime: string | null } | null {
  const envelopes = (body as { envelopes?: unknown })?.envelopes;
  if (!Array.isArray(envelopes)) return null;
  const candidates = envelopes
    .map(
      (e) =>
        e as {
          envelopeId?: unknown;
          status?: unknown;
          sentDateTime?: unknown;
          createdDateTime?: unknown;
        },
    )
    .filter(
      (
        e,
      ): e is {
        envelopeId: string;
        status: string;
        sentDateTime?: unknown;
        createdDateTime?: unknown;
      } =>
        typeof e.envelopeId === "string" &&
        e.envelopeId.length > 0 &&
        typeof e.status === "string" &&
        e.status.toLowerCase() !== "voided",
    )
    .map((e) => ({
      envelopeId: e.envelopeId,
      status: e.status,
      sentDateTime: typeof e.sentDateTime === "string" ? e.sentDateTime : null,
      at: Date.parse(
        typeof e.sentDateTime === "string"
          ? e.sentDateTime
          : typeof e.createdDateTime === "string"
            ? e.createdDateTime
            : "",
      ),
    }))
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0));
  const pick = candidates[0];
  return pick
    ? { envelopeId: pick.envelopeId, status: pick.status, sentDateTime: pick.sentDateTime }
    : null;
}

/** A PDF starts with its own signature; anything else is not the signed record. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/* ───────────────────────────── the agreement row ───────────────────────────── */

/**
 * What a signature on this offer entitles, in provisioning's vocabulary: the
 * tier's plan, and every catalogue module the offer sells on top of it.
 *
 * That is two sets, not one. The purchased lines, obviously — but also any
 * module the AGREEMENT includes at this tier that the catalogue does not
 * bundle with the plan. The Growth agreement prints Market News Feed as
 * "Included; no separate access fee" while the deployed entitlement gate
 * bundles `market-updates` only at Scale; the agreement is what the customer
 * signs, so a Growth signature provisions it as an add-on rather than leaving
 * the customer without something their contract includes. Seats are capacity,
 * not a module, and do not appear here.
 */
export function provisioningSelectionFromOffer(offer: SubscriptionOffer): {
  planSlug: SubscriptionTierSlug;
  addonSlugs: string[];
} {
  const slugs = new Set<string>();
  for (const key of A3_INCLUDED[offer.tier]) {
    const item = a3Item(key);
    if (!item?.catalogSlug) continue;
    const bundled =
      MODULES.find((m) => m.slug === item.catalogSlug)?.includedIn.includes(offer.tier) ?? false;
    if (!bundled) slugs.add(item.catalogSlug);
  }
  for (const line of offer.addons) {
    const item = a3Item(line.itemKey);
    if (item?.kind !== "module" || !item.catalogSlug) continue;
    if (isIncludedInTier(offer.tier, item.key)) continue;
    slugs.add(item.catalogSlug);
  }
  return { planSlug: offer.tier, addonSlugs: [...slugs].sort() };
}

/** Whether an agreement row's plan and add-ons are exactly an offer's selection. */
export function selectionMatches(
  row: { plan_slug: string | null; addon_slugs: readonly string[] | null },
  selection: { planSlug: string; addonSlugs: readonly string[] },
): boolean {
  if (row.plan_slug !== selection.planSlug) return false;
  const have = [...new Set(row.addon_slugs ?? [])].sort();
  const want = [...new Set(selection.addonSlugs)].sort();
  return have.length === want.length && have.every((s, i) => s === want[i]);
}

/**
 * The agreement row's own columns, as the offer states them. The list, the
 * CRM timeline, the notifications and provisioning all read these rather
 * than the offer, so they follow it on every save and at the send — the plan
 * and add-ons included, because what a signature provisions is what the offer
 * sold.
 *
 * `client_name` and `client_email` are NOT NULL on the row and are only
 * overwritten with something real: while the offer is still being prepared a
 * blank signatory keeps whatever the row already holds (the lead it was raised
 * from), and at the send the signatory is always complete — the composer will
 * not issue an offer without one.
 */
export function agreementColumnsFromOffer(offer: SubscriptionOffer): {
  client_name?: string;
  client_email?: string;
  client_org: string | null;
  service_tier: string;
  commencement_date: string | null;
  plan_slug: SubscriptionTierSlug;
  addon_slugs: string[];
} {
  const legalName = offer.customer.legalName.trim();
  const name = offer.signatory.name.trim() || legalName;
  const email = offer.signatory.email.trim();
  const selection = provisioningSelectionFromOffer(offer);
  return {
    ...(name ? { client_name: name } : {}),
    ...(email ? { client_email: email } : {}),
    client_org: legalName || null,
    service_tier: SUBSCRIPTION_TEMPLATES[offer.tier].tierName,
    commencement_date: parseIsoDate(offer.activationDate) ? offer.activationDate : null,
    plan_slug: selection.planSlug,
    addon_slugs: selection.addonSlugs,
  };
}
