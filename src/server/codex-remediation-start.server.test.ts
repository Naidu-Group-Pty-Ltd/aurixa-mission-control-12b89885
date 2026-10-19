// Starting a security fix: what is refused, what is reused, and which engine
// the workflow is told to use — Claude for P0/P1, Codex below — checked at
// the dispatch the workflow receives.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as Array<{ table: string; op: string; values: Row }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let values: Row | undefined;
    const result = () => {
      if (op === "insert") {
        const row = { id: `${table}-new`, ...(values as Row) };
        (h.tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (op === "update") return { data: null, error: null };
      return {
        data: (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
        error: null,
      };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (v: Row) => {
        op = "insert";
        values = v;
        h.writes.push({ table, op, values: v });
        return b;
      },
      update: (v: Row) => {
        op = "update";
        values = v;
        h.writes.push({ table, op, values: v });
        return b;
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      limit: () => b,
      single: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      maybeSingle: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, bad),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/server/codex-callback-keys.server", () => ({
  REMEDIATION_CALLBACK_KEY_VERSION: 1,
  resolveRemediationMasterSecrets: async () => ({ current: "master-not-real", previous: null }),
  deriveCallbackKey: async (_m: string, _p: string, id: string) => `key-for-${id}`,
}));
vi.mock("@/server/codex-security-client.server", () => ({
  remediationCallbackUrl: () => "https://mc.example/api/public/hooks/codex-remediation",
}));
vi.mock("@/server/codex-remediation.server", () => ({
  dispatchRemediationWorkflow: vi.fn(async () => ({ workflowRunId: null, workflowRunUrl: null })),
}));

import { startRemediation } from "./codex-remediation-start.server";
import { dispatchRemediationWorkflow } from "@/server/codex-remediation.server";

const finding = (extra: Row = {}): Row => ({
  id: "f-1",
  codex_finding_id: "cf-0123456789",
  scan_job_id: "job-1",
  clone_id: null,
  pr_number: null,
  state: "open",
  severity: "critical",
  title: "SQL injection in report builder",
  description: "Concatenated input",
  affected_file: "src/report.ts",
  affected_line: 42,
  cwe: "CWE-89",
  snippet: "db.query(`...${id}`)",
  scanner: "semgrep",
  rule_id: "sqli",
  ...extra,
});

beforeEach(() => {
  h.writes = [];
  vi.mocked(dispatchRemediationWorkflow).mockClear();
  h.tables = {
    codex_findings: [finding()],
    codex_remediations: [],
    prime_config: [
      {
        github_owner: "acme",
        github_repo: "prime",
        default_branch: "main",
        github_app_installation_id: "42",
      },
    ],
  };
});

const start = (extra: Partial<Parameters<typeof startRemediation>[0]> = {}) =>
  startRemediation({ findingId: "f-1", requestedBy: null, source: "autofix", ...extra });

describe("startRemediation", () => {
  it.each([
    ["critical", "claude_code", "claude"],
    ["high", "claude_code", "claude"],
    ["medium", "codex_cli", "codex"],
    ["low", "codex_cli", "codex"],
    ["info", "codex_cli", "codex"],
  ])("sends a %s finding to %s", async (severity, engine, workflowEngine) => {
    h.tables.codex_findings = [finding({ severity })];
    expect(await start()).toMatchObject({ ok: true, reused: false, engine });
    const call = vi.mocked(dispatchRemediationWorkflow).mock.calls[0][0];
    expect(call.finding.engine).toBe(workflowEngine);
    expect(call).toMatchObject({ owner: "acme", repo: "prime", baseRef: "main" });
    expect(call.callbackSecret).toBe("key-for-codex_remediations-new");
    expect(call.branchName).toMatch(/^codex\/fix-[a-z0-9-]+-cf-01234-[0-9a-f]{4}$/);
    const row = h.writes.find((w) => w.table === "codex_remediations" && w.op === "insert");
    expect(row?.values).toMatchObject({ engine, requested_by: null, status: "queued" });
  });

  it("records who asked, and a person may name the engine", async () => {
    await start({ requestedBy: "user-1", source: "operator", engine: "codex_cli" });
    expect(vi.mocked(dispatchRemediationWorkflow).mock.calls[0][0].finding.engine).toBe("codex");
    const event = h.writes.find((w) => w.table === "codex_finding_events");
    expect(event?.values).toMatchObject({ actor: "user-1", event_type: "fix_requested" });
  });

  it("marks a fix it started by itself as such", async () => {
    await start();
    const event = h.writes.find((w) => w.table === "codex_finding_events");
    expect(event?.values).toMatchObject({ actor: null, event_type: "autofix.dispatched" });
  });

  it.each([
    ["a clone's finding", { clone_id: "c-1" }, /cascade/],
    ["a pull request's finding", { pr_number: 7 }, /pull request #7/],
    ["a dismissed finding", { state: "dismissed" }, /reopen it/],
  ])("refuses %s", async (_what, extra, error) => {
    h.tables.codex_findings = [finding(extra)];
    expect(await start()).toMatchObject({ ok: false, error: expect.stringMatching(error) });
    expect(dispatchRemediationWorkflow).not.toHaveBeenCalled();
  });

  it("reuses a fix already in flight instead of starting a second", async () => {
    h.tables.codex_remediations = [
      { id: "rem-1", finding_id: "f-1", status: "pr_opened", engine: "claude_code" },
    ];
    expect(await start()).toEqual({
      ok: true,
      remediationId: "rem-1",
      reused: true,
      engine: "claude_code",
    });
    expect(dispatchRemediationWorkflow).not.toHaveBeenCalled();
  });

  it("records a dispatch GitHub refused as a failed remediation", async () => {
    vi.mocked(dispatchRemediationWorkflow).mockRejectedValueOnce(new Error("404 no workflow"));
    expect(await start()).toMatchObject({ ok: false, error: "404 no workflow" });
    const failed = h.writes.find(
      (w) => w.table === "codex_remediations" && w.op === "update" && w.values.status === "failed",
    );
    expect(failed?.values.last_error).toBe("404 no workflow");
  });
});
