-- @asserts none:adds a UNIQUE constraint on two existing columns; no table, column, function, cron job or row is created, and pg_constraint is not observable through PostgREST
--
-- A module's library versions are numbered once each (docs/DELIVERY_SYSTEM_PLAN.md,
-- D19; Codex on aurixa-mission-control#388).
--
-- Publication numbers an entry one past the slug's highest version, read just
-- before the insert. Two publications of the same module that read the same
-- version each wrote it: nothing in the schema stopped a second v6 beside the
-- first, and each then cleared the other's latest flag, so the slug read as
-- having no latest entry and dropped out of the library's latest view and the
-- re-ingest's pin re-pointing.
--
-- Measured 28 Oct 2026, read only, before this migration: module_library holds
-- 134 entries, no (slug, version) pair twice, no slug with two latest entries
-- and none with no latest entry. Its only constraints are the primary key and
-- module_library_approval_status_check.
--
-- With this constraint the later of two such inserts fails with 23505, and
-- publication refuses that module by name, saying another publication wrote
-- the version first. The supersede that follows a written entry now clears
-- only lower versions, so a publication that numbered itself after this one
-- is never cleared by it.
--
-- Re-runnable: the constraint is added only if it is not there.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_library_slug_version_key'
      AND conrelid = 'public.module_library'::regclass
  ) THEN
    ALTER TABLE public.module_library
      ADD CONSTRAINT module_library_slug_version_key UNIQUE (slug, version);
  END IF;
END $$;
