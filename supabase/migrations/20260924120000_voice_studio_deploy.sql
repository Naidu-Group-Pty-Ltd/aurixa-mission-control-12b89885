-- Voice Cloning Studio: deployments into a client's VAPI org, and the ledger
-- that makes a re-run a no-op.
--
-- @asserts table:voice_studio_deployments
-- @asserts table:voice_studio_vapi_ledger
-- @asserts rpc:claim_voice_studio_deployments
--
-- ## Why a ledger
--
-- A deploy is a sequence of VAPI writes - tools, the knowledge-base file, each
-- assistant, the squad - and any of them can fail half way. The ledger records,
-- per (project, kind, key), the VAPI id a thing was created as and the hash of
-- the payload last written to it. A re-run reads it and skips every step whose
-- payload has not changed and whose read-back still verifies, so a deploy that
-- died at the squad resumes at the squad, and a deploy that already succeeded
-- writes nothing at all. Without it, a retry creates a second copy of every
-- tool and every assistant.
--
-- ## Why a deployment is a queued row
--
-- For the planner's reason (20260924100000): a deploy waits on VAPI's file
-- parser (KB_TEXT_PLAIN - the upload is not usable until it reports `done`),
-- which a browser request cannot be trusted to outlive. The worker claims it,
-- writes each step into `steps` as it goes, and the Deploy tab polls.

CREATE TABLE IF NOT EXISTS public.voice_studio_deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  package_id    UUID NOT NULL REFERENCES public.voice_studio_packages (id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply', 'rollback')),
  status        TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- An existing number in the client's org to route to the fleet, if any.
  phone_number_id TEXT,
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification  JSONB,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    TIMESTAMPTZ,
  last_error    TEXT,
  requested_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS voice_studio_deployments_project_idx
  ON public.voice_studio_deployments (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_studio_deployments_package_idx
  ON public.voice_studio_deployments (package_id);
CREATE INDEX IF NOT EXISTS voice_studio_deployments_queue_idx
  ON public.voice_studio_deployments (status, created_at) WHERE status IN ('queued', 'running');
-- One live deployment per project: two workers writing the same assistants
-- at once is how a PATCH from one erases the other's.
CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_deployments_one_live
  ON public.voice_studio_deployments (project_id) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS public.voice_studio_vapi_ledger (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('tool', 'kb_file', 'assistant', 'squad', 'phone')),
  key          TEXT NOT NULL,
  vapi_id      TEXT NOT NULL,
  payload_sha  TEXT NOT NULL,
  package_id   UUID REFERENCES public.voice_studio_packages (id) ON DELETE SET NULL,
  -- Set when the thing was adopted by id rather than created by the Studio:
  -- somebody decided it may be overwritten, and that decision is recorded.
  adopted      BOOLEAN NOT NULL DEFAULT false,
  verified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_vapi_ledger_key
  ON public.voice_studio_vapi_ledger (project_id, kind, key);
CREATE INDEX IF NOT EXISTS voice_studio_vapi_ledger_package_idx
  ON public.voice_studio_vapi_ledger (package_id);

ALTER TABLE public.voice_studio_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_vapi_ledger ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'voice_studio_deployments',
    'voice_studio_vapi_ledger'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS "Operators read %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Operators read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.is_operator(auth.uid()))',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS "Admins write %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Admins write %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_touch ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row()',
      t
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.claim_voice_studio_deployments(
  _limit INTEGER DEFAULT 1,
  _lease_seconds INTEGER DEFAULT 600
)
RETURNS SETOF public.voice_studio_deployments
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.voice_studio_deployments AS d
     SET status = 'running',
         claimed_at = now(),
         attempts = d.attempts + 1
   WHERE d.id IN (
     SELECT c.id
       FROM public.voice_studio_deployments AS c
      WHERE c.status = 'queued'
         OR (c.status = 'running'
             AND c.claimed_at < now() - make_interval(secs => GREATEST(_lease_seconds, 120)))
      ORDER BY c.created_at
      LIMIT GREATEST(LEAST(_limit, 5), 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING d.*;
$$;

REVOKE ALL ON FUNCTION public.claim_voice_studio_deployments(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_voice_studio_deployments(INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_voice_studio_deployments(INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_studio_deployments(INTEGER, INTEGER) TO service_role;

COMMENT ON TABLE public.voice_studio_vapi_ledger IS
  'What the Studio has written into a client VAPI org: the id each tool, file, assistant and squad was created as, and the payload hash last written. Makes a re-deploy a no-op.';
