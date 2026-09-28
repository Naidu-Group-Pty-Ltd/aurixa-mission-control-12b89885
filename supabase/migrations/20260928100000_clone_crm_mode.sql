-- @asserts column:clones.crm_mode
-- @asserts check:clones.crm_mode=dependent
-- @asserts check:clones.crm_mode=independent
-- @asserts column:prime_config.crm_dependent_parent_clone_id
-- @asserts column:prime_config.crm_independent_parent_clone_id
-- @asserts column:clone_backends.clone_owned_functions

-- WHICH CRM A CLONE RUNS, RECORDED RATHER THAN READ OFF ITS REPOSITORY NAME.
--
-- The fleet already holds two kinds of deployment, and nothing in this
-- database said which was which:
--
--     npc-property-dashbord                     (PRIME)
--     ├── npc-client-dashboard                  CRM-DEPENDENT  (GoHighLevel)
--     │   ├── preflight-property-group          CRM-DEPENDENT
--     │   └── npc-test-76b3b3                   CRM-DEPENDENT
--     └── npc-crm-independent-6505dc            CRM-INDEPENDENT (its own Postgres)
--
-- A CRM-dependent deployment's Clients, Client Tracker, Conversations and
-- Calendar are GoHighLevel's: the tree calls `send-ghl-message`,
-- `ghl-calendar` and `sync-ghl-conversations` directly. A CRM-independent one
-- answers all four out of its own tables, behind `crmProvider.ts` /
-- `_shared/crm/crmProvider.pure.ts`, and carries three edge functions the
-- prime does not have (`crm-calendar`, `crm-inbound-message`,
-- `crm-send-message`). The two are different TREES, and a new clone becomes
-- one or the other by the tree it is created from.
--
-- ## `clones.crm_mode`
--
-- `dependent` or `independent`. NULL means NOBODY HAS SAID — a clone
-- registered without a repository, or one created before this column. It is
-- never inferred: the provisioning wizard writes it when it creates a clone
-- under a CRM parent, the conversion writes it when it moves one, and this
-- migration writes it for the four rows the diagram above names.
--
-- A CHECK rather than an enum, because an enum value cannot be removed and
-- this vocabulary is the kind that grows a third word.
--
-- ## The two parents, on `prime_config`
--
-- A new clone of either kind is created FROM a clone, not from the prime:
--
--  * dependent   → from `npc-client-dashboard`, the prime's mirror, and it
--    then receives everything through that mirror exactly as NPC Test and
--    Preflight already do.
--  * independent → from `npc-crm-independent-6505dc`, whose tree carries the
--    CRM routing, the native CRM functions and the clone-owned files a prime
--    cascade would otherwise revert.
--
-- Recorded as two columns on the singleton rather than as repository names in
-- code, because which clone heads each line is a fact about THIS fleet and an
-- operator must be able to change it without a deploy. `on delete set null`:
-- a parent that is removed leaves the setting empty, and provisioning then
-- refuses by name rather than creating from a repository that no longer
-- exists.
--
-- Keyed on `github_repo`, like `20260920090000_clone_parent_lineage.sql`, and
-- idempotent: each write fills a value that is still NULL and never overwrites
-- one somebody has since changed.

alter table public.clones
  add column if not exists crm_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clones_crm_mode_check'
      and conrelid = 'public.clones'::regclass
  ) then
    alter table public.clones
      add constraint clones_crm_mode_check
      check (crm_mode is null or crm_mode in ('dependent', 'independent'));
  end if;
end
$$;

comment on column public.clones.crm_mode is
  'Which CRM this deployment runs: dependent (GoHighLevel, the tree of npc-client-dashboard) or independent (its own Postgres, the tree of npc-crm-independent-6505dc). NULL means nobody has said. Written by provisioning and by the CRM conversion; never inferred from a repository name.';

alter table public.prime_config
  add column if not exists crm_dependent_parent_clone_id uuid
    references public.clones(id) on delete set null;

alter table public.prime_config
  add column if not exists crm_independent_parent_clone_id uuid
    references public.clones(id) on delete set null;

-- Deleting a clone checks these for a row that still names it. `prime_config`
-- holds one row, so the scan is trivial either way; the indexes are here so
-- the foreign keys look like every other one in this schema rather than like
-- an exception somebody has to reason about (`check:fk-indexes`).
create index if not exists idx_prime_config_crm_dependent_parent_clone_id
  on public.prime_config (crm_dependent_parent_clone_id);

create index if not exists idx_prime_config_crm_independent_parent_clone_id
  on public.prime_config (crm_independent_parent_clone_id);

comment on column public.prime_config.crm_dependent_parent_clone_id is
  'The clone a new CRM-dependent clone is created from and receives cascades through. Its crm_mode must be dependent; provisioning refuses by name when it is not, or when this is NULL.';

comment on column public.prime_config.crm_independent_parent_clone_id is
  'The clone a new CRM-independent clone is created from and receives cascades through. Its crm_mode must be independent; provisioning refuses by name when it is not, or when this is NULL.';

-- ---------------------------------------------------------------------------
-- The functions a clone carries and the prime does not
-- ---------------------------------------------------------------------------
--
-- Every edge function a clone backend runs is deployed from the PRIME's
-- repository: `fetchPrimeBackendSnapshot` reads the prime's tree, and both the
-- provisioning pipeline and the self-healing deploy lane post those bundles.
-- That is correct for every function the prime declares and it is silent about
-- the rest. A CRM-independent clone's three `crm-*` functions exist in no
-- repository but its own (and its parent's), so a clone created under that
-- parent would come up with a CRM front end calling three functions its
-- project does not have.
--
-- `cloneOwnedFunctions.server.ts` deploys exactly that set from the clone's
-- OWN repository. This column is its record: which slugs it found, the
-- repository commit and the content digest it deployed, and each function's
-- result. The digest is what lets the half-hourly sweep redeploy only when the
-- bundles actually changed. NULL means the lane has never run for this clone,
-- which is different from `{"slugs": []}` — a clone that was read and owns
-- nothing.

alter table public.clone_backends
  add column if not exists clone_owned_functions jsonb;

comment on column public.clone_backends.clone_owned_functions is
  'Edge functions this clone declares and the prime does not, deployed from the clone''s own repository: {slugs, source_sha, digest, deployed_at, results}. NULL means never read; {"slugs": []} means read and owning none.';

-- ---------------------------------------------------------------------------
-- The fleet as it stands
-- ---------------------------------------------------------------------------

update public.clones
   set crm_mode = 'dependent'
 where github_repo in ('npc-client-dashboard', 'npc-test-76b3b3', 'preflight-property-group')
   and crm_mode is null;

update public.clones
   set crm_mode = 'independent'
 where github_repo = 'npc-crm-independent-6505dc'
   and crm_mode is null;

update public.prime_config
   set crm_dependent_parent_clone_id = (
         select id from public.clones where github_repo = 'npc-client-dashboard' limit 1
       )
 where crm_dependent_parent_clone_id is null;

update public.prime_config
   set crm_independent_parent_clone_id = (
         select id from public.clones where github_repo = 'npc-crm-independent-6505dc' limit 1
       )
 where crm_independent_parent_clone_id is null;
