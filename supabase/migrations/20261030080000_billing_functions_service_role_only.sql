-- @asserts none:revokes EXECUTE on eleven functions from the browser roles, creates no object
--
-- Takes the public key's reach off eleven SECURITY DEFINER functions: the
-- usage meter and its settlement, two rate-limit counters, and four retention
-- purges.
--
-- ## What was measured, 30 Oct 2026
--
-- - Each of them runs as its owner (SECURITY DEFINER), checks nobody's identity
--   or role inside, and could be executed by anon and authenticated. Postgres
--   grants EXECUTE to PUBLIC on a new function, and no file revoked it.
-- - Over the wire, the browser's publishable key reached them through
--   PostgREST: `POST /rest/v1/rpc/api_usage_tenant_summary` for a random tenant
--   id answered HTTP 200 with the summary's shape. That key ships in this
--   app's public bundle, so anyone could:
--   - write billable usage against any tenant (`record_api_usage_event`), which
--     the period close then invoices;
--   - close any tenant's period early, freezing its rollups
--     (`close_api_usage_period`);
--   - read every tenant's name and usage (`api_usage_fleet_summary`) or one
--     tenant's lines (`api_usage_tenant_summary`), and a clone's key ledger
--     status (`resolve_api_key_billability`);
--   - spend another caller's rate-limit budget (`check_api_rate_limit`,
--     `check_public_rate_limit`);
--   - run a retention purge early (`purge_api_usage_events`,
--     `purge_deployment_events`, `purge_hosting_teardowns`,
--     `prune_repo_blob_analysis`).
--   Only the read was tried. No write was sent.
-- - Every caller in this repository uses the service role (`supabaseAdmin`):
--   `api.public.usage.report`, the verification and listings brokers, the
--   settlement sweep, the Billing page's server functions and the token rate
--   limiter. The purges run from pg_cron as their owner.
--
-- ## What this does
--
-- Revokes EXECUTE from PUBLIC, anon and authenticated on all eleven, and grants
-- it to service_role. The owner keeps it, so pg_cron's jobs are unchanged. A
-- function this deployment lacks is skipped.
--
-- Left as they are: the RLS helpers a policy calls (`is_super_admin`,
-- `is_high_king`, `can_access_security_assessment`, `is_security_partner_member`,
-- `security_storage_assessment_id`, `clone_has_dedicated_backend`,
-- `clone_requires_backend`), whose callers are the policies themselves; the
-- trigger functions, which PostgREST cannot call; and
-- `email_import_list_into_campaign`, which checks auth.uid() inside.

-- @effect: select 1 where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('record_api_usage_event','close_api_usage_period','api_usage_fleet_summary','api_usage_tenant_summary','resolve_api_key_billability','check_api_rate_limit','check_public_rate_limit','purge_api_usage_events','purge_deployment_events','purge_hosting_teardowns','prune_repo_blob_analysis') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))

do $revoke$
declare
  _fn regprocedure;
begin
  for _fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'record_api_usage_event',
         'close_api_usage_period',
         'api_usage_fleet_summary',
         'api_usage_tenant_summary',
         'resolve_api_key_billability',
         'check_api_rate_limit',
         'check_public_rate_limit',
         'purge_api_usage_events',
         'purge_deployment_events',
         'purge_hosting_teardowns',
         'prune_repo_blob_analysis'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', _fn);
    execute format('grant execute on function %s to service_role', _fn);
  end loop;
end
$revoke$;
