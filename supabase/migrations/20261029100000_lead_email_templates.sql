-- @asserts table:lead_email_templates
-- @asserts column:lead_email_templates.content
-- @asserts table:lead_email_settings
-- @asserts column:lead_email_settings.stage1_sender
-- @asserts table:lead_questionnaire_links
-- @asserts column:lead_questionnaire_links.token_sha256
-- @asserts column:waitlist_leads.stage3_meeting_url
-- @asserts cron:lead-stage-emails
--
-- Mission Control sends the free trial applicant's emails (docs/LEAD_EMAILS.md).
--
-- Until now the three emails an applicant receives — application received
-- (with the questionnaire link), questionnaire received (with the strategic
-- review link) and review confirmed — were composed and sent by Make.com
-- scenarios 9389960, 9590512 and 9601915, their HTML inlined in the scenario
-- blueprints where nobody could edit them without opening Make. Mission
-- Control already had the sender (`lead_stage_emails`, the dispatcher, the
-- do-not-send register, Microsoft Graph); it only backstopped Make.
--
-- This adds what it needs to own them:
--
--   lead_email_templates      the editable copy of each stage's email. A row
--                             is an OVERRIDE: no row means the default that
--                             ships in `leadEmailTemplates.pure.ts`, so
--                             "Reset to default" deletes the row and a later
--                             change to the default reaches every stage that
--                             was never edited.
--   lead_email_settings       one row: who sends each stage (Make, with
--                             Mission Control as a backstop, or Mission
--                             Control) and the sending identity — tenant,
--                             mailbox, sender name, reply-to.
--   lead_questionnaire_links  the secure questionnaire links Mission Control
--                             mints for the Stage 1 email. Only the SHA-256
--                             of a token is stored; the website verifies a
--                             link by asking Mission Control.
--
-- and `waitlist_leads.stage3_meeting_url`, the Cal.com video link the website
-- reports with a confirmed booking, so the confirmation can carry it.
--
-- Every stage starts on 'make'. Switching one to 'mission_control' is an
-- admin act on Email → Lead emails, done after the matching email modules are
-- removed from Make — the console says which, and how — so an applicant is
-- never sent the same email twice.
--
-- Writes go through admin server functions with the service role. Operators
-- may read templates and settings; nobody but the service role reads links.

create table if not exists public.lead_email_templates (
  stage smallint primary key,
  subject text not null,
  content jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamp with time zone not null default now(),
  constraint lead_email_templates_stage_range
    check (stage between 1 and 3),
  constraint lead_email_templates_subject_len
    check (char_length(btrim(subject)) between 1 and 200),
  constraint lead_email_templates_content_object
    check (jsonb_typeof(content) = 'object'),
  constraint lead_email_templates_content_size
    check (octet_length(content::text) <= 60000)
);

create index if not exists idx_lead_email_templates_updated_by
  on public.lead_email_templates (updated_by);

comment on table public.lead_email_templates is
  'Edited copy of the free trial applicant emails, one row per stage. A row overrides the default in leadEmailTemplates.pure.ts; no row means the default.';
comment on column public.lead_email_templates.content is
  'The email''s sections (hero, message, next-step card, buttons, details, steps, footer) as written on Email → Lead emails. Validated by leadEmailTemplates.pure.ts before it is saved.';

alter table public.lead_email_templates enable row level security;

drop policy if exists "Operators read lead email templates" on public.lead_email_templates;
create policy "Operators read lead email templates"
  on public.lead_email_templates for select to authenticated
  using (is_operator(auth.uid()));

create table if not exists public.lead_email_settings (
  id boolean primary key default true,
  stage1_sender text not null default 'make',
  stage2_sender text not null default 'make',
  stage3_sender text not null default 'make',
  tenant_id uuid references public.microsoft_tenants(id) on delete set null,
  from_mailbox text,
  from_name text,
  reply_to text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamp with time zone not null default now(),
  constraint lead_email_settings_single_row check (id),
  constraint lead_email_settings_stage1_sender
    check (stage1_sender in ('make', 'mission_control')),
  constraint lead_email_settings_stage2_sender
    check (stage2_sender in ('make', 'mission_control')),
  constraint lead_email_settings_stage3_sender
    check (stage3_sender in ('make', 'mission_control')),
  constraint lead_email_settings_from_mailbox_shape
    check (from_mailbox is null or from_mailbox ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint lead_email_settings_reply_to_shape
    check (reply_to is null or reply_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint lead_email_settings_from_name_len
    check (from_name is null or char_length(btrim(from_name)) between 1 and 80)
);

create index if not exists idx_lead_email_settings_tenant_id
  on public.lead_email_settings (tenant_id);

create index if not exists idx_lead_email_settings_updated_by
  on public.lead_email_settings (updated_by);

insert into public.lead_email_settings (id) values (true)
  on conflict (id) do nothing;

comment on table public.lead_email_settings is
  'Who sends each free trial applicant email (make: Make.com sends, Mission Control only backstops; mission_control: Mission Control sends) and the identity it sends as. One row.';
comment on column public.lead_email_settings.stage1_sender is
  'Stage 1, application received with the questionnaire link. Make scenario 9389960, modules 19, 21 and 22.';
comment on column public.lead_email_settings.stage2_sender is
  'Stage 2, questionnaire received with the strategic review link. Make scenario 9590512, modules 3 and 4.';
comment on column public.lead_email_settings.stage3_sender is
  'Stage 3, strategic review confirmed. Make scenario 9601915, modules 7 and 8.';
comment on column public.lead_email_settings.tenant_id is
  'The Microsoft tenant the emails send through. Null means the deployment''s default Graph credentials.';
comment on column public.lead_email_settings.from_mailbox is
  'The mailbox the emails send from. Null means LEAD_STAGE_EMAIL_MAILBOX, then the tenant''s default mailbox.';

alter table public.lead_email_settings enable row level security;

drop policy if exists "Operators read lead email settings" on public.lead_email_settings;
create policy "Operators read lead email settings"
  on public.lead_email_settings for select to authenticated
  using (is_operator(auth.uid()));

create table if not exists public.lead_questionnaire_links (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.waitlist_leads(id) on delete cascade,
  token_sha256 text not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  last_used_at timestamp with time zone,
  constraint lead_questionnaire_links_token_shape
    check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint lead_questionnaire_links_expiry_after_creation
    check (expires_at > created_at)
);

create unique index if not exists lead_questionnaire_links_token_key
  on public.lead_questionnaire_links (token_sha256);

create index if not exists idx_lead_questionnaire_links_lead_id
  on public.lead_questionnaire_links (lead_id);

comment on table public.lead_questionnaire_links is
  'Secure Business Readiness Questionnaire links minted for the Stage 1 email. Only the SHA-256 of a token is kept; the website asks /api/public/storefront/questionnaire-access whether a link is live.';

alter table public.lead_questionnaire_links enable row level security;

drop policy if exists "Operators read lead questionnaire links" on public.lead_questionnaire_links;
create policy "Operators read lead questionnaire links"
  on public.lead_questionnaire_links for select to authenticated
  using (is_operator(auth.uid()));

alter table public.waitlist_leads
  add column if not exists stage3_meeting_url text;

comment on column public.waitlist_leads.stage3_meeting_url is
  'The video link of a confirmed strategic review, as the website reported it with the booking (Cal.com).';

-- The mailer ticks every minute now, not every five.
--
-- 20260922130000 chose five because the only applicant email Mission Control
-- sent was a backstop that waits 45 minutes for Make anyway. A stage handed to
-- Mission Control has no such wait: "your application has been received", with
-- the questionnaire link in it, is the email the applicant is looking for while
-- the confirmation screen is still open, and Make delivered it in about half a
-- minute. A tick that finds nothing due claims nothing and sends nothing. The
-- URL and the Authorization header are 20260922130000's, for its reasons.
DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('lead-stage-emails')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lead-stage-emails');

  PERFORM cron.schedule(
    'lead-stage-emails',
    '* * * * *',
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
      v_base || '/hooks/lead-stage-emails'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'lead-stage-emails NOT rescheduled (%).', SQLERRM;
END $$;
