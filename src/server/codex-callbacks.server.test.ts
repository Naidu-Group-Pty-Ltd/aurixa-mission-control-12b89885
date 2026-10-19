// The Codex scan and remediation webhooks: who is believed, and what a
// believed callback may change. Run against a fake Supabase so the order of
// the checks — job lookup, per-job key, timestamp, closed job, repository,
// replay — is what is under test.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data?: unknown; error?: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  receiptError: null as { code?: string; message: string } | null,
  writes: [] as Array<{ table: string; op: string; values?: unknown; filters: unknown[] }>,
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResults: {} as Record<string, Result>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const state = { table, op: "select", values: undefined as unknown, filters: [] as unknown[] };
    const resolve = (): Result => {
      if (state.op === "select") {
        return { data: h.rows[table] ?? null, error: null };
      }
      if (table === "codex_callback_receipts" && state.op === "insert") {
        return { error: h.receiptError };
      }
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        if (name === "insert" || name === "update" || name === "delete" || name === "upsert") {
          state.op = name;
          state.values = args[0];
          h.writes.push({ table, op: name, values: args[0], filters: state.filters });
        } else if (["eq", "in", "is", "lt", "gte", "neq"].includes(name)) {
          state.filters.push([name, ...args]);
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
      "order",
      "limit",
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
      rpc: (fn: string, args: unknown) => {
        h.rpcs.push({ fn, args });
        return Promise.resolve(h.rpcResults[fn] ?? { data: {}, error: null });
      },
    },
  };
});

vi.mock("@/server/codex-pr-checks.server", () => ({
  completePrCheckForJob: vi.fn(async () => undefined),
}));
vi.mock("@/server/cascade-trigger.server", () => ({
  evaluateCascadeSecurityGate: vi.fn(async () => ({ hold: false, reason: null })),
  holdPendingCommitCascades: vi.fn(async () => 0),
}));

import {
  CALLBACK_MAX_SKEW_SECONDS,
  REMEDIATION_CALLBACK_KEY_VERSION,
  SCAN_CALLBACK_KEY_VERSION,
  claimCallbackReceipt,
  deriveCallbackKey,
  resolveScanMasterSecrets,
  verifyCallbackSignature,
} from "./codex-callback-keys.server";
import { REMEDIATION_CALLBACK_KEY_VERSION as CLIENT_REMEDIATION_KEY_VERSION } from "@/lib/codex-remediation.functions";
import { handleScanCallback, runUrlBelongsTo } from "./codex-scan-callback.server";
import {
  findingStateForEvent,
  handleRemediationCallback,
  nextRemediationStatus,
  prUrlBelongsTo,
} from "./codex-remediation-callback.server";
import { completePrCheckForJob } from "@/server/codex-pr-checks.server";
import { deepScanFor } from "./codex-scheduling.server";

const MASTER = "test-master-secret-not-a-real-one";
const JOB_ID = "3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REM_ID = "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d";
const REPO = "acme/widget";

const hmac = (key: string, msg: string) =>
  crypto.createHmac("sha256", key).update(msg).digest("hex");
/** What the v2 workflows send — computed the way the workflow does, in node. */
function sign(key: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return {
    "x-codex-signature": `sha256=${hmac(key, `${ts}.${body}`)}`,
    "x-codex-timestamp": String(ts),
  };
}
function post(body: string, headers: Record<string, string>) {
  return new Request("https://mc.example/api/public/hooks/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  process.env.CODEX_SECURITY_WEBHOOK_SECRET = MASTER;
  delete process.env.CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.CODEX_REMEDIATION_WEBHOOK_SECRET;
  h.rows = {};
  h.receiptError = null;
  h.writes = [];
  h.rpcs = [];
  h.rpcResults = {};
  vi.mocked(completePrCheckForJob).mockClear();
});

describe("per-job callback keys", () => {
  it("derive the way the workflows can reproduce, and differ per job and purpose", async () => {
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    expect(key).toBe(hmac(MASTER, `aurixa-codex-callback:v1:scan:${JOB_ID}`));
    expect(await deriveCallbackKey(MASTER, "remediation", JOB_ID)).not.toBe(key);
    expect(await deriveCallbackKey(MASTER, "scan", REM_ID)).not.toBe(key);
  });

  it("pin the client's remediation key version to the server's", () => {
    // The browser bundle cannot import the server module, so the literal is
    // duplicated; this is what keeps the two from drifting.
    expect(CLIENT_REMEDIATION_KEY_VERSION).toBe(REMEDIATION_CALLBACK_KEY_VERSION);
  });
});

describe("verifyCallbackSignature", () => {
  const body = '{"a":1}';
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const ts = Math.floor(now / 1000);

  it("accepts a timestamped signature from any candidate key", async () => {
    const v = await verifyCallbackSignature({
      rawBody: body,
      signature: `sha256=${hmac("old-key", `${ts}.${body}`)}`,
      timestamp: String(ts),
      keys: ["new-key", "old-key"],
      allowUntimestamped: false,
      nowMs: now,
    });
    expect(v).toMatchObject({ ok: true, scheme: "timestamped" });
  });

  it("refuses a timestamp outside the window", async () => {
    const old = ts - CALLBACK_MAX_SKEW_SECONDS - 1;
    const v = await verifyCallbackSignature({
      rawBody: body,
      signature: `sha256=${hmac("k", `${old}.${body}`)}`,
      timestamp: String(old),
      keys: ["k"],
      allowUntimestamped: true,
      nowMs: now,
    });
    expect(v).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("refuses a malformed timestamp and a wrong key", async () => {
    expect(
      await verifyCallbackSignature({
        rawBody: body,
        signature: "sha256=00",
        timestamp: "soon",
        keys: ["k"],
        allowUntimestamped: true,
        nowMs: now,
      }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(
      await verifyCallbackSignature({
        rawBody: body,
        signature: `sha256=${hmac("other", `${ts}.${body}`)}`,
        timestamp: String(ts),
        keys: ["k"],
        allowUntimestamped: true,
        nowMs: now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts the older untimestamped scheme only where allowed, and labels it", async () => {
    const legacy = {
      rawBody: body,
      signature: hmac("k", body),
      timestamp: null,
      keys: ["k"],
      nowMs: now,
    };
    expect(await verifyCallbackSignature({ ...legacy, allowUntimestamped: true })).toMatchObject({
      ok: true,
      scheme: "legacy",
    });
    expect(await verifyCallbackSignature({ ...legacy, allowUntimestamped: false })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    });
  });

  it("refuses with nothing to check against", async () => {
    expect(
      await verifyCallbackSignature({
        rawBody: body,
        signature: null,
        timestamp: null,
        keys: ["k"],
        allowUntimestamped: true,
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      await verifyCallbackSignature({
        rawBody: body,
        signature: "x",
        timestamp: null,
        keys: ["", null],
        allowUntimestamped: true,
      }),
    ).toEqual({ ok: false, reason: "no_keys" });
  });
});

describe("master secrets", () => {
  it("prefer the environment, with its previous value for a rotation", async () => {
    process.env.CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS = "before";
    expect(await resolveScanMasterSecrets()).toEqual({
      current: MASTER,
      previous: ["before"],
      mode: "env",
    });
  });

  it("fall back to the intake source, keeping the previous key only within the grace window", async () => {
    delete process.env.CODEX_SECURITY_WEBHOOK_SECRET;
    const now = Date.UTC(2026, 9, 18, 12);
    h.rows.security_intake_sources = {
      id: "s1",
      hmac_secret: "current",
      previous_hmac_secret: "previous",
      hmac_rotated_at: new Date(now - 3_600_000).toISOString(),
    };
    expect(await resolveScanMasterSecrets(now)).toEqual({
      current: "current",
      previous: ["previous"],
      mode: "intake_source",
    });
    expect((await resolveScanMasterSecrets(now + 48 * 3_600_000)).previous).toEqual([]);
  });

  it("report none when nothing is configured", async () => {
    delete process.env.CODEX_SECURITY_WEBHOOK_SECRET;
    expect(await resolveScanMasterSecrets()).toEqual({ current: "", previous: [], mode: "none" });
  });
});

describe("replay receipts", () => {
  it("tell a new signature from a replayed one, and survive an unmigrated database", async () => {
    expect(await claimCallbackReceipt("scan", "d1", JOB_ID)).toBe("new");
    h.receiptError = { code: "23505", message: "duplicate key" };
    expect(await claimCallbackReceipt("scan", "d1", JOB_ID)).toBe("duplicate");
    h.receiptError = {
      code: "42P01",
      message: 'relation "codex_callback_receipts" does not exist',
    };
    expect(await claimCallbackReceipt("scan", "d1", JOB_ID)).toBe("unavailable");
  });
});

describe("the scan webhook", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: JOB_ID,
    kind: "manual",
    status: "running",
    clone_id: "c0ffee00-0000-4000-8000-000000000001",
    target_kind: "clone",
    repo_full_name: REPO,
    ref: "main",
    request_payload: { callback_key: SCAN_CALLBACK_KEY_VERSION },
    created_at: "2026-10-18T00:00:00Z",
    ...over,
  });
  const started = JSON.stringify({
    client_job_id: JOB_ID,
    event: "scan.started",
    workflow_version: 2,
    workflow_run_id: 9,
    workflow_run_url: `https://github.com/${REPO}/actions/runs/9`,
  });

  it("answers an unknown job exactly like a bad signature", async () => {
    const res = await handleScanCallback(post(started, sign("anything", started)));
    expect(res.status).toBe(401);
  });

  it("refuses the shared master for a job dispatched with its own key", async () => {
    h.rows.codex_scan_jobs = job();
    const res = await handleScanCallback(post(started, sign(MASTER, started)));
    expect(res.status).toBe(401);
    expect(h.writes.filter((w) => w.table === "codex_scan_jobs")).toEqual([]);
  });

  it("accepts the job's own key and marks the scan running", async () => {
    h.rows.codex_scan_jobs = job({ status: "queued" });
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    const res = await handleScanCallback(post(started, sign(key, started)));
    expect(res.status).toBe(200);
    const update = h.writes.find((w) => w.table === "codex_scan_jobs" && w.op === "update");
    expect(update?.values).toMatchObject({ status: "running", workflow_run_id: 9 });
  });

  it("still accepts the shared master for a job dispatched before per-job keys", async () => {
    h.rows.codex_scan_jobs = job({ request_payload: {} });
    const res = await handleScanCallback(post(started, sign(MASTER, started)));
    expect(res.status).toBe(200);
  });

  it("refuses a closed job's callbacks", async () => {
    h.rows.codex_scan_jobs = job({ status: "completed" });
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    expect((await handleScanCallback(post(started, sign(key, started)))).status).toBe(409);
  });

  it("refuses results from a run in another repository", async () => {
    h.rows.codex_scan_jobs = job();
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    const foreign = JSON.stringify({
      client_job_id: JOB_ID,
      event: "scan.started",
      workflow_run_url: "https://github.com/evil/repo/actions/runs/1",
    });
    expect((await handleScanCallback(post(foreign, sign(key, foreign)))).status).toBe(400);
  });

  it("answers a replayed signature without processing it again", async () => {
    h.rows.codex_scan_jobs = job();
    h.receiptError = { code: "23505", message: "duplicate key" };
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    const res = await handleScanCallback(post(started, sign(key, started)));
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(h.writes.filter((w) => w.table === "codex_scan_jobs")).toEqual([]);
  });

  it("ingests and finalizes in Postgres, then completes a PR scan's check", async () => {
    h.rows.codex_scan_jobs = job({
      kind: "pr_open",
      request_payload: { callback_key: SCAN_CALLBACK_KEY_VERSION, pr: 5 },
    });
    h.rpcResults.codex_finalize_scan = { data: { open_total: 1 }, error: null };
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    const completed = JSON.stringify({
      client_job_id: JOB_ID,
      event: "scan.completed",
      workflow_version: 2,
      findings: [{ id: "f1", title: "Use of eval", severity: "high", description: null }],
      summary: { total: 1, scanners: { semgrep: { status: "ok" } } },
    });
    const res = await handleScanCallback(post(completed, sign(key, completed)));
    expect(res.status).toBe(200);
    expect(h.rpcs.map((r) => r.fn)).toEqual(["codex_ingest_scan_findings", "codex_finalize_scan"]);
    expect(vi.mocked(completePrCheckForJob)).toHaveBeenCalledTimes(1);
  });

  it("says so when the findings cannot be stored, so the workflow retries", async () => {
    h.rows.codex_scan_jobs = job();
    h.rpcResults.codex_ingest_scan_findings = {
      data: null,
      error: { code: "XX000", message: "boom" },
    };
    const key = await deriveCallbackKey(MASTER, "scan", JOB_ID);
    const progress = JSON.stringify({
      client_job_id: JOB_ID,
      event: "scan.progress",
      findings: [{ id: "f1", title: "t", severity: "low" }],
    });
    expect((await handleScanCallback(post(progress, sign(key, progress)))).status).toBe(500);
  });
});

describe("the remediation webhook", () => {
  const rem = (over: Record<string, unknown> = {}) => ({
    id: REM_ID,
    finding_id: "f0000000-0000-4000-8000-000000000001",
    scan_job_id: null,
    status: "dispatched",
    repo_full_name: REPO,
    branch_name: "codex/fix-high-eval-f0000000",
    pr_number: null,
    head_sha: null,
    dispatch_payload: { callback_key: REMEDIATION_CALLBACK_KEY_VERSION },
    ...over,
  });
  const opened = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      remediation_id: REM_ID,
      event: "pr.opened",
      pr_number: 77,
      pr_url: `https://github.com/${REPO}/pull/77`,
      head_sha: "a".repeat(40),
      branch_name: "main",
      ...over,
    });

  it("refuses a PR in another repository, or one whose number does not match its URL", async () => {
    h.rows.codex_remediations = rem();
    const key = await deriveCallbackKey(MASTER, "remediation", REM_ID);
    const foreign = opened({ pr_url: "https://github.com/evil/repo/pull/77" });
    expect((await handleRemediationCallback(post(foreign, sign(key, foreign)))).status).toBe(400);
    const mismatched = opened({ pr_url: `https://github.com/${REPO}/pull/78` });
    expect((await handleRemediationCallback(post(mismatched, sign(key, mismatched)))).status).toBe(
      400,
    );
  });

  it("records the PR and its head, but never renames Mission Control's branch", async () => {
    h.rows.codex_remediations = rem();
    const key = await deriveCallbackKey(MASTER, "remediation", REM_ID);
    const body = opened();
    expect((await handleRemediationCallback(post(body, sign(key, body)))).status).toBe(200);
    const update = h.writes.find((w) => w.table === "codex_remediations" && w.op === "update");
    expect(update?.values).toMatchObject({
      status: "pr_opened",
      pr_number: 77,
      head_sha: "a".repeat(40),
    });
    expect(update?.values).not.toHaveProperty("branch_name");
  });

  it("refuses to move a remediation to a different PR", async () => {
    h.rows.codex_remediations = rem({ pr_number: 12, status: "pr_opened" });
    const key = await deriveCallbackKey(MASTER, "remediation", REM_ID);
    const body = opened();
    expect((await handleRemediationCallback(post(body, sign(key, body)))).status).toBe(400);
  });

  it("refuses callbacks for a finished remediation", async () => {
    h.rows.codex_remediations = rem({ status: "merged" });
    const key = await deriveCallbackKey(MASTER, "remediation", REM_ID);
    const body = opened();
    expect((await handleRemediationCallback(post(body, sign(key, body)))).status).toBe(409);
  });
});

describe("remediation state rules", () => {
  it("only move forward, except that a new head invalidates approvals", () => {
    expect(nextRemediationStatus("pr_opened", "workflow.started", false)).toBeNull();
    expect(nextRemediationStatus("dispatched", "pr.opened", false)).toBe("pr_opened");
    expect(nextRemediationStatus("approved", "pr.updated", true)).toBe("pr_updated");
    expect(nextRemediationStatus("approved", "pr.updated", false)).toBeNull();
    expect(nextRemediationStatus("merged", "pr.closed", false)).toBeNull();
  });

  it("mirror onto the finding without overriding a verdict", () => {
    expect(findingStateForEvent("pr.opened", "fix_drafted")).toBe("pr_open");
    expect(findingStateForEvent("pr.merged", "pr_open")).toBe("fix_merged");
    expect(findingStateForEvent("workflow.failed", "fix_drafted")).toBe("open");
    expect(findingStateForEvent("pr.closed", "pr_open")).toBe("open");
    expect(findingStateForEvent("pr.merged", "dismissed")).toBeNull();
  });

  it("believe only URLs inside the repository", () => {
    expect(prUrlBelongsTo(`https://github.com/${REPO}/pull/3`, "ACME/Widget", 3)).toBe(true);
    expect(prUrlBelongsTo(`https://github.com/${REPO}/pull/3/files`, REPO, 3)).toBe(true);
    expect(prUrlBelongsTo(`https://github.com/${REPO}/pull/3`, REPO, 4)).toBe(false);
    expect(prUrlBelongsTo("not a url", REPO)).toBe(false);
    expect(runUrlBelongsTo(`https://github.com/${REPO}/actions/runs/1`, REPO)).toBe(true);
    expect(runUrlBelongsTo(`https://github.com/${REPO}-fork/actions/runs/1`, REPO)).toBe(false);
  });
});

describe("deepScanFor", () => {
  it("always runs the AI pass on manual scans, and otherwise follows the scope", () => {
    expect(deepScanFor({ kind: "manual", targetKind: "clone", scope: "off" })).toBe(true);
    expect(deepScanFor({ kind: "nightly_full", targetKind: "prime", scope: "off" })).toBe(false);
    expect(deepScanFor({ kind: "nightly_full", targetKind: "prime", scope: "prime" })).toBe(true);
    expect(deepScanFor({ kind: "nightly_full", targetKind: "clone", scope: "prime" })).toBe(false);
    expect(deepScanFor({ kind: "pr_open", targetKind: "clone", scope: "fleet" })).toBe(true);
  });
});
