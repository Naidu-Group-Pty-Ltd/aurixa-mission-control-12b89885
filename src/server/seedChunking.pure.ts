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
};

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

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
 */
export async function* chunkSeedStatements(
  chunks: AsyncIterable<string>,
  shape: SeedShape,
  opts: { maxStatementBytes: number },
): AsyncGenerator<ChunkedStatement> {
  const overhead = byteLength(shape.header) + byteLength(shape.onConflict) + 2;
  let group: string[] = [];
  let groupBytes = overhead;
  let firstRow = 1;
  let rowsSeen = 0;
  const ready: ChunkedStatement[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const sql = `${shape.header}\n${group.join(",\n")}\n${shape.onConflict}`;
    ready.push({
      label: `rows ${firstRow}-${firstRow + group.length - 1}`,
      sql,
      rows: group.length,
      bytes: byteLength(sql),
    });
    firstRow += group.length;
    group = [];
    groupBytes = overhead;
  };

  // `walk` is pull-based on the stream and push-based on tuples; the
  // statements it completes are queued and yielded between lines so the
  // consumer sees each one as soon as it is whole. The queue never holds more
  // than one finished statement plus the group being filled.
  const walking = walk(chunks, (tuple) => {
    rowsSeen += 1;
    const bytes = byteLength(tuple) + 2;
    if (group.length > 0 && groupBytes + bytes > opts.maxStatementBytes) flush();
    group.push(tuple);
    groupBytes += bytes;
  });

  // Yield as statements complete. `walk` runs to completion here; the queue
  // is drained after it, which keeps this simple and still bounded because a
  // statement is at most `maxStatementBytes` and the group at most one more.
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

  for (const s of ready) yield s;
  if (shape.tail) {
    yield { label: "trailing statements", sql: shape.tail, rows: 0, bytes: byteLength(shape.tail) };
  }
}

/**
 * The executable skeleton — every statement the data is poured into — for
 * the destructiveness gate. Rows are data and are not assessed as SQL.
 */
export function seedSkeleton(shape: SeedShape): string {
  return [shape.header, "  (…)", shape.onConflict, shape.tail].filter(Boolean).join("\n");
}
