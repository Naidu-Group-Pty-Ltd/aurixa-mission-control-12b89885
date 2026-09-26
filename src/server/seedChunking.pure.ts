/**
 * Chunk a seeded-catalogue migration into statements the Management API will
 * take — from a STREAM, never holding the file.
 *
 * The template-library seed is one INSERT of 543 rows carrying 39 MB of
 * schema JSON. That is past the 8 MB ceiling `openPrimeMigrationCorpus`
 * refuses at, and the ceiling is right: a body that size cannot be sent as
 * one Management API statement, and this runtime cannot hold it either — a
 * 39 MB file is a 52 MB base64 response, a 78 MB UTF-16 string and a second
 * copy for the split, against an isolate limit of 128 MB. So the fleet sync
 * withheld it, the cascade held it, and the seed reached no clone. The
 * prime's own `.github/scripts/apply-migration.mjs` solves the same problem
 * for the prime by splitting on tuple boundaries and sending each chunk with
 * the file's own ON CONFLICT clause; it can afford to read the whole file.
 * This is that chunker, written so that no more than one tuple and one chunk
 * are ever in memory.
 *
 * Two passes, because every chunk needs the ON CONFLICT clause and the clause
 * comes AFTER the rows. The first pass reads the file end to end keeping only
 * the header, the clause, the trailing statements and the tuple count; the
 * second re-reads it and emits statements as tuples arrive. Two reads of the
 * blob cost two requests, against a cascade budget of thousands.
 *
 * The checks are the prime script's, kept because each one caught a real
 * class of wrong split. A line that is exactly `  (` INSIDE a dollar-quoted
 * JSON schema would be taken as a tuple boundary, and every chunk around it
 * would be invalid SQL while the parse looked complete — so the dollar-quote
 * tags must balance within every tuple. The second pass must find exactly the
 * tuples the first did, or the blob changed between reads. A tuple must end
 * with `)`. Text before the first tuple is refused rather than absorbed.
 *
 * What it does NOT do: it never sends anything, never decides whether the
 * migration is destructive (the lane assesses the skeleton — header, clause,
 * tail — which is every executable statement the data is poured into), and
 * never recognises any shape but this one. A large file that is not this
 * shape is not this module's problem, and is refused by name.
 */

export class SeedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedShapeError";
  }
}

/** What the first pass keeps: everything but the rows. */
export type SeedShape = {
  /** The INSERT through the line `VALUES`, verbatim. */
  header: string;
  /** The `ON CONFLICT … ;` clause, verbatim, possibly several lines. */
  onConflict: string;
  /** Statements after the clause, trimmed. Empty when there are none. */
  tail: string;
  /** Tuples the first pass parsed; the second pass must find the same. */
  tupleCount: number;
  /** The table the INSERT names, for the report. */
  target: string | null;
};

export type ChunkedStatement = {
  /** `rows 1-20`, or `trailing statements`. */
  label: string;
  sql: string;
  /** Tuples in this statement; 0 for the tail. */
  rows: number;
  bytes: number;
  /**
   * This statement's position in the whole seed, from 0, the trailing
   * statements included.
   *
   * Carried on the statement because a caller handed a WINDOW of the seed
   * (see {@link StatementWindow}) cannot count its way to a position: the
   * statements before the window are never handed over at all. The cursor
   * stores positions, so the position has to come from the one place that
   * walked every statement.
   */
  index: number;
};

/**
 * Which of the seed's statements one call builds and hands over.
 *
 * ## Why a pass is handed a window rather than the whole seed
 *
 * Nothing may be handed over until the second read reaches EOF (see the
 * comment inside {@link chunkSeedStatements}), so everything handed over is
 * HELD until then — and a statement is a string of up to a megabyte of seed
 * text. Holding all of them is what killed the fleet drain: measured
 * 26 Sep 2026 over the real `20261207000000_seed_template_library_v16_…`
 * (41,780,944 bytes), the queue came to **86.7 MB of heap**, because 44 of its
 * 45 statements carry at least one character outside Latin-1 and V8 stores
 * such a string at two bytes a character. That is two thirds of a 128 MB
 * isolate before the corpus, the clients and the request bodies. A pass that
 * sent ONE statement and stopped fitted; the first pass allowed a second
 * statement died sending it, every time, as an HTTP 502 with nothing logged.
 *
 * A pass never sends more than a handful of statements inside its budget, so
 * it is handed the statements from its cursor onward and no more than
 * `maxHeldChars` of them. Everything else is still WALKED — every tuple is
 * validated and counted, and the grouping is computed over the whole file so
 * a position means the same statement on every pass — it is just never built.
 */
export type StatementWindow = {
  /**
   * Statements before this position are counted and never built: an earlier
   * pass sent them.
   */
  skip: number;
  /**
   * The most statement text, in UTF-16 code units, held at once. The first
   * statement at or after `skip` is always held however large it is, so a
   * pass always has something to send; after that, the window closes at the
   * first statement that would exceed this, so what is handed over is always
   * CONTIGUOUS and a later, smaller statement is never sent ahead of it.
   */
  maxHeldChars: number;
};

/**
 * What the second read established, reported before anything is handed over.
 *
 * `total` is what tells a windowed caller whether the statements it was handed
 * FINISH the seed. Without it, a window that ran out and a seed that ended
 * look identical to the loop consuming them — and the first reading makes the
 * caller write the migration's ledger row for a seed it has not finished.
 */
export type SeedPlan = {
  /** Statements in the whole seed, the trailing statements included. */
  total: number;
  /** Statements this call will hand over, from the window's `skip` onward. */
  held: number;
};

/**
 * The UTF-8 length of a string, without encoding it.
 *
 * `TextEncoder.encode(s).length` allocates a buffer the size of the string to
 * read one number off it, and this runs on every tuple of a 41 MB seed on
 * every pass — 41 MB of short-lived buffers, which are external memory in the
 * isolate that is already the constraint above. Lone surrogates count three
 * bytes, as the encoder's U+FFFD replacement does, so the two agree on every
 * string; `seedChunking.test.ts` holds them to it.
 */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

const byteLength = utf8ByteLength;

/** Split a stream of text into lines without their terminators. */
export async function* linesOf(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of chunks) {
    rest += chunk;
    let at = rest.indexOf("\n");
    while (at !== -1) {
      yield rest.slice(0, at);
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
    }
  }
  // A file that ends in a newline ends here with an empty remainder, which is
  // not a line. One that does not ends with a real last line, which is.
  if (rest.length > 0) yield rest;
}

/** Every dollar-quote tag in a tuple must open and close inside it. */
export function assertDollarQuotesBalanced(tuple: string, ordinal: number): void {
  const counts = new Map<string, number>();
  for (const tag of tuple.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g) ?? []) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  for (const [tag, n] of counts) {
    if (n % 2 !== 0) {
      throw new SeedShapeError(
        `tuple ${ordinal} splits inside a ${tag} string (${n} tags) — refusing to chunk`,
      );
    }
  }
}

/**
 * Assembles tuples from region lines one at a time. Holds at most one tuple.
 */
class TupleAssembler {
  private current: string[] | null = null;
  count = 0;

  feed(line: string, onTuple: (tuple: string) => void): void {
    if (line === "  (") {
      if (this.current) onTuple(this.finish());
      this.current = [line];
      return;
    }
    if (!this.current) {
      if (line.trim() === "") return;
      throw new SeedShapeError(
        `text before the first tuple is not a row and cannot be chunked: ${JSON.stringify(line.slice(0, 60))}`,
      );
    }
    this.current.push(line);
  }

  end(onTuple: (tuple: string) => void): void {
    if (this.current) onTuple(this.finish());
  }

  private finish(): string {
    const body = this.current!;
    this.current = null;
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    if (body.length < 2) throw new SeedShapeError(`tuple ${this.count + 1} has no body`);
    const last = body.length - 1;
    let lastLine = body[last].replace(/\s+$/, "");
    if (lastLine.endsWith(",")) lastLine = lastLine.slice(0, -1);
    body[last] = lastLine;
    const tuple = body.join("\n");
    // The balance check runs first: a boundary that fell inside a quoted
    // string is the cause, and "does not end with ')'" would be its symptom.
    assertDollarQuotesBalanced(tuple, this.count + 1);
    if (!lastLine.endsWith(")")) {
      throw new SeedShapeError(`tuple ${this.count + 1} does not end with ')'`);
    }
    this.count += 1;
    return tuple;
  }
}

type Phase = "header" | "region" | "conflict" | "tail";

/**
 * Walk the file once, handing every tuple to `onTuple` and keeping the rest.
 */
async function walk(
  chunks: AsyncIterable<string>,
  onTuple: (tuple: string) => void,
): Promise<SeedShape> {
  let phase: Phase = "header";
  const header: string[] = [];
  const conflict: string[] = [];
  const tail: string[] = [];
  const tuples = new TupleAssembler();

  for await (const line of linesOf(chunks)) {
    if (phase === "header") {
      header.push(line);
      if (line === "VALUES") {
        const head = header.join("\n");
        if (!/INSERT INTO\s+/i.test(head)) {
          throw new SeedShapeError(
            "VALUES reached with no INSERT INTO before it — not the recognised seed shape",
          );
        }
        phase = "region";
      }
      continue;
    }
    if (phase === "region") {
      if (line.startsWith("ON CONFLICT ")) {
        tuples.end(onTuple);
        conflict.push(line);
        phase = line.replace(/\s+$/, "").endsWith(";") ? "tail" : "conflict";
        continue;
      }
      tuples.feed(line, onTuple);
      continue;
    }
    if (phase === "conflict") {
      conflict.push(line);
      if (line.replace(/\s+$/, "").endsWith(";")) phase = "tail";
      continue;
    }
    tail.push(line);
  }

  if (phase === "header") {
    throw new SeedShapeError("no VALUES line — not the recognised seed shape");
  }
  if (phase === "region") {
    throw new SeedShapeError(
      "no ON CONFLICT clause after the rows — not the recognised seed shape",
    );
  }
  if (phase === "conflict") {
    throw new SeedShapeError("unterminated ON CONFLICT clause");
  }
  if (tuples.count === 0)
    throw new SeedShapeError("no tuples found between VALUES and ON CONFLICT");

  const head = header.join("\n");
  return {
    header: head,
    onConflict: conflict.join("\n"),
    tail: tail.join("\n").trim(),
    tupleCount: tuples.count,
    target: /INSERT INTO\s+((?:[a-z0-9_]+\.)?[a-z0-9_]+)/i.exec(head)?.[1] ?? null,
  };
}

/** First pass: everything but the rows. Validates every tuple on the way. */
export async function readSeedShape(chunks: AsyncIterable<string>): Promise<SeedShape> {
  return walk(chunks, () => {});
}

/**
 * Second pass: the statements, grouped up to `maxStatementBytes` each.
 *
 * A tuple larger than the budget on its own is still emitted, alone — a row
 * cannot be split, and whether the API takes it is the API's answer to give.
 *
 * With a `window`, only the statements from `window.skip` onward, up to
 * `window.maxHeldChars` of them, are built and handed over; `onPlan` reports
 * how many the seed has in all, before the first is handed over. Without one,
 * every statement is — which is the whole seed held at once, and is only
 * affordable for a seed a fraction of the size of the template library's. See
 * {@link StatementWindow}.
 */
export async function* chunkSeedStatements(
  chunks: AsyncIterable<string>,
  shape: SeedShape,
  opts: {
    maxStatementBytes: number;
    window?: StatementWindow;
    onPlan?: (plan: SeedPlan) => void;
  },
): AsyncGenerator<ChunkedStatement> {
  const skip = Math.max(0, opts.window?.skip ?? 0);
  const maxHeldChars = opts.window?.maxHeldChars ?? Number.POSITIVE_INFINITY;
  const overhead = byteLength(shape.header) + byteLength(shape.onConflict) + 2;
  // The same wrapper in code units: `header\n` + rows + `\n` + `onConflict`.
  const overheadChars = shape.header.length + shape.onConflict.length + 2;
  let group: string[] = [];
  let groupBytes = overhead;
  // Code units in the group's tuples plus the `,\n` between them.
  let groupChars = 0;
  let firstRow = 1;
  let rowsSeen = 0;
  // Statements met so far, held or not: the next one's position in the seed.
  let position = 0;
  let heldChars = 0;
  // Once a statement is turned away for size, nothing after it is held.
  let windowClosed = false;
  const ready: ChunkedStatement[] = [];

  /** Whether the statement at `position`, `chars` long, is one to build. */
  const admits = (chars: number): boolean => {
    if (position < skip || windowClosed) return false;
    if (ready.length === 0 || heldChars + chars <= maxHeldChars) return true;
    windowClosed = true;
    return false;
  };

  const flush = () => {
    if (group.length === 0) return;
    // Decided BEFORE the statement is built: building it to measure it is the
    // allocation the window exists to avoid.
    if (admits(overheadChars + groupChars)) {
      const sql = `${shape.header}\n${group.join(",\n")}\n${shape.onConflict}`;
      ready.push({
        label: `rows ${firstRow}-${firstRow + group.length - 1}`,
        sql,
        rows: group.length,
        bytes: byteLength(sql),
        index: position,
      });
      heldChars += sql.length;
    }
    position += 1;
    firstRow += group.length;
    group = [];
    groupBytes = overhead;
    groupChars = 0;
  };

  /*
    NOTHING IS HANDED OVER UNTIL THE SECOND READ HAS AGREED WITH THE FIRST, AND
    THAT IS WHY EVERY STATEMENT IS HELD.

    The comment that stood here said the statements were "queued and yielded
    between lines so the consumer sees each one as soon as it is whole", and
    that "the queue never holds more than one finished statement plus the group
    being filled". Both were false. `ready` is drained only after `await
    walking`, so the WHOLE file is read before the first statement is handed
    over — measured by effect on a 400-tuple fixture: 4,101 of 4,101 stream
    chunks consumed before statement 1 of 101 arrived.

    It is false in the safe direction, and the buffering is load-bearing rather
    than incidental. Every statement this yields is
    `remembered header + fresh tuples + remembered onConflict`, and the four
    comparisons below are what make that safe. Two of them CANNOT be made any
    earlier:

      * `onConflict` sits after the last tuple, so it is unknown until EOF.
      * `tail` sits after that.

    Yield a statement before EOF and it goes out under a conflict clause this
    pass has not yet checked. If the prime changed `DO UPDATE SET` to
    `DO NOTHING` between the two reads, rows are updated that the new body
    wanted left alone — and the next pass cannot repair it, because under the
    new clause it never writes those rows at all. That is a permanent wrong
    write, where holding the statements costs only memory.

    THE MEMORY IS REAL, AND THE FIGURE THAT STOOD HERE WAS WRONG BY HALF.

    `ready` grows to everything this call hands over, which `maxStatementBytes`
    bounds one statement of and not the queue. This comment said the queue was
    35 MB, measured on a 41,335,822-byte fixture "built to the real seed's
    shape" — and then corrected an earlier ~84 MB down to it, on the grounds
    that V8 stores an ASCII string at one byte a character. Both halves of that
    were true of the FIXTURE, which was ASCII. The real seed is not.

    Measured 26 Sep 2026 over the prime's own
    `20261207000000_seed_template_library_v16_verdict_and_running_head.sql`:
    45 statements, 44 of them carrying at least one character outside Latin-1
    (1,738 such characters in the file), and **86.7 MB of heap** held once the
    first statement is handed over. A statement is flattened from its tuples,
    and one em dash anywhere in it makes the whole string two bytes a
    character. So the first figure was the right one, for the reason it gave.

    And it was the demonstrated reading, not a possible one. With a 45-second
    budget a pass sent one statement and let go of the queue; the first passes
    allowed a second statement (90 seconds, 26 Sep 2026, #291) died sending it
    — five in a row, each within about 70–76 s, each an HTTP 502 with no audit
    row and the claim left set — while passes of up to 88 s that sent ONE
    statement had succeeded the same morning. Wall clock was not the limit.
    The isolate's memory was: the queue fitted beside one statement's request
    and response, and not beside two.

    So the queue is BOUNDED now rather than accepted: {@link StatementWindow}
    builds only the statements this pass may send, and they are handed over by
    shifting, so a sent statement is not held while the rest go. The EOF rule
    below is untouched — everything handed over is still held until the second
    read has agreed with the first; there is simply far less of it.

    Removing the queue altogether still needs `onConflict` and `tail` known
    BEFORE the streaming pass — a ranged read of the blob's last few kilobytes —
    which is an API `PrimeMigrationCorpus` does not have.

    `seedChunking.test.ts` pins both halves of this: nothing is yielded before
    EOF, and nothing is yielded before a disagreement throws. Do not
    "optimise" the queue away without reading them.
  */
  const walking = walk(chunks, (tuple) => {
    rowsSeen += 1;
    // The GROUPING is decided on bytes alone and never on the window, so a
    // position names the same statement on every pass whatever each pass
    // holds.
    const bytes = byteLength(tuple) + 2;
    if (group.length > 0 && groupBytes + bytes > opts.maxStatementBytes) flush();
    groupChars += (group.length > 0 ? 2 : 0) + tuple.length;
    group.push(tuple);
    groupBytes += bytes;
  });

  // EOF, and only now is anything known about the ON CONFLICT clause or the
  // tail. Every comparison below therefore runs before `ready` is drained.
  const finalShape = await walking;
  flush();

  if (finalShape.tupleCount !== shape.tupleCount || rowsSeen !== shape.tupleCount) {
    throw new SeedShapeError(
      `the second read found ${rowsSeen} tuples where the first found ${shape.tupleCount} — ` +
        "the blob changed between reads; refusing to send",
    );
  }
  if (finalShape.header !== shape.header || finalShape.onConflict !== shape.onConflict) {
    throw new SeedShapeError(
      "the second read's header or ON CONFLICT clause differs from the first — refusing to send",
    );
  }
  /*
    AND THE TAIL, WHICH IS THE ONE THIS CHECK USED TO MISS.

    The three comparisons above guard what the tuples are poured INTO. The
    tail is different in kind: it is executed verbatim, and it is taken from
    the REMEMBERED shape rather than the one just derived — so without this a
    file whose trailing statements changed, while its header, ON CONFLICT and
    tuple count did not, would run the old tail against the new tuples and
    then be recorded as applied.

    Not hypothetical on this corpus. The template seed's tail is an `UPDATE …
    SET status = 'published' … WHERE slug IN (…)` naming every slug one by
    one, so an edit that swaps one slug for another leaves all three of the
    other readings identical. Raised by review against the cross-pass shape,
    where the interval between the two readings stopped being microseconds
    and became however long a clone sits mid-seed.
  */
  if (finalShape.tail !== shape.tail) {
    throw new SeedShapeError(
      "the second read's trailing statements differ from the first — refusing to send",
    );
  }

  if (shape.tail) {
    // A statement like any other: it has a position, and it is held only
    // inside the window. It is the REMEMBERED tail, compared equal just above.
    if (admits(shape.tail.length)) {
      ready.push({
        label: "trailing statements",
        sql: shape.tail,
        rows: 0,
        bytes: byteLength(shape.tail),
        index: position,
      });
    }
    position += 1;
  }

  opts.onPlan?.({ total: position, held: ready.length });

  // Handed over by SHIFTING, so a statement already sent is not still held by
  // this queue while the ones after it go.
  while (ready.length > 0) yield ready.shift()!;
}

/**
 * The line a skeleton carries where the rows were.
 *
 * Named once because two readers depend on it: {@link seedSkeleton} writes it,
 * and `seedSkeletonManifest.pure.ts` checks a skeleton the PRIME published has
 * exactly one, after `VALUES` and before its `ON CONFLICT` clause — the prime
 * builds its skeletons with this join, ported character for character.
 */
export const SEED_ROWS_MARKER = "  (…)";

/**
 * The executable skeleton — every statement the data is poured into — for
 * the destructiveness gate. Rows are data and are not assessed as SQL.
 */
export function seedSkeleton(shape: SeedShape): string {
  return [shape.header, SEED_ROWS_MARKER, shape.onConflict, shape.tail].filter(Boolean).join("\n");
}
