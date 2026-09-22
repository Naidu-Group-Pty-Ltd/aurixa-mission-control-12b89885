-- The Airtable mirror carries the whole applicant, not just the Stage 1 form.
--
-- @asserts column:waitlist_leads.stage2_user_count
-- @asserts column:waitlist_leads.stage2_capabilities
-- @asserts column:waitlist_leads.stage3_notes
-- @asserts column:waitlist_leads.stage1_email_message_id
-- @asserts column:waitlist_leads.stage2_invite_count
-- @asserts column:waitlist_leads.enrichment_synced_at
--
-- ## What was missing, measured
--
-- The Aurixa priority-access funnel writes THREE Airtable tables, keyed on the
-- public application reference (`AX-XXXXXXXXXX`):
--
--   `Aurixa Waitlist`              Stage 1 — the 60-second application
--   `BRQ Detailed Responses`       Stage 2 — 40+ columns of qualification
--   `Strategic Review Bookings`    Stage 3 — the session, in three time zones
--
-- `airtable-sync.server.ts` read the FIRST one, and of that one it read the
-- Stage 1 answers plus six rollups. Everything an operator would actually
-- qualify on — how many users, what they run today, what has to be integrated,
-- how much data migrates, what security and procurement demand, what budget is
-- approved, what they asked to happen next — sat in a child table nothing here
-- had ever opened. So /leads could say an applicant had *reached* Stage 2 and
-- could not say one word about what they had said in it.
--
-- `stage2_answers` and `stage2_summary` already existed (20260731140000) and
-- are populated by the WEBSITE dual-write only. That path carries the whole
-- `fields` block, and it is the right shape — but it fires once, from a
-- browser, and it is the path that is missing precisely when something went
-- wrong. The Airtable mirror is the durable one, and it filled neither.
--
-- ## Why columns and not just the JSONB blob
--
-- `stage2_answers` stays the complete record and the fit engine keeps reading
-- it whole. These columns are the handful an operator FILTERS and SORTS on —
-- seat count, timeline, budget, migration scope — and a jsonb path is not an
-- index. Everything here is also derivable from the blob, so a column that
-- disagrees with it is a bug in one mapper rather than two sources of truth.
--
-- Nothing is destructive: every column is nullable (or an empty array) and
-- every existing row keeps working untouched.

-- ── Stage 2: the Business Readiness Questionnaire, in columns ───────────────

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage2_authority           TEXT,
  ADD COLUMN IF NOT EXISTS stage2_user_count          TEXT,
  ADD COLUMN IF NOT EXISTS stage2_entity_structure    TEXT,
  ADD COLUMN IF NOT EXISTS stage2_admin_time          TEXT,
  ADD COLUMN IF NOT EXISTS stage2_migration           TEXT,
  ADD COLUMN IF NOT EXISTS stage2_regions             TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_systems             TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_problems            TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_capabilities        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_integrations        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_security            TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS stage2_difficult_workflow  TEXT,
  ADD COLUMN IF NOT EXISTS stage2_airtable_record_id  TEXT;

COMMENT ON COLUMN public.waitlist_leads.stage2_capabilities IS
  'BRQ-10, the applicant''s own ranked top five Aurixa capabilities, in their order. This is the closest thing the funnel has to a statement of what they are buying.';
COMMENT ON COLUMN public.waitlist_leads.stage2_user_count IS
  'BRQ-03 expected user count. Stored as a column because seat count is what a plan is quoted from, and a jsonb path cannot be indexed or sorted.';
COMMENT ON COLUMN public.waitlist_leads.stage2_difficult_workflow IS
  'BRQ-09, free text. Optional in the questionnaire, and the single most useful paragraph an applicant ever writes about their own operation.';

-- ── Stage 3: the strategic review, as booked ───────────────────────────────

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage3_notes               TEXT,
  ADD COLUMN IF NOT EXISTS stage3_local_time          TEXT,
  ADD COLUMN IF NOT EXISTS stage3_host_local_time     TEXT,
  ADD COLUMN IF NOT EXISTS stage3_duration_minutes    INTEGER,
  ADD COLUMN IF NOT EXISTS stage3_booking_reference   TEXT,
  ADD COLUMN IF NOT EXISTS stage3_confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_airtable_record_id  TEXT;

COMMENT ON COLUMN public.waitlist_leads.stage3_host_local_time IS
  'The same session in Australia/Sydney, as Airtable stores it. Kept verbatim rather than re-derived: a session time recomputed from a UTC instant and a guessed zone is how a diary entry lands an hour out.';
COMMENT ON COLUMN public.waitlist_leads.stage3_confirmation_sent_at IS
  'When the Stage 3 Make scenario actually sent the booking confirmation. NULL on a booked review means the applicant was never told — which is the state this column exists to make visible.';

-- ── The invitation and access lifecycle ────────────────────────────────────
--
-- These answer a question /leads could not ask at all: has this applicant
-- been contacted, and can they get to the next stage if they try?

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS stage1_email_message_id     TEXT,
  ADD COLUMN IF NOT EXISTS stage2_invite_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage2_invite_count         INTEGER,
  ADD COLUMN IF NOT EXISTS stage3_invite_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_invite_count         INTEGER,
  ADD COLUMN IF NOT EXISTS questionnaire_token_status  TEXT,
  ADD COLUMN IF NOT EXISTS questionnaire_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage3_access_state         TEXT,
  ADD COLUMN IF NOT EXISTS stage3_access_denied_reason TEXT,
  ADD COLUMN IF NOT EXISTS stage3_booking_url          TEXT;

COMMENT ON COLUMN public.waitlist_leads.stage1_email_message_id IS
  'Graph message id of the Stage 1 acknowledgement the Make scenario sent. Present means the applicant was emailed; absent on a lead older than a few minutes means nobody told them their application arrived.';
COMMENT ON COLUMN public.waitlist_leads.stage3_access_state IS
  'Airtable''s own "Stage 3 Access (Application)" verdict — GRANT or otherwise. Read-only here: the gate is Airtable''s to decide and Mission Control''s to display.';

-- ── When the enrichment last ran for this row ──────────────────────────────
--
-- Separate from `synced_at`, which the parent-table mirror already stamps. A
-- row whose parent synced but whose children did not is a real state, and one
-- timestamp cannot express it.

ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS enrichment_synced_at TIMESTAMPTZ;

-- Operators filter the console on the two facts that decide whether a lead is
-- worth a call today: how far they came, and how recently.
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_stage2_next_step
  ON public.waitlist_leads (stage2_next_step)
  WHERE stage2_next_step IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_waitlist_leads_stage3_session
  ON public.waitlist_leads (stage3_session_start DESC)
  WHERE stage3_session_start IS NOT NULL;

-- One row per Airtable child record, so a re-sync updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_stage2_record_key
  ON public.waitlist_leads (stage2_airtable_record_id)
  WHERE stage2_airtable_record_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_stage3_record_key
  ON public.waitlist_leads (stage3_airtable_record_id)
  WHERE stage3_airtable_record_id IS NOT NULL;
