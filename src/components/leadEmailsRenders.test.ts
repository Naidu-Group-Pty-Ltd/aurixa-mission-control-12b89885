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
    setLeadEmailTeamAlertsFn: fn,
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
    teamAlerts: { recipients: null, stages: null },
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
  teamAlerts: {
    recipients: ["trials@aurixasystems.com.au"],
    source: "mailbox_fallback",
    stages: [1, 2, 3],
    dropped: [],
    env: { recipients: [], stages: [1, 2, 3] },
    limit: 25,
  },
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

  it("shows the stage's send gate, from the rules the dispatcher applies", () => {
    const html = show(overview());
    expect(html).toContain("send gate");
    expect(html).toContain("Send Stage 2 Invite");
    expect(html).toContain("Applicant already reached Stage 2");
    expect(html).toContain("The lead is Disqualified on the Leads page.");
  });

  it("says only the sending mailbox hears about a lead while no team list is set", () => {
    const html = show(overview());
    expect(html).toContain("team alerts");
    expect(html).toContain("goes to trials@aurixasystems.com.au only");
    expect(html).toContain("only the sending mailbox (trials@aurixasystems.com.au) is told");
    expect(html).toContain("Save team alerts");
    for (const s of LEAD_STAGES) expect(html).toContain(`id="lead-team-alert-${s}"`);
  });

  it("shows the saved list and the stages it is on for", () => {
    const team = ["admin@aurixasystems.com.au", "rugesh@aurixasystems.com.au"];
    const html = show(
      overview({
        settings: { ...overview().settings, teamAlerts: { recipients: team, stages: [1, 3] } },
        teamAlerts: {
          recipients: team,
          source: "configured",
          stages: [1, 3],
          dropped: [],
          env: { recipients: [], stages: [1, 2, 3] },
          limit: 25,
        },
      }),
    );
    expect(html).toContain("goes to 2 people");
    expect(html).toContain("admin@aurixasystems.com.au\nrugesh@aurixasystems.com.au");
    const stageSwitch = (s: number) =>
      new RegExp(`<button[^>]*id="lead-team-alert-${s}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(stageSwitch(1)).toContain('aria-checked="true"');
    expect(stageSwitch(2)).toContain('aria-checked="false"');
    expect(stageSwitch(3)).toContain('aria-checked="true"');
    expect(html).not.toContain("only the sending mailbox");
  });

  it("names the deployment's list while the console has none, and what it left off", () => {
    const html = show(
      overview({
        teamAlerts: {
          recipients: ["a@x.com"],
          source: "configured",
          stages: [1, 2, 3],
          dropped: [
            { value: "Rugesh Naidu", reason: "not an address this deployment can send to" },
          ],
          env: { recipients: ["a@x.com"], stages: [1, 2, 3] },
          limit: 25,
        },
      }),
    );
    expect(html).toContain("LEAD_STAGE_INTERNAL_RECIPIENTS</code> decides");
    expect(html).toContain("&quot;Rugesh Naidu&quot; (not an address this deployment can send to)");
  });

  it("does not offer to save the team alerts to somebody who is not an administrator", () => {
    h.isAdmin = false;
    const html = show(overview());
    expect(html).toContain("team alerts");
    expect(html).not.toContain("Save team alerts");
    expect(/<textarea[^>]*id="lead-team-alerts"[^>]*>/.exec(html)?.[0]).toContain("disabled");
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
