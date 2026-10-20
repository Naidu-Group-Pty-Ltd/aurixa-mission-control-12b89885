-- @asserts table:clone_function_deploys
-- @asserts column:clone_function_deploys.digest
-- @asserts column:clone_function_deploys.function_version
-- What Mission Control itself deployed to each clone's project, bundle by
-- bundle: the digest of exactly what it sent, and which deploy that was.
--
-- The edge-function deploy lane read "already delivered" off the clone's own
-- timestamps alone. A timestamp says a copy landed, never which tree it came
-- from, so every prime merge restarted the lane's generation and re-owed every
-- bundle — about 400 of them, at about one bundle a pass. Measured 20 Oct 2026
-- over the prime's 340 first-parent commits since 12 Oct: re-owing what each
-- commit actually changed costs 1,383 bundle deploys, re-owing everything on
-- every commit costs 135,763. So no run could finish, every clone's run parked
-- between 12 and 13 Oct, and no clone has received a function since (F23 in
-- docs/HANDOFF_2026-10-19_CONTINUED.md).
--
-- A row here says: this lane deployed `slug` with bundle `digest`, from prime
-- commit `source_sha`, and the project answered with function `function_id`
-- at `function_version`. The lane treats the clone's copy as current only
-- where the prime's digest for that bundle still equals this one AND the
-- clone still lists that very function id at that very version. Every deploy
-- increments the version, so a copy replaced since by anything else is owed
-- again. `src/server/edgeBundleLedger.pure.ts` carries the rule.
--
-- `deployed_from`/`deployed_to` are when the deploy call ran, by Mission
-- Control's clock. They prove nothing — a clock window is exactly where a
-- second writer lands — and are kept so an operator can line a row up with
-- the run that wrote it.
--
-- Additive, and read by the lane only where it exists: until this migration
-- has run, the lane reads no ledger and behaves exactly as it did before.
create table if not exists public.clone_function_deploys (
  clone_id uuid not null references public.clones(id) on delete cascade,
  slug text not null,
  digest text not null,
  source_sha text,
  function_id text,
  function_version integer,
  deployed_from timestamptz not null,
  deployed_to timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (clone_id, slug),
  constraint clone_function_deploys_window check (deployed_to >= deployed_from),
  constraint clone_function_deploys_version check (function_version is null or function_version >= 0)
);

comment on table public.clone_function_deploys is
  'One row per (clone, edge function) the edge_function_deploy lane deployed: the bundle digest it sent and the deploy the project answered with. Read to skip bundles provably current on the clone; written only by that lane.';
comment on column public.clone_function_deploys.digest is
  'bundleDigest() of what the deploy sent: slug, entrypoint, import map, the verify_jwt actually sent, and every pruned file by git blob id (src/server/functionBundleDigest.pure.ts).';
comment on column public.clone_function_deploys.function_version is
  'The version the Management API answered the deploy with. The clone''s copy is this deploy only while the project still lists function_id at this version; NULL proves nothing.';
comment on column public.clone_function_deploys.deployed_from is
  'Mission Control''s clock just before the deploy call. With deployed_to, for lining a row up with its run; proves nothing about the clone''s copy.';

alter table public.clone_function_deploys enable row level security;

-- Server-side only: the deploy lane holds the service role. No policy is
-- granted to anon or authenticated, so a browser cannot read which bundles a
-- tenant runs, nor write a row that would make the lane skip a deploy.
revoke all on public.clone_function_deploys from anon, authenticated;
