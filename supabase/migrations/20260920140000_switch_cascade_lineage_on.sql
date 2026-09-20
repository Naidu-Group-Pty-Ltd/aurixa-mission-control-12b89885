-- @asserts check:prime_config.cascade_follows_lineage=true

-- SWITCH THE CASCADE ONTO THE RECORDED LINEAGE.
--
-- `20260920093000_cascade_follows_lineage.sql` landed the flag OFF and said
-- flipping it is an operator's act. This is that act, on the owner's
-- instruction of 20 Sep 2026. A migration is not a second opinion about it —
-- it is the only channel that reaches this database at all: Mission Control's
-- database is a Lovable Cloud project in LOVABLE's Supabase organisation, with
-- no service-role key and no direct database URL, so `apply-migrations.yml`
-- queueing SQL is how every statement gets here. See that workflow's header.
--
-- ## What changes on the next cascade
--
-- Nothing happens when this applies. The flag is read when a cascade RUNS, so
-- the change lands on the next prime push (or the next drift-beacon firing),
-- not here.
--
-- From then on `preflight-property-group` and `npc-test-76b3b3` stop reading
-- prime and start reading `npc-client-dashboard`'s default branch. Both are
-- MIRRORS, so what they receive is that clone's whole tree — including the
-- divergence it is documented as deliberately carrying (see
-- `20260916100000_seed_september_unblock_approvals.sql`, which excluded
-- npc-client-dashboard from an App.tsx overwrite precisely because "its copy
-- carries real client-facing gates"). Those gates are now what its children
-- inherit. That is the point of the recorded tree, and it is a real content
-- change rather than a presentational one.
--
-- ## What `pr` mode will look like, so it is not read as a fault
--
-- `prime_config.default_cascade_mode` defaults to `pr`. In that mode a parent's
-- cascade OPENS a proposal rather than landing on its branch, so its children
-- are HELD — correctly — until somebody merges it. The event stays `pending`
-- with "Waiting on lineage until …" and re-checks every five minutes; it is
-- reported as a deferral so it does not spend the attempts that would fail it.
--
-- Two clones that appear to stop following prime is therefore the DESIGNED
-- reading of a parent proposal nobody has merged yet, not a stall. Merging
-- npc-client-dashboard's cascade pull request releases them.
--
-- ## Turning it back off
--
-- `update public.prime_config set cascade_follows_lineage = false;` restores
-- prime-sourced cascades fleet-wide with no other change and no migration.
-- This file is applied once through the ledger and re-asserts nothing, so an
-- operator who turns it off stays off.
--
-- ## Why this refuses rather than trusting its own premise
--
-- Routing is switched on against a SHAPE. If the lineage this was written
-- against is not the lineage in the table, the flip would act on a tree nobody
-- agreed to — and the failure would be silent, because an empty or different
-- lineage still flips a boolean perfectly well. So the two parentings the
-- operator's diagram names are checked by EFFECT before anything is written,
-- the same rule the retention purge and the verification self-test answer to.
--
-- Deliberately a floor (`< 2`) and not an equality: additional lineage
-- recorded since is somebody's own decision, and routing applies to it by
-- design. What must hold is that the tree this migration was told to act on is
-- the one that is there.

do $$
declare
  _drawn int;
  _rows  int;
begin
  select count(*)
    into _drawn
    from public.clones child
    join public.clones parent on parent.id = child.parent_clone_id
   where parent.github_repo = 'npc-client-dashboard'
     and child.github_repo in ('preflight-property-group', 'npc-test-76b3b3');

  if _drawn < 2 then
    raise exception
      'Refusing to switch cascade routing on: expected preflight-property-group and npc-test-76b3b3 to be recorded under npc-client-dashboard, found % of 2. Apply 20260920090000_clone_parent_lineage.sql first.',
      _drawn
      using errcode = 'check_violation';
  end if;

  update public.prime_config
     set cascade_follows_lineage = true;

  get diagnostics _rows = row_count;

  -- A flip that wrote nothing is not a flip. `prime_config` holds exactly one
  -- row by construction — every reader takes it with `.limit(1)` — so zero
  -- rows here means the prime is not configured and the cascade has no source
  -- at all, which must fail loudly rather than record a switch nobody threw.
  if _rows < 1 then
    raise exception
      'Refusing to switch cascade routing on: no prime_config row was updated, so there is no prime for a cascade to source from.'
      using errcode = 'check_violation';
  end if;
end $$;
