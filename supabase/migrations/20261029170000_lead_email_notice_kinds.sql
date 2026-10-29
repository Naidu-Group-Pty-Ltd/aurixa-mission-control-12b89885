-- The notifications raised when the team alert recipients change, and when an
-- applicant corrects the address their application was made under — or tries
-- to, and cannot.
--
-- @asserts enum:notification_kind
--
-- Kept in its own migration, like 20261029095900: a new enum value cannot be
-- USED in the transaction that adds it.
--
-- Who receives the team's lead alerts is set on Email → Lead emails; every
-- operator is told when it changes, as for a sender change. An address
-- correction re-sends the Stage 1 email to the corrected address, and the team
-- — whose own alert named the old one — is told (docs/LEAD_EMAILS.md). A
-- refused correction leaves an applicant without their email, so the team is
-- told that too, with the address the applicant gave.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'lead_email_team_alerts_changed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'lead_address_corrected';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'lead_address_correction_refused';
