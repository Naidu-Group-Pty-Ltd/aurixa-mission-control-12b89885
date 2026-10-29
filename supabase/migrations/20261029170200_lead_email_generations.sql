-- @asserts column:lead_stage_emails.generation
-- @asserts column:waitlist_leads.applicant_email_generation
--
-- An applicant who corrects the address they applied under is owed the email
-- they never received, at the address they meant (docs/LEAD_EMAILS.md,
-- "Address corrections").
--
-- The ledger held one row per (lead, stage, audience), so the Stage 1 email,
-- once sent to a mistyped address, could never be sent to the right one: the
-- corrected application was answered "duplicate" and nothing changed. Each
-- applicant email now belongs to a GENERATION of the applicant's address. A
-- correction moves the lead to the next generation; the obligation raised for
-- it is a new row beside the old one, which keeps what it says happened — sent
-- to the address it was sent to. Team alerts are not about the applicant's
-- address and stay generation 0.
alter table public.waitlist_leads
  add column if not exists applicant_email_generation smallint not null default 0;

alter table public.lead_stage_emails
  add column if not exists generation smallint not null default 0;

create unique index if not exists lead_stage_emails_obligation_generation_key
  on public.lead_stage_emails (lead_id, stage, audience, generation);

-- The old key, (lead_id, stage, audience), STAYS in this migration. The code
-- running when this applies writes `on conflict (lead_id, stage, audience)`,
-- and this migration applies on merge while that code is live until the next
-- publish: dropping the index here would fail every stage email it raises in
-- between. It is dropped by its own migration once the code that writes the
-- new key is published. Until then a corrected address's email (generation 1)
-- collides with the old key and waits; the sweep raises it after the drop.

comment on column public.waitlist_leads.applicant_email_generation is
  'Which address the applicant emails are for: 0 the address applied under, one more for each correction the applicant made. Set by /api/public/leads/capture.';
comment on column public.lead_stage_emails.generation is
  'The applicant address generation this email belongs to (waitlist_leads.applicant_email_generation when it was raised). Team alerts are always 0.';
comment on table public.lead_stage_emails is
  'Send ledger for the priority-access stage mailer. One row per (lead, stage, audience, generation); sending is a state transition on that row, so a duplicate is not something the code declines to do — it is a row that cannot exist. An applicant email belongs to the address generation it was raised for; team alerts are generation 0.';
