-- @asserts rpc:fleet_claim_heartbeat

-- A TIMESTAMP THE DATABASE PICKS, AND A MAXIMUM IT CANNOT GO BACK FROM.
--
-- The fleet migration lane says it is still alive by stamping
-- `clone_backends.migration_heartbeat_at` while it holds a claim. Written from
-- the isolate, that stamp is chosen BEFORE the request goes out — and two
-- requests sent by one pass can commit in the other order, so an older value
-- lands last and a pass that is beating perfectly reads as stale. The reclaim
-- then hands its clone to a second pass and two of them apply the same
-- migrations to one schema, which is the outcome the claim exists to prevent.
--
-- Three attempts were made in the client and each one bought the next defect:
--
--   * overlapping beats reordered (the fault above);
--   * serialising them made a HUNG beat end the heartbeat for ever, and the
--     wedge is correlated with the case the heartbeat is for — a request
--     stuck on the same egress as the migration's own SQL;
--   * bounding each beat with an abort turned a database that is merely SLOW
--     into total silence, because every beat past the ceiling is discarded and
--     the stamp never moves at all.
--
-- They are one problem wearing three hats: ordering was being defended in the
-- caller, where it cannot be, because the caller does not decide when a write
-- commits. So the decision moves here.
--
--   set migration_heartbeat_at = greatest(migration_heartbeat_at, clock_timestamp())
--
-- `GREATEST` ignores NULL in Postgres, so a row whose stamp was never set
-- takes the clock. Whichever transaction commits last, the column ends at the
-- maximum of what any of them offered: commit order stops mattering, which
-- means beats no longer have to be serialised, which means one that hangs
-- cannot end the chain, which means none of them needs an abort. All three
-- defects above are gone at once rather than traded against each other.
--
-- `clock_timestamp()` rather than `now()` deliberately: `now()` is the
-- TRANSACTION's start time, so two overlapping beats would still offer values
-- in the order they started rather than the order they ran. And either is
-- better than the isolate's own clock, which this pipeline has already
-- measured drifting 10-40 ms from the database's.
--
-- The fence is the function's own `where`: a beat may only touch the row while
-- `worker_started_at` is still the value the pass claimed it with. The return
-- says whether it matched, so the caller can tell "the claim is gone" from
-- "the write failed" — two answers that a bare row count could not separate
-- once the write also became conditional on advancing.

create or replace function public.fleet_claim_heartbeat(
  _clone_id uuid,
  _claimed_at timestamptz,
  -- AND A BEAT CANNOT SPEAK FOR A PASS THAT HAS STOPPED.
  --
  -- The caller stops its timer when the pass ends, which stops beats being
  -- SENT and does nothing about one already dispatched. On the path where the
  -- release write itself failed — the row still held, which is exactly when
  -- the five-minute silence is load-bearing — a late beat's fence still
  -- matches and `GREATEST` refreshes a claim nobody holds, for another five
  -- minutes, once per queued beat. The caller's drain bounds how long the pass
  -- WAITS; it cannot bound when a dispatched request executes. Raised by
  -- review.
  --
  -- So the bound travels with the beat. Whenever it actually runs, a beat may
  -- only speak for the moment it was sent: past `_not_after` it writes nothing
  -- and says so. The extra life a queued beat can buy is then one interval,
  -- fixed, instead of however long the request sat in a queue.
  _not_after timestamptz
)
returns text
language plpgsql
-- INVOKER, not DEFINER, and that is deliberate.
--
-- Its siblings in this schema are `security definer` because `anon` and
-- `authenticated` call them and need a privilege they do not hold. This one is
-- called by exactly one caller — the fleet lane, on `supabaseAdmin`, which is
-- `service_role` — and that role already updates `clone_backends` directly
-- through PostgREST today. A definer here would therefore hand out a
-- privilege nobody needs, and a `security definer` function on a table this
-- sensitive is a standing escalation surface kept for no reason.
--
-- The grants below leave `service_role` as the only grantee, so nothing else
-- can reach it either way. This is the belt as well as the braces.
security invoker
set search_path = public
as $$
declare
  _held boolean;
begin
  -- Checked BEFORE the write, so an expired beat cannot touch the row at all.
  if clock_timestamp() > _not_after then
    return 'expired';
  end if;

  update public.clone_backends
     set migration_heartbeat_at = greatest(migration_heartbeat_at, clock_timestamp())
   where clone_id = _clone_id
     and worker_started_at = _claimed_at
  returning true into _held;

  -- Three answers, because they send the caller three different ways. `held`
  -- is the ordinary one. `lost` means the claim is somebody else's and the
  -- caller must stop beating. `expired` above means this beat is simply too
  -- late to say anything — which is NOT a lost claim, and reporting it as one
  -- would have the caller log that a pass lost a claim it still holds.
  return case when coalesce(_held, false) then 'held' else 'lost' end;
end;
$$;

comment on function public.fleet_claim_heartbeat(uuid, timestamptz, timestamptz) is
  'Advance the fleet migration lane''s liveness stamp on a clone it holds. '
  'Fenced on `worker_started_at` so a reclaimed pass cannot write into its '
  'successor''s claim, and monotonic by GREATEST so two beats committing out '
  'of order cannot move the stamp backwards. Returns whether the claim was '
  'still held.';

-- REVOKING FROM `public` IS NOT REVOKING FROM `anon` AND `authenticated`.
--
-- `pg_default_acl` on this database grants EXECUTE on every new `public`
-- function to `anon` AND `authenticated` — measured and written down in
-- `20260828030000_schema_migration_queue.sql`, which records that 77 of 145
-- public functions are anon-executable today and that of the 45
-- `REVOKE ALL ON FUNCTION` statements in this corpus only 13 name
-- `authenticated`. Those are role-specific grants; revoking from the PUBLIC
-- pseudo-role leaves every one of them standing. Raised by review, and this
-- migration was the forty-sixth to make the mistake.
--
-- Named explicitly, therefore. With `security invoker` an `anon` caller would
-- have been refused by RLS anyway and learned nothing, but "refused one layer
-- in" is not the same as "cannot be called", and the layer that refuses it is
-- a policy somebody may edit for another reason entirely.
revoke all on function public.fleet_claim_heartbeat(uuid, timestamptz, timestamptz) from public;
revoke all on function public.fleet_claim_heartbeat(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.fleet_claim_heartbeat(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.fleet_claim_heartbeat(uuid, timestamptz, timestamptz) to service_role;

-- A new signature, so PostgREST's schema cache has to be told.
notify pgrst, 'reload schema';
