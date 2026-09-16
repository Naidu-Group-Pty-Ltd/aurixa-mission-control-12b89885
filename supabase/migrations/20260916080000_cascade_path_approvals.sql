-- @asserts table:cascade_path_approvals
-- @asserts column:cascade_path_approvals.kind
-- @asserts column:cascade_path_approvals.expires_at

-- A REFUSAL THE ENGINE CANNOT LIFT NEEDS A PLACE A PERSON CAN.
--
-- Two of the cascade engine's refusals are deliberate and correct, and in
-- September 2026 both landed on the same change at once — prime's
-- builder-portal decommission — and froze the fleet for two days:
--
--   * the bulk-deletion cap refused a 95-file retirement whole, on every
--     pass, although every path in it was individually proven against
--     prime's own history (`deletionPropagation.pure.ts`);
--   * the `manual_reconcile` hold on `src/App.tsx` withheld the one-line
--     route rewrite the retirement needs, while a cascaded source test
--     asserted that route's presence — so `verify` was red on every rebuilt
--     proposal and the auto-merge gate correctly refused, forever.
--
-- Each refusal said "a person has to decide", and the product had nowhere to
-- record the decision. The pull request body asked; nothing listened. This
-- table is where the decision lives:
--
--   kind = 'bulk_deletion' — an operator has READ a refused deletion set and
--     approves it path by path. The engine delivers a set over the cap only
--     when every path in it is approved, and a path still has to earn its
--     delete verdict from prime's history first — an approval is never
--     evidence (`planDeletions`).
--
--   kind = 'overwrite' — an operator approves prime's copy over one held
--     `manual_reconcile` path on one clone. It releases judgement, never
--     identity: `decideHoldRelease` refuses to release a `protected` path
--     whatever this table says, and a released file still runs the content
--     holds (`backendIdentityHold`) like any other write.
--
-- Approvals EXPIRE (14 days) and are REVOKED rather than deleted, because an
-- authority with no end and no record is how the next accident gets a
-- pedigree. The unique key means re-approving refreshes one row rather than
-- accumulating contradictions.

CREATE TABLE IF NOT EXISTS public.cascade_path_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('overwrite', 'bulk_deletion')),
  path text NOT NULL,
  reason text NOT NULL,
  approved_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  revoked_at timestamptz,
  revoked_by uuid,
  UNIQUE (clone_id, kind, path)
);

CREATE INDEX IF NOT EXISTS cascade_path_approvals_clone_idx
  ON public.cascade_path_approvals (clone_id);

ALTER TABLE public.cascade_path_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators read cascade_path_approvals"
  ON public.cascade_path_approvals FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE POLICY "Operators record their own path approvals"
  ON public.cascade_path_approvals FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_operator(auth.uid())
    AND approved_by = auth.uid()
  );

-- Revocation and re-approval touch existing rows; the server functions set
-- revoked_by to the caller, and RLS holds the caller to being an operator.
CREATE POLICY "Operators update cascade_path_approvals"
  ON public.cascade_path_approvals FOR UPDATE
  TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

-- The alert a blocked proposal raises. `cascade_failed` is wrong for it —
-- nothing failed; the engine is refusing on purpose and a person is owed a
-- decision — and reusing a kind that already means something else is how a
-- bell full of red teaches operators not to read it.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'cascade_blocked';
