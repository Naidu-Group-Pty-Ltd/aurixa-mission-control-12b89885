-- Re-rate the brokered calls that were already booked as free.
--
-- @asserts none:re-rates existing rows and creates no object — the effect is
-- @asserts none:a data correction, and every assertion kind here probes for a
-- @asserts none:table, column, cron job or row count that would exist either way
--
-- Rating happens once, at insert. The events written before the rule was
-- fixed are frozen wrong, and no later call corrects them — so the money
-- already spent stays unrecoverable unless it is repaired here.
--
-- Measured 8 Sep 2026: three rows, all NPC Test, all `call_status = 'success'`
-- against `DIDIT_API_KEY` while that clone's secret stands `withheld` — one
-- ID verification, one passive liveness, one face match from the end-to-end
-- loop check. Didit charged the prime USD 0.30 for them.
--
-- Two rules the repair follows.
--
-- **It re-rates, it never re-prices.** Quantity, occurrence, tenant, clone and
-- idempotency key are untouched; only the three fields the broken rule
-- decided (`billing_reason`, `billable`, and the two money columns) are
-- recomputed, from the SAME rate row a correct insert would have read. A
-- repair that also moved a price would be indistinguishable from a billing
-- change nobody approved.
--
-- **The rollup moves by the delta, never by recomputation.** `api_usage_rollups`
-- is an accumulator over every event in a period, and rebuilding it from the
-- events this migration can see would silently drop anything pruned by
-- retention. Adding the difference is correct whatever else the period holds.
--
-- Idempotent by construction: the predicate selects rows still rated
-- `no_key`, and the update takes them out of it. A second run repairs nothing
-- and moves no rollup.

BEGIN;

CREATE TEMP TABLE _rerate ON COMMIT DROP AS
SELECT
  e.id,
  e.tenant_id,
  e.period_start,
  e.secret_name,
  e.rated_micros                                   AS old_rated,
  e.cost_micros                                    AS old_cost,
  e.quantity,
  ROUND(e.quantity * r.resale_micros_per_unit, 6)  AS new_rated,
  ROUND(e.quantity * r.cost_micros_per_unit, 6)    AS new_cost
FROM public.api_usage_events e
JOIN public.clone_backend_secrets s
  ON s.clone_id = e.clone_id AND s.name = e.secret_name
JOIN public.api_provider_rates r
  ON r.secret_name = e.secret_name AND r.is_active AND r.is_billable
-- The per-OPERATION price where one exists, the base row where it does not.
-- This migration is ordered after `per_operation_vendor_rates` precisely so a
-- repaired row is priced by the same rule a fresh one would be; re-rating at
-- the flat rate first and correcting afterwards would book, and then have to
-- unbook, a charge that was never owed.
LEFT JOIN public.api_provider_rate_features f
  ON f.secret_name = e.secret_name AND f.feature = e.feature
WHERE e.billing_reason = 'no_key'
  AND e.call_status = 'success'
  AND e.clone_id IS NOT NULL
  -- Either route to "the prime paid": the broker said so at the time, or the
  -- clone demonstrably holds no forwarded key now.
  -- Compared as jsonb, never cast: `::boolean` RAISES on a string it cannot
  -- read, and this predicate scans every event ever written — one malformed
  -- metadata value would abort the whole migration.
  AND (s.status = 'withheld' OR (e.metadata->'brokered') = 'true'::jsonb);

UPDATE public.api_usage_events e
   SET billing_reason = 'brokered',
       billable       = true,
       rated_micros   = x.new_rated,
       cost_micros    = x.new_cost
  FROM _rerate x
 WHERE e.id = x.id;

UPDATE public.api_usage_rollups ru
   SET billable_quantity   = ru.billable_quantity   + d.q,
       gross_charge_micros = ru.gross_charge_micros + d.rated_delta,
       cost_micros         = ru.cost_micros         + d.cost_delta
  FROM (
    SELECT tenant_id,
           period_start,
           secret_name,
           SUM(quantity)             AS q,
           SUM(new_rated - old_rated) AS rated_delta,
           SUM(new_cost  - old_cost)  AS cost_delta
      FROM _rerate
     GROUP BY tenant_id, period_start, secret_name
  ) d
 WHERE ru.tenant_id   = d.tenant_id
   AND ru.period_start = d.period_start
   AND ru.secret_name  = d.secret_name;

DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM _rerate;
  RAISE NOTICE 'brokered usage backlog re-rated: % event(s)', _n;
END $$;

COMMIT;
