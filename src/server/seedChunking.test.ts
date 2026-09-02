import { describe, expect, it } from "vitest";
import {
  type ChunkedStatement,
  SeedShapeError,
  assertDollarQuotesBalanced,
  chunkSeedStatements,
  linesOf,
  readSeedShape,
  seedSkeleton,
} from "./seedChunking.pure";

/** Feed text in awkward pieces so line boundaries fall inside chunks. */
async function* pieces(text: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const HEADER = [
  "-- Template Library — seeded catalogue.",
  "-- IDEMPOTENT: upserts on (slug, version).",
  "INSERT INTO public.template_library_entries (",
  "  slug, version, name,",
  "  schema",
  ")",
  "VALUES",
].join("\n");

const ON_CONFLICT = [
  "ON CONFLICT (slug, version) DO UPDATE SET",
  "  name = EXCLUDED.name,",
  "  schema = EXCLUDED.schema;",
].join("\n");

const TAIL = [
  "-- Publish them.",
  "UPDATE public.template_library_entries SET status = 'published'",
  "WHERE version = 1 AND slug IN ($tlt$a$tlt$, $tlt$b$tlt$);",
].join("\n");

/** One tuple in the generator's shape: `  (` on its own line, JSON dollar-quoted. */
function tuple(slug: string, schemaLines: string[]): string {
  return [
    "  (",
    `    $tlt$${slug}$tlt$, 1, $tlt$${slug.toUpperCase()}$tlt$,`,
    "    $tlj$" + schemaLines.join("\n") + "$tlj$::jsonb",
    "  )",
  ].join("\n");
}

function seed(tuples: string[], opts: { tail?: boolean } = {}): string {
  return (
    `${HEADER}\n${tuples.join(",\n")}\n${ON_CONFLICT}\n\n` +
    (opts.tail === false ? "" : `${TAIL}\n`)
  );
}

const TUPLES = [
  tuple("investor-compass", ['{"pages": [', '  {"kind": "cover"}', "]}"]),
  tuple("executive-brief", ['{"pages": []}']),
  tuple("property-snapshot", [
    '{"pages": [{"kind": "table"}], "notes": "' + "x".repeat(400) + '"}',
  ]),
  tuple("market-intelligence", ['{"pages": []}']),
];

describe("linesOf", () => {
  it("splits across chunk boundaries and does not invent a final empty line", async () => {
    const got: string[] = [];
    for await (const l of linesOf(pieces("a\nbb\n\nccc\n", 2))) got.push(l);
    expect(got).toEqual(["a", "bb", "", "ccc"]);
    const noNewline: string[] = [];
    for await (const l of linesOf(pieces("a\nb", 3))) noNewline.push(l);
    expect(noNewline).toEqual(["a", "b"]);
  });
});

describe("readSeedShape", () => {
  it("keeps the header, the clause and the tail, and counts the rows", async () => {
    const shape = await readSeedShape(pieces(seed(TUPLES)));
    expect(shape.header).toBe(HEADER);
    expect(shape.onConflict).toBe(ON_CONFLICT);
    expect(shape.tail).toBe(TAIL);
    expect(shape.tupleCount).toBe(4);
    expect(shape.target).toBe("public.template_library_entries");
  });

  it("a seed with no trailing statements has an empty tail", async () => {
    const shape = await readSeedShape(pieces(seed(TUPLES, { tail: false })));
    expect(shape.tail).toBe("");
  });

  it("refuses a file that is not the seed shape, by name", async () => {
    await expect(readSeedShape(pieces("create table t (id int);\n"))).rejects.toThrow(
      /no VALUES line/,
    );
    await expect(readSeedShape(pieces(`${HEADER}\n${TUPLES[0]}\n`))).rejects.toThrow(
      /no ON CONFLICT clause/,
    );
    await expect(
      readSeedShape(pieces(`select 1;\nVALUES\n${TUPLES[0]}\n${ON_CONFLICT}\n`)),
    ).rejects.toThrow(/no INSERT INTO/);
  });

  it("refuses a tuple boundary that falls inside a dollar-quoted string", async () => {
    /* The JSON here contains a line that is exactly `  (` — the generator's
       tuple marker — inside the quoted schema. Rejoining the two halves would
       still reproduce the file byte for byte, and every chunk around the split
       would be invalid SQL. The tag balance is what catches it. */
    const poisoned = tuple("poison", ["{", "  (", "}"]);
    await expect(readSeedShape(pieces(seed([TUPLES[0], poisoned])))).rejects.toThrow(
      /splits inside a \$tlj\$ string/,
    );
  });

  it("refuses text before the first tuple rather than absorbing it", async () => {
    const stray = `${HEADER}\n  -- stray\n${TUPLES[0]}\n${ON_CONFLICT}\n`;
    await expect(readSeedShape(pieces(stray))).rejects.toThrow(/text before the first tuple/);
  });

  it("refuses an unterminated ON CONFLICT clause", async () => {
    const cut = `${HEADER}\n${TUPLES[0]}\nON CONFLICT (slug, version) DO UPDATE SET\n  name = EXCLUDED.name\n`;
    await expect(readSeedShape(pieces(cut))).rejects.toThrow(/unterminated/);
  });
});

describe("chunkSeedStatements", () => {
  async function collect(text: string, maxStatementBytes: number) {
    const shape = await readSeedShape(pieces(text));
    const out: ChunkedStatement[] = [];
    for await (const s of chunkSeedStatements(pieces(text), shape, { maxStatementBytes }))
      out.push(s);
    return { shape, out };
  }

  it("reassembles to the original rows, byte for byte, across every statement", async () => {
    const text = seed(TUPLES);
    const { out } = await collect(text, 900);
    const rowStatements = out.filter((s) => s.rows > 0);
    const rebuilt = rowStatements
      .map((s) => {
        expect(s.sql.startsWith(`${HEADER}\n`)).toBe(true);
        expect(s.sql.endsWith(`\n${ON_CONFLICT}`)).toBe(true);
        return s.sql.slice(HEADER.length + 1, s.sql.length - ON_CONFLICT.length - 1);
      })
      .join(",\n");
    expect(rebuilt).toBe(TUPLES.join(",\n"));
    expect(rowStatements.reduce((n, s) => n + s.rows, 0)).toBe(4);
  });

  it("groups by byte budget, never by a fixed row count", async () => {
    const { out } = await collect(seed(TUPLES), 900);
    // Rows one and two fit together; the 400-character third row forces a
    // new statement; the fourth joins whichever it fits.
    expect(out.map((s) => s.label)).toEqual([
      "rows 1-2",
      "rows 3-3",
      "rows 4-4",
      "trailing statements",
    ]);
    for (const s of out.filter((s) => s.rows > 1)) expect(s.bytes).toBeLessThanOrEqual(900);
  });

  it("emits a row larger than the budget on its own rather than dropping it", async () => {
    const { out } = await collect(seed(TUPLES), 10);
    expect(out.filter((s) => s.rows > 0).map((s) => s.rows)).toEqual([1, 1, 1, 1]);
  });

  it("puts everything in one statement when it fits", async () => {
    const { out } = await collect(seed(TUPLES), 100_000);
    expect(out.map((s) => s.label)).toEqual(["rows 1-4", "trailing statements"]);
  });

  it("carries the trailing statements last and only when present", async () => {
    const { out } = await collect(seed(TUPLES, { tail: false }), 100_000);
    expect(out.map((s) => s.label)).toEqual(["rows 1-4"]);
    const { out: withTail } = await collect(seed(TUPLES), 100_000);
    expect(withTail[withTail.length - 1]).toMatchObject({
      label: "trailing statements",
      rows: 0,
      sql: TAIL,
    });
  });

  it("refuses to send when the second read disagrees with the first", async () => {
    const shape = await readSeedShape(pieces(seed(TUPLES)));
    const changed = seed(TUPLES.slice(0, 3));
    const gen = chunkSeedStatements(pieces(changed), shape, { maxStatementBytes: 100_000 });
    await expect(gen.next()).rejects.toThrow(/the blob changed between reads/);
  });
});

describe("the skeleton the gate assesses", () => {
  it("is every executable statement with the rows left out", () => {
    const skeleton = seedSkeleton({
      header: HEADER,
      onConflict: ON_CONFLICT,
      tail: TAIL,
      tupleCount: 4,
      target: "public.template_library_entries",
    });
    expect(skeleton).toContain("INSERT INTO public.template_library_entries");
    expect(skeleton).toContain("ON CONFLICT (slug, version) DO UPDATE SET");
    expect(skeleton).toContain("UPDATE public.template_library_entries SET status = 'published'");
    expect(skeleton).not.toContain("investor-compass");
  });
});

describe("assertDollarQuotesBalanced", () => {
  it("counts each tag separately and accepts $$", () => {
    expect(() => assertDollarQuotesBalanced("$a$x$a$ $$y$$ $tlj$z$tlj$", 1)).not.toThrow();
    expect(() => assertDollarQuotesBalanced("$a$x$a$ $b$", 2)).toThrow(SeedShapeError);
    // A positional parameter is not a tag.
    expect(() => assertDollarQuotesBalanced("select $1", 3)).not.toThrow();
  });
});
