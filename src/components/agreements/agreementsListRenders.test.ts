/**
 * The Agreements list and the issuing profile page are drawn, not only
 * typechecked — the same reasoning, and the same stand-ins, as
 * `agreementPageRenders.test.ts`.
 *
 * The list is where every row's state is read at a glance, so it is drawn
 * with one row in each state both kinds of agreement reach: a draft, a send
 * running and one that stopped part-way, sent, signed with and without its
 * record retained, provisioned, voided and declined.
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
    createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
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
      isLoading: data === undefined,
      isFetching: false,
      error: null,
      refetch: async () => ({}),
    };
  },
  useMutation: () => ({
    mutate: () => undefined,
    mutateAsync: async () => undefined,
    isPending: false,
    variables: undefined,
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
    AGREEMENT_KINDS: ["sla", "subscription"],
    AGREEMENT_STATUSES: ["draft", "sent", "delivered", "signed", "declined", "voided"],
    SERVICE_TIERS: ["Launch", "Growth", "Scale", "Enterprise"],
    createAgreement: fn(),
    createSubscriptionAgreement: fn(),
    deleteDraftAgreement: fn(),
    downloadSignedAgreement: fn(),
    getAgreementsConfig: fn(),
    getSubscriptionContext: fn(),
    listAgreements: fn(),
    provisionAgreementNow: fn(),
    refreshAgreementStatus: fn(),
    saveIssuingProfile: fn(),
    searchAgreementClients: fn(),
    searchAgreementLeads: fn(),
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

import { Route as ListRoute } from "@/routes/agreements.index";
import { Route as ProfileRoute } from "@/routes/agreements.issuing-profile";
import type { AgreementListRow } from "@/lib/agreements.functions";
import { issuingProfileSchema } from "@/lib/agreements/subscriptionOffer.pure";
import { STALE_SEND_CLAIM_MS } from "@/lib/agreements/subscriptionIssue.pure";
import { COMPLETE_PROFILE, RATE_CARD } from "@/lib/agreements/subscriptionFixtures";

let n = 0;
function row(over: Partial<AgreementListRow> = {}): AgreementListRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    account_id: null,
    addon_slugs: [],
    admin_email: null,
    client_email: `client${n}@customer.test`,
    client_name: `Client ${n}`,
    client_org: `Organisation ${n} Pty Ltd`,
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
    lead_id: null,
    metadata: {},
    module_ids: [],
    notes: null,
    offer_reference: `AUR-SUB-TEST-${String(n).padStart(4, "0")}`,
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

const ENVELOPE = { docusign_envelope_id: "11111111-2222-4333-8444-555555555555" };
const SENT = {
  ...ENVELOPE,
  status: "sent",
  docusign_status: "sent",
  docusign_sent_at: "2026-09-25T02:00:00.000Z",
  issued_at: "2026-09-25T02:00:00.000Z",
};
const SIGNED = { ...SENT, status: "signed", docusign_signed_at: "2026-09-26T02:00:00.000Z" };

const ROWS: AgreementListRow[] = [
  row(),
  row({ issued_at: new Date(Date.now() - 60_000).toISOString() }),
  row({ issued_at: new Date(Date.now() - STALE_SEND_CLAIM_MS - 60_000).toISOString() }),
  row(SENT),
  row({ ...SIGNED, provision_on_signature: true, provision_status: "armed" }),
  row({
    ...SIGNED,
    signed_record_path: "subscription/a/b-signed.pdf",
    provision_on_signature: true,
    provision_status: "provisioned",
    provisioned_clone_id: "00000000-0000-4000-8000-0000000000cc",
  }),
  row({
    ...SIGNED,
    signed_record_path: "subscription/a/c-signed.pdf",
    provision_status: "failed",
    provision_error: "GitHub refused the repository",
  }),
  row({
    ...SENT,
    status: "voided",
    docusign_voided_at: "2026-09-27T02:00:00.000Z",
    void_reason: "Wrong term",
  }),
  row({ ...SENT, status: "declined" }),
  row({ document_kind: "sla", offer_reference: null, service_tier: "Scale" }),
  row({ document_kind: "sla", offer_reference: null, ...SENT, status: "delivered" }),
  row({
    document_kind: "sla",
    offer_reference: null,
    ...SIGNED,
    provision_on_signature: true,
    provision_status: "provisioning",
  }),
];

function context(profile = COMPLETE_PROFILE) {
  return {
    profile,
    profileStored: true,
    profileValid: true,
    profileUpdatedAt: "2026-09-24T00:00:00.000Z",
    rateCard: RATE_CARD,
    today: "2026-09-25",
  };
}

function drawList(
  opts: { rows?: AgreementListRow[]; configured?: boolean; profile?: typeof COMPLETE_PROFILE } = {},
) {
  h.queries.clear();
  h.queries.set(JSON.stringify(["agreements", "config"]), {
    configured: opts.configured ?? true,
    missing: opts.configured === false ? ["DOCUSIGN_INTEGRATION_KEY"] : [],
    baseUrl: "https://demo.docusign.net/restapi",
    countersigner: null,
  });
  h.queries.set(JSON.stringify(["agreements", "subscription-context"]), context(opts.profile));
  h.queries.set(JSON.stringify(["agreements", "list", "all", "all", ""]), {
    agreements: opts.rows ?? ROWS,
  });
  const component = (ListRoute as unknown as { options: { component: () => ReactNode } }).options
    .component;
  return renderToStaticMarkup(createElement(component));
}

function drawProfile(profile = COMPLETE_PROFILE) {
  h.queries.clear();
  h.queries.set(JSON.stringify(["agreements", "subscription-context"]), context(profile));
  const component = (ProfileRoute as unknown as { options: { component: () => ReactNode } }).options
    .component;
  return renderToStaticMarkup(createElement(component));
}

describe("the Agreements list", () => {
  it("draws a row in every state both kinds of agreement reach", () => {
    const html = drawList();
    for (const r of ROWS) expect(html).toContain(r.client_name);
    expect(html).toContain("sending");
    expect(html).toContain("send interrupted");
  });

  it("draws with nothing to list", () => {
    drawList({ rows: [] });
  });

  it("says what the issuing profile still lacks, and when DocuSign is not connected", () => {
    const html = drawList({ configured: false, profile: issuingProfileSchema.parse({}) });
    expect(html).toContain("issuing profile");
  });

  it("offers the three templates to read", () => {
    const html = drawList();
    expect(html).toContain("aurixa-launch-subscription-agreement.docx");
    expect(html).toContain("aurixa-growth-subscription-agreement.docx");
    expect(html).toContain("aurixa-scale-subscription-agreement.docx");
  });
});

describe("the issuing profile page", () => {
  it("draws a complete profile for an administrator, with save", () => {
    const html = drawProfile();
    expect(html).toContain("Issuing profile");
    expect(html).toContain("Saved");
  });

  it("draws an empty profile, naming what is missing", () => {
    const html = drawProfile(issuingProfileSchema.parse({}));
    expect(html).toContain("still missing");
  });

  it("draws the profile read-only for an operator who is not an administrator", () => {
    h.isAdmin = false;
    try {
      const html = drawProfile();
      expect(html).toContain("Only an administrator can change the issuing profile");
      expect(html).not.toContain("Save profile");
    } finally {
      h.isAdmin = true;
    }
  });
});
