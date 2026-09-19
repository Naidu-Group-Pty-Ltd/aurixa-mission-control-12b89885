-- @asserts cron:reference-data-sync-15min

-- NINETY SECONDS AN HOUR IS THE WHOLE FLEET'S REFERENCE-DATA BUDGET.
--
-- `runReferenceDataSync` claims ONE clone a pass and stops itself at
-- `DEFAULT_BUDGET_MS` (90 s). It was scheduled `43 * * * *`. Those three facts
-- multiply: every clone in the fleet shares ninety seconds of copying an hour,
-- and a clone gets a turn only when the unordered pick happens to choose it.
--
-- Measured 19 Sep 2026 on `npc-crm-independent-6505dc`, provisioned that
-- morning. Four passes in four hours, and each one finished at most a single
-- table:
--
--   07:43  suburb_directory        18,519 / 18,519   complete
--   08:43  depreciation_comps      22,000 / 22,000   complete
--   08:44  template_library_entries   100 / 543      copying
--   09:43  (the pick chose NPC Test instead)
--   10:44  template_library_entries    —             still copying
--
-- Three of twenty-four tables. `template_library_entries` is the 500 Investment
-- Compass masters and the 43 voice templates — the table this whole lane was
-- built for, and the one the product cannot draw a document without. At this
-- rate a newly provisioned clone is days from being able to render a report,
-- and nothing reports that it is waiting.
--
-- The cadence was never argued for. The migration that set it
-- (`20260827090000_clone_reference_syncs.sql`) states its reasoning for the
-- separate claim column and for the allow-list, and says nothing at all about
-- `43 * * * *`.
--
-- ## Why cadence rather than more work per pass
--
-- The budget is not the thing to raise: 90 s already sits under the cron's
-- 120 s pg_net timeout, and the sibling lane's invocations were being killed
-- at around forty-five. Nor is serving every clone in one pass, which would
-- divide the same ninety seconds four ways and make each clone's progress
-- worse. The pass is already claim-release-and-resume by cursor, so passes do
-- not interfere; there is simply not much point running one an hour.
--
-- Four an hour is six minutes of copying an hour against the prime, up from
-- ninety seconds. That is the cost, stated plainly: this lane reads the prime,
-- which is a live tenant database, in keyset-paginated pages. It is bounded by
-- the same per-pass budget, so the ceiling moves from 90 s to 360 s an hour and
-- no single pass grows at all.
--
-- The job is RENAMED, because `reference-data-sync-hourly` would otherwise be
-- a schedule's name saying the opposite of its schedule — which is exactly the
-- kind of quiet disagreement the rest of this repository keeps paying for.

DO $do$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- Unschedule both names so this is idempotent and leaves no second job
  -- racing the first on the same claim column.
  PERFORM cron.unschedule('reference-data-sync-hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reference-data-sync-hourly');
  PERFORM cron.unschedule('reference-data-sync-15min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reference-data-sync-15min');

  PERFORM cron.schedule(
    'reference-data-sync-15min',
    -- Offset from :00 so it does not start in the same minute as the fleet
    -- migration sync, which claims the same clones under a different column
    -- and reads the same prime.
    '13,28,43,58 * * * *',
    format(
      $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 120000
        )$f$,
      v_base || '/hooks/reference-data-sync'
    )
  );
  RAISE NOTICE 'scheduled % against %', 'reference-data-sync-15min', v_base;
END
$do$;
