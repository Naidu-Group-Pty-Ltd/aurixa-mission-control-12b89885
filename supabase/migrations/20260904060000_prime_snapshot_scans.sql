-- @asserts table:prime_snapshot_scans
-- What the prime repo contains at a commit, cached so a pass stops re-buying it.
--
-- Two facts about the prime — the edge-function secret names and the declared
-- function slugs — are pure functions of (repo, commit). Nothing about a clone
-- can change them. The engine was recomputing both on EVERY provisioning pass,
-- and after the secret scan was widened to read every bundle the prime defines
-- (~1,033 files across 423 bundles, about thirteen batched GraphQL requests
-- plus the decode) that recomputation became the dominant fixed cost of a pass.
--
-- Measured 4 Sep 2026, on the two clones this engine was converging: every
-- invocation processed exactly ONE job and budget-paused before it reached a
-- stage that had work left — one at `deploying edge functions`, the other at
-- `replicating the pg_cron schedule`. Neither had advanced in half an hour.
-- That is not slow progress, it is a LIVELOCK: a fixed cost paid before the
-- first stage, large enough that the 50s invocation budget is gone before the
-- remaining work starts, on every tick, for ever.
--
-- Caching by commit is what makes the cost proportional to the prime changing
-- rather than to the number of passes. The key is (repo, git_sha) and not the
-- branch: a branch moves, and a scan attributed to a moved branch is a scan of
-- a tree nobody has.
--
-- Only a COMPLETE scan is ever written. A snapshot taken with the function
-- source omitted knows no secret names, and recording its empty list here
-- would teach every later pass that the prime has none — the failure this
-- table exists to prevent, made permanent.
create table if not exists public.prime_snapshot_scans (
  repo text not null,
  git_sha text not null,
  secret_names jsonb not null,
  declared_function_slugs jsonb not null,
  scanned_at timestamptz not null default now(),
  primary key (repo, git_sha)
);

comment on table public.prime_snapshot_scans is
  'Per-commit cache of what the prime repository declares: edge-function secret names and function slugs. Written only from a snapshot that fetched the whole function source; read to let a later provisioning pass skip that fetch.';
comment on column public.prime_snapshot_scans.secret_names is
  'Every Deno.env.get() name referenced by any function bundle the repo defines at this commit, minus the SUPABASE_* values the platform injects. Names only — a value is never read, stored or transported.';
comment on column public.prime_snapshot_scans.declared_function_slugs is
  'Every function slug the repo declares with a runnable entrypoint at this commit. What a clone is contracted to carry, which is not the same set as what the prime project happens to be running.';

alter table public.prime_snapshot_scans enable row level security;

-- Server-side only: every reader and writer is an edge/server route holding
-- the service role. No policy is granted to anon or authenticated, so the
-- table is unreachable from a browser and RLS is on rather than merely
-- claimed.
revoke all on public.prime_snapshot_scans from anon, authenticated;
