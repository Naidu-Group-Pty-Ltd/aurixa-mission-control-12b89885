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

/**
 * The whole of a top-level function, ended at its own closing brace rather
 * than at a byte count.
 *
 * A fixed length is a silent measurement: this file already asserted nothing
 * twice for that reason — once on an unanchored `indexOf("break;")` that found
 * a later statement's, and once here, where a comment added inside the guard
 * pushed `pipeThrough` past a 2,500-byte window and turned a passing assertion
 * into a failing one about the wrong thing. A function that grows is not a
 * function that changed.
 */
function sliceFunction(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  expect(end, `no closing brace for: ${anchor}`).toBeGreaterThan(at);
  return src.slice(at, end + 3);
}

describe("the corpus streams a body it will not hold", () => {
  it("opens the blob with the raw media type, not getBlob", () => {
    const fn = sliceFunction(corpus, "async function fetchBlobTextStream");
    // The MEDIA TYPE is the rule — it is what makes the bytes arrive as a
    // stream rather than base64 inside a JSON document. How the header map is
    // spelled is not: it moved into `githubApiHeaders` when that call site was
    // found to be missing `User-Agent`, and an assertion on the old spelling
    // would have opposed the fix rather than the regression.
    expect(fn).toContain("application/vnd.github.raw+json");
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
    // Anchored FROM the oversize branch, not from the top of the loop. There
    // is now an earlier `break;` above it — the upstream-quota hold added 19
    // Sep 2026 — and an unanchored search found that one, so this slice ran
    // backwards and silently asserted nothing.
    const at = loop.indexOf("if (!oversize) {");
    const held = loop.slice(at, loop.indexOf("break;", at));
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
    const fn = sliceFunction(replay, "async function applyChunkedSeed");
    /*
      Gated on `cursorIsForThisBody`, which asks the migration id AND the body's
      own sha — a position is only a position in the body it was taken in, and
      the shape cannot tell a re-released body from the one the position came
      from. The rule itself lives in `chunkCursorStore.pure.ts` and is tested
      behaviourally there; what matters here is that the skip reads it.
    */
    expect(fn).toContain(
      "const skip = cursorIsForThisBody ? (oversize.cursor?.statementsDone ?? 0) : 0;",
    );
    expect(fn).toContain("cursorAppliesToBody(oversize.cursor, m.id, bodySha)");
    expect(fn).toMatch(/if \(applied > 0 && budget\?\.isPastDeadline\(slowestMs\)\)/);
    // The budget pause's cursor, field by field: it also carries the body's own
    // identity now, so a literal would read as this rule breaking when what
    // changed is that the cursor says which release it is a position into.
    expect(fn).toMatch(
      /cursor: \{ migrationId: m\.id, statementsDone: index, shape, \.\.\.identityOf\(\) \}/,
    );
  });

  it("reads the body ONCE on a pass that already knows the shape", () => {
    /*
      `readSeedShape` is `walk(chunks, () => {})` — a full walk of the file
      that discards every tuple — and `chunkSeedStatements` then walks it
      again. On the 41,671,969-byte template seed that is ~80 MB of blob
      traffic to buy one bounded group of statements inside a 45-second
      budget. Measured 19 Sep 2026: `npc-test-76b3b3` completed a pass having
      advanced ZERO statements.

      A cursor naming THIS migration and carrying a shape is that first
      reading, taken by an earlier pass. `??=` is what makes the read
      conditional; spelling it as an unconditional `await readSeedShape(...)`
      would restore the double walk while every other assertion here still
      passed.
    */
    const fn = sliceFunction(replay, "async function applyChunkedSeed");
    // Read through the same predicate as the skip: two spellings of "is this
    // cursor this body's?" is how one of them comes to say yes where the other
    // says no — a pass that skips a prefix whose shape it then re-reads, or the
    // reverse.
    expect(fn).toMatch(
      /const cursorShape =\s*cursorIsForThisBody \? \(oversize\.cursor\?\.shape \?\? null\) : null;/,
    );
    expect(fn).toContain("shape ??= await readSeedShape(await oversize.streamSql(m));");
    // Exactly one unconditional stream for the statements, and no second
    // unconditional one for the shape.
    expect(fn).toContain("chunkSeedStatements(await oversize.streamSql(m), shape, {");
    expect(fn).not.toMatch(/const shape = await readSeedShape\(/);
  });

  it("names the manual remedy for a large file that is not the seed shape", () => {
    const fn = sliceFunction(replay, "async function applyChunkedSeed");
    expect(fn).toMatch(/e instanceof SeedShapeError[\s\S]*?Apply it to this clone by hand/);
  });

  it("does not demand a hand-apply when the seed merely changed upstream", () => {
    // A mismatch against a shape read in THIS pass means the file is not
    // seed-shaped. A mismatch against one taken off the cursor means the
    // prime re-released the seed between passes — the file is fine, the
    // recorded position was cut from a body that no longer exists, and the
    // answer is to drop the cursor and start again rather than to ask a
    // person to apply 41 MB by hand.
    const fn = sliceFunction(replay, "async function applyChunkedSeed");
    expect(fn).toMatch(/if \(cursorShape\) \{[\s\S]*?cursor: null/);
    expect(fn).toMatch(/changed on the prime since the last pass/);
  });

  it("discards the stored cursor on exactly ONE path, and it is that one", () => {
    /*
      Audited path by path, because "which refusals leave a cursor that can
      never match again?" is a question a reader has to be able to answer:

        * budget pause — the cursor it writes is fresh. Nothing to discard.
        * SeedShapeError WITH a cursor shape — the stored position was cut from
          a body that no longer exists and the stale shape would make the next
          pass hit the same mismatch for ever. This is the one that discards.
        * SeedShapeError WITHOUT one — the file is not seed-shaped and a person
          has to act. Any stored cursor is inert rather than harmful, because
          the body identity refuses it and `skip` is 0.
        * the prime's body went unreadable — the cursor is KEPT deliberately,
          so the statements that landed are not re-sent.
        * an unrecognised error — rethrown, cursor untouched, still valid.
        * a cursor past the end — reset to 0 rather than discarded, because the
          file is fine and the position is not.
        * completion — `cursor: null`, and the caller clears it because its own
          file landed.

      One site, and a second appearing is a finding rather than a refactor.
    */
    const fn = sliceFunction(replay, "async function applyChunkedSeed");
    const sites = fn.match(/cursorDiscarded: true/g) ?? [];
    expect(sites).toHaveLength(1);
    const at = fn.indexOf("cursorDiscarded: true");
    const branch = fn.lastIndexOf("if (cursorShape) {", at);
    expect(branch, "the discard is not inside the cursor-shape branch").toBeGreaterThan(-1);
    // And the caller has to carry it out, or the flag is a value nobody reads.
    expect(replay).toMatch(/chunked\.cursorDiscarded[\s\S]{0,80}?chunkCursorDiscarded = true/);
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
    expect(call).toMatch(/chunk_cursor: \{[\s\S]{0,200}?migrationId: p\.migrationId/);
    expect(call).toMatch(/chunk_cursor: \{[\s\S]{0,200}?statementsDone: p\.statementsDone/);
    // And the shape, so the next pass reads the body once rather than twice.
    expect(call).toMatch(/chunk_cursor: \{[\s\S]{0,200}?shape: p\.shape/);
  });

  it("carries the cursor across a requeue, or the next pass re-sends everything", () => {
    // Anchored on the migration lane's OWN requeue result rather than on
    // `status: "planned"`, which the file writes five times — the deferral
    // path, the generic error path and three lanes — so a first-occurrence
    // anchor tested whichever one happened to be written earliest.
    const requeue = sliceFrom(lane, "applied_this_pass: landed,", 900);
    expect(requeue).toContain("chunk_cursor: chunkCursor,");
  });
});
