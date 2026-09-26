import { describe, expect, it } from "vitest";
import {
  ADDITIONAL_LINE_LABELS,
  communicationsInScope,
  composedView,
  dollarsInputText,
  gapCountsBySection,
  gapsByInput,
  inputOfGap,
  issuingProfileGaps,
  OFFER_SECTIONS,
  parseDollars,
  readIssuedSnapshot,
  reviewRows,
  sectionOfGap,
  serviceMatchesProfile,
  SERVICE_FIELDS,
  snapshotView,
  tierSummary,
  USAGE_FIELDS,
  withProfileService,
  withProfileUsage,
} from "./offerEditor.pure";
import { COMPLETE_PROFILE, RATE_CARD, completeOffer } from "./subscriptionFixtures";
import {
  ADDITIONAL_LINE_TAGS,
  composeSubscriptionOffer,
  issuingProfileSchema,
  newSubscriptionOffer,
  serviceDisclosureSchema,
  SUBSCRIPTION_FIELD_TAGS,
  usageAuthoritySchema,
} from "./subscriptionOffer.pure";
import { buildIssuedSnapshot } from "./subscriptionIssue.pure";
import { SUBSCRIPTION_TIER_SLUGS } from "./subscriptionTemplates";

const compose = (offer = completeOffer()) =>
  composeSubscriptionOffer(offer, {
    offerReference: "AUR-SA-20260925-ABCDEF",
    rateCard: RATE_CARD,
    today: "2026-09-25",
  });

describe("where a gap belongs", () => {
  it("places every gap an empty offer raises in a section, and most beside an input", () => {
    const empty = newSubscriptionOffer("scale", issuingProfileSchema.parse({}));
    const { gaps } = composeSubscriptionOffer(empty, {
      offerReference: "AUR-SA-20260925-ABCDEF",
      rateCard: null,
    });
    expect(gaps.length).toBeGreaterThan(20);
    const sections = new Set(OFFER_SECTIONS.map((s) => s.id));
    for (const g of gaps) expect(sections.has(sectionOfGap(g.key))).toBe(true);
    const counts = gapCountsBySection(gaps);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(gaps.length);
    expect(counts.customer).toBeGreaterThan(0);
    expect(counts.signatory).toBe(3);
    expect(counts.service).toBe(SERVICE_FIELDS.length);
    expect(counts.usage).toBeGreaterThan(0); // the rate card, and the A4 rows
    expect(sectionOfGap("rateCard")).toBe("usage");
  });

  it("reads a document field's backstop gap as the input the text was typed in", () => {
    expect(inputOfGap("contacts.legal")).toBe("service.legalContact");
    expect(inputOfGap("usage.api_storage_basis_payer_cap")).toBe("usage.apiBasis");
    expect(inputOfGap("customer.legal_name")).toBe("customer.legalName");
    expect(sectionOfGap("contacts.support")).toBe("service");
    expect(sectionOfGap("order.special_conditions_summary")).toBe("departures");
    // An offer path is its own input.
    expect(inputOfGap("customer.identifier")).toBe("customer.identifier");
    expect(sectionOfGap("addons.3")).toBe("purchases");
    expect(sectionOfGap("oneOffCharges.0")).toBe("charges");
    expect(sectionOfGap("activationDate")).toBe("order");
    expect(sectionOfGap("something.new")).toBe("order");
  });

  it("maps every single-input field tag to a real offer path", () => {
    const offer = completeOffer();
    for (const tag of SUBSCRIPTION_FIELD_TAGS) {
      const input = inputOfGap(tag);
      if (input === tag) continue;
      const [head, tail] = input.split(".");
      const value = tail
        ? (offer as unknown as Record<string, Record<string, unknown>>)[head]?.[tail]
        : (offer as unknown as Record<string, unknown>)[head];
      expect(typeof value, `${tag} → ${input}`).toBe("string");
    }
  });

  it("groups a bracket gap and its input's own gap on the same input", () => {
    const offer = completeOffer("growth", (o) => {
      o.customer.legalName = "[Customer]";
    });
    const byInput = gapsByInput(compose(offer).gaps);
    expect(byInput.get("customer.legalName")?.join(" ")).toMatch(/square brackets/);
  });
});

describe("the issuing profile", () => {
  it("names every missing fact of an empty profile, weighed by what it costs", () => {
    const gaps = issuingProfileGaps(issuingProfileSchema.parse({}));
    const required = gaps.filter((g) => g.weight === "required").map((g) => g.key);
    for (const f of SERVICE_FIELDS) expect(required).toContain(`service.${f.key}`);
    expect(required).toEqual(
      expect.arrayContaining([
        "usage.apiAllowance",
        "usage.apiBasis",
        "usage.amlAllowance",
        "usage.amlBasis",
      ]),
    );
    expect(gaps.filter((g) => g.weight === "conditional").map((g) => g.key)).toEqual([
      "usage.commsAllowance",
      "usage.commsBasis",
    ]);
    expect(gaps.find((g) => g.key === "defaultPaymentMethod")?.weight).toBe("recommended");
    // The zero-authority defaults cover these; the profile need not state them.
    expect(gaps.map((g) => g.key)).not.toContain("usage.variableAllowance");
    expect(gaps.map((g) => g.key)).not.toContain("usage.buffer");
  });

  it("finds nothing missing in a complete profile", () => {
    expect(issuingProfileGaps(COMPLETE_PROFILE)).toEqual([]);
  });

  it("lists every schema field exactly once", () => {
    expect(SERVICE_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(serviceDisclosureSchema.shape).sort(),
    );
    expect(USAGE_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(usageAuthoritySchema.shape).sort(),
    );
  });

  it("stops each input where the schema would refuse it", () => {
    type Shape = Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    const pairs: Array<[ReadonlyArray<{ key: string; max: number }>, Shape]> = [
      [SERVICE_FIELDS, serviceDisclosureSchema.shape],
      [USAGE_FIELDS, usageAuthoritySchema.shape],
    ];
    for (const [fields, shape] of pairs) {
      for (const f of fields) {
        expect(shape[f.key].safeParse("x".repeat(f.max)).success, f.key).toBe(true);
        expect(shape[f.key].safeParse("x".repeat(f.max + 1)).success, f.key).toBe(false);
      }
    }
  });

  it("tells an offer prepared from an older profile apart, and applies the current one", () => {
    const offer = completeOffer();
    expect(serviceMatchesProfile(offer, COMPLETE_PROFILE)).toBe(true);
    const moved = issuingProfileSchema.parse({
      ...COMPLETE_PROFILE,
      service: { ...COMPLETE_PROFILE.service, correctionRoute: "corrections@aurixa.test" },
    });
    expect(serviceMatchesProfile(offer, moved)).toBe(false);
    const applied = withProfileService(offer, moved);
    expect(applied.service.correctionRoute).toBe("corrections@aurixa.test");
    expect(applied.customer).toEqual(offer.customer);
    expect(serviceMatchesProfile(applied, moved)).toBe(true);
  });

  it("resets the authorities to the profile's, with the zero defaults where it is silent", () => {
    const offer = completeOffer("growth", (o) => {
      o.usage.apiBasis = "Negotiated: $0.02 per call, customer pays, cap $50";
      o.usage.variableAllowance = "";
    });
    const reset = withProfileUsage(offer, COMPLETE_PROFILE);
    expect(reset.usage.apiBasis).toBe(COMPLETE_PROFILE.usage.apiBasis);
    expect(reset.usage.variableAllowance).toMatch(/included Subscription Tokens/);
    expect(reset.usage.buffer).toBe("Zero");
  });
});

describe("money as it is typed", () => {
  it("reads dollars to cents", () => {
    expect(parseDollars("")).toBe(0);
    expect(parseDollars("  ")).toBe(0);
    expect(parseDollars("99")).toBe(9900);
    expect(parseDollars("$1,234.56")).toBe(123456);
    expect(parseDollars("49.5")).toBe(4950);
    expect(parseDollars("0.05")).toBe(5);
  });

  it("refuses what it cannot read exactly rather than rounding it", () => {
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(parseDollars("ten")).toBeNull();
    expect(parseDollars("1e3")).toBeNull();
  });

  it("round-trips through the input's text", () => {
    for (const cents of [0, 5, 4950, 9900, 123456, 100_000_000]) {
      expect(parseDollars(dollarsInputText(cents))).toBe(cents);
    }
    expect(dollarsInputText(0)).toBe("");
    expect(dollarsInputText(4950)).toBe("49.50");
  });
});

describe("tiers and scope", () => {
  it("summarises each tier from the template and the catalogue", () => {
    for (const tier of SUBSCRIPTION_TIER_SLUGS) {
      const s = tierSummary(tier);
      expect(s.withAmlCents).toBeGreaterThan(s.withoutAmlCents);
      expect(s.tokens).toBeGreaterThan(0);
      expect(s.includedSeats).toBeGreaterThan(0);
    }
    expect(tierSummary("launch").included).toEqual([]);
    expect(tierSummary("growth").included).toContain("Market News Feed");
  });

  it("knows when the communications authorities are owed", () => {
    expect(communicationsInScope(completeOffer("launch"))).toBe(false);
    // Scale includes Marketing, which sends email and SMS.
    expect(communicationsInScope(completeOffer("scale"))).toBe(true);
    expect(
      communicationsInScope(
        completeOffer("launch", (o) => {
          o.addons = [
            {
              id: "l1",
              itemKey: "email-copilot",
              quantity: 1,
              discountMonthlyCents: 0,
              term: "flexible",
              purchaser: "",
              scope: "",
              usageAndCosts: "",
              permissions: "",
            },
          ];
        }),
      ),
    ).toBe(true);
  });
});

describe("one view of an offer", () => {
  it("renders a live composition and its issued snapshot identically", () => {
    const composed = compose();
    expect(composed.gaps).toEqual([]);
    const live = composedView(composed);
    const snapshot = buildIssuedSnapshot({
      offerReference: "AUR-SA-20260925-ABCDEF",
      issuedAt: "2026-09-25T00:00:00.000Z",
      tier: "growth",
      composed,
      rateCard: RATE_CARD,
      document: { name: "x.docx", sha256: "a", bytes: 1, documentXmlSha256: "b" },
      signer: { name: "Alex Example", email: "alex@customer.test" },
      carbonCopy: null,
    });
    const issued = snapshotView(snapshot, live.records);
    expect(issued.fields).toEqual(live.fields);
    expect(issued.lines).toEqual(live.lines);
    expect(issued.totals).toEqual(live.totals);
    expect(issued.dates).toEqual(live.dates);
    expect(issued.records).toEqual(live.records);
    expect(issued.gaps).toEqual([]);
    expect(reviewRows(live)).toHaveLength(SUBSCRIPTION_FIELD_TAGS.length);
    expect(readIssuedSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("labels every Schedule A4 record row", () => {
    expect(Object.keys(ADDITIONAL_LINE_LABELS).sort()).toEqual([...ADDITIONAL_LINE_TAGS].sort());
  });

  it("does not read something that is not a snapshot as one", () => {
    expect(readIssuedSnapshot(null)).toBeNull();
    expect(readIssuedSnapshot({})).toBeNull();
    expect(readIssuedSnapshot({ schema: 2, issuedAt: "x", fields: {}, totals: {} })).toBeNull();
    expect(readIssuedSnapshot("snapshot")).toBeNull();
  });
});
