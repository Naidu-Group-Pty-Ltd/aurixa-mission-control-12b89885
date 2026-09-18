/**
 * The backend has a revision of its own, and the catch-up plans from it.
 *
 * ## What this is here to make impossible
 *
 * `clones.last_synced_sha` is the revision the clone's REPOSITORY content
 * reached. The cascade advances it the moment a pull request merges — whether
 * or not the backend deploy that merge requested ever landed. Read as the
 * backend's baseline it says a clone is current the instant its files are,
 * which is a different question and the wrong one.
 *
 * Measured 17 Sep 2026. `npc-client-dashboard` parked its `edge_function_deploy`
 * run on 14 Sep and `npc-test` on 15 Sep, both carrying `failed: []` — no
 * bundle had errored; the attempt budget went on prime-generation restarts and
 * per-pass budget pauses. The cascade then merged past both. The sweep diffed
 * head against head, answered `no_backend_work`, and neither clone received a
 * single edge function for three days — while the fleet page read `in_sync`,
 * every cascade was green, and the sweep's own audit breadcrumb agreed there
 * was nothing to do. `mission-control-announcements` shipped to the prime on
 * 16 Sep and reached one clone of three.
 *
 * Structural — which column is read, where the stamp is written, and what a
 * failed read does — so it is asserted against the source. A Supabase double
 * would agree with wrong code here; which column the query names cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const healing = stripComments(read("src/server/self-healing.server.ts"));
const catchup = stripComments(read("src/server/backendCatchup.server.ts"));
const sync = stripComments(read("src/server/backendSync.server.ts"));

/** The edge-function deploy lane alone. */
const lane = healing.slice(
  healing.indexOf("async function executeEdgeFunctionDeploy"),
  healing.indexOf("async function executeMonitorRecovery"),
);

describe("a succeeded deploy records the revision the functions reached", () => {
  it("stamps the backend revision on the success path", () => {
    /*
      Only here. A run reaches `succeedRun` with `sourceMoved` false, so every
      bundle it counted came from one revision — which is the whole claim the
      stamp is making. A resuming pass has not finished and must not stamp.
    */
    const success = lane.slice(lane.lastIndexOf("return succeedRun(run, {"));
    const beforeSuccess = lane.slice(0, lane.lastIndexOf("return succeedRun(run, {"));

    expect(beforeSuccess).toContain("recordBackendRevision(run.clone_id");
    expect(success).not.toContain("recordBackendRevision");
  });

  it("writes it to the backend's own column, never to the clone's", () => {
    const helper = healing.slice(
      healing.indexOf("async function recordBackendRevision"),
      healing.indexOf("async function executePrMerge"),
    );
    expect(helper).toContain('.from("clone_backends")');
    expect(helper).toContain("source_sha");
    // Advancing the repository baseline here would tell the next cascade the
    // clone's FILES are current and skip them.
    expect(helper).not.toContain("last_synced_sha");
    expect(helper).not.toContain('.from("clones")');
  });

  it("never fails a completed deploy over the stamp, and never swallows it", () => {
    const helper = healing.slice(
      healing.indexOf("async function recordBackendRevision"),
      healing.indexOf("async function executePrMerge"),
    );
    // Best-effort: no throw, no parkRun, no status change.
    expect(helper).not.toContain("throw");
    expect(helper).not.toContain("parkRun");
    // But said out loud — an unwritten stamp costs a redeploy next time and
    // must not be invisible while it does.
    expect(helper).toContain("console.error");
  });
});

describe("the catch-up plans from the backend's revision", () => {
  it("reads clone_backends rather than trusting the repository baseline", () => {
    expect(catchup).toContain('.from("clone_backends")');
    expect(catchup).toContain("source_sha");
  });

  it("prefers the backend revision over last_synced_sha for the diff", () => {
    /*
      The fallback is deliberate and one-directional: a clone with no stamp
      yet plans from its repository baseline rather than from null, because
      null means "owes every backend file" and would buy a full redeploy of
      the fleet the first time this runs. The stamp lands on that clone's
      next successful deploy and the fallback stops being reached.
    */
    expect(catchup).toContain("backendSha.get(row.id) ?? row.last_synced_sha ?? null");
    // The bare repository baseline must never be the whole answer again.
    expect(catchup).not.toContain("fromSha: row.last_synced_sha ?? null");
  });

  it("names a run that is queued behind a person rather than behind the drain", () => {
    /*
      `awaiting_validation` is one of the OPEN statuses, so a parked run
      absorbs every later plan — and `executeRemediationRun` takes `planned`
      and `approved` only, so it will never pick that work up on its own.
      Reported in a live run's words, three days of undelivered functions
      read as a healthy queue on every sweep.
    */
    const planner = sync.slice(
      sync.indexOf("async function planFunctionDeploy"),
      sync.indexOf("async function planMigrationCatchUp"),
    );
    expect(planner).toContain('open.status === "awaiting_validation"');
    expect(planner).toContain("BLOCKED");
    // Every outcome that reports an open run carries the caveat, not just
    // the first one — the whole-fleet plan is the one that actually fired.
    expect(planner).not.toMatch(/return "already queued \(that run covers every function\)"/);
    expect(planner).not.toMatch(/: "widened the open run to every function"/);
  });

  it("refuses when the backend revisions cannot be read", () => {
    /*
      A read that FAILED is not a fleet with no recorded backends. Falling
      through to every clone's repository baseline would re-open exactly the
      hole this closes, and would do it silently.
    */
    const guard = catchup.slice(
      catchup.indexOf('.from("clone_backends")'),
      catchup.indexOf("const backendSha"),
    );
    expect(guard).toContain("if (backendErr)");
    expect(guard).toContain("refused:");
  });
});
