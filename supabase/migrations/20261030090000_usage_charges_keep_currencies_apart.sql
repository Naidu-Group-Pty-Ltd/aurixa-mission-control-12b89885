-- @asserts check:api_usage_charges.status=below_threshold
-- @asserts rpc:close_api_usage_period
--
-- A charge under the invoicing threshold says so, and a period closes into one
-- charge per currency (key audit R6, 29 Oct 2026).
--
-- ## What was measured, 29 Oct 2026 (read-only)
--
-- - api_usage_charges holds four rows. All four say 'invoiced', none has a
--   Stripe invoice item, and each carries metadata.below_threshold = true:
--   three in USD (14 cents each, period 2026-09-08) and one in AUD (5 cents,
--   2026-09-19). 'invoiced' told the Billing page money had been asked for.
--   None had.
-- - Those three USD periods hold rollups in two currencies: AIRTABLE_TOKEN is
--   rated in AUD and DIDIT_API_KEY in USD, the only rate not in AUD.
--   close_api_usage_period summed every line into one total and labelled it
--   with the currency of the last rollup row it read. Here the AUD lines fell
--   inside Airtable's free allowance and added nothing, so each total is the
--   Didit line alone. Any AUD line above its allowance would have been charged
--   as USD.
-- - The live function matches 20260807095403, the file that defined it.
--
-- ## What this does
--
-- 1. 'below_threshold' joins the status CHECK, and the four rows are
--    relabelled from 'invoiced'. Their amounts, lines and metadata stay as
--    they are. invoiceClosedCharge writes the new status from now on.
-- 2. A charge is unique per (tenant, period, currency) rather than per
--    (tenant, period). The four rows already satisfy it.
-- 3. close_api_usage_period closes one charge for each currency the period's
--    rollups hold, and each sums only its own currency's lines. A currency
--    already closed is returned as it stands, never recomputed. The function
--    still answers the fields it answered (for the first charge, in currency
--    order) and adds `charges`, one entry per currency. A period with no
--    rollups closes one empty AUD charge, as before.
--
-- A USD charge then reaches Stripe as USD. Every price the platform sells is in
-- AUD, so Stripe refuses an invoice item in another currency for an AUD
-- customer, and the charge goes to 'failed' with Stripe's reason, on the
-- Billing page. Pricing Didit in AUD, or a USD invoice, is the owner's
-- decision.

-- @effect: select 1 where not exists (select 1 from public.api_usage_charges where status = 'invoiced' and stripe_invoice_item_id is null and coalesce((metadata->>'below_threshold')::boolean, false)) and exists (select 1 from pg_constraint where conrelid = 'public.api_usage_charges'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, period_start, currency)')

alter table public.api_usage_charges drop constraint if exists api_usage_charges_status_check;
alter table public.api_usage_charges
  add constraint api_usage_charges_status_check
  check (status in ('open', 'closed', 'invoiced', 'below_threshold', 'waived', 'failed'));

update public.api_usage_charges
   set status = 'below_threshold',
       updated_at = now()
 where status = 'invoiced'
   and stripe_invoice_item_id is null
   and coalesce((metadata->>'below_threshold')::boolean, false);

alter table public.api_usage_charges drop constraint if exists api_usage_charges_tenant_id_period_start_key;
do $unique$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.api_usage_charges'::regclass
       and conname = 'api_usage_charges_tenant_period_currency_key'
  ) then
    alter table public.api_usage_charges
      add constraint api_usage_charges_tenant_period_currency_key
      unique (tenant_id, period_start, currency);
  end if;
end
$unique$;

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

  select case
           when t.current_period_start::date = _period_start and t.current_period_end is not null
             then t.current_period_end::date
           else (_period_start + interval '1 month')::date
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

  -- The first charge's fields, as the function answered before, and every
  -- charge it closed. A caller that reads only `charge_id` still gets one.
  return (_out -> 0) || jsonb_build_object('ok', true, 'charges', _out);
end
$$;

revoke all on function public.close_api_usage_period(uuid, date) from public, anon, authenticated;
grant execute on function public.close_api_usage_period(uuid, date) to service_role;
