-- @asserts check:clone_backend_secrets.status=withheld
--
-- A credential fleet policy forwards, that ONE clone must not hold.
--
-- `prime_secret_forwards.inherit` is fleet policy and `clone_secret_forwards`
-- is a per-clone AUTHORISATION — its own header states the rule: "a row that
-- is not wanted is deleted", there is no `inherit` boolean, because a false
-- row would mean "considered and declined", which is a statement fleet policy
-- needs and a single clone does not.
--
-- That leaves no way to say the one thing now needed. `DIDIT_API_KEY` is
-- forwarded fleet-wide and must be taken back off ONE tenant while the other
-- two keep it: a Didit key is scoped to an APPLICATION, and that scope
-- includes the application's session list — every session, with the
-- customer's name and live pre-signed URLs to their passport portrait and
-- selfie. The clone reaches Didit through Mission Control's broker instead.
-- Withdrawing it fleet-wide is a different, larger decision.
--
-- Deleting the value alone does not survive: `pushFleetSecretForwards` writes
-- every fleet name a clone is not `settled` on, so the next reconcile — every
-- thirty minutes — puts it straight back. Leaving the ledger reading
-- `inherited` would stop that and make the ledger lie, which is worse: the
-- operator's secret list would show a value the project does not hold.
--
-- `withheld` is therefore its own status, and it is deliberately NOT in
-- `SETTLED`. The clone does not hold the value (so the reading stays true)
-- and the sweep may not write it (so the withdrawal stands). It is written
-- only by an explicit withdrawal and never by a sweep, because a status that
-- a reconcile can reach is one a reconcile can reach by accident.
--
-- The constraint is REPLACED rather than widened in place, because Postgres
-- has no "add a value to a CHECK". A value the column refuses is rejected by
-- the server while looking, from the function that tried to write it, exactly
-- like a write nobody attempted — the shape this platform has already paid
-- for once on a CHECK-constrained `reminder_type`.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clone_backend_secrets_status_check'
  ) THEN
    ALTER TABLE public.clone_backend_secrets
      DROP CONSTRAINT clone_backend_secrets_status_check;
  END IF;

  ALTER TABLE public.clone_backend_secrets
    ADD CONSTRAINT clone_backend_secrets_status_check
    CHECK (status IN ('missing', 'set', 'failed', 'inherited', 'authorised_no_value', 'withheld'));
END $$;

COMMENT ON COLUMN public.clone_backend_secrets.status IS
  'missing = not on the project. set = written for this clone. inherited = '
  'forwarded by fleet policy. failed = the write was attempted and refused. '
  'authorised_no_value = authorised, but Mission Control holds nothing under '
  'the name (never written — an empty shell is worse than an absent one). '
  'withheld = deliberately taken off THIS clone though fleet policy forwards '
  'it; the project does not hold the value and no sweep may write it.';
