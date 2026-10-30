-- @asserts table:live_audit_settings
-- @asserts table:live_audit_runs
-- @asserts table:live_audit_findings
-- @asserts table:live_audit_observations
-- @asserts table:live_audit_events
-- @asserts table:live_audit_fixes
-- @asserts table:live_audit_callback_receipts
-- @asserts rows:live_audit_settings>=1
-- @asserts check:live_audit_settings.mode=live
-- @asserts check:live_audit_findings.state=fix_merged
-- @asserts rpc:live_audit_ingest_findings
-- @asserts rpc:live_audit_finalize_run
-- @asserts rpc:live_audit_set_nightly_schedule
-- @asserts cron:live-audit-nightly
-- @asserts cron:live-audit-sweep
--
-- THE LIVE AUDIT (docs/LIVE_AUDIT.md).
--
-- Mission Control dispatches `.github/workflows/live-audit.yml` on Prime: Chromium,
-- driven by Playwright, uses the deployed application as a member of staff while
-- Claude reads Prime's repository to decide what to exercise and to find the code
-- behind each defect. Bug and error detection only. This is the record of it:
--
--   live_audit_settings      one row per target — Prime only, for now
--                            (src/lib/live-audit-policy.ts); the model, budgets,
--                            limits, schedule and fix policy
--   live_audit_runs          one per dispatch, with its phases and summary
--   live_audit_findings      one row per (target, fingerprint): a defect keeps
--                            its identity, its triage and its history across runs
--   live_audit_observations  which run saw which finding
--   live_audit_events        the timeline of a run, a finding and a fix
--   live_audit_fixes         each Claude fix: codex-remediation.yml version 5,
--                            `kind: "bug"`, a `live-audit/fix-…` branch
--   live_audit_callback_receipts  accepted callback signatures, so a replay is
--                            refused
--
-- A finding is resolved by its ABSENCE only on a complete run that opened its
-- page (`p_covered`), only for what the deterministic crawl detects, and only
-- after it is missed twice; what the explore agent found needs four misses,
-- because an agent may simply not have walked that way. A fix that merged is
-- confirmed by the first complete miss.

-- ── 1. Settings ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_audit_settings (
  target_key TEXT PRIMARY KEY DEFAULT 'prime',
  nightly_enabled BOOLEAN NOT NULL DEFAULT false,
  -- 02:13 Sydney in winter, 03:13 in summer: after the Codex nightly (07:00 UTC
  -- is 17:00/18:00 Sydney) and clear of the working day.
  nightly_cron TEXT NOT NULL DEFAULT '13 16 * * *',
  mode TEXT NOT NULL DEFAULT 'live',
  target_url TEXT NOT NULL DEFAULT 'https://command-centre.npcservices.com.au',
  -- NULL: nobody has chosen yet. The runner uses its default and every run
  -- records that it was the default, so a default never passes for a decision.
  audit_model TEXT,
  fix_model TEXT,
  effort_scope TEXT NOT NULL DEFAULT 'high',
  effort_explore TEXT NOT NULL DEFAULT 'medium',
  effort_triage TEXT NOT NULL DEFAULT 'high',
  fix_effort TEXT NOT NULL DEFAULT 'high',
  budget_usd NUMERIC(8,2) NOT NULL DEFAULT 15,
  max_pages INTEGER NOT NULL DEFAULT 60,
  max_journeys INTEGER NOT NULL DEFAULT 8,
  max_steps INTEGER NOT NULL DEFAULT 25,
  time_budget_minutes INTEGER NOT NULL DEFAULT 70,
  viewports TEXT[] NOT NULL DEFAULT ARRAY['desktop']::TEXT[],
  screenshots TEXT NOT NULL DEFAULT 'issues',
  guard_allow_functions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  guard_block_functions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  autofix_enabled BOOLEAN NOT NULL DEFAULT false,
  autofix_max_per_run INTEGER NOT NULL DEFAULT 3,
  autofix_min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.70,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_audit_settings_target_check CHECK (target_key = 'prime' OR target_key ~ '^[0-9a-f-]{36}$'),
  CONSTRAINT live_audit_settings_mode_check CHECK (mode IN ('live', 'preview')),
  CONSTRAINT live_audit_settings_effort_check CHECK (
    effort_scope IN ('low', 'medium', 'high', 'xhigh', 'max')
    AND effort_explore IN ('low', 'medium', 'high', 'xhigh', 'max')
    AND effort_triage IN ('low', 'medium', 'high', 'xhigh', 'max')
    AND fix_effort IN ('low', 'medium', 'high', 'xhigh', 'max')
  ),
  CONSTRAINT live_audit_settings_model_check CHECK (
    (audit_model IS NULL OR audit_model ~ '^claude-[a-z0-9.-]{3,60}$')
    AND (fix_model IS NULL OR fix_model ~ '^claude-[a-z0-9.-]{3,60}$')
  ),
  CONSTRAINT live_audit_settings_limits_check CHECK (
    budget_usd >= 0 AND budget_usd <= 200
    AND max_pages BETWEEN 1 AND 400
    AND max_journeys BETWEEN 0 AND 40
    AND max_steps BETWEEN 1 AND 80
    AND time_budget_minutes BETWEEN 5 AND 85
    AND autofix_max_per_run BETWEEN 0 AND 20
    AND autofix_min_confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT live_audit_settings_screenshots_check CHECK (screenshots IN ('issues', 'off')),
  CONSTRAINT live_audit_settings_url_check CHECK (target_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$')
);
CREATE INDEX IF NOT EXISTS live_audit_settings_updated_by_idx ON public.live_audit_settings(updated_by);

INSERT INTO public.live_audit_settings (target_key) VALUES ('prime') ON CONFLICT (target_key) DO NOTHING;

DROP TRIGGER IF EXISTS live_audit_settings_updated_at ON public.live_audit_settings;
CREATE TRIGGER live_audit_settings_updated_at
  BEFORE UPDATE ON public.live_audit_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 2. Runs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key TEXT NOT NULL DEFAULT 'prime',
  kind TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL DEFAULT 'queued',
  repo_full_name TEXT NOT NULL,
  dispatch_ref TEXT NOT NULL DEFAULT 'main',
  ref TEXT,
  target_url TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  callback_key_version TEXT NOT NULL DEFAULT 'live-run-v1',
  workflow_run_id BIGINT,
  workflow_run_url TEXT,
  runner_version INTEGER,
  auth_state TEXT,
  anthropic JSONB,
  phases JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB,
  complete BOOLEAN,
  cost_usd NUMERIC(10,4),
  findings_reported INTEGER NOT NULL DEFAULT 0,
  findings_new INTEGER NOT NULL DEFAULT 0,
  regressions INTEGER NOT NULL DEFAULT 0,
  findings_resolved INTEGER NOT NULL DEFAULT 0,
  batches_received INTEGER NOT NULL DEFAULT 0,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_audit_runs_kind_check CHECK (kind IN ('manual', 'nightly', 'verify')),
  CONSTRAINT live_audit_runs_mode_check CHECK (mode IN ('live', 'preview')),
  CONSTRAINT live_audit_runs_status_check CHECK (status IN ('queued', 'dispatched', 'running', 'completed', 'failed', 'canceled'))
);
-- One run in flight per target: the workflow's own concurrency group queues a
-- second dispatch, and a queued run would hold its key open for nothing.
CREATE UNIQUE INDEX IF NOT EXISTS live_audit_runs_one_active
  ON public.live_audit_runs(target_key) WHERE status IN ('queued', 'dispatched', 'running');
CREATE INDEX IF NOT EXISTS live_audit_runs_created_idx ON public.live_audit_runs(target_key, created_at DESC);
CREATE INDEX IF NOT EXISTS live_audit_runs_requested_by_idx ON public.live_audit_runs(requested_by);

DROP TRIGGER IF EXISTS live_audit_runs_updated_at ON public.live_audit_runs;
CREATE TRIGGER live_audit_runs_updated_at
  BEFORE UPDATE ON public.live_audit_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 3. Findings ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key TEXT NOT NULL DEFAULT 'prime',
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  detector TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  route TEXT,
  route_template TEXT,
  repro_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspected_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  fix_hint TEXT,
  confidence NUMERIC(4,3),
  deterministic BOOLEAN NOT NULL DEFAULT false,
  reproduced BOOLEAN,
  judged_by TEXT,
  screenshot_path TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  runs_seen INTEGER NOT NULL DEFAULT 1,
  missed_runs INTEGER NOT NULL DEFAULT 0,
  first_seen_run_id UUID REFERENCES public.live_audit_runs(id) ON DELETE SET NULL,
  last_seen_run_id UUID REFERENCES public.live_audit_runs(id) ON DELETE SET NULL,
  resolved_by_run_id UUID REFERENCES public.live_audit_runs(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  absent_since TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  triaged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  triage_reason TEXT,
  triaged_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  fix_attempts INTEGER NOT NULL DEFAULT 0,
  last_fix_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_audit_findings_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT live_audit_findings_state_check CHECK (state IN (
    'open', 'triaging', 'fix_queued', 'fix_in_progress', 'fix_pr_open', 'fix_merged',
    'resolved', 'dismissed', 'false_positive'
  )),
  CONSTRAINT live_audit_findings_resolution_check CHECK (resolution IS NULL OR resolution IN ('absent', 'fixed', 'manual')),
  CONSTRAINT live_audit_findings_severity_check CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  CONSTRAINT live_audit_findings_target_fingerprint_key UNIQUE (target_key, fingerprint)
);
CREATE INDEX IF NOT EXISTS live_audit_findings_open_idx
  ON public.live_audit_findings(target_key, severity)
  WHERE state NOT IN ('resolved', 'dismissed', 'false_positive');
CREATE INDEX IF NOT EXISTS live_audit_findings_template_idx ON public.live_audit_findings(target_key, route_template);
CREATE INDEX IF NOT EXISTS live_audit_findings_first_seen_run_idx ON public.live_audit_findings(first_seen_run_id);
CREATE INDEX IF NOT EXISTS live_audit_findings_last_seen_run_idx ON public.live_audit_findings(last_seen_run_id);
CREATE INDEX IF NOT EXISTS live_audit_findings_resolved_by_run_idx ON public.live_audit_findings(resolved_by_run_id);
CREATE INDEX IF NOT EXISTS live_audit_findings_triaged_by_idx ON public.live_audit_findings(triaged_by);
CREATE INDEX IF NOT EXISTS live_audit_findings_assigned_to_idx ON public.live_audit_findings(assigned_to);

DROP TRIGGER IF EXISTS live_audit_findings_updated_at ON public.live_audit_findings;
CREATE TRIGGER live_audit_findings_updated_at
  BEFORE UPDATE ON public.live_audit_findings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.live_audit_observations (
  run_id UUID NOT NULL REFERENCES public.live_audit_runs(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES public.live_audit_findings(id) ON DELETE CASCADE,
  occurrences INTEGER NOT NULL DEFAULT 1,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, finding_id)
);
CREATE INDEX IF NOT EXISTS live_audit_observations_finding_idx
  ON public.live_audit_observations(finding_id, observed_at DESC);

-- ── 4. Fixes ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_audit_fixes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES public.live_audit_findings(id) ON DELETE CASCADE,
  run_id UUID REFERENCES public.live_audit_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  -- Every live-audit defect is fixed by Claude, whatever its severity.
  engine TEXT NOT NULL DEFAULT 'claude_code',
  model TEXT,
  repo_full_name TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  workflow_run_id BIGINT,
  workflow_run_url TEXT,
  verification JSONB,
  files_changed INTEGER,
  lines_added INTEGER,
  lines_removed INTEGER,
  summary TEXT,
  last_error TEXT,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'operator',
  dispatch_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatched_at TIMESTAMPTZ,
  merged_at TIMESTAMPTZ,
  fix_confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  pr_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT live_audit_fixes_engine_check CHECK (engine = 'claude_code'),
  CONSTRAINT live_audit_fixes_status_check CHECK (status IN (
    'queued', 'dispatched', 'pr_opened', 'pr_updated', 'merged', 'closed', 'failed', 'canceled'
  )),
  CONSTRAINT live_audit_fixes_source_check CHECK (source IN ('operator', 'autofix')),
  CONSTRAINT live_audit_fixes_branch_check CHECK (branch_name ~ '^live-audit/fix-[A-Za-z0-9._-]{1,180}$')
);
-- Never two fixes in flight for one finding.
CREATE UNIQUE INDEX IF NOT EXISTS live_audit_fixes_one_in_flight
  ON public.live_audit_fixes(finding_id) WHERE status IN ('queued', 'dispatched', 'pr_opened', 'pr_updated');
CREATE INDEX IF NOT EXISTS live_audit_fixes_finding_idx ON public.live_audit_fixes(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_audit_fixes_run_idx ON public.live_audit_fixes(run_id);
CREATE INDEX IF NOT EXISTS live_audit_fixes_requested_by_idx ON public.live_audit_fixes(requested_by);

DROP TRIGGER IF EXISTS live_audit_fixes_updated_at ON public.live_audit_fixes;
CREATE TRIGGER live_audit_fixes_updated_at
  BEFORE UPDATE ON public.live_audit_fixes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 5. Events ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES public.live_audit_runs(id) ON DELETE CASCADE,
  finding_id UUID REFERENCES public.live_audit_findings(id) ON DELETE CASCADE,
  fix_id UUID REFERENCES public.live_audit_fixes(id) ON DELETE CASCADE,
  actor UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_audit_events_run_idx ON public.live_audit_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS live_audit_events_finding_idx ON public.live_audit_events(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_audit_events_fix_idx ON public.live_audit_events(fix_id);
CREATE INDEX IF NOT EXISTS live_audit_events_actor_idx ON public.live_audit_events(actor);

-- ── 6. Replay protection for the run and fix callbacks ────────────────────
-- Closed to every role but the service role: the REVOKE is the control, not a
-- policy (scripts/check-rls-policies.mjs).

CREATE TABLE IF NOT EXISTS public.live_audit_callback_receipts (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'fix')),
  subject_id UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_audit_callback_receipts_received_idx
  ON public.live_audit_callback_receipts(received_at);

-- ── 7. Access ─────────────────────────────────────────────────────────────
-- Operators read; every write is the service role's, behind a server function
-- that checked the person is an admin, or behind a signed callback.

REVOKE ALL ON public.live_audit_settings, public.live_audit_runs, public.live_audit_findings,
  public.live_audit_observations, public.live_audit_events, public.live_audit_fixes,
  public.live_audit_callback_receipts FROM anon, authenticated;
GRANT SELECT ON public.live_audit_settings, public.live_audit_runs, public.live_audit_findings,
  public.live_audit_observations, public.live_audit_events, public.live_audit_fixes TO authenticated;
GRANT ALL ON public.live_audit_settings, public.live_audit_runs, public.live_audit_findings,
  public.live_audit_observations, public.live_audit_events, public.live_audit_fixes,
  public.live_audit_callback_receipts TO service_role;

ALTER TABLE public.live_audit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_fixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audit_callback_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_audit_settings read operator+" ON public.live_audit_settings;
CREATE POLICY "live_audit_settings read operator+"
  ON public.live_audit_settings FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "live_audit_runs read operator+" ON public.live_audit_runs;
CREATE POLICY "live_audit_runs read operator+"
  ON public.live_audit_runs FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "live_audit_findings read operator+" ON public.live_audit_findings;
CREATE POLICY "live_audit_findings read operator+"
  ON public.live_audit_findings FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "live_audit_observations read operator+" ON public.live_audit_observations;
CREATE POLICY "live_audit_observations read operator+"
  ON public.live_audit_observations FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "live_audit_events read operator+" ON public.live_audit_events;
CREATE POLICY "live_audit_events read operator+"
  ON public.live_audit_events FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "live_audit_fixes read operator+" ON public.live_audit_fixes;
CREATE POLICY "live_audit_fixes read operator+"
  ON public.live_audit_fixes FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

-- ── 8. Evidence ───────────────────────────────────────────────────────────
-- One screenshot per finding, replaced as it is seen again. Private: the
-- application's pages carry client data, so the browser reads one only through
-- a signed URL a server function issues after its operator check.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('live-audit-evidence', 'live-audit-evidence', false, 1048576, ARRAY['image/jpeg', 'image/png']::TEXT[])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── 9. Ingest ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.live_audit_ingest_findings(p_run_id UUID, p_findings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_run        public.live_audit_runs%ROWTYPE;
  v_f          JSONB;
  v_id         UUID;
  v_state      TEXT;
  v_last_run   UUID;
  v_triaged    UUID;
  v_inserted   INTEGER := 0;
  v_updated    INTEGER := 0;
  v_regressed  INTEGER := 0;
  v_ineffective INTEGER := 0;
  v_ids        JSONB := '[]'::jsonb;
  v_occ        INTEGER;
BEGIN
  SELECT * INTO v_run FROM public.live_audit_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live audit run % does not exist', p_run_id USING ERRCODE = 'P0002';
  END IF;

  FOR v_f IN SELECT * FROM jsonb_array_elements(COALESCE(p_findings, '[]'::jsonb)) LOOP
    v_occ := GREATEST(1, COALESCE((v_f->>'occurrences')::INTEGER, 1));
    v_id := NULL;
    INSERT INTO public.live_audit_findings (
      target_key, fingerprint, severity, category, detector, title, description, route,
      route_template, repro_steps, evidence, suspected_files, fix_hint, confidence,
      deterministic, reproduced, judged_by, occurrences, first_seen_run_id, last_seen_run_id
    ) VALUES (
      v_run.target_key, v_f->>'fingerprint', v_f->>'severity', v_f->>'category', v_f->>'detector',
      v_f->>'title', v_f->>'description', v_f->>'route', v_f->>'route_template',
      COALESCE(v_f->'repro_steps', '[]'::jsonb), COALESCE(v_f->'evidence', '{}'::jsonb),
      COALESCE(v_f->'suspected_files', '[]'::jsonb), v_f->>'fix_hint',
      NULLIF(v_f->>'confidence', '')::NUMERIC, COALESCE((v_f->>'deterministic')::BOOLEAN, false),
      NULLIF(v_f->>'reproduced', '')::BOOLEAN, v_f->>'judged_by', v_occ, p_run_id, p_run_id
    )
    ON CONFLICT (target_key, fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
      INSERT INTO public.live_audit_events (run_id, finding_id, event_type, to_state, payload)
      VALUES (p_run_id, v_id, 'detected', 'open',
              jsonb_build_object('severity', v_f->>'severity', 'detector', v_f->>'detector'));
    ELSE
      SELECT id, state, last_seen_run_id, triaged_by INTO v_id, v_state, v_last_run, v_triaged
        FROM public.live_audit_findings
       WHERE target_key = v_run.target_key AND fingerprint = v_f->>'fingerprint'
       FOR UPDATE;
      v_updated := v_updated + 1;
      UPDATE public.live_audit_findings SET
        -- A person's verdict on severity outlives the next run's opinion.
        severity = CASE WHEN v_triaged IS NOT NULL THEN severity ELSE v_f->>'severity' END,
        category = v_f->>'category',
        title = v_f->>'title',
        description = v_f->>'description',
        route = v_f->>'route',
        route_template = v_f->>'route_template',
        repro_steps = COALESCE(v_f->'repro_steps', repro_steps),
        evidence = COALESCE(v_f->'evidence', evidence),
        suspected_files = COALESCE(v_f->'suspected_files', suspected_files),
        fix_hint = COALESCE(v_f->>'fix_hint', fix_hint),
        confidence = COALESCE(NULLIF(v_f->>'confidence', '')::NUMERIC, confidence),
        deterministic = deterministic OR COALESCE((v_f->>'deterministic')::BOOLEAN, false),
        reproduced = COALESCE(NULLIF(v_f->>'reproduced', '')::BOOLEAN, reproduced),
        judged_by = COALESCE(v_f->>'judged_by', judged_by),
        occurrences = occurrences + v_occ,
        runs_seen = runs_seen + CASE WHEN v_last_run IS DISTINCT FROM p_run_id THEN 1 ELSE 0 END,
        missed_runs = 0,
        absent_since = NULL,
        last_seen_run_id = p_run_id,
        last_seen_at = now(),
        -- Back after it was resolved: a regression. Still here after its fix
        -- merged: the fix did not work. Either way it is open again.
        state = CASE WHEN v_state IN ('resolved', 'fix_merged') THEN 'open' ELSE state END,
        resolution = CASE WHEN v_state IN ('resolved', 'fix_merged') THEN NULL ELSE resolution END,
        resolved_at = CASE WHEN v_state IN ('resolved', 'fix_merged') THEN NULL ELSE resolved_at END,
        resolved_by_run_id = CASE WHEN v_state IN ('resolved', 'fix_merged') THEN NULL ELSE resolved_by_run_id END
      WHERE id = v_id;

      IF v_state = 'resolved' THEN
        v_regressed := v_regressed + 1;
        INSERT INTO public.live_audit_events (run_id, finding_id, event_type, from_state, to_state)
        VALUES (p_run_id, v_id, 'regressed', 'resolved', 'open');
      ELSIF v_state = 'fix_merged' THEN
        v_ineffective := v_ineffective + 1;
        INSERT INTO public.live_audit_events (run_id, finding_id, event_type, from_state, to_state)
        VALUES (p_run_id, v_id, 'fix_ineffective', 'fix_merged', 'open');
      END IF;
    END IF;

    INSERT INTO public.live_audit_observations (run_id, finding_id, occurrences)
    VALUES (p_run_id, v_id, v_occ)
    ON CONFLICT (run_id, finding_id) DO UPDATE SET occurrences = live_audit_observations.occurrences + excluded.occurrences;

    v_ids := v_ids || jsonb_build_object('fingerprint', v_f->>'fingerprint', 'id', v_id);
  END LOOP;

  UPDATE public.live_audit_runs SET
    findings_reported = findings_reported + jsonb_array_length(COALESCE(p_findings, '[]'::jsonb)),
    findings_new = findings_new + v_inserted,
    regressions = regressions + v_regressed + v_ineffective,
    batches_received = batches_received + 1
  WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated, 'regressions', v_regressed,
    'fix_ineffective', v_ineffective, 'ids', v_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.live_audit_ingest_findings(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_audit_ingest_findings(UUID, JSONB) TO service_role;

-- ── 10. Finalize ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.live_audit_finalize_run(
  p_run_id UUID, p_summary JSONB, p_complete BOOLEAN, p_covered TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_run       public.live_audit_runs%ROWTYPE;
  v_missed    INTEGER := 0;
  v_resolved  INTEGER := 0;
  v_confirmed INTEGER := 0;
  r           RECORD;
BEGIN
  SELECT * INTO v_run FROM public.live_audit_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live audit run % does not exist', p_run_id USING ERRCODE = 'P0002';
  END IF;
  -- Under the row lock: a run the sweep closed since the callback read it
  -- resolves nothing and is not reopened.
  IF v_run.status NOT IN ('queued', 'dispatched', 'running') THEN
    RETURN jsonb_build_object('skipped', 'the run is ' || v_run.status);
  END IF;

  -- Absence counts only on a complete run, and only on the pages it opened.
  IF COALESCE(p_complete, false) AND COALESCE(array_length(p_covered, 1), 0) > 0 THEN
    FOR r IN
      SELECT id, state, deterministic, missed_runs
        FROM public.live_audit_findings
       WHERE target_key = v_run.target_key
         AND state IN ('open', 'triaging', 'fix_queued', 'fix_in_progress', 'fix_pr_open', 'fix_merged')
         AND route_template = ANY (p_covered)
         AND last_seen_run_id IS DISTINCT FROM p_run_id
       FOR UPDATE
    LOOP
      v_missed := v_missed + 1;
      IF r.state = 'fix_merged' AND (r.deterministic OR r.missed_runs + 1 >= 2) THEN
        UPDATE public.live_audit_findings SET
          missed_runs = missed_runs + 1, absent_since = COALESCE(absent_since, now()),
          state = 'resolved', resolution = 'fixed', resolved_at = now(), resolved_by_run_id = p_run_id
        WHERE id = r.id;
        UPDATE public.live_audit_fixes SET fix_confirmed_at = now()
         WHERE finding_id = r.id AND status = 'merged' AND fix_confirmed_at IS NULL;
        INSERT INTO public.live_audit_events (run_id, finding_id, event_type, from_state, to_state)
        VALUES (p_run_id, r.id, 'fix_confirmed', 'fix_merged', 'resolved');
        v_confirmed := v_confirmed + 1;
      -- Parenthesised: PL/pgSQL ends an ELSIF condition at its first THEN,
      -- including one inside a bare CASE.
      ELSIF r.state <> 'fix_merged'
        AND r.missed_runs + 1 >= (CASE WHEN r.deterministic THEN 2 ELSE 4 END) THEN
        UPDATE public.live_audit_findings SET
          missed_runs = missed_runs + 1, absent_since = COALESCE(absent_since, now()),
          state = 'resolved', resolution = 'absent', resolved_at = now(), resolved_by_run_id = p_run_id
        WHERE id = r.id;
        INSERT INTO public.live_audit_events (run_id, finding_id, event_type, from_state, to_state, payload)
        VALUES (p_run_id, r.id, 'resolved_absent', r.state, 'resolved',
                jsonb_build_object('missed_runs', r.missed_runs + 1));
        v_resolved := v_resolved + 1;
      ELSE
        UPDATE public.live_audit_findings SET
          missed_runs = missed_runs + 1, absent_since = COALESCE(absent_since, now())
        WHERE id = r.id;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.live_audit_runs SET
    status = 'completed',
    summary = p_summary,
    complete = COALESCE(p_complete, false),
    findings_resolved = v_resolved + v_confirmed,
    cost_usd = NULLIF(p_summary #>> '{anthropic,usd}', '')::NUMERIC,
    completed_at = now(),
    last_error = NULL
  WHERE id = p_run_id;

  RETURN jsonb_build_object('missed', v_missed, 'resolved', v_resolved, 'fix_confirmed', v_confirmed);
END;
$$;

REVOKE ALL ON FUNCTION public.live_audit_finalize_run(UUID, JSONB, BOOLEAN, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_audit_finalize_run(UUID, JSONB, BOOLEAN, TEXT[]) TO service_role;

-- ── 11. When the nightly fires ────────────────────────────────────────────
-- The setting and the job, changed together, as `codex_set_nightly_schedule`
-- does: a column that recorded a schedule nobody ran is the fault that one
-- was written to end.

CREATE OR REPLACE FUNCTION public.live_audit_set_nightly_schedule(p_cron TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expr  TEXT := btrim(regexp_replace(COALESCE(p_cron, ''), '\s+', ' ', 'g'));
  v_jobid BIGINT;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: admin required' USING ERRCODE = '42501';
  END IF;
  IF v_expr !~ '^[0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+$' THEN
    RAISE EXCEPTION 'invalid cron expression "%": expected five fields of digits, *, /, - and ,', v_expr
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.live_audit_settings SET nightly_cron = v_expr, updated_by = auth.uid() WHERE target_key = 'prime';

  IF to_regnamespace('cron') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'applied', false, 'schedule', v_expr,
                              'reason', 'pg_cron is not installed on this database');
  END IF;

  EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1 LIMIT 1' INTO v_jobid USING 'live-audit-nightly';
  IF v_jobid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'applied', false, 'schedule', v_expr,
                              'reason', 'the live-audit-nightly job is not scheduled on this database');
  END IF;

  EXECUTE 'SELECT cron.alter_job(job_id := $1, schedule := $2)' USING v_jobid, v_expr;
  RETURN jsonb_build_object('ok', true, 'applied', true, 'schedule', v_expr, 'jobid', v_jobid);
END;
$$;

REVOKE ALL ON FUNCTION public.live_audit_set_nightly_schedule(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.live_audit_set_nightly_schedule(TEXT) TO authenticated;

-- ── 12. Schedules ─────────────────────────────────────────────────────────
-- Both read the cron credential from the vault INSIDE the command, per run
-- (scripts/check-cron-auth.mjs). The nightly hook stands down unless
-- `live_audit_settings.nightly_enabled` is on; the sweep re-dispatches what was
-- lost, times out what hung, starts the run's fixes when automatic fixes are
-- on, and follows fix pull requests to their merge.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron is not installed; the live audit is not scheduled';
    RETURN;
  END IF;
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- live-audit-nightly -> /hooks/live-audit-nightly   (13 16 * * *)
  PERFORM cron.unschedule('live-audit-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'live-audit-nightly');
  PERFORM cron.schedule(
    'live-audit-nightly',
    '13 16 * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 60000
      )$f$,
      v_base || '/hooks/live-audit-nightly'
    )
  );

  -- live-audit-sweep -> /hooks/live-audit-sweep   (*/10 * * * *)
  PERFORM cron.unschedule('live-audit-sweep')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'live-audit-sweep');
  PERFORM cron.schedule(
    'live-audit-sweep',
    '*/10 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 60000
      )$f$,
      v_base || '/hooks/live-audit-sweep'
    )
  );
END $$;
