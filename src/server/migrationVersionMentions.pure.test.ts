/**
 * Which migration versions a migration's SQL names.
 * See `migrationVersionMentions.pure.ts`.
 */
import { describe, expect, it } from "vitest";

import { mentionedVersionsOf } from "./migrationVersionMentions.pure";

const SEED = "20261204020000";

/** Abridged from `20261204030000_refresh_active_masters_from_library_v15.sql`. */
const REFRESH = `-- Refresh each tenant's active masters from the v15 library.
CREATE TABLE IF NOT EXISTS public.template_master_refresh_decisions (id uuid);
INSERT INTO public.template_master_refresh_decisions (id)
SELECT rt.id
  FROM public.report_templates rt
  JOIN public.template_library_release_baselines b
    ON b.entry_id = rt.entry_id
   AND b.release = '${SEED}_seed_template_library_v15_running_head_and_columns';`;

describe("mentionedVersionsOf", () => {
  it("reads the seed a refresh names in a string — which is where it keeps it", () => {
    expect(mentionedVersionsOf(REFRESH)).toEqual([SEED]);
  });

  it("reads a version named in a guard's message, inside a function body", () => {
    const guard = `DO $$ BEGIN
      IF to_regclass('public.agency_agreements') IS NULL THEN
        RAISE EXCEPTION '20260805150000 must run first';
      END IF;
    END $$;`;
    expect(mentionedVersionsOf(guard)).toEqual(["20260805150000"]);
  });

  it("does not read comments, where the corpus names other migrations in prose", () => {
    const prose = `-- 20260921100000 dropped these columns; this restores them.
/* See 20260719000000 for the original shape. */
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS shared_at timestamptz;`;
    expect(mentionedVersionsOf(prose)).toEqual([]);
  });

  it("de-duplicates and sorts, so two readings of one file agree", () => {
    const sql = `SELECT '20261207000000', '20261204020000', '20261207000000';`;
    expect(mentionedVersionsOf(sql)).toEqual(["20261204020000", "20261207000000"]);
  });

  it("reads exactly fourteen digits: a longer number is not a version", () => {
    expect(mentionedVersionsOf("SELECT 202612040200001, 9202612040200000;")).toEqual([]);
    expect(mentionedVersionsOf("SELECT 1234567890123;")).toEqual([]);
  });

  it("reads a version joined to its slug, as a release name spells it", () => {
    expect(mentionedVersionsOf(`SELECT '${SEED}_seed';`)).toEqual([SEED]);
  });

  it("keeps a file's own version — a seed spells its own release name", () => {
    const seedTail = `INSERT INTO public.template_library_release_baselines (entry_id, release)
SELECT entry_id, '${SEED}_seed_template_library_v15_running_head_and_columns'
  FROM public.template_library_entries;`;
    expect(mentionedVersionsOf(seedTail)).toEqual([SEED]);
  });

  it("names nothing in an empty body, or in something that is not text", () => {
    expect(mentionedVersionsOf("")).toEqual([]);
    expect(mentionedVersionsOf(undefined as unknown as string)).toEqual([]);
  });
});
