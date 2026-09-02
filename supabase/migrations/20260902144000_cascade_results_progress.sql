-- @asserts column:cascade_results.progress
--
-- Where a clone's cascade pass got to, so the next pass can carry on.
--
-- A first module-scope cascade to `preflight-property-group` is 353 files:
-- one content read and one blob create each, two tree listings, the deletion
-- probes, then the tree, the commit and the pull request. Measured 2 Sep
-- 2026 (14:10 and 14:14 UTC): the pass was still preparing blobs when the
-- hook that runs it was abandoned at 60 seconds, twice. The invocation budget
-- stops BETWEEN clones; a single clone whose pass is larger than one tick was
-- cut, reclaimed ten minutes later and retried whole — the same 353 reads
-- and creates again — until its attempts ran out.
--
-- The blobs a cut pass created are not lost: they exist in the clone's
-- repository, addressed by SHA, whether or not a tree ever referenced them.
-- What was lost was the LIST. This column keeps it: for every path prepared,
-- the blob SHA the clone now holds and the prime blob SHA it was made from,
-- keyed by the prime commit the pass was for. The next pass reuses every
-- entry whose prime SHA still matches and reads nothing for it.
--
-- Written only on the real path — `processClone` stays write-free on a dry
-- run, so the engine supplies the writer — and cleared when the clone's
-- result reaches any finished status, because progress toward a proposal
-- that has been made is not progress any more.
alter table public.cascade_results
  add column if not exists progress jsonb;

comment on column public.cascade_results.progress is
  'Prepared blobs of an unfinished pass: {version, source_sha, prepared: {path: {blob, prime}}, total}. Present only while the row is queued after a pass the invocation budget stopped inside this clone; the next pass reuses entries whose prime SHA still matches. Cleared on any finished status.';
