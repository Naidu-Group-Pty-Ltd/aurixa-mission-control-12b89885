-- @asserts column:module_detection_runs.commit_sha
-- @asserts column:module_library.source_commit_sha
--
-- A library entry records the prime commit it was approved at
-- (docs/DELIVERY_SYSTEM_PLAN.md, D19).
--
-- Measured 28 Oct 2026, read only, before this migration:
--
--   * `module_library` holds 134 entries. Every one is `approval_status =
--     'pending'` and `is_latest`, all were published on 31 Jul 2026, and none
--     records a commit, in a column or in `metadata`.
--   * `clone_library_pins` holds no row. A pin needs an approved entry
--     (`setCloneLibraryPin`, `bulkApplyClonePins`), and none is approved.
--   * The last detection run completed on 31 Jul (feature-first, 4,637 files,
--     369 edge functions). A run stores `tree_hash`, a hash Mission Control
--     computes over the file list it read, and not the commit it read.
--
-- The owner decided on 27 Oct that pins stay, for clones that stay
-- module-scoped, that the catalogue is detected again, and that each entry is
-- approved when it is published, with the commit it was approved at.
--
-- `module_detection_runs.commit_sha` is the prime commit a run read: its tree,
-- and every file it read, at that commit. The run writes it once it has read
-- the tree, and a run that cannot write it fails before it changes a module.
--
-- `module_library.source_commit_sha` is the commit of the run that detected the
-- entry's module, copied onto the entry when an admin publishes it. Publishing
-- approves the entry. A module whose run recorded no commit is refused by name,
-- and so is approving an entry that records none. The commit is copied rather
-- than joined because a run can be deleted, from the history panel or by
-- `purge_log_tables()` 180 days after it completes, and an entry outlives it.
--
-- Additive and nullable. No existing row is written: every run before this one
-- reads NULL, which is what each of them recorded, and the 134 pending entries
-- keep NULL and stay pending until a new publication supersedes them.

ALTER TABLE public.module_detection_runs
  ADD COLUMN IF NOT EXISTS commit_sha text;

ALTER TABLE public.module_library
  ADD COLUMN IF NOT EXISTS source_commit_sha text;

COMMENT ON COLUMN public.module_detection_runs.commit_sha IS
  'The prime commit this run read its tree and file contents at (GitHub''s 40-character SHA). Written by runDetection once the tree is read; a run that cannot write it fails before it changes a module. NULL on every run before 20261028120000, which recorded none.';

COMMENT ON COLUMN public.module_library.source_commit_sha IS
  'The prime commit this entry was approved at: the commit_sha of the detection run that detected its module, copied when an admin published it, which approves it. NULL on entries published before 20261028120000; such an entry cannot be approved or pinned.';
