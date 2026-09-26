/**
 * The agreement page is drawn in every state its row can be in.
 *
 * The page decides a great deal from the row alone — whether the offer is
 * editable, whether a send is running or stopped part-way, whether it is a
 * record read back from its snapshot, whether the snapshot can be read at
 * all, whether a signature has been retained and provisioned — and each of
 * those is a branch that renders different panels. None of them runs in the
 * type checker, and a property read that fails on one is a blank page for the
 * operator holding that customer's offer. So the real page component is drawn
 * through `renderToStaticMarkup` for each state, and the markup read for the
 * thing that state must say.
 *
 * The router, the query client, authentication and the server functions are
 * replaced by the smallest stand-ins that answer what the page asks: the
 * query stand-in serves each query key from a table the test fills.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  params: { agreementId: "00000000-0000-4000-8000-000000000001" },
  isAdmin: true,
}));

vi.mock("@tanstack/react-router", async () => {
  const { createElement: el } = await import("react");
  return {
    createFileRoute: () => (options: Record<string, unknown>) => ({
      options,
      useParams: () => h.params,
    }),
    Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) =>
      el("a", { href: to, className }, children),
    useBlocker: () => undefined,
    useNavigate: () => () => undefined,
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
    downloadSubscriptionAgreementDocument: fn(),
    duplicateSubscriptionOffer: fn(),
    getAgreement: fn(),
    getAgreementsConfig: fn(),
    getSubscriptionContext: fn(),
    provisionAgreementNow: fn(),
    refreshAgreementStatus: fn(),
    saveSubscriptionOffer: fn(),
    sendAgreement: fn(),
    voidAgreement: fn(),
  };
});

vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/route-error", () => ({ RouteError: () => null }));
vi.mock("@/components/agreement-provisioning-dialog", () => ({
  AgreementProvisioningDialog: () => null,
}));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/use-user-roles", () => ({
  useUserRoles: () => ({ isAdmin: h.isAdmin, isOperator: true, loading: false }),
}));

import { Route } from "@/routes/agreements.$agreementId";
import type { AgreementRow } from "@/lib/agreements.functions";
import type { Json } from "@/integrations/supabase/types";
import {
  composeSubscriptionOffer,
  issuingProfileSchema,
  newSubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import { buildIssuedSnapshot, STALE_SEND_CLAIM_MS } from "@/lib/agreements/subscriptionIssue.pure";
import { COMPLETE_PROFILE, RATE_CARD, completeOffer } from "@/lib/agreements/subscriptionFixtures";

const ID = h.params.agreementId;
const REFERENCE = "AUR-SUB-TEST-0001";
const ISSUED_AT = "2026-09-25T02:00:00.000Z";

const OFFER = completeOffer("growth");

const SNAPSHOT = buildIssuedSnapshot({
  offerReference: REFERENCE,
  issuedAt: ISSUED_AT,
  tier: "growth",
  composed: composeSubscriptionOffer(OFFER, {
    offerReference: REFERENCE,
    rateCard: RATE_CARD,
    today: "2026-09-25",
  }),
  rateCard: RATE_CARD,
  document: {
    name: `Aurixa Growth Subscription Agreement ${REFERENCE}.docx`,
    sha256: "0".repeat(64),
    bytes: 1,
    documentXmlSha256: "0".repeat(64),
  } as never,
  signer: { name: "Alex Example", email: "alex@customer.test" },
  carbonCopy: "ops@aurixa.test",
});

function row(over: Partial<AgreementRow> = {}): AgreementRow {
  return {
    id: ID,
    account_id: null,
    addon_slugs: [],
    admin_email: null,
    client_email: "alex@customer.test",
    client_name: "Alex Example",
    client_org: "Example Property Advisory Pty Ltd",
    commencement_date: null,
    contact_id: null,
    created_at: "2026-09-20T01:00:00.000Z",
    created_by: "00000000-0000-4000-8000-0000000000aa",
    document_kind: "subscription",
    docusign_envelope_id: null,
    docusign_sent_at: null,
    docusign_signed_at: null,
    docusign_status: null,
    docusign_voided_at: null,
    excluded_module_ids: [],
    issued_at: null,
    issued_snapshot: null,
    lead_id: "00000000-0000-4000-8000-0000000000bb",
    metadata: {},
    module_ids: [],
    notes: null,
    offer: OFFER as unknown as Json,
    offer_reference: REFERENCE,
    plan_slug: "growth",
    provision_error: null,
    provision_on_signature: false,
    provision_region: "ap-southeast-2",
    provision_status: "none",
    provisioned_clone_id: null,
    service_tier: "Growth",
    signed_record_path: null,
    signed_record_retained_at: null,
    signed_record_sha256: null,
    status: "draft",
    updated_at: "2026-09-24T01:00:00.000Z",
    void_reason: null,
    ...over,
  };
}

const issued = (over: Partial<AgreementRow> = {}) =>
  row({
    status: "sent",
    docusign_envelope_id: "11111111-2222-4333-8444-555555555555",
    docusign_status: "sent",
    docusign_sent_at: ISSUED_AT,
    issued_at: ISSUED_AT,
    issued_snapshot: SNAPSHOT as unknown as Json,
    ...over,
  });

function draw(agreement: AgreementRow, opts: { configured?: boolean } = {}): string {
  h.queries.clear();
  h.queries.set(JSON.stringify(["agreements", "detail", ID]), {
    agreement,
    lead: {
      id: agreement.lead_id,
      name: "Alex Example",
      email: "alex@customer.test",
      org: "Example Property Advisory Pty Ltd",
      status: "qualified",
    },
    account: null,
  });
  h.queries.set(JSON.stringify(["agreements", "subscription-context"]), {
    profile: COMPLETE_PROFILE,
    profileStored: true,
    profileValid: true,
    profileUpdatedAt: "2026-09-24T00:00:00.000Z",
    rateCard: RATE_CARD,
    today: "2026-09-25",
  });
  h.queries.set(JSON.stringify(["agreements", "config"]), {
    configured: opts.configured ?? true,
    missing: opts.configured === false ? ["DOCUSIGN_INTEGRATION_KEY"] : [],
    baseUrl: "https://demo.docusign.net/restapi",
    countersigner: { name: "Aurixa Operations", email: "ops@aurixa.test" },
  });
  const component = (Route as unknown as { options: { component: () => ReactNode } }).options
    .component;
  return renderToStaticMarkup(createElement(component));
}

describe("the agreement page in each state its row can be in", () => {
  it("prepares a complete draft, with send offered", () => {
    const html = draw(row());
    expect(html).toContain("Send for signature");
    expect(html).toContain("Preview .docx");
    expect(html).toContain(REFERENCE);
    expect(html).toContain("read live, printed as it stands when the offer is sent");
  });

  it("prepares a blank draft, with what is missing named and send held back", () => {
    const html = draw(
      row({
        offer: newSubscriptionOffer("scale", issuingProfileSchema.parse({})) as unknown as Json,
        plan_slug: "scale",
      }),
    );
    expect(html).toContain("Send for signature");
    expect(html).toMatch(/to complete/i);
  });

  it("says DocuSign is not connected on a draft that cannot be sent yet", () => {
    const html = draw(row(), { configured: false });
    expect(html).toMatch(/DocuSign/);
  });

  it("shows a send that is running, and offers nothing that would race it", () => {
    const html = draw(row({ issued_at: new Date(Date.now() - 60_000).toISOString() }));
    expect(html).toContain("Sending");
    expect(html).not.toContain("Send for signature");
  });

  it("offers to finish a send that stopped part-way", () => {
    const html = draw(
      row({ issued_at: new Date(Date.now() - STALE_SEND_CLAIM_MS - 60_000).toISOString() }),
    );
    expect(html).toContain("Finish sending");
  });

  it("reads a sent offer back from its snapshot, read-only", () => {
    const html = draw(issued());
    expect(html).toContain("Refresh status");
    expect(html).not.toContain("Send for signature");
    expect(html).toContain("Alex Example");
    // The rate card shown is the one the offer was sent with, and says so.
    expect(html).toContain("as this offer printed it when it was sent");
    expect(html).not.toContain("read live");
  });

  it("still draws a sent offer whose snapshot this build cannot read", () => {
    const html = draw(issued({ issued_snapshot: {} as Json }));
    expect(html).toContain(REFERENCE);
  });

  it("shows a signed, retained and provisioned offer with its clone", () => {
    const html = draw(
      issued({
        status: "signed",
        docusign_status: "completed",
        docusign_signed_at: "2026-09-26T02:00:00.000Z",
        signed_record_path: `subscription/${ID}/env-signed.pdf`,
        signed_record_sha256: "a".repeat(64),
        signed_record_retained_at: "2026-09-26T02:01:00.000Z",
        provision_on_signature: true,
        provision_status: "provisioned",
        provisioned_clone_id: "00000000-0000-4000-8000-0000000000cc",
      }),
    );
    expect(html).toContain("Signed PDF");
  });

  it("says when a signed offer's record has not been retained yet", () => {
    const html = draw(
      issued({
        status: "signed",
        docusign_status: "completed",
        docusign_signed_at: "2026-09-26T02:00:00.000Z",
        provision_on_signature: true,
        provision_status: "armed",
      }),
    );
    expect(html).toMatch(/retain/i);
  });

  it("shows a voided offer with its reason, and offers a revision", () => {
    const html = draw(
      issued({
        status: "voided",
        docusign_status: "voided",
        docusign_voided_at: "2026-09-27T02:00:00.000Z",
        void_reason: "Customer asked for a different term",
      }),
    );
    expect(html).toContain("Customer asked for a different term");
    expect(html).toContain("Prepare a revised offer");
    // Nothing a withdrawn offer selected can be provisioned, and the panel
    // does not offer to arm it.
    expect(html).toContain("can no longer be signed, so nothing it selected is provisioned");
    expect(html).not.toContain("until an operator arms it");
  });

  it("shows a declined offer, and offers a revision", () => {
    const html = draw(issued({ status: "declined", docusign_status: "declined" }));
    expect(html).toContain("Prepare a revised offer");
  });

  it("draws a non-admin's view of a signed offer without the provision button", () => {
    h.isAdmin = false;
    try {
      draw(
        issued({
          status: "signed",
          docusign_signed_at: "2026-09-26T02:00:00.000Z",
          signed_record_path: `subscription/${ID}/env-signed.pdf`,
          provision_on_signature: true,
          provision_status: "failed",
          provision_error: "GitHub refused the repository",
        }),
      );
    } finally {
      h.isAdmin = true;
    }
  });

  it("refuses to edit an offer this build cannot read, rather than failing", () => {
    const html = draw(row({ offer: { schema: 99 } as Json }));
    expect(html).not.toContain("Send for signature");
  });

  it("draws a Service Level Agreement as its facts", () => {
    const html = draw(
      row({
        document_kind: "sla",
        offer: null,
        offer_reference: null,
        service_tier: "Scale",
        commencement_date: "2026-10-01",
        status: "sent",
        docusign_envelope_id: "11111111-2222-4333-8444-555555555555",
        docusign_sent_at: ISSUED_AT,
      }),
    );
    expect(html).toContain("Service Level Agreement");
  });
});
