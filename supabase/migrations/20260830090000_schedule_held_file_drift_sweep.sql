-- @asserts cron:held-file-drift
--
-- Schedule the held-file drift sweep.
--
-- A `manual_reconcile` path is one the cascade must never write: the clone's
-- copy is a deliberate superset of prime's. Two guards stand behind that hold
-- and both of them run INSIDE a cascade, over the files that cascade delivers.
--
-- One of the two failures they catch is loud. A held file importing a symbol a
-- delivered module stopped exporting fails the build, which is how it was
-- found: `src/App.tsx` importing an `AmlIntakeQueue` that `AmlShellPages.tsx`
-- no longer exported, failing every Vercel deployment.
--
-- The other is silent. Wiring that prime's copy has and the clone's copy never
-- received compiles perfectly; the clone simply does not have the feature. The
-- AUSTRAC drafting routes were caught only because a source test happened to
-- assert them, which is luck rather than a mechanism.
--
-- Both are invisible on a module no cascade has touched since the drift
-- appeared: the guard never runs, nothing goes red, and nobody is told. This is
-- the part that comes back and looks anyway.
--
-- Hourly. The work is one tree read per clone, two blob reads per held source
-- path and one per module that actually differs — about ten calls for the
-- mirror and two for a module-scoped clone, against an hourly budget of 5,000.
-- The endpoint reports and never writes to a repository, so a run that
-- overlaps a cascade cannot interfere with it.
--
-- It is also quiet on purpose: a finding is recorded and announced when the set
-- of gaps CHANGES, never once an hour for the same unfixed thing, because a gap
-- persists until a person edits a file this platform is forbidden to write.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin — the two faults that left `agreements-refresh` answering 401 on every
-- run since it was installed. `check-cron-auth.mjs` fails CI on either.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('held-file-drift')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'held-file-drift');

  PERFORM cron.schedule(
    'held-file-drift',
    '17 * * * *',
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
      v_base || '/hooks/held-file-drift'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'held file drift sweep NOT scheduled (%).', SQLERRM;
END $$;
