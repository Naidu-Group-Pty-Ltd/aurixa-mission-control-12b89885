-- ────────────────────────────────────────────────────────────────────────
-- Codex Security: one record per finding, and a lifecycle that tells the truth.
--
-- @asserts column:codex_findings.target_key
-- @asserts column:codex_findings.pr_number
-- @asserts column:codex_findings.missed_scans
-- @asserts column:codex_findings.absent_since
-- @asserts column:codex_findings.last_seen_job_id
-- @asserts column:codex_findings.resolved_by_job_id
-- @asserts column:codex_findings.resolution
-- @asserts column:codex_findings.triaged_by
-- @asserts column:codex_findings.triage_reason
-- @asserts table:codex_finding_observations
-- @asserts table:codex_finding_events
-- @asserts table:codex_callback_receipts
-- @asserts column:security_intake_sources.previous_hmac_secret
-- @asserts column:security_intake_sources.hmac_rotated_at
-- @asserts column:cascade_events.hold_reason
-- @asserts column:codex_remediations.head_sha
-- @asserts column:codex_remediations.fix_ineffective_at
-- @asserts column:codex_remediations.merged_via
-- @asserts column:codex_remediation_reviews.head_sha
-- @asserts column:prime_config.codex_auto_merge_ceiling
-- @asserts column:prime_config.codex_deep_scan_scope
-- @asserts column:prime_config.codex_pr_check_enabled
-- @asserts column:prime_config.codex_pr_check_fail_on
-- @asserts column:prime_config.codex_cascade_gate
-- @asserts check:prime_config.codex_auto_merge_ceiling=off
-- @asserts check:prime_config.codex_deep_scan_scope=prime
-- @asserts check:prime_config.codex_pr_check_fail_on=high
-- @asserts check:prime_config.codex_cascade_gate=off
-- @asserts check:codex_findings.resolution=rotated
-- @asserts rpc:codex_ingest_scan_findings
-- @asserts rpc:codex_finalize_scan
-- @asserts rpc:codex_prime_overview
-- @asserts rpc:codex_fleet_overview
-- @asserts rpc:codex_set_nightly_schedule
--
-- WHAT WAS WRONG
--
-- Every scan wrote a NEW row for every finding it reported, and the cleanup
-- after a full scan only ever closed rows belonging to the scan immediately
-- before it. So one real issue seen by thirty nightly scans was thirty `open`
-- rows; after it was fixed, twenty-nine were still open; and when it came back
-- it was not flagged as a regression, because an older open copy always
-- outranked the resolved one. Every count built on `state = 'open'` — the fleet
-- table, the sidebar badge, /security, the clone card, the partner portal —
-- grew with the number of scans rather than the number of problems.
--
-- The carry-forward rules then made decisions impossible to change: an old
-- `dismissed` copy beat any later reopen, and a finding whose fix PR was closed
-- (`fix_drafted`) or merged without working (`fix_merged`) left the open count
-- for good while the scanner kept reporting it. "Fix confirmed by re-scan"
-- could not fire at all: merging moved the finding to `fix_merged`, and the
-- confirmation step only looked at rows still `open`.
--
-- WHAT THIS DOES
--
--   1. `codex_findings` becomes one row per (target, fingerprint). A target is
--      Prime or a clone, or a pull request against either (`pr_number`) — PR
--      scans look at unmerged code and must never move the main record.
--   2. `codex_finding_observations` records which scan saw which finding, so a
--      scan's own findings list still works without a row per scan.
--   3. `codex_finding_events` is the per-finding history: first seen,
--      regression, auto-resolved, fix confirmed / ineffective, every triage
--      decision with who and why.
--   4. Existing duplicates are merged into one survivor per group. Every row
--      that referenced a duplicate (remediations, tickets, self-healing runs,
--      partner mirrors) is re-pointed first, and every scan that saw a
--      duplicate is recorded as an observation of the survivor, so nothing a
--      person or a scan recorded is lost.
--   5. `codex_ingest_scan_findings` / `codex_finalize_scan` apply the lifecycle
--      in one transaction with row locks, instead of a read-compute-write in
--      the Worker that could overwrite a triage made mid-scan and that
--      silently truncated at PostgREST's 1,000-row ceiling. Absence only
--      resolves a finding when ITS scanner actually ran and every result batch
--      arrived; secrets are never resolved by absence (removing a credential
--      from the files does not un-leak it); the AI review must miss a finding
--      three times running.
--   6. `codex_callback_receipts` lets the webhooks refuse a replayed callback.
--   7. Settings for the policies this release makes explicit: unattended
--      auto-merge (off by default), which scans run the paid Codex review, PR
--      checks, and holding automatic cascades while Prime has open findings.
-- ────────────────────────────────────────────────────────────────────────

-- ── 1. codex_findings: target identity, lifecycle and triage columns ──────

ALTER TABLE public.codex_findings
  ADD COLUMN IF NOT EXISTS pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS missed_scans INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS absent_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_job_id UUID REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_by_job_id UUID REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution TEXT,
  ADD COLUMN IF NOT EXISTS triaged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_reason TEXT;

-- Generated so the identity can never drift from the columns it is made of.
DO $$ BEGIN
  ALTER TABLE public.codex_findings
    ADD COLUMN target_key TEXT
    GENERATED ALWAYS AS (COALESCE(clone_id::text, 'prime') || COALESCE(':pr:' || pr_number::text, '')) STORED;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.codex_findings
    ADD CONSTRAINT codex_findings_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('absent', 'fixed', 'rotated', 'manual', 'pr_closed', 'pr_merged'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS codex_findings_last_seen_job_idx
  ON public.codex_findings(last_seen_job_id);
CREATE INDEX IF NOT EXISTS codex_findings_resolved_by_job_idx
  ON public.codex_findings(resolved_by_job_id);
CREATE INDEX IF NOT EXISTS codex_findings_triaged_by_idx
  ON public.codex_findings(triaged_by);

-- ── 2. Observations and per-finding history ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.codex_finding_observations (
  job_id UUID NOT NULL REFERENCES public.codex_scan_jobs(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES public.codex_findings(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, finding_id)
);
CREATE INDEX IF NOT EXISTS codex_finding_observations_finding_idx
  ON public.codex_finding_observations(finding_id, observed_at DESC);

REVOKE ALL ON public.codex_finding_observations FROM anon, authenticated;
GRANT SELECT ON public.codex_finding_observations TO authenticated;
GRANT ALL ON public.codex_finding_observations TO service_role;
ALTER TABLE public.codex_finding_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "codex_finding_observations read operator+" ON public.codex_finding_observations;
CREATE POLICY "codex_finding_observations read operator+"
  ON public.codex_finding_observations FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.codex_finding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES public.codex_findings(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL,
  actor UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codex_finding_events_finding_idx
  ON public.codex_finding_events(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS codex_finding_events_job_idx
  ON public.codex_finding_events(job_id);
CREATE INDEX IF NOT EXISTS codex_finding_events_actor_idx
  ON public.codex_finding_events(actor);

-- Written by the service role only (the webhook, the scan functions, and the
-- triage server function after its own admin check). Operators read.
REVOKE ALL ON public.codex_finding_events FROM anon, authenticated;
GRANT SELECT ON public.codex_finding_events TO authenticated;
GRANT ALL ON public.codex_finding_events TO service_role;
ALTER TABLE public.codex_finding_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "codex_finding_events read operator+" ON public.codex_finding_events;
CREATE POLICY "codex_finding_events read operator+"
  ON public.codex_finding_events FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

-- ── 3. Replay protection for the scan and remediation callbacks ──────────
-- One row per accepted signature. Closed to every role but the service role:
-- the REVOKE is the control, not a policy (see check-rls-policies.mjs).

CREATE TABLE IF NOT EXISTS public.codex_callback_receipts (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'remediation')),
  subject_id UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codex_callback_receipts_received_idx
  ON public.codex_callback_receipts(received_at);

REVOKE ALL ON public.codex_callback_receipts FROM anon, authenticated;
GRANT ALL ON public.codex_callback_receipts TO service_role;
ALTER TABLE public.codex_callback_receipts ENABLE ROW LEVEL SECURITY;

-- The scan master never leaves Mission Control now: each job's key is derived
-- from it. Rotating it must not orphan scans already running, so the previous
-- value is kept for a grace window — in its own column, because `metadata` is
-- returned to the intake settings page and a secret has no business there.
ALTER TABLE public.security_intake_sources
  ADD COLUMN IF NOT EXISTS previous_hmac_secret TEXT,
  ADD COLUMN IF NOT EXISTS hmac_rotated_at TIMESTAMPTZ;

-- ── 4. Remediation evidence, approvals pinned to a commit, and policy ────

ALTER TABLE public.codex_remediations
  ADD COLUMN IF NOT EXISTS head_sha TEXT,
  ADD COLUMN IF NOT EXISTS fix_ineffective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fix_ineffective_job_id UUID REFERENCES public.codex_scan_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_via TEXT;
CREATE INDEX IF NOT EXISTS codex_remediations_fix_ineffective_job_idx
  ON public.codex_remediations(fix_ineffective_job_id);
CREATE INDEX IF NOT EXISTS codex_remediations_repo_pr_idx
  ON public.codex_remediations(repo_full_name, pr_number);

-- Why an automatic cascade is held when the reason is not blast radius: the
-- security gate (Prime has open findings at or above codex_cascade_gate), or
-- an unattended self-healing merge. The drain's gate reassessment discharges
-- a gate the blast-radius rule no longer owes; a held event with a reason
-- here stands until a person approves it.
ALTER TABLE public.cascade_events
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

-- The commit a reviewer approved. An approval for an older head does not
-- count once the branch moves, and the merge is pinned to the head that the
-- counted approvals name.
ALTER TABLE public.codex_remediation_reviews
  ADD COLUMN IF NOT EXISTS head_sha TEXT;

ALTER TABLE public.prime_config
  ADD COLUMN IF NOT EXISTS codex_auto_merge_ceiling TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS codex_deep_scan_scope TEXT NOT NULL DEFAULT 'prime',
  ADD COLUMN IF NOT EXISTS codex_pr_check_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS codex_pr_check_fail_on TEXT NOT NULL DEFAULT 'high',
  ADD COLUMN IF NOT EXISTS codex_cascade_gate TEXT NOT NULL DEFAULT 'off';

DO $$ BEGIN
  ALTER TABLE public.prime_config ADD CONSTRAINT prime_config_codex_auto_merge_ceiling_check
    CHECK (codex_auto_merge_ceiling IN ('off', 'info', 'low', 'medium'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.prime_config ADD CONSTRAINT prime_config_codex_deep_scan_scope_check
    CHECK (codex_deep_scan_scope IN ('off', 'prime', 'fleet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.prime_config ADD CONSTRAINT prime_config_codex_pr_check_fail_on_check
    CHECK (codex_pr_check_fail_on IN ('critical', 'high', 'medium', 'low', 'never'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.prime_config ADD CONSTRAINT prime_config_codex_cascade_gate_check
    CHECK (codex_cascade_gate IN ('off', 'critical', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 5. Existing data: PR scans to their own targets, then one row per finding ──

-- Rows written by PR scans described unmerged code but were stored against the
-- main target. Give them their PR number so they stop counting against it.
UPDATE public.codex_findings f
   SET pr_number = (j.request_payload->>'pr')::integer
  FROM public.codex_scan_jobs j
 WHERE f.scan_job_id = j.id
   AND j.kind = 'pr_open'
   AND f.pr_number IS NULL
   AND (j.request_payload->>'pr') ~ '^[0-9]{1,9}$';

-- PR findings nobody has seen for two weeks belong to pull requests that are
-- long closed; nothing will ever deliver their close event now.
UPDATE public.codex_findings
   SET state = 'resolved',
       resolved_at = COALESCE(resolved_at, now()),
       resolution = 'pr_closed'
 WHERE pr_number IS NOT NULL
   AND state IN ('open', 'triaging')
   AND last_seen_at < now() - interval '14 days';

-- Survivor per (target, fingerprint): the row a remediation already points at
-- when there is one (so the fewest links move), otherwise the latest seen.
CREATE TEMP TABLE codex_dedup_map ON COMMIT DROP AS
WITH flagged AS (
  SELECT f.id, f.target_key, f.fingerprint, f.last_seen_at, f.created_at,
         EXISTS (SELECT 1 FROM public.codex_remediations r WHERE r.finding_id = f.id) AS has_remediation
    FROM public.codex_findings f
   WHERE f.fingerprint IS NOT NULL
)
SELECT id,
       first_value(id) OVER (
         PARTITION BY target_key, fingerprint
         ORDER BY has_remediation DESC, last_seen_at DESC, created_at DESC, id DESC
       ) AS survivor_id
  FROM flagged;

-- The merged state of each group, decided before anything moves. Deliberate
-- verdicts win (the most recent one), then remediation progress; otherwise the
-- LATEST scan's view of it — which is what un-inflates the counts.
CREATE TEMP TABLE codex_dedup_state ON COMMIT DROP AS
SELECT m.survivor_id,
       (CASE
          WHEN bool_or(f.state IN ('dismissed', 'false_positive')) THEN
            (array_agg(f.state::text ORDER BY f.updated_at DESC)
               FILTER (WHERE f.state IN ('dismissed', 'false_positive')))[1]
          WHEN bool_or(f.state = 'fix_merged') THEN 'fix_merged'
          WHEN bool_or(f.state = 'pr_open') THEN 'pr_open'
          WHEN bool_or(f.state = 'fix_drafted') THEN 'fix_drafted'
          WHEN bool_or(f.state = 'triaging') THEN 'triaging'
          ELSE (array_agg(f.state::text ORDER BY f.created_at DESC))[1]
        END)::public.codex_finding_state AS state,
       min(f.first_seen_at) AS first_seen_at,
       max(f.last_seen_at) AS last_seen_at,
       (array_agg(f.scan_job_id ORDER BY f.created_at DESC) FILTER (WHERE f.scan_job_id IS NOT NULL))[1]
         AS last_seen_job_id,
       (array_agg(f.resolved_at ORDER BY f.created_at DESC))[1] AS latest_resolved_at,
       count(*) AS members
  FROM public.codex_findings f
  JOIN codex_dedup_map m ON m.id = f.id
 GROUP BY m.survivor_id;

-- Every scan that saw any copy saw the survivor.
INSERT INTO public.codex_finding_observations (job_id, finding_id, observed_at)
SELECT f.scan_job_id, m.survivor_id, min(f.created_at)
  FROM public.codex_findings f
  JOIN codex_dedup_map m ON m.id = f.id
 WHERE f.scan_job_id IS NOT NULL
 GROUP BY f.scan_job_id, m.survivor_id
ON CONFLICT (job_id, finding_id) DO NOTHING;

-- Re-point everything that referenced a duplicate.
UPDATE public.codex_remediations r
   SET finding_id = m.survivor_id
  FROM codex_dedup_map m
 WHERE r.finding_id = m.id AND m.id <> m.survivor_id;

UPDATE public.support_tickets t
   SET codex_finding_id = m.survivor_id
  FROM codex_dedup_map m
 WHERE t.codex_finding_id = m.id AND m.id <> m.survivor_id;

UPDATE public.remediation_runs rr
   SET finding_id = m.survivor_id
  FROM codex_dedup_map m
 WHERE rr.finding_id = m.id AND m.id <> m.survivor_id;

UPDATE public.security_external_tickets et
   SET codex_finding_id = m.survivor_id
  FROM codex_dedup_map m
 WHERE et.codex_finding_id = m.id AND m.id <> m.survivor_id;

-- A partner assessment holds at most one mirror per Codex finding. Where an
-- assessment mirrored several copies, the copy a reviewer has acted on keeps
-- the link; the rest keep their partner data and lose only the link (ON DELETE
-- SET NULL below), so nothing a reviewer wrote is removed.
WITH candidates AS (
  SELECT s.id, s.assessment_id, m.survivor_id,
         row_number() OVER (
           PARTITION BY s.assessment_id, m.survivor_id
           ORDER BY (s.status <> 'open') DESC, s.updated_at DESC, s.id
         ) AS rn
    FROM public.security_findings s
    JOIN codex_dedup_map m ON s.codex_finding_id = m.id
   WHERE m.id <> m.survivor_id
)
UPDATE public.security_findings s
   SET codex_finding_id = c.survivor_id
  FROM candidates c
 WHERE s.id = c.id
   AND c.rn = 1
   AND NOT EXISTS (
     SELECT 1 FROM public.security_findings x
      WHERE x.assessment_id = c.assessment_id AND x.codex_finding_id = c.survivor_id
   );

DELETE FROM public.codex_findings f
 USING codex_dedup_map m
 WHERE f.id = m.id AND m.id <> m.survivor_id;

UPDATE public.codex_findings f
   SET state = s.state,
       first_seen_at = s.first_seen_at,
       last_seen_at = s.last_seen_at,
       last_seen_job_id = COALESCE(s.last_seen_job_id, f.scan_job_id),
       resolved_at = CASE WHEN s.state = 'resolved' THEN COALESCE(s.latest_resolved_at, f.resolved_at, now()) ELSE NULL END,
       resolution = CASE
                      WHEN s.state <> 'resolved' THEN NULL
                      WHEN f.pr_number IS NOT NULL THEN COALESCE(f.resolution, 'pr_closed')
                      ELSE COALESCE(f.resolution, 'absent')
                    END
  FROM codex_dedup_state s
 WHERE f.id = s.survivor_id;

-- A finding parked in a remediation state with no live remediation behind it
-- is an open finding that a failed or closed fix PR hid from every count.
UPDATE public.codex_findings f
   SET state = 'open'
 WHERE f.state IN ('fix_drafted', 'pr_open')
   AND NOT EXISTS (
     SELECT 1 FROM public.codex_remediations r
      WHERE r.finding_id = f.id
        AND r.status IN ('queued', 'dispatched', 'pr_opened', 'pr_updated', 'approved', 'changes_requested')
   );

UPDATE public.codex_findings
   SET last_seen_job_id = scan_job_id
 WHERE last_seen_job_id IS NULL AND scan_job_id IS NOT NULL;

-- The identity, enforced. Intake findings already carry a `source:external_id`
-- fingerprint that is unique on its own, so they satisfy this too.
CREATE UNIQUE INDEX IF NOT EXISTS codex_findings_target_fingerprint_uidx
  ON public.codex_findings(target_key, fingerprint);
CREATE INDEX IF NOT EXISTS codex_findings_target_state_idx
  ON public.codex_findings(target_key, state, severity);

-- ── 6. Ingest: one batch of reported findings, applied under row locks ───

CREATE OR REPLACE FUNCTION public.codex_ingest_scan_findings(p_job_id UUID, p_findings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_job          RECORD;
  v_pr           INTEGER;
  v_target       TEXT;
  v_f            JSONB;
  v_fp           TEXT;
  v_legacy       TEXT;
  v_row          public.codex_findings%ROWTYPE;
  v_found        BOOLEAN;
  v_id           UUID;
  v_new_state    public.codex_finding_state;
  v_severity     public.codex_finding_severity;
  v_rem_id       UUID;
  v_reopened     BOOLEAN;
  v_stored       INTEGER := 0;
  v_created      INTEGER := 0;
  v_regressions  INTEGER := 0;
  v_ineffective  INTEGER := 0;
  v_rekeyed      INTEGER := 0;
BEGIN
  SELECT id, kind, clone_id, status, created_at, request_payload
    INTO v_job
    FROM public.codex_scan_jobs
   WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_ingest_scan_findings: unknown scan job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_job.kind = 'pr_open' AND (v_job.request_payload->>'pr') ~ '^[0-9]{1,9}$' THEN
    v_pr := (v_job.request_payload->>'pr')::integer;
  END IF;
  v_target := COALESCE(v_job.clone_id::text, 'prime') || COALESCE(':pr:' || v_pr::text, '');

  FOR v_f IN SELECT value FROM jsonb_array_elements(COALESCE(p_findings, '[]'::jsonb)) LOOP
    v_fp := NULLIF(COALESCE(v_f->>'fingerprint', v_f->>'id'), '');
    CONTINUE WHEN v_fp IS NULL;
    v_legacy := NULLIF(v_f->>'legacy_fingerprint', '');
    v_severity := COALESCE(NULLIF(v_f->>'severity', ''), 'medium')::public.codex_finding_severity;
    v_reopened := false;
    v_id := NULL;

    SELECT * INTO v_row
      FROM public.codex_findings
     WHERE target_key = v_target AND fingerprint = v_fp
     FOR UPDATE;
    v_found := FOUND;

    -- A finding recorded under the previous fingerprint scheme keeps its
    -- identity, history, triage and remediation links: it is re-keyed rather
    -- than resolved and re-opened as a stranger.
    IF NOT v_found AND v_legacy IS NOT NULL AND v_legacy <> v_fp THEN
      SELECT * INTO v_row
        FROM public.codex_findings
       WHERE target_key = v_target AND fingerprint = v_legacy AND scan_job_id IS NOT NULL
       FOR UPDATE;
      IF FOUND THEN
        UPDATE public.codex_findings
           SET fingerprint = v_fp, codex_finding_id = v_fp
         WHERE id = v_row.id;
        v_found := true;
        v_rekeyed := v_rekeyed + 1;
      END IF;
    END IF;

    IF NOT v_found THEN
      INSERT INTO public.codex_findings (
        scan_job_id, last_seen_job_id, clone_id, pr_number, codex_finding_id, fingerprint,
        title, severity, state, description, affected_file, affected_line, cwe, cvss,
        auto_fix_confidence, scanner, rule_id, snippet, source_slug, first_seen_at,
        last_seen_at, raw
      ) VALUES (
        p_job_id, p_job_id, v_job.clone_id, v_pr, v_fp, v_fp,
        left(COALESCE(NULLIF(v_f->>'title', ''), '(untitled finding)'), 500), v_severity, 'open',
        v_f->>'description', v_f->>'file', (v_f->>'line')::integer, v_f->>'cwe',
        (v_f->>'cvss')::numeric, (v_f->>'auto_fix_confidence')::numeric, v_f->>'scanner',
        v_f->>'rule_id', v_f->>'snippet', 'codex', now(), now(),
        COALESCE(v_f->'raw', '{}'::jsonb)
      )
      ON CONFLICT (target_key, fingerprint) DO NOTHING
      RETURNING id INTO v_id;

      IF v_id IS NOT NULL THEN
        v_created := v_created + 1;
        INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, to_state)
        VALUES (v_id, p_job_id, 'first_seen', 'open');
      ELSE
        -- A concurrent batch inserted it first; treat it as already known.
        SELECT * INTO v_row
          FROM public.codex_findings
         WHERE target_key = v_target AND fingerprint = v_fp
         FOR UPDATE;
        v_found := FOUND;
      END IF;
    END IF;

    IF v_found THEN
      v_new_state := v_row.state;

      IF v_row.state = 'resolved' AND COALESCE(v_row.resolution, '') <> 'rotated' THEN
        -- A credential marked rotated stays resolved when its (now dead) value
        -- is reported again: history cannot be unwritten, and the verdict is
        -- about the credential, not the text.
        v_new_state := 'open';
        v_reopened := true;
        v_regressions := v_regressions + 1;
        INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, payload)
        VALUES (v_row.id, p_job_id, 'regression', 'resolved', 'open',
                jsonb_build_object('previous_resolution', v_row.resolution));
      ELSIF v_row.state = 'fix_merged' THEN
        -- Reported by a scan created after the fix merged: the fix did not work.
        SELECT r.id INTO v_rem_id
          FROM public.codex_remediations r
         WHERE r.finding_id = v_row.id
           AND r.status = 'merged'
           AND r.merged_at IS NOT NULL
           AND r.merged_at < v_job.created_at
         ORDER BY r.merged_at DESC
         LIMIT 1;
        IF v_rem_id IS NOT NULL THEN
          v_new_state := 'open';
          v_reopened := true;
          v_ineffective := v_ineffective + 1;
          UPDATE public.codex_remediations
             SET fix_ineffective_at = COALESCE(fix_ineffective_at, now()),
                 fix_ineffective_job_id = COALESCE(fix_ineffective_job_id, p_job_id)
           WHERE id = v_rem_id;
          INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, payload)
          VALUES (v_row.id, p_job_id, 'fix_ineffective', 'fix_merged', 'open',
                  jsonb_build_object('remediation_id', v_rem_id));
        END IF;
      END IF;

      UPDATE public.codex_findings
         SET state = v_new_state,
             resolved_at = CASE WHEN v_reopened THEN NULL ELSE resolved_at END,
             resolution = CASE WHEN v_reopened THEN NULL ELSE resolution END,
             resolved_by_job_id = CASE WHEN v_reopened THEN NULL ELSE resolved_by_job_id END,
             last_seen_at = now(),
             last_seen_job_id = p_job_id,
             missed_scans = 0,
             absent_since = NULL,
             title = left(COALESCE(NULLIF(v_f->>'title', ''), title), 500),
             severity = v_severity,
             description = COALESCE(v_f->>'description', description),
             affected_file = COALESCE(v_f->>'file', affected_file),
             affected_line = COALESCE((v_f->>'line')::integer, affected_line),
             cwe = COALESCE(v_f->>'cwe', cwe),
             cvss = COALESCE((v_f->>'cvss')::numeric, cvss),
             auto_fix_confidence = COALESCE((v_f->>'auto_fix_confidence')::numeric, auto_fix_confidence),
             scanner = COALESCE(v_f->>'scanner', scanner),
             rule_id = COALESCE(v_f->>'rule_id', rule_id),
             snippet = v_f->>'snippet',
             raw = COALESCE(v_f->'raw', raw)
       WHERE id = v_row.id;
      v_id := v_row.id;
    END IF;

    IF v_id IS NOT NULL THEN
      INSERT INTO public.codex_finding_observations (job_id, finding_id)
      VALUES (p_job_id, v_id)
      ON CONFLICT (job_id, finding_id) DO NOTHING;
      v_stored := v_stored + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'stored', v_stored,
    'created', v_created,
    'regressions', v_regressions,
    'fix_ineffective', v_ineffective,
    'rekeyed', v_rekeyed,
    'target_key', v_target
  );
END;
$$;

REVOKE ALL ON FUNCTION public.codex_ingest_scan_findings(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.codex_ingest_scan_findings(UUID, JSONB) TO service_role;

-- ── 7. Finalize: absence, fix verdicts, counts, and the job's own close ──

CREATE OR REPLACE FUNCTION public.codex_finalize_scan(p_job_id UUID, p_summary JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_job            RECORD;
  v_pr             INTEGER;
  v_target         TEXT;
  v_scanners       JSONB := COALESCE(p_summary->'scanners', '{}'::jsonb);
  v_version        INTEGER;
  v_ok             TEXT[];
  v_expected       INTEGER;
  v_observed       INTEGER;
  v_cb_failures    INTEGER;
  v_complete       BOOLEAN;
  v_scope          TEXT;
  v_full_tree      BOOLEAN;
  v_pr_target      BOOLEAN;
  v_absence        BOOLEAN;
  v_row            RECORD;
  v_missed         INTEGER;
  v_threshold      INTEGER;
  v_secret         BOOLEAN;
  v_confirmed_now  INTEGER;
  v_auto_resolved  INTEGER := 0;
  v_confirmed      INTEGER := 0;
  v_absent_secrets INTEGER := 0;
  v_counts         JSONB;
  v_open_total     INTEGER;
  v_result         JSONB;
BEGIN
  SELECT id, kind, clone_id, status, created_at, request_payload
    INTO v_job
    FROM public.codex_scan_jobs
   WHERE id = p_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'codex_finalize_scan: unknown scan job %', p_job_id USING ERRCODE = 'P0002';
  END IF;
  IF v_job.status IN ('completed', 'failed', 'canceled') THEN
    RETURN jsonb_build_object('already_final', true, 'status', v_job.status);
  END IF;

  IF v_job.kind = 'pr_open' AND (v_job.request_payload->>'pr') ~ '^[0-9]{1,9}$' THEN
    v_pr := (v_job.request_payload->>'pr')::integer;
  END IF;
  v_target := COALESCE(v_job.clone_id::text, 'prime') || COALESCE(':pr:' || v_pr::text, '');
  IF jsonb_typeof(v_scanners) IS DISTINCT FROM 'object' THEN
    v_scanners := '{}'::jsonb;
  END IF;

  -- Which scanners may vouch for an absence. The current workflow reports a
  -- per-scanner status from each step's real exit; an older copy reported an
  -- `ok` flag that a failed osv-scanner download and a crashed AI pass both
  -- left looking healthy, so those two are never trusted from it.
  v_version := CASE WHEN (p_summary->>'workflow_version') ~ '^[0-9]+$'
                    THEN (p_summary->>'workflow_version')::integer ELSE 1 END;
  IF v_version >= 2 THEN
    v_ok := ARRAY(SELECT s.key FROM jsonb_each(v_scanners) s WHERE s.value->>'status' = 'ok');
  ELSE
    v_ok := ARRAY(
      SELECT s.key FROM jsonb_each(v_scanners) s
       WHERE jsonb_typeof(s.value) = 'object'
         AND (s.value->>'ok') = 'true'
         AND s.key NOT IN ('osv-scanner', 'codex')
    );
  END IF;

  v_expected := CASE WHEN (p_summary->>'total') ~ '^[0-9]+$' THEN (p_summary->>'total')::integer END;
  SELECT count(*) INTO v_observed FROM public.codex_finding_observations WHERE job_id = p_job_id;
  v_cb_failures := CASE WHEN (p_summary->>'callback_failures') ~ '^[0-9]+$'
                        THEN (p_summary->>'callback_failures')::integer ELSE 0 END;
  v_complete := v_cb_failures = 0 AND (v_expected IS NULL OR v_observed >= v_expected);

  -- What the scan looked at. A full-tree kind narrowed to a few paths saw
  -- nothing of the rest, so it cannot vouch for an absence there. Older
  -- workflows report no scope; they always scanned the whole tree.
  v_scope := COALESCE(NULLIF(p_summary->'scope'->>'mode', ''), 'full');
  v_full_tree := v_job.kind IN ('manual', 'nightly_full', 'post_merge_revalidate') AND v_scope = 'full';
  v_pr_target := v_job.kind = 'pr_open' AND v_scope IN ('diff', 'full');
  v_absence := v_complete AND (v_full_tree OR v_pr_target) AND cardinality(v_ok) > 0;

  IF v_absence THEN
    FOR v_row IN
      SELECT f.id, f.state, f.scanner, f.rule_id, f.affected_file, f.missed_scans, f.absent_since
        FROM public.codex_findings f
       WHERE f.target_key = v_target
         AND f.scan_job_id IS NOT NULL
         AND f.scanner = ANY (v_ok)
         AND f.state IN ('open', 'triaging', 'fix_drafted', 'pr_open', 'fix_merged', 'dismissed', 'false_positive')
         AND NOT EXISTS (
           SELECT 1 FROM public.codex_finding_observations o
            WHERE o.job_id = p_job_id AND o.finding_id = f.id
         )
       FOR UPDATE OF f
    LOOP
      v_missed := v_row.missed_scans + 1;
      v_secret := v_row.scanner IN ('gitleaks', 'gitleaks-history') AND NOT v_pr_target;
      v_threshold := CASE WHEN v_row.scanner = 'codex' AND NOT v_pr_target THEN 3 ELSE 1 END;

      UPDATE public.codex_findings
         SET missed_scans = v_missed,
             absent_since = COALESCE(absent_since, now())
       WHERE id = v_row.id;

      IF v_secret THEN
        IF v_row.absent_since IS NULL AND v_row.state NOT IN ('dismissed', 'false_positive') THEN
          v_absent_secrets := v_absent_secrets + 1;
          INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, reason)
          VALUES (v_row.id, p_job_id, 'absent_from_tree', v_row.state::text, v_row.state::text,
                  'No longer in the files. The credential stays exposed until it is rotated.');
        END IF;
        CONTINUE;
      END IF;

      CONTINUE WHEN v_missed < v_threshold;

      IF v_row.state IN ('open', 'triaging', 'fix_drafted', 'pr_open') THEN
        UPDATE public.codex_findings
           SET state = 'resolved', resolved_at = now(), resolution = 'absent',
               resolved_by_job_id = p_job_id
         WHERE id = v_row.id;
        v_auto_resolved := v_auto_resolved + 1;
        INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, payload)
        VALUES (v_row.id, p_job_id, 'auto_resolved', v_row.state::text, 'resolved',
                jsonb_build_object('missed_scans', v_missed));
      ELSIF v_row.state = 'fix_merged' THEN
        UPDATE public.codex_findings
           SET state = 'resolved', resolved_at = now(), resolution = 'fixed', resolved_by_job_id = p_job_id
         WHERE id = v_row.id;
        v_auto_resolved := v_auto_resolved + 1;

        -- Absence is evidence only when nothing of the same shape is still
        -- there: a fix that moved the vulnerable code rather than removing it
        -- shows up as a new finding from the same rule in the same file.
        IF EXISTS (
          SELECT 1
            FROM public.codex_findings s
            JOIN public.codex_finding_observations o ON o.finding_id = s.id AND o.job_id = p_job_id
           WHERE s.target_key = v_target
             AND s.id <> v_row.id
             AND s.scanner IS NOT DISTINCT FROM v_row.scanner
             AND s.rule_id IS NOT DISTINCT FROM v_row.rule_id
             AND s.affected_file IS NOT DISTINCT FROM v_row.affected_file
        ) THEN
          INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, reason)
          VALUES (v_row.id, p_job_id, 'fix_unconfirmed', 'fix_merged', 'resolved',
                  'Gone, but the same rule still fires in the same file.');
        ELSE
          WITH confirmed AS (
            UPDATE public.codex_remediations
               SET fix_confirmed_at = now(), fix_confirmed_by_job_id = p_job_id
             WHERE finding_id = v_row.id
               AND status = 'merged'
               AND merged_at IS NOT NULL
               AND merged_at < v_job.created_at
               AND fix_confirmed_at IS NULL
            RETURNING 1
          )
          SELECT count(*) INTO v_confirmed_now FROM confirmed;
          v_confirmed := v_confirmed + v_confirmed_now;
          INSERT INTO public.codex_finding_events (finding_id, job_id, event_type, from_state, to_state, payload)
          VALUES (v_row.id, p_job_id,
                  CASE WHEN v_confirmed_now > 0 THEN 'fix_confirmed' ELSE 'auto_resolved' END,
                  'fix_merged', 'resolved', jsonb_build_object('remediations_confirmed', v_confirmed_now));
        END IF;
      END IF;
      -- dismissed / false_positive keep the verdict; the absence is recorded.
    END LOOP;
  END IF;

  SELECT jsonb_build_object(
           'critical', count(*) FILTER (WHERE severity = 'critical'),
           'high',     count(*) FILTER (WHERE severity = 'high'),
           'medium',   count(*) FILTER (WHERE severity = 'medium'),
           'low',      count(*) FILTER (WHERE severity = 'low'),
           'info',     count(*) FILTER (WHERE severity = 'info')
         ),
         count(*)
    INTO v_counts, v_open_total
    FROM public.codex_findings
   WHERE target_key = v_target AND state = 'open';

  v_result := COALESCE(p_summary, '{}'::jsonb) || v_counts || jsonb_build_object(
    'open_total', v_open_total,
    'auto_resolved', v_auto_resolved,
    'confirmed_fixes', v_confirmed,
    'absent_secrets', v_absent_secrets,
    'observed', v_observed,
    'expected', v_expected,
    'incomplete', NOT v_complete,
    'absence_processed', v_absence,
    'eligible_scanners', to_jsonb(v_ok),
    'target_key', v_target
  );

  UPDATE public.codex_scan_jobs
     SET status = 'completed', completed_at = now(), result_summary = v_result
   WHERE id = p_job_id;

  IF v_auto_resolved > 0 THEN
    INSERT INTO public.codex_scan_events (job_id, event_type, payload)
    VALUES (p_job_id, 'findings_auto_resolved', jsonb_build_object('count', v_auto_resolved));
  END IF;
  IF v_confirmed > 0 THEN
    INSERT INTO public.codex_scan_events (job_id, event_type, payload)
    VALUES (p_job_id, 'remediation.fix_confirmed', jsonb_build_object('count', v_confirmed));
  END IF;
  IF v_absent_secrets > 0 THEN
    INSERT INTO public.codex_scan_events (job_id, event_type, payload)
    VALUES (p_job_id, 'secrets_absent_from_tree', jsonb_build_object('count', v_absent_secrets));
  END IF;
  IF NOT v_complete THEN
    INSERT INTO public.codex_scan_events (job_id, event_type, payload)
    VALUES (p_job_id, 'results_incomplete', jsonb_build_object(
      'expected', v_expected, 'observed', v_observed, 'callback_failures', v_cb_failures));
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.codex_finalize_scan(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.codex_finalize_scan(UUID, JSONB) TO service_role;

-- ── 8. Posture views: the fleet without PR scans, and Prime itself ───────

CREATE OR REPLACE FUNCTION public.codex_fleet_overview()
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  repo_full_name TEXT,
  github_owner TEXT,
  github_repo TEXT,
  codex_nightly_enabled BOOLEAN,
  sync_status TEXT,
  last_scan JSONB,
  open_findings JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER bypasses RLS, so re-assert the read gate that the
  -- underlying tables' policies would have applied.
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator or admin required';
  END IF;

  RETURN QUERY
  WITH last_jobs AS (
    -- A PR scan reads unmerged code; it is not the clone's posture.
    SELECT DISTINCT ON (j.clone_id)
      j.clone_id,
      jsonb_build_object(
        'id', j.id,
        'kind', j.kind,
        'status', j.status,
        'engine', j.engine,
        'ref', j.ref,
        'started_at', j.started_at,
        'completed_at', j.completed_at,
        'created_at', j.created_at,
        'workflow_run_url', j.workflow_run_url,
        'last_error', j.last_error,
        'result_summary', j.result_summary
      ) AS last_scan
    FROM public.codex_scan_jobs j
    WHERE j.clone_id IS NOT NULL AND j.kind <> 'pr_open'
    ORDER BY j.clone_id, j.created_at DESC
  ),
  finding_counts AS (
    SELECT
      f.clone_id,
      jsonb_build_object(
        'critical', count(*) FILTER (WHERE f.severity = 'critical'),
        'high',     count(*) FILTER (WHERE f.severity = 'high'),
        'medium',   count(*) FILTER (WHERE f.severity = 'medium'),
        'low',      count(*) FILTER (WHERE f.severity = 'low'),
        'info',     count(*) FILTER (WHERE f.severity = 'info')
      ) AS open_findings
    FROM public.codex_findings f
    WHERE f.state = 'open' AND f.clone_id IS NOT NULL AND f.pr_number IS NULL
    GROUP BY f.clone_id
  )
  SELECT
    c.id,
    c.name,
    c.slug,
    c.repo_full_name,
    c.github_owner,
    c.github_repo,
    c.codex_nightly_enabled,
    c.sync_status::TEXT,
    lj.last_scan,
    COALESCE(
      fc.open_findings,
      '{"critical":0,"high":0,"medium":0,"low":0,"info":0}'::jsonb
    )
  FROM public.clones c
  LEFT JOIN last_jobs lj ON lj.clone_id = c.id
  LEFT JOIN finding_counts fc ON fc.clone_id = c.id
  ORDER BY c.name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.codex_fleet_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.codex_fleet_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.codex_prime_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last    JSONB;
  v_counts  JSONB;
  v_triage  JSONB;
  v_in_prs  INTEGER;
BEGIN
  IF NOT (public.is_operator(auth.uid()) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: operator or admin required';
  END IF;

  SELECT jsonb_build_object(
           'id', j.id,
           'kind', j.kind,
           'status', j.status,
           'engine', j.engine,
           'ref', j.ref,
           'started_at', j.started_at,
           'completed_at', j.completed_at,
           'created_at', j.created_at,
           'workflow_run_url', j.workflow_run_url,
           'last_error', j.last_error,
           'result_summary', j.result_summary
         )
    INTO v_last
    FROM public.codex_scan_jobs j
   WHERE j.clone_id IS NULL AND j.target_kind = 'prime' AND j.kind <> 'pr_open'
   ORDER BY j.created_at DESC
   LIMIT 1;

  SELECT jsonb_build_object(
           'critical', count(*) FILTER (WHERE f.severity = 'critical'),
           'high',     count(*) FILTER (WHERE f.severity = 'high'),
           'medium',   count(*) FILTER (WHERE f.severity = 'medium'),
           'low',      count(*) FILTER (WHERE f.severity = 'low'),
           'info',     count(*) FILTER (WHERE f.severity = 'info')
         )
    INTO v_counts
    FROM public.codex_findings f
   WHERE f.clone_id IS NULL AND f.pr_number IS NULL AND f.state = 'open';

  SELECT jsonb_build_object(
           'triaging',       count(*) FILTER (WHERE f.state = 'triaging'),
           'fix_in_flight',  count(*) FILTER (WHERE f.state IN ('fix_drafted', 'pr_open')),
           'fix_merged',     count(*) FILTER (WHERE f.state = 'fix_merged'),
           'dismissed',      count(*) FILTER (WHERE f.state = 'dismissed'),
           'false_positive', count(*) FILTER (WHERE f.state = 'false_positive'),
           'secrets_absent', count(*) FILTER (WHERE f.state = 'open' AND f.absent_since IS NOT NULL
                                               AND f.scanner IN ('gitleaks', 'gitleaks-history'))
         )
    INTO v_triage
    FROM public.codex_findings f
   WHERE f.clone_id IS NULL AND f.pr_number IS NULL;

  SELECT count(*) INTO v_in_prs
    FROM public.codex_findings f
   WHERE f.clone_id IS NULL AND f.pr_number IS NOT NULL AND f.state = 'open';

  RETURN jsonb_build_object(
    'last_scan', v_last,
    'open_findings', v_counts,
    'triage', v_triage,
    'open_in_pull_requests', v_in_prs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.codex_prime_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.codex_prime_overview() TO authenticated;

-- ── 9. The nightly schedule an operator sets is the one that runs ────────
-- `prime_config.codex_nightly_cron` used to be "recorded for reference" while
-- pg_cron kept firing at 07:00. pg_cron is reached through dynamic SQL so this
-- function exists (and reports why it cannot apply) on a database without it.

CREATE OR REPLACE FUNCTION public.codex_set_nightly_schedule(p_cron TEXT)
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

  UPDATE public.prime_config SET codex_nightly_cron = v_expr WHERE id IS NOT NULL;

  IF to_regnamespace('cron') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'applied', false, 'schedule', v_expr,
                              'reason', 'pg_cron is not installed on this database');
  END IF;

  EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1 LIMIT 1'
     INTO v_jobid
    USING 'codex-security-nightly';
  IF v_jobid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'applied', false, 'schedule', v_expr,
                              'reason', 'the codex-security-nightly job is not scheduled — the vault entry cron_secret was missing when it was due to be created');
  END IF;

  EXECUTE 'SELECT cron.alter_job(job_id := $1, schedule := $2)' USING v_jobid, v_expr;
  RETURN jsonb_build_object('ok', true, 'applied', true, 'schedule', v_expr, 'jobid', v_jobid);
END;
$$;

REVOKE ALL ON FUNCTION public.codex_set_nightly_schedule(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.codex_set_nightly_schedule(TEXT) TO authenticated;
