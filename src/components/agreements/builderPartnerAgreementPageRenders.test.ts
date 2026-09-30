/**
 * The Builder Partner Agreement page, drawn in the states the Portal
 * subscription can be in.
 *
 * The section decides everything from the view alone — whether the columns
 * exist, whether a link went, whether the builder already pays — and a
 * property read that fails on one of those branches is a blank page for the
 * admin looking at a builder who has just signed. So the real component is
 * drawn through `renderToStaticMarkup` for each state and its markup read for
 * what that state must say and must not offer.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  isAdmin: true,
}));

vi.mock("@tanstack/react-router", async () => {
  const { createElement: el } = await import("react");
  return {
    Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) =>
      el("a", { href: to, className }, children),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = h.queries.get(JSON.stringify(queryKey));
    return {
      data,
      isPending: data === undefined,
      isFetching: false,
      error: null,
      refetch: async () => ({}),
    };
  },
  useMutation: () => ({
    mutate: () => undefined,
    mutateAsync: async () => undefined,
    isPending: false,
    reset: () => undefined,
  }),
  useQueryClient: () => ({
    invalidateQueries: async () => undefined,
    setQueryData: () => undefined,
  }),
}));

vi.mock("@/lib/agreements.functions", () => {
  const fn = () => async () => undefined;
  return {
    deleteDraftAgreement: fn(),
    downloadSignedAgreement: fn(),
    sendAgreement: fn(),
    voidAgreement: fn(),
  };
});

vi.mock("@/lib/builderPartnerAgreements.functions", () => {
  const fn = () => async () => undefined;
  return {
    downloadBuilderPartnerAgreementTerms: fn(),
    downloadBuilderPartnerSchedule: fn(),
    getBuilderPartnerAgreement: fn(),
    grantBuilderPartnerPortalAccess: fn(),
    saveBuilderPartnerParticulars: fn(),
    sendBuilderPartnerPaymentLink: fn(),
    setBuilderPartnerGrantOnSignature: fn(),
  };
});

vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/use-user-roles", () => ({
  useUserRoles: () => ({ isAdmin: h.isAdmin, isOperator: true, loading: false }),
}));

import { BuilderPartnerAgreementPage } from "./builder-partner-agreement";
import type { BuilderPartnerAgreementView } from "@/server/builder-partner-agreements.server";
import type { BuilderPortalPaymentView } from "@/server/builder-portal-payment.server";
import { builderPortalPaymentUrl, portalPrice } from "@/lib/agreements/builderPortalPayment.pure";

const ID = "0b6f3a52-6d3e-4a8e-9f55-1c2d3e4f5a6b";

function payment(
  over: {
    installed?: boolean;
    link?: Partial<BuilderPortalPaymentView["link"]>;
    subscription?: Partial<BuilderPortalPaymentView["subscription"]>;
  } = {},
): BuilderPortalPaymentView {
  const price = portalPrice();
  return {
    installed: over.installed ?? true,
    price: {
      monthlyInclGstCents: price.monthlyInclGstCents,
      gstCents: price.gstCents,
      sentence: price.sentence,
    },
    url:
      over.installed === false
        ? null
        : builderPortalPaymentUrl({ agreementId: ID, email: "sam@examplehomes.test" }),
    link: {
      status: null,
      attempts: 0,
      attemptedAt: null,
      sentAt: null,
      sentTo: null,
      detail: null,
      ...over.link,
    },
    subscription: {
      id: null,
      status: null,
      customerId: null,
      startedAt: null,
      updatedAt: null,
      ...over.subscription,
    },
  };
}

function view(over: Partial<BuilderPartnerAgreementView> = {}): BuilderPartnerAgreementView {
  return {
    id: ID,
    reference: "AUR-BPA-20260930-ABCDEF",
    status: "signed",
    builderOrganisationId: "00000000-0000-4000-8000-0000000000aa",
    particulars: {
      schema: 1,
      partner: {
        legalName: "Example Homes Pty Ltd",
        tradingName: "Example Homes",
        abn: "51824753556",
        acn: "",
        address: "1 Builder Street, Parramatta NSW 2150",
        email: "office@examplehomes.test",
        phone: "02 9000 0000",
      },
      signatory: { name: "Sam Builder", email: "sam@examplehomes.test", title: "Director" },
    },
    gaps: { blockers: [], warnings: [] },
    sendState: "unclaimed",
    issued: null,
    termsInForce: null,
    termsState: "in_force",
    grantAccessOnSignature: true,
    portalAccess: {
      status: "granted",
      attemptedAt: "2026-09-30T01:00:00.000Z",
      grantedAt: "2026-09-30T01:00:05.000Z",
      detail: null,
    },
    signedRecord: { retained: true, sha256: "a".repeat(64) },
    meteringAccount: true,
    portalPayment: payment(),
    docusignReady: true,
    updatedAt: "2026-09-30T01:00:05.000Z",
    ...over,
  } as BuilderPartnerAgreementView;
}

function draw(v: BuilderPartnerAgreementView): string {
  h.queries.clear();
  h.queries.set(JSON.stringify(["agreements", "builder-partner", ID]), v);
  return renderToStaticMarkup(createElement(BuilderPartnerAgreementPage, { agreementId: ID }));
}

describe("the Portal subscription on a Builder Partner Agreement", () => {
  it("states the price, and that the Transaction Fees are not charged by the link", () => {
    const html = draw(view());
    expect(html).toContain("Portal subscription");
    expect(html).toContain("$699.00 a month including GST ($63.55 GST)");
    expect(html).toContain("New Build and Development Sale fees are separate");
  });

  it("offers the first send, and the builder's own link, once signed and retained", () => {
    const html = draw(view());
    expect(html).toContain("The payment link has not been sent yet");
    expect(html).toContain("Send payment link");
    expect(html).not.toContain("Send payment link again");
    expect(html).toContain("Copy the builder&#x27;s link");
  });

  it("waits for the signed copy before offering anything", () => {
    const html = draw(view({ signedRecord: { retained: false, sha256: null } }));
    expect(html).toContain("The payment link waits for the signed agreement to be retained.");
    expect(html).not.toContain("Send payment link");
  });

  it("shows a link that went, and offers it again only as a second send", () => {
    const html = draw(
      view({
        portalPayment: payment({
          link: {
            status: "sent",
            attempts: 1,
            attemptedAt: "2026-09-30T01:01:00.000Z",
            sentAt: "2026-09-30T01:01:02.000Z",
            sentTo: "sam@examplehomes.test",
          },
        }),
      }),
    );
    expect(html).toContain("Payment link sent");
    expect(html).toContain("to sam@examplehomes.test");
    expect(html).toContain("Send payment link again");
  });

  it("says a send Microsoft did not confirm, with its reason", () => {
    const html = draw(
      view({
        portalPayment: payment({
          link: {
            status: "unconfirmed",
            attempts: 1,
            attemptedAt: "2026-09-30T01:01:00.000Z",
            detail: "Microsoft did not confirm the send",
          },
        }),
      }),
    );
    expect(html).toContain("Send not confirmed");
    expect(html).toContain("Microsoft did not confirm the send");
  });

  it("holds an agreement signed before links went automatically, and offers the first send", () => {
    const html = draw(view({ portalPayment: payment({ link: { status: "held" } }) }));
    expect(html).toContain("Held — signed before links were sent automatically");
    expect(html).toContain("Send payment link");
    expect(html).not.toContain("Send payment link again");
  });

  it("offers no send at all to a builder who already pays", () => {
    const html = draw(
      view({
        portalPayment: payment({
          link: { status: "sent", sentAt: "2026-09-30T01:01:02.000Z" },
          subscription: {
            id: "sub_123",
            status: "active",
            startedAt: "2026-09-30T01:10:00.000Z",
          },
        }),
      }),
    );
    expect(html).toContain("Subscription active");
    expect(html).toContain("sub_123");
    expect(html).not.toContain("Send payment link");
  });

  it("says when the columns are not installed, and sends nothing", () => {
    const html = draw(view({ portalPayment: payment({ installed: false }) }));
    expect(html).toContain("has not been applied to this database yet");
    expect(html).not.toContain("Send payment link");
    expect(html).not.toContain("Copy the builder");
  });

  it("says the subscription could not be read rather than drawing nothing", () => {
    const html = draw(view({ portalPayment: null }));
    expect(html).toContain("The Portal subscription could not be read.");
  });

  it("offers an operator nothing to press", () => {
    h.isAdmin = false;
    try {
      const html = draw(view());
      expect(html).toContain("Portal subscription");
      expect(html).not.toContain("Send payment link");
    } finally {
      h.isAdmin = true;
    }
  });

  it("draws a draft without offering a link", () => {
    const html = draw(
      view({
        status: "draft",
        portalAccess: { status: null, attemptedAt: null, grantedAt: null, detail: null },
        signedRecord: { retained: false, sha256: null },
      }),
    );
    expect(html).toContain("Portal subscription");
    expect(html).not.toContain("Send payment link");
    expect(html).not.toContain("Copy the builder");
  });
});
