-- @asserts table:clone_custodial_acts
-- @asserts column:clone_custodial_acts.act
-- @asserts column:clone_custodial_acts.outcome
-- @asserts column:clone_custodial_acts.reversal

-- THE CUSTODIAN MAY RE-RUN WORK. IT MAY NEVER CHANGE A VERDICT.
--
-- That sentence is the whole reconciliation between "the fleet stays in sync
-- no matter what" and "this must not compromise on genuine breakages".
-- Re-running is not a judgement: a spent rate-limit window, a stale URL, an
-- unseeded policy and a retired delivery are facts about the MACHINERY, and
-- repeating the pass that failed on them takes no new decision. Clearing a red
-- check is a judgement — prime shipped something the clone's checks refuse,
-- the gate is doing its job, and no amount of retrying substitutes for
-- somebody changing the code.
--
-- The line between those is `clone_sync_blockages.owner`, declared once in
-- `blockageTaxonomy.pure.ts` and enforced in `custodian.pure.ts`. This table
-- is the record of every time that line was consulted.
--
-- EVERY ACT IS WRITTEN DOWN, INCLUDING THE ONES NOT TAKEN. `outcome` carries
-- four values and three of them are inaction:
--
--   performed       it wrote, and `reversal` says how to undo it
--   would_perform   permitted, not yet switched on — step 5 of the shipping
--                   order runs the whole catalogue in exactly this state, so
--                   an act can be watched for a week before it is trusted
--   refused         the permission said no, and `detail` says which rule
--   failed          it tried and the write did not land
--
-- A custodian whose refusals were silent would be indistinguishable from one
-- that was not running, which is this programme's oldest lesson wearing an
-- automation badge.
--
-- `reversal` IS THE POINT OF THE ROW. Every act records what it changed and
-- what the value was before, so undoing it is reading a row rather than
-- reconstructing an intention. An automatic repair nobody can reverse is a
-- decision taken by a machine with no way back.
--
-- AND THE CUSTODIAN NEVER CLEARS ITS OWN BLOCKAGE. The ledger's next pass
-- observes whether the condition is gone and clears it then. If the custodian
-- closed what it had just repaired, a repair that did not work would look
-- exactly like one that did — the auditor's own separation of actor from
-- observer, one level down.

CREATE TABLE IF NOT EXISTS public.clone_custodial_acts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  -- The blockage this answered. Nullable because a blockage may be cleared and
  -- pruned while its act stays on the record — the act is the durable half.
  blockage_id uuid REFERENCES public.clone_sync_blockages(id) ON DELETE SET NULL,
  class text NOT NULL,
  act text NOT NULL,
  outcome text NOT NULL CHECK (
    outcome IN ('performed', 'would_perform', 'refused', 'failed')
  ),
  rows_affected integer NOT NULL DEFAULT 0,
  detail text NOT NULL,
  -- How to undo it: the table, the rows, and the value each held before.
  -- Absent on anything that did not write.
  reversal jsonb,
  -- True when the whole pass was a rehearsal. Distinct from `would_perform`,
  -- which is an act that is permitted and not yet switched on: one is the
  -- run's mode, the other is the act's own state, and reading either as the
  -- other would make a rehearsal look like a policy.
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The foreign keys, covered.
CREATE INDEX IF NOT EXISTS clone_custodial_acts_clone_idx
  ON public.clone_custodial_acts (clone_id);
CREATE INDEX IF NOT EXISTS clone_custodial_acts_blockage_idx
  ON public.clone_custodial_acts (blockage_id);

-- The operator's read: what has this thing been doing, newest first.
CREATE INDEX IF NOT EXISTS clone_custodial_acts_recent_idx
  ON public.clone_custodial_acts (created_at DESC);

-- What a per-act daily cap counts.
CREATE INDEX IF NOT EXISTS clone_custodial_acts_rate_idx
  ON public.clone_custodial_acts (clone_id, act, created_at DESC)
  WHERE outcome = 'performed';

ALTER TABLE public.clone_custodial_acts ENABLE ROW LEVEL SECURITY;

-- Read-only to operators. Only the service role writes: an act an operator
-- could author is not a record of what the custodian did.
CREATE POLICY "Operators read clone_custodial_acts"
  ON public.clone_custodial_acts FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));
