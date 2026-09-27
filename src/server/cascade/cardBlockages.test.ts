import { describe, expect, it } from "vitest";
import { groupCardBlockages, type OpenBlockageRow } from "./cardBlockages.pure";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";

const row = (over: Partial<OpenBlockageRow> & Pick<OpenBlockageRow, "id">): OpenBlockageRow => ({
  class: "prime_ledger_hole",
  owner: "operator",
  detail: "detail",
  first_seen_at: "2026-09-22T09:37:07.450Z",
  self_heals: false,
  ...over,
});

/*
  The CRM independent on 27 Sep 2026: 52 open hole rows, one per version,
  first seen from 22 Sep onward. The card drew six identical sentences and said
  nothing of the other forty-six, and a class opening later could not appear.
*/
const independent = (): OpenBlockageRow[] =>
  Array.from({ length: 52 }, (_, i) =>
    row({
      id: `hole-${i}`,
      detail: `version ${i}`,
      first_seen_at: new Date(Date.UTC(2026, 8, 22, 9, 37) + i * 60_000).toISOString(),
    }),
  );

describe("the sync card lists every class that is open, once", () => {
  it("draws 52 rows of one class as one line that says 52", () => {
    const groups = groupCardBlockages(independent());
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(52);
    expect(groups[0].what).toBe(BLOCKAGE_POLICY.prime_ledger_hole.what);
    // The line is dated by its OLDEST row.
    expect(groups[0].firstSeenAt).toBe("2026-09-22T09:37:00.000Z");
  });

  it("shows a class that opened after every older row", () => {
    // Before, a red cascade PR opened here would have been row 53 of a list cut at six.
    const rows = [
      ...independent(),
      row({
        id: "ci",
        class: "ci_red",
        owner: "prime_author",
        detail: "PR #264 is red",
        first_seen_at: "2026-09-26T15:59:57.486Z",
      }),
    ];
    const groups = groupCardBlockages(rows);
    expect(groups.map((g) => g.cls)).toEqual(["prime_ledger_hole", "ci_red"]);
    expect(groups[1].count).toBe(1);
    expect(groups[1].owner).toBe("prime_author");
  });

  it("orders the lines by each class's oldest row, whatever order they were read in", () => {
    const rows = [
      row({
        id: "b",
        class: "ci_red",
        owner: "prime_author",
        first_seen_at: "2026-09-26T00:00:00Z",
      }),
      row({ id: "a", first_seen_at: "2026-09-23T00:00:00Z" }),
      row({ id: "c", first_seen_at: "2026-09-21T00:00:00Z" }),
    ];
    const groups = groupCardBlockages(rows);
    expect(groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", 2, "2026-09-21T00:00:00Z"],
      ["ci_red", 1, "2026-09-26T00:00:00Z"],
    ]);
  });

  it("takes a known class's owner and sentence from the taxonomy, together", () => {
    // A row written under an older policy must not pair today's sentence with yesterday's owner.
    const [g] = groupCardBlockages([row({ id: "x", owner: "machinery", self_heals: true })]);
    expect(g.owner).toBe(BLOCKAGE_POLICY.prime_ledger_hole.owner);
    expect(g.selfHeals).toBe(BLOCKAGE_POLICY.prime_ledger_hole.selfHeals);
    expect(g.what).toBe(BLOCKAGE_POLICY.prime_ledger_hole.what);
  });

  it("never draws one unknown row's words over another's", () => {
    const groups = groupCardBlockages([
      row({ id: "1", class: "retired_class", owner: "machinery", detail: "first reason" }),
      row({ id: "2", class: "retired_class", owner: "machinery", detail: "second reason" }),
      row({ id: "3", class: "retired_class", owner: "machinery", detail: "first reason" }),
    ]);
    expect(groups.map((g) => [g.what, g.count])).toEqual([
      ["first reason", 2],
      ["second reason", 1],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it("an unreadable start sorts last rather than first", () => {
    const groups = groupCardBlockages([
      row({ id: "a", class: "ci_red", owner: "prime_author", first_seen_at: "not a date" }),
      row({ id: "b", first_seen_at: "2026-09-23T00:00:00Z" }),
    ]);
    expect(groups.map((g) => g.cls)).toEqual(["prime_ledger_hole", "ci_red"]);
  });

  it("nothing open is no lines at all", () => {
    expect(groupCardBlockages([])).toEqual([]);
  });
});
