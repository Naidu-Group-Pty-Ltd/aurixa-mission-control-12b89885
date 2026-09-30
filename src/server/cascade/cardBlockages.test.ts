import { describe, expect, it } from "vitest";
import {
  KNOWN_BLOCKAGE_CLASSES,
  cardBlockagesFrom,
  type CardBlockages,
  type OpenBlockageLine,
} from "./cardBlockages.pure";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";

const line = (over: Partial<OpenBlockageLine> = {}): OpenBlockageLine => ({
  class: "prime_ledger_hole",
  detail: null,
  owner: "operator",
  self_heals: false,
  open_count: 1,
  oldest_first_seen_at: "2026-09-22T09:37:00.000Z",
  total_open: 1,
  total_lines: 1,
  ...over,
});

/** Stamp one answer's totals on every line, the way one statement computes them. */
const answer = (lines: OpenBlockageLine[], totals?: { open?: number; lines?: number }) => {
  const open = totals?.open ?? lines.reduce((n, l) => n + l.open_count, 0);
  const count = totals?.lines ?? lines.length;
  return lines.map((l) => ({ ...l, total_open: open, total_lines: count }));
};

const drawn = (lines: OpenBlockageLine[]): CardBlockages => {
  const read = cardBlockagesFrom(lines);
  if (!read.ok) throw new Error(`refused: ${read.reason}`);
  return read.blockages;
};

const refusal = (lines: OpenBlockageLine[]): string => {
  const read = cardBlockagesFrom(lines);
  if (read.ok) throw new Error("drawn, but should have been refused");
  return read.reason;
};

/*
  The CRM independent on 27 Sep 2026: 52 open hole rows, one per version,
  first seen from 22 Sep onward. The card drew six identical sentences and said
  nothing of the other forty-six, and a class opening later could not appear.
  The database now answers that as one line.
*/
const independent = () =>
  line({ open_count: 52, oldest_first_seen_at: "2026-09-22T09:37:00.000Z" });

const ciRed = (over: Partial<OpenBlockageLine> = {}) =>
  line({
    class: "ci_red",
    owner: "prime_author",
    oldest_first_seen_at: "2026-09-26T15:59:57.486Z",
    ...over,
  });

describe("the sync card lists every class that is open, once", () => {
  it("draws 52 rows of one class as one line that says 52", () => {
    const card = drawn(answer([independent()]));
    expect(card.groups).toHaveLength(1);
    expect(card.groups[0].count).toBe(52);
    expect(card.groups[0].what).toBe(BLOCKAGE_POLICY.prime_ledger_hole.what);
    // The line is dated by its OLDEST row.
    expect(card.groups[0].firstSeenAt).toBe("2026-09-22T09:37:00.000Z");
    expect([card.total, card.counted]).toEqual([52, 52]);
  });

  it("shows a class that opened after every older row", () => {
    // Before, a red cascade PR opened here would have been row 53 of a list cut at six.
    const card = drawn(answer([independent(), ciRed()]));
    expect(card.groups.map((g) => [g.cls, g.count])).toEqual([
      ["prime_ledger_hole", 52],
      ["ci_red", 1],
    ]);
    expect(card.groups[1].owner).toBe("prime_author");
  });

  it("orders the lines by each class's oldest row, whatever order they arrived in", () => {
    // The database leads with the classes this build knows, not with the oldest.
    const card = drawn(
      answer([
        ciRed({ oldest_first_seen_at: "2026-09-26T00:00:00Z" }),
        line({ open_count: 2, oldest_first_seen_at: "2026-09-21T00:00:00Z" }),
      ]),
    );
    expect(card.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", 2, "2026-09-21T00:00:00Z"],
      ["ci_red", 1, "2026-09-26T00:00:00Z"],
    ]);
  });

  it("takes a known class's owner and sentence from the taxonomy, together", () => {
    // A row written under an older policy must not pair today's sentence with yesterday's owner.
    const [g] = drawn(answer([line({ owner: "machinery", self_heals: true })])).groups;
    expect(g.owner).toBe(BLOCKAGE_POLICY.prime_ledger_hole.owner);
    expect(g.selfHeals).toBe(BLOCKAGE_POLICY.prime_ledger_hole.selfHeals);
    expect(g.what).toBe(BLOCKAGE_POLICY.prime_ledger_hole.what);
  });

  it("never draws one unknown line's words over another's", () => {
    const card = drawn(
      answer([
        line({ class: "retired_class", owner: "machinery", detail: "first reason", open_count: 2 }),
        line({ class: "retired_class", owner: "machinery", detail: "second reason" }),
      ]),
    );
    expect(card.groups.map((g) => [g.what, g.count, g.owner])).toEqual([
      ["first reason", 2, "machinery"],
      ["second reason", 1, "machinery"],
    ]);
    expect(new Set(card.groups.map((g) => g.key)).size).toBe(card.groups.length);
  });

  it("draws a class the database split as one line, since its sentence is one", () => {
    // Only possible if the database was not told the class; drawing it twice
    // is the defect this card had.
    const card = drawn(
      answer([
        line({ detail: "version 1", open_count: 3, oldest_first_seen_at: "2026-09-23T00:00:00Z" }),
        line({ detail: "version 2", open_count: 4, oldest_first_seen_at: "2026-09-21T00:00:00Z" }),
      ]),
    );
    expect(card.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", 7, "2026-09-21T00:00:00Z"],
    ]);
  });

  it("an unreadable start sorts last rather than first", () => {
    const card = drawn(
      answer([
        ciRed({ oldest_first_seen_at: "not a date" }),
        line({ oldest_first_seen_at: "2026-09-23T00:00:00Z" }),
      ]),
    );
    expect(card.groups.map((g) => g.cls)).toEqual(["prime_ledger_hole", "ci_red"]);
  });

  it("nothing open is no lines at all", () => {
    expect(drawn([])).toEqual({ groups: [], total: 0, counted: 0 });
  });
});

/*
  PostgREST caps an answer and says nothing when it does. The database leads
  with the classes this build knows and counts its totals before the cap, so a
  cut answer can only lose lines of a class this build does not know — and its
  totals say exactly how many rows those were.

  The answer below is the one `clone_open_blockage_groups` gave on Postgres 16
  against the real `clone_sync_blockages` migrations (27 Sep 2026): 52 holes, a
  red PR, and three rows of a class the caller did not name, over two details,
  cut at two lines.
*/
describe("an answer PostgREST cut short", () => {
  const cut = () =>
    [
      line({ open_count: 52, oldest_first_seen_at: "2026-09-22T11:47:26.000Z" }),
      ciRed({ oldest_first_seen_at: "2026-09-27T10:46:26.000Z" }),
    ].map((l) => ({ ...l, total_open: 56, total_lines: 4 }));

  it("draws the lines that arrived and says how many rows they leave out", () => {
    const card = drawn(cut());
    expect(card.groups.map((g) => [g.cls, g.count])).toEqual([
      ["prime_ledger_hole", 52],
      ["ci_red", 1],
    ]);
    // The panel draws `total - counted` as rows not read for this card.
    expect([card.total, card.counted]).toEqual([56, 53]);
  });

  it("is whole when every line arrived, and then every row is counted", () => {
    const whole = [
      ...cut(),
      line({ class: "retired_class", detail: "another unknown condition", open_count: 2 }),
      line({ class: "retired_class", detail: "stalled for no known reason" }),
    ].map((l) => ({ ...l, total_open: 56, total_lines: 4 }));
    const card = drawn(whole);
    expect(card.groups).toHaveLength(4);
    expect([card.total, card.counted]).toEqual([56, 56]);
  });
});

/*
  One statement computes the totals once, so an answer that disagrees with
  itself is not one this module understands. Drawing it would put a number on
  the card that nobody measured, so it is refused, and the card says it could
  not be read.
*/
describe("an answer that contradicts itself is refused, not drawn", () => {
  it("when its lines disagree about the totals", () => {
    const lines = answer([independent(), ciRed()]);
    lines[1] = { ...lines[1], total_open: 999 };
    expect(refusal(lines)).toMatch(/disagree/);
  });

  it("when every line arrived and they do not add up to the total", () => {
    expect(refusal(answer([independent(), ciRed()], { open: 60 }))).toMatch(/add up/);
  });

  it("when its lines claim more than its totals", () => {
    expect(refusal(answer([independent(), ciRed()], { lines: 1 }))).toMatch(/more than/);
    expect(refusal(answer([independent(), ciRed()], { open: 10, lines: 3 }))).toMatch(/more than/);
  });

  it("when a line stands for no rows, or for a number that is not a count", () => {
    for (const open_count of [0, -1, 1.5, Number.NaN]) {
      expect(refusal(answer([line({ open_count })], { open: 1, lines: 1 }))).toMatch(/no rows/);
    }
  });

  it("when its totals are not counts", () => {
    expect(refusal(answer([independent()], { open: -1 }))).toMatch(/not counts/);
  });

  it("when a class this build does not know came back without its words", () => {
    // Its detail is its only sentence, and the card never draws a class name.
    expect(refusal(answer([line({ class: "retired_class", detail: null })]))).toMatch(/words/);
  });
});

describe("what the database is told", () => {
  it("names every class the taxonomy knows, and nothing else", () => {
    expect([...KNOWN_BLOCKAGE_CLASSES].sort()).toEqual(Object.keys(BLOCKAGE_POLICY).sort());
  });
});
