/**
 * The prime's seed skeletons, as Mission Control reads them.
 *
 * Three properties carry the module, and each is asserted here rather than
 * trusted:
 *
 *   - a manifest is used WHOLE or not at all — a document that is partly
 *     wrong describes nothing, so every seed is read as unread, exactly as
 *     before the prime published one;
 *   - an entry is used only against the bytes it describes — pinned to a git
 *     blob id, so a seed re-released without regenerating the manifest has no
 *     facts rather than somebody else's;
 *   - a skeleton's facts are what makes a seed stop being an OPAQUE barrier,
 *     and nothing more: it never clears a file by body, and a refresh still
 *     waits for the seed it names.
 */
import { describe, expect, it } from "vitest";

import { partitionByDependency, type CorpusMeta } from "./fleetCorpusScope.pure";
import { dependencyFactsOf, type MigrationDependencyFacts } from "./migrationDependencyFacts.pure";
import { mentionedVersionsOf } from "./migrationVersionMentions.pure";
import { SEED_ROWS_MARKER, readSeedShape, seedSkeleton } from "./seedChunking.pure";
import {
  SEED_SKELETONS_PATH,
  readSeedSkeletonManifest,
  readThroughSeedSkeletons,
  seedSkeletonNotes,
  skeletonShapeProblem,
  unreadableSeedSkeletons,
  usableSeedSkeletons,
  type SeedSkeletonReading,
} from "./seedSkeletonManifest.pure";

const SEED_V = "20261204020000";
const SEED_NAME = `${SEED_V}_seed_template_library_v15.sql`;
const SEED_PATH = `supabase/migrations/${SEED_NAME}`;
const SEED_BLOB = "a".repeat(40);

/** A seed in the corpus's own layout: a baseline insert, then the rows. */
const SEED_SQL = [
  "CREATE TABLE IF NOT EXISTS public.template_library_release_baselines (entry_id uuid, release text);",
  "INSERT INTO public.template_library_release_baselines (entry_id, release)",
  `SELECT id, '${SEED_V}_seed_template_library_v15' FROM public.template_library_entries`,
  "ON CONFLICT (entry_id, release) DO NOTHING;",
  "INSERT INTO public.template_library_entries (slug, schema)",
  "VALUES",
  "  (",
  "    'alpha',",
  '    $json${"title": "A", "weight": 0.05000000000007}$json$::jsonb',
  "  ),",
  "  (",
  "    'bravo',",
  '    $json${"title": "B"}$json$::jsonb',
  "  )",
  "ON CONFLICT (slug) DO UPDATE",
  "  SET schema = EXCLUDED.schema;",
  "",
].join("\n");

async function* chunked(text: string, size = 7): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

/** The skeleton Mission Control's own reader derives from {@link SEED_SQL}. */
const skeletonOf = async (sql: string) => seedSkeleton(await readSeedShape(chunked(sql)));

type Doc = {
  schema_version?: unknown;
  generated_by?: unknown;
  min_bytes?: unknown;
  skeletons?: unknown;
  refused?: unknown;
};

/** A manifest as the prime writes one. */
const manifest = (over: Doc = {}, skeleton = "") =>
  JSON.stringify({
    schema_version: 1,
    generated_by: "scripts/build-migration-seed-skeletons.mjs",
    min_bytes: 262144,
    skeletons: [{ path: SEED_PATH, blob: SEED_BLOB, bytes: 40_000_000, tuples: 2, skeleton }],
    refused: [],
    ...over,
  });

const file = (name: string, sha: string) => ({
  name,
  path: `supabase/migrations/${name}`,
  sha,
});

describe("skeletonShapeProblem — the shape the prime's join produces, and nothing looser", () => {
  it("accepts the skeleton Mission Control's own reader derives", async () => {
    const skeleton = await skeletonOf(SEED_SQL);
    expect(skeletonShapeProblem(skeleton)).toBeNull();
    // And the marker it is checked for is the one the join writes.
    expect(skeleton.split("\n")).toContain(SEED_ROWS_MARKER);
  });

  it("accepts a skeleton with no tail — the join drops an empty part", async () => {
    const shape = await readSeedShape(chunked(SEED_SQL));
    expect(skeletonShapeProblem(seedSkeleton({ ...shape, tail: "" }))).toBeNull();
  });

  it.each([
    ["no marker", "INSERT INTO public.t (a)\nVALUES\nON CONFLICT DO NOTHING;", /no row marker/],
    [
      "two markers",
      `INSERT INTO public.t (a)\nVALUES\n${SEED_ROWS_MARKER}\n${SEED_ROWS_MARKER}\nON CONFLICT DO NOTHING;`,
      /more than one row marker/,
    ],
    [
      "a marker not under VALUES",
      `INSERT INTO public.t (a)\nSELECT 1\n${SEED_ROWS_MARKER}\nON CONFLICT DO NOTHING;`,
      /does not open its rows with a VALUES line/,
    ],
    [
      "no INSERT above the rows",
      `SELECT 1\nVALUES\n${SEED_ROWS_MARKER}\nON CONFLICT DO NOTHING;`,
      /names no INSERT INTO/,
    ],
    [
      "no ON CONFLICT below the rows",
      `INSERT INTO public.t (a)\nVALUES\n${SEED_ROWS_MARKER}\nUPDATE public.t SET a = 1;`,
      /does not close its rows with an ON CONFLICT clause/,
    ],
    [
      "a marker as the last line",
      `INSERT INTO public.t (a)\nVALUES\n${SEED_ROWS_MARKER}`,
      /does not close its rows with an ON CONFLICT clause/,
    ],
  ])("refuses %s", (_label, text, why) => {
    expect(skeletonShapeProblem(text)).toMatch(why);
  });
});

describe("readSeedSkeletonManifest — used whole or not at all", () => {
  it("reads the absence of a manifest as absent, describing nothing", () => {
    const r = readSeedSkeletonManifest(null);
    expect(r.state).toBe("absent");
    expect(r.entries.size).toBe(0);
    expect(r.refused).toEqual([]);
  });

  it("reads a manifest the prime wrote: entries by path, refusals by path", async () => {
    const skeleton = await skeletonOf(SEED_SQL);
    const refusedPath = "supabase/migrations/20261101000000_seed_template_library_v9.sql";
    const r = readSeedSkeletonManifest(
      manifest(
        {
          refused: [{ path: refusedPath, blob: "b".repeat(40), bytes: 1, why: "no VALUES line" }],
        },
        skeleton,
      ),
    );
    expect(r.state).toBe("read");
    expect([...r.entries.keys()]).toEqual([SEED_PATH]);
    expect(r.entries.get(SEED_PATH)).toEqual({ path: SEED_PATH, blob: SEED_BLOB, skeleton });
    expect(r.refused).toEqual([refusedPath]);
  });

  it("reads a manifest that describes nothing as read, not as unreadable", () => {
    const r = readSeedSkeletonManifest(manifest({ skeletons: [] }));
    expect(r.state).toBe("read");
    expect(r.entries.size).toBe(0);
  });

  const good = "INSERT INTO public.t (a)\nVALUES\n  (…)\nON CONFLICT DO NOTHING;";
  const entry = (over: Record<string, unknown>) => ({
    path: SEED_PATH,
    blob: SEED_BLOB,
    bytes: 1,
    tuples: 1,
    skeleton: good,
    ...over,
  });

  it.each<[string, string, RegExp]>([
    ["text that is not JSON", "{ nope", /not valid JSON/],
    ["an array", "[]", /not a JSON object/],
    ["null", "null", /not a JSON object/],
    [
      "a version this reader does not know",
      manifest({ schema_version: 2 }),
      /schema_version 2; this reader knows 1/,
    ],
    ["no version at all", manifest({ schema_version: undefined }), /schema_version undefined/],
    ["no skeletons array", manifest({ skeletons: {} }), /no "skeletons" array/],
    ["no refused array", manifest({ refused: null }), /no "refused" array/],
    [
      "a path outside the migrations directory",
      manifest({ skeletons: [entry({ path: "supabase/functions/x/index.sql" })] }),
      /skeletons\[0\] does not name a migration file/,
    ],
    [
      "a path that climbs out of it",
      manifest({
        skeletons: [entry({ path: "supabase/migrations/../../etc/20261204020000_x.sql" })],
      }),
      /does not name a migration file/,
    ],
    [
      "a path with no fourteen-digit version",
      manifest({ skeletons: [entry({ path: "supabase/migrations/2026_x.sql" })] }),
      /does not name a migration file/,
    ],
    [
      "a blob id that is not git's",
      manifest({ skeletons: [entry({ blob: "A".repeat(40) })] }),
      /carries no git blob id/,
    ],
    [
      "a short blob id",
      manifest({ skeletons: [entry({ blob: "abc123" })] }),
      /carries no git blob id/,
    ],
    ["no skeleton text", manifest({ skeletons: [entry({ skeleton: 42 })] }), /carries no skeleton/],
    [
      "a skeleton of the wrong shape",
      manifest({ skeletons: [entry({ skeleton: "SELECT 1;" })] }),
      /is not a seed skeleton: it carries no row marker/,
    ],
    [
      "one file described twice",
      manifest({ skeletons: [entry({}), entry({ blob: "c".repeat(40) })] }),
      /described twice/,
    ],
    [
      "a refusal that names no migration file",
      manifest({ skeletons: [], refused: [{ path: 7 }] }),
      /refused\[0\] does not name a migration file/,
    ],
  ])("refuses %s, and describes nothing", (_label, text, why) => {
    const r = readSeedSkeletonManifest(text);
    expect(r.state).toBe("unreadable");
    expect(r.state === "unreadable" && r.why).toMatch(why);
    // Not the entries that happened to parse: a partial document is not acted on.
    expect(r.entries.size).toBe(0);
    expect(r.refused).toEqual([]);
  });

  it("refuses the whole document for one bad entry among good ones", () => {
    const r = readSeedSkeletonManifest(
      manifest({
        skeletons: [
          entry({}),
          entry({
            path: "supabase/migrations/20261205000000_seed_template_library_v16.sql",
            skeleton: "no marker",
          }),
        ],
      }),
    );
    expect(r.state).toBe("unreadable");
    expect(r.entries.size).toBe(0);
  });

  it("never throws, whatever it is handed", () => {
    for (const text of ["", "0", '"x"', "true", "{}", '{"schema_version":1}']) {
      expect(() => readSeedSkeletonManifest(text)).not.toThrow();
      expect(readSeedSkeletonManifest(text).state).toBe("unreadable");
    }
  });
});

describe("usableSeedSkeletons — an entry is used only against its own bytes", () => {
  const reading = (
    paths: Array<[string, string]>,
    refused: string[] = [],
  ): SeedSkeletonReading => ({
    state: "read",
    entries: new Map(paths.map(([path, blob]) => [path, { path, blob, skeleton: `sk:${path}` }])),
    refused,
  });

  it("uses an entry whose blob is the file's own", () => {
    const seed = file(SEED_NAME, SEED_BLOB);
    const { skeletons, report } = usableSeedSkeletons(
      reading([[seed.path, SEED_BLOB]]),
      [seed],
      () => false,
    );
    expect([...skeletons]).toEqual([[seed.path, `sk:${seed.path}`]]);
    expect(report).toEqual({
      state: "read",
      used: [SEED_NAME],
      stale: [],
      unmatched: [],
      refused: [],
    });
  });

  it("reads a file whose bytes changed since the manifest as unread, and names it stale", () => {
    const seed = file(SEED_NAME, "d".repeat(40));
    const { skeletons, report } = usableSeedSkeletons(
      reading([[seed.path, SEED_BLOB]]),
      [seed],
      () => false,
    );
    expect(skeletons.size).toBe(0);
    expect(report.stale).toEqual([SEED_NAME]);
    expect(report.used).toEqual([]);
  });

  it("names an entry for a file this corpus does not carry, and uses nothing for it", () => {
    const gone = `supabase/migrations/20261101000000_seed_template_library_v9.sql`;
    const { skeletons, report } = usableSeedSkeletons(
      reading([[gone, SEED_BLOB]]),
      [],
      () => false,
    );
    expect(skeletons.size).toBe(0);
    expect(report.unmatched).toEqual(["20261101000000_seed_template_library_v9.sql"]);
  });

  it("leaves a file the pass already read alone — a body outranks its description", () => {
    const seed = file(SEED_NAME, SEED_BLOB);
    const { skeletons, report } = usableSeedSkeletons(
      reading([[seed.path, SEED_BLOB]]),
      [seed],
      (p) => p === seed.path,
    );
    expect(skeletons.size).toBe(0);
    expect(report.used).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("uses nothing from an unreadable manifest, and carries why", () => {
    const seed = file(SEED_NAME, SEED_BLOB);
    const { skeletons, report } = usableSeedSkeletons(
      unreadableSeedSkeletons("it is not valid JSON"),
      [seed],
      () => false,
    );
    expect(skeletons.size).toBe(0);
    expect(report).toEqual({
      state: "unreadable",
      why: "it is not valid JSON",
      used: [],
      stale: [],
      unmatched: [],
      refused: [],
    });
  });

  it("reports file names, sorted, and the refusals by name", () => {
    const a = file("20261205000000_seed_template_library_v16.sql", "1".repeat(40));
    const b = file(SEED_NAME, SEED_BLOB);
    const { report } = usableSeedSkeletons(
      reading(
        [
          [a.path, "1".repeat(40)],
          [b.path, SEED_BLOB],
        ],
        ["supabase/migrations/20261201000000_z.sql", "supabase/migrations/20261101000000_a.sql"],
      ),
      [a, b],
      () => false,
    );
    expect(report.used).toEqual([SEED_NAME, "20261205000000_seed_template_library_v16.sql"].sort());
    expect(report.refused).toEqual(["20261101000000_a.sql", "20261201000000_z.sql"]);
  });
});

describe("readThroughSeedSkeletons — facts from the statements, and only facts", () => {
  it("gives a seed the facts its whole body would give, and the names without the rows' noise", async () => {
    const skeleton = await skeletonOf(SEED_SQL);
    const seed = file(SEED_NAME, SEED_BLOB);
    const { facts, mentions } = readThroughSeedSkeletons(
      readSeedSkeletonManifest(manifest({}, skeleton)),
      [seed],
      { facts: new Map(), mentions: new Map() },
    );
    // The same extractor over the whole body agrees — the measurement the
    // prime's manifest rests on, on a seed small enough to hold here.
    expect(facts.get(seed.path)).toEqual(dependencyFactsOf(SEED_SQL));
    // The seed's own release name is in its statements; the float in its row
    // JSON reads as a fourteen-digit "version" only in the body.
    expect(mentions.get(seed.path)).toEqual([SEED_V]);
    expect(mentionedVersionsOf(SEED_SQL)).toContain("05000000000007");
  });

  it("keeps what the pass read, and does not mutate the maps it was handed", async () => {
    const skeleton = await skeletonOf(SEED_SQL);
    const seed = file(SEED_NAME, SEED_BLOB);
    const small = "supabase/migrations/20261203000000_small.sql";
    const readFacts: MigrationDependencyFacts = { creates: ["public.x"], requires: [] };
    const passFacts = new Map([[small, readFacts]]);
    const passMentions = new Map([[small, ["20261101000000"]]]);

    const through = readThroughSeedSkeletons(
      readSeedSkeletonManifest(manifest({}, skeleton)),
      [seed, file("20261203000000_small.sql", "e".repeat(40))],
      { facts: passFacts, mentions: passMentions },
    );

    expect(through.facts.get(small)).toBe(readFacts);
    expect(through.mentions.get(small)).toEqual(["20261101000000"]);
    expect(through.facts.has(seed.path)).toBe(true);
    expect(passFacts.has(seed.path)).toBe(false);
    expect(passMentions.has(seed.path)).toBe(false);
  });

  it("never gives a file the other half of what the pass read for it", async () => {
    // A path the pass holds mentions for (and, by a defect elsewhere, no
    // facts) was READ. A skeleton would supply facts from different text.
    const skeleton = await skeletonOf(SEED_SQL);
    const seed = file(SEED_NAME, SEED_BLOB);
    const through = readThroughSeedSkeletons(
      readSeedSkeletonManifest(manifest({}, skeleton)),
      [seed],
      { facts: new Map(), mentions: new Map([[seed.path, []]]) },
    );
    expect(through.facts.has(seed.path)).toBe(false);
    expect(through.report.used).toEqual([]);
  });

  it("returns facts, names and a report — never a body digest", async () => {
    const skeleton = await skeletonOf(SEED_SQL);
    const through = readThroughSeedSkeletons(
      readSeedSkeletonManifest(manifest({}, skeleton)),
      [file(SEED_NAME, SEED_BLOB)],
      { facts: new Map(), mentions: new Map() },
    );
    expect(Object.keys(through).sort()).toEqual(["facts", "mentions", "report"]);
  });
});

describe("what the facts change at the barrier", () => {
  /** The urban-centre migration the prime's ledger does not record: a hole. */
  const HOLE = {
    id: "20261203000000",
    name: "20261203000000_urban_centre_register.sql",
    sql: "create table if not exists public.urban_centre_register (sua_code text primary key);",
  };
  /** A later migration that has nothing to do with either. */
  const LATER = {
    id: "20261206000000",
    name: "20261206000000_unrelated.sql",
    sql: "alter table public.report_templates add column if not exists note text;",
  };
  /** A refresh that reads the seed's rows back by the seed's release name. */
  const REFRESH = {
    id: "20261205000000",
    name: "20261205000000_refresh_active_masters_from_library_v15.sql",
    sql: `select 1 from public.template_library_release_baselines b where b.release = '${SEED_V}_seed_template_library_v15';`,
  };

  const read = (m: { id: string; name: string; sql: string }): CorpusMeta => ({
    id: m.id,
    name: m.name,
    ...dependencyFactsOf(m.sql),
    mentions: mentionedVersionsOf(m.sql),
  });

  /** The seed as the pass sees it: unread, or read through its skeleton. */
  const seedMeta = async (withSkeleton: boolean): Promise<CorpusMeta> => {
    const base = { id: SEED_V, name: SEED_NAME };
    if (!withSkeleton) return base;
    const skeleton = await skeletonOf(SEED_SQL);
    const through = readThroughSeedSkeletons(
      readSeedSkeletonManifest(manifest({}, skeleton)),
      [file(SEED_NAME, SEED_BLOB)],
      { facts: new Map(), mentions: new Map() },
    );
    return {
      ...base,
      ...through.facts.get(SEED_PATH),
      mentions: through.mentions.get(SEED_PATH),
    };
  };

  const ids = (ms: readonly CorpusMeta[]) => ms.map((m) => m.id);

  it("a seed the prime ran is sent past a hole it does not depend on — once its statements are read", async () => {
    const run = async (withSkeleton: boolean) =>
      partitionByDependency(
        [read(HOLE), await seedMeta(withSkeleton), read(REFRESH), read(LATER)],
        new Set([SEED_V, REFRESH.id, LATER.id]),
        new Set(),
      );

    // Unread, the seed cannot say what it needs, so the hole holds it — and
    // held, it is an opaque barrier to everything after it.
    const before = await run(false);
    expect(ids(before.send)).toEqual([]);

    // Read through its skeleton, it needs nothing the hole creates and names
    // no version the hole is: it goes, and so does what was waiting on it.
    const after = await run(true);
    expect(ids(after.send)).toEqual([SEED_V, REFRESH.id, LATER.id]);
    expect(after.holes).toEqual([HOLE.id]);
  });

  it("a refresh still waits for a seed that is held, however well the seed is read", async () => {
    // The seed is a hole here — withheld — and its skeleton makes it a
    // TRANSPARENT one. The refresh names it, so it waits; the unrelated
    // migration behind it no longer does.
    const r = partitionByDependency(
      [await seedMeta(true), read(REFRESH), read(LATER)],
      new Set([REFRESH.id, LATER.id]),
      new Set(),
    );
    expect(ids(r.send)).toEqual([LATER.id]);
    expect(r.orphaned.map((o) => [o.meta.id, o.blockedBy])).toEqual([[REFRESH.id, [SEED_V]]]);
  });

  it("an unread seed that is held still holds everything after it", async () => {
    const r = partitionByDependency(
      [await seedMeta(false), read(REFRESH), read(LATER)],
      new Set([REFRESH.id, LATER.id]),
      new Set(),
    );
    expect(ids(r.send)).toEqual([]);
  });
});

describe("seedSkeletonNotes — one wording for every surface", () => {
  const report = (over: Partial<Parameters<typeof seedSkeletonNotes>[0]> = {}) => ({
    state: "read" as const,
    used: [],
    stale: [],
    unmatched: [],
    refused: [],
    ...over,
  });

  it("is silent when the manifest was read and everything it describes is current", () => {
    expect(seedSkeletonNotes(report({ used: [SEED_NAME] }))).toEqual([]);
    expect(seedSkeletonNotes(report({ state: "absent" }))).toEqual([]);
  });

  it("always says an unreadable manifest, and what it costs", () => {
    const [note] = seedSkeletonNotes(report({ state: "unreadable", why: "it is not valid JSON" }));
    expect(note).toContain(SEED_SKELETONS_PATH);
    expect(note).toContain("(it is not valid JSON)");
    expect(note).toMatch(/holds every migration after it/);
  });

  it("names stale and refused files, in the right number", () => {
    expect(seedSkeletonNotes(report({ stale: ["a.sql"] }))[0]).toMatch(
      /^1 migration file has changed/,
    );
    expect(seedSkeletonNotes(report({ stale: ["a.sql", "b.sql"] }))[0]).toMatch(
      /^2 migration files have changed .* they are read as unread .*: a\.sql, b\.sql\.$/,
    );
    expect(seedSkeletonNotes(report({ refused: ["c.sql"] }))[0]).toMatch(
      /could not describe 1 migration file too large .* it is still read as unread: c\.sql\.$/,
    );
  });

  it("does not report unmatched entries to an operator — they describe nothing here", () => {
    expect(seedSkeletonNotes(report({ unmatched: ["gone.sql"] }))).toEqual([]);
  });
});
