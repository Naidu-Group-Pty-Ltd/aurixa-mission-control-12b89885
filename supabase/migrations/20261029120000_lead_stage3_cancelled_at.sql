-- @asserts column:waitlist_leads.stage3_cancelled_at
--
-- When the applicant cancelled their strategic review, as Cal.com told Mission
-- Control (docs/LEAD_EMAILS.md, "The send gates").
--
-- The Stage 3 confirmation's send gate holds a cancelled booking, as
-- Airtable's `Send Booking Confirmation` did on `Booking Status = Cancelled`.
-- `stage3_status` is the Airtable mirror's column and is rewritten from the
-- base on every sync, so a cancellation Mission Control learns of itself is
-- kept here, where only Mission Control writes: the Cal.com webhook sets it
-- for a stage-three booking, and the website reporting a new booking clears it.
alter table public.waitlist_leads
  add column if not exists stage3_cancelled_at timestamp with time zone;

comment on column public.waitlist_leads.stage3_cancelled_at is
  'When Cal.com reported the applicant''s strategic review cancelled. Cleared when a new booking is reported. Written by Mission Control only, never by the Airtable mirror.';
