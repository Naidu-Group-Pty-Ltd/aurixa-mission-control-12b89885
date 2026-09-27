import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";
import {
  CARD_BLOCKAGE_PAGE,
  CARD_BLOCKAGE_ROW_CEILING,
  readCardBlockages,
} from "./cardBlockagesRead.server";

type Row = {
  id: string;
  clone_id: string;
  class: string;
  owner: string;
  detail: string;
  first_seen_at: string;
  self_heals: boolean;
  cleared_at: string | null;
};

const CLONE = "clone-1";
const CLASS_COUNT = Object.keys(BLOCKAGE_POLICY).length;

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 20) + minutes * 60_000).toISOString();

/** A row whose id sorts by `prefix` and then by `n`, the order the walk reads in. */
const blockage = (prefix: string, n: number, over: Partial<Row> = {}): Row => ({
  id: `${prefix}${String(n).padStart(6, "0")}`,
  clone_id: CLONE,
  class: "prime_ledger_hole",
  owner: "operator",
  detail: `version ${n}`,
  first_seen_at: at(n),
  self_heals: false,
  cleared_at: null,
  ...over,
});

const many = (length: number, make: (n: number) => Row) =>
  Array.from({ length }, (_, n) => make(n));

/**
 * A PostgREST stand-in: applies the filters it is handed, orders by the column
 * named, truncates at `cap` without saying so, and counts the matching rows
 * when asked to — before the limit, as the real one does.
 */
function fakeServer(
  rows: Row[],
  opts: {
    cap?: number;
    beforeCall?: (call: number) => void;
    failOn?: number;
    /** A server that drops the keyset filter, and so answers every page with the first. */
    ignoreKeyset?: boolean;
    /** Answer a count request with no count. */
    withholdCountOn?: number;
  } = {},
) {
  let calls = 0;
  const client = {
    from(table: string) {
      expect(table).toBe("clone_sync_blockages");
      const filters: Array<(r: Row) => boolean> = [];
      let limit = Number.POSITIVE_INFINITY;
      let sortBy: keyof Row = "id";
      let counting = false;
      const builder = {
        select: (_cols: string, o?: { count?: string }) => {
          counting = o?.count === "exact";
          return builder;
        },
        eq: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        is: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        gt: (col: keyof Row, val: string) => {
          if (!opts.ignoreKeyset) filters.push((r) => String(r[col]) > val);
          return builder;
        },
        order: (col: keyof Row) => ((sortBy = col), builder),
        limit: (n: number) => ((limit = n), builder),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          calls += 1;
          opts.beforeCall?.(calls);
          if (opts.failOn === calls) {
            return Promise.resolve({ data: null, error: { message: "boom" }, count: null }).then(
              resolve,
              reject,
            );
          }
          const matching = rows
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => (a[sortBy]! < b[sortBy]! ? -1 : a[sortBy]! > b[sortBy]! ? 1 : 0));
          const data = matching.slice(0, Math.min(limit, opts.cap ?? Number.POSITIVE_INFINITY));
          const count = counting && opts.withholdCountOn !== calls ? matching.length : null;
          return Promise.resolve({ data, error: null, count }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls: () => calls };
}

describe("readCardBlockages: every open row is read", () => {
  it("reads every open row of this clone when the server caps a response below the page", async () => {
    const rows = [
      ...many(1_234, (n) => blockage("a", n)),
      blockage("b", 1, { cleared_at: at(9_000) }),
      blockage("c", 1, { clone_id: "clone-2" }),
    ];
    const { client } = fakeServer(rows, { cap: 100 });
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(error).toBeNull();
    expect(data!.groups.map((g) => [g.cls, g.count])).toEqual([["prime_ledger_hole", 1_234]]);
    expect(data!.total).toBe(1_234);
    expect(data!.counted).toBe(1_234);
  });

  /*
    What Codex found in the bound this replaces: oldest first and cut at 500,
    a class whose first row fell past the cut was not drawn at all.
  */
  it("draws a class whose every row lies past the 500 rows the card used to read", async () => {
    const rows = [
      ...many(600, (n) => blockage("a", n)),
      blockage("z", 1, { class: "ci_red", owner: "prime_author", first_seen_at: at(9_000) }),
    ];
    const { client } = fakeServer(rows);
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.groups.map((g) => [g.cls, g.count])).toEqual([
      ["prime_ledger_hole", 600],
      ["ci_red", 1],
    ]);
    expect(data!.total - data!.counted).toBe(0);
  });

  /*
    What an offset would get wrong: once a row from the first page is cleared,
    every later row moves up one place, and the row that stood first on the
    second page is skipped. A key does not move.
  */
  it("a row cleared between pages never pushes another past the boundary", async () => {
    const rows = many(CARD_BLOCKAGE_PAGE + 50, (n) =>
      blockage("a", n, { class: n === CARD_BLOCKAGE_PAGE ? "ci_red" : "prime_ledger_hole" }),
    );
    const { client } = fakeServer(rows, {
      beforeCall: (call) => {
        if (call === 2) rows[5].cleared_at = at(9_000);
      },
    });
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.groups.map((g) => [g.cls, g.count])).toEqual([
      // Read on the first page while it was still open.
      ["prime_ledger_hole", CARD_BLOCKAGE_PAGE + 49],
      ["ci_red", 1],
    ]);
  });

  it("nothing open is one request and no lines", async () => {
    const { client, calls } = fakeServer([blockage("a", 1, { cleared_at: at(9_000) })]);
    const { data } = await readCardBlockages(client, CLONE);
    expect(data).toEqual({ groups: [], total: 0, counted: 0 });
    expect(calls()).toBe(1);
  });

  it("a walk ends on an empty page, never on a short one", async () => {
    const { client, calls } = fakeServer(
      many(52, (n) => blockage("a", n)),
      { cap: 10 },
    );
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.counted).toBe(52);
    expect(calls()).toBe(7);
  });
});

describe("readCardBlockages: a read that cannot be trusted is not a shorter list", () => {
  it("an unreadable page fails the read", async () => {
    const { client } = fakeServer(
      many(CARD_BLOCKAGE_PAGE + 20, (n) => blockage("a", n)),
      { failOn: 2 },
    );
    expect(await readCardBlockages(client, CLONE)).toEqual({
      data: null,
      error: { message: "boom" },
    });
  });

  it("a page that repeats a row fails the read rather than looping", async () => {
    const { client, calls } = fakeServer(
      many(CARD_BLOCKAGE_PAGE + 20, (n) => blockage("a", n)),
      { ignoreKeyset: true },
    );
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(data).toBeNull();
    expect(error!.message).toContain("blockage a000000 came back twice");
    expect(calls()).toBe(2);
  });
});

/*
  Past the ceiling the walk stops and the database counts each known class,
  so every class the taxonomy knows is drawn with its true count however many
  rows it has.
*/
describe("readCardBlockages: past the ceiling, every known class is counted", () => {
  const walkPages = CARD_BLOCKAGE_ROW_CEILING / CARD_BLOCKAGE_PAGE;

  it("draws every known class with its exact count and its oldest row", async () => {
    const rows = [
      ...many(CARD_BLOCKAGE_ROW_CEILING + 600, (n) => blockage("a", n)),
      // Keyed after every hole, so the walk never reaches them.
      ...many(30, (n) =>
        blockage("z", n, {
          class: "ci_red",
          owner: "prime_author",
          first_seen_at: at(5_000 - n),
        }),
      ),
    ];
    const { client, calls } = fakeServer(rows);
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(error).toBeNull();
    expect(data!.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", CARD_BLOCKAGE_ROW_CEILING + 600, at(0)],
      ["ci_red", 30, at(5_000 - 29)],
    ]);
    expect(data!.total).toBe(CARD_BLOCKAGE_ROW_CEILING + 630);
    expect(data!.counted).toBe(data!.total);
    // The walk to the ceiling, then one count of everything and one per class.
    expect(calls()).toBe(walkPages + 1 + CLASS_COUNT);
  });

  it("a class this build does not know is drawn from what was walked, and the rest is said", async () => {
    const retired = (prefix: string, n: number) =>
      blockage(prefix, n, {
        class: "retired_class",
        owner: "machinery",
        detail: "why",
        first_seen_at: at(n - 100),
      });
    const rows = [
      ...many(3, (n) => retired("a", n)),
      ...many(CARD_BLOCKAGE_ROW_CEILING, (n) => blockage("b", n)),
      ...many(5, (n) => retired("z", n)),
    ];
    const { client } = fakeServer(rows);
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.groups.map((g) => [g.what, g.count])).toEqual([
      ["why", 3],
      [BLOCKAGE_POLICY.prime_ledger_hole.what, CARD_BLOCKAGE_ROW_CEILING],
    ]);
    expect(data!.total).toBe(CARD_BLOCKAGE_ROW_CEILING + 8);
    // What no count by class can reach, and what the card says it left out.
    expect(data!.total - data!.counted).toBe(5);
  });

  it("a failed count fails the read", async () => {
    const { client } = fakeServer(
      many(CARD_BLOCKAGE_ROW_CEILING + 1, (n) => blockage("a", n)),
      { failOn: walkPages + 3 },
    );
    expect(await readCardBlockages(client, CLONE)).toEqual({
      data: null,
      error: { message: "boom" },
    });
  });

  it("a count the database did not give fails the read, never reads as zero", async () => {
    const { client } = fakeServer(
      many(CARD_BLOCKAGE_ROW_CEILING + 1, (n) => blockage("a", n)),
      { withholdCountOn: walkPages + 1 },
    );
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(data).toBeNull();
    expect(error!.message).toBe("the database did not count this clone's open blockages");
  });
});
