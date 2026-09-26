/**
 * The offer page's panels are rendered, not only typechecked.
 *
 * Every panel here reads a composed view that has many legitimately empty
 * states — a blank offer with every gap open, a complete draft, an issued
 * offer read back from its snapshot, an issued offer whose rate card is gone —
 * and a property read on one of those that TypeScript lets through is a white
 * screen for the operator in the middle of preparing a customer's offer. So
 * each state is drawn through the real components and the markup read.
 *
 * `createElement` and `renderToStaticMarkup` under vitest's node environment,
 * as `membraneBandRenders.test.ts` does. The one router dependency (`Link`)
 * is replaced by a plain anchor, which is all it renders anyway.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) =>
    createElement("a", { href: to, className }, children),
}));

import { OfferEditor } from "./offer-editor";
import {
  OfferDocumentReview,
  OfferPrice,
  OfferProvisioning,
  OfferReadiness,
} from "./offer-summary";
import { IssuingProfileForm } from "./issuing-profile-form";
import { composedView, snapshotView, type OfferView } from "@/lib/agreements/offerEditor.pure";
import {
  composeSubscriptionOffer,
  issuingProfileSchema,
  newSubscriptionOffer,
  type AddonLine,
  type SubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import { buildIssuedSnapshot } from "@/lib/agreements/subscriptionIssue.pure";
import { COMPLETE_PROFILE, RATE_CARD, completeOffer } from "@/lib/agreements/subscriptionFixtures";
import type { SubscriptionTierSlug } from "@/lib/agreements/subscriptionTemplates";

const REFERENCE = "AUR-SUB-TEST-0001";
const EMPTY_PROFILE = issuingProfileSchema.parse({});
const TODAY = "2026-09-25";

function composedOfferView(offer: SubscriptionOffer, rateCard = RATE_CARD): OfferView {
  return composedView(
    composeSubscriptionOffer(offer, { offerReference: REFERENCE, rateCard, today: TODAY }),
  );
}

const ROW = {
  plan_slug: "growth",
  addon_slugs: [],
  provision_on_signature: false,
  provision_status: "none",
  provision_error: null,
};

function drawAll(offer: SubscriptionOffer, view: OfferView, readOnly: boolean): string {
  return [
    renderToStaticMarkup(
      createElement(OfferEditor, {
        offer,
        onChange: () => {},
        readOnly,
        view,
        profile: COMPLETE_PROFILE,
        profileUpdatedAt: "2026-09-24T01:00:00.000Z",
        rateCard: RATE_CARD,
      }),
    ),
    renderToStaticMarkup(createElement(OfferReadiness, { view, issued: null })),
    renderToStaticMarkup(createElement(OfferPrice, { view, offer })),
    renderToStaticMarkup(createElement(OfferProvisioning, { offer, row: ROW, unsaved: !readOnly })),
    renderToStaticMarkup(createElement(OfferDocumentReview, { view, defaultOpen: true })),
  ].join("\n");
}

describe("the offer page's panels render in every state an offer can be in", () => {
  it.each<SubscriptionTierSlug>(["launch", "growth", "scale"])(
    "draws a brand-new %s offer, every gap still open",
    (tier) => {
      const offer = newSubscriptionOffer(tier, EMPTY_PROFILE);
      const view = composedOfferView(offer);
      expect(view.gaps.length).toBeGreaterThan(0);
      const html = drawAll(offer, view, false);
      expect(html).toContain("Customer");
    },
  );

  it.each<SubscriptionTierSlug>(["launch", "growth", "scale"])(
    "draws a complete %s draft with nothing outstanding",
    (tier) => {
      const offer = completeOffer(tier);
      const view = composedOfferView(offer);
      expect(view.gaps).toEqual([]);
      const html = drawAll(offer, view, false);
      expect(html).toContain("Example Property Advisory Pty Ltd");
    },
  );

  const line = (itemKey: string, patch: Partial<AddonLine> = {}): AddonLine => ({
    id: `line-${itemKey}`,
    itemKey,
    quantity: 1,
    discountMonthlyCents: 0,
    term: "flexible",
    purchaser: "Example Property Advisory Pty Ltd",
    scope: "All named internal users",
    usageAndCosts: "Included use only",
    permissions: "Standard module permissions",
    ...patch,
  });

  it.each<SubscriptionTierSlug>(["launch", "scale"])(
    "draws a %s offer on every term, with seats, lines and charges",
    (tier) => {
      for (const term of ["flexible", "committed_monthly", "committed_annual"] as const) {
        for (const aml of ["with", "without"] as const) {
          const offer = completeOffer(tier, (o) => {
            o.term = term;
            o.aml = aml;
            o.extraSeats = 2;
            o.addons = [
              line("commercial-industrial", { term: "committed", discountMonthlyCents: 1_000 }),
              line("advanced-forms-builder"),
              line("market-news-feed", { quantity: 2 }),
            ];
            o.supportFee = { monthlyCents: 25_000, description: "Priority support" };
            o.oneOffCharges = [{ description: "Onboarding", amountCents: 150_000 }];
            o.specialConditions = "None beyond the Order.";
          });
          const html = drawAll(offer, composedOfferView(offer), false);
          expect(html).toContain("Advanced Forms Builder");
        }
      }
    },
  );

  it("draws an offer with no rate card to read", () => {
    const offer = completeOffer("growth");
    drawAll(offer, composedOfferView(offer, null as never), false);
  });

  it("draws an issued offer read back from its snapshot, read-only", () => {
    const offer = completeOffer("growth");
    const composed = composeSubscriptionOffer(offer, {
      offerReference: REFERENCE,
      rateCard: RATE_CARD,
      today: TODAY,
    });
    const snapshot = buildIssuedSnapshot({
      offerReference: REFERENCE,
      issuedAt: "2026-09-25T02:00:00.000Z",
      tier: "growth",
      composed,
      rateCard: RATE_CARD,
      document: {
        name: "Aurixa Growth Subscription Agreement AUR-SUB-TEST-0001.docx",
        sha256: "0".repeat(64),
        bytes: 1,
        documentXmlSha256: "0".repeat(64),
      } as never,
      signer: { name: "Alex Example", email: "alex@customer.test" },
      carbonCopy: null,
    });
    const view = snapshotView(snapshot, composedView(composed).records);
    const html = [
      drawAll(offer, view, true),
      renderToStaticMarkup(
        createElement(OfferReadiness, {
          view,
          issued: {
            at: snapshot.issuedAt,
            documentName: snapshot.document.name,
            signer: snapshot.signer.name,
          },
        }),
      ),
    ].join("\n");
    expect(html).toContain("Alex Example");
  });

  it("draws the issuing profile form, empty and complete, editable and not", () => {
    for (const profile of [EMPTY_PROFILE, COMPLETE_PROFILE]) {
      for (const readOnly of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(IssuingProfileForm, { profile, onChange: () => {}, readOnly }),
        );
        expect(html.length).toBeGreaterThan(0);
      }
    }
  });
});
