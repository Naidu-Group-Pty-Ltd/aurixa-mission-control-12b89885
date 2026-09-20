-- @asserts column:prime_config.cascade_follows_lineage

-- THE SWITCH THAT LETS A CASCADE READ FROM A CLONE'S PARENT.
--
-- `clones.parent_clone_id` (20260920090000) records where a clone receives
-- from. Recording it and ACTING on it are deliberately two steps, and the gap
-- between them is this column.
--
-- Populating the lineage changed what Yggdrasil draws and nothing else. Acting
-- on it changes where the cascade engine READS BYTES: a clone with a parent
-- stops copying prime's tree and starts copying its parent's, which is the
-- whole point — a parent may carry clone-authored divergence its children are
-- meant to inherit — and is also the single most destructive thing this engine
-- does. `assertMirrorPolicy` exists because a whole-tree cascade with the wrong
-- policy overwrote a clone's backend identity: its Supabase project, its
-- hosting config, its own lead-capture embed.
--
-- So the routing lands OFF. Flipping it is an operator's act, taken once
-- somebody has read the drawn tree and agreed with it, and reversible by
-- setting this column back to false — which restores prime-sourced cascades
-- for every clone with no other change and no migration.
--
-- This is the same shape as `20260909110000_two_clones_become_mirrors.sql`:
-- seed the rows first, flip the behaviour second, because a flip that precedes
-- its data leaves a window in which a cascade can do exactly the damage the
-- guard exists to prevent.
--
-- While false, `executeCascade` resolves every clone's source to prime exactly
-- as it did before either migration existed, and `resolveCascadeSource` is a
-- one-line passthrough. There is no third state: a fleet is either following
-- the recorded lineage or it is not.

alter table public.prime_config
  add column if not exists cascade_follows_lineage boolean not null default false;

comment on column public.prime_config.cascade_follows_lineage is
  'When true, a clone with parent_clone_id set receives its cascade FROM that parent''s default branch rather than from prime, and is held until the parent carries the prime commit being delivered. Default false: recording the lineage draws the tree, acting on it moves bytes, and those are separate decisions. Set back to false to restore prime-sourced cascades fleet-wide with no other change.';
