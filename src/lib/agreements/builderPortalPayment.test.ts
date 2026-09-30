import { describe, expect, it } from "vitest";
import {
  agreementIdFromReference,
  BUILDER_PORTAL_PAYMENT,
  BUILDER_PORTAL_PAYMENT_PURPOSE,
  builderPortalPaymentUrl,
  catalogPortalPriceCents,
  composePaymentLinkEmail,
  decidePaymentLinkDispatch,
  decideSubscriptionRecord,
  isBuilderPortalSession,
  isBuilderPortalSubscription,
  isStripeSubscriptionStatus,
  MAX_PAYMENT_LINK_ATTEMPTS,
  paymentReferenceFor,
  portalPrice,
  STALE_PAYMENT_LINK_CLAIM_MS,
  subscriptionIsLive,
  subscriptionNeedsAttention,
  type PaymentLinkRow,
} from "./builderPortalPayment.pure";

const AGREEMENT = "0b6f3a52-6d3e-4a8e-9f55-1c2d3e4f5a6b";
const NOW = Date.parse("2026-09-30T02:00:00.000Z");

function row(over: Partial<PaymentLinkRow> = {}): PaymentLinkRow {
  return {
    status: "signed",
    signed_record_path: "builder-partner/signed/a.pdf",
    client_email: "sam@examplehomes.test",
    portal_payment_link_status: null,
    portal_payment_link_attempts: 0,
    portal_payment_link_attempted_at: null,
    portal_subscription_status: null,
    ...over,
  };
}

describe("the price the link charges", () => {
  it("is the catalog's own figure for the Builder / Developer Portal", () => {
    // The Stripe price was created at this figure; if either side moves alone,
    // the link would charge one amount while the product quotes another.
    expect(catalogPortalPriceCents()).toBe(BUILDER_PORTAL_PAYMENT.monthlyInclGstCents);
  });

  it("states the GST inside it, in a sentence a builder can check against Stripe", () => {
    const price = portalPrice();
    expect(price).toMatchObject({ monthlyInclGstCents: 69900, gstCents: 6355, exGstCents: 63545 });
    expect(price.sentence).toBe("$699.00 a month including GST ($63.55 GST)");
  });

  it("is the live AUD link in Mission Control's own Stripe account", () => {
    expect(BUILDER_PORTAL_PAYMENT).toMatchObject({
      stripeAccountId: "acct_1TbJPK3tNhf9apmH",
      livemode: true,
      currency: "aud",
    });
    expect(BUILDER_PORTAL_PAYMENT.url).toMatch(/^https:\/\/buy\.stripe\.com\//);
  });
});

describe("the builder's own link", () => {
  it("names the agreement, and reads back only a reference it could have minted", () => {
    const reference = paymentReferenceFor(AGREEMENT.toUpperCase());
    expect(reference).toBe(`bpa_${AGREEMENT}`);
    expect(agreementIdFromReference(reference)).toBe(AGREEMENT);
    expect(agreementIdFromReference(null)).toBeNull();
    expect(agreementIdFromReference(AGREEMENT)).toBeNull();
    expect(agreementIdFromReference("bpa_not-a-uuid")).toBeNull();
    expect(() => paymentReferenceFor("a1")).toThrow();
  });

  it("carries the reference and the signatory's address, and never a bad one", () => {
    const url = new URL(
      builderPortalPaymentUrl({ agreementId: AGREEMENT, email: " sam@examplehomes.test " }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(BUILDER_PORTAL_PAYMENT.url);
    expect(url.searchParams.get("client_reference_id")).toBe(`bpa_${AGREEMENT}`);
    expect(url.searchParams.get("prefilled_email")).toBe("sam@examplehomes.test");
    const bare = new URL(
      builderPortalPaymentUrl({ agreementId: AGREEMENT, email: "not an address" }),
    );
    expect(bare.searchParams.has("prefilled_email")).toBe(false);
  });
});

describe("recognising what Stripe sends back", () => {
  it("knows the link's sessions by the link, and by its purpose as a second witness", () => {
    expect(isBuilderPortalSession({ payment_link: BUILDER_PORTAL_PAYMENT.paymentLinkId })).toBe(
      true,
    );
    expect(
      isBuilderPortalSession({ payment_link: { id: BUILDER_PORTAL_PAYMENT.paymentLinkId } }),
    ).toBe(true);
    expect(
      isBuilderPortalSession({
        payment_link: null,
        metadata: { purpose: BUILDER_PORTAL_PAYMENT_PURPOSE },
      }),
    ).toBe(true);
    // A self-serve checkout carries our own metadata and no link.
    expect(
      isBuilderPortalSession({ payment_link: null, metadata: { mode: "topup", item_id: "x" } }),
    ).toBe(false);
    expect(isBuilderPortalSession({ payment_link: "plink_someoneElse" })).toBe(false);
  });

  it("knows the link's subscriptions by their purpose or by the Portal price", () => {
    expect(
      isBuilderPortalSubscription({ metadata: { purpose: BUILDER_PORTAL_PAYMENT_PURPOSE } }),
    ).toBe(true);
    expect(
      isBuilderPortalSubscription({
        metadata: {},
        items: { data: [{ price: { id: BUILDER_PORTAL_PAYMENT.priceId } }] },
      }),
    ).toBe(true);
    // A clone's seat subscription is none of this module's business.
    expect(
      isBuilderPortalSubscription({
        metadata: { clone_id: "c1", item_id: "growth" },
        items: { data: [{ price: "price_growth" }] },
      }),
    ).toBe(false);
  });

  it("records Stripe's own status words and nothing else", () => {
    expect(isStripeSubscriptionStatus("past_due")).toBe(true);
    expect(isStripeSubscriptionStatus("lapsed")).toBe(false);
    expect(subscriptionIsLive("active")).toBe(true);
    expect(subscriptionIsLive("past_due")).toBe(true);
    expect(subscriptionIsLive("canceled")).toBe(false);
    expect(subscriptionIsLive("incomplete_expired")).toBe(false);
    expect(subscriptionIsLive(null)).toBe(false);
  });

  it("tells a person when a subscription goes wrong, once per change", () => {
    expect(subscriptionNeedsAttention("active", "past_due")).toBe(true);
    expect(subscriptionNeedsAttention("past_due", "past_due")).toBe(false);
    expect(subscriptionNeedsAttention("active", "canceled")).toBe(true);
    expect(subscriptionNeedsAttention("incomplete", "active")).toBe(false);
  });

  it("never writes a second subscription over the first", () => {
    expect(decideSubscriptionRecord(null, "sub_1")).toEqual({ action: "record", first: true });
    expect(decideSubscriptionRecord("sub_1", "sub_1")).toEqual({ action: "record", first: false });
    expect(decideSubscriptionRecord("sub_1", "sub_2")).toEqual({
      action: "duplicate",
      existing: "sub_1",
    });
  });
});

describe("whether the link is sent", () => {
  const signature = { trigger: "signature" as const };
  const sweep = { trigger: "sweep" as const };
  const manual = { trigger: "manual" as const };

  it("goes once the signed agreement is retained, and not a moment before", () => {
    expect(decidePaymentLinkDispatch(row(), NOW, signature)).toEqual({ action: "send" });
    expect(decidePaymentLinkDispatch(row({ status: "sent" }), NOW, signature)).toMatchObject({
      action: "skip",
      reason: "not_signed",
    });
    expect(decidePaymentLinkDispatch(row({ signed_record_path: null }), NOW, manual)).toMatchObject(
      {
        action: "skip",
        reason: "not_retained",
      },
    );
    expect(decidePaymentLinkDispatch(row({ client_email: "nobody" }), NOW, manual)).toMatchObject({
      action: "skip",
      reason: "no_address",
    });
  });

  it("is not sent to a builder who already has a subscription, even by hand", () => {
    for (const status of ["active", "past_due", "incomplete"]) {
      expect(
        decidePaymentLinkDispatch(row({ portal_subscription_status: status }), NOW, manual),
      ).toMatchObject({ action: "skip", reason: "already_subscribed" });
    }
    // A cancelled one is over; a new link can be owed.
    expect(
      decidePaymentLinkDispatch(row({ portal_subscription_status: "canceled" }), NOW, manual),
    ).toEqual({ action: "send" });
  });

  it("never goes twice at once, and a claim that died becomes unconfirmed rather than a retry", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const stale = new Date(NOW - STALE_PAYMENT_LINK_CLAIM_MS - 1).toISOString();
    expect(
      decidePaymentLinkDispatch(
        row({ portal_payment_link_status: "sending", portal_payment_link_attempted_at: fresh }),
        NOW,
        manual,
      ),
    ).toMatchObject({ action: "skip", reason: "in_flight" });
    expect(
      decidePaymentLinkDispatch(
        row({ portal_payment_link_status: "sending", portal_payment_link_attempted_at: stale }),
        NOW,
        sweep,
      ),
    ).toEqual({ action: "abandon_stale" });
    expect(
      decidePaymentLinkDispatch(
        row({ portal_payment_link_status: "sending", portal_payment_link_attempted_at: null }),
        NOW,
        sweep,
      ),
    ).toEqual({ action: "abandon_stale" });
  });

  it("retries a refusal automatically, and only so many times", () => {
    expect(
      decidePaymentLinkDispatch(
        row({ portal_payment_link_status: "failed", portal_payment_link_attempts: 1 }),
        NOW,
        sweep,
      ),
    ).toEqual({ action: "send" });
    expect(
      decidePaymentLinkDispatch(
        row({
          portal_payment_link_status: "failed",
          portal_payment_link_attempts: MAX_PAYMENT_LINK_ATTEMPTS,
        }),
        NOW,
        sweep,
      ),
    ).toMatchObject({ action: "skip", reason: "gave_up" });
  });

  it("leaves a sent, held or unconfirmed link to a person — who may send it again", () => {
    for (const [status, reason] of [
      ["sent", "already_sent"],
      ["held", "held"],
      ["unconfirmed", "unconfirmed"],
    ] as const) {
      const r = row({ portal_payment_link_status: status, portal_payment_link_attempts: 1 });
      expect(decidePaymentLinkDispatch(r, NOW, sweep)).toMatchObject({ action: "skip", reason });
      expect(decidePaymentLinkDispatch(r, NOW, signature)).toMatchObject({
        action: "skip",
        reason,
      });
      expect(decidePaymentLinkDispatch(r, NOW, manual)).toEqual({ action: "send" });
    }
  });
});

describe("the email", () => {
  const email = composePaymentLinkEmail({
    agreementId: AGREEMENT,
    reference: "AUR-BPA-20260930-ABCDEF",
    recipientName: "Sam Builder",
    recipientEmail: "sam@examplehomes.test",
    organisation: "Example Homes <Pty> Ltd",
  });

  it("names the subscription, its price with GST, and the builder's own link", () => {
    expect(email.subject).toBe(
      "Set up your Builder / Developer Portal subscription — AUR-BPA-20260930-ABCDEF",
    );
    expect(email.text).toMatch(/^Hi Sam,/);
    expect(email.text).toContain("$699.00 a month including GST ($63.55 GST)");
    const url = builderPortalPaymentUrl({ agreementId: AGREEMENT, email: "sam@examplehomes.test" });
    expect(email.text).toContain(url);
    expect(email.html).toContain(url.replace(/&/g, "&amp;"));
  });

  it("says the Transaction Fees are separate and are not charged through it", () => {
    for (const body of [email.text, email.html]) {
      expect(body).toMatch(
        /New Build Fees and Development Sale Fees are separate from this subscription/,
      );
      expect(body).toMatch(/not charged through this link/);
    }
    // No clause numbers: the terms can be re-issued with a different numbering.
    expect(email.text).not.toMatch(/\bclause\b|\b1[45]\.\d/i);
  });

  it("escapes what the agreement records rather than trusting it", () => {
    expect(email.html).toContain("Example Homes &lt;Pty&gt; Ltd");
    expect(email.html).not.toContain("<Pty>");
  });

  it("greets nobody by a name it does not have", () => {
    const anonymous = composePaymentLinkEmail({
      agreementId: AGREEMENT,
      reference: null,
      recipientName: null,
      recipientEmail: "sam@examplehomes.test",
      organisation: null,
    });
    expect(anonymous.text).toMatch(/^Hi there,/);
    expect(anonymous.subject).toBe("Set up your Builder / Developer Portal subscription");
  });
});
