-- @asserts column:clones.merge_drain_at

-- The merge drain remembers where it got to, so a fleet larger than one run
-- can serve is served in turn rather than from the top every time.
--
-- ## Why
--
-- `drainCascadeMerges` looped over EVERY clone with no cap, no ordering and no
-- wall-clock budget, doing one `pulls.list` per clone and then up to 25
-- sequential `pulls.get` / `checks.listForRef` / `pulls.merge` round trips
-- inside it. That is O(clones x open pull requests) serial GitHub calls inside
-- a 60,000 ms pg_net ceiling — the same wall that killed the first mirror
-- cascade at exactly 60,000 ms, and that `net._http_response` still records
-- being hit on this deployment.
--
-- At three clones it fits. The failure past that is not "slow": because the
-- clone list came back in whatever order the planner chose and the run was cut
-- off wherever the ceiling fell, every run served the same prefix and the tail
-- was never reached. Nothing reported it — the route writes an audit row only
-- when something CHANGED, so a starved tail and a quiet fleet look identical.
--
-- ## The rule
--
-- **Longest-waited-first, stamped whether or not anything happened.** The
-- stamp is a visit, not a merge: a clone with nothing to do still had its turn,
-- and ordering by "when did we last look" is what makes the rotation fair by
-- construction rather than by luck. `fleet-migration` already orders its own
-- batch this way (`migration_version` nulls first); this is the same rule for
-- the same reason.
--
-- NULL means never visited, and sorts first.

alter table public.clones
  add column if not exists merge_drain_at timestamptz;

comment on column public.clones.merge_drain_at is
  'When the cascade merge drain last VISITED this clone, whether or not anything merged. '
  'Ordering by it nulls-first is what stops a run that fits its budget from serving the same '
  'head of the list every time while the tail starves unreported.';

-- The drain reads exactly this: clones with a repository, oldest visit first.
create index if not exists clones_merge_drain_rotation_idx
  on public.clones (merge_drain_at nulls first)
  where github_owner is not null and github_repo is not null;
