import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type ChunkedStatement,
  type SeedPlan,
  type SeedShape,
  SeedShapeError,
  assertDollarQuotesBalanced,
  chunkSeedStatements,
  linesOf,
  readSeedShape,
  seedSkeleton,
  utf8ByteLength,
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

/*
  A REMEMBERED SHAPE IS TRUSTED FOR WHAT IT DESCRIBES AND CHECKED FOR WHAT IT
  EXECUTES.

  `chunkSeedStatements` re-derives the shape from the second read and refuses
  on any disagreement — that is what licenses carrying a shape across passes
  on the cursor rather than paying for a second 41 MB walk. The tail is the
  one part of a shape that is not a description: it is SQL, taken verbatim
  from the remembered copy and executed. Compared last and asserted here,
  because a file whose trailing statements changed while its header, ON
  CONFLICT and tuple count did not would otherwise run the old tail against
  the new tuples and be recorded as applied. Raised by review.
*/
describe("chunkSeedStatements — the remembered tail", () => {
  const shapeOf = async (text: string) => await readSeedShape(pieces(text));

  async function drain(text: string, shape: Awaited<ReturnType<typeof shapeOf>>) {
    const out: ChunkedStatement[] = [];
    for await (const s of chunkSeedStatements(pieces(text), shape, { maxStatementBytes: 4_000 })) {
      out.push(s);
    }
    return out;
  }

  it("sends the trailing statements when the file still carries them", async () => {
    const text = seed(TUPLES);
    const stmts = await drain(text, await shapeOf(text));
    expect(stmts.at(-1)?.label).toBe("trailing statements");
    expect(stmts.at(-1)?.sql).toContain("SET status = 'published'");
  });

  it("refuses a tail that changed while everything else stayed identical", async () => {
    const before = seed(TUPLES);
    const remembered = await shapeOf(before);
    // Same header, same ON CONFLICT, same tuples — one slug swapped in the
    // trailing UPDATE, which is the shape of edit this corpus actually makes.
    const after = before.replace("$tlt$b$tlt$", "$tlt$c$tlt$");
    expect(after).not.toBe(before);
    const fresh = await shapeOf(after);
    expect(fresh.tupleCount, "the fixture changed more than the tail").toBe(remembered.tupleCount);
    expect(fresh.header).toBe(remembered.header);
    expect(fresh.onConflict).toBe(remembered.onConflict);
    await expect(drain(after, remembered)).rejects.toThrow(SeedShapeError);
  });

  it("refuses a tail that was REMOVED, which is the same class of change", async () => {
    const before = seed(TUPLES);
    const remembered = await shapeOf(before);
    await expect(drain(seed(TUPLES, { tail: false }), remembered)).rejects.toThrow(SeedShapeError);
  });

  it("refuses a tail that APPEARED where the remembered shape had none", async () => {
    const before = seed(TUPLES, { tail: false });
    const remembered = await shapeOf(before);
    await expect(drain(seed(TUPLES), remembered)).rejects.toThrow(SeedShapeError);
  });

  /*
    THE HOLD IS THE GUARANTEE, SO IT IS ASSERTED AND NOT LEFT TO A COMMENT.

    Every statement is `remembered header + fresh tuples + remembered
    onConflict`, and both the ON CONFLICT clause and the tail sit AFTER the last
    tuple — so neither can be compared before EOF. Hand a statement over any
    earlier and it goes out under a clause this pass has not checked: a prime
    that changed `DO UPDATE SET` to `DO NOTHING` between the two reads gets rows
    updated that the new body wanted left alone, and the next pass cannot repair
    it, because under the new clause it never writes those rows at all.

    The comment that used to stand over the queue claimed the opposite — that
    each statement was yielded "as soon as it is whole" and the queue held at
    most one. These two are here because that comment was believed, and because
    the buffer it misdescribes is ~84 MB on the real seed and therefore exactly
    the thing somebody will try to remove.
  */
  describe("nothing is handed over until the second read has agreed", () => {
    /** Drains, recording how much of the stream had been consumed at each yield. */
    async function drainWithReadCount(text: string, shape: SeedShape) {
      let chunksRead = 0;
      const size = 7;
      const totalChunks = Math.ceil(text.length / size);
      async function* counted(): AsyncGenerator<string> {
        for (let i = 0; i < text.length; i += size) {
          chunksRead += 1;
          yield text.slice(i, i + size);
        }
      }
      const readAt: number[] = [];
      for await (const _s of chunkSeedStatements(counted(), shape, { maxStatementBytes: 400 })) {
        readAt.push(chunksRead);
      }
      return { readAt, totalChunks };
    }

    it("reads the whole file before the FIRST statement is handed over", async () => {
      const text = seed(TUPLES);
      const { readAt, totalChunks } = await drainWithReadCount(text, await shapeOf(text));
      expect(readAt.length, "the fixture produced no statements").toBeGreaterThan(1);
      // Every statement, including the first, arrives with the stream exhausted.
      expect(readAt[0]).toBe(totalChunks);
      expect(new Set(readAt)).toEqual(new Set([totalChunks]));
    });

    it("hands over NOTHING when the tail disagrees, rather than all but the tail", async () => {
      const before = seed(TUPLES);
      const remembered = await shapeOf(before);
      const after = before.replace("$tlt$b$tlt$", "$tlt$c$tlt$");
      const got: string[] = [];
      await expect(
        (async () => {
          for await (const s of chunkSeedStatements(pieces(after), remembered, {
            maxStatementBytes: 400,
          })) {
            got.push(s.label);
          }
        })(),
      ).rejects.toThrow(SeedShapeError);
      // The rows are not the hazard on their own; the clause they were poured
      // into is, and it is unknown until the line the tail follows.
      expect(got, "statements went out before the shape was agreed").toEqual([]);
    });
  });
});

/*
  A PASS IS HANDED A WINDOW OF THE SEED, NOT THE WHOLE OF IT.

  Everything handed over is held until the second read reaches EOF, and on the
  real template seed "everything" measured 86.7 MB — two-byte strings, because
  44 of its 45 statements carry a character outside Latin-1. The first pass
  allowed to send a second statement beside that was killed sending it, every
  time. So a pass is handed the statements from its cursor on, no more than a
  cap of them, and everything else is walked and never built. These pin what
  that must not change: the statements themselves, their positions, and the
  EOF rule.
*/
describe("chunkSeedStatements — a window of the seed", () => {
  /** Rows of varied size, every one carrying an em dash, as the real seed's do. */
  const ROWS = Array.from({ length: 11 }, (_, i) =>
    tuple(`entry-${i}`, [`{"title": "Entry ${i} — seeded", "pad": "${"z".repeat(40 + i * 25)}"}`]),
  );
  const TEXT = seed(ROWS);
  const BYTES = 420;

  async function every(): Promise<ChunkedStatement[]> {
    const shape = await readSeedShape(pieces(TEXT));
    const out: ChunkedStatement[] = [];
    for await (const st of chunkSeedStatements(pieces(TEXT), shape, { maxStatementBytes: BYTES }))
      out.push(st);
    return out;
  }

  async function windowed(skip: number, maxHeldChars: number, text = TEXT) {
    const shape = await readSeedShape(pieces(TEXT));
    const plans: SeedPlan[] = [];
    const out: ChunkedStatement[] = [];
    let handedBeforePlan = 0;
    for await (const st of chunkSeedStatements(pieces(text), shape, {
      maxStatementBytes: BYTES,
      window: { skip, maxHeldChars },
      onPlan: (plan) => {
        handedBeforePlan = out.length;
        plans.push(plan);
      },
    }))
      out.push(st);
    return { out, plans, handedBeforePlan };
  }

  it("numbers every statement by its place in the whole seed, the tail included", async () => {
    const all = await every();
    expect(all.length, "the fixture must come to several statements").toBeGreaterThan(5);
    expect(all.map((st) => st.index)).toEqual(all.map((_, i) => i));
    expect(all.at(-1)).toMatchObject({ label: "trailing statements", index: all.length - 1 });
  });

  it("hands over exactly the statements from the cursor on, byte for byte", async () => {
    const all = await every();
    for (const skip of [0, 1, 3, all.length - 1]) {
      const { out } = await windowed(skip, Number.POSITIVE_INFINITY);
      expect(out, `skip ${skip}`).toEqual(all.slice(skip));
    }
  });

  it("holds no more than the cap, and always at least the next statement", async () => {
    const all = await every();
    const two = all[2].sql.length + all[3].sql.length;
    const { out: capped } = await windowed(2, two);
    expect(capped.map((st) => st.index)).toEqual([2, 3]);
    // A cap smaller than any statement still hands over one: a pass that is
    // handed nothing would come back with the cursor where it found it.
    const { out: tiny } = await windowed(4, 1);
    expect(tiny.map((st) => st.index)).toEqual([4]);
    expect(tiny[0]).toEqual(all[4]);
  });

  it("keeps what it hands over contiguous, never skipping a statement that did not fit", async () => {
    const all = await every();
    // Find a statement followed by a LARGER one and then a smaller one, and cap
    // the window so the larger does not fit beside the first while the smaller
    // would. Handing the smaller one over would send it before the larger.
    const at = all.findIndex(
      (st, i) =>
        i + 2 < all.length &&
        all[i + 1].sql.length > st.sql.length &&
        all[i + 2].sql.length < all[i + 1].sql.length,
    );
    expect(at, "the fixture needs a large statement between two smaller ones").toBeGreaterThan(-1);
    const cap = all[at].sql.length + all[at + 2].sql.length;
    expect(all[at].sql.length + all[at + 1].sql.length).toBeGreaterThan(cap);
    const { out } = await windowed(at, cap);
    expect(out.map((st) => st.index)).toEqual([at]);
  });

  it("says how long the whole seed is before it hands anything over", async () => {
    const all = await every();
    const { out, plans, handedBeforePlan } = await windowed(3, all[3].sql.length);
    expect(plans).toEqual([{ total: all.length, held: out.length }]);
    expect(handedBeforePlan).toBe(0);
  });

  it("says so, and hands over nothing, when the cursor is past the end", async () => {
    const all = await every();
    const { out, plans } = await windowed(all.length + 7, Number.POSITIVE_INFINITY);
    expect(out).toEqual([]);
    expect(plans).toEqual([{ total: all.length, held: 0 }]);
    // And on equality — a pass that sent the last statement and died before
    // its ledger row — the same: nothing to send, and the length to prove it.
    const { out: level, plans: levelPlans } = await windowed(all.length, 10);
    expect(level).toEqual([]);
    expect(levelPlans).toEqual([{ total: all.length, held: 0 }]);
  });

  it("still refuses a second read that disagrees, before any plan or statement", async () => {
    const changed = seed(ROWS.slice(0, 10));
    const run = windowed(2, Number.POSITIVE_INFINITY, changed);
    await expect(run).rejects.toThrow(/the blob changed between reads/);
  });

  it("bounds a two-byte seed by the cap, where the whole seed is many times it", async () => {
    const all = await every();
    const whole = all.reduce((n, st) => n + st.sql.length, 0);
    const cap = Math.ceil(whole / 5);
    for (let skip = 0; skip < all.length; skip += 1) {
      const { out } = await windowed(skip, cap);
      const held = out.reduce((n, st) => n + st.sql.length, 0);
      // One statement may exceed the cap on its own; two may not.
      if (out.length > 1) expect(held, `skip ${skip}`).toBeLessThanOrEqual(cap);
      expect(out[0].index).toBe(skip);
    }
    // And the fixture is the case that matters: two-byte, as the real seed is.
    expect(all.every((st) => st.rows === 0 || /[\u0100-\uffff]/.test(st.sql))).toBe(true);
  });

  it("releases each statement as it hands it over rather than iterating a held queue", () => {
    // What the window saves is only saved if a sent statement stops being held
    // while the rest go; iterating the queue keeps every one of them alive
    // until the last is sent. Judged on the source, because a heap reading in
    // a test runner is not one to assert on.
    const src = readFileSync("src/server/seedChunking.pure.ts", "utf8");
    expect(src).toContain("while (ready.length > 0) yield ready.shift()!;");
    expect(src).not.toMatch(/for \(const \w+ of ready\) yield/);
  });
});

describe("utf8ByteLength", () => {
  it("agrees with the encoder it replaces, on every kind of character", () => {
    const encoder = new TextEncoder();
    for (const sample of [
      "",
      "plain ascii",
      "caf\u00e9 \u00b7 \u00a3",
      "em dash \u2014 and \u20ac",
      "astral \u{1F3E0} house",
      "lone high \ud83d then text",
      "lone low \udc00 then text",
      "\ud83d",
      tuple("mixed", ['{"t": "Entry \u2014 caf\u00e9 \u{1F4C8}"}']),
    ]) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(encoder.encode(sample).length);
    }
  });
});
