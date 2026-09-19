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
  _claimed_at timestamptz
)
returns boolean
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
  update public.clone_backends
     set migration_heartbeat_at = greatest(migration_heartbeat_at, clock_timestamp())
   where clone_id = _clone_id
     and worker_started_at = _claimed_at
  returning true into _held;

  -- FALSE means the claim is no longer this pass's, and nothing was written.
  -- NULL — no row matched — is the same statement, said by the absence of a
  -- row rather than by a value.
  return coalesce(_held, false);
end;
$$;

comment on function public.fleet_claim_heartbeat(uuid, timestamptz) is
  'Advance the fleet migration lane''s liveness stamp on a clone it holds. '
  'Fenced on `worker_started_at` so a reclaimed pass cannot write into its '
  'successor''s claim, and monotonic by GREATEST so two beats committing out '
  'of order cannot move the stamp backwards. Returns whether the claim was '
  'still held.';

revoke all on function public.fleet_claim_heartbeat(uuid, timestamptz) from public;
grant execute on function public.fleet_claim_heartbeat(uuid, timestamptz) to service_role;

-- A new signature, so PostgREST's schema cache has to be told.
notify pgrst, 'reload schema';
