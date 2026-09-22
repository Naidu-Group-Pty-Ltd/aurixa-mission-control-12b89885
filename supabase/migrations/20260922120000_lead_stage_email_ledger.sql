-- The priority-access stage mailer: one row per (applicant, stage, audience).
--
-- @asserts table:lead_stage_emails
-- @asserts rpc:claim_lead_stage_emails
-- @asserts column:lead_stage_emails.audience
--
-- ## What this is for
--
-- Two different emails are owed every time an applicant finishes a stage of
-- the Aurixa Systems priority-access funnel, and before this only one of them
-- had any owner at all:
--
--   * the APPLICANT is acknowledged — sent today by the Make.com scenarios,
--     through Microsoft Graph, with no record anywhere Mission Control can
--     read and no signal when it does not go; and
--   * the TEAM is told — sent by no Make scenario and by no website code.
--     Measured on all four exported blueprints (`aurixa-waitlist-stage-1/2/3`
--     and `aurixa-stage-3-access`, 2026-08-18): every `toRecipients` block in
--     the funnel names the applicant and only the applicant.
--
-- That measurement was read too widely when this was first written. Airtable's
-- OWN automations were never in the search space, and the live base runs one
-- that does notify the team: `wflM9vUhBoHb0ZE8r` "Aurixa Lead Capture",
-- deployed, on `recordCreated` in Aurixa Waitlist — the table Make stage 1
-- writes. Stage 2's equivalent (`wflh1IWRe0okzxeTK`) is deployed but bound to
-- a table the funnel does not write, and stage 3 has none at all.
--
-- So the gap this ledger fills is real but narrower than stated: an applicant
-- could complete the Business Readiness Questionnaire — the most substantial
-- qualification document the business collects — or book a strategic review,
-- and nothing on Aurixa's side would say so.
--
-- ## Why a ledger and not a flag on the lead
--
-- This borrows `email_campaign_recipients`' rule, for the same reason and with
-- the same consequence: THERE IS NO UNDO ON A SENT EMAIL. "Never twice" is not
-- a condition some function checks, it is `unique (lead_id, stage, audience)` —
-- one row per obligation, and sending is a state transition ON that row. Two
-- dispatcher ticks racing, the webhook and the Airtable sync both noticing the
-- same advance, or an operator re-running the hook by hand all resolve to the
-- same single row.
--
-- A boolean on `waitlist_leads` could not do this. It carries no claim, so two
-- concurrent readers both see `false`; and it carries no outcome, so a refusal
-- and a delivery look identical afterwards.
--
-- ## The three outcomes a send can leave, and why `unconfirmed` never retries
--
-- `sendMail` answers 202 with no body. A non-2xx BEFORE acceptance means no
-- message exists and retrying is safe. A network failure AFTER the request left
-- is ambiguous. Recording both as "failed" and retrying the pair is exactly the
-- duplicate the unique index exists to prevent — so `unconfirmed` is its own
-- terminal state, and releasing one is an operator's explicit act.

CREATE TABLE IF NOT EXISTS public.lead_stage_emails (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES public.waitlist_leads (id) ON DELETE CASCADE,

  -- Which milestone this email is about. 1 = application received,
  -- 2 = readiness questionnaire complete, 3 = strategic review booked.
  stage        SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 3),

  -- Who it is for. The two audiences are independent obligations: an applicant
  -- acknowledgement that Make already sent must not stop the team being told.
  audience     TEXT NOT NULL CHECK (audience IN ('internal', 'applicant')),

  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',      -- owed, nothing has claimed it
      'claimed',      -- a dispatcher tick holds it; nothing else may take it
      'sent',         -- Graph accepted it
      'failed',       -- refused BEFORE acceptance, so no message exists
      'unconfirmed',  -- the request left and we do not know; never auto-retried
      'suppressed',   -- the address is on the do-not-send register
      'skipped'       -- deliberately not sent (already sent elsewhere, or off)
    )),

  -- Why a row is in a non-sending terminal state, in words an operator reads.
  -- `skipped` is the one that carries real information: "Make already emailed
  -- this applicant at 09:41" and "applicant sending is switched off on this
  -- deployment" are different facts and must not both read as a blank.
  reason       TEXT,

  to_address   TEXT,
  subject      TEXT,
  mailbox      TEXT,
  recipients   TEXT[] NOT NULL DEFAULT '{}',

  claimed_at   TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  graph_status INTEGER,
  graph_request_id TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The rule. One obligation per (applicant, stage, audience), for ever.
CREATE UNIQUE INDEX IF NOT EXISTS lead_stage_emails_obligation_key
  ON public.lead_stage_emails (lead_id, stage, audience);

CREATE INDEX IF NOT EXISTS lead_stage_emails_queue_idx
  ON public.lead_stage_emails (status, created_at)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS lead_stage_emails_lead_idx
  ON public.lead_stage_emails (lead_id, stage);

COMMENT ON TABLE public.lead_stage_emails IS
  'Send ledger for the priority-access stage mailer. One row per (lead, stage, audience); sending is a state transition on that row, so a duplicate is not something the code declines to do — it is a row that cannot exist.';

ALTER TABLE public.lead_stage_emails ENABLE ROW LEVEL SECURITY;

-- Operators read it (the console shows whether an applicant was told) and may
-- release an `unconfirmed` row. Nothing here inserts from a browser: every
-- write that creates an obligation is the service role's, through the ingest
-- endpoint or the sync.
DROP POLICY IF EXISTS "Operators read lead stage emails" ON public.lead_stage_emails;
CREATE POLICY "Operators read lead stage emails"
  ON public.lead_stage_emails FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators update lead stage emails" ON public.lead_stage_emails;
CREATE POLICY "Operators update lead stage emails"
  ON public.lead_stage_emails FOR UPDATE
  TO authenticated
  USING (public.is_operator(auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_lead_stage_emails()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_stage_emails_touch ON public.lead_stage_emails;
CREATE TRIGGER lead_stage_emails_touch
  BEFORE UPDATE ON public.lead_stage_emails
  FOR EACH ROW EXECUTE FUNCTION public.touch_lead_stage_emails();

-- ── The claim ──────────────────────────────────────────────────────────────
--
-- Two ticks must never both hold the same obligation, and the guarantee has to
-- be the database's rather than a read-then-write in the worker. This is the
-- same shape `email_campaign_recipients`' claim uses: a conditional UPDATE
-- whose WHERE clause is the lock, returning only the rows it actually won.
--
-- A `claimed` row older than the lease is taken back: a worker that died
-- mid-tick must not park an obligation for ever. The lease is deliberately
-- long relative to one Graph call — re-claiming a row whose send is still in
-- flight is the one way this design can duplicate, so it errs towards leaving
-- an email unsent rather than sending it twice.

CREATE OR REPLACE FUNCTION public.claim_lead_stage_emails(
  _limit INTEGER DEFAULT 20,
  _lease_seconds INTEGER DEFAULT 600
)
RETURNS SETOF public.lead_stage_emails
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.lead_stage_emails AS e
     SET status = 'claimed',
         claimed_at = now(),
         attempts = e.attempts + 1
   WHERE e.id IN (
     SELECT c.id
       FROM public.lead_stage_emails AS c
      WHERE c.status = 'pending'
         OR (c.status = 'claimed'
             AND c.claimed_at < now() - make_interval(secs => GREATEST(_lease_seconds, 60)))
      ORDER BY c.created_at
      LIMIT GREATEST(LEAST(_limit, 100), 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING e.*;
$$;

REVOKE ALL ON FUNCTION public.claim_lead_stage_emails(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_lead_stage_emails(INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_lead_stage_emails(INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_stage_emails(INTEGER, INTEGER) TO service_role;

COMMENT ON FUNCTION public.claim_lead_stage_emails(INTEGER, INTEGER) IS
  'Atomically claims due stage emails for one dispatcher tick. Service role only — an anon or authenticated caller claiming these would take obligations nothing will ever send.';
