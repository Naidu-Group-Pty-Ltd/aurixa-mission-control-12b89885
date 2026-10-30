-- @asserts none:re-prices one catalog row and its three per-operation rows,
-- @asserts none:and creates no object a claim could probe; every table here
-- @asserts none:already holds rows, so `rows:` would pass whether or not this
-- @asserts none:ran. The block at the end fails the migration unless Didit
-- @asserts none:reads in AUD and no period still to close holds it in USD.
--
-- Didit is priced in AUD, so a period closes into one AUD charge (the owner's
-- decision of 30 Oct 2026, which 20261030090000 left open: "Pricing Didit in
-- AUD, or a USD invoice, is the owner's decision").
--
-- ## What was measured, 30 Oct 2026 (read-only)
--
-- - DIDIT_API_KEY is the only one of the 34 rates not in AUD. Its row reads
--   USD, cost 200,000 micros (USD 0.20) and resale 0. Its three per-operation
--   rows (20260908040100) carry no currency of their own and are read in the
--   row's: cost 200,000 for id-verification and 50,000 each for
--   passive-liveness and face-match, resale 0 on all three.
-- - Resale has been 0 since 20260908110100 made Didit `absorbed`: Aurixa pays
--   the vendor and the workspace pays in tokens. No Didit event carries a
--   charge (20260908110200 backed out the three that did). Cost is what
--   Aurixa pays, recorded for the margin report.
-- - A period closes into one charge per currency (20261030090000), so a
--   period holding Didit usage closes a USD charge beside its AUD one, empty
--   because resale is 0. The 04:20 UTC sweep closed three on 30 Oct, for the
--   8 Sep periods of NPC Test, the dashboard and Preflight: 0 cents each,
--   `below_threshold`, nothing sent. NPC Test's carries the USD 0.30 Didit
--   cost.
-- - All 13 Didit events are dated 8 Sep and sit in those three periods. No
--   period still to close holds Didit usage.
--
-- ## The rate
--
-- Reserve Bank of Australia, statistical table F11.1 Exchange Rates, series
-- FXRUSD (WM/Reuters): A$1 = US$0.7040 on 30 Oct 2026, read that day from
-- rba.gov.au/statistics/frequency/exchange-rates.html and the table's CSV.
-- So US$1 = A$1.420455, and a USD amount converts as `usd / 0.7040`.
--
-- It is fixed here. If the dollar moves a lot, the AUD cost below drifts from
-- what Didit bills, and it is re-set by hand: by a migration like this one,
-- because the rate editor changes resale only and the three per-operation
-- rows have no editor.
--
-- ## What this does
--
-- 1. Resale, the price a workspace pays, converts at that rate and rounds UP
--    to the cent per unit, as the decision says. It is 0 on all four rows and
--    stays 0: Didit is still absorbed, and 20260908110100's reasons stand.
-- 2. Cost converts at the same rate to the whole micro, and is not rounded
--    up. It shares the row's one currency, so left as it is it would read
--    USD 0.20 as AUD 0.20, 30% below what Aurixa pays; rounded up to the cent
--    it would overstate passive liveness and face match by 13% (AUD 0.0710 as
--    0.08). The decision prices what a workspace pays; this only keeps the
--    cost true under the new label. ID verification reads AUD 0.284091,
--    passive liveness and face match AUD 0.071023 each, so a completed
--    sequence is AUD 0.426137 (USD 0.30).
-- 3. The row reads AUD. A Didit event from here files in AUD, its rollup is
--    AUD, and its period closes into the one AUD charge with everything else:
--    its cost adds to that charge's cost, and its amount is zero while it is
--    absorbed.
-- 4. Didit usage already filed in USD under a period that has not closed in
--    USD moves to AUD with it: its currency, and its cost at the same rate.
--    Its charge is zero either way. There is none on 30 Oct; this is for a
--    call recorded between that reading and this file running. The three
--    8 Sep periods and their charges are left exactly as they are.
--
-- A Didit call reported late and dated before 8 Oct would still be filed
-- under one of those 8 Sep periods, and add AUD cost to its USD rollup. There
-- has been no Didit call since 8 Sep, and the 35-day backdating limit
-- (MAX_BACKDATE_DAYS) closes that on 12 Nov. An event recorded in the seconds
-- this runs may still read the USD row.

-- 1-3. The rates. Converted from what they hold, so a figure edited since the
-- reading above is converted too, and only while the row still reads USD: a
-- second run changes nothing.
do $didit$
declare
  _usd_per_aud constant numeric := 0.7040;
begin
  if not exists (select 1 from public.api_provider_rates
                  where secret_name = 'DIDIT_API_KEY' and currency = 'USD') then
    raise notice 'Didit is not priced in USD here; nothing to convert';
    return;
  end if;

  update public.api_provider_rate_features
     set cost_micros_per_unit = round(cost_micros_per_unit / _usd_per_aud),
         resale_micros_per_unit = ceil(resale_micros_per_unit / _usd_per_aud / 10000) * 10000,
         notes = coalesce(notes, '')
                 || ' In AUD from 30 Oct 2026 at A$1 = US$0.7040 (RBA F11.1): cost converted to the micro, resale rounded up to the cent (20261030210000).',
         updated_at = now()
   where secret_name = 'DIDIT_API_KEY';

  update public.api_provider_rates
     set currency = 'AUD',
         cost_micros_per_unit = round(cost_micros_per_unit / _usd_per_aud),
         resale_micros_per_unit = ceil(resale_micros_per_unit / _usd_per_aud / 10000) * 10000,
         notes = 'ABSORBED. Aurixa pays Didit and does not recharge the money: a workspace is '
              || 'charged 5 tokens per consumed attempt and 5 more for a verified identity '
              || '(prime: _shared/aml/verificationTokenPrice.pure.ts). Priced in AUD from 30 Oct 2026 '
              || '(owner''s decision), so a period closes into one AUD charge. Cost per call is real and '
              || 'still recorded, converted from what Didit bills at A$1 = US$0.7040 (RBA F11.1, 30 Oct '
              || '2026): ID verification USD 0.20 = AUD 0.284091, passive liveness and face match USD 0.05 '
              || '= AUD 0.071023 each, a completed sequence USD 0.30 = AUD 0.426137, none on a free tier. '
              || 'Re-set by hand if the exchange rate moves a lot (20261030210000). Resale is 0 so that '
              || 'clearing `absorbed` under-charges visibly rather than billing money on top of the tokens; '
              || 'a resale set here is in AUD.'
   where secret_name = 'DIDIT_API_KEY'
     and currency = 'USD';
end
$didit$;

-- 4. USD Didit usage in a period that has not closed in USD, if any.
do $usage$
declare
  _usd_per_aud constant numeric := 0.7040;
  _rollups integer;
  _events integer;
begin
  lock table public.api_usage_events, public.api_usage_rollups in share row exclusive mode;

  create temporary table didit_aud_rollups on commit drop as
  select r.id, r.tenant_id, r.period_start
    from public.api_usage_rollups r
   where r.secret_name = 'DIDIT_API_KEY'
     and r.currency = 'USD'
     and not exists (select 1 from public.api_usage_charges c
                      where c.tenant_id = r.tenant_id and c.period_start = r.period_start
                        and c.currency = 'USD' and c.status <> 'open');
  select count(*) into _rollups from didit_aud_rollups;

  update public.api_usage_events e
     set currency = 'AUD',
         cost_micros = round(e.cost_micros / _usd_per_aud)
    from didit_aud_rollups x
   where e.tenant_id = x.tenant_id and e.period_start = x.period_start
     and e.secret_name = 'DIDIT_API_KEY' and e.currency = 'USD';
  get diagnostics _events = row_count;

  update public.api_usage_rollups r
     set currency = 'AUD',
         cost_micros = (select coalesce(sum(e.cost_micros), 0) from public.api_usage_events e
                         where e.tenant_id = r.tenant_id and e.period_start = r.period_start
                           and e.secret_name = r.secret_name)
    from didit_aud_rollups x
   where r.id = x.id;

  raise notice 'Didit in AUD: % USD rollup(s) and % event(s) in periods still to close moved', _rollups, _events;
end
$usage$;

-- Asserted by effect.
do $verify$
declare
  _currency text;
  _uneven integer;
  _usd_open integer;
  _charged integer;
  _unequal integer;
begin
  select currency into _currency from public.api_provider_rates where secret_name = 'DIDIT_API_KEY';
  if _currency is distinct from 'AUD' then
    raise exception 'Didit is priced in %, not AUD', coalesce(_currency, 'no row');
  end if;

  select count(*) into _uneven
    from (select resale_micros_per_unit as resale from public.api_provider_rates
           where secret_name = 'DIDIT_API_KEY'
          union all
          select resale_micros_per_unit from public.api_provider_rate_features
           where secret_name = 'DIDIT_API_KEY') p
   where mod(p.resale, 10000) <> 0;
  if _uneven > 0 then
    raise exception '% Didit price(s) are not a whole number of AUD cents', _uneven;
  end if;

  select count(*) into _usd_open
    from public.api_usage_rollups r
   where r.secret_name = 'DIDIT_API_KEY' and r.currency = 'USD'
     and not exists (select 1 from public.api_usage_charges c
                      where c.tenant_id = r.tenant_id and c.period_start = r.period_start
                        and c.currency = 'USD' and c.status <> 'open');
  if _usd_open > 0 then
    raise exception '% Didit rollup(s) in USD remain in a period still to close', _usd_open;
  end if;

  -- What moved carried no charge: Didit is absorbed.
  select count(*) into _charged
    from public.api_usage_events
   where secret_name = 'DIDIT_API_KEY' and currency = 'AUD' and rated_micros <> 0;
  if _charged > 0 then
    raise exception '% Didit event(s) in AUD carry a charge', _charged;
  end if;

  select count(*) into _unequal
    from public.api_usage_rollups r
   where r.secret_name = 'DIDIT_API_KEY' and r.currency = 'AUD'
     and r.cost_micros is distinct from (select coalesce(sum(e.cost_micros), 0) from public.api_usage_events e
                                          where e.tenant_id = r.tenant_id and e.period_start = r.period_start
                                            and e.secret_name = r.secret_name);
  if _unequal > 0 then
    raise exception '% Didit rollup(s) in AUD differ from their events', _unequal;
  end if;
end
$verify$;
