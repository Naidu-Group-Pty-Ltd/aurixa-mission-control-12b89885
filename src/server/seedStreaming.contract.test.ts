/**
 * A migration too big to hold is streamed and chunked, never failed and
 * never held in memory.
 *
 * The template-library seed is one 39 MB INSERT. `openPrimeMigrationCorpus`
 * refuses it at the 8 MB ceiling — correctly, because this isolate cannot hold
 * it — and the fleet sync withheld it for as long as the prime's own ledger
 * did not record it. The moment the prime recorded it (2 Sep 2026, 13:56 UTC,
 * by hand through the prime's apply-migration workflow) the lane would have
 * parked every run as "unreadable" and an approved run would have halted on
 * the same throw, with every later migration held back behind it on every
 * clone. These pin the shape of the alternative.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const corpus = readFileSync("src/server/prime-backend.server.ts", "utf8");
const replay = readFileSync("src/server/backend-provisioning.server.ts", "utf8");
const lane = readFileSync("src/server/self-healing.server.ts", "utf8");

function sliceFrom(src: string, anchor: string, length = 6_000): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  return src.slice(at, at + length);
}

describe("the corpus streams a body it will not hold", () => {
  it("opens the blob with the raw media type, not getBlob", () => {
    const fn = sliceFrom(corpus, "async function fetchBlobTextStream", 2_500);
    expect(fn).toContain('Accept: "application/vnd.github.raw+json"');
    expect(fn).toContain("pipeThrough(new TextDecoderStream())");
    expect(fn).not.toContain("git.getBlob");
  });

  it("exposes the stream beside loadSql, with no ceiling and no cache", () => {
    const at = corpus.indexOf("const openSqlStream = async (id: string)");
    expect(at).toBeGreaterThan(-1);
    const open = corpus.slice(at, corpus.indexOf("};", at));
    expect(open).not.toContain("maxBytes");
    expect(open).not.toContain("cache.");
    expect(corpus).toMatch(/loadSql,\s*openSqlStream,\s*\};/);
  });

  it("the ceiling throws the class the replay and the gate catch", () => {
    expect(corpus).toContain("return new OversizedMigrationError(name, bytes, maxBytes);");
  });
});

describe("the replay chunks an oversized seed", () => {
  // Sized to the whole iteration rather than a magic length: this window has
  // already gone stale once, when a comment pushed the ledger insert past it
  // and a live rule reported as broken.
  const loop = (() => {
    const at = replay.indexOf("let sentInChunks = false;");
    expect(at, "anchor not found: let sentInChunks = false;").toBeGreaterThan(-1);
    const end = replay.indexOf("slowestMs = Math.max(slowestMs", at);
    expect(end, "end anchor not found").toBeGreaterThan(at);
    return replay.slice(at, end);
  })();

  it("falls back only for that error, and only when told how", () => {
    // Three outcomes, and the middle one is the fix of 4 Sep 2026. Anything
    // that is NOT an oversize refusal rethrows. An oversize refusal with no
    // streaming option is HELD — reported, halting, and never a failure that
    // moves the clone. With the option it chunks.
    expect(loop).toMatch(/if \(!\(e instanceof OversizedMigrationError\)\) throw e;/);
    expect(loop).toMatch(/if \(!oversize\) \{/);
    expect(loop).toMatch(/heldOversize: true/);
    expect(loop).toContain("applyChunkedSeed(projectRef, m, oversize, budget)");
  });

  it("a held body is never reported as a failed migration", () => {
    // The whole point of the split: `success: false` alone is what the fleet
    // sync read as "this clone rejected something", and it ejected a healthy
    // clone from the fleet for a day on the strength of it.
    const held = loop.slice(loop.indexOf("if (!oversize) {"), loop.indexOf("break;"));
    expect(held).toContain("heldOversize: true");
    expect(held).not.toContain("throw ");
  });

  it("records the ledger only after every statement has gone", () => {
    // A budgeted pass that stopped inside the seed breaks out BEFORE the
    // ledger insert; a completed chunked send falls through to it.
    expect(loop).toMatch(
      /if \(chunked\.stoppedEarly\) \{\s*chunkCursor = chunked\.cursor;\s*stoppedEarly = true;\s*break;/,
    );
    expect(loop.indexOf("sentInChunks = true;")).toBeLessThan(
      loop.indexOf("insert into supabase_migrations.schema_migrations"),
    );
  });

  it("sends at least one statement a pass and resumes from the cursor", () => {
    const fn = sliceFrom(replay, "async function applyChunkedSeed", 3_000);
    expect(fn).toContain(
      "const skip = oversize.cursor?.migrationId === m.id ? oversize.cursor.statementsDone : 0;",
    );
    expect(fn).toMatch(/if \(applied > 0 && budget\?\.isPastDeadline\(slowestMs\)\)/);
    expect(fn).toContain("cursor: { migrationId: m.id, statementsDone: index }");
  });

  it("names the manual remedy for a large file that is not the seed shape", () => {
    const fn = sliceFrom(replay, "async function applyChunkedSeed", 3_000);
    expect(fn).toMatch(/e instanceof SeedShapeError[\s\S]{0,400}Apply it to this clone by hand/);
  });

  it("keeps the statement budget in bytes, under the API's limit", () => {
    const m = /export const DEFAULT_SEED_STATEMENT_BYTES = ([\d_]+);/.exec(replay);
    expect(m).not.toBeNull();
    const bytes = Number(m![1].replace(/_/g, ""));
    expect(bytes).toBeGreaterThanOrEqual(500_000);
    expect(bytes).toBeLessThanOrEqual(2_000_000);
  });
});

describe("the lane", () => {
  it("assesses the seed's skeleton instead of parking it as unreadable", () => {
    const gate = sliceFrom(lane, "async function assessPendingMigrations", 2_500);
    expect(gate).toMatch(
      /if \(!\(e instanceof OversizedMigrationError\) \|\| !openSqlStream\) throw e;/,
    );
    expect(gate).toContain("sql = seedSkeleton(await readSeedShape(await openSqlStream(m.id)));");
    expect(lane).toContain(
      "assessPendingMigrations(pending, corpus.loadSql, corpus.openSqlStream)",
    );
  });

  it("hands the replay the stream, the cursor and a heartbeat that carries it", () => {
    const call = sliceFrom(lane, "streamSql: (m) => corpus.openSqlStream(m.id),", 900);
    expect(call).toContain("run.result?.chunk_cursor");
    expect(call).toMatch(
      /chunk_cursor: \{ migrationId: p\.migrationId, statementsDone: p\.statementsDone \}/,
    );
  });

  it("carries the cursor across a requeue, or the next pass re-sends everything", () => {
    const requeue = sliceFrom(lane, 'status: "planned",', 900);
    expect(requeue).toContain("chunk_cursor: chunkCursor,");
  });
});
