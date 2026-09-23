/**
 * A version held back is a barrier, driven through the replay itself.
 *
 * `partitionByDependency` and `rescueScopedOrphans` each have tests of their
 * own. These run `applyPrimeMigrations` with a scope, against a Management API
 * that records every query, so what they assert is what a clone would have
 * been SENT — which neither stage's tests can see, because the defect lived
 * between them. The partition judged a refresh against the prime's holes
 * alone, found none it touched, and sent it, while the seed it reads back by
 * name stayed held behind one of those holes. The refresh then ran against a
 * library the seed never reached, refreshed nothing, and was recorded — so
 * nothing would ever run it again. See `fleetCorpusScope.pure.ts` ("And a
 * migration held back is a barrier too") and `migrationVersionMentions.pure.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations } from "./backend-provisioning.server";
import type { CorpusMeta } from "./fleetCorpusScope.pure";
import { dependencyFactsOf } from "./migrationDependencyFacts.pure";
import { mentionedVersionsOf } from "./migrationVersionMentions.pure";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { MAX_MIGRATION_BYTES } from "./prime-backend.server";
import { recordingManagementApi } from "./managementApiRecorder.test-support";

const REF = "abcdefghijklmnopqrst";

type File = { id: string; name: string; sql: string };

/** A migration the prime's ledger does not record: it creates the baselines table. */
const HOLE: File = {
  id: "20261201000000",
  name: "20261201000000_template_library_release_baselines.sql",
  sql: "create table public.template_library_release_baselines (entry_id int, release text);",
};
/** The seed: writes a baseline row per entry under its own release name. */
const SEED: File = {
  id: "20261204020000",
  name: "20261204020000_seed_template_library_v15.sql",
  sql: `insert into public.template_library_release_baselines (entry_id, release)
values (1, '20261204020000_seed_template_library_v15');`,
};
/**
 * The refresh: reads the seed's rows back BY THE SEED'S NAME. Abridged from
 * `20261204030000_refresh_active_masters_from_library_v15.sql`. It requires
 * nothing the hole creates — its read of the baselines table is a join, which
 * is not a form Postgres resolves at the statement — so only the name ties it
 * to the seed.
 */
const REFRESH: File = {
  id: "20261204030000",
  name: "20261204030000_refresh_active_masters_from_library_v15.sql",
  sql: `create table if not exists public.template_master_refresh_decisions (id int);
insert into public.template_master_refresh_decisions (id)
select rt.id
  from public.report_templates rt
  join public.template_library_release_baselines b
    on b.entry_id = rt.id
   and b.release = '20261204020000_seed_template_library_v15';`,
};
/** Unrelated to all three. */
const OTHER: File = {
  id: "20261205000000",
  name: "20261205000000_unrelated_things.sql",
  sql: "create table public.unrelated_things (id int);",
};

const CORPUS = [HOLE, SEED, REFRESH, OTHER];

/** The corpus row the fleet sync builds for a body it decoded: facts AND names. */
const decoded = (f: File): CorpusMeta => ({
  id: f.id,
  name: f.name,
  ...dependencyFactsOf(f.sql),
  mentions: mentionedVersionsOf(f.sql),
});
/** And for one it did not — the 41 MB seeds, past the digest pass's ceiling. */
const undecoded = (f: File): CorpusMeta => ({ id: f.id, name: f.name });
/** Metadata alone, as the scoped callers hand the replay its list. */
const meta = (f: File) => ({ id: f.id, name: f.name });

/** Bodies by file, as the fleet sync's loader serves them from GitHub. */
function loaderFor(opts: { oversize?: readonly File[] } = {}) {
  const tooLarge = new Set((opts.oversize ?? []).map((f) => f.name));
  const bodies = new Map(CORPUS.map((f) => [f.name, f.sql]));
  return vi.fn(async (m: { id: string; name: string }) => {
    if (tooLarge.has(m.name)) {
      throw new OversizedMigrationError(m.name, 41_600_000, MAX_MIGRATION_BYTES);
    }
    const sql = bodies.get(m.name);
    if (sql === undefined) throw new Error(`no body for ${m.name}`);
    return sql;
  });
}

function managementApi(opts?: Parameters<typeof recordingManagementApi>[0]) {
  const api = recordingManagementApi(opts);
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

const resultFor = (
  out: Awaited<ReturnType<typeof applyPrimeMigrations>>,
  f: File,
): (typeof out.results)[number] | undefined => out.results.find((r) => r.name === f.name);

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("applyPrimeMigrations — a refresh waits for the seed it names", () => {
  it("sends neither while the seed is held, sends what is unrelated, and names the hole behind both", async () => {
    const api = managementApi();
    const scope = {
      corpus: CORPUS.map(decoded),
      // The prime's ledger records everything but the hole.
      runnableIds: new Set([SEED.id, REFRESH.id, OTHER.id]),
    };

    const out = await applyPrimeMigrations(
      REF,
      [SEED, REFRESH, OTHER].map(meta),
      undefined,
      loaderFor(),
      scope,
    );

    expect(api.bodies()).toEqual([OTHER.sql]);
    expect(api.recorded()).toEqual([{ version: OTHER.id, name: OTHER.name }]);

    // The seed writes into the table the hole creates: held behind the hole.
    const seed = resultFor(out, SEED);
    expect(seed?.skipped).toBe(true);
    expect(seed?.blockedBy).toEqual([HOLE.id]);
    expect(seed?.waitsFor).toBeUndefined();

    // The refresh is held for the seed it names, and the hole that has to be
    // reconciled for either to move is the one it reports.
    const refresh = resultFor(out, REFRESH);
    expect(refresh?.skipped).toBe(true);
    expect(refresh?.blockedBy).toEqual([HOLE.id]);
    expect(refresh?.waitsFor).toEqual([SEED.id]);
    // A held version is never reported as the prime's ledger being short.
    expect(refresh?.blockedBy).not.toContain(SEED.id);
    expect(out.primeLedgerHoles).toEqual([HOLE.id]);

    const other = resultFor(out, OTHER);
    expect(other?.success).toBe(true);
    expect(other?.skipped ?? false).toBe(false);
  });

  it("holds everything after a seed nobody could read, rather than guessing what it creates", async () => {
    const api = managementApi();
    const loadSql = loaderFor({ oversize: [SEED] });
    const scope = {
      // The seed's body was never decoded, so its row carries no facts.
      corpus: [decoded(HOLE), undecoded(SEED), decoded(REFRESH), decoded(OTHER)],
      runnableIds: new Set([SEED.id, REFRESH.id, OTHER.id]),
    };

    const out = await applyPrimeMigrations(
      REF,
      [SEED, REFRESH, OTHER].map(meta),
      undefined,
      loadSql,
      scope,
    );

    // Fail-closed: an unread seed might create anything, so nothing after it
    // travels. Reading it — not assuming it — is what releases the rest.
    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    // The rescue asked for the seed's body and was refused it for its size.
    expect(loadSql.mock.calls.map(([m]) => m.name)).toContain(SEED.name);

    expect(resultFor(out, SEED)?.blockedBy).toEqual([HOLE.id]);
    for (const f of [REFRESH, OTHER]) {
      const r = resultFor(out, f);
      expect(r?.skipped, f.name).toBe(true);
      expect(r?.blockedBy, f.name).toEqual([HOLE.id]);
      expect(r?.waitsFor, f.name).toEqual([SEED.id]);
    }
  });

  it("waits for nothing when the version it names travels in the same pass", async () => {
    const api = managementApi();
    const scope = {
      corpus: [SEED, REFRESH].map(decoded),
      runnableIds: new Set([SEED.id, REFRESH.id]),
    };

    await applyPrimeMigrations(REF, [SEED, REFRESH].map(meta), undefined, loaderFor(), scope);

    expect(api.bodies()).toEqual([SEED.sql, REFRESH.sql]);
  });

  it("waits for nothing when the clone already has the version it names", async () => {
    const api = managementApi({ applied: [SEED.id], tables: 12 });
    const scope = {
      corpus: [SEED, REFRESH].map(decoded),
      runnableIds: new Set([SEED.id, REFRESH.id]),
    };

    await applyPrimeMigrations(REF, [SEED, REFRESH].map(meta), undefined, loaderFor(), scope);

    expect(api.bodies()).toEqual([REFRESH.sql]);
  });
});
