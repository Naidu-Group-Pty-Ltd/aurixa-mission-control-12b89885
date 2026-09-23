-- Voice Cloning Studio: projects, source documents, planning runs, plans and
-- build packages.
--
-- @asserts table:voice_studio_projects
-- @asserts table:voice_studio_documents
-- @asserts table:voice_studio_runs
-- @asserts table:voice_studio_artifacts
-- @asserts table:voice_studio_plans
-- @asserts table:voice_studio_packages
-- @asserts rpc:claim_voice_studio_runs
--
-- ## What this is for
--
-- A cloning project takes a client business - an existing clone, a lead, a
-- signed agreement or a prospect - and its documents, and produces a voice
-- agent fleet for it from the recipe book (src/lib/voice-recipe), which is the
-- proven NPC / Mission Control stack. docs/voice-cloning/README.md has the whole
-- flow. This migration holds the planning half: nothing here touches VAPI.
--
-- ## Why plans and packages are versioned rows, never updated in place
--
-- An operator approves a plan, then approves the package compiled from it, and
-- the package is what is deployed. Each approval has to name exactly what was
-- approved, so an edit makes a NEW version and the old one is kept -
-- crm_fit_analyses' rule, for the same reason: re-running must never change a
-- report somebody has already read. A package also carries its content hash, so
-- "is what is live the thing that was approved?" has an answer.
--
-- ## Why the planner is a queue
--
-- A plan is several model calls (one per document, then the profile, the
-- topology, each agent, each knowledge-base part), and a Worker request cannot
-- be relied on to outlive all of them. So a run is a row a cron worker claims
-- with a lease, and every stage writes its output as an artifact keyed by
-- (run, kind, key). A worker that dies mid-run leaves its finished stages in
-- place; the next claim resumes from them instead of paying for them twice.

CREATE TABLE IF NOT EXISTS public.voice_studio_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('clone', 'lead', 'agreement', 'prospect')),
  clone_id      UUID REFERENCES public.clones (id) ON DELETE SET NULL,
  lead_id       UUID REFERENCES public.waitlist_leads (id) ON DELETE SET NULL,
  agreement_id  UUID REFERENCES public.client_agreements (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'planning', 'plan_ready', 'plan_approved', 'package_ready', 'package_approved', 'deploying', 'deployed', 'failed')),
  notes         TEXT,
  current_plan_id    UUID,
  current_package_id UUID,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_studio_projects_clone_idx ON public.voice_studio_projects (clone_id);
CREATE INDEX IF NOT EXISTS voice_studio_projects_lead_idx ON public.voice_studio_projects (lead_id);
-- One draft project per agreement: provisioning creates it, and a retried
-- provisioning run must find it rather than make a second.
CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_projects_agreement_key
  ON public.voice_studio_projects (agreement_id) WHERE agreement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.voice_studio_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  storage_path      TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL DEFAULT 0,
  sha256            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'xlsx', 'csv', 'text')),
  -- 'native' = a PDF the model reads itself; its text is not held here, so its
  -- citations are model-asserted rather than verified (confidence.pure.ts).
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'extracted', 'native', 'failed')),
  extracted_text    TEXT,
  truncated         BOOLEAN NOT NULL DEFAULT false,
  page_count        INTEGER,
  anthropic_file_id TEXT,
  error             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same file uploaded twice to one project is one document.
CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_documents_content_key
  ON public.voice_studio_documents (project_id, sha256);

CREATE TABLE IF NOT EXISTS public.voice_studio_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  -- The stage the run is in and a per-stage cursor, so a re-claimed run
  -- resumes rather than restarts.
  stage         TEXT NOT NULL DEFAULT 'extract_docs',
  stage_cursor  JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    TIMESTAMPTZ,
  last_error    TEXT,
  usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  model         TEXT,
  recipe_version TEXT,
  recipe_sha    TEXT,
  requested_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS voice_studio_runs_project_idx ON public.voice_studio_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_studio_runs_queue_idx
  ON public.voice_studio_runs (status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS public.voice_studio_artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES public.voice_studio_runs (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  data        JSONB NOT NULL,
  usage       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A stage unit is written once per run; a re-claimed run upserts onto it.
CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_artifacts_unit_key
  ON public.voice_studio_artifacts (run_id, kind, key);

CREATE TABLE IF NOT EXISTS public.voice_studio_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  run_id      UUID REFERENCES public.voice_studio_runs (id) ON DELETE SET NULL,
  version     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  plan        JSONB NOT NULL,
  confidence  INTEGER,
  has_errors  BOOLEAN NOT NULL DEFAULT false,
  edit_note   TEXT,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_plans_version_key ON public.voice_studio_plans (project_id, version);
CREATE INDEX IF NOT EXISTS voice_studio_plans_run_idx ON public.voice_studio_plans (run_id);

CREATE TABLE IF NOT EXISTS public.voice_studio_packages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES public.voice_studio_plans (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  package        JSONB NOT NULL,
  content_sha256 TEXT NOT NULL,
  approved_by    UUID,
  approved_at    TIMESTAMPTZ,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_packages_version_key ON public.voice_studio_packages (project_id, version);
CREATE INDEX IF NOT EXISTS voice_studio_packages_plan_idx ON public.voice_studio_packages (plan_id);

-- The current pointers are FKs too, added once the targets exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_studio_projects_current_plan_fkey') THEN
    ALTER TABLE public.voice_studio_projects
      ADD CONSTRAINT voice_studio_projects_current_plan_fkey
      FOREIGN KEY (current_plan_id) REFERENCES public.voice_studio_plans (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_studio_projects_current_package_fkey') THEN
    ALTER TABLE public.voice_studio_projects
      ADD CONSTRAINT voice_studio_projects_current_package_fkey
      FOREIGN KEY (current_package_id) REFERENCES public.voice_studio_packages (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS voice_studio_projects_current_plan_idx ON public.voice_studio_projects (current_plan_id);
CREATE INDEX IF NOT EXISTS voice_studio_projects_current_package_idx ON public.voice_studio_projects (current_package_id);
CREATE INDEX IF NOT EXISTS voice_studio_projects_agreement_idx ON public.voice_studio_projects (agreement_id);

-- ── Row security ────────────────────────────────────────────────────────────
-- Operators read the whole studio; only admins create, plan, edit and approve.
-- The worker writes with the service role.

ALTER TABLE public.voice_studio_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_studio_packages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'voice_studio_projects',
    'voice_studio_documents',
    'voice_studio_runs',
    'voice_studio_artifacts',
    'voice_studio_plans',
    'voice_studio_packages'
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
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.touch_voice_studio_row()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS voice_studio_projects_touch ON public.voice_studio_projects;
CREATE TRIGGER voice_studio_projects_touch
  BEFORE UPDATE ON public.voice_studio_projects
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();

DROP TRIGGER IF EXISTS voice_studio_runs_touch ON public.voice_studio_runs;
CREATE TRIGGER voice_studio_runs_touch
  BEFORE UPDATE ON public.voice_studio_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();

-- ── The claim ──────────────────────────────────────────────────────────────
-- The same shape as claim_lead_stage_emails: a conditional UPDATE whose WHERE
-- clause is the lock, returning only the runs it won. A `running` run older
-- than the lease is taken back, because a worker that died mid-stage must not
-- park a plan for ever; its finished stages are artifacts and are not redone.

CREATE OR REPLACE FUNCTION public.claim_voice_studio_runs(
  _limit INTEGER DEFAULT 2,
  _lease_seconds INTEGER DEFAULT 600
)
RETURNS SETOF public.voice_studio_runs
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.voice_studio_runs AS r
     SET status = 'running',
         claimed_at = now(),
         attempts = r.attempts + 1
   WHERE r.id IN (
     SELECT c.id
       FROM public.voice_studio_runs AS c
      WHERE c.status = 'queued'
         OR (c.status = 'running'
             AND c.claimed_at < now() - make_interval(secs => GREATEST(_lease_seconds, 120)))
      ORDER BY c.created_at
      LIMIT GREATEST(LEAST(_limit, 10), 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING r.*;
$$;

REVOKE ALL ON FUNCTION public.claim_voice_studio_runs(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_voice_studio_runs(INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_voice_studio_runs(INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_studio_runs(INTEGER, INTEGER) TO service_role;

COMMENT ON TABLE public.voice_studio_projects IS
  'Voice Cloning Studio projects: a client business whose voice fleet is being planned from the recipe book. See docs/voice-cloning/README.md.';
COMMENT ON TABLE public.voice_studio_plans IS
  'Versioned cloning plans. An edit is a new version; approval names exactly one version.';
COMMENT ON TABLE public.voice_studio_packages IS
  'Immutable build packages compiled from an approved plan. content_sha256 identifies exactly what an approval and a deploy were about.';
