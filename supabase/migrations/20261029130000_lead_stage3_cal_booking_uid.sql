-- @asserts column:waitlist_leads.stage3_cal_booking_uid
--
-- The Cal.com uid of the strategic review the website last reported for the
-- applicant (docs/LEAD_EMAILS.md, "The send gates").
--
-- The Cal.com webhook finds the lead a cancellation belongs to by this uid,
-- and leaves alone a lead whose recorded booking is a different one.
-- `stage3_booking_reference` cannot answer that: the Airtable mirror rewrites
-- it with the base's own `Booking Reference` ("AX-… · 6 Aug 11:00 am"), which
-- is no Cal.com uid, and a cancellation compared against it would read as
-- another booking's and never hold the confirmation. Only the website's
-- booking report writes this column; the mirror never does.
alter table public.waitlist_leads
  add column if not exists stage3_cal_booking_uid text;

comment on column public.waitlist_leads.stage3_cal_booking_uid is
  'The Cal.com uid of the strategic review the website last reported. Written by the website''s Stage 3 report only, never by the Airtable mirror; the Cal.com webhook matches cancellations on it.';
