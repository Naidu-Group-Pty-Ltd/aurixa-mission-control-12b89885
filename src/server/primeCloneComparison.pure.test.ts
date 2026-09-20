/**
 * Whose problem is it?
 *
 * The blocks below are the rules rather than the current strings. The side of
 * a blockage is DERIVED from `BLOCKAGE_POLICY`, so the test walks that table
 * and asserts the derivation — a test that listed today's prime-side classes
 * would pass for ever while a new one silently filed as the clone's, which is
 * exactly the failure the derivation exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { BLOCKAGE_POLICY, type BlockageClass } from "./cascade/blockageTaxonomy.pure";
import {
  buildCloneComparison,
  compareBlockers,
  readCodeStanding,
  readMigrationStanding,
  sideOfBlockage,
  type BlockageRow,
  type ComparedBlocker,
} from "./primeCloneComparison.pure";

const CLASSES = Object.keys(BLOCKAGE_POLICY) as BlockageClass[];

const row = (over: Partial<BlockageRow> = {}): BlockageRow => ({
  id: "b1",
  class: "ci_red",
  owner: "prime_author",
  detail: "the clone's checks refused this delivery",
  first_seen_at: "2026-09-18T09:00:00.000Z",
  self_heals: false,
  ...over,
});

const blocker = (over: Partial<ComparedBlocker> = {}): ComparedBlocker => ({
  id: "b1",
  cls: "ci_red",
  owner: "prime_author",
  side: "prime",
  selfHeals: false,
  what: "what",
  detail: "detail",
  firstSeenAt: "2026-09-18T09:00:00.000Z",
  ...over,
});

const CODE_OK = readCodeStanding({
  primeHeadSha: "abcdef1234567890",
  syncedSha: "abcdef1234567890",
  commitsBehind: 0,
  label: "Clone",
});
const MIG_OK = readMigrationStanding({
  frontier: "20260903010000",
  runnableVersions: ["20260901010000", "20260903010000"],
  recordedVersion: "20260903010000",
  blockedReason: null,
  label: "Clone",
});

describe("the side is derived from the policy, not from a second list", () => {
  it("every prime_author class is the prime's", () => {
    const authored = CLASSES.filter((c) => BLOCKAGE_POLICY[c].owner === "prime_author");
    // If the taxonomy ever stops carrying one, this block is measuring nothing.
    expect(authored.length).toBeGreaterThan(0);
    for (const c of authored) expect(sideOfBlockage(c)).toBe("prime");
  });

  it("prime_ledger_hole is the prime's despite being owned by an operator", () => {
    /*
      The one that is named rather than inferred. Its owner is `operator`
      because a person decides — and the person is standing at the PRIME,
      dispatching a migration there. By owner alone it would file as the
      clone's problem, which is backwards for a condition only the prime can
      clear.
    */
    expect(BLOCKAGE_POLICY.prime_ledger_hole.owner).toBe("operator");
    expect(sideOfBlockage("prime_ledger_hole")).toBe("prime");
  });

  it("every other class is the clone's", () => {
    for (const c of CLASSES) {
      if (BLOCKAGE_POLICY[c].owner === "prime_author" || c === "prime_ledger_hole") continue;
      expect(sideOfBlockage(c)).toBe("clone");
    }
  });

  it("a class this build has never heard of is the clone's, not the prime's", () => {
    // Claiming a condition nobody has classified is the prime's fault puts a
    // finding on that page which no act there can discharge.
    expect(sideOfBlockage("something_invented_later" as BlockageClass)).toBe("clone");
  });

  it("the two sides partition the taxonomy — nothing is unfiled", () => {
    for (const c of CLASSES) expect(["prime", "clone"]).toContain(sideOfBlockage(c));
  });
});

describe("a row keeps the taxonomy's sentence, and falls back to its own", () => {
  it("prefers the policy's standing description", () => {
    const [out] = compareBlockers([row({ class: "ci_red" })]);
    expect(out.what).toBe(BLOCKAGE_POLICY.ci_red.what);
    expect(out.side).toBe("prime");
    expect(out.selfHeals).toBe(false);
  });

  it("an unknown class renders its own detail rather than a blank line", () => {
    const [out] = compareBlockers([
      row({
        class: "invented",
        owner: "machinery",
        detail: "SOMETHING SPECIFIC",
        self_heals: true,
      }),
    ]);
    expect(out.what).toBe("SOMETHING SPECIFIC");
    expect(out.selfHeals).toBe(true);
    expect(out.side).toBe("clone");
  });
});

describe("the code half", () => {
  it("carrying, when the recorded sync is the prime's head", () => {
    const out = readCodeStanding({
      primeHeadSha: "abcdef1234567890",
      syncedSha: "abcdef1234567890",
      commitsBehind: 0,
      label: "Clone",
    });
    expect(out.standing).toBe("carrying");
    expect(out.tone).toBe("ok");
  });

  it("matches on a prefix of at least seven characters", () => {
    expect(
      readCodeStanding({
        primeHeadSha: "abcdef1234567890",
        syncedSha: "abcdef1",
        commitsBehind: 0,
        label: "Clone",
      }).standing,
    ).toBe("carrying");
    // Six is not enough to identify a commit, so it is not a match.
    expect(
      readCodeStanding({
        primeHeadSha: "abcdef1234567890",
        syncedSha: "abcdef",
        commitsBehind: 0,
        label: "Clone",
      }).standing,
    ).toBe("behind");
  });

  it("behind, and quotes the stored count as a stored count", () => {
    const out = readCodeStanding({
      primeHeadSha: "abcdef1234567890",
      syncedSha: "9999999999999999",
      commitsBehind: 12,
      label: "Clone",
    });
    expect(out.standing).toBe("behind");
    expect(out.sentence).toContain("12 commits");
    expect(out.sentence).toMatch(/Mission Control records/);
  });

  it("never synced is its own reading, not zero commits behind", () => {
    const out = readCodeStanding({
      primeHeadSha: "abcdef1234567890",
      syncedSha: null,
      commitsBehind: null,
      label: "Clone",
    });
    expect(out.standing).toBe("never_synced");
    expect(out.standing).not.toBe("carrying");
  });

  it("an unread prime head is unknown, and never carrying", () => {
    const out = readCodeStanding({
      primeHeadSha: null,
      syncedSha: "abcdef1234567890",
      commitsBehind: 0,
      label: "Clone",
    });
    expect(out.standing).toBe("unknown");
    expect(out.tone).toBe("idle");
  });
});

describe("the migration half", () => {
  const runnable = ["20260901010000", "20260902010000", "20260903010000"];

  it("at the frontier", () => {
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: "20260903010000",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("at_frontier");
    expect(out.owed).toBe(0);
    expect(out.tone).toBe("ok");
  });

  it("behind, counting only the runnable versions above the cursor", () => {
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: "20260901010000",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("behind");
    expect(out.owed).toBe(2);
  });

  it("a cursor past the prime's frontier is a finding, not a pass", () => {
    /*
      The direction that loses data silently: the next sync computes what is
      owed from this number, so every version between the two is skipped as
      applied and nothing offers them again. It must never render as the
      direction that is fine.
    */
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: "20261204010000",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("ahead");
    expect(out.tone).toBe("bad");
    expect(out.standing).not.toBe("at_frontier");
    // No count is offered: the set it would be measured against is wrong.
    expect(out.owed).toBeNull();
  });

  it("a cursor that is not a version cannot be ordered, and says so", () => {
    /*
      Lexicographically `"9"` sorts above `"20261204010000"`, so an unparsed
      cursor would read `ahead` — the loudest verdict here, about a clone whose
      position is simply unknown.
    */
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: "9",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("unknown");
    expect(out.standing).not.toBe("ahead");
    expect(out.owed).toBeNull();
    expect(out.sentence).toMatch(/not a version this can order/i);
  });

  it("no frontier is unknown rather than up to date", () => {
    const out = readMigrationStanding({
      frontier: null,
      runnableVersions: null,
      recordedVersion: "20260903010000",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("unknown");
    expect(out.owed).toBeNull();
  });

  it("no recorded version is an absent record, said as one", () => {
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: null,
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("unknown");
    expect(out.sentence).toMatch(/not an empty ledger/i);
  });

  it("an unreadable runnable set still reads behind, with no invented count", () => {
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: null,
      recordedVersion: "20260901010000",
      blockedReason: null,
      label: "Clone",
    });
    expect(out.standing).toBe("behind");
    expect(out.owed).toBeNull();
  });

  it("carries the clone's own reason for stopping", () => {
    const out = readMigrationStanding({
      frontier: "20260903010000",
      runnableVersions: runnable,
      recordedVersion: "20260901010000",
      blockedReason: "held behind 20260902010000",
      label: "Clone",
    });
    expect(out.blockedReason).toBe("held behind 20260902010000");
  });
});

describe("the verdict", () => {
  const base = {
    cloneId: "c1",
    label: "Clone",
    repoFullName: "org/clone",
    syncScope: "mirror",
    code: CODE_OK,
    migrations: MIG_OK,
    blockersError: null,
  };

  it("an unread blockage ledger outranks every clean reading beneath it", () => {
    /*
      A clone carrying prime's head at prime's frontier with an unreadable
      blockage table is not converged; it is a clone we cannot describe.
    */
    const out = buildCloneComparison({
      ...base,
      blockers: null,
      blockersError: "permission denied for table clone_sync_blockages",
    });
    expect(out.verdict).toBe("unreadable");
    expect(out.verdict).not.toBe("converged");
    expect(out.primeSide).toBeNull();
    expect(out.cloneSide).toBeNull();
  });

  it("a prime-side blockage outranks a clone-side one", () => {
    const out = buildCloneComparison({
      ...base,
      blockers: [
        blocker({ id: "a", cls: "attempts_exhausted", side: "clone" }),
        blocker({ id: "b", cls: "ci_red", side: "prime" }),
      ],
    });
    expect(out.verdict).toBe("prime_blocked");
    expect(out.tone).toBe("bad");
    expect(out.primeSide).toBe(1);
    expect(out.cloneSide).toBe(1);
    expect(out.headline).toMatch(/happens on the source/);
  });

  it("blockages that are none of the prime's read as held here", () => {
    const out = buildCloneComparison({
      ...base,
      blockers: [blocker({ cls: "attempts_exhausted", side: "clone" })],
    });
    expect(out.verdict).toBe("clone_blocked");
    expect(out.primeSide).toBe(0);
  });

  it("nothing open and one half unknown is not converged", () => {
    const out = buildCloneComparison({
      ...base,
      code: readCodeStanding({
        primeHeadSha: null,
        syncedSha: "abcdef1234567890",
        commitsBehind: null,
        label: "Clone",
      }),
      blockers: [],
    });
    expect(out.verdict).toBe("unreadable");
    expect(out.verdict).not.toBe("converged");
  });

  it("a cursor ahead of the prime is drawn as a problem even with nothing open", () => {
    const out = buildCloneComparison({
      ...base,
      migrations: readMigrationStanding({
        frontier: "20260903010000",
        runnableVersions: ["20260903010000"],
        recordedVersion: "20261204010000",
        blockedReason: null,
        label: "Clone",
      }),
      blockers: [],
    });
    expect(out.verdict).toBe("clone_blocked");
    expect(out.tone).toBe("bad");
    expect(out.headline).toMatch(/worse than being behind/i);
  });

  it("behind with nothing open is lagging, and says a pass will move it", () => {
    const out = buildCloneComparison({
      ...base,
      migrations: readMigrationStanding({
        frontier: "20260903010000",
        runnableVersions: ["20260901010000", "20260903010000"],
        recordedVersion: "20260901010000",
        blockedReason: null,
        label: "Clone",
      }),
      blockers: [],
    });
    expect(out.verdict).toBe("lagging");
    expect(out.tone).toBe("warn");
  });

  it("converged needs everything read AND everything clean", () => {
    const out = buildCloneComparison({ ...base, blockers: [] });
    expect(out.verdict).toBe("converged");
    expect(out.tone).toBe("ok");
    expect(out.primeSide).toBe(0);
    expect(out.cloneSide).toBe(0);
  });
});
