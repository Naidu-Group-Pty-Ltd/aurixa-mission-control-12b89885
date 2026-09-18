-- @asserts table:clone_convergence_observations
-- @asserts column:clone_convergence_observations.state
-- @asserts column:clone_convergence_observations.owed_fingerprint
-- @asserts column:clone_convergence_observations.last_converged_at
-- @asserts column:prime_config.convergence_slo_minutes

-- SYNC IS A PROPERTY OF TWO TREES, MEASURED BY COMPARING THEM.
--
-- Every existing reading of "is this clone in sync" is derived from the record
-- the actor wrote:
--
--   sync_status <- commits_behind <- last_synced_sha <- the merge drain
--               <- cascade_results <- the engine
--
-- so a wrong actor produces a reading wrong IN THE SAME DIRECTION. On
-- 16 Sep 2026 `advanceClone` stamped a folded carrier's provenance instead of
-- the head its pass delivered, and the next drift scan wrote "Critical Sync:
-- 84 commits behind Prime" onto a clone whose content matched prime's byte for
-- byte. `choosePointerAdvance` made the pointer honest; it did not change the
-- fact that the pointer is the only thing anybody reads.
--
-- This table holds the other reading: prime's tree against the clone's tree,
-- through the engine's own exclusion partition. `owed_count` is what the
-- cascade would still write if you asked it to run right now — the only
-- number that is true independently of how the ledger came to say what it
-- says, and the only one that can see divergence NO EVENT EVER CREATED (a
-- force-push, a reverted merge, an over-broad exclusion, a direct edit).
--
-- DIVERGENCE IS NOT A FAULT. Measured 18 Sep 2026: `drift_high` fired
-- "Investigate Stalled Cascade Pipeline" at 08:45 and 09:00 about clones that
-- converged at 09:00:46. Delivery is ~17 minutes of CI plus drain latency, so
-- a fifteen-minute scan reading a non-zero `commits_behind` fires on the
-- normal state of a working pipeline — which is the whole of the 1,253 unread
-- `drift_high` rows, and why the channel `cascade_blocked` also arrives in is
-- one an operator had already learned to filter out.
--
-- So nothing keys on a level. `state` is a verdict about a DERIVATIVE, over
-- two clocks:
--
--   converged       owed is empty. Both clocks reset.
--   delivering      owed is non-empty and either moved this pass or is
--                   younger than one delivery window. Silent, by design.
--   stalled         the SAME owed set has outlived one delivery window.
--   falling_behind  the owed set keeps MOVING but has not reached zero in
--                   four windows. This is the September freeze's signature:
--                   prime moved 118 commits over two days while the fleet
--                   received nothing, so "has it moved?" answered yes,
--                   continuously, about a fleet that was frozen.
--   unknown         it could not be measured. NEVER read as converged.
--
-- Step 1 of the shipping order writes observations and acts on nothing. The
-- escalation that replaces `drift_high` reads this table and arrives in its
-- own change, once a week of observations has shown the reading agrees with
-- reality. Nothing in this migration notifies anybody.

CREATE TABLE IF NOT EXISTS public.clone_convergence_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (
    state IN ('converged', 'delivering', 'stalled', 'falling_behind', 'unknown')
  ),
  -- Paths the cascade WOULD write whose blob SHA differs. Held paths are never
  -- counted here: a held file that has drifted is real and is
  -- `held-file-drift`'s job, and counting it would leave every clone
  -- permanently non-convergent on files this platform may not write.
  owed_count integer NOT NULL DEFAULT 0,
  -- Order-independent identity of the owed set; NULL when converged or
  -- unknown. What the "has anything moved?" question compares.
  owed_fingerprint text,
  -- A BOUNDED sample, and `owed_count` beside it is the true number. A
  -- truncated list that reads as complete is this repository's most repeated
  -- defect.
  owed_sample text[] NOT NULL DEFAULT '{}',
  -- Paths the clone holds that prime does not. A CANDIDATE and never on its
  -- own a reason to delete — only prime's own history settles that
  -- (`deletionPropagation.pure.ts`), and re-deriving it here would be a second
  -- implementation of the most destructive decision in the engine.
  deletion_candidates integer NOT NULL DEFAULT 0,
  held_count integer NOT NULL DEFAULT 0,
  -- Paths the cascade refuses on SIZE (over CASCADE_MAX_FILE_BYTES). Never
  -- owed: found by running the auditor against the two live trees before it
  -- had ever run in production — both differing paths were ~41.7 MB template
  -- seeds against an 8 MB ceiling, held on every pass for ever and correctly.
  -- Reported as owed they would have escalated as `stalled` permanently, on a
  -- fleet behaving exactly as designed, which is `drift_high` in a new costume.
  oversize_held integer NOT NULL DEFAULT 0,
  compared_count integer NOT NULL DEFAULT 0,
  -- When the CURRENT owed set was first seen. The `stalled` clock.
  unchanged_since timestamptz,
  -- Last moment this clone held everything it was owed. The `falling_behind`
  -- clock. Carried forward on every row rather than looked up across the
  -- series, so one read answers both clocks and the fact survives pruning.
  last_converged_at timestamptz,
  slo_minutes integer,
  scope text,
  prime_sha text,
  clone_sha text,
  why text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The auditor's only read: this clone's newest row.
CREATE INDEX IF NOT EXISTS clone_convergence_observations_clone_time_idx
  ON public.clone_convergence_observations (clone_id, observed_at DESC);

-- The retention pass, and the "show me the series" card.
CREATE INDEX IF NOT EXISTS clone_convergence_observations_time_idx
  ON public.clone_convergence_observations (observed_at DESC);

ALTER TABLE public.clone_convergence_observations ENABLE ROW LEVEL SECURITY;

-- Read-only to operators. Nothing but the service role writes this table: an
-- observation an operator could author is not an independent reading.
CREATE POLICY "Operators read clone_convergence_observations"
  ON public.clone_convergence_observations FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

-- HOW LONG A CLONE MAY TAKE TO RECEIVE A PRIME COMMIT.
--
-- A parameter rather than a literal, because it is a number an operator has to
-- be able to defend and change. 90 minutes is ~17 minutes of `verify`, a
-- five-minute merge drain, one conflict-repair cycle, and room for a queued
-- pass to wait its turn. Without a stated number "stuck" is undefined and
-- every alarm is a guess — which is how the fleet ended up with 1,253 of them.
ALTER TABLE public.prime_config
  ADD COLUMN IF NOT EXISTS convergence_slo_minutes integer NOT NULL DEFAULT 90;

-- Every fifteen minutes, offset off the quarter hour so it does not contend
-- with `drift-refresh` (*/5) or `fleet-drift-scan` (*/15) for the same
-- installation window. It yields below the scan floor anyway; this just keeps
-- the ticks legible in `net._http_response`.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('cascade-audit')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cascade-audit');

  PERFORM cron.schedule(
    'cascade-audit',
    '7,22,37,52 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 60000
      )$f$,
      v_base || '/hooks/cascade-audit'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron or vault must not fail the whole migration. An unscheduled
  -- auditor is a reading nobody takes, not a broken fleet — and
  -- `check-cron-auth.mjs` fails CI on a hook nobody scheduled.
  RAISE WARNING 'cascade audit NOT scheduled (%).', SQLERRM;
END $$;
