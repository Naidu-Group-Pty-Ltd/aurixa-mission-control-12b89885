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
      [{ id: "20261203010000", name: "20261203010000_x.sql", sql: SQL["20261203010000"] }],
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

/**
 * A version several files share is decided ONCE. The replay records versions,
 * so sending one sibling while holding the other records the version over a
 * file that never ran — and nothing sends a recorded version again.
 */
describe("rescueScopedOrphans — a shared version is one decision", () => {
  const V = "20261205000000";
  const HOLE_V = "20261204000000";
  const file = (id: string, slug: string) => ({ id, name: `${id}_${slug}.sql` });
  const BODIES: Record<string, string> = {
    [`${HOLE_V}_first.sql`]: `CREATE TABLE IF NOT EXISTS public.shared_first_tbl (id int);`,
    [`${HOLE_V}_second.sql`]: `CREATE TABLE IF NOT EXISTS public.shared_second_tbl (id int);`,
    [`${V}_independent.sql`]: `CREATE TABLE IF NOT EXISTS public.v_independent_tbl (id int);`,
    [`${V}_dependent.sql`]: `
      CREATE TABLE IF NOT EXISTS public.v_dependent_log (id int);
      INSERT INTO public.shared_second_tbl (id) VALUES (1);
    `,
    "20261206000000_after.sql": `UPDATE public.report_templates SET name = name WHERE false;`,
    "20261207000000_needs_sibling.sql": `INSERT INTO public.v_independent_tbl (id) VALUES (1);`,
  };
  const byName = (unreadable: ReadonlySet<string> = new Set()) =>
    vi.fn(async (m: { id: string; name: string }) => {
      if (unreadable.has(m.name)) throw new Error(`no body for ${m.name}`);
      const sql = BODIES[m.name];
      if (sql === undefined) throw new Error(`no body for ${m.name}`);
      return sql;
    });
  const holeFiles = [file(HOLE_V, "first"), file(HOLE_V, "second")];
  const sharedCorpus = [
    ...holeFiles,
    file(V, "dependent"),
    file(V, "independent"),
    file("20261206000000", "after"),
  ];
  const orphanOf = (m: { id: string; name: string }, blockedBy: string[] = [HOLE_V]) => ({
    meta: m,
    blockedBy,
  });

  it("holds both files when the hole reaches either one of them", async () => {
    const r = await rescueScopedOrphans(
      [orphanOf(file(V, "dependent")), orphanOf(file(V, "independent"))],
      sharedCorpus,
      [],
      byName(),
    );
    expect(r.send).toEqual([]);
    expect(r.stillBlocked.map((o) => o.meta.name)).toEqual([
      `${V}_dependent.sql`,
      `${V}_independent.sql`,
    ]);
    for (const o of r.stillBlocked) expect(o.blockedBy).toEqual([HOLE_V]);
  });

  it("reads every file of a shared hole, each by its own name", async () => {
    const load = byName();
    await rescueScopedOrphans([orphanOf(file(V, "independent"))], sharedCorpus, [], load);
    const holeReads = load.mock.calls.map(([m]) => m.name).filter((n) => n.startsWith(HOLE_V));
    expect(holeReads).toEqual([`${HOLE_V}_first.sql`, `${HOLE_V}_second.sql`]);
  });

  it("finds what the SECOND file of a hole creates", async () => {
    // Resolved by version, the hole read one file's body and missed what the
    // other created; the dependent file here needs the second one's table.
    const r = await rescueScopedOrphans(
      [orphanOf(file(V, "dependent"))],
      sharedCorpus,
      [],
      byName(),
    );
    expect(r.send).toEqual([]);
    expect(r.stillBlocked[0].blockedBy).toEqual([HOLE_V]);
  });

  it("is opaque when any one file of the hole could not be read", async () => {
    const r = await rescueScopedOrphans(
      [orphanOf(file(V, "independent"))],
      sharedCorpus,
      [],
      byName(new Set([`${HOLE_V}_second.sql`])),
    );
    expect(r.send).toEqual([]);
    expect(r.stillBlocked[0].blockedBy).toEqual([HOLE_V]);
  });

  it("sends both files when nothing reaches either", async () => {
    // A hole whose files create only the FIRST table reaches neither sibling.
    const r = await rescueScopedOrphans(
      [orphanOf(file(V, "independent")), orphanOf(file("20261206000000", "after"))],
      [file(HOLE_V, "first"), file(V, "independent"), file("20261206000000", "after")],
      [],
      byName(),
    );
    expect(r.send.map((m) => m.name)).toEqual([`${V}_independent.sql`, "20261206000000_after.sql"]);
  });

  it("judges what comes after a held version against every file of it", async () => {
    const heldV = [orphanOf(file(V, "dependent")), orphanOf(file(V, "independent"))];
    // Nothing either file of V creates is named here, so it is sent.
    const clear = await rescueScopedOrphans(
      [...heldV, orphanOf(file("20261206000000", "after"), [])],
      sharedCorpus,
      [],
      byName(),
    );
    expect(clear.send.map((m) => m.name)).toEqual(["20261206000000_after.sql"]);
    expect(clear.stillBlocked.map((o) => o.meta.id)).toEqual([V, V]);

    // This one names the table the INDEPENDENT file creates. That file was
    // sendable on its own merits and is held only because its version is, so
    // what it creates is still missing — and what needs it has to wait.
    const waits = await rescueScopedOrphans(
      [...heldV, orphanOf(file("20261207000000", "needs_sibling"), [])],
      [...sharedCorpus, file("20261207000000", "needs_sibling")],
      [],
      byName(),
    );
    expect(waits.send).toEqual([]);
    expect(waits.stillBlocked.at(-1)).toEqual({
      meta: file("20261207000000", "needs_sibling"),
      blockedBy: [V],
    });
  });
});
