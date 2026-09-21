/**
 * The one module here that changes anything, exercised on what it SENDS.
 *
 * Two properties, and both are invisible in any output:
 *
 *   - a verdict that does not permit the act never reaches GitHub at all;
 *   - the verdict is re-taken here, so a page holding a five-minute-old
 *     `ready` cannot spend it.
 *
 * Neither can be shown by reading a diagnosis. They are shown by capturing
 * every request the module makes and asserting the transcript is empty.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  assessIdempotency,
  scanSqlStatements,
  type MigrationDiagnosis,
} from "./primeMigrationDiagnosis.pure";

const state = vi.hoisted(() => ({
  requests: [] as Array<{ route: string; params: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  /** What the fresh diagnosis answers. Replaced per test. */
  report: null as unknown,
  reportThrows: null as null | Error,
  requestFails: null as null | { status?: number; message: string },
  /** What the in-flight probe finds. Empty means nothing is running. */
  runs: [] as Array<{ status: string }>,
  runsThrow: false,
}));

vi.mock("./github-app.server", () => ({
  getAppOctokit: () => ({
    request: async (route: string, params: Record<string, unknown>) => {
      state.requests.push({ route, params });
      if (route.includes("/runs")) {
        if (state.runsThrow) throw new Error("GitHub is unwell");
        return { data: { workflow_runs: state.runs } };
      }
      if (state.requestFails) {
        const err = new Error(state.requestFails.message) as Error & {
          status?: number;
          response?: { data?: { message?: string } };
        };
        err.status = state.requestFails.status;
        err.response = { data: { message: state.requestFails.message } };
        throw err;
      }
      return { data: {} };
    },
  }),
}));

vi.mock("./audit.server", () => ({
  writeAuditLog: async (a: Record<string, unknown>) => {
    state.audits.push(a);
  },
}));

vi.mock("./primeMigrationDiagnosis.server", () => ({
  diagnosePrimeMigration: async () => {
    if (state.reportThrows) throw state.reportThrows;
    return state.report;
  },
}));

import { dispatchPrimeMigration, APPLY_WORKFLOW_FILE } from "./primeMigrationDispatch.server";

const REPO = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

function diagnosis(over: Partial<MigrationDiagnosis> = {}): MigrationDiagnosis {
  return {
    id: "20260901010000",
    name: "20260901010000_add_thing.sql",
    path: "supabase/migrations/20260901010000_add_thing.sql",
    verdict: "ready",
    headline: "Tried against the prime and rolled back cleanly in 42 ms.",
    remedy: null,
    dispatchable: true,
    statementCount: 3,
    bytes: 512,
    hazards: [],
    hazardCount: 0,
    destructiveCount: 0,
    dataRewriteCount: 0,
    // A real reading of a real body rather than a hand-typed shape, so this
    // fixture cannot claim something the module would never produce.
    idempotency: assessIdempotency(scanSqlStatements("create table if not exists x (id int);")),
    blockedBy: [],
    dryRun: { ran: true, ok: true, ms: 42 },
    catalogueNote: null,
    ...over,
  };
}

function reports(d: MigrationDiagnosis, repo: typeof REPO | null = REPO) {
  state.report = {
    diagnosis: d,
    repo,
    primeRef: "dduzbchuswwbefdunfct",
    headSha: "abc1234",
    collisions: [],
    readAt: "2026-09-20T00:00:00.000Z",
  };
}

beforeEach(() => {
  state.requests = [];
  state.audits = [];
  state.report = null;
  state.reportThrows = null;
  state.requestFails = null;
  state.runs = [];
  state.runsThrow = false;
});

/** Only the dispatches — the in-flight probe is a GET and not an act. */
const dispatches = () => state.requests.filter((r) => r.route.includes("/dispatches"));

describe("a verdict that does not permit the act never reaches GitHub", () => {
  it("refuses, quoting the diagnosis, and sends nothing", async () => {
    reports(
      diagnosis({
        verdict: "would_fail",
        dispatchable: false,
        headline: "it fails because it refers to a table that does not exist here (42P01).",
      }),
    );

    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");

    expect(r.ok).toBe(false);
    // Not even the in-flight probe: a verdict that forbids the act ends it
    // before anything is spent.
    expect(state.requests).toEqual([]);
    expect(state.audits).toEqual([]);
    if (!r.ok) expect(r.error).toContain("42P01");
  });

  it("holds for every verdict but `ready` — asserted over the whole union", async () => {
    // A representative sample would be satisfied by whichever ones happen to
    // be listed, which is exactly how a new verdict acquires a button.
    for (const verdict of [
      "rollback_script",
      "version_collision",
      "already_applied",
      "oversized",
      "blocked_by_prerequisite",
      "unsafe_to_test",
      "would_fail",
      "undiagnosed",
    ] as const) {
      state.requests = [];
      reports(diagnosis({ verdict, dispatchable: false }));
      const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
      expect(r.ok, verdict).toBe(false);
      expect(state.requests, verdict).toEqual([]);
    }
  });

  it("a diagnosis that threw dispatches nothing and carries no verdict", async () => {
    state.reportThrows = new Error("GitHub answered 403");
    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnosis).toBeNull();
    expect(state.requests).toEqual([]);
  });

  it("an unconfigured prime repository stops it after the diagnosis", async () => {
    reports(diagnosis(), null);
    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
    expect(r.ok).toBe(false);
    expect(state.requests).toEqual([]);
  });
});

describe("the act, when it is permitted", () => {
  it("dispatches the prime's own workflow, for one named file", async () => {
    reports(diagnosis());

    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");

    expect(r.ok).toBe(true);
    expect(dispatches()).toHaveLength(1);
    const { route, params } = dispatches()[0];
    expect(route).toContain("/actions/workflows/{workflow_id}/dispatches");
    expect(params).toMatchObject({
      owner: REPO.owner,
      repo: REPO.repo,
      workflow_id: APPLY_WORKFLOW_FILE,
      ref: REPO.branch,
    });
    // The file, not a version and not a set. `apply-migration.yml` refuses to
    // infer its own target and so does this.
    expect(params.inputs).toEqual({
      file: "supabase/migrations/20260901010000_add_thing.sql",
      record_version: "true",
    });
  });

  it("records the act, with the evidence it rested on, AFTER it succeeded", async () => {
    reports(diagnosis({ destructiveCount: 2, dataRewriteCount: 1 }));

    await dispatchPrimeMigration({} as never, "20260901010000", "u-42");

    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: "prime.migration.dispatch",
      entityType: "prime_migration",
      entityId: "20260901010000",
      actorUserId: "u-42",
    });
    const meta = state.audits[0].metadata as Record<string, unknown>;
    // Evidence, not a verdict word: "why did we think this was safe?" is
    // answered by the trial run and the counts.
    expect(meta).toMatchObject({
      workflow: APPLY_WORKFLOW_FILE,
      verdict: "ready",
      dryRunMs: 42,
      destructiveStatements: 2,
      dataRewriteStatements: 1,
    });
  });

  it("points at the run rather than claiming one id, because dispatch returns none", async () => {
    reports(diagnosis());
    const r = await dispatchPrimeMigration({} as never, "20260901010000", null);
    expect(r.ok && r.runsUrl).toContain(
      `Naidu-Group-Pty-Ltd/npc-property-dashbord/actions/workflows/${APPLY_WORKFLOW_FILE}`,
    );
  });
});

describe("one apply at a time", () => {
  it("refuses while a run is already going, and says nothing was applied", async () => {
    reports(diagnosis());
    state.runs = [{ status: "in_progress" }];

    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");

    expect(r.ok).toBe(false);
    expect(dispatches()).toEqual([]);
    expect(state.audits).toEqual([]);
    if (!r.ok) {
      expect(r.error).toMatch(/already in progress/);
      expect(r.error).toMatch(/Nothing was applied/);
    }
  });

  it("a finished run is not a run in flight", async () => {
    reports(diagnosis());
    state.runs = [{ status: "completed" }, { status: "completed" }];
    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
    expect(r.ok).toBe(true);
    expect(dispatches()).toHaveLength(1);
  });

  it("a probe that FAILED does not refuse the act", async () => {
    /*
      The conservative side of a DISCLOSURE is to say nothing, not to invent a
      reason. A refusal built on a failed read would make a GitHub hiccup
      indistinguishable from a run in flight and would block the act this page
      exists to offer. The workflow's own `concurrency` group is the real
      serialiser; this is the notice in front of it.
    */
    reports(diagnosis());
    state.runsThrow = true;
    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
    expect(r.ok).toBe(true);
  });
});

describe("a dispatch that failed is not an act that happened", () => {
  it("writes no audit row", async () => {
    reports(diagnosis());
    state.requestFails = { status: 404, message: "Not Found" };

    const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");

    expect(r.ok).toBe(false);
    expect(state.audits).toEqual([]);
  });

  it("separates the three things GitHub calls Not Found, and says nothing was applied", async () => {
    const seen: string[] = [];
    for (const status of [404, 403, 422, 500]) {
      reports(diagnosis());
      state.requestFails = { status, message: "boom" };
      const r = await dispatchPrimeMigration({} as never, "20260901010000", "u1");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error, String(status)).toMatch(/Nothing was applied/);
        seen.push(r.error);
      }
    }
    // Four different remedies, not one sentence wearing four status codes.
    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toMatch(/Actions: read & write/);
    expect(seen[1]).toMatch(/installation/);
    expect(seen[2]).toMatch(/workflow_dispatch inputs/);
  });
});
