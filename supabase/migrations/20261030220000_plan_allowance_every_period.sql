-- @asserts none:replaces two functions that already exist, so `rpc:` would
-- @asserts none:pass whether or not this ran, and creates no other object. The
-- @asserts none:block at the end fails the migration unless both are this
-- @asserts none:file's and executable by service_role alone.
--
-- A plan's monthly credits are issued every period, whether or not Stripe
-- recorded a renewal (the owner's decision of 30 Oct 2026: "Each tenant gets
-- its plan's allowance every period, whether or not Stripe recorded a
-- renewal").
--
-- ## What was measured, 30 Oct 2026 (read-only)
--
-- - The hourly issuer (`token-plan-allowances`, minute 7) calls
--   issue_plan_allowance(tenant, NULL), which keyed the grant on
--   tenants.current_period_start. That anchor moves only when the Stripe
--   webhook records a renewal (advance_tenant_billing_period), and none has
--   ever been recorded, so each hour it found the same grant again.
-- - Each of the 11 tenants holding a plan grant holds one per plan, for its
--   first period: the dashboard's `prime:` tenant two (free from 6 Sep,
--   scale from 16 Sep), the rest one each. They last 30 days, so all have
--   expired except Aurixa Builders' (31 Oct) and the tutorial demo's
--   (28 Nov). Prime holds none: its anchor (19 May) is older than the rule
--   that only periods beginning after 28 Jul are issued.
-- - Ten tenants were each given their first period's allowance twice. A
--   tenant that provisioning creates on first call (ensureTenant's
--   auto-provision, clone-api-keys.server.ts) is given its plan's monthly
--   allowance at once, through grant_tokens, as
--   `auto_provisioned_monthly_allowance` with no plan or period in its
--   metadata. The hourly run then issued the same plan's allowance for the
--   same period, 13 to 60 minutes later: 100 + 100 free credits for NPC
--   Test, both dashboard tenants, Preflight, the CRM, Aurixa Builders and
--   the four other builders-network tenants. The token integration doc
--   calls the first grant that plan's monthly allowance
--   (prime-repo-token-integration.md), so it is not a welcome credit.
-- - Three seat entitlements exist, all `active` and none with a Stripe
--   subscription: the prime's, NPC Client Dashboard's (scale, comped) and
--   the tutorial demo's (launch).
-- - issue_plan_allowance and issue_due_plan_allowances are executable by
--   `authenticated`, so any signed-in user could call either over PostgREST
--   and credit any tenant, for any period named.
--
-- ## What this does
--
-- 1. Asked for no period (the hourly run), issue_plan_allowance credits the
--    tenant's current period, counted the way api_usage_period_start counts
--    it: whole months on from current_period_start, whether or not Stripe
--    moved it. Never an earlier one. Credits expire after 30 days, so issuing
--    a missed period would be a windfall, not an allowance. The rule that
--    only periods beginning after the feature shipped (28 Jul 2026) are
--    issued now reads that period's start, not the anchor's.
-- 2. One grant per plan per computed period. A grant of the same plan whose
--    period start falls inside the period is that period's grant, whatever
--    its ref says. Every caller asks this (the hourly run, a renewal through
--    advance_tenant_billing_period, a plan change through
--    apply_seat_plan_change), under a per-tenant lock, so the hourly grant
--    and the webhook's renewal grant cannot both land in one period, in
--    either order or at the same moment. The webhook keys its grants
--    `plan:<plan id>:<day the period starts>`, so:
--    - a renewal on the computed day carries the hourly grant's ref;
--    - a renewal a day before it (a subscription created at 23:59 UTC,
--      whose plan change started the anchor after midnight) moves the anchor
--      to that day, and the hourly grant falls inside the new period;
--    - a renewal days after it is month-end clamping. A 31st subscription
--      renewed on 28 Feb has its anchor moved to 28 Feb, so the computed month
--      runs 28 Mar to 28 Apr while Stripe's next period starts 31 Mar. So
--      while the period Stripe recorded is still running, the hourly run
--      waits for the renewal. Once that period has ended without one, the
--      hourly grant is labelled with the day Stripe's next period starts, and
--      a late renewal finds its own ref.
--    A plan change is not held back: it starts its period at the change, and
--    another plan's grant is not this plan's.
--    The grant provisioning makes when it creates a tenant is that period's
--    grant too, for as long as the tenant stays on the plan it was created
--    with. So a tenant created on first call gets its first month once, at
--    creation, and the hourly run credits from its second period on.
-- 3. The guard, beside the webhook's own rule ("a cancelled or past-due plan
--    must not keep granting credits", api.public.stripe.webhook.ts:532-533).
--    The hourly run skips a tenant whose clone's seat entitlement
--    (tenants.clone_id = clone_seat_entitlements.clone_id, one per clone)
--    reads anything but `active`. The webhook stores `active` for Stripe's
--    active and trialing, `past_due` for past_due and unpaid, `canceled` for
--    canceled and incomplete_expired, and any other status as Stripe sent
--    it. A tenant with no entitlement row is credited: whether or not Stripe
--    recorded a renewal. tenants.status must still be `active`.
-- 4. Both functions run for service_role only. Nothing in the app calls them;
--    the renewal and plan-change paths reach issue_plan_allowance through
--    SECURITY DEFINER functions, and the cron runs as the owner.
--
-- The next hourly run after this, dry-run on a copy of the live rows on
-- 30 Oct: 100 credits each to NPC Test, NPC Client Dashboard and Preflight
-- (period from 8 Oct), the four builders-network tenants (18 Oct) and NPC
-- CRM Independent (19 Oct); 75,000 to the dashboard's `prime:` tenant (scale,
-- 16 Oct) and to Prime (scale, 19 Oct). Aurixa Builders (1 Oct) and the
-- tutorial demo (29 Oct) already hold their current period's grant. A second
-- run issues nothing. Those first grants land part-way through their periods
-- and, like every grant, last 30 days from issue.

create or replace function public.issue_plan_allowance(
  _tenant_id uuid,
  _period_start timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _tenant     public.tenants%rowtype;
  _allowance  integer;
  _anchor     date;
  _from       date;
  _to         date;
  _recorded   date;
  _start      timestamptz;
  _ref        text;
  _expires    timestamptz;
begin
  -- One caller at a time per tenant, so a renewal and the hourly run that
  -- arrive together cannot both find the period empty. Taken before the
  -- tenant is read, so a renewal's new anchor is seen once it has committed.
  perform pg_advisory_xact_lock(hashtextextended('issue_plan_allowance:' || _tenant_id::text, 0));

  select * into _tenant from public.tenants where id = _tenant_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'tenant_not_found'); end if;
  if _tenant.status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'error', 'tenant_inactive');
  end if;

  select bp.monthly_allowance into _allowance
    from public.billing_plans bp where bp.id = _tenant.plan_id;
  if coalesce(_allowance, 0) <= 0 then
    return jsonb_build_object('ok', true, 'skipped', 'no_allowance');
  end if;

  _anchor := _tenant.current_period_start::date;

  if _period_start is not null then
    -- A period a caller names: a renewal, or a plan change.
    _start := _period_start;
    _from := public.api_usage_period_start(_anchor, _period_start);
    _to := public.api_usage_period_end(_anchor, _from);
  else
    -- The hourly run. A clone whose subscription is not live earns nothing
    -- here, as it earns nothing from the webhook.
    if exists (select 1 from public.clone_seat_entitlements e
                where e.clone_id = _tenant.clone_id and e.status <> 'active') then
      return jsonb_build_object('ok', true, 'skipped', 'subscription_not_live');
    end if;

    _from := public.api_usage_period_start(_anchor, now());
    if _from < date '2026-07-28' then
      return jsonb_build_object('ok', true, 'skipped', 'period_before_feature');
    end if;
    _to := public.api_usage_period_end(_anchor, _from);

    -- A period Stripe recorded that ends inside this one: month-end clamping.
    _recorded := _tenant.current_period_end::date;
    if _recorded > _from and _recorded < _to then
      if now() < _tenant.current_period_end then
        return jsonb_build_object('ok', true, 'skipped', 'recorded_period_running');
      end if;
      _start := _tenant.current_period_end;
    else
      _start := _from::timestamptz;
    end if;
  end if;

  _ref := 'plan:' || coalesce(_tenant.plan_id::text, 'none') || ':' || to_char(_start, 'YYYY-MM-DD');

  if exists (
    select 1 from public.token_ledger l
     where l.tenant_id = _tenant_id
       and l.kind = 'grant'
       and (l.source_ref = _ref
            or (l.reason = 'plan_allowance'
                and l.metadata->>'plan_id' = _tenant.plan_id::text
                and coalesce((l.metadata->>'period_start')::timestamptz, l.created_at)::date >= _from
                and coalesce((l.metadata->>'period_start')::timestamptz, l.created_at)::date < _to)
            -- The first month that provisioning gives a tenant it creates on
            -- first call (ensureTenant): this allowance, through grant_tokens,
            -- so with no plan or period of its own. It is this plan's while
            -- the tenant has not changed plan since. The same call set
            -- plan_started_at a fraction of a second before, on the app's
            -- clock rather than the database's.
            or (l.reason = 'auto_provisioned_monthly_allowance'
                and l.created_at >= coalesce(_tenant.plan_started_at, _tenant.created_at) - interval '10 seconds'
                and l.created_at::date >= _from
                and l.created_at::date < _to))
  ) then
    return jsonb_build_object('ok', true, 'idempotent', true, 'tokens', _allowance);
  end if;

  _expires := now() + make_interval(days => public.token_expiry_days());

  insert into public.token_ledger
    (tenant_id, kind, tokens, source, source_ref, reason, expires_at, metadata)
  values (
    _tenant_id, 'grant', _allowance, 'subscription', _ref,
    'plan_allowance', _expires,
    jsonb_build_object('period_start', _start, 'plan_id', _tenant.plan_id)
  );

  return jsonb_build_object('ok', true, 'tokens', _allowance, 'expires_at', _expires,
                            'period_start', _start);
end
$$;

-- The hourly driver. Which period, whether it is due, and whether the tenant
-- has earned it are issue_plan_allowance's to decide.
create or replace function public.issue_due_plan_allowances()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _t       record;
  _result  jsonb;
  _issued  integer := 0;
  _skipped integer := 0;
begin
  for _t in
    select id from public.tenants
     where status = 'active'
       and plan_id is not null
       and current_period_start is not null
  loop
    _result := public.issue_plan_allowance(_t.id, null);
    if coalesce(_result ->> 'tokens', '') <> '' and (_result ->> 'idempotent') is null then
      _issued := _issued + 1;
      perform public.recompute_token_balance(_t.id);
    else
      _skipped := _skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'issued', _issued, 'skipped', _skipped);
end
$$;

revoke all on function public.issue_plan_allowance(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.issue_due_plan_allowances() from public, anon, authenticated;
grant execute on function public.issue_plan_allowance(uuid, timestamptz) to service_role;
grant execute on function public.issue_due_plan_allowances() to service_role;

-- Asserted by effect.
do $verify$
declare _open integer; _old integer;
begin
  select count(*) into _open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('issue_plan_allowance', 'issue_due_plan_allowances')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or not has_function_privilege('service_role', p.oid, 'execute'));
  if _open > 0 then
    raise exception '% plan allowance function(s) are not service_role only', _open;
  end if;

  select count(*) into _old
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and ((p.proname = 'issue_plan_allowance'
           and (position('subscription_not_live' in p.prosrc) = 0
                or position('auto_provisioned_monthly_allowance' in p.prosrc) = 0))
          or (p.proname = 'issue_due_plan_allowances' and position('2026-07-28' in p.prosrc) > 0));
  if _old > 0 then
    raise exception '% plan allowance function(s) are not this file''s', _old;
  end if;
end
$verify$;
