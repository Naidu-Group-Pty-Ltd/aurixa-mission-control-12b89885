/**
 * The watch end to end, against a fake installation client and a fake
 * database: it announces once, stays quiet on the next pass, and never records
 * a clean slate it did not read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeAuditLog = vi.fn(
  async (_entry: { action: string; metadata: Record<string, unknown> }) => undefined,
);
const notifyOperators = vi.fn(async (_n: Record<string, unknown>) => true);
vi.mock("./audit.server", () => ({ writeAuditLog, notifyOperators }));
vi.mock("./github-app.server", () => ({
  getAppOctokit: () => {
    throw new Error("the test hands in its own client");
  },
}));

const { sweepCloneCi } = await import("./cloneCiWatch.server");
const { CLONE_CI_WATCH_ACTION } = await import("./cloneCiWatch.pure");
type CiOctokit = import("./cloneCiWatch.server").CiOctokit;

const NOW = Date.parse("2026-10-26T22:00:00Z");
const CLONE_ID = "11111111-1111-4111-8111-111111111111";
const SANCTIONS = ".github/workflows/aml-sanctions-refresh.yml";
const APPLY = ".github/workflows/apply-migration.yml";
const DRIFT = ".github/workflows/migration-drift.yml";

type Row = Record<string, unknown>;

/** Just enough of the query builder for the reads this module makes. */
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        not: (col: string, _op: string, _val: null) => {
          rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return q;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return q;
    },
  } as never;
}

function tables(history: Row[] = []) {
  return {
    prime_config: [{ github_owner: "Org", github_repo: "prime", default_branch: "main" }],
    clones: [
      {
        id: CLONE_ID,
        name: "NPC Test",
        github_owner: "Org",
        github_repo: "npc-test",
        default_branch: "main",
      },
    ],
    clone_sync_exclusions: [
      { clone_id: CLONE_ID, pattern: APPLY, reason: "protected" },
      { clone_id: CLONE_ID, pattern: "src/integrations/supabase/env.ts", reason: "protected" },
    ],
    audit_log: history,
  };
}

const runRow = (path: string, at: string, conclusion: string, id: number) => ({
  path,
  name: "Refresh sanctions",
  event: "schedule",
  head_branch: "main",
  status: "completed",
  conclusion,
  created_at: at,
  html_url: `https://github.com/Org/npc-test/actions/runs/${id}`,
});

function fakeOctokit(
  over: {
    failRuns?: boolean;
    cloneWorkflowDir404?: boolean;
    /** Add a workflow GitHub has stopped, whose file says this, or cannot be read. */
    stoppedDrift?: { file: string } | "unreadable";
  } = {},
) {
  const calls: string[] = [];
  const octokit: CiOctokit = {
    actions: {
      async listWorkflowRunsForRepo(p) {
        calls.push(`runs:${p.repo}:${p.event}`);
        if (over.failRuns) throw Object.assign(new Error("Bad credentials"), { status: 401 });
        if (p.event !== "schedule") return { data: { workflow_runs: [] } };
        return {
          data: {
            workflow_runs: [
              runRow(SANCTIONS, "2026-10-25T20:45:00Z", "failure", 3),
              runRow(SANCTIONS, "2026-10-24T20:45:00Z", "failure", 2),
            ],
          },
        };
      },
      async listRepoWorkflows(p) {
        calls.push(`workflows:${p.repo}`);
        const workflows = [{ path: SANCTIONS, name: "Refresh sanctions", state: "active" }];
        if (over.stoppedDrift) {
          workflows.push({ path: DRIFT, name: "Migration drift", state: "disabled_inactivity" });
        }
        return { data: { workflows } };
      },
    },
    repos: {
      async getContent(p) {
        calls.push(`contents:${p.repo}:${p.path}`);
        if (p.path === DRIFT) {
          if (over.stoppedDrift === "unreadable" || !over.stoppedDrift) {
            throw Object.assign(new Error("Server Error"), { status: 502 });
          }
          return {
            data: {
              encoding: "base64",
              content: Buffer.from(over.stoppedDrift.file).toString("base64"),
            },
          };
        }
        if (p.repo === "npc-test" && over.cloneWorkflowDir404) {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        const sha = p.repo === "prime" ? "a".repeat(40) : "b".repeat(40);
        return { data: [{ type: "file", path: APPLY, sha }] };
      },
    },
  };
  return { octokit, calls };
}

beforeEach(() => {
  writeAuditLog.mockClear();
  notifyOperators.mockReset();
  notifyOperators.mockImplementation(async () => true);
});

describe("sweepCloneCi", () => {
  it("records and announces what nobody has been told, naming each finding", async () => {
    const { octokit, calls } = fakeOctokit();
    const report = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });

    expect(report).toMatchObject({
      clones: 1,
      attention: 1,
      announced: 2,
      unreadable: 0,
      failed: 0,
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: CLONE_CI_WATCH_ACTION,
      entityType: "clone",
      entityId: CLONE_ID,
    });

    expect(notifyOperators).toHaveBeenCalledTimes(1);
    const n = notifyOperators.mock.calls[0][0];
    expect(n).toMatchObject({
      kind: "clone_ci_attention",
      severity: "error",
      cloneId: CLONE_ID,
      title:
        "NPC Test: 1 scheduled workflow failing, 1 protected workflow differs from the prime's",
    });
    expect(n.body).toContain("aml-sanctions-refresh.yml — the last 2 scheduled runs failed");
    expect(n.body).toContain("apply-migration.yml — protected here");

    // The prime's workflows are listed once for the pass, not once per clone.
    expect(calls.filter((c) => c.startsWith("contents:prime")).length).toBe(1);
  });

  it("is quiet on the next pass when nothing has changed", async () => {
    const { octokit } = fakeOctokit();
    await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    const recorded = writeAuditLog.mock.calls[0][0].metadata;
    writeAuditLog.mockClear();
    notifyOperators.mockClear();

    const report = await sweepCloneCi(
      fakeSupabase(
        tables([{ action: CLONE_CI_WATCH_ACTION, entity_id: CLONE_ID, metadata: recorded }]),
      ),
      { octokit, now: NOW },
    );
    expect(report).toMatchObject({ attention: 1, announced: 0 });
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(notifyOperators).not.toHaveBeenCalled();
  });

  it("records nothing for a clone it could not read, so its standing findings stand", async () => {
    const { octokit } = fakeOctokit({ failRuns: true });
    const report = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    expect(report).toMatchObject({ unreadable: 1, attention: 0 });
    expect(report.detail[0]).toMatchObject({ outcome: "unreadable" });
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(notifyOperators).not.toHaveBeenCalled();
  });

  it("reads a repository without a workflows directory as having none", async () => {
    const { octokit } = fakeOctokit({ cloneWorkflowDir404: true });
    const report = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    // The clone carries no apply-migration.yml at all: absent is not drift.
    expect(report).toMatchObject({ unreadable: 0, announced: 1 });
    expect(notifyOperators.mock.calls[0][0].title).toBe("NPC Test: 1 scheduled workflow failing");
  });
  it("tries an announcement again when its notification did not land (Codex P1 on #365)", async () => {
    const { octokit } = fakeOctokit({ cloneWorkflowDir404: true });
    notifyOperators.mockImplementationOnce(async () => false);
    const first = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    expect(first).toMatchObject({ attention: 1, announced: 0, undelivered: 1 });
    // Observed and written down, but not as told.
    const recorded = writeAuditLog.mock.calls[0][0].metadata;
    expect(recorded.announced).toEqual([]);

    writeAuditLog.mockClear();
    notifyOperators.mockClear();
    const second = await sweepCloneCi(
      fakeSupabase(
        tables([{ action: CLONE_CI_WATCH_ACTION, entity_id: CLONE_ID, metadata: recorded }]),
      ),
      { octokit, now: NOW },
    );
    expect(second).toMatchObject({ announced: 1, undelivered: 0 });
    expect(notifyOperators).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0].metadata.announced).toEqual([`failing:${SANCTIONS}`]);
  });

  it("finds a stopped schedule from its file, with no run left to show it (Codex P2 on #365)", async () => {
    const { octokit } = fakeOctokit({
      cloneWorkflowDir404: true,
      stoppedDrift: { file: "on:\n  schedule:\n    - cron: '10 19 * * *'\n" },
    });
    const report = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    expect(report.detail[0]).toMatchObject({ outcome: "attention" });
    expect(notifyOperators.mock.calls[0][0].body).toContain(
      "migration-drift.yml — GitHub has stopped scheduling it (disabled_inactivity)",
    );
  });

  it("is unreadable when a stopped workflow's file cannot be read", async () => {
    const { octokit } = fakeOctokit({ cloneWorkflowDir404: true, stoppedDrift: "unreadable" });
    const report = await sweepCloneCi(fakeSupabase(tables()), { octokit, now: NOW });
    expect(report).toMatchObject({ unreadable: 1 });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
