import { describe, expect, it } from "vitest";
import { blockOvertakenBySequence } from "./blockSequence.pure";

/*
  The independent's own shape, reduced to what decides it: a hole the prime
  never ran, the v15 seed that creates the baselines table, and the v15
  refresh that reads it and names the seed's release.
*/
const HOLE = "20250124120000";
const SEED = "20261204020000";
const REFRESH = "20261204030000";
const LATER = "20261206000000";

const hole = {
  id: HOLE,
  name: `${HOLE}_fix_client_data_rls_policies.sql`,
  creates: ["client_data_policy"],
  requires: [],
  mentions: [],
};
const seed = {
  id: SEED,
  name: `${SEED}_seed_template_library_v15_running_head_and_columns.sql`,
  creates: ["template_library_release_baselines"],
  requires: ["template_library_entries"],
  mentions: [],
};
/** The same seed as it was read before 23 Sep: 41 MB, no skeleton, no facts. */
const unreadSeed = { id: SEED, name: seed.name };
const refresh = {
  id: REFRESH,
  name: `${REFRESH}_refresh_active_masters_from_library_v15.sql`,
  creates: [],
  requires: ["template_library_release_baselines", "report_templates"],
  mentions: [SEED],
};
const later = {
  id: LATER,
  name: `${LATER}_extension_migration_status_rls.sql`,
  creates: [],
  requires: [],
  mentions: [],
};

const BLOCK =
  `${REFRESH}_refresh_active_masters_from_library_v15.sql: SQL execution failed on qvuwrvwzjyigptmnijyb: ` +
  '400 — {"message":"Failed to run sql query: ERROR:  42P01: relation \\"public.template_library_release_baselines\\" does not exist"}';

const runnable = new Set([SEED, REFRESH, LATER]);

describe("blockOvertakenBySequence", () => {
  it("discharges the independent's block: the lane would now send the seed first", () => {
    const verdict = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, seed, refresh, later],
      runnableIds: runnable,
      cloneApplied: new Set(),
    });
    expect(verdict).toMatchObject({ discharged: true, blockedVersion: REFRESH, nextVersion: SEED });
    expect(verdict.why).toContain(SEED);
  });

  it("keeps a block whose version is still the first the lane would send", () => {
    // The seed has landed. The refresh is first again: if it fails now it
    // fails for its own reasons, and the block has to hold.
    const verdict = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, seed, refresh, later],
      runnableIds: runnable,
      cloneApplied: new Set([SEED]),
    });
    expect(verdict.discharged).toBe(false);
    expect(verdict.why).toContain("still the first version");
  });

  it("cannot loop: each discharge needs an earlier version, and applying it removes it", () => {
    const first = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, seed, refresh],
      runnableIds: runnable,
      cloneApplied: new Set(),
    });
    expect(first.discharged).toBe(true);
    // The seed is what gets sent. Once it is applied the same block, written
    // again by a refresh that still fails, is held.
    const again = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, seed, refresh],
      runnableIds: runnable,
      cloneApplied: new Set([SEED]),
    });
    expect(again.discharged).toBe(false);
  });

  it("keeps the block where nothing is sendable — the pre-23-Sep shape, seed unread", () => {
    // An unread seed behind a hole is held; the refresh behind it is held too
    // now. Nothing would be sent, so nothing shows the order changed.
    const verdict = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, unreadSeed, refresh],
      runnableIds: new Set([SEED, REFRESH]),
      cloneApplied: new Set(),
    });
    expect(verdict).toEqual({
      discharged: false,
      why: "the lane would send this clone nothing, so nothing shows the order it failed in has changed",
    });
  });

  it("keeps the block where only LATER versions are sendable", () => {
    // The seed waits for a hole it reads from, the refresh waits for the
    // seed, and an unrelated later version is sendable. The replay's rescue
    // reads bodies this rule does not and can readmit the refresh, so this is
    // not a sequence that proves anything — and discharging on it would
    // re-send and re-block the same migration every sweep.
    const holeTheSeedReads = { ...hole, creates: ["template_library_entries"] };
    const verdict = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [holeTheSeedReads, seed, refresh, later],
      runnableIds: runnable,
      cloneApplied: new Set(),
    });
    expect(verdict.discharged).toBe(false);
    expect(verdict.why).toContain(LATER);
  });

  it("leaves a version the clone already records to the ledger test", () => {
    const verdict = blockOvertakenBySequence({
      reason: BLOCK,
      metas: [hole, seed, refresh],
      runnableIds: runnable,
      cloneApplied: new Set([REFRESH]),
    });
    expect(verdict.discharged).toBe(false);
    expect(verdict.why).toContain("already records");
  });

  it("never discharges a reason that names no version", () => {
    for (const reason of [null, undefined, "", "claim failed: connection reset"]) {
      const verdict = blockOvertakenBySequence({
        reason,
        metas: [hole, seed, refresh],
        runnableIds: runnable,
        cloneApplied: new Set(),
      });
      expect(verdict).toEqual({ discharged: false, why: "the block names no version" });
    }
  });

  it("reads the version from the block the way the eligibility module does", () => {
    // Leading whitespace is tolerated there, so it is tolerated here.
    const verdict = blockOvertakenBySequence({
      reason: `  ${BLOCK}`,
      metas: [hole, seed, refresh],
      runnableIds: runnable,
      cloneApplied: new Set(),
    });
    expect(verdict.discharged).toBe(true);
  });
});
