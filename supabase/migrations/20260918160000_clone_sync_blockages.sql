-- @asserts table:clone_sync_blockages
-- @asserts column:clone_sync_blockages.class
-- @asserts column:clone_sync_blockages.owner
-- @asserts column:clone_sync_blockages.self_heals
-- @asserts column:clone_sync_blockages.cleared_at

-- A BLOCKAGE MAY BE SILENT, OR PERMANENT. IT MAY NEVER BE BOTH.
--
-- The auditor (`clone_convergence_observations`) says WHETHER a clone is
-- converging. This says WHY it is not, and — the field everything turns on —
-- WHO CAN CLEAR IT.
--
-- From 14 to 16 Sep 2026 the fleet froze at prime@66c49f8 while prime moved
-- 118 commits and the engine worked continuously. Every individual signal was
-- correct: the pull request body named the held files, the run notification
-- said "1 awaiting manual reconcile" (the same words it says on a healthy
-- run), and the drain held the proposal with a true sentence about failing
-- checks. Nothing distinguished "waiting on CI" from "will fail for ever until
-- a person acts", so nobody acted. This table is that distinction.
--
-- `owner` is a PERMISSION, not a label. The custodian in step 3 of the
-- shipping order reads it to decide whether it may act at all:
--
--   machinery      nothing about the code is wrong; a pass has to be re-run,
--                  a stale record repaired, a policy seeded. Safe to retry,
--                  because retrying is not a judgement.
--   operator       a decision only a person may record.
--   prime_author   prime shipped something the clone's checks refuse.
--   account_owner  a billing or account setting outside this repository.
--
-- `self_heals` is the same fact in the form the custodian actually asks, and
-- it is FALSE on ci_red for ever. A proposal going red because prime shipped
-- something the clone's checks refuse is the system working; nothing retries
-- it, rebuilds it hoping for a different answer, or merges it. What changes is
-- only that it stops producing the same silence as a proposal waiting on a
-- runner.
--
-- THE TAXONOMY CANNOT BE COMPLETE, AND IS STILL SOUND. The next freeze will
-- take a path nobody has walked — which is the whole reason this design exists
-- rather than another guard. So when the auditor reports a clone stalled and
-- no rule can say why, that ABSENCE is written here as `unclassified`, owned
-- by a person, never self-healing. An unanticipated condition arrives as a
-- named gap rather than as silence.
--
-- Step 2 of the shipping order populates this table and speaks to nobody. The
-- escalation reads it and ships separately, once the classification has been
-- checked against what actually happens.

CREATE TABLE IF NOT EXISTS public.clone_sync_blockages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  class text NOT NULL CHECK (
    class IN (
      'policy_unseeded', 'repo_retargeted', 'unreconciled_proposal',
      'attempts_exhausted', 'partial_clone_dropped', 'approval_pending',
      'deferred_far_future', 'event_stuck_running', 'invocation_cut',
      'consecutive_failures', 'ci_red', 'unclassified'
    )
  ),
  owner text NOT NULL CHECK (
    owner IN ('machinery', 'operator', 'prime_author', 'account_owner')
  ),
  -- Whether re-running the work clears this WITHOUT any new decision. The
  -- custodian's permission, carried on the row so an act can be audited
  -- against what was true when it was taken.
  self_heals boolean NOT NULL,
  -- One stable identity for one way of being blocked, so the same condition
  -- refreshes a row rather than accumulating them.
  fingerprint text NOT NULL,
  detail text NOT NULL,
  -- When the CONDITION began, as the facts reported it — not when this row was
  -- written. A blockage found today that started three weeks ago says three
  -- weeks, which is the number an operator needs.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- CLEARED, never deleted. A blockage records that a condition existed, and
  -- destroying that record is how the second occurrence looks like the first.
  -- A fingerprint that comes back opens a NEW row, which is what makes a gap
  -- that returned audible again rather than deduped into silence.
  cleared_at timestamptz,
  -- Reserved for the escalation in step 3. Nothing writes it yet.
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Both indexes below are PARTIAL, so neither covers the foreign key when a
-- clone is deleted. This one does.
CREATE INDEX IF NOT EXISTS clone_sync_blockages_clone_idx
  ON public.clone_sync_blockages (clone_id);

-- The reconciler's only read: this clone's currently-open set.
CREATE INDEX IF NOT EXISTS clone_sync_blockages_open_idx
  ON public.clone_sync_blockages (clone_id, fingerprint)
  WHERE cleared_at IS NULL;

-- The operator's read: what is open across the fleet, oldest first.
CREATE INDEX IF NOT EXISTS clone_sync_blockages_standing_idx
  ON public.clone_sync_blockages (first_seen_at)
  WHERE cleared_at IS NULL;

ALTER TABLE public.clone_sync_blockages ENABLE ROW LEVEL SECURITY;

-- Read-only to operators. Only the service role writes: a blockage an
-- operator could author is not an independent classification.
CREATE POLICY "Operators read clone_sync_blockages"
  ON public.clone_sync_blockages FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));
