/**
 * A migration that writes a ledger, driven through the replay itself.
 *
 * Asserts what a clone is SENT: a file that would edit the clone's record of
 * what reached it is held before anything at its version goes, the one file
 * frozen as history still runs as it ran on the prime, and a streamed seed is
 * judged by the parts of it that EXECUTE. See `migrationLedgerWrites.pure.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations } from "./backend-provisioning.server";
import { recordingManagementApi } from "./managementApiRecorder.test-support";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { MAX_MIGRATION_BYTES } from "./prime-backend.server";

const REF = "abcdefghijklmnopqrst";

type File = { id: string; name: string; sql?: string };

const A: File = {
  id: "20260101000000",
  name: "20260101000000_alpha.sql",
  sql: "create table public.alpha (id int);",
};
const WRITER: File = {
  id: "20260102000000",
  name: "20260102000000_tidy_the_ledger.sql",
  sql:
    "drop index if exists public.idx_alpha;\n" +
    "delete from supabase_migrations.schema_migrations where version = '20260101000000';",
};
const C: File = {
  id: "20260103000000",
  name: "20260103000000_charlie.sql",
  sql: "create table public.charlie (id int);",
};

/** The recording API, installed as `fetch` for this test. */
function managementApi(opts?: Parameters<typeof recordingManagementApi>[0]) {
  const api = recordingManagementApi(opts);
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("applyPrimeMigrations — a file that writes a ledger is held", () => {
  it("holds it before it is sent, records nothing for it, and halts", async () => {
    const api = managementApi();

    const out = await applyPrimeMigrations(REF, [A, WRITER, C]);

    expect(api.bodies()).toEqual([A.sql]);
    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    const held = out.results.find((r) => r.heldByRule);
    expect(held?.name).toBe(WRITER.name);
    expect(held?.success).toBe(false);
    expect(held?.heldByRule?.rule).toBe("ledger_write");
    expect(held?.heldByRule?.detail).toContain(`${WRITER.name} writes a migration ledger`);
    expect(held?.heldByRule?.detail).toContain("delete from supabase_migrations.");
    // Halted: the version after it would run against a schema missing it.
    expect(out.results.some((r) => r.name === C.name)).toBe(false);
    expect(out.latestApplied).toBe(A.id);
  });

  it("reads a body the loader supplies, exactly as one carried inline", async () => {
    const api = managementApi();
    const loadSql = vi.fn(async () => WRITER.sql as string);

    const out = await applyPrimeMigrations(
      REF,
      [{ id: WRITER.id, name: WRITER.name }],
      undefined,
      loadSql,
    );

    expect(loadSql).toHaveBeenCalledTimes(1);
    expect(api.bodies()).toEqual([]);
    expect(out.results[0].heldByRule?.rule).toBe("ledger_write");
  });

  it("holds a whole shared version when one of its files writes a ledger", async () => {
    const api = managementApi();
    const sibling: File = {
      id: WRITER.id,
      name: "20260102000000_a_harmless_sibling.sql",
      sql: "create table public.sibling (id int);",
    };

    const out = await applyPrimeMigrations(REF, [sibling, WRITER]);

    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    const held = out.results.find((r) => r.heldByRule);
    expect(held?.heldByRule?.rule).toBe("ledger_write");
    expect(held?.heldByRule?.detail).toContain(
      `Nothing at version ${WRITER.id} was sent (${sibling.name}, ${WRITER.name} share it).`,
    );
    expect(held?.sharedVersion).toEqual([sibling.name, WRITER.name]);
  });

  it("still runs the one file frozen as history, as the prime ran it, in a replay from nothing", async () => {
    const frozen: File = {
      id: "20260921100000",
      name: "20260921100000_withdraw_builder_aml_partner_portal_changes.sql",
      sql:
        "DROP FUNCTION IF EXISTS public.builder_accept_current_terms(uuid, uuid, text, text, jsonb);\n" +
        "DELETE FROM supabase_migrations.schema_migrations\n" +
        " WHERE version IN ('20260719000000','20260728120000');",
    };
    const api = managementApi();

    const out = await applyPrimeMigrations(REF, [frozen]);

    expect(api.bodies()).toEqual([frozen.sql]);
    expect(api.recorded()).toEqual([{ version: frozen.id, name: frozen.name }]);
    expect(out.results[0].success).toBe(true);
  });
});

describe("applyPrimeMigrations — a streamed seed is judged by what it executes", () => {
  const SEED: File = {
    id: "20260104000000",
    name: "20260104000000_seed_library.sql",
  };

  /** A body in the seed shape the chunking lane recognises. */
  const seedBody = (rows: string[], tail: string) =>
    [
      "INSERT INTO public.template_library_entries (entry_id, body)",
      "VALUES",
      ...rows.flatMap((row, i) => ["  (", `    ${row}`, i === rows.length - 1 ? "  )" : "  ),"]),
      "ON CONFLICT (entry_id) DO NOTHING;",
      tail,
    ].join("\n");

  function replaySeed(body: string) {
    const streamSql = vi.fn(async () =>
      (async function* () {
        yield body;
      })(),
    );
    const loadSql = vi.fn(async () => {
      throw new OversizedMigrationError(SEED.name, 41_600_000, MAX_MIGRATION_BYTES);
    });
    return {
      streamSql,
      run: () =>
        applyPrimeMigrations(
          REF,
          [{ id: SEED.id, name: SEED.name }],
          undefined,
          loadSql,
          undefined,
          undefined,
          { streamSql },
        ),
    };
  }

  it("holds a seed whose trailing statements write a ledger, before its first statement goes", async () => {
    const api = managementApi();
    const seed = replaySeed(
      seedBody(
        ["'a', 'x'", "'b', 'y'"],
        "DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260101000000';",
      ),
    );

    const out = await seed.run();

    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    // One read for the shape; the second, which sends, never began.
    expect(seed.streamSql).toHaveBeenCalledTimes(1);
    expect(out.results[0].heldByRule?.rule).toBe("ledger_write");
    expect(out.results[0].heldByRule?.detail).toContain(`${SEED.name} writes a migration ledger`);
    expect(out.chunksApplied).toBe(0);
  });

  it("sends a seed whose ROWS spell a ledger write: a value being inserted is not a statement", async () => {
    const api = managementApi();
    const seed = replaySeed(
      seedBody(
        ["'a', 'delete from supabase_migrations.schema_migrations'", "'b', 'y'"],
        "UPDATE public.report_templates SET page_plan = page_plan;",
      ),
    );

    const out = await seed.run();

    expect(out.results[0].success).toBe(true);
    expect(out.results[0].heldByRule).toBeUndefined();
    expect(
      api.bodies().some((q) => q.startsWith("INSERT INTO public.template_library_entries")),
    ).toBe(true);
    expect(api.bodies()).toContain("UPDATE public.report_templates SET page_plan = page_plan;");
    expect(api.recorded()).toEqual([{ version: SEED.id, name: SEED.name }]);
  });
});
