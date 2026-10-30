/**
 * A clone stamped from the prime is asked for the version the prime ran each
 * file as, driven through the replay itself.
 *
 * `stampMigrationLedgerFromPrime` gives a clone built by introspection the
 * PRIME's ledger: its versions, no bodies. A file Lovable applied on the prime
 * sits there under the moment Lovable applied it, not the version in its name,
 * so the replay asked the stamped ledger for the name's version, read the file
 * as missing, and sent it again. On the demo clone (30 Oct 2026) that was 594
 * versions, and the first one that was not idempotent blocked it:
 * `relation "investment_reports" already exists`. See `primeHoldings.pure.ts`.
 *
 * These run `applyPrimeMigrations` with a scope against a Management API that
 * records every query, so what they assert is what the clone was SENT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations } from "./backend-provisioning.server";
import type { CorpusMeta } from "./fleetCorpusScope.pure";
import { recordingManagementApi } from "./managementApiRecorder.test-support";

const REF = "abcdefghijklmnopqrst";

type File = { id: string; name: string; sql: string };

/** Recorded on the prime and the clone under its own version. */
const BASE: File = {
  id: "20250124160000",
  name: "20250124160000_prepare_extensions_schema.sql",
  sql: "create schema if not exists extensions;",
};
/** Lovable's: the prime records these bytes as `20250912050519`, not as this. */
const LOVABLE: File = {
  id: "20250912170521",
  name: "20250912170521_208618a7-d33a-4e4b-96c2-455f4efcf772.sql",
  sql: "create table public.investment_reports (id uuid primary key);",
};
const PRIME_VERSION_OF_LOVABLE = "20250912050519";
/** Run on the prime after the clone was built: genuinely owed. */
const LATER: File = {
  id: "20270209090000",
  name: "20270209090000_model_hub_retired_fallbacks_name_their_successors.sql",
  sql: "alter table public.investment_reports add column if not exists note text;",
};

const CORPUS = [BASE, LOVABLE, LATER];
const meta = (f: File): CorpusMeta => ({ id: f.id, name: f.name });
const loadSql = vi.fn(async (m: { name: string }) => {
  const f = CORPUS.find((c) => c.name === m.name);
  if (!f) throw new Error(`no body for ${m.name}`);
  return f.sql;
});

/** The scope the fleet sync builds: everything cleared, LOVABLE by its body. */
const scope = (primeHoldings?: Map<string, string[]>) => ({
  corpus: CORPUS.map(meta),
  runnableIds: new Set(CORPUS.map((f) => f.id)),
  ...(primeHoldings ? { primeHoldings } : {}),
});
const HOLDINGS = new Map([[LOVABLE.name, [PRIME_VERSION_OF_LOVABLE]]]);

function managementApi(applied: string[]) {
  const api = recordingManagementApi({ applied, tables: 600 });
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
  loadSql.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("applyPrimeMigrations — a stamped clone", () => {
  it("is sent only what the prime ran after it was built", async () => {
    // The stamp: the prime's versions, so Lovable's file is here as the prime's.
    const api = managementApi([BASE.id, PRIME_VERSION_OF_LOVABLE]);

    const out = await applyPrimeMigrations(
      REF,
      CORPUS.map(meta),
      undefined,
      loadSql,
      scope(HOLDINGS),
    );

    expect(api.bodies()).toEqual([LATER.sql]);
    expect(api.recorded()).toEqual([{ version: LATER.id, name: LATER.name }]);
    // Held, as a version the clone records is: never a candidate, so no result
    // says it was sent, failed, or waits behind anything.
    expect(out.results.filter((r) => r.name === LOVABLE.name)).toEqual([]);
    expect(out.primeLedgerHoles).toEqual([]);
    // Its body was never even fetched: held is decided before anything is sent.
    expect(loadSql.mock.calls.map(([m]) => m.name)).not.toContain(LOVABLE.name);
    // Nothing is written to say it ran here: the stamp already says so.
    expect(api.recorded().map((r) => r.version)).not.toContain(LOVABLE.id);
  });

  it("was sent the Lovable file again without the prime's holdings — the defect", async () => {
    const api = managementApi([BASE.id, PRIME_VERSION_OF_LOVABLE]);

    await applyPrimeMigrations(REF, CORPUS.map(meta), undefined, loadSql, scope());

    expect(api.bodies()).toEqual([LOVABLE.sql, LATER.sql]);
  });

  it("is still sent the file when its ledger does not record the prime's version", async () => {
    // A clone built before the prime ran those bytes is genuinely owed them.
    const api = managementApi([BASE.id]);

    await applyPrimeMigrations(REF, CORPUS.map(meta), undefined, loadSql, scope(HOLDINGS));

    expect(api.bodies()).toEqual([LOVABLE.sql, LATER.sql]);
  });
});
