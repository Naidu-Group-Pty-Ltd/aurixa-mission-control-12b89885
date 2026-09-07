-- ─────────────────────────────────────────────────────────────────────────────
-- `verify_domain_txt` was refused by the column that stores it.
--
-- The verifying-domain fix (#113) taught the drain to queue the provider's
-- ownership challenge wherever it appears, and the edge worker has handled the
-- `verify_domain_txt` action since the same change. Between them sat this
-- CHECK constraint, which was never extended past the seven actions it was
-- written with:
--
--   attach, apply_posture, sync, detach,
--   provision_subdomain, deprovision_subdomain, resync_subdomain
--
-- So every enqueue answered 23514 and NOTHING was queued. Measured 7 September
-- 2026, after the re-queue migration put both domains back in flight: the
-- challenge was captured on each row correctly
-- (`vc-domain-verify=npc-test.aurixasystems.com.au,8a82…`), the drain ticked
-- every two minutes, and `edge_provisioning_jobs` held ZERO rows for the
-- action. The TXT at `_vercel.aurixasystems.com.au` still answered NXDOMAIN
-- four days after the domains were attached.
--
-- This is the `reminder_type` lesson again, in a different column: a value the
-- COLUMN refuses is rejected by Postgres while looking, from the function
-- above it, exactly like a write nobody attempted. It is only invisible
-- because the caller discarded the error — fixed in the same change as this,
-- so the next value a column will not accept says so on the row an operator
-- reads.
--
-- @asserts none:widens a CHECK constraint — pg_constraint is not observable
-- through PostgREST, and the vocabulary has no `constraint:` claim. The effect
-- is proven on the live fleet instead: the drain's next enqueue succeeds and
-- `edge_provisioning_jobs` gains the rows it has been unable to write.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.edge_provisioning_jobs
  DROP CONSTRAINT IF EXISTS edge_provisioning_jobs_action_check;

ALTER TABLE public.edge_provisioning_jobs
  ADD CONSTRAINT edge_provisioning_jobs_action_check
  CHECK (action = ANY (ARRAY[
    'attach',
    'apply_posture',
    'sync',
    'detach',
    'provision_subdomain',
    'deprovision_subdomain',
    'resync_subdomain',
    'verify_domain_txt'
  ]::text[]));
