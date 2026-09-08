-- A brokered vendor call spends the prime's money. It must bill the tenant.
--
-- @asserts check:api_usage_events.billing_reason=brokered
--
-- Measured 8 Sep 2026 on NPC Test: a full identity verification ran through
-- the broker — ID verification, passive liveness and face match, all three
-- answered 200 by the vendor — and Didit charged the prime USD 0.30. Mission
-- Control wrote three usage rows, correctly attributed to the clone, and
-- rated every one of them `no_key`, `billable = false`, `cost_micros = 0`.
--
-- The cause is one CASE arm. `resolve_api_key_billability` reads
-- `clone_backend_secrets.status` and charges only `inherited`:
--
--     WHEN 'inherited' THEN 'inherited'   -- piggybacking on ours -> billable
--     WHEN 'set'       THEN 'byok'
--     ELSE 'no_key'
--
-- `withheld` — the status that exists so a clone can STOP holding a forwarded
-- vendor key — lands in the ELSE. That inference was correct before the
-- broker: no forwarded key meant the clone could not spend our money. Under
-- the broker it is exactly inverted. `withheld` is now the one status that
-- GUARANTEES the prime paid, because the credential stays here and the CALL
-- travels instead.
--
-- Two independent routes to the same answer, because neither covers the
-- other. The broker STATES `brokered` in the event metadata — it is the party
-- that made the call, so it is the only party that knows, and it can be right
-- about a clone whose ledger row says anything at all. The status column
-- catches usage that reaches the ledger by some other path while the clone is
-- demonstrably stripped of the key. A row needs only one of them.
--
-- `brokered` is its own reason rather than a reuse of `inherited` because the
-- two record different facts: one credential travelled to the tenant, the
-- other never left this project. An operator asking the ledger "which tenants
-- are holding our keys?" must not be told a brokered tenant is.

BEGIN;

-- 1. The vocabulary. Without this the new reason is refused by the column and
--    every brokered call would fail to meter at all — strictly worse than
--    metering it free.
ALTER TABLE public.api_usage_events
  DROP CONSTRAINT IF EXISTS api_usage_events_billing_reason_check;
ALTER TABLE public.api_usage_events
  ADD CONSTRAINT api_usage_events_billing_reason_check
  CHECK (billing_reason IN (
    'inherited','brokered','byok','no_key',
    'unknown_secret','not_billable','error_call','rate_missing'));

-- 2. The ledger route.
CREATE OR REPLACE FUNCTION public.resolve_api_key_billability(_clone_id uuid, _secret_name text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _status text;
BEGIN
  IF _clone_id IS NULL THEN RETURN 'no_key'; END IF;
  SELECT status INTO _status
    FROM public.clone_backend_secrets
   WHERE clone_id = _clone_id AND name = _secret_name;
  IF _status IS NULL THEN RETURN 'unknown_secret'; END IF;
  RETURN CASE _status
    WHEN 'inherited' THEN 'inherited'
    WHEN 'set'       THEN 'byok'
    -- The key was deliberately taken off this clone, so a call it makes is
    -- one Mission Control made for it, on our credential.
    WHEN 'withheld'  THEN 'brokered'
    -- 'missing', 'failed' and 'authorised_no_value' stay unbillable: each
    -- means no working credential exists on either side of the broker.
    ELSE 'no_key'
  END;
END
$function$;

-- 3. The rating. `brokered` charges exactly as `inherited` does.
CREATE OR REPLACE FUNCTION public.record_api_usage_event(_tenant_id uuid, _clone_id uuid, _secret_name text, _quantity numeric, _idempotency_key text, _model text DEFAULT NULL::text, _feature text DEFAULT NULL::text, _call_status text DEFAULT 'success'::text, _occurred_at timestamp with time zone DEFAULT now(), _metadata jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _rate public.api_provider_rates%ROWTYPE; _existing public.api_usage_events%ROWTYPE; _reason text; _billable boolean:=false; _rated numeric(18,6):=0; _cost numeric(18,6):=0; _period date; _provider text; _unit text; _currency text:='AUD'; _event_id uuid; _qty numeric(18,4):=GREATEST(COALESCE(_quantity,0),0); _when timestamptz:=COALESCE(_occurred_at,now()); _brokered boolean:=((_metadata->'brokered') = 'true'::jsonb); _cost_per numeric(18,6); _resale_per numeric(18,6);
BEGIN IF _tenant_id IS NULL OR _secret_name IS NULL OR _idempotency_key IS NULL THEN RETURN jsonb_build_object('ok',false,'error','missing_required_argument'); END IF;
SELECT * INTO _existing FROM public.api_usage_events WHERE tenant_id=_tenant_id AND idempotency_key=_idempotency_key;
IF FOUND THEN RETURN jsonb_build_object('ok',true,'duplicate',true,'event_id',_existing.id,'billable',_existing.billable,'billing_reason',_existing.billing_reason,'rated_micros',_existing.rated_micros); END IF;
SELECT COALESCE(t.current_period_start::date,date_trunc('month',_when)::date) INTO _period FROM public.tenants t WHERE t.id=_tenant_id;
IF _period IS NULL THEN RETURN jsonb_build_object('ok',false,'error','tenant_not_found'); END IF; IF _when::date<_period THEN _period:=date_trunc('month',_when)::date; END IF;
SELECT * INTO _rate FROM public.api_provider_rates WHERE secret_name=_secret_name AND is_active;
IF NOT FOUND THEN _provider:='unknown';_unit:='request';_reason:='rate_missing'; ELSE _provider:=_rate.provider;_unit:=_rate.unit;_currency:=_rate.currency;_reason:=public.resolve_api_key_billability(_clone_id,_secret_name);
  -- Per-OPERATION price, where the vendor charges differently per operation
  -- under one credential. Absent an override the base row applies unchanged,
  -- which is every other secret in the catalog.
  _cost_per:=NULL; _resale_per:=NULL;
  IF _feature IS NOT NULL THEN
    SELECT f.cost_micros_per_unit, f.resale_micros_per_unit INTO _cost_per, _resale_per
      FROM public.api_provider_rate_features f
     WHERE f.secret_name=_secret_name AND f.feature=_feature;
  END IF;
  _cost_per:=COALESCE(_cost_per,_rate.cost_micros_per_unit);
  _resale_per:=COALESCE(_resale_per,_rate.resale_micros_per_unit);
  -- The broker's own assertion. It made the call, so it is the only party
  -- that KNOWS the route; the ledger lookup above is the independent second
  -- route and either one is sufficient. Never accepted from a clone —
  -- `normalizeEvent` strips the key at the public reporting boundary.
  --
  -- Compared as jsonb rather than cast. `(_metadata->>'brokered')::boolean`
  -- RAISES on any string Postgres cannot read as a boolean, and metadata is
  -- free-form — so one malformed value would abort this function and stop
  -- every tenant's usage from being recorded at all. Only a real JSON `true`
  -- matches; anything else is simply not brokered.
  IF _brokered AND _clone_id IS NOT NULL THEN _reason:='brokered'; END IF;
IF NOT _rate.is_billable THEN _reason:='not_billable'; ELSIF _call_status='error' THEN _reason:='error_call'; END IF;
IF _reason IN('inherited','brokered') THEN _billable:=true;_rated:=ROUND(_qty*_resale_per,6); END IF; IF _reason IN('inherited','brokered','error_call','not_billable') THEN _cost:=ROUND(_qty*_cost_per,6); END IF; END IF;
INSERT INTO public.api_usage_events(tenant_id,clone_id,secret_name,provider,unit,quantity,model,feature,call_status,billable,billing_reason,rated_micros,cost_micros,currency,period_start,occurred_at,idempotency_key,metadata)
VALUES(_tenant_id,_clone_id,_secret_name,_provider,_unit,_qty,_model,_feature,COALESCE(_call_status,'success'),_billable,_reason,_rated,_cost,_currency,_period,_when,_idempotency_key,COALESCE(_metadata,'{}'::jsonb)) RETURNING id INTO _event_id;
INSERT INTO public.api_usage_rollups(tenant_id,clone_id,period_start,secret_name,provider,unit,currency,gross_quantity,billable_quantity,byok_quantity,event_count,error_count,gross_charge_micros,cost_micros,first_seen_at,last_seen_at)
VALUES(_tenant_id,_clone_id,_period,_secret_name,_provider,_unit,_currency,_qty,CASE WHEN _billable THEN _qty ELSE 0 END,CASE WHEN _reason='byok' THEN _qty ELSE 0 END,1,CASE WHEN _call_status='error' THEN 1 ELSE 0 END,_rated,_cost,_when,_when)
ON CONFLICT(tenant_id,period_start,secret_name) DO UPDATE SET gross_quantity=api_usage_rollups.gross_quantity+EXCLUDED.gross_quantity,billable_quantity=api_usage_rollups.billable_quantity+EXCLUDED.billable_quantity,byok_quantity=api_usage_rollups.byok_quantity+EXCLUDED.byok_quantity,event_count=api_usage_rollups.event_count+1,error_count=api_usage_rollups.error_count+EXCLUDED.error_count,gross_charge_micros=api_usage_rollups.gross_charge_micros+EXCLUDED.gross_charge_micros,cost_micros=api_usage_rollups.cost_micros+EXCLUDED.cost_micros,clone_id=COALESCE(api_usage_rollups.clone_id,EXCLUDED.clone_id),last_seen_at=GREATEST(api_usage_rollups.last_seen_at,EXCLUDED.last_seen_at);
RETURN jsonb_build_object('ok',true,'duplicate',false,'event_id',_event_id,'billable',_billable,'billing_reason',_reason,'rated_micros',_rated,'period_start',_period); END $function$;

COMMIT;
