-- @asserts column:prime_config.codex_autofix_enabled
-- @asserts column:prime_config.codex_autofix_max_per_night
--
-- Codex Security: fixes are written and merged with no person in the loop,
-- and scans run nightly on Prime only. Both decided by the platform owner,
-- October 2026.
--
-- `codex_autofix_enabled` -- after each nightly Prime scan, Mission Control
-- dispatches fixes for the open findings by itself: Claude writes the P0/P1
-- ones (critical, high), Codex the P2 and below (src/lib/codex-autofix-policy.ts).
-- Every fix PR merges once its automated checks pass, or is closed
-- (src/lib/remediation-policy.ts `decideFixMerge`), and the merge reaches the
-- clones through the ordinary cascade. On by default, because that is the
-- decision; off stops new dispatches, and fixes already in flight still merge
-- or close.
--
-- `codex_autofix_max_per_night` -- how many fixes one nightly scan
-- dispatches. Each is an Actions run and model spend, and each merge is a
-- cascade to the fleet, so a large backlog drains over successive nights,
-- worst first.
--
-- The updates below make the scan policy hold from the moment this migration
-- applies, whichever of the code and the database is deployed first: code
-- from before it reads these switches, and stops scanning pull requests,
-- merges and clones. The new code no longer reads them at all.
ALTER TABLE public.prime_config
  ADD COLUMN IF NOT EXISTS codex_autofix_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS codex_autofix_max_per_night INTEGER NOT NULL DEFAULT 10;

DO $$
BEGIN
  ALTER TABLE public.prime_config
    ADD CONSTRAINT prime_config_codex_autofix_max_per_night_range
    CHECK (codex_autofix_max_per_night BETWEEN 0 AND 50);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE public.prime_config
   SET codex_pr_scan_enabled = false,
       codex_post_merge_revalidate = false;

UPDATE public.prime_config
   SET codex_deep_scan_scope = 'prime'
 WHERE codex_deep_scan_scope = 'fleet';

UPDATE public.clones
   SET codex_nightly_enabled = false
 WHERE codex_nightly_enabled IS DISTINCT FROM false;
