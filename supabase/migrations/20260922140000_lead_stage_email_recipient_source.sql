-- How a stage email's recipient list was arrived at, recorded per row.
--
-- @asserts column:lead_stage_emails.recipient_source
--
-- ## Why this is a column and not a comment
--
-- Mission Control is now the SOLE internal notifier for the priority-access
-- funnel: the Airtable automation `wflM9vUhBoHb0ZE8r` ("Aurixa Lead Capture",
-- subject "New Lead Received") that told five people about a new lead is being
-- retired in favour of this mailer.
--
-- `readPolicy` resolves the internal recipient list as: the explicit
-- `LEAD_STAGE_INTERNAL_RECIPIENTS` list, else the sending mailbox alone, else
-- nobody. That fallback was a kindness while Airtable was the real notifier —
-- a deployment that configured a mailbox and forgot the list still heard about
-- its leads. As the ONLY notifier it is a trap of exactly the shape this
-- funnel already has one of: the live Airtable automation carries a LEADING
-- SPACE on four of its five recipients, so if Airtable does not trim them,
-- four people have never received a lead alert and nothing says so.
--
-- A silent drop from five recipients to one is the same failure. So the
-- resolution is recorded on every row rather than inferred:
--
--   configured        an explicit list was set and used
--   mailbox_fallback  no list was set; the sending mailbox was used alone
--   applicant         an applicant-audience row, addressed to the applicant
--
-- `mailbox_fallback` on an internal row is the reading that means "fewer
-- people were told than you think". It is visible on the Leads page's email
-- record and answerable in one query:
--
--   select count(*) from public.lead_stage_emails
--    where audience = 'internal' and recipient_source = 'mailbox_fallback';
--
-- Nullable and unconstrained by default so every row written before this
-- migration stays valid and reads as "not recorded" rather than as a fallback
-- that did not happen.
--
-- ## It is written twice, and the second write is the one that matters
--
-- Enqueue stamps how the list was resolved when the obligation was RAISED. The
-- settle rewrites it, with `recipients`, to the send that HAPPENED — because
-- dispatch re-resolves an internal list from the deployment at send time, and
-- a row that keeps what it was raised with then reads "sending mailbox only"
-- over a send that reached five people.
--
-- `claim_lead_stage_emails` needs no change: it is `RETURNS SETOF
-- public.lead_stage_emails` with `RETURNING e.*`, so the new column travels
-- with the composite type. If it ever did not, `recipient_source` would arrive
-- undefined and the dispatcher would label a stored list `configured` — a
-- mislabel on the row, never a wrong recipient on the wire.

ALTER TABLE public.lead_stage_emails
  ADD COLUMN IF NOT EXISTS recipient_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lead_stage_emails_recipient_source_check'
  ) THEN
    ALTER TABLE public.lead_stage_emails
      ADD CONSTRAINT lead_stage_emails_recipient_source_check
      CHECK (
        recipient_source IS NULL
        OR recipient_source IN ('configured', 'mailbox_fallback', 'applicant')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.lead_stage_emails.recipient_source IS
  'How the recipient list was resolved: configured | mailbox_fallback | applicant. '
  'mailbox_fallback on an internal row means LEAD_STAGE_INTERNAL_RECIPIENTS was unset '
  'and only the sending mailbox was told.';

-- Finding every row that went to fewer people than intended has to be cheap,
-- because it is the question this column exists to answer.
CREATE INDEX IF NOT EXISTS lead_stage_emails_fallback_idx
  ON public.lead_stage_emails (recipient_source)
  WHERE recipient_source = 'mailbox_fallback';
