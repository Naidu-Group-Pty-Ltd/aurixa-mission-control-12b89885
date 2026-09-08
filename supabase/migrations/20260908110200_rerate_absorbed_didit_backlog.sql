-- Back out the money already charged for the three Didit calls.
--
-- @asserts none:re-rates existing rows and creates no object — the effect is
-- @asserts none:a data correction, and every assertion kind here probes for a
-- @asserts none:thing that exists. It is asserted by the block at the end,
-- @asserts none:which fails the migration if any charged absorbed row remains.
--
-- Three events exist, from the end-to-end loop test on NPC Test (8 Sep 2026,
-- 03:45 UTC): one `id-verification`, one `passive-liveness`, one `face-match`,
-- all answered 200 by the vendor. 20260908040000 correctly stopped them
-- billing nobody and 20260908040300 rated them at the measured per-operation
-- prices — USD 0.30 cost against USD 0.60 charged.
--
-- That charge is now wrong, and it is wrong in the direction that matters: the
-- workspace is to pay in tokens, so leaving the money on the ledger bills the
-- same verification twice. The COST stays exactly as it is — Aurixa really did
-- spend USD 0.30 and the margin report must keep saying so.
--
-- The rollup is adjusted by the DELTA of the rows this touches rather than
-- recomputed from the events table, for the reason 20260908040300 gives: a
-- recompute silently rewrites every other reason's contribution to the same
-- (tenant, period, secret) line if any of them is out of step, which turns a
-- narrow correction into an unreviewable one.

BEGIN;

CREATE TEMP TABLE _absorb ON COMMIT DROP AS
SELECT e.id, e.tenant_id, e.period_start, e.secret_name,
       e.quantity        AS qty,
       e.rated_micros    AS old_rated
  FROM public.api_usage_events e
  JOIN public.api_provider_rates r ON r.secret_name = e.secret_name
 WHERE r.absorbed
   AND e.billing_reason IN ('inherited', 'brokered')
   AND e.call_status = 'success';

UPDATE public.api_usage_events e
   SET billing_reason = 'absorbed',
       billable       = false,
       rated_micros   = 0
  FROM _absorb a
 WHERE e.id = a.id;

UPDATE public.api_usage_rollups u
   SET gross_charge_micros = GREATEST(u.gross_charge_micros - d.charge, 0),
       billable_quantity   = GREATEST(u.billable_quantity   - d.qty,    0)
  FROM (
    SELECT tenant_id, period_start, secret_name,
           SUM(old_rated) AS charge, SUM(qty) AS qty
      FROM _absorb GROUP BY tenant_id, period_start, secret_name
  ) d
 WHERE u.tenant_id   = d.tenant_id
   AND u.period_start = d.period_start
   AND u.secret_name  = d.secret_name;

DO $$
DECLARE _left integer;
BEGIN
  SELECT count(*) INTO _left
    FROM public.api_usage_events e
    JOIN public.api_provider_rates r ON r.secret_name = e.secret_name
   WHERE r.absorbed AND e.billable;
  IF _left > 0 THEN
    RAISE EXCEPTION 're-rate did not converge: % absorbed-vendor event(s) still billable', _left;
  END IF;
END $$;

COMMIT;
