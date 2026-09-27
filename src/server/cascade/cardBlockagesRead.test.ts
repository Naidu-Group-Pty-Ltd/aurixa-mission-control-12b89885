import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";
import type { OpenBlockageLine } from "./cardBlockages.pure";
import { readCardBlockages } from "./cardBlockagesRead.server";

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

type RpcCall = { fn: string; args: Record<string, unknown>; options: unknown };

/**
 * A stand-in for `clone_open_blockage_groups` behind PostgREST. It folds the
 * open rows the way the function does (`20260927100000_clone_open_blockage_groups.sql`,
 * whose behaviour was checked on Postgres 16): a known class is one line, an
 * unknown one a line per detail, each line with the oldest row's owner, known
 * classes first, and the totals counted over every line. Then it cuts the
 * answer at `cap` without saying so, as PostgREST's `max_rows` does.
 *
 * It has no `from`: a reader that queried the table itself would throw here.
 */
function fakeDatabase(
  rows: Row[],
  opts: {
    cap?: number;
    fail?: string;
    answer?: unknown;
    rewrite?: (l: OpenBlockageLine[]) => OpenBlockageLine[];
  } = {},
) {
  const calls: RpcCall[] = [];
  const client = {
    from() {
      throw new Error("the card read must not query the table itself");
    },
    rpc(fn: string, args: Record<string, unknown>, options: unknown) {
      calls.push({ fn, args, options });
      if (opts.fail) return Promise.resolve({ data: null, error: { message: opts.fail } });
      if ("answer" in opts) return Promise.resolve({ data: opts.answer, error: null });

      const known = new Set(args._known_classes as string[]);
      const lines = new Map<string, { known: boolean; rows: Row[] }>();
      for (const r of rows) {
        if (r.clone_id !== args._clone_id || r.cleared_at !== null) continue;
        const isKnown = known.has(r.class);
        const key = isKnown ? r.class : `${r.class}\u0000${r.detail}`;
        const line = lines.get(key) ?? { known: isKnown, rows: [] };
        line.rows.push(r);
        lines.set(key, line);
      }
      const byOldest = (a: Row, b: Row) =>
        a.first_seen_at.localeCompare(b.first_seen_at) || a.id.localeCompare(b.id);
      const folded = [...lines.values()].map(({ known: k, rows: rs }) => {
        const oldest = [...rs].sort(byOldest)[0];
        return { k, oldest, count: rs.length };
      });
      folded.sort(
        (a, b) =>
          Number(b.k) - Number(a.k) ||
          a.oldest.first_seen_at.localeCompare(b.oldest.first_seen_at) ||
          a.oldest.class.localeCompare(b.oldest.class),
      );
      const totalOpen = folded.reduce((n, f) => n + f.count, 0);
      let answer: OpenBlockageLine[] = folded.map((f) => ({
        class: f.oldest.class,
        detail: f.k ? null : f.oldest.detail,
        owner: f.oldest.owner,
        self_heals: f.oldest.self_heals,
        open_count: f.count,
        oldest_first_seen_at: f.oldest.first_seen_at,
        total_open: totalOpen,
        total_lines: folded.length,
      }));
      if (opts.cap !== undefined) answer = answer.slice(0, opts.cap);
      if (opts.rewrite) answer = opts.rewrite(answer);
      return Promise.resolve({ data: answer, error: null });
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const read = async (db: ReturnType<typeof fakeDatabase>) => readCardBlockages(db.client, CLONE);

describe("the card asks the database once", () => {
  it("as a GET, naming the clone and every class this build knows", async () => {
    const db = fakeDatabase([]);
    await read(db);
    expect(db.calls).toEqual([
      {
        fn: "clone_open_blockage_groups",
        args: { _clone_id: CLONE, _known_classes: Object.keys(BLOCKAGE_POLICY) },
        // PostgREST runs a GET in a read-only transaction.
        options: { get: true },
      },
    ]);
  });
});

describe("every open class is drawn, with its count", () => {
  it("the CRM independent's 52 holes and a red PR opened after them are two lines", async () => {
    const rows = [
      ...many(52, (n) => blockage("hole-", n)),
      blockage("ci-", 0, { class: "ci_red", owner: "prime_author", first_seen_at: at(10_000) }),
    ];
    const { data, error } = await read(fakeDatabase(rows));
    expect(error).toBeNull();
    expect(data?.groups.map((g) => [g.cls, g.count, g.firstSeenAt])).toEqual([
      ["prime_ledger_hole", 52, at(0)],
      ["ci_red", 1, at(10_000)],
    ]);
    expect([data?.total, data?.counted]).toEqual([53, 53]);
  });

  it("a class whose every row is newer than 2,600 others is still drawn, whatever the cap", async () => {
    // Past the six, the 500 and the 2,000 rows every earlier reading stopped at.
    const rows = [
      ...many(2_600, (n) => blockage("hole-", n)),
      ...many(3, (n) =>
        blockage("ci-", n, {
          class: "ci_red",
          owner: "prime_author",
          first_seen_at: at(90_000 + n),
        }),
      ),
    ];
    const { data } = await read(fakeDatabase(rows, { cap: 1_000 }));
    expect(data?.groups.map((g) => [g.cls, g.count])).toEqual([
      ["prime_ledger_hole", 2_600],
      ["ci_red", 3],
    ]);
    expect([data?.total, data?.counted]).toEqual([2_603, 2_603]);
  });

  it("a cap cuts only lines of a class this build does not know, and the card says how many rows", async () => {
    const rows = [
      ...many(1_500, (n) =>
        blockage("old-", n, {
          class: "retired_class",
          detail: `reason ${n}`,
          first_seen_at: at(-5_000 + n),
        }),
      ),
      ...many(52, (n) => blockage("hole-", n)),
      blockage("ci-", 0, { class: "ci_red", owner: "prime_author", first_seen_at: at(10_000) }),
    ];
    const { data } = await read(fakeDatabase(rows, { cap: 1_000 }));
    // Both known classes arrive, however many older unknown lines there are.
    expect(
      data?.groups.filter((g) => g.cls in BLOCKAGE_POLICY).map((g) => [g.cls, g.count]),
    ).toEqual([
      ["prime_ledger_hole", 52],
      ["ci_red", 1],
    ]);
    // 998 unknown lines arrived; the other 502 rows are what the panel says it left out.
    expect([data?.total, data?.counted]).toEqual([1_553, 1_051]);
  });

  it("never counts a cleared row, or another clone's", async () => {
    const rows = [
      blockage("hole-", 1),
      blockage("hole-", 2, { cleared_at: at(5) }),
      blockage("ci-", 1, { class: "ci_red", owner: "prime_author", clone_id: "clone-2" }),
    ];
    const { data } = await read(fakeDatabase(rows));
    expect(data?.groups.map((g) => [g.cls, g.count])).toEqual([["prime_ledger_hole", 1]]);
    expect([data?.total, data?.counted]).toEqual([1, 1]);
  });

  it("nothing open is no lines", async () => {
    expect(await read(fakeDatabase([]))).toEqual({
      data: { groups: [], total: 0, counted: 0 },
      error: null,
    });
  });
});

/*
  A failed read is `null` on the card and drawn as "could not be read": "nothing
  is blocking this clone" is a claim, and a read that did not happen cannot
  make it.
*/
describe("a read that did not happen is never drawn as none", () => {
  it("a failed request fails the read", async () => {
    const res = await read(
      fakeDatabase([blockage("hole-", 1)], { fail: "PGRST202: function not found" }),
    );
    expect(res).toEqual({ data: null, error: { message: "PGRST202: function not found" } });
  });

  it("an answer that is not a list fails the read", async () => {
    const res = await read(fakeDatabase([], { answer: null }));
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/no answer/);
  });

  it("an answer that contradicts itself fails the read", async () => {
    const rows = [...many(3, (n) => blockage("hole-", n)), blockage("ci-", 0, { class: "ci_red" })];
    const res = await read(
      fakeDatabase(rows, {
        rewrite: (lines) =>
          lines.map((l, i) => (i === 0 ? { ...l, total_open: l.total_open + 7 } : l)),
      }),
    );
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/disagree/);
  });
});
