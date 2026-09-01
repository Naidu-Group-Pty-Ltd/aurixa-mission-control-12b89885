-- @asserts column:clone_backends.retry_after
--
-- A job refused on a VENDOR QUOTA must wait before asking again.
--
-- The drain claims a pending row every minute. When the GitHub App
-- installation's hourly quota is exhausted, each of those claims spends a
-- request that is refused and parks the row again — sixty refused calls an
-- hour, which is what keeps the quota exhausted. The engine was competing
-- with its own retry frequency.
--
-- NULL means claimable now, which is what every existing row already means.
alter table public.clone_backends
  add column if not exists retry_after timestamptz;

comment on column public.clone_backends.retry_after is
  'Do not claim this job before this time. Set when an upstream vendor quota refused the run, so the retry does not spend the quota it is waiting on. NULL = claimable now.';
