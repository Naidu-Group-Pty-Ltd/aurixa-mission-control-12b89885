-- @asserts rpc:api_usage_period_start
-- @asserts rpc:api_usage_period_end
-- @asserts rpc:api_usage_closable_periods
--
-- Usage is filed under the period it falls in, and a period that has ended
-- stops collecting it (key audit R7, found 30 Oct 2026 while dry-running R6).
--
-- ## What was measured, 30 Oct 2026 (read-only)
--
-- - A tenant's billing anchor (`tenants.current_period_start`) moves only when
--   Stripe renews a subscription (`advance_tenant_billing_period`). Ten of the
--   twelve anchors are a month old or more and still read the day each plan
--   started: 19 May, and 8, 16, 18 and 19 Sep.
-- - record_api_usage_event filed every event under the anchor. NPC Test, the
--   dashboard and Preflight (8 Sep) and the CRM (19 Sep) kept filing into a
--   period that ended on 8 and 19 Oct: about 16,000 Airtable requests each
--   since then. A closed charge is never recomputed, so none of that usage
--   could ever be billed. The rollup for 8 Sep read 7,770 requests when its
--   charge closed on 8 Oct and 24,200 on 30 Oct.
-- - Every rollup equalled the sum of its events, field for field (quantity,
--   billable, BYOK, count, errors, charge, cost, first and last seen). No
--   event has been purged: the oldest is 8 Sep and the purge keeps 400 days.
-- - The three 8 Sep charges read USD, but each holds one line: AIRTABLE_TOKEN,
--   rated in AUD. The old close labelled a charge with the currency of the
--   last rollup it read, and DIDIT_API_KEY sorts after it. 20261030090000
--   said the reverse (that each total was the Didit line); this corrects it.
-- - Under 20261030090000's per-currency close, the 04:20 UTC sweep on 30 Oct
--   would have closed a second, AUD charge for each 8 Sep period from its
--   grown rollup (96, 97 and 96 cents) and put NPC Test's on its Stripe
--   customer: three weeks of October billed as September.
-- - The fleet overview asks for the first day of the calendar month, which
--   is no tenant's period start, so it showed no usage at all.
--
-- ## What this does
--
-- 1. api_usage_period_start(anchor, instant) is the period an instant falls
--    in: the anchor plus whole months, each counted from the anchor (a 31st
--    anchor gives 28 Feb, then 31 Mar). Before the anchor, or with none, it is
--    the calendar month, as before. api_usage_period_end gives where the next
--    period starts.
-- 2. record_api_usage_event files by it. Nothing else in it changes.
-- 3. Each event filed under a period it does not fall in is re-filed, and the
--    rollups on both sides are rebuilt from their events. Only events that
--    feed a rollup move: Mission Control's GitHub meter writes rows without
--    one. Each tenant's per-secret totals are checked unchanged.
-- 4. A charge whose lines are all rated in one currency is labelled with it,
--    and its cost is that currency's. The three 8 Sep charges become AUD;
--    their amounts and lines stay, and NPC Test's loses the USD 0.30 of Didit
--    cost the old close had added to it.
-- 5. close_api_usage_period ends a period where the next one starts.
-- 6. api_usage_closable_periods(limit) lists what the daily sweep closes: the
--    periods before each tenant's current one that still have a currency to
--    close or invoice. The sweep used to revisit every past period every day,
--    and with its limit of 200 it would in time have stopped reaching new
--    periods at all.
-- 7. Asked for no period, the tenant and fleet summaries show each tenant's
--    current period.
--
-- The 04:20 sweep then finds the three 8 Sep periods with a Didit currency
-- still to close and closes each as an empty USD charge. Nothing reaches
-- Stripe. October's usage sits in each tenant's current period and closes
-- when that period ends (8 Nov for NPC Test, the dashboard and Preflight).
--
-- An event recorded in the seconds this runs may still be filed under the old
-- period. The re-file holds the usage tables against writes while it runs.


create or replace function public.api_usage_period_start(_anchor date, _when timestamptz)
returns date
language plpgsql
stable
set search_path = public
as $$
declare
  _day date := _when::date;
  _months integer;
  _start date;
begin
  if _anchor is null or _day < _anchor then
    return date_trunc('month', _when)::date;
  end if;
  _months := ((extract(year from _day) - extract(year from _anchor)) * 12
              + (extract(month from _day) - extract(month from _anchor)))::integer;
  _start := (_anchor + make_interval(months => _months))::date;
  if _start > _day then
    _start := (_anchor + make_interval(months => _months - 1))::date;
  end if;
  return _start;
end
$$;

create or replace function public.api_usage_period_end(_anchor date, _period_start date)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    when _anchor is null or _period_start < _anchor
      then (date_trunc('month', _period_start::timestamp) + interval '1 month')::date
    else (_anchor + make_interval(months =>
            ((extract(year from _period_start) - extract(year from _anchor)) * 12
             + (extract(month from _period_start) - extract(month from _anchor)))::integer + 1))::date
  end
$$;

revoke all on function public.api_usage_period_start(date, timestamptz) from public, anon, authenticated;
revoke all on function public.api_usage_period_end(date, date) from public, anon, authenticated;
grant execute on function public.api_usage_period_start(date, timestamptz) to service_role;
grant execute on function public.api_usage_period_end(date, date) to service_role;

-- 2. The rating, as 20260908110000 left it, filed by the period its instant
-- falls in.
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
-- The period the instant falls in, counted from the tenant's anchor. No row
-- leaves _period NULL, which is how a tenant that does not exist is told.
SELECT public.api_usage_period_start(t.current_period_start::date,_when) INTO _period FROM public.tenants t WHERE t.id=_tenant_id;
IF _period IS NULL THEN RETURN jsonb_build_object('ok',false,'error','tenant_not_found'); END IF;
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

REVOKE ALL ON FUNCTION public.record_api_usage_event(uuid,uuid,text,numeric,text,text,text,text,timestamptz,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_api_usage_event(uuid,uuid,text,numeric,text,text,text,text,timestamptz,jsonb) TO service_role;

-- 3. Re-file, and rebuild the rollups the move touched.
do $refile$
declare
  _before jsonb;
  _after jsonb;
  _moved integer;
  _touched integer;
begin
  lock table public.api_usage_events, public.api_usage_rollups in share row exclusive mode;

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into _before
    from (select r.tenant_id::text || '|' || r.secret_name as k,
                 jsonb_build_array(sum(r.gross_quantity), sum(r.billable_quantity), sum(r.byok_quantity),
                                   sum(r.event_count), sum(r.error_count), sum(r.gross_charge_micros), sum(r.cost_micros)) as v
            from public.api_usage_rollups r
           group by 1) s;

  create temporary table r7_moves on commit drop as
  select e.id, e.tenant_id, e.secret_name, e.period_start as from_period,
         public.api_usage_period_start(t.current_period_start::date, e.occurred_at) as to_period
    from public.api_usage_events e
    join public.tenants t on t.id = e.tenant_id
   where e.period_start <> public.api_usage_period_start(t.current_period_start::date, e.occurred_at)
     and exists (select 1 from public.api_usage_rollups r
                  where r.tenant_id = e.tenant_id and r.period_start = e.period_start
                    and r.secret_name = e.secret_name);

  update public.api_usage_events e
     set period_start = m.to_period
    from r7_moves m
   where m.id = e.id;
  get diagnostics _moved = row_count;

  create temporary table r7_touched on commit drop as
  select tenant_id, secret_name, from_period as period_start from r7_moves
  union
  select tenant_id, secret_name, to_period from r7_moves;
  select count(*) into _touched from r7_touched;

  -- A rollup no event is filed under any more goes.
  delete from public.api_usage_rollups r
   using r7_touched x
   where r.tenant_id = x.tenant_id and r.secret_name = x.secret_name and r.period_start = x.period_start
     and not exists (select 1 from public.api_usage_events e
                      where e.tenant_id = r.tenant_id and e.secret_name = r.secret_name
                        and e.period_start = r.period_start);

  -- The others are their events' sums, as record_api_usage_event keeps them.
  insert into public.api_usage_rollups (tenant_id, clone_id, period_start, secret_name, provider, unit, currency,
                                        gross_quantity, billable_quantity, byok_quantity, event_count, error_count,
                                        gross_charge_micros, cost_micros, first_seen_at, last_seen_at)
  select e.tenant_id,
         (array_agg(e.clone_id order by e.occurred_at) filter (where e.clone_id is not null))[1],
         e.period_start, e.secret_name,
         (array_agg(e.provider order by e.occurred_at))[1],
         (array_agg(e.unit order by e.occurred_at))[1],
         (array_agg(e.currency order by e.occurred_at))[1],
         sum(e.quantity),
         sum(case when e.billable then e.quantity else 0 end),
         sum(case when e.billing_reason = 'byok' then e.quantity else 0 end),
         count(*),
         count(*) filter (where e.call_status = 'error'),
         sum(e.rated_micros),
         sum(e.cost_micros),
         min(e.occurred_at),
         max(e.occurred_at)
    from public.api_usage_events e
    join r7_touched x
      on x.tenant_id = e.tenant_id and x.secret_name = e.secret_name and x.period_start = e.period_start
   group by e.tenant_id, e.period_start, e.secret_name
  on conflict (tenant_id, period_start, secret_name) do update set
    clone_id = coalesce(api_usage_rollups.clone_id, excluded.clone_id),
    gross_quantity = excluded.gross_quantity,
    billable_quantity = excluded.billable_quantity,
    byok_quantity = excluded.byok_quantity,
    event_count = excluded.event_count,
    error_count = excluded.error_count,
    gross_charge_micros = excluded.gross_charge_micros,
    cost_micros = excluded.cost_micros,
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at;

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into _after
    from (select r.tenant_id::text || '|' || r.secret_name as k,
                 jsonb_build_array(sum(r.gross_quantity), sum(r.billable_quantity), sum(r.byok_quantity),
                                   sum(r.event_count), sum(r.error_count), sum(r.gross_charge_micros), sum(r.cost_micros)) as v
            from public.api_usage_rollups r
           group by 1) s;

  if _after is distinct from _before then
    raise exception 'R7 re-file changed a tenant''s totals: before %, after %', _before, _after;
  end if;

  raise notice 'R7: % event(s) re-filed; % rollup(s) rebuilt or removed', _moved, _touched;
end
$refile$;

-- 4. A charge takes the currency its lines are rated in, and that currency's
-- cost, read from the period's rollups as the re-file left them.
update public.api_usage_charges c
   set currency = l.rated_in,
       cost_micros = (select coalesce(sum(r.cost_micros), 0) from public.api_usage_rollups r
                       where r.tenant_id = c.tenant_id and r.period_start = c.period_start
                         and r.currency = l.rated_in),
       metadata = coalesce(c.metadata, '{}'::jsonb)
                  || jsonb_build_object('currency_relabelled_from', c.currency,
                                        'cost_micros_before', c.cost_micros,
                                        'currency_relabelled_by', '20261030100000'),
       updated_at = now()
  from (select l.charge_id, min(pr.currency) as rated_in
          from public.api_usage_charge_lines l
          left join public.api_provider_rates pr on pr.secret_name = l.secret_name
         group by l.charge_id
        having count(*) = count(pr.currency) and count(distinct pr.currency) = 1) l
 where l.charge_id = c.id
   and c.currency <> l.rated_in
   and not exists (select 1 from public.api_usage_charges o
                    where o.tenant_id = c.tenant_id and o.period_start = c.period_start
                      and o.currency = l.rated_in);

-- 5. As 20261030090000, with the period ending where the next one starts.
create or replace function public.close_api_usage_period(_tenant_id uuid, _period_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _clone_id uuid;
  _period_end date;
  _currencies text[];
  _currency text;
  _charge public.api_usage_charges%rowtype;
  _charge_id uuid;
  _row record;
  _total numeric(18,6);
  _cost_total numeric(18,6);
  _charged_qty numeric(18,4);
  _free numeric(18,4);
  _line_amount numeric(18,6);
  _lines integer;
  _out jsonb := '[]'::jsonb;
  _entry jsonb;
begin
  select coalesce(array_agg(distinct r.currency order by r.currency), array['AUD'])
    into _currencies
    from public.api_usage_rollups r
   where r.tenant_id = _tenant_id and r.period_start = _period_start;

  select clone_id into _clone_id
    from public.api_usage_rollups
   where tenant_id = _tenant_id and period_start = _period_start
   limit 1;

  -- Stripe's own end for the period it is tracking; otherwise where the next
  -- period starts on the tenant's cycle.
  select case
           when t.current_period_start::date = _period_start and t.current_period_end is not null
             then t.current_period_end::date
           else public.api_usage_period_end(t.current_period_start::date, _period_start)
         end
    into _period_end
    from public.tenants t
   where t.id = _tenant_id;
  _period_end := coalesce(_period_end, (_period_start + interval '1 month')::date);

  foreach _currency in array _currencies loop
    select * into _charge
      from public.api_usage_charges
     where tenant_id = _tenant_id and period_start = _period_start and currency = _currency;

    if _charge.id is not null and _charge.status <> 'open' then
      _entry := jsonb_build_object(
        'already_closed', true, 'charge_id', _charge.id, 'status', _charge.status,
        'amount_cents', _charge.amount_cents, 'currency', _charge.currency);
      _out := _out || jsonb_build_array(_entry);
      continue;
    end if;

    if _charge.id is not null then
      _charge_id := _charge.id;
      delete from public.api_usage_charge_lines where charge_id = _charge_id;
    else
      insert into public.api_usage_charges (tenant_id, clone_id, period_start, period_end, currency)
      values (_tenant_id, _clone_id, _period_start, _period_end, _currency)
      on conflict (tenant_id, period_start, currency) do update set clone_id = excluded.clone_id
      returning id into _charge_id;
    end if;

    _total := 0;
    _cost_total := 0;
    _lines := 0;
    for _row in
      select r.secret_name, r.provider, r.unit, r.billable_quantity, r.byok_quantity, r.cost_micros,
             coalesce(pr.included_free_units, 0) as free_units,
             coalesce(pr.resale_micros_per_unit, 0) as rate,
             coalesce(pr.display_name, r.secret_name) as display_name
        from public.api_usage_rollups r
        left join public.api_provider_rates pr on pr.secret_name = r.secret_name
       where r.tenant_id = _tenant_id and r.period_start = _period_start and r.currency = _currency
       order by r.secret_name
    loop
      _cost_total := _cost_total + coalesce(_row.cost_micros, 0);
      _free := least(_row.free_units, _row.billable_quantity);
      _charged_qty := greatest(_row.billable_quantity - _free, 0);
      _line_amount := round(_charged_qty * _row.rate, 6);
      if _charged_qty > 0 or _row.byok_quantity > 0 then
        insert into public.api_usage_charge_lines (
          charge_id, secret_name, provider, display_name, unit, billable_quantity,
          free_units_applied, charged_quantity, rate_micros_per_unit, amount_micros, byok_quantity)
        values (
          _charge_id, _row.secret_name, _row.provider, _row.display_name, _row.unit, _row.billable_quantity,
          _free, _charged_qty, _row.rate, _line_amount, _row.byok_quantity);
        _lines := _lines + 1;
      end if;
      _total := _total + _line_amount;
    end loop;

    update public.api_usage_charges
       set amount_micros = _total,
           amount_cents = floor(_total / 10000 + 0.5)::integer,
           cost_micros = _cost_total,
           status = 'closed',
           closed_at = now(),
           period_end = _period_end
     where id = _charge_id;

    _entry := jsonb_build_object(
      'already_closed', false, 'charge_id', _charge_id, 'status', 'closed', 'lines', _lines,
      'amount_micros', _total, 'amount_cents', floor(_total / 10000 + 0.5)::integer, 'currency', _currency);
    _out := _out || jsonb_build_array(_entry);
  end loop;

  return (_out -> 0) || jsonb_build_object('ok', true, 'charges', _out);
end
$$;

revoke all on function public.close_api_usage_period(uuid, date) from public, anon, authenticated;
grant execute on function public.close_api_usage_period(uuid, date) to service_role;

-- 6. What the daily sweep closes. A charge still `open` or `closed` (closed,
-- not yet invoiced) is unfinished; `invoiced`, `below_threshold`, `waived` and
-- `failed` are where the sweep leaves a charge.
create or replace function public.api_usage_closable_periods(_limit integer default 200)
returns table (tenant_id uuid, period_start date)
language sql
stable
security definer
set search_path = public
as $$
  select r.tenant_id, r.period_start
    from public.api_usage_rollups r
    join public.tenants t on t.id = r.tenant_id
   where r.period_start < public.api_usage_period_start(t.current_period_start::date, now())
     and not exists (
       select 1 from public.api_usage_charges c
        where c.tenant_id = r.tenant_id and c.period_start = r.period_start and c.currency = r.currency
          and c.status in ('invoiced', 'below_threshold', 'waived', 'failed'))
   group by r.tenant_id, r.period_start
   order by r.period_start, r.tenant_id
   limit greatest(coalesce(_limit, 200), 0)
$$;

revoke all on function public.api_usage_closable_periods(integer) from public, anon, authenticated;
grant execute on function public.api_usage_closable_periods(integer) to service_role;

-- 7. The summaries, asked for no period, show each tenant's current one.
CREATE OR REPLACE FUNCTION public.api_usage_tenant_summary(_tenant_id uuid,_period_start date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE _period date;_out jsonb;BEGIN _period:=COALESCE(_period_start,(SELECT public.api_usage_period_start(current_period_start::date,now()) FROM public.tenants WHERE id=_tenant_id));
SELECT jsonb_build_object('tenant_id',_tenant_id,'period_start',_period,'currency',COALESCE(MAX(r.currency),'AUD'),'event_count',COALESCE(SUM(r.event_count),0),'error_count',COALESCE(SUM(r.error_count),0),'billable_micros',COALESCE(SUM(r.gross_charge_micros),0),'cost_micros',COALESCE(SUM(r.cost_micros),0),'providers_used',COUNT(DISTINCT r.provider),'byok_secrets',COUNT(*) FILTER(WHERE r.byok_quantity>0),'lines',COALESCE(jsonb_agg(jsonb_build_object('secret_name',r.secret_name,'provider',r.provider,'display_name',COALESCE(pr.display_name,r.secret_name),'unit',r.unit,'gross_quantity',r.gross_quantity,'billable_quantity',r.billable_quantity,'byok_quantity',r.byok_quantity,'event_count',r.event_count,'error_count',r.error_count,'charge_micros',r.gross_charge_micros,'cost_micros',r.cost_micros) ORDER BY r.gross_charge_micros DESC,r.secret_name) FILTER(WHERE r.secret_name IS NOT NULL),'[]'::jsonb)) INTO _out FROM public.api_usage_rollups r LEFT JOIN public.api_provider_rates pr ON pr.secret_name=r.secret_name WHERE r.tenant_id=_tenant_id AND r.period_start=_period;
RETURN COALESCE(_out,jsonb_build_object('tenant_id',_tenant_id,'period_start',_period,'currency','AUD','event_count',0,'error_count',0,'billable_micros',0,'cost_micros',0,'providers_used',0,'byok_secrets',0,'lines','[]'::jsonb));END $$;

-- `period_start` is null when each tenant's current period is shown: they
-- start on different days.
CREATE OR REPLACE FUNCTION public.api_usage_fleet_summary(_period_start date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN jsonb_build_object('period_start',_period_start,
'tenants',COALESCE((SELECT jsonb_agg(x ORDER BY sort_key DESC) FROM(SELECT SUM(r.gross_charge_micros) sort_key,jsonb_build_object('tenant_id',r.tenant_id,'clone_id',r.clone_id,'tenant_name',COALESCE(t.display_name,t.external_ref),'clone_name',c.name,'period_start',r.period_start,'currency',MAX(r.currency),'event_count',SUM(r.event_count),'error_count',SUM(r.error_count),'charge_micros',SUM(r.gross_charge_micros),'cost_micros',SUM(r.cost_micros),'byok_quantity',SUM(r.byok_quantity),'providers',COUNT(DISTINCT r.provider)) x FROM public.api_usage_rollups r JOIN public.tenants t ON t.id=r.tenant_id LEFT JOIN public.clones c ON c.id=r.clone_id WHERE r.period_start=COALESCE(_period_start,public.api_usage_period_start(t.current_period_start::date,now())) GROUP BY r.tenant_id,r.clone_id,r.period_start,t.display_name,t.external_ref,c.name)s),'[]'::jsonb),
'providers',COALESCE((SELECT jsonb_agg(x ORDER BY sort_key DESC) FROM(SELECT SUM(r.gross_charge_micros) sort_key,jsonb_build_object('provider',r.provider,'secret_name',r.secret_name,'unit',r.unit,'gross_quantity',SUM(r.gross_quantity),'billable_quantity',SUM(r.billable_quantity),'byok_quantity',SUM(r.byok_quantity),'charge_micros',SUM(r.gross_charge_micros),'cost_micros',SUM(r.cost_micros),'tenant_count',COUNT(DISTINCT r.tenant_id)) x FROM public.api_usage_rollups r JOIN public.tenants t ON t.id=r.tenant_id WHERE r.period_start=COALESCE(_period_start,public.api_usage_period_start(t.current_period_start::date,now())) GROUP BY r.provider,r.secret_name,r.unit)s),'[]'::jsonb));END $$;

REVOKE ALL ON FUNCTION public.api_usage_tenant_summary(uuid,date) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_usage_fleet_summary(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_usage_tenant_summary(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_usage_fleet_summary(date) TO service_role;

-- Asserted by effect.
do $verify$
declare _misfiled integer; _mislabelled integer; _unequal integer;
begin
  select count(*) into _misfiled
    from public.api_usage_events e
    join public.tenants t on t.id = e.tenant_id
   where e.period_start <> public.api_usage_period_start(t.current_period_start::date, e.occurred_at)
     and exists (select 1 from public.api_usage_rollups r
                  where r.tenant_id = e.tenant_id and r.period_start = e.period_start
                    and r.secret_name = e.secret_name);
  if _misfiled > 0 then
    raise exception 'R7 did not converge: % event(s) still filed under a period they do not fall in', _misfiled;
  end if;

  select count(*) into _mislabelled
    from public.api_usage_charges c
    join (select l.charge_id, min(pr.currency) as rated_in
            from public.api_usage_charge_lines l
            left join public.api_provider_rates pr on pr.secret_name = l.secret_name
           group by l.charge_id
          having count(*) = count(pr.currency) and count(distinct pr.currency) = 1) l on l.charge_id = c.id
   where c.currency <> l.rated_in;
  if _mislabelled > 0 then
    raise exception 'R7 did not converge: % charge(s) labelled in a currency their lines are not rated in', _mislabelled;
  end if;

  select count(*) into _unequal
    from public.api_usage_rollups r
    left join lateral (
      select sum(e.quantity) as gross, count(*) as n
        from public.api_usage_events e
       where e.tenant_id = r.tenant_id and e.period_start = r.period_start and e.secret_name = r.secret_name) e on true
   where r.gross_quantity is distinct from e.gross or r.event_count is distinct from e.n;
  if _unequal > 0 then
    raise exception 'R7 did not converge: % rollup(s) differ from their events', _unequal;
  end if;
end
$verify$;
