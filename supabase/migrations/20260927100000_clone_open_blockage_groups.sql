-- @asserts rpc:clone_open_blockage_groups
--
-- A clone's open blockages, one line per class, counted in ONE statement.
--
-- WHAT WAS WRONG. The sync card (`src/server/cascade/cardBlockagesRead.server.ts`)
-- read a clone's open `clone_sync_blockages` rows in one PostgREST statement
-- with an exact count, and that reading is complete whenever the count is no
-- more than the rows returned. Past that, it asked for one count per class the
-- taxonomy knows, and every one of those was its own statement. Review found
-- what that costs (PR #299): separate statements see separate snapshots, so a
-- reconciliation that clears 501 rows between two of them leaves one counting
-- 501 before the clear and another 0 after it, and the card then draws 501
-- open rows on a clone that has none. No arrangement of separate requests
-- closes that. Only one statement sees one moment.
--
-- WHAT THIS IS. Every open row on one clone, folded into one line per class,
-- each line carrying its count and when its oldest row was first seen. A class
-- the CALLER'S taxonomy does not know is a line per class AND detail, because
-- the card draws such a row's own words and two rows need not say the same
-- thing. Every line also carries the totals over ALL lines: the open rows and
-- the lines. It is one SELECT, so the lines and the totals describe the same
-- moment by construction.
--
-- The totals are what make a short answer safe to read. PostgREST caps what it
-- returns (`max_rows`, 1,000 here) and says nothing when it does. The lines of
-- a class the caller knows sort first, and there are thirteen such classes, so
-- the cap can only ever cut lines of classes it does not know. The totals are
-- computed over every line before the cap, so they say exactly how many rows
-- the lines that arrived leave out.
--
-- The caller names the classes it knows (`_known_classes`) because the
-- database cannot know what the running build knows: a class this migration's
-- CHECK constraint admits and an older build has never heard of is exactly the
-- case the per-detail lines exist for.
--
-- READ-ONLY, AND READ AS THE CALLER. `stable`, so Postgres refuses any write
-- from inside it, and `security invoker`, so the table's own RLS decides what
-- it sees: an operator reads every open row on the clone, and anyone else reads
-- none, exactly as the direct read it replaces did. The card also calls it as a
-- GET, which PostgREST runs in a read-only transaction.
--
-- WHO MAY CALL IT. `pg_default_acl` on this database grants EXECUTE on every
-- new `public` function to `anon` and `authenticated`, and revoking from the
-- PUBLIC pseudo-role leaves those grants standing (see
-- `20260919153000_fleet_claim_heartbeat_monotonic.sql`), so `anon` is revoked
-- by name. `authenticated` keeps EXECUTE because the card reads with the
-- operator's own session. `service_role` keeps it because the drift alarm finds
-- an `rpc:` assertion in the schema description it reads as that role.
--
-- ADDITIVE, AND IT LANDS FIRST. `apply-migrations.yml` applies this within the
-- minute of the merge, and Lovable publishes the code that calls it after. Until
-- it exists the card's read fails, and a failed read is drawn as "could not be
-- read", never as a clone with nothing open.

create or replace function public.clone_open_blockage_groups(
  _clone_id uuid,
  _known_classes text[]
)
returns table (
  class text,
  detail text,
  owner text,
  self_heals boolean,
  open_count bigint,
  oldest_first_seen_at timestamptz,
  total_open bigint,
  total_lines bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with open_rows as (
    select b.id,
           b.class,
           b.detail,
           b.owner,
           b.self_heals,
           b.first_seen_at,
           b.class = any (coalesce(_known_classes, '{}'::text[])) as known
      from public.clone_sync_blockages b
     where b.clone_id = _clone_id
       and b.cleared_at is null
  ),
  lines as (
    select o.class,
           -- A known class is one line whatever its rows' details say. An
           -- unknown one is a line per detail, because its detail is its sentence.
           case when o.known then null else o.detail end as detail,
           o.known,
           -- The oldest row's own owner and self-heal flag: deterministic, and
           -- for a class the caller does not know, the only description there is.
           (array_agg(o.owner order by o.first_seen_at, o.id))[1] as owner,
           (array_agg(o.self_heals order by o.first_seen_at, o.id))[1] as self_heals,
           count(*) as open_count,
           min(o.first_seen_at) as oldest_first_seen_at
      from open_rows o
     group by o.class, case when o.known then null else o.detail end, o.known
  )
  select l.class,
         l.detail,
         l.owner,
         l.self_heals,
         l.open_count,
         l.oldest_first_seen_at,
         -- Over every line, before PostgREST caps the answer.
         (sum(l.open_count) over ())::bigint as total_open,
         count(*) over () as total_lines
    from lines l
   order by l.known desc, l.oldest_first_seen_at, l.class, l.detail nulls first;
$$;

comment on function public.clone_open_blockage_groups(uuid, text[]) is
  'The sync card''s open blockages on one clone: one line per class (per class '
  'and detail for a class the caller does not know), each with its count and '
  'oldest first_seen_at, and on every line the totals over all lines. One '
  'statement, so the lines and the totals describe one moment. Read-only '
  '(stable) and read as the caller (security invoker), so RLS decides what it '
  'sees.';

revoke all on function public.clone_open_blockage_groups(uuid, text[]) from public;
revoke all on function public.clone_open_blockage_groups(uuid, text[]) from anon;
grant execute on function public.clone_open_blockage_groups(uuid, text[]) to authenticated;
grant execute on function public.clone_open_blockage_groups(uuid, text[]) to service_role;

-- A new function, so PostgREST's schema cache has to be told.
notify pgrst, 'reload schema';
