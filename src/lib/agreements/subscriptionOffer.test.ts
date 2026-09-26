import { describe, expect, it } from "vitest";
import { COMPLETE_PROFILE, completeOffer, EXAMPLE_ACN, RATE_CARD } from "./subscriptionFixtures";
import {
  ADDITIONAL_LINES_TAG,
  composeSubscriptionOffer,
  fieldValueText,
  IncompleteOfferError,
  issuingProfileSchema,
  newOfferReference,
  newSubscriptionOffer,
  NO_ADDITIONAL_PURCHASES,
  offerTitle,
  SUBSCRIPTION_FIELD_TAGS,
  toDocumentFill,
  type ComposeContext,
  type SubscriptionOffer,
} from "./subscriptionOffer.pure";
import { SUBSCRIPTION_ANCHORS } from "./subscriptionTemplates";

const CTX: ComposeContext = {
  offerReference: "AUR-SA-20260925-ABCDEF",
  rateCard: RATE_CARD,
  today: "2026-09-25",
};

const compose = (offer: SubscriptionOffer, ctx: Partial<ComposeContext> = {}) =>
  composeSubscriptionOffer(offer, { ...CTX, ...ctx });

const gapKeys = (offer: SubscriptionOffer, ctx: Partial<ComposeContext> = {}) =>
  compose(offer, ctx).gaps.map((g) => g.key);

describe("a new offer", () => {
  it("copies the issuing profile and fills only zero-authority defaults", () => {
    const offer = newSubscriptionOffer("launch", issuingProfileSchema.parse({}));
    expect(offer.tier).toBe("launch");
    expect(offer.aml).toBe("with");
    expect(offer.term).toBe("flexible");
    expect(offer.usage.variableBasis).toMatch(/period cap \$0\.00/);
    expect(offer.usage.buffer).toBe("Zero");
    expect(offer.usage.amlAllowance).toBe("");

    const seeded = newSubscriptionOffer("scale", COMPLETE_PROFILE);
    expect(seeded.service).toEqual(COMPLETE_PROFILE.service);
    expect(seeded.usage.apiAllowance).toBe(COMPLETE_PROFILE.usage.apiAllowance);
    expect(seeded.paymentMethod).toBe("Card through Stripe");
  });

  it("names every missing input, and the unread rate card", () => {
    const offer = newSubscriptionOffer("launch", issuingProfileSchema.parse({}));
    const keys = gapKeys(offer, { rateCard: null });
    for (const key of [
      "customer.legalName",
      "customer.identifier",
      "customer.address",
      "customer.noticeEmail",
      "signatory.name",
      "signatory.role",
      "signatory.email",
      "activationDate",
      "paymentMethod",
      "usage.apiAllowance",
      "usage.amlAllowance",
      "service.serviceProfile",
      "service.correctionRoute",
      "rateCard",
    ]) {
      expect(keys, key).toContain(key);
    }
  });
});

describe("a complete Growth offer, flexible, with AML", () => {
  const offer = completeOffer("growth");
  const composed = compose(offer);

  it("has no gaps and fills every field", () => {
    expect(composed.gaps).toEqual([]);
    for (const tag of SUBSCRIPTION_FIELD_TAGS) {
      expect(fieldValueText(composed.fields[tag]).trim(), tag).not.toBe("");
    }
  });

  it("prices the standard base with nothing fixed beyond the first payment", () => {
    expect(composed.totals.monthlyTotalCents).toBe(139_900);
    expect(composed.totals.monthlyGstCents).toBe(12_718);
    expect(composed.totals.minimumFixedCents).toBe(139_900);
    expect(composed.totals.postTermMonthlyCents).toBeNull();
    expect(composed.fields).toMatchObject({
      "price.headline_amount": "$1,399.00",
      "price.headline_basis":
        "per month, incl. GST, monthly in advance · $1,399.00 due at activation",
      "price.base_summary":
        "Standard Growth base (With AML) $1,399.00; no commitment discount on a flexible term; net base $1,399.00 per month",
      "price.recurring_extras": "None",
      "price.total_monthly_incl_gst": "$1,399.00 per month, including GST of $127.18",
      "price.activation_charges":
        "First payment $1,399.00; no one-off charges; total due at activation $1,399.00",
      "price.minimum_fixed_commitment":
        "No fixed term. Minimum: the first monthly payment of $1,399.00; total $1,399.00.",
      "price.post_term_summary": "N/A — flexible month-to-month term",
      "customer.identifier": "ABN 51 824 753 556",
      "customer.billing_contact": "Same as legal notices",
      "order.special_conditions_summary": "None",
    });
  });

  it("states the service dates from the activation date (clause 5.3)", () => {
    expect(composed.fields["order.start_and_renewal"]).toBe(
      "Activation 31 October 2026 — if paid activation is recorded on another date, every date here moves with it (clause 5.3). " +
        "Renews monthly on the 31st (the last day of any shorter month); next renewal 30 November 2026. No commitment end.",
    );
    expect(composed.fields["credits.cycle_display"]).toBe(
      "35,000 Subscription Tokens granted at paid activation for the first Billing Cycle (31 October 2026 to 29 November 2026); " +
        "the next grant is on 30 November 2026, then each monthly cycle — including when the base is prepaid",
    );
    expect(composed.fields["seats.summary"]).toBe(
      "15 included + 0 purchased = 15 named internal users; approved capacity 15",
    );
  });

  it("prints the live rate card with its version", () => {
    expect(composed.fields["usage.report_slugs_and_credit_costs"]).toBe(
      "Investment report 1,200 tokens; 10-year cash flow 400 tokens; Report comparison 1 token. Rate-card version rc-2026-09-25.",
    );
  });

  it("authorises no communications spend when nothing enables it", () => {
    expect(composed.fields["usage.communications_allowance_or_disabled"]).toMatch(/^Not selected/);
    expect(composed.fields["usage.communications_basis_payer_cap"]).toMatch(/period cap \$0\.00$/);
    expect(composed.fields["order.applicable_documents"]).toBe(
      "Schedule E5 Disclosure Record DR-1 (version 1)",
    );
  });

  it("places both DocuSign anchors in the electronic acceptance, once each", () => {
    const esign = composed.fields["signatory.esign_reference"];
    expect(Array.isArray(esign)).toBe(true);
    const anchors = (esign as ReadonlyArray<{ anchor?: string }>)
      .map((s) => s.anchor)
      .filter(Boolean);
    expect(anchors).toEqual([
      SUBSCRIPTION_ANCHORS.clientSignature,
      SUBSCRIPTION_ANCHORS.clientDate,
    ]);
    expect(fieldValueText(esign)).toContain("offer AUR-SA-20260925-ABCDEF");
    expect(fieldValueText(esign)).toContain("⟨DocuSign signature⟩");
  });

  it("produces a document fill stating the empty A4 section", () => {
    const fill = toDocumentFill(composed);
    expect(fill.repeating[ADDITIONAL_LINES_TAG]).toEqual({
      items: [],
      whenEmpty: NO_ADDITIONAL_PURCHASES,
    });
    expect(Object.keys(fill.fields)).toEqual([...SUBSCRIPTION_FIELD_TAGS]);
  });
});

describe("a Scale offer on a 12-month commitment with extras", () => {
  const offer = completeOffer("scale", (o) => {
    o.term = "committed_monthly";
    o.extraSeats = 2;
    o.addons = [
      {
        id: "l1",
        itemKey: "aurixa-agent",
        quantity: 1,
        discountMonthlyCents: 0,
        term: "committed",
        purchaser: "",
        scope: "",
        usageAndCosts: "",
        permissions: "",
      },
      {
        id: "l2",
        itemKey: "intelligence-hub",
        quantity: 1,
        discountMonthlyCents: 2_900,
        term: "flexible",
        purchaser: "",
        scope: "",
        usageAndCosts: "",
        permissions: "",
      },
    ];
    o.supportFee = { monthlyCents: 10_000, description: "Priority onboarding support" };
    o.oneOffCharges = [{ description: "Data migration", amountCents: 50_000 }];
  });
  const composed = compose(offer);

  it("has no gaps", () => {
    expect(composed.gaps).toEqual([]);
  });

  it("discounts the base only and fixes the committed charges", () => {
    const t = composed.totals;
    expect(t.base.netMonthlyCents).toBe(229_415);
    expect(t.recurringExtrasCents).toBe(9_800 + 49_500 + 10_000);
    expect(t.monthlyTotalCents).toBe(229_415 + 69_300 + 10_000);
    expect(t.dueAtActivationCents).toBe(308_715 + 50_000);
    // committed base + committed line for 12 months + first month of flexible extras and support + one-offs
    expect(t.minimumFixedCents).toBe(229_415 * 12 + 49_500 * 12 + 29_800 + 50_000);
    expect(t.postTermMonthlyCents).toBe(269_900 + 69_300 + 10_000);
  });

  it("prints the fixed charges and what follows the commitment", () => {
    expect(composed.fields["price.minimum_fixed_commitment"]).toBe(
      "Committed base 12 × $2,294.15 = $27,529.80; committed lines 12 × $495.00 = $5,940.00; " +
        "first month of flexible extras and support $298.00; one-off charges $500.00. Total minimum fixed charges $34,267.80.",
    );
    expect(composed.fields["price.post_term_summary"]).toBe(
      "From 31 October 2027: month to month at the standard Scale base of $2,699.00 (With AML) plus continuing extras of $793.00 — $3,492.00 per month — unless cancelled or recommitted (clauses 5.8–5.9)",
    );
    expect(composed.fields["price.recurring_extras"]).toBe(
      "2 additional user seats × $49.00 = $98.00; Aurixa Agent $495.00 (committed); " +
        "Aurixa Intelligence Hub $129.00 − $29.00 accepted discount = $100.00. Extras $693.00 per month.",
    );
  });

  it("writes one A4 record per line, numbered, with its dates and commitment", () => {
    expect(composed.lines.map((l) => l.record["addon.id_buyer_scope"].split(";")[0])).toEqual([
      "A4-1 Additional User Seat",
      "A4-2 Aurixa Agent",
      "A4-3 Aurixa Intelligence Hub",
    ]);
    const agent = composed.lines[1].record;
    expect(agent["addon.dates_and_term"]).toBe(
      "Effective at paid activation (31 October 2026); renews monthly with the base on the 31st; committed to the base commitment end — last day 30 October 2027",
    );
    expect(agent["addon.immediate_and_commitment"]).toBe(
      "Immediate charge $495.00 in the first payment; remaining fixed line charges 11 × $495.00 = $5,445.00 ($5,940.00 fixed in total)",
    );
    expect(composed.lines[0].record["addon.id_buyer_scope"]).toContain(
      "2 named internal user seats beyond the 30 included in Scale",
    );
  });

  it("brings in communications authority and the X09 supplement that Scale's inclusions need", () => {
    expect(composed.fields["usage.communications_allowance_or_disabled"]).toBe(
      COMPLETE_PROFILE.usage.commsAllowance,
    );
    expect(composed.fields["order.applicable_documents"]).toContain(
      "X09 Marketplace & Commercial Product Supplement",
    );
  });
});

describe("an annual prepayment", () => {
  it("heads the Order with the prepayment and calls the monthly figure an equivalent", () => {
    const composed = compose(completeOffer("launch", (o) => (o.term = "committed_annual")));
    expect(composed.gaps).toEqual([]);
    expect(composed.fields["price.headline_amount"]).toBe("$10,189.80");
    expect(composed.fields["price.total_label"]).toBe("Monthly equivalent if prepaid");
    expect(fieldValueText(composed.fields["payment.arrangement"])).toMatch(
      /^\$10,189\.80 base prepayment due 31 October 2026; no monthly extras\. Payment method: Card through Stripe\./,
    );
  });
});

describe("Without AML", () => {
  it("states the option in every AML field and asks for no AML authority", () => {
    const offer = completeOffer("growth", (o) => {
      o.aml = "without";
      o.usage.amlAllowance = "";
      o.usage.amlBasis = "";
    });
    const composed = compose(offer);
    expect(composed.gaps).toEqual([]);
    expect(composed.totals.monthlyTotalCents).toBe(124_900);
    expect(composed.fields["order.aml_option"]).toBe("Without AML");
    expect(composed.fields["usage.aml_allowance_or_disabled"]).toBe("Not selected — Without AML");
    expect(composed.fields["scope.aml_summary"]).toMatch(/^Without AML — /);
  });
});

describe("what an additional line may not be", () => {
  const withLine = (
    itemKey: string,
    patch: Record<string, unknown> = {},
    tier = "growth" as const,
  ) =>
    completeOffer(tier, (o) => {
      o.addons = [
        {
          id: "x",
          itemKey,
          quantity: 1,
          discountMonthlyCents: 0,
          term: "flexible",
          purchaser: "",
          scope: "",
          usageAndCosts: "",
          permissions: "",
          ...patch,
        },
      ];
    });
  const messages = (offer: SubscriptionOffer) =>
    compose(offer)
      .gaps.map((g) => g.message)
      .join(" ");

  it("refuses an item the tier already includes", () => {
    expect(messages(withLine("deal-pipeline"))).toMatch(/already included in Growth/);
  });

  it("refuses seats, independent contracts, items not for sale and unknown items", () => {
    expect(messages(withLine("additional-user-seat"))).toMatch(/seat count/);
    expect(messages(withLine("builder-developer-portal"))).toMatch(
      /own purchaser and paid agreement/,
    );
    expect(messages(withLine("lenders"))).toMatch(/not for sale/);
    expect(messages(withLine("no-such-item"))).toMatch(/not in Schedule A3/);
  });

  it("refuses a committed line on a flexible term and a discount above the charge", () => {
    expect(messages(withLine("email-copilot", { term: "committed" }))).toMatch(
      /only a 12-month committed term/,
    );
    expect(messages(withLine("email-copilot", { discountMonthlyCents: 20_000 }))).toMatch(
      /larger than its \$149\.00 monthly charge/,
    );
  });

  it("requires the scope A3's readiness rule asks for", () => {
    expect(messages(withLine("model-hub"))).toMatch(/Model Hub needs its identified scope/);
    expect(
      gapKeys(withLine("model-hub", { scope: "Customer-facing model selection only" })),
    ).toEqual([]);
  });

  it("requires communications authority once a line enables it", () => {
    const offer = withLine("email-copilot");
    offer.usage.commsAllowance = "";
    expect(gapKeys(offer)).toContain("usage.commsAllowance");
  });

  it("refuses the same item twice", () => {
    const offer = withLine("email-copilot");
    offer.addons.push({ ...offer.addons[0], id: "y" });
    expect(messages(offer)).toMatch(/listed twice/);
  });
});

describe("inputs that cannot be issued", () => {
  it("refuses an identifier that fails its check digits, and accepts a valid ACN", () => {
    expect(
      compose(completeOffer("launch", (o) => (o.customer.identifier = "51 824 753 557"))).gaps,
    ).toEqual([
      {
        key: "customer.identifier",
        message: "ABN 51 824 753 557 fails the ABR check-digit test — check the number.",
      },
    ]);
    const acn = compose(completeOffer("launch", (o) => (o.customer.identifier = EXAMPLE_ACN)));
    expect(acn.gaps).toEqual([]);
    expect(acn.fields["customer.identifier"]).toBe("ACN 004 085 616");
  });

  it("refuses square brackets, which would read as an unfilled placeholder", () => {
    const composed = compose(
      completeOffer("launch", (o) => (o.specialConditions = "See [annexure]")),
    );
    expect(composed.gaps.map((g) => g.key)).toEqual(["order.special_conditions_summary"]);
  });

  it("warns about a past activation date without blocking it", () => {
    const composed = compose(completeOffer("launch", (o) => (o.activationDate = "2026-09-01")));
    expect(composed.gaps).toEqual([]);
    expect(composed.warnings).toEqual([
      "The activation date is in the past. Clause 4.5 does not allow backdating.",
    ]);
  });

  it("will not produce a document from a composition with gaps", () => {
    const composed = compose(completeOffer("launch", (o) => (o.customer.legalName = "")));
    expect(() => toDocumentFill(composed)).toThrow(IncompleteOfferError);
  });
});

describe("references and titles", () => {
  it("makes a readable reference with no ambiguous characters", () => {
    const ref = newOfferReference(new Date("2026-09-25T03:00:00Z"), (n) =>
      Uint8Array.from({ length: n }, (_, i) => i * 37),
    );
    expect(ref).toMatch(/^AUR-SA-20260925-[A-HJ-NP-Z2-9]{6}$/);
  });

  it("titles the offer with the tier and the customer", () => {
    expect(offerTitle("scale", " Example Pty Ltd ")).toBe(
      "Aurixa Systems Scale Subscription Agreement — Example Pty Ltd",
    );
  });
});
