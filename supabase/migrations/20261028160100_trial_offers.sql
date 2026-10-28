-- @asserts table:trial_offers
-- @asserts column:trial_offers.trial_days
-- @asserts column:trial_offers.code
--
-- Trial offers (docs/CLONE_PAYMENT_GATES.md, "Custom trial periods").
--
-- The free trial is fourteen days by default. A trial offer is a named,
-- reusable exception to that: "Partner referral — 30 days", "Conference
-- 2027 — 21 days". An admin creates one on Billing → Payment Gates and it can
-- then be used three ways:
--
--   • picked in the New Clone wizard, or on an agreement's provisioning
--     settings, as the trial the workspace is armed with;
--   • shared as a website link (aurixasystems.com.au/contact?trial=CODE), so
--     the trial application says "Start your 30-day free trial" and carries
--     the code to the lead it creates;
--   • read back on the gate's history: the `armed` event names the offer.
--
-- The gate never references this table. A gate stores the hours it was armed
-- with, and that is all it ever reads (`resolveGateState`); an offer edited
-- or retired later must not move a deadline a customer was already given.
--
-- `code` is the public part, and the only part the website endpoint returns
-- alongside the label and the length. Upper case, letters, digits and
-- hyphens, so a code read out on a phone or printed on a slide survives
-- being retyped.
--
-- Writes go through admin server functions with the service role; operators
-- may read, so support can see what an offer gives.

create table if not exists public.trial_offers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  label text not null,
  trial_days integer not null,
  active boolean not null default true,
  expires_at timestamp with time zone,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamp with time zone not null default now(),
  constraint trial_offers_code_shape
    check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  constraint trial_offers_label_len
    check (char_length(btrim(label)) between 2 and 80),
  constraint trial_offers_days_range
    check (trial_days between 1 and 365),
  constraint trial_offers_notes_len
    check (notes is null or char_length(notes) <= 1000)
);

create unique index if not exists trial_offers_code_key
  on public.trial_offers (code);

create index if not exists idx_trial_offers_created_by
  on public.trial_offers (created_by);

create index if not exists idx_trial_offers_updated_by
  on public.trial_offers (updated_by);

comment on table public.trial_offers is
  'Named free-trial lengths an admin can give instead of the platform default: picked at provisioning, or shared as a website link (?trial=CODE). A gate never references an offer; it keeps the hours it was armed with.';
comment on column public.trial_offers.code is
  'The public code, as typed in a website link. Upper case letters, digits and hyphens; unique.';
comment on column public.trial_offers.trial_days is
  'The free trial this offer gives, in whole days (1 to 365).';
comment on column public.trial_offers.active is
  'False retires the offer: the website stops accepting its code and the pickers stop offering it. Workspaces already armed with it keep their trials.';
comment on column public.trial_offers.expires_at is
  'Optional end of a campaign. After it the website no longer accepts the code; the offer can still be picked by an admin until it is retired.';

alter table public.trial_offers enable row level security;

drop policy if exists "Operators read trial offers" on public.trial_offers;
create policy "Operators read trial offers"
  on public.trial_offers for select to authenticated
  using (is_operator(auth.uid()));
