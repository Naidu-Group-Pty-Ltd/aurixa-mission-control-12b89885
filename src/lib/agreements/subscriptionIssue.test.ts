import { describe, expect, it } from "vitest";
import { completeOffer, RATE_CARD } from "./subscriptionFixtures";
import {
  AGREEMENT_ID_CUSTOM_FIELD,
  agreementColumnsFromOffer,
  buildIssuedSnapshot,
  buildSubscriptionEnvelopeDefinition,
  DOCUSIGN_SUBJECT_MAX,
  envelopeSubject,
  issuedDocumentMeta,
  issuedDocumentName,
  issuingDay,
  looksLikePdf,
  OFFER_REFERENCE_CUSTOM_FIELD,
  pickRecoveredEnvelope,
  previewDocumentName,
  provisioningSelectionFromOffer,
  selectionMatches,
  sendClaimState,
  signedRecordPath,
  STALE_SEND_CLAIM_MS,
  type SubscriptionEnvelopeInput,
} from "./subscriptionIssue.pure";
import {
  composeSubscriptionOffer,
  fieldValueText,
  issuingProfileSchema,
  newSubscriptionOffer,
  offerTitle,
  PREVIEW_ACCEPTANCE_NOTICE,
  SUBSCRIPTION_FIELD_TAGS,
  type AddonLine,
} from "./subscriptionOffer.pure";
import { SUBSCRIPTION_ANCHORS, SUBSCRIPTION_TEMPLATES } from "./subscriptionTemplates";

const REFERENCE = "AUR-SA-20260925-ABCDEF";

const INPUT: SubscriptionEnvelopeInput = {
  agreementId: "0b7f4c1e-5d2a-4e8b-9c3f-1a2b3c4d5e6f",
  offerReference: REFERENCE,
  tier: "growth",
  title: offerTitle("growth", "Example Property Advisory Pty Ltd"),
  documentBase64: "UEsDBA==",
  signer: { name: " Alex Example ", email: " alex@customer.test " },
  customerLegalName: "Example Property Advisory Pty Ltd",
  correctionRoute: "offers@aurixa.test",
  carbonCopy: { name: null, email: "contracts@aurixa.test" },
};

type Tab = Record<string, string>;
type Signer = { email: string; name: string; recipientId: string; tabs: Record<string, Tab[]> };
type Definition = {
  emailSubject: string;
  emailBlurb: string;
  documents: Array<Record<string, string>>;
  recipients: { signers: Signer[]; carbonCopies?: Array<Record<string, string>> };
  customFields: { textCustomFields: Array<Record<string, string>> };
  status: string;
};

const build = (patch: Partial<SubscriptionEnvelopeInput> = {}) =>
  buildSubscriptionEnvelopeDefinition({ ...INPUT, ...patch }) as unknown as Definition;

describe("the subscription envelope", () => {
  it("has exactly one signer — the representative — with strict tabs on the two anchors", () => {
    const def = build();
    expect(def.recipients.signers).toHaveLength(1);
    const [signer] = def.recipients.signers;
    expect(signer.email).toBe("alex@customer.test");
    expect(signer.name).toBe("Alex Example");
    expect(signer.recipientId).toBe("1");
    expect(Object.keys(signer.tabs).sort()).toEqual(["dateSignedTabs", "signHereTabs"]);
    expect(signer.tabs.signHereTabs).toHaveLength(1);
    expect(signer.tabs.signHereTabs[0].anchorString).toBe(SUBSCRIPTION_ANCHORS.clientSignature);
    expect(signer.tabs.dateSignedTabs).toHaveLength(1);
    expect(signer.tabs.dateSignedTabs[0].anchorString).toBe(SUBSCRIPTION_ANCHORS.clientDate);
    for (const tab of [...signer.tabs.signHereTabs, ...signer.tabs.dateSignedTabs]) {
      // A missing anchor must make DocuSign refuse the envelope, not send one
      // with nowhere to sign.
      expect(tab.anchorIgnoreIfNotPresent).toBe("false");
      expect(tab.anchorCaseSensitive).toBe("true");
    }
    expect(def.status).toBe("sent");
  });

  it("copies Aurixa's countersigner rather than asking them to sign (clause 1.2)", () => {
    const def = build();
    expect(def.recipients.carbonCopies).toEqual([
      {
        email: "contracts@aurixa.test",
        name: "Aurixa Systems",
        recipientId: "2",
        routingOrder: "2",
      },
    ]);
    const named = build({ carbonCopy: { name: " Jo Contracts ", email: "jo@aurixa.test" } });
    expect(named.recipients.carbonCopies?.[0].name).toBe("Jo Contracts");
    expect(build({ carbonCopy: null }).recipients.carbonCopies).toBeUndefined();
  });

  it("sends the completed .docx under a name that says which offer it is", () => {
    const [document] = build().documents;
    expect(document.fileExtension).toBe("docx");
    expect(document.documentId).toBe("1");
    expect(document.documentBase64).toBe("UEsDBA==");
    expect(document.name).toBe(issuedDocumentName("growth", REFERENCE));
    expect(document.name).toBe(`Aurixa Growth Subscription Agreement ${REFERENCE}.docx`);
  });

  it("carries the agreement id and offer reference as hidden custom fields", () => {
    const fields = build().customFields.textCustomFields;
    expect(fields).toEqual([
      {
        name: AGREEMENT_ID_CUSTOM_FIELD,
        value: INPUT.agreementId,
        show: "false",
        required: "false",
      },
      { name: OFFER_REFERENCE_CUSTOM_FIELD, value: REFERENCE, show: "false", required: "false" },
    ]);
  });

  it("names the tier, customer, offer and correction route in the invitation", () => {
    const { emailBlurb, emailSubject } = build();
    expect(emailSubject).toBe(INPUT.title);
    expect(emailBlurb).toContain("Dear Alex Example,");
    expect(emailBlurb).toContain("Growth Subscription Agreement");
    expect(emailBlurb).toContain("Example Property Advisory Pty Ltd");
    expect(emailBlurb).toContain(REFERENCE);
    expect(emailBlurb).toContain("please do not sign — contact offers@aurixa.test");
    expect(build({ correctionRoute: "  " }).emailBlurb).not.toContain("do not sign");
  });
});

describe("envelopeSubject", () => {
  it("keeps a subject within DocuSign's limit", () => {
    expect(envelopeSubject("  Aurixa   Systems\nLaunch  ")).toBe("Aurixa Systems Launch");
    const long = envelopeSubject(offerTitle("scale", "A".repeat(200)));
    expect(long.length).toBeLessThanOrEqual(DOCUSIGN_SUBJECT_MAX);
    expect(long.endsWith("…")).toBe(true);
    const exact = "x".repeat(DOCUSIGN_SUBJECT_MAX);
    expect(envelopeSubject(exact)).toBe(exact);
  });
});

describe("names and paths", () => {
  it("marks a preview in its file name", () => {
    expect(previewDocumentName("launch", REFERENCE)).toBe(
      `PREVIEW - Aurixa Launch Subscription Agreement ${REFERENCE}.docx`,
    );
  });

  it("files the signed record by agreement and envelope, and nothing else", () => {
    expect(signedRecordPath("abc-123", "ENV-9f")).toBe("subscription/abc-123/ENV-9f-signed.pdf");
    expect(signedRecordPath("../../etc", "a/b c")).toBe("subscription/etc/abc-signed.pdf");
  });
});

describe("the issued snapshot", () => {
  const offer = completeOffer("scale", (o) => {
    o.term = "committed_monthly";
    o.extraSeats = 2;
  });
  const composed = composeSubscriptionOffer(offer, {
    offerReference: REFERENCE,
    rateCard: RATE_CARD,
    today: "2026-09-25",
  });
  const snapshot = buildIssuedSnapshot({
    offerReference: REFERENCE,
    issuedAt: "2026-09-25T03:04:05.678Z",
    tier: "scale",
    composed,
    rateCard: RATE_CARD,
    document: {
      name: issuedDocumentName("scale", REFERENCE),
      sha256: "a".repeat(64),
      bytes: 1234,
      documentXmlSha256: "b".repeat(64),
    },
    signer: { name: " Alex Example ", email: "alex@customer.test" },
    carbonCopy: "contracts@aurixa.test",
  });

  it("records every field as the document prints it", () => {
    expect(composed.gaps).toEqual([]);
    expect(Object.keys(snapshot.fields)).toEqual([...SUBSCRIPTION_FIELD_TAGS]);
    for (const tag of SUBSCRIPTION_FIELD_TAGS) {
      expect(snapshot.fields[tag]).toBe(fieldValueText(composed.fields[tag]));
    }
    expect(snapshot.fields["signatory.esign_reference"]).toContain("⟨DocuSign signature⟩");
    expect(snapshot.fields["signatory.esign_reference"]).not.toContain(PREVIEW_ACCEPTANCE_NOTICE);
  });

  it("pins the template, the rate card and the dates the offer was composed with", () => {
    const t = SUBSCRIPTION_TEMPLATES.scale;
    expect(snapshot.template).toEqual({
      id: t.id,
      version: t.version,
      path: t.path,
      sha256: t.sha256,
    });
    expect(snapshot.rateCard).toEqual(RATE_CARD);
    expect(snapshot.rateCard.rows[0]).not.toBe(RATE_CARD.rows[0]);
    expect(snapshot.dates).toEqual({
      activation: "2026-10-31",
      anchorDay: 31,
      nextRenewal: "2026-11-30",
      firstCycleEnd: "2026-11-29",
      commitmentAnniversary: "2027-10-31",
      commitmentLastDay: "2027-10-30",
    });
    expect(snapshot.totals.monthlyTotalCents).toBe(composed.totals.monthlyTotalCents);
    expect(snapshot.signer).toEqual({ name: "Alex Example", email: "alex@customer.test" });
  });

  it("keeps the line figures without the printed records, and survives JSON", () => {
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toEqual({
      key: "additional-user-seat",
      label: "Additional User Seat",
      quantity: 2,
      unitCents: composed.lines[0].unitCents,
      discountCents: 0,
      monthlyCents: composed.lines[0].monthlyCents,
      committed: false,
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("a preview composition", () => {
  it("says in the acceptance field that it is not an offer", () => {
    const offer = completeOffer("launch");
    const ctx = { offerReference: REFERENCE, rateCard: RATE_CARD };
    const issued = fieldValueText(
      composeSubscriptionOffer(offer, ctx).fields["signatory.esign_reference"],
    );
    const preview = fieldValueText(
      composeSubscriptionOffer(offer, { ...ctx, preview: true }).fields[
        "signatory.esign_reference"
      ],
    );
    expect(issued).not.toContain("PREVIEW");
    expect(preview.startsWith(PREVIEW_ACCEPTANCE_NOTICE)).toBe(true);
    expect(preview).toContain(REFERENCE);
    // The anchors stay, so a preview exercises the same issuing checks.
    expect(preview).toContain("⟨DocuSign signature⟩");
    expect(preview).toContain("⟨DocuSign date⟩");
  });
});

describe("issuing mechanics", () => {
  it("dates an offer by the Sydney calendar, not the Worker's UTC clock", () => {
    // 22:30 UTC on 24 September is 08:30 on 25 September in Sydney (AEST).
    expect(issuingDay(new Date("2026-09-24T22:30:00Z"))).toBe("2026-09-25");
    // And after daylight saving starts (4 October 2026), 13:30 UTC is 00:30 next day.
    expect(issuingDay(new Date("2026-10-10T13:30:00Z"))).toBe("2026-10-11");
    expect(issuingDay(new Date("2026-10-10T12:30:00Z"))).toBe("2026-10-10");
  });

  it("titles a preview as one, and an issued copy by its template", () => {
    const common = {
      tier: "growth" as const,
      offerReference: REFERENCE,
      customerLegalName: "Example Property Advisory Pty Ltd",
      issuedAt: "2026-09-25T03:04:05.678Z",
    };
    const issued = issuedDocumentMeta({ ...common, preview: false });
    expect(issued.title).toBe(offerTitle("growth", "Example Property Advisory Pty Ltd"));
    expect(issued.description).toContain(SUBSCRIPTION_TEMPLATES.growth.id);
    expect(issued.subject).toBe(`Growth Subscription Agreement offer ${REFERENCE}`);
    const preview = issuedDocumentMeta({ ...common, preview: true });
    expect(preview.title.startsWith("PREVIEW — ")).toBe(true);
    expect(preview.description).toMatch(/not an offer/);
  });

  it("reads a send claim as unclaimed, in flight, stale or sent", () => {
    const now = Date.parse("2026-09-25T03:00:00Z");
    expect(sendClaimState({ issued_at: null, docusign_envelope_id: null }, now)).toBe("unclaimed");
    expect(
      sendClaimState({ issued_at: "2026-09-25T02:59:00Z", docusign_envelope_id: null }, now),
    ).toBe("in_flight");
    expect(
      sendClaimState(
        {
          issued_at: new Date(now - STALE_SEND_CLAIM_MS).toISOString(),
          docusign_envelope_id: null,
        },
        now,
      ),
    ).toBe("stale");
    expect(sendClaimState({ issued_at: "not a date", docusign_envelope_id: null }, now)).toBe(
      "stale",
    );
    expect(
      sendClaimState({ issued_at: "2026-09-25T02:59:00Z", docusign_envelope_id: "env-1" }, now),
    ).toBe("sent");
  });

  it("recovers the latest live envelope from a search, never a voided one", () => {
    expect(pickRecoveredEnvelope({})).toBeNull();
    expect(pickRecoveredEnvelope({ resultSetSize: "0" })).toBeNull();
    expect(
      pickRecoveredEnvelope({ envelopes: [{ envelopeId: "old", status: "voided" }] }),
    ).toBeNull();
    expect(
      pickRecoveredEnvelope({
        envelopes: [
          { envelopeId: "a", status: "sent", sentDateTime: "2026-09-25T01:00:00Z" },
          { envelopeId: "b", status: "delivered", sentDateTime: "2026-09-25T02:00:00Z" },
          { envelopeId: "c", status: "voided", sentDateTime: "2026-09-25T03:00:00Z" },
          { status: "sent" },
        ],
      }),
    ).toEqual({ envelopeId: "b", status: "delivered", sentDateTime: "2026-09-25T02:00:00Z" });
  });

  it("recognises a PDF by its signature", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n"))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });
});

const line = (itemKey: string, patch: Partial<AddonLine> = {}): AddonLine => ({
  id: itemKey,
  itemKey,
  quantity: 1,
  discountMonthlyCents: 0,
  term: "flexible",
  purchaser: "",
  scope: "",
  usageAndCosts: "",
  permissions: "",
  ...patch,
});

describe("what a signature provisions", () => {
  it("is the tier's plan with nothing added when the catalogue bundles all the tier includes", () => {
    expect(provisioningSelectionFromOffer(completeOffer("launch"))).toEqual({
      planSlug: "launch",
      addonSlugs: [],
    });
    expect(provisioningSelectionFromOffer(completeOffer("scale"))).toEqual({
      planSlug: "scale",
      addonSlugs: [],
    });
  });

  it("provisions what the Growth agreement includes but the catalogue bundles only at Scale", () => {
    expect(provisioningSelectionFromOffer(completeOffer("growth"))).toEqual({
      planSlug: "growth",
      addonSlugs: ["market-updates"],
    });
  });

  it("adds each purchased module once, in catalogue slugs, and never a seat", () => {
    const offer = completeOffer("launch", (o) => {
      o.extraSeats = 3;
      o.addons = [line("email-copilot"), line("commercial-industrial", { quantity: 2 })];
    });
    expect(provisioningSelectionFromOffer(offer)).toEqual({
      planSlug: "launch",
      addonSlugs: ["commercial-industrial", "email-copilot"],
    });
  });

  it("ignores a line the composer would refuse, so nothing unsold is provisioned", () => {
    const offer = completeOffer("scale", (o) => {
      // Included at Scale, not for sale, an independent contract, unknown.
      o.addons = [
        line("marketing"),
        line("lenders"),
        line("builder-developer-portal"),
        line("not-a-real-item"),
      ];
    });
    expect(provisioningSelectionFromOffer(offer).addonSlugs).toEqual([]);
  });

  it("compares a row's selection as sets", () => {
    const selection = { planSlug: "growth", addonSlugs: ["market-updates", "email-copilot"] };
    expect(
      selectionMatches(
        { plan_slug: "growth", addon_slugs: ["email-copilot", "market-updates"] },
        selection,
      ),
    ).toBe(true);
    expect(
      selectionMatches({ plan_slug: "growth", addon_slugs: ["market-updates"] }, selection),
    ).toBe(false);
    expect(
      selectionMatches(
        { plan_slug: "scale", addon_slugs: ["market-updates", "email-copilot"] },
        selection,
      ),
    ).toBe(false);
    expect(
      selectionMatches(
        { plan_slug: "launch", addon_slugs: null },
        { planSlug: "launch", addonSlugs: [] },
      ),
    ).toBe(true);
  });
});

describe("the agreement row's columns", () => {
  it("follow a complete offer", () => {
    expect(agreementColumnsFromOffer(completeOffer("growth"))).toEqual({
      client_name: "Alex Example",
      client_email: "alex@customer.test",
      client_org: "Example Property Advisory Pty Ltd",
      service_tier: "Growth",
      commencement_date: "2026-10-31",
      plan_slug: "growth",
      addon_slugs: ["market-updates"],
    });
  });

  it("never overwrite the row's name or email with a blank", () => {
    const blank = newSubscriptionOffer("scale", issuingProfileSchema.parse({}));
    const cols = agreementColumnsFromOffer(blank);
    expect(cols).not.toHaveProperty("client_name");
    expect(cols).not.toHaveProperty("client_email");
    expect(cols.client_org).toBeNull();
    expect(cols.commencement_date).toBeNull();
    expect(cols.plan_slug).toBe("scale");
  });

  it("name the customer when no representative is named yet, and ignore an impossible date", () => {
    const offer = completeOffer("launch", (o) => {
      o.signatory.name = "  ";
      o.signatory.email = "";
      o.activationDate = "2026-02-30";
    });
    const cols = agreementColumnsFromOffer(offer);
    expect(cols.client_name).toBe("Example Property Advisory Pty Ltd");
    expect(cols).not.toHaveProperty("client_email");
    expect(cols.commencement_date).toBeNull();
  });
});
