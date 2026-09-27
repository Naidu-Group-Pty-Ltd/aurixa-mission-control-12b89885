import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";
import { CARD_BLOCKAGE_READ_LIMIT, readCardBlockages } from "./cardBlockagesRead.server";

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
 * A PostgREST stand-in. Each request is one statement: it applies the filters
 * it is handed, orders by the columns named, truncates at `cap` without saying
 * so, and — when asked — counts the matching rows before the limit, from the
 * same rows it returns, as the real one does.
 */
function fakeServer(
  rows: Row[],
  opts: {
    cap?: number;
    failOn?: number;
    /** Answer this request's count request with no count. */
    withholdCountOn?: number;
    /** Answer this request with a count but none of the rows it counted. */
    dropRowsOn?: number;
  } = {},
) {
  let calls = 0;
  const client = {
    from(table: string) {
      expect(table).toBe("clone_sync_blockages");
      const filters: Array<(r: Row) => boolean> = [];
      const sorts: Array<keyof Row> = [];
      let limit = Number.POSITIVE_INFINITY;
      let counting = false;
      const builder = {
        select: (_cols: string, o?: { count?: string }) => {
          counting = o?.count === "exact";
          return builder;
        },
        eq: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        is: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        order: (col: keyof Row) => (sorts.push(col), builder),
        limit: (n: number) => ((limit = n), builder),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          calls += 1;
          const call = calls;
          if (opts.failOn === call) {
            return Promise.resolve({ data: null, error: { message: "boom" }, count: null }).then(
              resolve,
              reject,
            );
          }
          const matching = rows
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => {
              for (const col of sorts) {
                if (a[col]! < b[col]!) return -1;
                if (a[col]! > b[col]!) return 1;
              }
              return 0;
            });
          const data =
            opts.dropRowsOn === call
              ? []
              : matching.slice(0, Math.min(limit, opts.cap ?? Number.POSITIVE_INFINITY));
          const count = counting && opts.withholdCountOn !== call ? matching.length : null;
          return Promise.resolve({ data, error: null, count }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls: () => calls };
}

describe("readCardBlockages: one statement carries every open row", () => {
  it("reads the clone's open rows once, and draws them as one line per class", async () => {
    const rows = [
      ...many(52, (n) => blockage("a", n)),
      blockage("z", 1, { class: "ci_red", owner: "prime_author", first_seen_at: at(9_000) }),
      blockage("b", 1, { cleared_at: at(9_000) }),
      blockage("c", 1, { clone_id: "clone-2" }),
    ];
    const { client, calls } = fakeServer(rows);
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(error).toBeNull();
    expect(data!.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", 52, at(0)],
      ["ci_red", 1, at(9_000)],
    ]);
    expect(data!.total).toBe(53);
    expect(data!.counted).toBe(53);
    // One statement: the rows, and the count that says they are all of them.
    expect(calls()).toBe(1);
  });

  it("nothing open is one request and no lines", async () => {
    const { client, calls } = fakeServer([blockage("a", 1, { cleared_at: at(9_000) })]);
    const { data } = await readCardBlockages(client, CLONE);
    expect(data).toEqual({ groups: [], total: 0, counted: 0 });
    expect(calls()).toBe(1);
  });

  it("a read the server cut short is never taken for the whole", async () => {
    // A cap below the limit returns fewer rows than were asked for; the count
    // that came with them says there are more, so the read goes on to count.
    const rows = [
      ...many(300, (n) => blockage("a", n)),
      blockage("z", 1, { class: "ci_red", owner: "prime_author", first_seen_at: at(9_000) }),
    ];
    const { client } = fakeServer(rows, { cap: 100 });
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.groups.map((g) => [g.cls, g.count])).toEqual([
      ["prime_ledger_hole", 300],
      ["ci_red", 1],
    ]);
    expect(data!.total - data!.counted).toBe(0);
  });
});

/*
  More open rows than one statement carries: every class the taxonomy knows
  is counted by the database, each count one statement with its oldest row.
*/
describe("readCardBlockages: past one statement, every known class is counted", () => {
  it("draws every known class with its exact count, including one the first read never reached", async () => {
    // What Codex found in the first commit's bound: oldest first and cut at
    // 500, a class whose every row came later was not drawn at all.
    const rows = [
      ...many(CARD_BLOCKAGE_READ_LIMIT + 600, (n) => blockage("a", n)),
      ...many(30, (n) =>
        blockage("z", n, {
          class: "ci_red",
          owner: "prime_author",
          first_seen_at: at(50_000 - n),
        }),
      ),
    ];
    const { client, calls } = fakeServer(rows);
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(error).toBeNull();
    expect(data!.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", CARD_BLOCKAGE_READ_LIMIT + 600, at(0)],
      ["ci_red", 30, at(50_000 - 29)],
    ]);
    expect(data!.total).toBe(CARD_BLOCKAGE_READ_LIMIT + 630);
    expect(data!.counted).toBe(data!.total);
    // The first read, then one count of everything and one per class.
    expect(calls()).toBe(1 + 1 + CLASS_COUNT);
  });

  it("a class this build does not know is drawn from what the first read carried, and the rest is said", async () => {
    const retired = (prefix: string, n: number, minutes: number) =>
      blockage(prefix, n, {
        class: "retired_class",
        owner: "machinery",
        detail: "why",
        first_seen_at: at(minutes),
      });
    const rows = [
      // Oldest, so the first read carries them.
      ...many(3, (n) => retired("a", n, n - 100)),
      ...many(CARD_BLOCKAGE_READ_LIMIT, (n) => blockage("b", n)),
      // Newest, past what the first read carried.
      ...many(5, (n) => retired("z", n, 90_000 + n)),
    ];
    const { client } = fakeServer(rows);
    const { data } = await readCardBlockages(client, CLONE);
    expect(data!.groups.map((g) => [g.what, g.count])).toEqual([
      ["why", 3],
      [BLOCKAGE_POLICY.prime_ledger_hole.what, CARD_BLOCKAGE_READ_LIMIT],
    ]);
    expect(data!.total).toBe(CARD_BLOCKAGE_READ_LIMIT + 8);
    // What no count by class can reach, and what the card says it left out.
    expect(data!.total - data!.counted).toBe(5);
  });
});

describe("readCardBlockages: a read that cannot be trusted is not a shorter list", () => {
  const large = () => many(CARD_BLOCKAGE_READ_LIMIT + 1, (n) => blockage("a", n));

  it("a failed first read fails the read", async () => {
    const { client } = fakeServer(large(), { failOn: 1 });
    expect(await readCardBlockages(client, CLONE)).toEqual({
      data: null,
      error: { message: "boom" },
    });
  });

  it("a first read with no count fails the read, rather than being taken as complete", async () => {
    const { client } = fakeServer(
      many(3, (n) => blockage("a", n)),
      { withholdCountOn: 1 },
    );
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(data).toBeNull();
    expect(error!.message).toBe("the database did not count this clone's open blockages");
  });

  it("a failed class count fails the read", async () => {
    const { client } = fakeServer(large(), { failOn: 3 });
    expect(await readCardBlockages(client, CLONE)).toEqual({
      data: null,
      error: { message: "boom" },
    });
  });

  it("a total the database did not count fails the read, and never reads as zero", async () => {
    const { client } = fakeServer(large(), { withholdCountOn: 2 });
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(data).toBeNull();
    expect(error!.message).toBe("the database did not count this clone's open blockages");
  });

  it("a class counted with no oldest row fails the read", async () => {
    // Request 3 is the first class in the taxonomy: give it a row, then answer
    // with the count and none of the rows.
    const first = Object.keys(BLOCKAGE_POLICY)[0];
    const rows = [...large(), blockage("z", 1, { class: first, owner: "machinery" })];
    const { client } = fakeServer(rows, { dropRowsOn: 3 });
    const { data, error } = await readCardBlockages(client, CLONE);
    expect(data).toBeNull();
    expect(error!.message).toBe(
      `the database counted 1 open ${first} rows and returned none of them`,
    );
  });
});
