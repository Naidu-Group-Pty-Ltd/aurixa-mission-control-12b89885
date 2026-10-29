-- @asserts column:lead_email_settings.internal_recipients
-- @asserts column:lead_email_settings.internal_stages
--
-- Who receives the team's lead alerts, and at which stages, set on Email →
-- Lead emails (docs/LEAD_EMAILS.md, "Team alerts").
--
-- Until now only the environment said: LEAD_STAGE_INTERNAL_RECIPIENTS and
-- LEAD_STAGE_INTERNAL_STAGES, a secret nobody on the console could see or
-- change, and with neither set the alert reached the sending mailbox alone.
-- Null in either column means the console has not set it and the environment
-- still decides; a list here is the team's answer and overrides it.
alter table public.lead_email_settings
  add column if not exists internal_recipients text[],
  add column if not exists internal_stages smallint[];

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lead_email_settings_internal_recipients_size'
  ) then
    alter table public.lead_email_settings
      add constraint lead_email_settings_internal_recipients_size
      check (internal_recipients is null or cardinality(internal_recipients) between 1 and 25);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'lead_email_settings_internal_stages_range'
  ) then
    alter table public.lead_email_settings
      add constraint lead_email_settings_internal_stages_range
      check (internal_stages is null or internal_stages <@ array[1, 2, 3]::smallint[]);
  end if;
end $$;

comment on column public.lead_email_settings.internal_recipients is
  'Who receives the team''s lead alerts. Null: LEAD_STAGE_INTERNAL_RECIPIENTS, else the sending mailbox. Set on Email → Lead emails.';
comment on column public.lead_email_settings.internal_stages is
  'The stages the team is alerted at (1 application, 2 questionnaire, 3 review booked). Null: LEAD_STAGE_INTERNAL_STAGES, else all three. Empty: none.';
