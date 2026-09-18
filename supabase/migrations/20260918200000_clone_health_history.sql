-- @asserts table:clone_health_history
-- @asserts column:clone_health_history.status
-- @asserts column:clone_health_history.probed_at

-- A CACHE AND A HISTORY ARE DIFFERENT TABLES, AND AN SLO NEEDS THE SECOND ONE.
--
-- `clone_health_snapshots` is UNIQUE on `clone_id`. That is correct and it
-- stays: it is a five-minute cache holding exactly one row per clone, which is
-- what makes `/health` render instantly after the first probe, and
-- `readCachedCloneHealth` depends on there being one row to read.
--
-- What was wrong is everything that read it as though it were a series.
-- `computeFleetSlo` takes a windowDays between 1 and 90, selects every
-- snapshot inside the window and computes up/total per clone — and with one
-- row per clone the total is always 1, so the window parameter could not
-- change the answer: a one-day and a ninety-day SLO returned the same number.
-- `CloneHealthTimeline` calls itself a "30-day uptime sparkline" over the same
-- table, and a UNIQUE constraint means it can never hold more than one bucket.
--
-- This table is the series. It is append-only, one row per probe, and it
-- carries the reading in COLUMNS rather than in a payload — see below for why
-- that is the load-bearing part.
--
-- AN SLO READS A COLUMN, NEVER A PAYLOAD.
--
-- Measured on 18 Sep 2026, both readers resolved a clone's status as
-- `payload->>'status' ?? payload->>'health'`, and `CloneHealth` has carried
-- NEITHER key since the day it was written — the status is at
-- `payload->'uptime'->>'status'`. All three clones were up, HTTP 200 in 41–50
-- ms, and the SLO page drew 0.00% in destructive red across the fleet. Not
-- "0% or 100%": it could only ever be 0%, because the reader's expression had
-- no way to resolve anything else.
--
-- Extracting the three facts at the WRITE means the only module that can
-- misread the payload's shape is the one that defines its type. Nothing
-- downstream reaches into a blob, so nothing downstream can drift from it.
--
-- `status` IS THREE VALUES, AND `unknown` IS NOT `down`.
--
-- A clone with no deploy URL has nothing to ping, and the health card has
-- always drawn that grey rather than red — "a red pip is worse than a grey
-- one". The old arithmetic counted every such probe in the denominator, so a
-- clone that was never deployed read 0% uptime. The reading excludes `unknown`
-- from BOTH sides of the fraction, which is `rentalEvidence`'s rule that this
-- fleet has now paid for on rents, on Places lookups and on builder rankings:
-- absent is never zero.

CREATE TABLE IF NOT EXISTS public.clone_health_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  probed_at timestamptz NOT NULL DEFAULT now(),
  -- Mirrors `CloneHealth["uptime"]["status"]` exactly. A fourth value would be
  -- a reading nothing computes and the constraint refuses it.
  status text NOT NULL CHECK (status IN ('up', 'down', 'unknown')),
  -- What the ping actually saw. Null on an unknown, and null on a failure that
  -- never got a response — which is a `down` with nothing to report, not a
  -- zero.
  http_status integer,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Leading `clone_id` covers the foreign key as well as the per-clone series
-- read. Deliberately NOT partial: a partial index does not count as covering
-- an FK, which is a lesson this branch already paid for once.
CREATE INDEX IF NOT EXISTS clone_health_history_clone_probed_idx
  ON public.clone_health_history (clone_id, probed_at DESC);

-- The fleet-wide window scan, and the prune.
CREATE INDEX IF NOT EXISTS clone_health_history_probed_idx
  ON public.clone_health_history (probed_at DESC);

ALTER TABLE public.clone_health_history ENABLE ROW LEVEL SECURITY;

-- READ ONLY, DELIBERATELY. The cache beside this one grants operators `FOR
-- ALL`, and this one grants SELECT and nothing else, because an uptime SLO is
-- only meaningful over a REGULAR cadence.
--
-- Three callers of `getCloneHealth` probe on demand — the health card's
-- Refresh, the `/health` dashboard, a forced fleet walk — and those are taken
-- at moments a person chose, which in practice means when somebody already
-- suspected a problem. Folding them into the series would make "99.9% over
-- thirty days" depend on how worried people were that month.
--
-- So the only writer is the five-minute cron, running as the service role, and
-- the absence of an INSERT policy is what makes the cadence an access control
-- rather than a convention. `recordSample` in `clone-health.server.ts` is the
-- same rule stated where a developer reads it.
CREATE POLICY "Operators read clone_health_history"
  ON public.clone_health_history FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

-- SEED THE SERIES FROM THE CACHE, ONCE.
--
-- The cache holds each clone's CURRENT probe and nothing older, so there is no
-- history to recover here — but those rows are real probes with real
-- `probed_at` stamps, and carrying them across means the SLO is not empty on
-- the first render after this lands. One sample is one sample; the reading
-- says so, because coverage travels with it.
--
-- The extraction is the same path the writer now uses, which is the only path:
-- `payload -> 'uptime' ->> 'status'`. An older row whose payload predates that
-- shape resolves to NULL and is filed as `unknown` rather than guessed at.
INSERT INTO public.clone_health_history (clone_id, probed_at, status, http_status, latency_ms)
SELECT
  s.clone_id,
  s.probed_at,
  CASE
    WHEN s.payload -> 'uptime' ->> 'status' IN ('up', 'down') THEN s.payload -> 'uptime' ->> 'status'
    ELSE 'unknown'
  END,
  NULLIF(s.payload -> 'uptime' ->> 'httpStatus', '')::integer,
  NULLIF(s.payload -> 'uptime' ->> 'latencyMs', '')::integer
FROM public.clone_health_snapshots s
WHERE NOT EXISTS (
  SELECT 1 FROM public.clone_health_history h
  WHERE h.clone_id = s.clone_id AND h.probed_at = s.probed_at
);

-- @asserts table:clone_health_daily

-- THE READING IS AGGREGATED IN THE DATABASE, NOT IN AN EDGE FUNCTION.
--
-- Three clones probed every five minutes is 864 rows a day: 26k over a
-- thirty-day window and 78k over the widest one the page offers. At fifty
-- clones the ninety-day question is 1.3 million rows. Pulling those into a
-- function to count them is the shape of a mistake that only shows up once the
-- fleet has grown, which is the worst time for it to show up.
--
-- A regular view rather than a materialized one, deliberately. A materialized
-- view needs a refresh, a refresh needs a schedule, and this platform's own
-- record (`THE_CLONING_ENGINE.md`: six pg_cron jobs never scheduled at all,
-- silently) is the argument against making a reading depend on a worker
-- nobody notices has stopped. Computed on read against
-- `clone_health_history_clone_probed_idx`, this is an index scan and a group.
--
-- `security_invoker = on` is load-bearing: without it the view runs as its
-- owner and the operator-only policy on the table underneath stops applying.
-- A view is not a way around RLS and must never become one.
--
-- Buckets are UTC calendar days. The window filter is therefore "the last N
-- calendar days" rather than "the last N x 24 hours", which is what a
-- sparkline is anyway — and the reading still carries the first and last probe
-- it actually saw, so nothing about the span is rounded in what a reader is
-- told.
CREATE OR REPLACE VIEW public.clone_health_daily
WITH (security_invoker = on) AS
SELECT
  h.clone_id,
  (h.probed_at AT TIME ZONE 'UTC')::date AS day,
  count(*) FILTER (WHERE h.status = 'up')      AS up,
  count(*) FILTER (WHERE h.status = 'down')    AS down,
  -- Probes that reached no conclusion — a clone with nothing to ping. Counted
  -- and reported, and in neither side of any fraction.
  count(*) FILTER (WHERE h.status = 'unknown') AS unmeasured,
  min(h.probed_at) AS first_probed_at,
  max(h.probed_at) AS last_probed_at,
  -- What the clone was on this day's LAST probe. Carried as a column so the
  -- "what is it right now" reading never has to reach into a payload either —
  -- which is the whole failure this table exists to close, and it would be a
  -- poor joke to reintroduce it one field to the right.
  (array_agg(h.status ORDER BY h.probed_at DESC))[1] AS last_status
FROM public.clone_health_history h
GROUP BY h.clone_id, (h.probed_at AT TIME ZONE 'UTC')::date;
