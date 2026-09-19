/**
 * The second look at an orphan, and the ordering rule that makes it safe.
 *
 * `partitionByDependency` answers with corpus POSITION, which is all it has —
 * it is handed metadata, not SQL. `rescueScopedOrphans` is the second look,
 * taken where the SQL loader is, and everything it can get wrong it gets wrong
 * by keeping the prefix barrier.
 */
import { describe, it, expect, vi } from "vitest";
import { rescueScopedOrphans } from "./backend-provisioning.server";

const HOLE = "20261202090000";

/** Abridged from the real files on the prime, 19 Sep 2026. */
const SQL: Record<string, string> = {
  [HOLE]: `
    ALTER TABLE public.builder_network_stock_items ADD COLUMN IF NOT EXISTS rank_item_score numeric;
    CREATE OR REPLACE VIEW public.builder_network_stock_ranked AS SELECT 1;
    CREATE OR REPLACE FUNCTION public.builder_network_apply_stock_ranks(n integer)
      RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;
  `,
  "20261203010000": `
    UPDATE public.report_templates rt SET page_plan = tle.page_plan
      FROM public.template_library_entries tle WHERE tle.entry_id = rt.entry_id;
  `,
  "20261299000000": `SELECT public.builder_network_apply_stock_ranks(10);`,
};

/** The 41 MB template-library seeds. Past MAX_SCOPING_BYTES by construction. */
const OVERSIZE = new Set(["20261203000000", "20261204020000"]);

function loader() {
  return vi.fn(async (m: { id: string; name: string }) => {
    if (OVERSIZE.has(m.id)) throw new Error(`Migration ${m.name} is too large to hold`);
    const sql = SQL[m.id];
    if (sql === undefined) throw new Error(`no body for ${m.id}`);
    return sql;
  });
}

const meta = (id: string) => ({ id, name: `${id}_x.sql` });
const orphan = (id: string, blockedBy: string[] = [HOLE]) => ({ meta: meta(id), blockedBy });
const corpus = [HOLE, "20261203000000", "20261203010000", "20261204020000", "20261299000000"].map(
  meta,
);

describe("rescueScopedOrphans", () => {
  it("sends an orphan the hole does not reach", async () => {
    const r = await rescueScopedOrphans([orphan("20261203010000")], corpus, [], loader());
    expect(r.send.map((m) => m.id)).toEqual(["20261203010000"]);
    expect(r.stillBlocked).toEqual([]);
  });

  it("holds an orphan that names something the hole creates", async () => {
    const r = await rescueScopedOrphans([orphan("20261299000000")], corpus, [], loader());
    expect(r.send).toEqual([]);
    expect(r.stillBlocked.map((o) => o.blockedBy)).toEqual([[HOLE]]);
  });

  it("holds an orphan whose own body is past the reading ceiling", async () => {
    const r = await rescueScopedOrphans([orphan("20261203000000")], corpus, [], loader());
    expect(r.send).toEqual([]);
    expect(r.stillBlocked.map((o) => o.meta.id)).toEqual(["20261203000000"]);
  });

  it("an orphan that stays blocked is a hole for the ones after it", async () => {
    /*
      THE ORDERING RULE, on the real held set.

      In corpus order: the 41 MB v14 SEED, then its 2,616-byte active-master
      REFRESH. Judged against the builder-marketplace hole alone the refresh
      sends — correctly, they share no object — and the clone would then
      refresh its active masters out of a library that never received v14.
    */
    const r = await rescueScopedOrphans(
      [orphan("20261203000000"), orphan("20261203010000")],
      corpus,
      [],
      loader(),
    );
    expect(r.send).toEqual([]);
    expect(r.stillBlocked.map((o) => o.meta.id)).toEqual(["20261203000000", "20261203010000"]);
    // And it is told WHICH unsent migration holds it, not just the prime's hole.
    expect(r.stillBlocked[1].blockedBy).toEqual(["20261203000000"]);
  });

  it("does not hold a later orphan behind an EARLIER one that was sent", async () => {
    const r = await rescueScopedOrphans(
      [orphan("20261203010000"), orphan("20261299000000")],
      corpus,
      [],
      loader(),
    );
    expect(r.send.map((m) => m.id)).toEqual(["20261203010000"]);
    expect(r.stillBlocked.map((o) => o.meta.id)).toEqual(["20261299000000"]);
  });

  it("reads each body once however many orphans name it", async () => {
    const load = loader();
    await rescueScopedOrphans(
      [orphan("20261203010000"), orphan("20261299000000")],
      corpus,
      [],
      load,
    );
    const holeReads = load.mock.calls.filter(([m]) => m.id === HOLE);
    expect(holeReads).toHaveLength(1);
  });

  it("prefers SQL already on the item, so a materialised body is not re-fetched", async () => {
    const load = loader();
    const r = await rescueScopedOrphans(
      [orphan("20261203010000")],
      corpus,
      [{ id: "20261203010000", name: "x.sql", sql: SQL["20261203010000"] }],
      load,
    );
    expect(r.send.map((m) => m.id)).toEqual(["20261203010000"]);
    expect(load.mock.calls.filter(([m]) => m.id === "20261203010000")).toHaveLength(0);
  });

  it("keeps the prefix barrier entirely when there is no loader at all", async () => {
    const r = await rescueScopedOrphans([orphan("20261203010000")], corpus, []);
    expect(r.send).toEqual([]);
    expect(r.stillBlocked.map((o) => o.meta.id)).toEqual(["20261203010000"]);
  });

  it("is empty rather than throwing on an empty orphan list", async () => {
    expect(await rescueScopedOrphans([], corpus, [], loader())).toEqual({
      send: [],
      stillBlocked: [],
    });
  });
});
