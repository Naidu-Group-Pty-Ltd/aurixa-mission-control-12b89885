/**
 * A seed sent a WINDOW at a time, driven through the replay itself.
 *
 * Asserts what a clone is SENT across passes that each hold only part of the
 * seed: every statement exactly once and in order, a pause — never a
 * completion — whenever a pass runs out of what it holds with more of the seed
 * to go, and the ledger row only after the last statement. See
 * `StatementWindow` in `seedChunking.pure.ts` for why a pass may not hold the
 * whole seed: on the real one, that measured 86.7 MB and killed the isolate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations, type ChunkCursor } from "./backend-provisioning.server";
import { recordingManagementApi } from "./managementApiRecorder.test-support";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { MAX_MIGRATION_BYTES } from "./prime-backend.server";
import { chunkSeedStatements, readSeedShape } from "./seedChunking.pure";

const REF = "abcdefghijklmnopqrst";
const SEED = { id: "20261207000000", name: "20261207000000_seed_template_library_v16.sql" };
const BODY_SHA = "93d14853d7b8672e7ffc823bd0a6a7538cd0230a";
const STATEMENT_BYTES = 300;

/** A body in the seed shape, an em dash in every row — two-byte, as the real seed is. */
const BODY = [
  "INSERT INTO public.template_library_entries (slug, schema)",
  "VALUES",
  ...Array.from({ length: 14 }, (_, i) => [
    "  (",
    `    $tlt$entry-${i}$tlt$, ` +
      "$tlj$" +
      `{"title": "Entry ${i} — seeded", "pad": "${"q".repeat(30 + i * 9)}"}` +
      "$tlj$::jsonb",
    i === 13 ? "  )" : "  ),",
  ]).flat(),
  "ON CONFLICT (slug) DO UPDATE SET schema = EXCLUDED.schema;",
  "UPDATE public.template_library_entries SET status = 'published' WHERE slug LIKE 'entry-%';",
].join("\n");

async function* once(text: string): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += 97) yield text.slice(i, i + 97);
}

/** Every statement of the seed, as one unwindowed walk produces them. */
async function everyStatement(): Promise<string[]> {
  const shape = await readSeedShape(once(BODY));
  const out: string[] = [];
  for await (const st of chunkSeedStatements(once(BODY), shape, {
    maxStatementBytes: STATEMENT_BYTES,
  }))
    out.push(st.sql);
  return out;
}

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** One pass: a fresh Management API, the stored cursor, and a hold of `maxHeldChars`. */
async function pass(cursor: ChunkCursor | null, maxHeldChars: number) {
  const api = recordingManagementApi();
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  const progress: number[] = [];
  const out = await applyPrimeMigrations(
    REF,
    [{ id: SEED.id, name: SEED.name }],
    undefined,
    async () => {
      throw new OversizedMigrationError(SEED.name, 41_780_944, MAX_MIGRATION_BYTES);
    },
    undefined,
    undefined,
    {
      streamSql: async () => once(BODY),
      bodyIdentity: () => BODY_SHA,
      maxStatementBytes: STATEMENT_BYTES,
      maxHeldChars,
      cursor,
      onStatementDone: async (p) => {
        progress.push(p.statementsDone);
      },
    },
  );
  vi.unstubAllGlobals();
  return { out, api, progress };
}

/**
 * One press of a caller that records no progress — the per-clone sync button's
 * shape: a stream and an identity, and no cursor and no `onStatementDone`.
 */
async function pressWithoutProgress(maxHeldChars: number) {
  const api = recordingManagementApi();
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  const out = await applyPrimeMigrations(
    REF,
    [{ id: SEED.id, name: SEED.name }],
    undefined,
    async () => {
      throw new OversizedMigrationError(SEED.name, 41_780_944, MAX_MIGRATION_BYTES);
    },
    undefined,
    undefined,
    {
      streamSql: async () => once(BODY),
      bodyIdentity: () => BODY_SHA,
      maxStatementBytes: STATEMENT_BYTES,
      maxHeldChars,
    },
  );
  vi.unstubAllGlobals();
  return { out, api };
}

describe("applyPrimeMigrations — a caller that cannot resume", () => {
  it("is handed nothing of a seed one window cannot hold to the end, and holds it", async () => {
    // Raised by review on #292. Sending the first window and returning a pause
    // to a caller that drops the cursor is a truncation: part of the seed
    // lands, the migration is neither a success nor a failure in its results,
    // "up to date" is reported, and the next press starts from statement 0.
    const { out, api } = await pressWithoutProgress(1);
    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    expect(out.stoppedEarly).toBe(false);
    expect(out.chunkCursor).toBeNull();
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: SEED.id, success: false, heldOversize: true });
    expect(out.results[0].error).toMatch(/nothing of it was sent/);
  });

  it("still sends — and records — a seed its window holds to the end", async () => {
    const all = await everyStatement();
    const { out, api } = await pressWithoutProgress(Number.POSITIVE_INFINITY);
    expect(api.bodies()).toEqual(all);
    expect(out.results[0].success).toBe(true);
    expect(api.recorded()).toEqual([{ version: SEED.id, name: SEED.name }]);
  });
});

describe("applyPrimeMigrations — a seed sent a window at a time", () => {
  it("sends every statement exactly once, in order, across passes that each hold a few", async () => {
    const all = await everyStatement();
    expect(all.length, "the fixture must need several passes").toBeGreaterThan(6);
    // About two statements a pass: the cap is sized off the fixture's own
    // statements rather than a constant, so it keeps meaning "a few".
    const cap = Math.max(...all.map((sql) => sql.length)) * 2;

    const sent: string[] = [];
    let cursor: ChunkCursor | null = null;
    let passes = 0;
    for (;;) {
      passes += 1;
      expect(passes, "the seed never finished").toBeLessThan(all.length + 2);
      const { out, api, progress } = await pass(cursor, cap);
      const bodies = api.bodies();
      sent.push(...bodies);
      // Progress is reported per statement, as positions in the WHOLE seed.
      const from = cursor?.statementsDone ?? 0;
      expect(progress).toEqual(bodies.map((_, i) => from + i + 1));
      if (out.stoppedEarly) {
        // A window that ran out is a pause: nothing recorded, and a cursor at
        // the next statement, carrying the body it is a position into.
        expect(api.recorded(), `pass ${passes} recorded a seed it had not finished`).toEqual([]);
        expect(out.chunkCursor).toMatchObject({
          migrationId: SEED.id,
          statementsDone: from + bodies.length,
          bodySha: BODY_SHA,
        });
        expect(out.chunkCursor?.shape, "the shape rides the cursor").toBeTruthy();
        cursor = out.chunkCursor;
        continue;
      }
      // The pass that sends the last statement is the one that records it.
      expect(out.results[0].success).toBe(true);
      expect(api.recorded()).toEqual([{ version: SEED.id, name: SEED.name }]);
      break;
    }

    expect(sent).toEqual(all);
    expect(passes).toBeGreaterThan(2);
  });

  it("records nothing, and pauses, when a window ends exactly one statement short", async () => {
    const all = await everyStatement();
    // Resume at the second-to-last statement with room for exactly one: the
    // pass sends it, and must not read the end of its window as the end of the
    // seed — the trailing statements are still to go.
    const penultimate = all.length - 2;
    const shape = await readSeedShape(once(BODY));
    const { out, api } = await pass(
      { migrationId: SEED.id, statementsDone: penultimate, shape, bodySha: BODY_SHA },
      1,
    );
    expect(api.bodies()).toEqual([all[penultimate]]);
    expect(api.recorded()).toEqual([]);
    expect(out.stoppedEarly).toBe(true);
    expect(out.chunkCursor?.statementsDone).toBe(all.length - 1);
  });

  it("records the seed, sending nothing, when a pass died after its last statement", async () => {
    const all = await everyStatement();
    const shape = await readSeedShape(once(BODY));
    const { out, api } = await pass(
      { migrationId: SEED.id, statementsDone: all.length, shape, bodySha: BODY_SHA },
      1,
    );
    expect(api.bodies()).toEqual([]);
    expect(out.stoppedEarly).toBe(false);
    expect(api.recorded()).toEqual([{ version: SEED.id, name: SEED.name }]);
  });

  it("resets a cursor past the end to zero rather than recording the seed", async () => {
    const all = await everyStatement();
    const shape = await readSeedShape(once(BODY));
    const { out, api } = await pass(
      { migrationId: SEED.id, statementsDone: all.length + 5, shape, bodySha: BODY_SHA },
      Number.POSITIVE_INFINITY,
    );
    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    expect(out.stoppedEarly).toBe(true);
    expect(out.chunkCursor?.statementsDone).toBe(0);
  });
});
