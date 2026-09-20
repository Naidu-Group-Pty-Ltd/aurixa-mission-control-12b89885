import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MIGRATION_LANE_DETAIL_PREFIXES,
  PRIME_LEDGER_HOLE_NOTE_CAP,
  blockageDetailFor,
  holesNamedBy,
  isBlockageNote,
  migrationLaneWroteDetail,
  primeLedgerHoleNote,
  primeLedgerHoleSentence,
  reconcileBlockageRecord,
} from "./fleetBlockageRecord.pure";
import { partitionByDependency } from "./fleetCorpusScope.pure";

const read = (p: string) => readFileSync(p, "utf8");

/*
  THE HALF THAT PROTECTS THE VERDICT.

  A prefix that also matches a provisioning or parity sentence hands the
  migration lane permission to erase a reading it cannot re-derive — which is
  the defect the `didNothing` guard was built to stop, and the one it would be
  a poor trade to re-introduce while fixing its opposite. So the recognised
  set is asserted in BOTH directions, and the negative half is the load-bearing
  one.
*/
describe("whose sentence is standing on the row", () => {
  const MIGRATION_LANE = [
    "Synced to 20261206000000",
    "Synced to the prime's latest recorded migration — 4 migration(s) held back behind 20261201100000",
    "Synced to 20261202090000 so far — this pass stopped at its time budget with more to send",
    "Migration failed at 20261204010000_email_followup_reminders.sql",
    "Sending 20261203000000 — 9 statement(s) in (rows 81-90)",
    "Syncing migrations from Naidu-Group-Pty-Ltd/npc-property-dashbord...",
    "Migration sync refused: the prime backend reports no applied migrations",
    "Migration error: HTTP 403",
    "Migrations up to date (20261206000000)",
    "Verified level with the prime's recorded migrations",
  ];

  const NOT_OURS = [
    "Backend provisioned but DOES NOT MATCH the prime — missing_secrets:58. Review at /clones/abc",
    "Backend ready, but parity could not be verified (timeout) — it has not been compared with the prime",
    "Backend is ready — modules added",
    "Module add finished with 2 failure(s)",
    "Paused at the invocation budget — 41 of 78 stages done",
    "Waiting on an upstream API rate limit",
    "Provisioning failed",
    "Requeued — background worker will retry within ~60 seconds",
    "Adding modules...",
    // Written by `applyPrimeMigrations`' `onStatusUpdate` — which the fleet
    // lane passes `undefined` for, so this sentence is only ever
    // provisioning's, and claiming it would let a fleet pass erase a
    // provisioning run's progress line.
    "Applying migration 3/11: 20261203000000_seed.sql",
    "Worker stalled — requeued",
    "Provisioning ceiling exceeded",
    "Live on the provider origin. No subdomain is reserved for this clone.",
  ];

  for (const detail of MIGRATION_LANE) {
    it(`recognises its own: ${detail.slice(0, 48)}`, () => {
      expect(migrationLaneWroteDetail(detail)).toBe(true);
    });
  }

  for (const detail of NOT_OURS) {
    it(`leaves another writer's alone: ${detail.slice(0, 48)}`, () => {
      expect(migrationLaneWroteDetail(detail)).toBe(false);
    });
  }

  it("treats an absent or blank sentence as nobody's, and therefore fillable", () => {
    expect(migrationLaneWroteDetail(null)).toBe(true);
    expect(migrationLaneWroteDetail(undefined)).toBe(true);
    expect(migrationLaneWroteDetail("   ")).toBe(true);
  });

  it("declares every prefix it matches on, so the two ends cannot drift", () => {
    for (const detail of MIGRATION_LANE) {
      expect(MIGRATION_LANE_DETAIL_PREFIXES.some((p) => detail.startsWith(p))).toBe(true);
    }
  });
});

describe("the note a hole is recorded as", () => {
  it("names the version and says nothing was applied", () => {
    const note = primeLedgerHoleNote("20261206000000");
    expect(note.id).toBe("20261206000000");
    expect(note.primeLedgerHole).toBe(true);
    expect(note.blockedBy).toBeUndefined();
  });

  /*
    `successes` is `results.filter((r) => r.success && !r.skipped)`. A note that
    missed `skipped` would count as a migration this pass applied — which would
    move `migration_version`, flip `didNothing`, and report a version the clone
    does not hold as one it does.
  */
  it("can never read as a migration applied", () => {
    const note = primeLedgerHoleNote("20261206000000") as { success: boolean; skipped?: boolean };
    expect([note].filter((r) => r.success && !r.skipped)).toHaveLength(0);
  });

  it("can never read as a migration withheld", () => {
    const note = primeLedgerHoleNote("20261206000000") as { blockedBy?: string[] };
    expect([note].filter((r) => r.blockedBy && r.blockedBy.length > 0)).toHaveLength(0);
  });

  it("is a blockage note, so the reconciliation owns it", () => {
    expect(isBlockageNote(primeLedgerHoleNote("x"))).toBe(true);
    expect(isBlockageNote({ id: "a", name: "a", success: true })).toBe(false);
    expect(isBlockageNote({ id: "a", blockedBy: [] })).toBe(false);
    expect(isBlockageNote({ id: "a", blockedBy: ["h"] })).toBe(true);
    expect(isBlockageNote(null)).toBe(false);
  });
});

describe("the versions a stored record names as short", () => {
  it("reads both shapes and keeps corpus order without repeating", () => {
    expect(
      holesNamedBy([
        { id: "a", name: "a", success: true },
        { id: "b", name: "b", blockedBy: ["h1", "h2"] },
        primeLedgerHoleNote("h2"),
        primeLedgerHoleNote("h3"),
      ]),
    ).toEqual(["h1", "h2", "h3"]);
  });

  it("tolerates anything the column can hold", () => {
    expect(holesNamedBy(null)).toEqual([]);
    expect(holesNamedBy("not an array")).toEqual([]);
    expect(holesNamedBy([null, 7, ["nested"], { blockedBy: "not an array" }])).toEqual([]);
    expect(holesNamedBy([{ blockedBy: [1, "h", null] }])).toEqual(["h"]);
  });
});

describe("reconciling the blockage record", () => {
  /*
    THE ORDINARY HEALTHY PASS.

    Nothing changed, so nothing is written and the row is left exactly as
    found — byte-identical to the behaviour before this module existed. Every
    pass on a level fleet lands here, so a regression here is a regression on
    every clone.
  */
  it("writes nothing when the record already says what the pass measured", () => {
    expect(reconcileBlockageRecord({ stored: [], measured: [] }).entries).toBeNull();
    expect(
      reconcileBlockageRecord({
        stored: [primeLedgerHoleNote("h1")],
        measured: ["h1"],
      }).entries,
    ).toBeNull();
    expect(
      reconcileBlockageRecord({
        stored: [{ id: "a", name: "a", success: true }],
        measured: [],
      }).entries,
    ).toBeNull();
  });

  /*
    THE DEFECT THIS MODULE EXISTS TO CLOSE.

    The record of a blockage was written by the pass that found it and by no
    pass that disproved it, so `blockageLedger` — which reads exactly these
    `blockedBy` entries — kept the `prime_ledger_hole` row open for ever.
  */
  it("drops a blockage the pass disproved and keeps everything else, in order", () => {
    const out = reconcileBlockageRecord({
      stored: [
        { id: "m1", name: "m1", success: true },
        { id: "m2", name: "m2", success: true, skipped: true, blockedBy: ["h1"] },
        { id: "m3", name: "m3", success: true },
      ],
      measured: [],
    });
    expect(out.discharged).toEqual(["h1"]);
    expect(out.opened).toEqual([]);
    expect(out.entries).toEqual([
      { id: "m1", name: "m1", success: true },
      { id: "m3", name: "m3", success: true },
    ]);
  });

  it("records a hole the previous pass did not name", () => {
    const out = reconcileBlockageRecord({
      stored: [{ id: "m1", name: "m1", success: true }],
      measured: ["h9"],
    });
    expect(out.opened).toEqual(["h9"]);
    expect(out.discharged).toEqual([]);
    expect(out.entries).toEqual([
      { id: "m1", name: "m1", success: true },
      primeLedgerHoleNote("h9"),
    ]);
  });

  it("reports a swap as both a discharge and an opening", () => {
    const out = reconcileBlockageRecord({
      stored: [{ id: "m2", name: "m2", blockedBy: ["old"] }],
      measured: ["new"],
    });
    expect(out.discharged).toEqual(["old"]);
    expect(out.opened).toEqual(["new"]);
    expect(out.holes).toEqual(["new"]);
  });

  /*
    A no-op pass that emptied this array is one of the three things the
    `didNothing` guard exists to stop — provisioning's record of what it
    applied is not this lane's to destroy.
  */
  it("never empties provisioning's record", () => {
    const provisioning = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      name: `p${i}`,
      success: true,
    }));
    const out = reconcileBlockageRecord({
      stored: [...provisioning, { id: "m", name: "m", blockedBy: ["h"] }],
      measured: [],
    });
    expect(out.entries).toEqual(provisioning);
  });

  it("tolerates a column holding something else entirely", () => {
    expect(reconcileBlockageRecord({ stored: null, measured: ["h"] }).entries).toEqual([
      primeLedgerHoleNote("h"),
    ]);
    expect(
      reconcileBlockageRecord({ stored: { not: "an array" }, measured: [] }).entries,
    ).toBeNull();
  });

  it("ignores a repeated or empty measurement", () => {
    const out = reconcileBlockageRecord({ stored: [], measured: ["h", "h", "", "h2"] });
    expect(out.holes).toEqual(["h", "h2"]);
  });
});

describe("what an operator is told", () => {
  it("retracts to the level reading when the holes are gone", () => {
    expect(
      blockageDetailFor({
        standing: "Synced to X — 4 migration(s) held back behind 20261201100000",
        holes: [],
        syncedTo: "20261206000000",
      }),
    ).toBe("Synced to 20261206000000");
  });

  /*
    The assertion that protects the parity verdict. A migration pass may
    retract its own sentence and no one else's.
  */
  it("says nothing over another writer's sentence", () => {
    expect(
      blockageDetailFor({
        standing: "Backend provisioned but DOES NOT MATCH the prime — missing_secrets:58",
        holes: [],
        syncedTo: "20261206000000",
      }),
    ).toBeNull();
  });

  it("names the hole as the prime's to record, never as a fault on the clone", () => {
    const sentence = primeLedgerHoleSentence(["20261206000000"]);
    expect(sentence).toContain("the prime's ledger is short of 20261206000000");
    expect(sentence).toContain("this clone is level without");
    expect(sentence).not.toMatch(/fail|error|broken|refused/i);
  });

  /*
    The cap bounds how many rows one pass opens. It must never bound the count
    an operator is shown, because on this reading the number is the message.
  */
  it("states the true count even where the notes were capped", () => {
    const filed = Array.from({ length: PRIME_LEDGER_HOLE_NOTE_CAP }, (_, i) => `h${i}`);
    expect(primeLedgerHoleSentence(filed, 300)).toContain("and 299 other version(s)");
  });

  it("does not undercount when no total is supplied", () => {
    expect(primeLedgerHoleSentence(["a", "b", "c"])).toContain("and 2 other version(s)");
  });
});

/*
  TWO THINGS THE FIRST VERSION OF THIS MODULE GOT WRONG.

  Both were found by review on the merged commit, and both are cases the tests
  above did not reach — the first is a constraint that was written down for
  this change and then not implemented, which is the more useful kind of miss
  to pin.
*/
describe("a pass that stopped early knows nothing about being level", () => {
  /*
    `didNothing` does not imply the replay finished. `applyChunkedSeed` returns
    `stoppedEarly` with `applied: 0` when a stored cursor names more statements
    than the seed has, and the caller breaks on it having pushed no result at
    all — so a pass can discharge a hole, change nothing else, and still have a
    runnable migration pending. Writing `Synced to X` there reports a clone
    dozens of migrations behind as healthy.
  */
  /*
    The invariant is COMPOSED, not delegated. A first fix returned null here,
    trusting the sentence already on the row to be a pause. It need not be:
    `clearStaleMigrationFailure` writes a bare `Synced to X` and leaves
    `migrations_applied` alone, so a row can carry hole notes under a level
    sentence — and discharging the last hole on a paused pass would then leave
    that level claim standing over a clone with more to send.
  */
  it("never leaves a level reading standing over a pause, whatever was there before", () => {
    for (const standing of [
      "Synced to 20261202090000 so far — this pass stopped at its time budget",
      // The one that breaks a delegated invariant: self-healing's bare level
      // reading, written without touching `migrations_applied`.
      "Synced to 20261202090000",
      "Migrations up to date (20261202090000)",
      "Sending 20261203000000 — 16 statement(s) in (rows 151-160)",
      null,
    ]) {
      const detail = blockageDetailFor({
        standing,
        holes: [],
        pausedMidReplay: true,
        syncedTo: "20261202090000",
      });
      expect(detail, `standing: ${standing}`).not.toBeNull();
      expect(detail).toContain("so far");
      expect(detail).toContain("more to send");
      expect(detail).not.toBe("Synced to 20261202090000");
    }
  });

  it("still names the holes on a paused pass, but never as a level reading", () => {
    const detail = blockageDetailFor({
      standing: "Synced to 20261202090000 so far — this pass stopped at its time budget",
      holes: ["20261207000000"],
      pausedMidReplay: true,
      syncedTo: "20261202090000",
    });
    expect(detail).toContain("so far");
    expect(detail).toContain("stopped at its time budget");
    expect(detail).toContain("the prime's ledger is short of 20261207000000");
    // The bare level reading is exactly what must not appear.
    expect(detail).not.toBe("Synced to 20261202090000");
  });

  it("gives the level reading only when the pass finished looking", () => {
    expect(
      blockageDetailFor({
        standing: "Synced to X — 4 migration(s) held back behind 20261201100000",
        holes: [],
        pausedMidReplay: false,
        syncedTo: "20261206000000",
      }),
    ).toBe("Synced to 20261206000000");
  });

  it("is handed the pause rather than inferring it from the holes", () => {
    // Same holes, opposite readings — so the flag is load-bearing and cannot
    // be reconstructed from anything else this function is given.
    const paused = blockageDetailFor({
      standing: null,
      holes: ["h"],
      pausedMidReplay: true,
      syncedTo: "v",
    });
    const finished = blockageDetailFor({ standing: null, holes: ["h"], syncedTo: "v" });
    expect(paused).not.toBe(finished);
  });

  it("retracts a stale pause once the clone is level", () => {
    /*
      THE MIRROR OF THE PAUSE THAT COULD NOT BE WRITTEN.

      Once a clone goes level every pass is a no-op with an unchanged blockage
      record. Under the old caller gate that meant no sentence was ever written
      again — so the last budgeted pass's `stopped at its time budget with more
      to send` stood for ever on a clone with nothing left to send.

      Same cause as the reported finding, opposite direction: the sentence was
      gated on whether the RECORD changed, which is a different question.
    */
    expect(
      blockageDetailFor({
        standing:
          "Synced to 20261206000000 so far — this pass stopped at its time budget with more to send",
        holes: [],
        pausedMidReplay: false,
        syncedTo: "20261207010000",
      }),
    ).toBe("Synced to 20261207010000");
  });

  it("says nothing when the row already carries the reading", () => {
    // A level clone re-composes its own sentence on every tick. Writing it
    // back each time is churn on a shared column, and the write is what this
    // lane's `didNothing` guard exists to withhold unless there is something
    // to say.
    for (const [standing, args] of [
      ["Synced to 20261207010000", { holes: [], pausedMidReplay: false }],
      [
        "Synced to 20261207010000 so far — this pass stopped at its time budget with more to send",
        { holes: [], pausedMidReplay: true },
      ],
    ] as const) {
      expect(
        blockageDetailFor({ standing, syncedTo: "20261207010000", ...args }),
        `standing: ${standing}`,
      ).toBeNull();
    }
  });

  it("still refuses a sentence another writer put there", () => {
    // The equality check is an ADDITIONAL reason to say nothing, never a
    // replacement for the ownership guard: a parity verdict differs from the
    // composed reading and must still survive.
    expect(
      blockageDetailFor({
        standing:
          "Backend ready, but parity could not be verified (timeout) — it has not been compared with the prime",
        holes: [],
        pausedMidReplay: true,
        syncedTo: "20261207010000",
      }),
    ).toBeNull();
  });

  it("names the clone's own recorded version rather than prose, in every sentence", () => {
    /*
      THE SAME FALSE LEVEL READING, IN THE SIBLING BRANCH.

      `latestApplied` is null on every chunking pass — it finishes no
      migration — so a `syncedTo` of `latestApplied ?? <prose>` put the prose
      into the PAUSE sentence. Measured on the live fleet 20 Sep 2026, all
      three clones read `Synced to the prime's latest recorded migration so
      far — this pass stopped at its time budget`: the opening clause is the
      strongest claim of synchrony there is, and it was false on all three.

      `migration_version` is a reading of the clone's own ledger, so it is
      exactly what such a pass may name. Pinned as ONE resolution both
      composers read, because two of them is how two consecutive passes come
      to describe one clone's level differently.
    */
    const lane = read("src/server/fleet-migration.server.ts");
    expect(lane).toContain(
      'latestApplied ?? backend.migration_version ?? "the prime\'s latest recorded migration"',
    );
    // Handed the const, never a second resolution of its own.
    const call = lane.slice(lane.indexOf("blockageDetailFor({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("syncedTo,");
    expect(args).not.toContain("latestApplied ??");
  });

  it("the fleet lane hands it over", () => {
    const lane = read("src/server/fleet-migration.server.ts");
    const call = lane.slice(lane.indexOf("blockageDetailFor({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("pausedMidReplay");
    // And reads it only after it is declared — a const in its temporal dead
    // zone throws at runtime on the one path that reaches it.
    expect(lane.indexOf("const pausedMidReplay =")).toBeLessThan(
      lane.indexOf("const blockageDetail ="),
    );
  });
});

describe("a legacy blockedBy entry is replaced even when the holes are unchanged", () => {
  /*
    The entries carry more than the set of holes. A `blockedBy` entry names a
    migration being WITHHELD, and this reconciliation only ever runs on a pass
    where nothing is blocked — so the entry is disproved whatever the hole set
    does.

    The case: a clone acquires a formerly withheld migration by another route
    (the per-clone sync, self-healing, a repair by hand) while the hole that
    withheld it is still a hole. Comparing hole ids alone, the record never
    changes again and `blockageLedger` reports a `heldCount` for a migration
    nothing is holding, for ever.
  */
  it("replaces it with the explicit hole note", () => {
    const out = reconcileBlockageRecord({
      stored: [
        { id: "keep", name: "keep", success: true },
        { id: "m", name: "m", success: true, skipped: true, blockedBy: ["h"] },
      ],
      measured: ["h"],
    });
    expect(out.discharged).toEqual([]);
    expect(out.opened).toEqual([]);
    expect(out.entries).toEqual([
      { id: "keep", name: "keep", success: true },
      primeLedgerHoleNote("h"),
    ]);
  });

  it("leaves a record that already is the right notes alone", () => {
    // The healthy steady state, and the one that must stay byte-identical.
    expect(
      reconcileBlockageRecord({
        stored: [{ id: "keep", success: true }, primeLedgerHoleNote("h")],
        measured: ["h"],
      }).entries,
    ).toBeNull();
  });

  it("rewrites when the notes are the right ids in the wrong order", () => {
    expect(
      reconcileBlockageRecord({
        stored: [primeLedgerHoleNote("b"), primeLedgerHoleNote("a")],
        measured: ["a", "b"],
      }).entries,
    ).toEqual([primeLedgerHoleNote("a"), primeLedgerHoleNote("b")]);
  });
});

/*
  THE HOLE THE PARTITION USED TO DISCARD.

  `holes` was accumulated for the whole corpus walk and never returned, so a
  hole reached the record only as the `blockedBy` of an orphan sitting AFTER
  it. A hole at the tail of the corpus has no orphan after it.
*/
describe("partitionByDependency reports its holes", () => {
  const meta = (id: string) => ({ id, name: id });

  it("returns a hole that is withholding something", () => {
    const part = partitionByDependency(
      [meta("a"), meta("hole"), meta("b")],
      new Set(["a", "b"]),
      new Set<string>(),
    );
    expect(part.holes).toEqual(["hole"]);
    expect(part.send.map((m) => m.id)).toEqual(["a"]);
    expect(part.orphaned.map((o) => o.meta.id)).toEqual(["b"]);
  });

  it("returns a hole at the tail, which withholds nothing and produces no orphan", () => {
    const part = partitionByDependency(
      [meta("a"), meta("b"), meta("hole")],
      new Set(["a", "b"]),
      new Set<string>(),
    );
    expect(part.orphaned).toEqual([]);
    expect(part.holes).toEqual(["hole"]);
  });

  it("is not a hole where the clone already has it", () => {
    const part = partitionByDependency(
      [meta("a"), meta("hole")],
      new Set(["a"]),
      new Set(["hole"]),
    );
    expect(part.holes).toEqual([]);
  });
});

/*
  A MODULE IS NOT SHIPPED UNTIL SOMETHING CALLS IT.

  This repository has paid for that rule twice — three builder-portal
  components and twenty-eight stylesheet rules merged, deployed and never
  rendered — and `buildPrimeLedgerReconciliation` is sitting in it right now
  with zero call sites. An unused export typechecks, lints and builds.
*/
describe("the fix is mounted", () => {
  /*
    Pinned on the DATA FLOW, not on the mention. A first version of this
    asserted the source contained `reconcileBlockageRecord(` — which a call
    whose result is thrown away satisfies just as well, and that is precisely
    the failure this describe block exists to catch. What is asserted instead
    is that the `didNothing` branch writes the reconciled array: nothing
    downstream works if that assignment is not there.
  */
  it("the fleet lane writes the reconciled record on a pass that changed nothing", () => {
    const lane = read("src/server/fleet-migration.server.ts");
    expect(lane).toContain("reconcileBlockageRecord({");
    expect(lane).toContain("migrations_applied: blockage.entries");
    expect(lane).toContain("status_detail: blockageDetail");
    // Read, or there is nothing to reconcile against.
    expect(lane).toContain("migrations_applied, status_detail");

    // A pass that changed nothing said nothing at all once, including about
    // the one thing it was the authority on. It says it in a write of its own
    // now: the update that releases the claim must land unconditionally, so it
    // cannot carry an opinion drawn from a snapshot read 45 seconds earlier.
    const gate = lane.indexOf("const noopFacts = {");
    expect(gate, "the no-op facts have no write of their own").toBeGreaterThan(-1);
    const branch = lane.slice(gate);
    expect(branch).toContain("blockage.entries === null");
    // Written independently of the record: gating the sentence on the record
    // is what left a paused pass unable to retract a bare `Synced to X`.
    expect(branch).toContain(
      "...(blockageDetail === null ? {} : { status_detail: blockageDetail })",
    );
  });

  it("the replay files a note for every hole it measured", () => {
    const replay = read("src/server/backend-provisioning.server.ts");
    expect(replay).toContain("primeLedgerHoleNote(version)");
    expect(replay).toContain("PRIME_LEDGER_HOLE_NOTE_CAP");
    // Filed BEFORE the loop: that is what makes it complete on a pass the
    // budget stopped, and on one that broke on a cursor it could not honour.
    const holeNote = replay.indexOf("primeLedgerHoleNote(version)");
    const loop = replay.indexOf("for (let i = 0; i < ordered.length; i++)");
    expect(holeNote).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(holeNote);
  });

  it("the blockage ledger opens a row for a hole that withholds nothing", () => {
    const ledger = read("src/server/blockageLedger.server.ts");
    expect(ledger).toContain("primeLedgerHole === true");
  });

  it("the partition still returns its holes", () => {
    expect(read("src/server/fleetCorpusScope.pure.ts")).toContain(
      "return { send, orphaned, holes }",
    );
  });
});
