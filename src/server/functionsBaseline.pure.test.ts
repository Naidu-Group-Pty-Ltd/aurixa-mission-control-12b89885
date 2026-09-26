import { describe, expect, it } from "vitest";
import {
  functionsBaselineByClone,
  functionsRevisionOfSuccess,
  recordedFunctionsRevision,
} from "./functionsBaseline.pure";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("functionsRevisionOfSuccess", () => {
  it("a whole-fleet run proves the revision its bundles came from", () => {
    expect(
      functionsRevisionOfSuccess({
        wanted: null,
        deployedFromSha: A,
        plannedToSha: B,
        failedBundles: 0,
      }),
    ).toBe(A);
  });

  it("a named run proves only the revision its list was computed up to", () => {
    // The snapshot (A) is newer than the plan's reach (B), and its other
    // changes were never deployed by this run.
    expect(
      functionsRevisionOfSuccess({
        wanted: ["x"],
        deployedFromSha: A,
        plannedToSha: B,
        failedBundles: 0,
      }),
    ).toBe(B);
  });

  it("a named run with no recorded reach proves nothing", () => {
    for (const plannedToSha of [null, undefined, "", "not-a-sha", "ABC"]) {
      expect(
        functionsRevisionOfSuccess({
          wanted: ["x"],
          deployedFromSha: A,
          plannedToSha,
          failedBundles: 0,
        }),
      ).toBeNull();
    }
  });

  it("a run that left a bundle failed proves nothing", () => {
    expect(
      functionsRevisionOfSuccess({
        wanted: null,
        deployedFromSha: A,
        plannedToSha: null,
        failedBundles: 1,
      }),
    ).toBeNull();
    expect(
      functionsRevisionOfSuccess({
        wanted: ["x"],
        deployedFromSha: A,
        plannedToSha: B,
        failedBundles: 2,
      }),
    ).toBeNull();
  });

  it("a snapshot with no readable revision proves nothing", () => {
    for (const deployedFromSha of [null, undefined, "", "abc123", A.toUpperCase()]) {
      expect(
        functionsRevisionOfSuccess({
          wanted: null,
          deployedFromSha,
          plannedToSha: B,
          failedBundles: 0,
        }),
      ).toBeNull();
    }
  });
});

describe("recordedFunctionsRevision", () => {
  it("takes the lane's own statement wherever it made one", () => {
    expect(
      recordedFunctionsRevision({
        plan: { slugs: null },
        result: { functions_revision: B, source_sha: A },
      }),
    ).toBe(B);
  });

  it("an explicit null statement is a proof of nothing, not a fallback to the snapshot", () => {
    expect(
      recordedFunctionsRevision({
        plan: { slugs: null },
        result: { functions_revision: null, revision_recorded: true, source_sha: A },
      }),
    ).toBeNull();
  });

  it("reads a run recorded before the field existed by the same rule", () => {
    // Whole fleet: the snapshot. Named: the plan's reach.
    expect(
      recordedFunctionsRevision({
        plan: { slugs: null },
        result: { revision_recorded: true, source_sha: A },
      }),
    ).toBe(A);
    expect(
      recordedFunctionsRevision({ plan: {}, result: { revision_recorded: true, source_sha: A } }),
    ).toBe(A);
    expect(
      recordedFunctionsRevision({
        plan: { slugs: ["x"], prime_sha: B },
        result: { revision_recorded: true, source_sha: A },
      }),
    ).toBe(B);
    // A legacy named run that recorded no reach proves nothing.
    expect(
      recordedFunctionsRevision({
        plan: { slugs: ["x"] },
        result: { revision_recorded: true, source_sha: A },
      }),
    ).toBeNull();
  });

  it("a legacy run that did not record a revision proves nothing", () => {
    expect(
      recordedFunctionsRevision({
        plan: { slugs: null },
        result: { revision_recorded: false, source_sha: A },
      }),
    ).toBeNull();
    expect(
      recordedFunctionsRevision({ plan: { slugs: null }, result: { source_sha: A } }),
    ).toBeNull();
  });

  it("a plan or result it cannot read proves nothing", () => {
    expect(
      recordedFunctionsRevision({
        plan: { slugs: "everything" },
        result: { revision_recorded: true, source_sha: A },
      }),
    ).toBeNull();
    expect(
      recordedFunctionsRevision({
        plan: { slugs: ["x", 1] },
        result: { revision_recorded: true, source_sha: A },
      }),
    ).toBeNull();
    expect(recordedFunctionsRevision({ plan: null, result: null })).toBeNull();
    expect(recordedFunctionsRevision({ plan: null, result: [A] })).toBeNull();
  });
});

describe("functionsBaselineByClone", () => {
  const run = (
    cloneId: string | null,
    completedAt: string | null,
    result: unknown,
    plan: unknown = { slugs: null },
  ) => ({
    cloneId,
    completedAt,
    result,
    plan,
  });

  it("takes each clone's NEWEST proof", () => {
    const baseline = functionsBaselineByClone([
      run("one", "2026-09-19T10:00:00Z", { functions_revision: A }),
      run("one", "2026-09-26T10:00:00Z", { functions_revision: B }),
      run("two", "2026-09-20T10:00:00Z", { functions_revision: C }),
    ]);
    expect(baseline.get("one")).toBe(B);
    expect(baseline.get("two")).toBe(C);
  });

  it("steps over a newer run that proves nothing, back to an older proof", () => {
    // A later run that failed a bundle left that function where the older run
    // put it — so the older proof still holds, and stepping back to it only
    // widens the next diff.
    const baseline = functionsBaselineByClone([
      run("one", "2026-09-26T10:00:00Z", { functions_revision: null, revision_recorded: false }),
      run("one", "2026-09-19T10:00:00Z", { functions_revision: A }),
    ]);
    expect(baseline.get("one")).toBe(A);
  });

  it("leaves a clone with no proof out of the answer, so it owes everything", () => {
    const baseline = functionsBaselineByClone([
      run("one", "2026-09-26T10:00:00Z", { revision_recorded: false, source_sha: A }),
      run(null, "2026-09-26T10:00:00Z", { functions_revision: A }),
    ]);
    expect(baseline.has("one")).toBe(false);
    expect(baseline.size).toBe(0);
  });

  it("orders by completion itself, whatever order the rows arrive in", () => {
    const rows = [
      run("one", "2026-09-20T10:00:00Z", { functions_revision: A }),
      run("one", null, { functions_revision: C }),
      run("one", "2026-09-25T10:00:00Z", { functions_revision: B }),
    ];
    expect(functionsBaselineByClone(rows).get("one")).toBe(B);
    expect(functionsBaselineByClone([...rows].reverse()).get("one")).toBe(B);
  });
});
