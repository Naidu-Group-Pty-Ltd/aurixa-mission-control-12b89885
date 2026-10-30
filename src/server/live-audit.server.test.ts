// The live audit's server side, against a fake Supabase: who a callback is
// believed from, what a believed callback may change, how a fix's pull request
// moves its finding, and what the sweep does with a run that went quiet.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data?: unknown; error?: { code?: string; message: string } | null };
type Query = { table: string; op: string; values?: unknown; filters: unknown[]; selected: boolean };

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown | ((q: Query) => unknown)>,
  receiptError: null as { code?: string; message: string } | null,
  writes: [] as Query[],
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResults: {} as Record<string, Result>,
  uploads: [] as Array<{ bucket: string; path: string; contentType?: string }>,
  notified: [] as Array<{ kind: string; title: string }>,
  selects: [] as Query[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const q: Query = { table, op: "select", values: undefined, filters: [], selected: false };
    const resolve = (): Result => {
      if (q.op === "select") {
        h.selects.push(q);
        const row = h.rows[table];
        return {
          data: typeof row === "function" ? (row as (x: Query) => unknown)(q) : (row ?? null),
          error: null,
        };
      }
      if (table === "live_audit_callback_receipts" && q.op === "insert")
        return { error: h.receiptError };
      // A write that asks for its rows back gets one, as a matching row would.
      return { data: q.selected ? [{ id: "moved" }] : null, error: null };
    };
    const b: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        if (["insert", "update", "delete", "upsert"].includes(name)) {
          q.op = name;
          q.values = args[0];
          h.writes.push(q);
        } else if (name === "select" && q.op !== "select") {
          q.selected = true;
        } else if (["eq", "in", "is", "lt", "gte", "neq", "not", "or"].includes(name)) {
          q.filters.push([name, ...args]);
        }
        return b;
      };
    for (const m of [
      "select",
      "insert",
      "update",
      "delete",
      "upsert",
      "eq",
      "in",
      "is",
      "lt",
      "gte",
      "neq",
      "not",
      "or",
      "order",
      "limit",
      "range",
    ]) {
      b[m] = chain(m);
    }
    b.maybeSingle = () => Promise.resolve(resolve());
    b.single = () => Promise.resolve(resolve());
    b.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(ok, bad);
    return b;
  }
  return {
    supabaseAdmin: {
      from,
      rpc: (fn: string, args: Record<string, unknown>) => {
        h.rpcs.push({ fn, args });
        return Promise.resolve(h.rpcResults[fn] ?? { data: {}, error: null });
      },
      storage: {
        from: (bucket: string) => ({
          upload: (path: string, _bytes: unknown, opts: { contentType?: string }) => {
            h.uploads.push({ bucket, path, contentType: opts?.contentType });
            return Promise.resolve({ data: { path }, error: null });
          },
        }),
      },
    },
  };
});

vi.mock("@/server/audit.server", () => ({
  notifyOperators: vi.fn(async (n: { kind: string; title: string }) => {
    h.notified.push({ kind: n.kind, title: n.title });
    return true;
  }),
  writeAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/server/codex-pr-checks.server", () => ({
  completePrCheckForJob: vi.fn(async () => undefined),
}));
vi.mock("@/server/cascade-trigger.server", () => ({
  evaluateCascadeSecurityGate: vi.fn(async () => ({ hold: false, reason: null })),
  holdPendingCommitCascades: vi.fn(async () => 0),
}));
vi.mock("@/server/github-app.server", () => ({
  getAppOctokit: () => {
    throw new Error("no GitHub in a unit test");
  },
}));
vi.mock("@/server/codex-security-client.server", () => ({
  appPublicOrigin: () => "https://mc.example",
}));

import { deriveCallbackKey } from "./codex-callback-keys.server";
import { deriveLiveAuditKey } from "./live-audit-keys.server";
import { EVIDENCE_BUCKET, handleLiveAuditCallback } from "./live-audit-callback.server";
import { findingStateForFixEvent, handleLiveAuditFixCallback } from "./live-audit-fix.server";
import { syncLiveAuditFixPullRequest } from "./live-audit-pr-sync.server";
import {
  RUN_TIMEOUT_MINUTES,
  START_TIMEOUT_MINUTES,
  sweepVerdict,
  type SweepRun,
} from "./live-audit-sweep.server";
import { runAlert } from "./live-audit-alerts.server";
import { MAX_DISPATCH_ATTEMPTS } from "./live-audit-dispatch.server";

const MASTER = "test-live-audit-master-not-a-real-one";
const RUN_ID = "3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const FIX_ID = "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d";
const FINDING_ID = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const REPO = "acme/prime";
const BRANCH = "live-audit/fix-clients-crash-aaaaaaaa-a1b2c3";

const hmac = (key: string, msg: string) =>
  crypto.createHmac("sha256", key).update(msg).digest("hex");

function signed(
  key: string,
  body: string,
  names: [string, string],
  ts = Math.floor(Date.now() / 1000),
) {
  return { [names[0]]: `sha256=${hmac(key, `${ts}.${body}`)}`, [names[1]]: String(ts) };
}
const RUN_HEADERS: [string, string] = ["x-live-audit-signature", "x-live-audit-timestamp"];
const FIX_HEADERS: [string, string] = ["x-codex-signature", "x-codex-timestamp"];

function post(body: string, headers: Record<string, string>) {
  return new Request("https://mc.example/api/public/hooks/live-audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const runRow = (status = "running") => ({
  id: RUN_ID,
  target_key: "prime",
  status,
  repo_full_name: REPO,
  phases: {},
  started_at: null,
});

async function callRun(event: Record<string, unknown>, opts: { key?: string; ts?: number } = {}) {
  const body = JSON.stringify({ run_id: RUN_ID, runner_version: 1, ...event });
  const key = opts.key ?? (await deriveLiveAuditKey(MASTER, "run", RUN_ID));
  return handleLiveAuditCallback(post(body, signed(key, body, RUN_HEADERS, opts.ts)));
}

beforeEach(() => {
  h.rows = { live_audit_runs: runRow() };
  h.receiptError = null;
  h.writes = [];
  h.rpcs = [];
  h.rpcResults = {};
  h.uploads = [];
  h.notified = [];
  h.selects = [];
  process.env.LIVE_AUDIT_WEBHOOK_SECRET = MASTER;
  delete process.env.LIVE_AUDIT_WEBHOOK_SECRET_PREVIOUS;
});

describe("the keys", () => {
  it("derive one key per run and per fix, under the live audit's own label", async () => {
    const run = await deriveLiveAuditKey(MASTER, "run", RUN_ID);
    expect(run).toBe(hmac(MASTER, `aurixa-live-audit-callback:v1:run:${RUN_ID}`));
    expect(await deriveLiveAuditKey(MASTER, "fix", RUN_ID)).not.toBe(run);
    expect(await deriveLiveAuditKey(MASTER, "run", FIX_ID)).not.toBe(run);
    // Never a Codex key, even under the same master.
    expect(await deriveCallbackKey(MASTER, "scan", RUN_ID)).not.toBe(run);
  });
});

describe("a run's callback is believed only from that run", () => {
  it("answers an unknown run and a bad signature alike", async () => {
    h.rows.live_audit_runs = null;
    expect((await callRun({ event: "run.context" })).status).toBe(401);
    h.rows.live_audit_runs = runRow();
    expect((await callRun({ event: "run.context" }, { key: "0".repeat(64) })).status).toBe(401);
    const bad = await handleLiveAuditCallback(
      post(JSON.stringify({ run_id: "nope", event: "run.context" }), {}),
    );
    expect(bad.status).toBe(401);
  });

  it("refuses another run's key, a fix's key and a Codex key for the same id", async () => {
    const other = await deriveLiveAuditKey(MASTER, "run", FIX_ID);
    expect((await callRun({ event: "run.context" }, { key: other })).status).toBe(401);
    const fixKey = await deriveLiveAuditKey(MASTER, "fix", RUN_ID);
    expect((await callRun({ event: "run.context" }, { key: fixKey })).status).toBe(401);
    const codex = await deriveCallbackKey(MASTER, "scan", RUN_ID);
    expect((await callRun({ event: "run.context" }, { key: codex })).status).toBe(401);
  });

  it("refuses a stale signature", async () => {
    const res = await callRun(
      { event: "run.context" },
      { ts: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(res.status).toBe(401);
  });

  it("refuses a closed run, and a workflow run outside Prime's repository", async () => {
    h.rows.live_audit_runs = runRow("completed");
    expect((await callRun({ event: "run.progress", phase: "crawl" })).status).toBe(409);
    h.rows.live_audit_runs = runRow();
    const res = await callRun({
      event: "run.progress",
      phase: "crawl",
      workflow_run_url: "https://github.com/someone/else/actions/runs/1",
    });
    expect(res.status).toBe(400);
  });

  it("processes a replay once", async () => {
    h.receiptError = { code: "23505", message: "duplicate" };
    const res = await callRun({ event: "run.progress", phase: "crawl" });
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(h.writes.filter((w) => w.table === "live_audit_runs")).toHaveLength(0);
  });
});

describe("what a believed run may change", () => {
  it("starts the run, but never reopens one the sweep closed", async () => {
    const res = await callRun({
      event: "run.started",
      mode: "live",
      auth: { state: "signed_in" },
      anthropic: { available: false, reason: "no key" },
      workflow_run_url: `https://github.com/${REPO}/actions/runs/7`,
    });
    expect(res.status).toBe(200);
    const update = h.writes.find((w) => w.table === "live_audit_runs" && w.op === "update")!;
    expect(update.values).toMatchObject({
      status: "running",
      auth_state: "signed_in",
      workflow_run_url: `https://github.com/${REPO}/actions/runs/7`,
    });
    expect(update.filters).toContainEqual(["in", "status", ["queued", "dispatched", "running"]]);
  });

  it("hands the runner what Mission Control already knows", async () => {
    h.rows.live_audit_findings = [{ fingerprint: "a".repeat(64), state: "dismissed" }];
    const res = await callRun({ event: "run.context" });
    expect(await res.json()).toEqual({
      ok: true,
      findings: [{ fingerprint: "a".repeat(64), state: "dismissed" }],
    });
    const read = h.selects.find((s) => s.table === "live_audit_findings")!;
    expect(read.filters).toContainEqual(["neq", "state", "resolved"]);
  });

  it("ingests findings in Postgres and keeps their screenshots in the private bucket", async () => {
    const id = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
    h.rpcResults.live_audit_ingest_findings = {
      data: { inserted: 1, updated: 0, regressions: 0, ids: [{ fingerprint: "a".repeat(64), id }] },
      error: null,
    };
    const res = await callRun({
      event: "run.findings",
      batch: { index: 0, count: 1 },
      findings: [
        {
          fingerprint: "a".repeat(64),
          detector: "page_error",
          category: "crash",
          severity: "high",
          title: "Crash",
          route_template: "/clients/:id",
          screenshot: { mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
        },
      ],
    });
    expect(res.status).toBe(200);
    const ingest = h.rpcs.find((r) => r.fn === "live_audit_ingest_findings")!;
    expect(ingest.args.p_run_id).toBe(RUN_ID);
    const rows = ingest.args.p_findings as Array<Record<string, unknown>>;
    expect(rows[0]).not.toHaveProperty("screenshot");
    expect(h.uploads).toEqual([
      { bucket: EVIDENCE_BUCKET, path: `prime/${id}/latest.jpg`, contentType: "image/jpeg" },
    ]);
    const path = h.writes.find((w) => w.table === "live_audit_findings" && w.op === "update")!;
    expect(path.values).toEqual({ screenshot_path: `prime/${id}/latest.jpg` });
  });

  it("fails the callback, so the runner retries, when the ingest fails", async () => {
    h.rpcResults.live_audit_ingest_findings = {
      data: null,
      error: { message: "deadlock detected" },
    };
    const res = await callRun({
      event: "run.findings",
      batch: { index: 0, count: 1 },
      findings: [
        {
          fingerprint: "b".repeat(64),
          detector: "x",
          category: "crash",
          severity: "low",
          title: "t",
        },
      ],
    });
    expect(res.status).toBe(500);
    // The receipt is given back, so the retry is processed rather than refused.
    expect(
      h.writes.some((w) => w.table === "live_audit_callback_receipts" && w.op === "delete"),
    ).toBe(true);
  });

  it("finalises on what the runner said it covered, and resolves nothing on an incomplete run", async () => {
    h.rpcResults.live_audit_finalize_run = { data: { resolved: 0 }, error: null };
    await callRun({
      event: "run.completed",
      summary: { complete: true, coverage: { templates_covered: ["/a", "/b/:id"] } },
    });
    expect(h.rpcs.at(-1)!.args).toMatchObject({
      p_run_id: RUN_ID,
      p_complete: true,
      p_covered: ["/a", "/b/:id"],
    });
    await callRun({
      event: "run.completed",
      summary: { complete: "yes", coverage: { templates_covered: ["/a"] } },
    });
    expect(h.rpcs.at(-1)!.args).toMatchObject({ p_complete: false });
  });

  it("records a failure with its reason", async () => {
    const res = await callRun({ event: "run.failed", phase: "workflow", error: "npm ci failed" });
    expect(res.status).toBe(200);
    const update = h.writes.find((w) => w.table === "live_audit_runs" && w.op === "update")!;
    expect(update.values).toMatchObject({ status: "failed", last_error: "npm ci failed" });
    expect(update.filters).toContainEqual(["in", "status", ["queued", "dispatched", "running"]]);
  });
});

describe("a fix's callback", () => {
  const fixRow = (over: Record<string, unknown> = {}) => ({
    id: FIX_ID,
    finding_id: FINDING_ID,
    status: "dispatched",
    repo_full_name: REPO,
    branch_name: BRANCH,
    head_sha: null,
    ...over,
  });

  async function callFix(event: Record<string, unknown>, key?: string) {
    const body = JSON.stringify({ remediation_id: FIX_ID, ...event });
    const k = key ?? (await deriveLiveAuditKey(MASTER, "fix", FIX_ID));
    return handleLiveAuditFixCallback(post(body, signed(k, body, FIX_HEADERS)));
  }

  beforeEach(() => {
    h.rows.live_audit_fixes = fixRow();
    h.rows.live_audit_findings = {
      id: FINDING_ID,
      state: "fix_in_progress",
      title: "Clients crash",
      severity: "high",
    };
  });

  it("is signed with the fix's own key, as the remediation workflow signs", async () => {
    const res = await callFix({
      event: "pr.opened",
      branch_name: BRANCH,
      pr_number: 12,
      pr_url: `https://github.com/${REPO}/pull/12`,
      model: "claude-opus-5-5",
    });
    expect(res.status).toBe(200);
    const fix = h.writes.find((w) => w.table === "live_audit_fixes" && w.op === "update")!;
    expect(fix.values).toMatchObject({ status: "pr_opened", pr_number: 12 });
    const finding = h.writes.find((w) => w.table === "live_audit_findings" && w.op === "update")!;
    expect(finding.values).toEqual({ state: "fix_pr_open" });
    expect(h.notified).toEqual([
      { kind: "live_audit_fix_ready", title: "Claude drafted a fix: Clients crash" },
    ]);
  });

  it("refuses a run's key, and a Codex remediation key, for the same id", async () => {
    expect(
      (
        await callFix(
          { event: "workflow.started" },
          await deriveLiveAuditKey(MASTER, "run", FIX_ID),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await callFix(
          { event: "workflow.started" },
          await deriveCallbackKey(MASTER, "remediation", FIX_ID),
        )
      ).status,
    ).toBe(401);
  });

  it("refuses another branch and a pull request in another repository", async () => {
    expect(
      (await callFix({ event: "branch.pushed", branch_name: "live-audit/fix-other-bbbbbbbb-x" }))
        .status,
    ).toBe(400);
    expect(
      (
        await callFix({
          event: "pr.opened",
          branch_name: BRANCH,
          pr_number: 3,
          pr_url: "https://github.com/else/where/pull/3",
        })
      ).status,
    ).toBe(400);
  });

  it("says nothing more once the fix is closed", async () => {
    h.rows.live_audit_fixes = fixRow({ status: "merged" });
    expect((await callFix({ event: "pr.updated", branch_name: BRANCH })).status).toBe(409);
  });
});

describe("how a fix event moves its finding", () => {
  it.each([
    ["workflow.started", "fix_queued", "fix_in_progress"],
    ["branch.pushed", "fix_in_progress", null],
    ["pr.opened", "fix_in_progress", "fix_pr_open"],
    ["pr.merged", "fix_pr_open", "fix_merged"],
    ["pr.closed", "fix_pr_open", "open"],
    ["workflow.failed", "fix_queued", "open"],
    // A person's decision is never overridden by the fix lane.
    ["pr.opened", "dismissed", null],
    ["workflow.failed", "resolved", null],
  ])("%s from %s → %s", (event, from, to) => {
    expect(findingStateForFixEvent(event, from)).toBe(to);
  });
});

describe("a fix's pull request, from the GitHub webhook", () => {
  it("costs nothing for any branch that is not a live-audit fix", async () => {
    const r = await syncLiveAuditFixPullRequest({
      repoFullName: REPO,
      prNumber: 4,
      headRef: "codex/fix-something",
      action: "closed",
      merged: true,
      headSha: null,
      mergedAt: null,
    });
    expect(r).toEqual({ fixes: 0 });
    expect(h.selects).toHaveLength(0);
  });

  it("marks a merged fix merged and its finding awaiting confirmation", async () => {
    h.rows.live_audit_fixes = [
      {
        id: FIX_ID,
        finding_id: FINDING_ID,
        status: "pr_opened",
        head_sha: null,
        pr_number: 12,
        repo_full_name: "Acme/Prime",
      },
    ];
    h.rows.live_audit_findings = { id: FINDING_ID, state: "fix_pr_open" };
    const r = await syncLiveAuditFixPullRequest({
      repoFullName: REPO,
      prNumber: 12,
      headRef: BRANCH,
      action: "closed",
      merged: true,
      headSha: "c".repeat(40),
      mergedAt: "2026-10-30T01:00:00Z",
    });
    expect(r).toEqual({ fixes: 1 });
    const fix = h.writes.find((w) => w.table === "live_audit_fixes")!;
    expect(fix.values).toMatchObject({ status: "merged", merged_at: "2026-10-30T01:00:00Z" });
    expect(fix.filters).toContainEqual(["in", "status", ["dispatched", "pr_opened", "pr_updated"]]);
    const finding = h.writes.find((w) => w.table === "live_audit_findings")!;
    expect(finding.values).toEqual({ state: "fix_merged" });
    const event = h.writes.find((w) => w.table === "live_audit_events")!;
    expect(event.values).toMatchObject({
      event_type: "fix.merged",
      payload: { pr: 12, via: "webhook" },
    });
  });

  it("ignores a pull request with the branch's name in another repository", async () => {
    h.rows.live_audit_fixes = [
      {
        id: FIX_ID,
        finding_id: FINDING_ID,
        status: "pr_opened",
        head_sha: null,
        pr_number: 12,
        repo_full_name: "fork/prime",
      },
    ];
    const r = await syncLiveAuditFixPullRequest({
      repoFullName: REPO,
      prNumber: 12,
      headRef: BRANCH,
      action: "closed",
      merged: false,
      headSha: null,
      mergedAt: null,
    });
    expect(r).toEqual({ fixes: 0 });
    expect(h.writes).toHaveLength(0);
  });
});

describe("the sweep", () => {
  const NOW = Date.parse("2026-10-30T12:00:00Z");
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const run = (over: Partial<SweepRun>): SweepRun => ({
    id: RUN_ID,
    status: "queued",
    dispatch_attempts: 1,
    next_attempt_at: null,
    last_error: null,
    created_at: ago(1),
    dispatched_at: null,
    started_at: null,
    ...over,
  });

  it("retries a refused dispatch when it is due, and gives up after the last attempt", () => {
    expect(sweepVerdict(run({ next_attempt_at: ago(-5) }), NOW)).toBeNull();
    expect(sweepVerdict(run({ next_attempt_at: ago(1) }), NOW)).toEqual({ act: "redispatch" });
    const failed = sweepVerdict(
      run({ dispatch_attempts: MAX_DISPATCH_ATTEMPTS, last_error: "404" }),
      NOW,
    );
    expect(failed).toMatchObject({ act: "fail", event: "run.dispatch_failed" });
    expect(failed?.act === "fail" && failed.reason).toContain("404");
  });

  it("leaves a run being dispatched right now alone, and picks up one whose request died", () => {
    expect(sweepVerdict(run({ dispatch_attempts: 0, created_at: ago(1) }), NOW)).toBeNull();
    expect(sweepVerdict(run({ dispatch_attempts: 0, created_at: ago(15) }), NOW)).toEqual({
      act: "redispatch",
    });
  });

  it("fails a run that never started, and one that outlived its job", () => {
    expect(
      sweepVerdict(
        run({ status: "dispatched", dispatched_at: ago(START_TIMEOUT_MINUTES - 1) }),
        NOW,
      ),
    ).toBeNull();
    expect(
      sweepVerdict(
        run({ status: "dispatched", dispatched_at: ago(START_TIMEOUT_MINUTES + 1) }),
        NOW,
      ),
    ).toMatchObject({
      act: "fail",
      event: "run.never_started",
    });
    expect(
      sweepVerdict(run({ status: "running", started_at: ago(RUN_TIMEOUT_MINUTES - 5) }), NOW),
    ).toBeNull();
    expect(
      sweepVerdict(run({ status: "running", started_at: ago(RUN_TIMEOUT_MINUTES + 5) }), NOW),
    ).toMatchObject({
      act: "fail",
      event: "run.timed_out",
    });
    expect(sweepVerdict(run({ status: "completed" }), NOW)).toBeNull();
  });
});

describe("what interrupts a person", () => {
  it("is new severe defects and regressions, and nothing else", () => {
    expect(runAlert({ newSevere: [], regressions: 0 })).toBeNull();
    const a = runAlert({
      newSevere: [{ title: "Crash", severity: "critical", route_template: "/a" }],
      regressions: 2,
    })!;
    expect(a.severity).toBe("error");
    expect(a.title).toBe(
      "Live audit of Prime: 1 new critical or high-severity defect, 2 defects back after being resolved or fixed",
    );
    expect(a.body).toBe("• [critical] Crash (/a)");
    expect(runAlert({ newSevere: [], regressions: 1 })!.severity).toBe("warning");
  });
});
