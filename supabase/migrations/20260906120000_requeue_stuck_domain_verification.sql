-- ─────────────────────────────────────────────────────────────────────────────
-- Re-queue the two deployments failed as "Stuck in verifying_domain".
--
-- Both were failed on 3-4 September holding the exact TXT challenge they
-- needed in their own `domain_verification` column — the defect the
-- verifying-time challenge fix closes (domainChallenge.contract.test.ts, rule
-- A7 in HOSTING_ARCHITECTURE.md). `failed` is terminal to every drain by
-- design, so the rows are put back at `attaching_domain`: the drain re-attaches
-- (idempotent), queues the provider's challenge records through Cloudflare,
-- and advances to `live` when the provider verifies.
--
-- A data repair ships as a migration here because the apply-on-merge workflow
-- runs with Mission Control's own database credential — the same channel the
-- forward-row seeds used. The WHERE names the exact two domains and the exact
-- failure, so a row in any other state is untouched and re-applying is a no-op.
--
-- @asserts rows:clone_deployments>=3
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.clone_deployments d
   SET status = 'attaching_domain',
       attempts = 0,
       error_message = NULL,
       status_detail = 'Re-queued: writing the provider''s domain-ownership challenge (the TXT record it asked for after attach), then verifying.',
       next_attempt_at = now(),
       worker_started_at = NULL,
       worker_finished_at = NULL,
       status_since = now(),
       updated_at = now()
 WHERE d.status = 'failed'
   AND d.error_message = 'stuck'
   AND d.project_id IS NOT NULL
   AND d.domain IN ('npc-test.aurixasystems.com.au', 'preflight-property-group.aurixasystems.com.au');
