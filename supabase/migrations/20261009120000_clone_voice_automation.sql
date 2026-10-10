-- @asserts table:clone_voice_automation
-- @asserts table:clone_voice_automation_revisions
-- @asserts table:clone_voice_automation_connections
-- @asserts check:clone_voice_automation.apply_status=blocked
-- @asserts check:clone_voice_automation_connections.kind=gmail
--
-- THE CALENDAR AND EMAIL SETTINGS OF A CRM-INDEPENDENT CLONE'S VOICE AGENTS,
-- HELD IN ONE PLACE AND APPLIED TO MAKE FROM HERE.
--
-- A clone on the CRM-independent line (clones.crm_mode = 'independent') answers
-- its phone with Vapi agents whose tools are Make.com scenarios. Which calendar
-- they book into, which mailbox confirms the booking, the business hours, who in
-- the business is told — all of that lives in ONE Make data-store record (the
-- stack's CFG) plus the connections baked into two scenario blueprints (the
-- calendar adapter and the email notifier). See docs/CLONE_VOICE_AUTOMATION.md.
--
-- Three writers change those settings: provisioning (the operator, before the
-- clone is handed over), the operator afterwards, and the TENANT from its own
-- Settings page. The tenant cannot hold a Make API token — one token reaches
-- every scenario in the team, every tenant's — so its write is a REQUEST to
-- Mission Control, which validates it and applies it. That is the same shape as
-- the Didit, Airtable and integration-secret brokers: the call travels, the
-- credential does not.
--
-- ## clone_voice_automation — one row per clone
--
-- The desired settings (`settings`, validated by `voiceAutomation.pure.ts`),
-- versioned by `revision`, plus what was last APPLIED (`applied_revision`,
-- `applied_settings`) and how the latest apply went. Desired and applied are
-- kept apart on purpose: a revision can be accepted and still be blocked (the
-- chosen calendar is not connected yet), and the live stack is then still on the
-- applied one — which the tenant is shown, rather than a save that "worked".
--
-- `revision` is the optimistic-concurrency token. Every write names the revision
-- it read and the UPDATE is conditioned on it, so an operator and a tenant
-- saving at the same moment cannot overwrite each other unseen.
--
-- The Make ids (zone, team, data store, scenarios) say WHICH stack is this
-- clone's. None of them is a secret. The stack's shared secret stays in its CFG
-- record and is never read into this database: the applier projects every CFG
-- reading down to the managed fields before it goes anywhere.
--
-- ## clone_voice_automation_revisions — the ledger
--
-- One row per accepted revision: who (provisioning / operator / tenant, and the
-- label the writer gave), what changed field by field, and the whole settings
-- object. Never values from outside the managed set.
--
-- ## clone_voice_automation_connections — the tenant's own OAuth grants
--
-- A connection is created by a person authorising a Make credential request in
-- their own Microsoft or Google account. This table records the request, its
-- state, and once authorised the numeric Make connection id the applier binds
-- into the blueprint. The authorisation link is kept ENCRYPTED (it lets whoever
-- holds it attach an account to this clone's request) and is shown back only to
-- the clone that asked. At most one open request and one authorised connection
-- per kind; a newer authorisation supersedes the older one.

create table if not exists public.clone_voice_automation (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null unique references public.clones(id) on delete cascade,

  make_zone text not null check (make_zone in ('eu1', 'eu2', 'us1', 'us2')),
  make_team_id bigint not null check (make_team_id > 0),
  cfg_data_store_id bigint not null check (cfg_data_store_id > 0),
  cfg_record_key text not null default 'default'
    check (cfg_record_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  adapter_scenario_id bigint not null check (adapter_scenario_id > 0),
  notifier_scenario_id bigint not null check (notifier_scenario_id > 0),
  -- Every scenario in the stack, by role, for health and for the operator card.
  stack_scenario_ids jsonb not null default '{}'::jsonb,

  settings jsonb not null,
  schema_version integer not null default 1,
  revision integer not null default 1 check (revision > 0),
  updated_by_kind text not null default 'provisioning'
    check (updated_by_kind in ('provisioning', 'operator', 'tenant')),
  updated_by_label text,

  -- Fields the tenant may see but not change (operator-held).
  locked_fields text[] not null default array['email.testRedirectTo']::text[],
  handed_off_at timestamptz,

  applied_revision integer,
  applied_settings jsonb,
  applied_at timestamptz,
  apply_status text not null default 'pending'
    check (apply_status in ('pending', 'applying', 'applied', 'blocked', 'failed')),
  apply_blocks jsonb not null default '[]'::jsonb,
  apply_error text,
  apply_attempts integer not null default 0,
  next_attempt_at timestamptz,
  apply_lease_until timestamptz,
  last_bindings jsonb not null default '[]'::jsonb,

  drift jsonb not null default '[]'::jsonb,
  drift_checked_at timestamptz,

  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.clone_voice_automation is
  'Calendar and email settings of a CRM-independent clone''s voice agents (Make stack), desired vs applied. Written by provisioning, operators and the tenant (through /api/public/voice-automation); applied to Make by voice-automation.server.ts. See docs/CLONE_VOICE_AUTOMATION.md.';

create table if not exists public.clone_voice_automation_revisions (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null references public.clones(id) on delete cascade,
  revision integer not null,
  settings jsonb not null,
  changes jsonb not null default '[]'::jsonb,
  actor_kind text not null check (actor_kind in ('provisioning', 'operator', 'tenant')),
  actor_label text,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  unique (clone_id, revision)
);

create table if not exists public.clone_voice_automation_connections (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null references public.clones(id) on delete cascade,
  kind text not null
    check (kind in ('outlook_calendar', 'google_calendar', 'outlook_mail', 'gmail')),
  state text not null default 'requested'
    check (state in ('requested', 'authorized', 'declined', 'failed', 'superseded')),
  source text not null default 'tenant' check (source in ('tenant', 'operator')),
  credential_request_id uuid,
  credential_id uuid,
  connection_name text,
  public_uri_enc text,
  make_connection_id bigint check (make_connection_id is null or make_connection_id > 0),
  account_label text,
  requested_by_label text,
  requested_at timestamptz not null default now(),
  authorized_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An authorised connection is a connection Make can call.
  check (state <> 'authorized' or make_connection_id is not null)
);

create unique index if not exists clone_voice_automation_connections_one_open
  on public.clone_voice_automation_connections (clone_id, kind)
  where state = 'requested';
create unique index if not exists clone_voice_automation_connections_one_live
  on public.clone_voice_automation_connections (clone_id, kind)
  where state = 'authorized';
create index if not exists idx_clone_voice_automation_connections_clone
  on public.clone_voice_automation_connections (clone_id);
create index if not exists idx_clone_voice_automation_revisions_clone
  on public.clone_voice_automation_revisions (clone_id);
create index if not exists idx_clone_voice_automation_due
  on public.clone_voice_automation (apply_status, next_attempt_at);

grant select, insert, update, delete on public.clone_voice_automation to authenticated;
grant select, insert, update, delete on public.clone_voice_automation_revisions to authenticated;
grant select, insert, update, delete on public.clone_voice_automation_connections to authenticated;
grant all on public.clone_voice_automation to service_role;
grant all on public.clone_voice_automation_revisions to service_role;
grant all on public.clone_voice_automation_connections to service_role;

alter table public.clone_voice_automation enable row level security;
alter table public.clone_voice_automation_revisions enable row level security;
alter table public.clone_voice_automation_connections enable row level security;

drop policy if exists "clone_voice_automation admin read" on public.clone_voice_automation;
create policy "clone_voice_automation admin read"
  on public.clone_voice_automation for select to authenticated
  using (public.is_admin(auth.uid()));
drop policy if exists "clone_voice_automation admin write" on public.clone_voice_automation;
create policy "clone_voice_automation admin write"
  on public.clone_voice_automation for all to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists "clone_voice_automation_revisions admin read" on public.clone_voice_automation_revisions;
create policy "clone_voice_automation_revisions admin read"
  on public.clone_voice_automation_revisions for select to authenticated
  using (public.is_admin(auth.uid()));
drop policy if exists "clone_voice_automation_revisions admin write" on public.clone_voice_automation_revisions;
create policy "clone_voice_automation_revisions admin write"
  on public.clone_voice_automation_revisions for all to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists "clone_voice_automation_connections admin read" on public.clone_voice_automation_connections;
create policy "clone_voice_automation_connections admin read"
  on public.clone_voice_automation_connections for select to authenticated
  using (public.is_admin(auth.uid()));
drop policy if exists "clone_voice_automation_connections admin write" on public.clone_voice_automation_connections;
create policy "clone_voice_automation_connections admin write"
  on public.clone_voice_automation_connections for all to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop trigger if exists clone_voice_automation_updated_at on public.clone_voice_automation;
create trigger clone_voice_automation_updated_at
  before update on public.clone_voice_automation
  for each row execute function public.update_updated_at_column();
drop trigger if exists clone_voice_automation_connections_updated_at on public.clone_voice_automation_connections;
create trigger clone_voice_automation_connections_updated_at
  before update on public.clone_voice_automation_connections
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- The one stack that exists today: NPC CRM Independent's, built 9 Oct 2026
-- (voice-agents/crm-independent/HANDOFF.md §00 in that clone's repository).
-- Keyed on github_repo like 20260928100000_clone_crm_mode.sql, idempotent, and
-- never overwriting a row somebody has since written. The settings are the
-- values its CFG record held when this was written; the row starts PENDING so
-- the first apply READS the live record and confirms it rather than this
-- migration asserting it. The test gate stays locked: that clone has not been
-- handed over for live email.

insert into public.clone_voice_automation (
  clone_id, make_zone, make_team_id, cfg_data_store_id, cfg_record_key,
  adapter_scenario_id, notifier_scenario_id, stack_scenario_ids,
  settings, revision, updated_by_kind, updated_by_label, locked_fields, apply_status
)
select c.id, 'us2', 2731020, 168061, 'default', 6561418, 6570895,
  jsonb_build_object(
    'adapter', 6561418, 'availability', 6561680, 'loader', 6561648,
    'notifier', 6570895, 'resolve_contact', 6570898, 'get_call_context', 6570904,
    'context_inject', 6570912, 'create_booking', 6570921, 'manage_booking', 6570940,
    'data_stores', jsonb_build_object('cfg', 168061, 'contacts', 168062, 'call_context', 168063, 'bookings', 168064, 'code_library', 168112)
  ),
  jsonb_build_object(
    'calendar', jsonb_build_object(
      'provider', 'internal', 'outlookCalendarBase', '/v1.0/me/calendar', 'googleCalendarId', 'primary',
      'timezone', 'Australia/Sydney', 'businessStartHour', 13, 'businessEndHour', 18,
      'slotStepMinutes', 30, 'bufferMinutes', 0, 'maxSlots', 6, 'searchDays', 5),
    'email', jsonb_build_object(
      'provider', 'outlook', 'adminEmail', 'property@npcservices.com.au', 'businessName', 'NPC Services',
      'notifyClient', true, 'zoomLink', '', 'testRedirectTo', 'property@npcservices.com.au')
  ),
  1, 'provisioning', 'Registered from the 9 Oct 2026 build', array['email.testRedirectTo']::text[], 'pending'
from public.clones c
where c.github_repo = 'npc-crm-independent-6505dc'
on conflict (clone_id) do nothing;

insert into public.clone_voice_automation_revisions (clone_id, revision, settings, changes, actor_kind, actor_label)
select v.clone_id, 1, v.settings, '[]'::jsonb, 'provisioning', v.updated_by_label
from public.clone_voice_automation v
join public.clones c on c.id = v.clone_id
where c.github_repo = 'npc-crm-independent-6505dc'
on conflict (clone_id, revision) do nothing;

-- The notifier already sends through the property@ mailbox (Make connection
-- 10496840). Registered as an operator connection so the first apply keeps it
-- bound rather than treating Outlook email as unconnected.
insert into public.clone_voice_automation_connections (
  clone_id, kind, state, source, make_connection_id, account_label, requested_by_label, authorized_at
)
select c.id, 'outlook_mail', 'authorized', 'operator', 10496840, 'property@npcservices.com.au',
  'Registered from the 9 Oct 2026 build', now()
from public.clones c
where c.github_repo = 'npc-crm-independent-6505dc'
  and not exists (
    select 1 from public.clone_voice_automation_connections x
    where x.clone_id = c.id and x.kind = 'outlook_mail' and x.state = 'authorized'
  );
