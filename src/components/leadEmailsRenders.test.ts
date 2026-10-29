/**
 * Email → Lead emails, rendered.
 *
 * The renderer, the dispatcher and the questionnaire link have their own
 * tests; these prove the page draws from what `getLeadEmailsFn` returns — who
 * sends each stage, the sending identity, the editor with the stage's copy,
 * the problems that stand between a draft and Save, and the preview built by
 * the same code the dispatcher sends with — without a browser.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_LEAD_EMAIL_TEMPLATES,
  LEAD_STAGES,
  templateProblems,
  templateWarnings,
  type LeadEmailTemplate,
  type LeadStage,
} from "@/lib/leadEmailTemplates.pure";

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
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = h.queries.get(JSON.stringify(queryKey));
    return {
      data,
      isPending: data === undefined,
      isFetching: false,
      isError: false,
      error: null,
      dataUpdatedAt: 0,
      refetch: async () => undefined,
    };
  },
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("@/server/lead-emails.functions", () => {
  const fn = async () => undefined;
  return {
    getLeadEmailsFn: fn,
    listPreviewLeadsFn: fn,
    previewLeadEmailFn: fn,
    resetLeadEmailTemplateFn: fn,
    saveLeadEmailSettingsFn: fn,
    saveLeadEmailTemplateFn: fn,
    sendLeadEmailTestFn: fn,
    setLeadEmailSenderFn: fn,
  };
});
vi.mock("@/components/email/tenant-select", async () => {
  const { createElement: el } = await import("react");
  return {
    TenantSelect: ({ value, disabled }: { value: string | null; disabled?: boolean }) =>
      el("div", { "data-tenant": value ?? "default", "data-disabled": String(Boolean(disabled)) }),
  };
});
vi.mock("@/components/email/mailbox-picker", async () => {
  const { createElement: el } = await import("react");
  return {
    MailboxPicker: ({ value }: { value: string }) =>
      el("div", { "data-mailbox": value || "default" }),
  };
});
vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/route-error", () => ({ RouteError: () => null }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/use-user-roles", () => ({
  useUserRoles: () => ({ loading: false, isAdmin: h.isAdmin }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ session: null }) }));

const { Route } = await import("@/routes/email.lead-emails");

const record = (
  stage: LeadStage,
  template: LeadEmailTemplate = DEFAULT_LEAD_EMAIL_TEMPLATES[stage],
) => ({
  stage,
  template,
  isDefault: template === DEFAULT_LEAD_EMAIL_TEMPLATES[stage],
  updatedAt: template === DEFAULT_LEAD_EMAIL_TEMPLATES[stage] ? null : "2026-10-29T00:00:00.000Z",
  updatedBy: null,
  problems: templateProblems(stage, template),
  warnings: templateWarnings(stage, template),
});

const overview = (over: Record<string, unknown> = {}) => ({
  schemaPending: false,
  error: null,
  settings: {
    senders: { 1: "make", 2: "make", 3: "make" },
    tenantId: null,
    fromMailbox: "trials@aurixasystems.com.au",
    fromName: "Aurixa Systems",
    replyTo: "admin@aurixasystems.com.au",
    updatedAt: "2026-10-29T00:00:00.000Z",
    updatedBy: null,
  },
  templates: LEAD_STAGES.map((stage) => record(stage)),
  defaults: DEFAULT_LEAD_EMAIL_TEMPLATES,
  identity: {
    ok: true,
    mailbox: "trials@aurixasystems.com.au",
    supportEmail: "admin@aurixasystems.com.au",
  },
  graphConfigured: true,
  envMailbox: "hello@aurixasystems.com.au",
  applicantMode: "auto",
  applicantStages: [1, 2, 3],
  recent: [],
  ...over,
});

const show = (data: Record<string, unknown>) => {
  h.queries.set(JSON.stringify(["email", "lead-emails"]), data);
  return renderToStaticMarkup(
    createElement(
      (Route as unknown as { options: { component: () => ReactNode } }).options.component,
    ),
  );
};

beforeEach(() => {
  h.queries.clear();
  h.isAdmin = true;
});

describe("Email → Lead emails", () => {
  it("shows who sends each stage and the identity they send as", () => {
    const html = show(overview());
    expect(html).toContain("Application received");
    expect(html).toContain("Questionnaire received");
    expect(html).toContain("Review confirmed");
    expect(html.match(/Make sends<\/div>|Make sends</g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("sends from trials@aurixasystems.com.au");
    expect(html).toContain('data-mailbox="trials@aurixasystems.com.au"');
    expect(html).toContain('value="Aurixa Systems"');
    expect(html).toContain("hello@aurixasystems.com.au");
  });

  it("opens on Stage 1 with its copy in the editor and the Make module it replaces", () => {
    const html = show(overview());
    expect(html).toContain('value="Application received — your Aurixa Systems free trial"');
    expect(html).toContain("9389960");
    expect(html).toContain("Send it from Mission Control");
    // The questionnaire link is a Stage 1 field; the booking link is not.
    expect(html).toContain("{{questionnaire_url}}");
    expect(html).not.toContain("{{booking_url}}");
  });

  it("previews the email in a sandboxed frame, drawn from the template", () => {
    const html = show(overview());
    const frame = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(frame).toContain('sandbox=""');
    expect(frame).toContain("srcDoc=");
    // Sample values are merged and escaped into the document.
    expect(frame).toContain("Jordan");
    expect(html).toContain("Sample values. Choose an applicant above");
  });

  it("offers the hand-back once Mission Control sends a stage", () => {
    const html = show(
      overview({
        settings: {
          ...overview().settings,
          senders: { 1: "mission_control", 2: "make", 3: "make" },
        },
      }),
    );
    expect(html).toContain("Mission Control sends this email");
    expect(html).toContain("Hand back to Make");
    expect(html).toContain("Mission Control sends</div>");
  });

  it("lists the problems that stand between a draft and Save", () => {
    const broken = {
      ...DEFAULT_LEAD_EMAIL_TEMPLATES[1],
      subject: "Hello {{frist_name}}",
    };
    const html = show(overview({ templates: [record(1, broken), record(2), record(3)] }));
    expect(html).toContain("fix before saving");
    expect(html).toContain("frist_name");
    expect(html).toContain("1 to fix");
  });

  it("is read-only for an operator who is not an administrator", () => {
    h.isAdmin = false;
    const html = show(overview());
    expect(html).toContain("Only an administrator can change these emails");
    expect(html).not.toContain("Send it from Mission Control");
    expect(html).not.toContain("Save sending identity");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="Application received/);
  });

  it("says when the migration has not applied, and saves nothing until it has", () => {
    const html = show(overview({ schemaPending: true, settings: null, identity: null }));
    expect(html).toContain("the migration that adds them has");
    expect(html).not.toContain("Save sending identity");
  });

  it("warns when the deployment switches applicant email off whatever is chosen", () => {
    expect(show(overview({ applicantMode: "off" }))).toContain("LEAD_STAGE_APPLICANT_MODE=off");
    expect(show(overview({ applicantStages: [1, 3] }))).toContain("leaves out stage 2");
  });

  it("lists what Mission Control raised for applicants", () => {
    const html = show(
      overview({
        recent: [
          {
            id: "r1",
            lead_id: "l1",
            stage: 1,
            status: "sent",
            reason: null,
            sent_at: "2026-10-29T00:00:00.000Z",
            created_at: "2026-10-29T00:00:00.000Z",
            to_address: "ada@example.com",
            last_error: null,
            subject: "Application received — your Aurixa Systems free trial",
          },
          {
            id: "r2",
            lead_id: "l2",
            stage: 2,
            status: "skipped",
            reason: "the workflow already emailed the applicant",
            sent_at: null,
            created_at: "2026-10-29T00:00:00.000Z",
            to_address: "grace@example.com",
            last_error: null,
            subject: null,
          },
        ],
      }),
    );
    expect(html).toContain("ada@example.com");
    expect(html).toContain("the workflow already emailed the applicant");
  });
});
