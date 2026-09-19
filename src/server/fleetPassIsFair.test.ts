/**
 * No clone may be last in the queue twice running.
 *
 * The ordering this pins was measured rather than reasoned about. On
 * 19 September 2026 three clones sat tied at `20261201100000`, part-way
 * through one 41 MB seed, and the statements each had landed descended
 * exactly with the order the database returned them — 25, 17 and 11, the
 * third last served an hour earlier while the first two advanced on the same
 * pass 25 ms apart. The comparator answered `0` for the tie and `Array#sort`
 * is stable, so the order came from a `.select()` with no `ORDER BY` and did
 * not change between passes.
 *
 * These tests are about the SECOND key. The first one is unchanged and is
 * asserted here only so that adding fairness cannot be shown to have cost
 * precedence.
 */
import { describe, it, expect } from "vitest";
import { furthestBehindThenLeastRecentlyServed as cmp } from "./fleet-migration.server";

type Row = Parameters<typeof cmp>[0];

function row(id: string, version: string | null, heartbeat: string | null): Row {
  return { clone_id: id, migration_version: version, migration_heartbeat_at: heartbeat };
}

/** Names in served order, which is the only thing any caller reads. */
function order(rows: Row[]): string[] {
  return [...rows].sort(cmp).map((r) => r.clone_id);
}

describe("which clone a fleet pass serves first", () => {
  it("still puts the clone furthest behind first, whatever its heartbeat says", () => {
    // The behind clone was served MOST recently, so the tie-break would put it
    // last if it were ever allowed to outrank the version.
    const behind = row("behind", "20261201100000", "2026-09-19T16:30:00.000Z");
    const ahead = row("ahead", "20261204010000", "2026-09-01T00:00:00.000Z");
    expect(order([ahead, behind])).toEqual(["behind", "ahead"]);
  });

  it("puts a backend with no recorded version ahead of every one that has one", () => {
    const none = row("none", null, "2026-09-19T16:30:00.000Z");
    const some = row("some", "20261201100000", null);
    expect(order([some, none])).toEqual(["none", "some"]);
  });

  /*
    THE MEASURED CASE.

    Three clones, one version, and the heap order that starved the third. The
    fixture is the production reading: the served-most-recently pair carry the
    16:30 pass and the starved one carries 15:30.
  */
  it("serves the clone it has not served for an hour before the two it served last pass", () => {
    const preflight = row("preflight", "20261201100000", "2026-09-19T16:30:44.498Z");
    const clientDash = row("client-dashboard", "20261201100000", "2026-09-19T16:30:44.523Z");
    const npcTest = row("npc-test", "20261201100000", "2026-09-19T15:30:59.767Z");
    // Fed in the order the database returned them, which is the order that
    // produced the starvation.
    expect(order([preflight, clientDash, npcTest])).toEqual([
      "npc-test",
      "preflight",
      "client-dashboard",
    ]);
  });

  it("puts a clone this lane has never served ahead of every clone it has", () => {
    const fresh = row("fresh", "20261201100000", null);
    const old = row("old", "20261201100000", "2020-01-01T00:00:00.000Z");
    expect(order([old, fresh])).toEqual(["fresh", "old"]);
  });

  /*
    AND THE ROTATION IS THE POINT, not merely the first pass being different.
    Serving a clone stamps its heartbeat, so the next pass must not choose it
    again while another is older. A tie-break that were merely a different
    FIXED order would pass every test above and still starve somebody.
  */
  it("rotates: the clone served this pass is last on the next one", () => {
    let rows = [
      row("a", "20261201100000", "2026-09-19T15:00:00.000Z"),
      row("b", "20261201100000", "2026-09-19T15:30:00.000Z"),
      row("c", "20261201100000", "2026-09-19T16:00:00.000Z"),
    ];
    const servedIn: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      // A budget that reaches exactly one clone — the condition under which
      // "served last" and "never served" are the same thing.
      const first = [...rows].sort(cmp)[0];
      servedIn.push(first.clone_id);
      const stamp = `2026-09-19T17:0${pass}:00.000Z`;
      rows = rows.map((r) =>
        r.clone_id === first.clone_id ? row(r.clone_id, r.migration_version, stamp) : r,
      );
    }
    expect(servedIn).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("is deterministic where two clones are level and neither was ever served", () => {
    // A fresh fleet. Arbitrary is acceptable here BECAUSE one pass ends it;
    // what is not acceptable is an order nothing in the process defines.
    const x = row("11111111-1111-1111-1111-111111111111", "20261201100000", null);
    const y = row("22222222-2222-2222-2222-222222222222", "20261201100000", null);
    expect(order([y, x])).toEqual([x.clone_id, y.clone_id]);
    expect(order([x, y])).toEqual([x.clone_id, y.clone_id]);
  });

  it("never answers 0 for two different clones, so no input order can survive it", () => {
    /*
      The defect in one line. A comparator that can answer 0 for two rows hands
      the decision to whatever order they arrived in, and this one arrives from
      a select with no ORDER BY. Asserted over every combination of the three
      fields rather than on an example.
    */
    const versions = [null, "20261201100000", "20261204010000"];
    const beats = [null, "2026-09-19T15:30:00.000Z", "2026-09-19T16:30:00.000Z"];
    const rows: Row[] = [];
    let n = 0;
    for (const v of versions) for (const h of beats) rows.push(row(`clone-${n++}`, v, h));
    for (const a of rows) {
      for (const b of rows) {
        if (a.clone_id === b.clone_id) continue;
        expect(cmp(a, b), `${a.clone_id} vs ${b.clone_id} is a coin toss`).not.toBe(0);
        // And antisymmetric, or `sort` is free to produce anything at all.
        expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)));
      }
    }
  });
});
