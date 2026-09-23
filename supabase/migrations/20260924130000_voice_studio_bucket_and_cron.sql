-- Voice Cloning Studio: the private bucket its source documents live in, and
-- the two workers that drain its queues.
--
-- @asserts cron:voice-studio-plan-drain
-- @asserts cron:voice-studio-deploy-drain
--
-- ## The bucket
--
-- A client's brochures, FAQs, price lists and policies. They are the client's
-- commercial documents, so the bucket is private: operators read them (the
-- Profile tab links each citation to a short-lived signed URL), admins write
-- them, nothing is ever served publicly. The storage policies are
-- 20260731140000's for `fit-knowledge`, for the same reason.
--
-- ## The two workers
--
-- /hooks/voice-studio-plan claims queued planning runs, and
-- /hooks/voice-studio-deploy claims queued deployments. Both are every minute
-- and both drain almost nothing almost always, which is the right trade: a plan
-- somebody has just asked for should start within a minute, and an empty
-- claim is one indexed UPDATE that matches no row.
--
-- The HTTP timeout is 290 s, not the 60 s most jobs here use, and
-- 20260922150000 is why: a planning tick is model calls, each of which can
-- take a minute or more, and a request pg_net stops listening to is still
-- DELIVERED - the worker really runs, and then cannot write its verdict. The
-- workers' own budgets (VOICE_STUDIO_TICK_BUDGET_MS) stop claiming new work
-- well inside that, and a run a worker could not finish is re-claimed after
-- its lease with every finished stage kept as an artifact.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voice-studio-docs',
  'voice-studio-docs',
  false,
  26214400, -- 25 MB
  ARRAY[
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "Operators read voice studio files" ON storage.objects;
CREATE POLICY "Operators read voice studio files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voice-studio-docs' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins write voice studio files" ON storage.objects;
CREATE POLICY "Admins write voice studio files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voice-studio-docs' AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins update voice studio files" ON storage.objects;
CREATE POLICY "Admins update voice studio files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'voice-studio-docs' AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins delete voice studio files" ON storage.objects;
CREATE POLICY "Admins delete voice studio files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'voice-studio-docs' AND public.is_admin(auth.uid()));

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- The base URL and Authorization header follow 20260922130000 exactly: the
-- lovable.app host 301s to the custom domain and libcurl drops Authorization
-- on a cross-host hop.
DO $$
DECLARE
  v_base TEXT;
  v_job  RECORD;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  FOR v_job IN
    SELECT * FROM (VALUES
      ('voice-studio-plan-drain', '/hooks/voice-studio-plan'),
      ('voice-studio-deploy-drain', '/hooks/voice-studio-deploy')
    ) AS j(name, path)
  LOOP
    PERFORM cron.unschedule(v_job.name)
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name);

    PERFORM cron.schedule(
      v_job.name,
      '* * * * *',
      format(
        $f$SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'Lovable-Context','cron',
            'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
          ),
          body := jsonb_build_object('source','pg_cron'),
          timeout_milliseconds := 290000
        )$f$,
        v_base || v_job.path
      )
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- A deployment without pg_cron must not fail the whole migration. Both
  -- workers are still reachable by hand with the cron secret.
  RAISE WARNING 'voice studio workers NOT scheduled (%).', SQLERRM;
END $$;
