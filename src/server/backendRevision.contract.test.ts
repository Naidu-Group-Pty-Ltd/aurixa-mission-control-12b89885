/**
 * The backend's functions have a revision of their own, proven by the run that
 * put them there, and the catch-up plans from it.
 *
 * ## What this is here to make impossible
 *
 * Two readings stood in for that revision and each was a different fact.
 *
 * `clones.last_synced_sha` is the revision the clone's REPOSITORY content
 * reached. The cascade advances it the moment a pull request merges — whether
 * or not the backend deploy that merge requested ever landed. Measured
 * 17 Sep 2026: `npc-client-dashboard` and `npc-test` parked their deploys with
 * `failed: []`, the cascade merged past both, and the sweep diffed head
 * against head for three days.
 *
 * Its replacement, `clone_backends.source_sha`, was stamped by the deploy lane
 * — and rewritten with the prime's HEAD by the fleet migration lane on every
 * pass. Measured 26 Sep 2026: `preflight-property-group` and `npc-test-76b3b3`
 * last received a function on 19 Sep while every sweep for a week reported
 * both as owing nothing. Same fault, one lane over.
 *
 * So the revision now lives on the succeeded deploy run that proves it, which
 * nothing else writes, and the catch-up reads it from there.
 *
 * Structural — what the lane records, which rows the catch-up reads, and what
 * a failed read does — so it is asserted against the source. A Supabase double
 * would agree with wrong code here; which table the query names cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Source with comments removed — a comment quoting code is not code. */
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const healing = stripComments(read("src/server/self-healing.server.ts"));
const catchup = stripComments(read("src/server/backendCatchup.server.ts"));
const sync = stripComments(read("src/server/backendSync.server.ts"));

/** The edge-function deploy lane alone. */
const lane = healing.slice(
  healing.indexOf("async function executeEdgeFunctionDeploy"),
  healing.indexOf("async function executeMonitorRecovery"),
);

/** Every `succeedRun` the lane can return, with what it records. */
const successes = (() => {
  const out: string[] = [];
  for (let at = lane.indexOf("return succeedRun(run, {"); at !== -1; ) {
    out.push(lane.slice(at, lane.indexOf("});", at)));
    at = lane.indexOf("return succeedRun(run, {", at + 1);
  }
  return out;
})();

describe("the slices this file reads exist", () => {
  it("finds the lane and both of its completions", () => {
    expect(lane.length).toBeGreaterThan(1000);
    // The empty-batch completion and the final one.
    expect(successes).toHaveLength(2);
  });
});

describe("a succeeded deploy records the revision its functions are proven at", () => {
  /** The completion reached when a pass has nothing left to fetch. */
  const emptyBatch = successes[0];
  /** The completion after a pass that deployed a batch itself. */
  const finalCompletion = successes[1];

  it("records it on the run itself, when the run deployed the bundles", () => {
    expect(finalCompletion).toContain("functions_revision: functionsRevision");
    expect(finalCompletion).toContain("revision_recorded: functionsRevision !== null");
  });

  it("proves nothing over an empty batch, which deployed nothing itself", () => {
    /*
      An empty batch means every bundle holds a copy newer than this
      generation — read from the TARGET's timestamps, which Lovable publishing
      the clone's own checkout, or the clone's CI, refresh exactly as this run
      does. Recording the snapshot's revision there would claim the prime's
      HEAD for a function that may hold an older tree, and a baseline past a
      change never plans it again. Recording none steps the catch-up back to
      the previous proof: a wider diff, never a skip.
    */
    expect(emptyBatch).toContain("functions_revision: null");
    expect(emptyBatch).toContain("revision_recorded: false");
    const emptyBranch = lane.slice(
      lane.indexOf("if (batch.length === 0 && !generation.sourceMoved)"),
      lane.indexOf("return succeedRun(run, {"),
    );
    expect(emptyBranch).not.toContain("functionsRevisionOfSuccess(");
  });

  it("computes it with the one rule, never inline", () => {
    // One rule: `functionsRevisionOfSuccess` is what the catch-up's reader
    // mirrors, so a second spelling here is how the writer and the reader come
    // to disagree.
    const calls = lane.match(/functionsRevisionOfSuccess\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    // A named run is proven only up to the revision its list was computed to.
    expect(lane.match(/plannedToSha: run\.plan\?\.prime_sha/g) ?? []).toHaveLength(1);
  });

  it("proves nothing over a bundle that failed to land", () => {
    /*
      A last pass can complete the run with some bundles failed. Recording then
      tells the next catch-up those functions are at this revision; they have
      not changed since, so the diff never names them and they are never
      planned again. Unrecorded, the catch-up plans from the previous proof and
      owes them again: a redeploy, never a skip.
    */
    const finalCompletion = lane.slice(0, lane.lastIndexOf("return succeedRun(run, {"));
    const rule = finalCompletion.slice(finalCompletion.lastIndexOf("functionsRevisionOfSuccess({"));
    expect(rule).toContain("failedBundles: failedDetail.length");
  });

  it("no longer writes a revision into a column another lane owns", () => {
    // `clone_backends.source_sha` is the fleet migration lane's to rewrite on
    // every pass; a stamp there was overwritten within half an hour.
    expect(healing).not.toContain("recordBackendRevision");
    expect(lane).not.toMatch(/\.from\("clone_backends"\)[\s\S]{0,120}source_sha/);
    // And never the repository's baseline, which would tell the next cascade
    // the clone's FILES are current and skip them.
    expect(lane).not.toContain("last_synced_sha");
  });
});

describe("the catch-up plans from the runs that prove a revision", () => {
  it("reads succeeded deploy runs that recorded one, and no shared column", () => {
    expect(catchup).toContain('.from("remediation_runs")');
    expect(catchup).toContain('.eq("action_type", "edge_function_deploy")');
    expect(catchup).toContain('.eq("status", "succeeded")');
    expect(catchup).toContain('.eq("result->>revision_recorded", "true")');
    expect(catchup).toContain("functionsBaselineByClone(");
    expect(catchup).not.toContain('.from("clone_backends")');
  });

  it("falls back to nothing, never to the repository baseline", () => {
    /*
      Null means "owes every backend file" — a redeploy, never a skip. The
      repository baseline was the fallback once, and it is the one reading that
      was never the backend's.
    */
    expect(catchup).toContain("fromSha: functionsSha.get(row.id) ?? null");
    expect(catchup).not.toContain("last_synced_sha");
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
      sync.indexOf("function plannedSlugsOf"),
    );
    expect(planner.length).toBeGreaterThan(500);
    expect(planner).toContain('open.status === "awaiting_validation"');
    expect(planner).toContain("BLOCKED");
    // Every outcome that reports an open run carries the caveat, not just
    // the first one — the whole-fleet plan is the one that actually fired.
    expect(planner).not.toMatch(/return "already queued \(that run covers every function\)"/);
    expect(planner).not.toMatch(/: "widened the open run to every function"/);
  });

  it("refuses when the proving runs cannot be read", () => {
    /*
      A read that FAILED is not a fleet with no recorded revisions. Planning
      every clone from nothing would redeploy the whole fleet on a database
      blip, and would do it silently.
    */
    const guard = catchup.slice(
      catchup.indexOf('.from("remediation_runs")'),
      catchup.indexOf("const functionsSha"),
    );
    expect(guard).toContain("if (deployErr)");
    expect(guard).toContain("refused:");
  });
});
