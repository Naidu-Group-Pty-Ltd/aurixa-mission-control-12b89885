-- A vendor cost the platform absorbs, because the tenant already paid in tokens.
--
-- @asserts column:api_provider_rates.absorbed
-- @asserts check:api_usage_events.billing_reason=absorbed
--
-- Didit bills Aurixa USD 0.30 for a complete identity verification —
-- `id_verification_api` 0.20, `passive_liveness_api` 0.05,
-- `face_match_api` 0.05, none of which carries a free tier (measured against
-- the live account 8 Sep 2026). The commercial decision is that Aurixa
-- shoulders that money and the workspace pays in TOKENS instead: 5 for a
-- consumed attempt and 5 more where the identity is actually verified, priced
-- in the prime's `_shared/aml/verificationTokenPrice.pure.ts`.
--
-- ## Why this is not `is_billable = false`
--
-- `not_billable` already records cost and charges nothing, so it would
-- produce the right numbers. It would say the wrong thing. That flag means
-- "platform overhead rather than tenant usage" — a shared infra key, our own
-- webhook secret, a free-tier service — and Didit is none of those: it is
-- genuine, per-customer, per-tenant usage of a paid vendor. An operator
-- asking the ledger "what are we spending on tenants that we deliberately do
-- not recharge in money?" must get a different answer from "what is our own
-- overhead?", and the next person to read a zero here must be told it is
-- priced elsewhere rather than left to conclude the meter is broken.
--
-- That is the same reasoning that made `brokered` its own code rather than a
-- reuse of `inherited` (20260908040000): the numbers agreeing is not the same
-- as the ledger being true.
--
-- ## What it does and does not touch
--
-- `absorbed` replaces `inherited` and `brokered` only — the two reasons in
-- which the prime's credential was spent. A `byok` call on an absorbed vendor
-- stays `byok` (the tenant spent its own money and there is nothing to
-- absorb), and a failed call stays `error_call`, which is asked first.
--
-- Cost is still recorded, per operation, so the margin report keeps reading
-- the real 0.30. Only the charge goes.

BEGIN;

-- 1. The flag. Off everywhere by default, so no existing rate changes.
ALTER TABLE public.api_provider_rates
  ADD COLUMN IF NOT EXISTS absorbed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.api_provider_rates.absorbed IS
  'The platform pays this vendor and does not recharge the money, because the tenant is charged for the same work in tokens. Cost is still recorded; the charge is zero and the event reads `absorbed`. Distinct from is_billable=false, which means platform overhead rather than tenant usage.';

-- 2. The vocabulary. Without this the new reason is refused by the column and
--    an absorbed call would fail to meter at all — strictly worse than
--    metering it free.
ALTER TABLE public.api_usage_events
  DROP CONSTRAINT IF EXISTS api_usage_events_billing_reason_check;
ALTER TABLE public.api_usage_events
  ADD CONSTRAINT api_usage_events_billing_reason_check
  CHECK (billing_reason IN (
    'inherited','brokered','absorbed','byok','no_key',
    'unknown_secret','not_billable','error_call','rate_missing'));

-- 3. The rating.
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
-- Order matters and each arm is deliberate. `not_billable` is a fact about
-- the KEY and outranks everything. A failed call is `error_call` whatever the
-- money model, because we do not charge for nothing delivered. `absorbed`
-- then replaces only the two reasons in which the prime's credential was
-- spent — a `byok` call on an absorbed vendor spent the tenant's own money
-- and there is nothing for us to absorb.
IF NOT _rate.is_billable THEN _reason:='not_billable';
ELSIF _call_status='error' THEN _reason:='error_call';
ELSIF _rate.absorbed AND _reason IN ('inherited','brokered') THEN _reason:='absorbed';
END IF;
IF _reason IN('inherited','brokered') THEN _billable:=true;_rated:=ROUND(_qty*_resale_per,6); END IF; IF _reason IN('inherited','brokered','absorbed','error_call','not_billable') THEN _cost:=ROUND(_qty*_cost_per,6); END IF; END IF;
INSERT INTO public.api_usage_events(tenant_id,clone_id,secret_name,provider,unit,quantity,model,feature,call_status,billable,billing_reason,rated_micros,cost_micros,currency,period_start,occurred_at,idempotency_key,metadata)
VALUES(_tenant_id,_clone_id,_secret_name,_provider,_unit,_qty,_model,_feature,COALESCE(_call_status,'success'),_billable,_reason,_rated,_cost,_currency,_period,_when,_idempotency_key,COALESCE(_metadata,'{}'::jsonb)) RETURNING id INTO _event_id;
INSERT INTO public.api_usage_rollups(tenant_id,clone_id,period_start,secret_name,provider,unit,currency,gross_quantity,billable_quantity,byok_quantity,event_count,error_count,gross_charge_micros,cost_micros,first_seen_at,last_seen_at)
VALUES(_tenant_id,_clone_id,_period,_secret_name,_provider,_unit,_currency,_qty,CASE WHEN _billable THEN _qty ELSE 0 END,CASE WHEN _reason='byok' THEN _qty ELSE 0 END,1,CASE WHEN _call_status='error' THEN 1 ELSE 0 END,_rated,_cost,_when,_when)
ON CONFLICT(tenant_id,period_start,secret_name) DO UPDATE SET gross_quantity=api_usage_rollups.gross_quantity+EXCLUDED.gross_quantity,billable_quantity=api_usage_rollups.billable_quantity+EXCLUDED.billable_quantity,byok_quantity=api_usage_rollups.byok_quantity+EXCLUDED.byok_quantity,event_count=api_usage_rollups.event_count+1,error_count=api_usage_rollups.error_count+EXCLUDED.error_count,gross_charge_micros=api_usage_rollups.gross_charge_micros+EXCLUDED.gross_charge_micros,cost_micros=api_usage_rollups.cost_micros+EXCLUDED.cost_micros,clone_id=COALESCE(api_usage_rollups.clone_id,EXCLUDED.clone_id),last_seen_at=GREATEST(api_usage_rollups.last_seen_at,EXCLUDED.last_seen_at);
RETURN jsonb_build_object('ok',true,'duplicate',false,'event_id',_event_id,'billable',_billable,'billing_reason',_reason,'rated_micros',_rated,'period_start',_period); END $function$;

COMMIT;
