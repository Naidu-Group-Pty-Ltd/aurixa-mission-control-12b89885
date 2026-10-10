-- @asserts table:clone_vapi_custody
-- @asserts table:clone_ghl_voice_credentials
-- @asserts table:voice_stack_templates
-- @asserts table:clone_voice_stacks
-- @asserts table:clone_voice_stack_ledger
-- @asserts check:clone_voice_stacks.crm_mode=independent
--
-- EVERY CLONE'S VOICE AGENTS, IN THE CLONE'S OWN VAPI ORG, COPIED FROM ITS
-- CRM LINE'S TEMPLATE. See docs/CLONE_VOICE_STACKS.md.
--
-- A clone answers its phone with a voice-agent stack: Make.com scenarios that
-- do the work, and Vapi tools, assistants and a squad that use them. Which
-- stack it gets follows its CRM line, exactly as its code does: a dependent
-- clone gets the GoHighLevel stack, an independent clone the native one, each
-- COPIED from the stack its line's head clone runs. When a clone changes line
-- (the CRM conversion), its voice stack changes with it.
--
-- ## clone_vapi_custody — one row per clone
--
-- Each clone's agents live in its OWN Vapi organisation, created on the
-- clone's own Resend address (`voice-agents@<sending domain>`) and held by
-- Aurixa: the tenant never sees the login, the password or the key. Vapi has
-- no API to create an account, so one sign-up per clone is an operator's; the
-- clone's domain RECEIVES mail (Resend receiving) so the verification code is
-- read back into Mission Control. The password and the private key are
-- encrypted by the application (CREDENTIALS_ENC_KEY) before they are written.
-- No two clones may hold the same org or key: both are unique here, so the
-- database refuses what `judgeVapiKey` refuses.
--
-- ## clone_ghl_voice_credentials — the dependent line's requirement
--
-- A CRM-dependent stack talks to the tenant's own GoHighLevel location, so its
-- API key and location are required before anything is built. The key is
-- encrypted, verified against the location with one read, and written into the
-- stack's own CFG for the scenarios that call GoHighLevel over HTTP.
--
-- ## voice_stack_templates — one row per line
--
-- Which objects of the line head's live stack play which role, and what each
-- foreign reference must become in a tenant's copy. Blueprints and prompts are
-- read LIVE at build time, so a fix to the head's stack reaches the next clone
-- copied from it. The head itself is resolved from prime_config's parent
-- columns, the same column every cascade on that line reads. The dependent
-- template is registered DISABLED with its reason (OPEN_QUESTIONS.md C1).
--
-- ## clone_voice_stacks and clone_voice_stack_ledger
--
-- One stack per (clone, line): a clone that converts and converts back
-- resumes the stack it had, its ledger intact. The ledger has one row per
-- object the build created, written the moment the object exists, so a tick
-- that runs out of time never creates anything twice.
--
-- ## Closed to every browser
--
-- Four of these tables hold secrets (an encrypted password, key, GoHighLevel
-- token, call-log secret) and the ledger names objects in tenants' orgs. All
-- five have RLS on and NO policy: only the service role reads them, and every
-- operator surface goes through server functions that return fingerprints,
-- never values. The one exception is the audited password reveal.

create table if not exists public.clone_vapi_custody (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null unique references public.clones(id) on delete cascade,

  sending_domain text,
  resend_domain_id text,
  receiving_enabled_at timestamptz,
  receiving_records jsonb not null default '[]'::jsonb,
  receiving_records_installed_via text
    check (receiving_records_installed_via in ('cloudflare', 'manual')),

  login_email text check (login_email is null or login_email ~ '^voice-agents@[a-z0-9.-]+$'),
  password_enc text,
  password_set_at timestamptz,

  signed_up_at timestamptz,
  signed_up_by uuid,

  vapi_org_id text check (
    vapi_org_id is null or vapi_org_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  vapi_org_name text,
  private_key_enc text,
  public_key text,
  key_fingerprint text,
  key_verified_at timestamptz,
  key_set_by uuid,

  suspended_at timestamptz,
  suspended_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A password is held whole or not at all.
  check ((password_enc is null) = (password_set_at is null)),
  -- A verified key names its org and is held.
  check (key_verified_at is null or (private_key_enc is not null and vapi_org_id is not null and key_fingerprint is not null))
);

-- One org per clone, one key per clone: the database refuses a second holder.
create unique index if not exists clone_vapi_custody_one_org
  on public.clone_vapi_custody (vapi_org_id) where vapi_org_id is not null;
create unique index if not exists clone_vapi_custody_one_key
  on public.clone_vapi_custody (key_fingerprint) where key_fingerprint is not null;
create unique index if not exists clone_vapi_custody_one_login
  on public.clone_vapi_custody (login_email) where login_email is not null;

comment on table public.clone_vapi_custody is
  'Each clone''s own Vapi organisation, held by Aurixa: the login on the clone''s own Resend address, the org, and its private key (encrypted). Service role only. See docs/CLONE_VOICE_STACKS.md.';

create table if not exists public.clone_ghl_voice_credentials (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null unique references public.clones(id) on delete cascade,
  location_id text not null check (location_id ~ '^[A-Za-z0-9]{10,40}$'),
  location_name text,
  api_key_enc text not null,
  key_fingerprint text not null,
  verified_at timestamptz,
  last_error text,
  set_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.clone_ghl_voice_credentials is
  'The tenant''s GoHighLevel API key (encrypted) and location, required for a CRM-dependent voice stack. Service role only.';

create table if not exists public.voice_stack_templates (
  crm_mode text primary key check (crm_mode in ('dependent', 'independent')),
  enabled boolean not null default true,
  disabled_reason text,
  manifest jsonb not null,
  version integer not null default 1 check (version > 0),
  notes text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (enabled or disabled_reason is not null)
);

comment on table public.voice_stack_templates is
  'Per CRM line: which objects of the line head''s live voice stack play which role, and what each becomes in a tenant''s copy (validated by voiceStackTemplate.pure.ts).';

create table if not exists public.clone_voice_stacks (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null references public.clones(id) on delete cascade,
  crm_mode text not null check (crm_mode in ('dependent', 'independent')),
  template_version integer,

  -- The tenant's business, replacing the head's in every prompt.
  clone_label text,
  identity_replacements jsonb not null default '[]'::jsonb,

  discovery jsonb,
  make_zone text check (make_zone in ('eu1', 'eu2', 'us1', 'us2')),
  make_team_id bigint,
  make_folder_id bigint,
  vapi_org_id text,
  call_log_url text,
  call_log_secret_enc text,

  status text not null default 'awaiting_requirements' check (
    status in ('awaiting_requirements', 'ready', 'provisioning', 'awaiting_connections', 'live', 'failed', 'parked')
  ),
  blocks jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  steps_done integer not null default 0,
  steps_total integer not null default 0,
  lease_until timestamptz,
  parked_at timestamptz,
  parked_reason text,
  live_at timestamptz,
  last_error text,
  operator_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clone_id, crm_mode),
  check (status <> 'parked' or parked_at is not null)
);

create index if not exists idx_clone_voice_stacks_status on public.clone_voice_stacks (status);

comment on table public.clone_voice_stacks is
  'A clone''s voice stack on one CRM line: built in the clone''s own Vapi org from its line''s template; one per (clone, line), so converting back resumes it. Status is derived from the plan and the ledger (voiceStackPlan.pure.ts).';

create table if not exists public.clone_voice_stack_ledger (
  id uuid primary key default gen_random_uuid(),
  stack_id uuid not null references public.clone_voice_stacks(id) on delete cascade,
  step_key text not null,
  status text not null check (status in ('done', 'waiting', 'failed')),
  external_id text,
  external_ref text,
  payload_sha text,
  -- An encrypted value a step must keep between ticks: a credential request's
  -- authorisation link, which lets whoever holds it attach an account.
  secret_enc text,
  detail text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stack_id, step_key)
);

-- Closed to browsers by REVOKE, not merely by an absent policy: these tables
-- hold encrypted Vapi keys, login passwords, GoHighLevel tokens and minted
-- webhook secrets, and a policy added later must not be all it takes to open
-- them. Only Mission Control's server, on the service role, reads or writes.
revoke all on public.clone_vapi_custody from anon, authenticated;
revoke all on public.clone_ghl_voice_credentials from anon, authenticated;
revoke all on public.voice_stack_templates from anon, authenticated;
revoke all on public.clone_voice_stacks from anon, authenticated;
revoke all on public.clone_voice_stack_ledger from anon, authenticated;

grant all on public.clone_vapi_custody to service_role;
grant all on public.clone_ghl_voice_credentials to service_role;
grant all on public.voice_stack_templates to service_role;
grant all on public.clone_voice_stacks to service_role;
grant all on public.clone_voice_stack_ledger to service_role;

alter table public.clone_vapi_custody enable row level security;
alter table public.clone_ghl_voice_credentials enable row level security;
alter table public.voice_stack_templates enable row level security;
alter table public.clone_voice_stacks enable row level security;
alter table public.clone_voice_stack_ledger enable row level security;

drop trigger if exists clone_vapi_custody_updated_at on public.clone_vapi_custody;
create trigger clone_vapi_custody_updated_at
  before update on public.clone_vapi_custody
  for each row execute function public.update_updated_at_column();
drop trigger if exists clone_ghl_voice_credentials_updated_at on public.clone_ghl_voice_credentials;
create trigger clone_ghl_voice_credentials_updated_at
  before update on public.clone_ghl_voice_credentials
  for each row execute function public.update_updated_at_column();
drop trigger if exists voice_stack_templates_updated_at on public.voice_stack_templates;
create trigger voice_stack_templates_updated_at
  before update on public.voice_stack_templates
  for each row execute function public.update_updated_at_column();
drop trigger if exists clone_voice_stacks_updated_at on public.clone_voice_stacks;
create trigger clone_voice_stacks_updated_at
  before update on public.clone_voice_stacks
  for each row execute function public.update_updated_at_column();
drop trigger if exists clone_voice_stack_ledger_updated_at on public.clone_voice_stack_ledger;
create trigger clone_voice_stack_ledger_updated_at
  before update on public.clone_voice_stack_ledger
  for each row execute function public.update_updated_at_column();

-- The two lines' templates. The manifests are `INDEPENDENT_TEMPLATE_SEED` and
-- `DEPENDENT_TEMPLATE_SEED` in voiceStackTemplate.pure.ts, byte for byte as
-- JSON (voiceStackTemplateSeed.test.ts holds the two to each other). A row an
-- operator has since edited is left alone.
insert into public.voice_stack_templates (crm_mode, enabled, disabled_reason, manifest, notes)
values (
  'independent',
  true,
  null,
  $manifest${
  "manifestVersion": 1,
  "label": "NPC CRM Independent — native stack",
  "make": {
    "zone": "us2",
    "teamId": 2731020,
    "hooks": [
      {
        "role": "adapter",
        "templateHookId": 2911007
      },
      {
        "role": "availability",
        "templateHookId": 2911143
      },
      {
        "role": "resolve_contact",
        "templateHookId": 2911144
      },
      {
        "role": "get_call_context",
        "templateHookId": 2911145
      },
      {
        "role": "context_inject",
        "templateHookId": 2911146
      },
      {
        "role": "create_booking",
        "templateHookId": 2911147
      },
      {
        "role": "manage_booking",
        "templateHookId": 2911148
      },
      {
        "role": "notifier",
        "templateHookId": 2911149
      },
      {
        "role": "loader",
        "templateHookId": 2911176
      }
    ],
    "dataStores": [
      {
        "role": "cfg",
        "templateStoreId": 168061,
        "records": "none",
        "isCfg": true
      },
      {
        "role": "contacts",
        "templateStoreId": 168062,
        "records": "none"
      },
      {
        "role": "call_context",
        "templateStoreId": 168063,
        "records": "none"
      },
      {
        "role": "bookings",
        "templateStoreId": 168064,
        "records": "none"
      },
      {
        "role": "code_library",
        "templateStoreId": 168112,
        "records": "copy"
      }
    ],
    "scenarios": [
      {
        "role": "adapter",
        "templateScenarioId": 6561418,
        "hookRole": "adapter"
      },
      {
        "role": "loader",
        "templateScenarioId": 6561648,
        "hookRole": "loader"
      },
      {
        "role": "notifier",
        "templateScenarioId": 6570895,
        "hookRole": "notifier"
      },
      {
        "role": "availability",
        "templateScenarioId": 6561680,
        "hookRole": "availability"
      },
      {
        "role": "resolve_contact",
        "templateScenarioId": 6570898,
        "hookRole": "resolve_contact"
      },
      {
        "role": "get_call_context",
        "templateScenarioId": 6570904,
        "hookRole": "get_call_context"
      },
      {
        "role": "context_inject",
        "templateScenarioId": 6570912,
        "hookRole": "context_inject"
      },
      {
        "role": "create_booking",
        "templateScenarioId": 6570921,
        "hookRole": "create_booking"
      },
      {
        "role": "manage_booking",
        "templateScenarioId": 6570940,
        "hookRole": "manage_booking"
      }
    ],
    "connections": {
      "shared": [
        {
          "templateConnectionId": 10496826,
          "label": "Aurixa OpenAI (availability classifier)"
        }
      ],
      "tenantOwned": [
        {
          "templateConnectionId": 10496840,
          "label": "The head's Outlook mailbox (property@)"
        },
        {
          "templateConnectionId": 10770538,
          "label": "The head's Google placeholder (Sheets, no calendar scope)"
        }
      ],
      "slotsByApp": {
        "microsoft-calendar": {
          "slot": "outlook_calendar",
          "appName": "microsoft-calendar",
          "appVersion": 2,
          "appModules": [
            "makeApiCall"
          ],
          "label": "Outlook calendar",
          "grantedBy": "voice_automation"
        },
        "google-calendar": {
          "slot": "google_calendar",
          "appName": "google-calendar",
          "appVersion": 5,
          "appModules": [
            "makeApiCall"
          ],
          "label": "Google Calendar",
          "grantedBy": "voice_automation"
        },
        "microsoft-email": {
          "slot": "outlook_mail",
          "appName": "microsoft-email",
          "appVersion": 2,
          "appModules": [
            "createAndSendAMessage"
          ],
          "label": "Outlook mailbox",
          "grantedBy": "voice_automation"
        },
        "google-email": {
          "slot": "gmail",
          "appName": "google-email",
          "appVersion": 4,
          "appModules": [
            "sendAnEmail"
          ],
          "label": "Gmail mailbox",
          "grantedBy": "voice_automation"
        }
      }
    },
    "cfg": {
      "storeRole": "cfg",
      "key": "default",
      "mintSecrets": [
        "adapter_secret"
      ],
      "hookUrls": {
        "adapter_url": "adapter",
        "notifier_url": "notifier"
      },
      "copyFields": [
        "outbound_assistants"
      ],
      "assistantMapField": "outbound_assistants",
      "secretFields": [
        "adapter_secret"
      ],
      "secretPlaceholders": {},
      "ghlFields": null
    }
  },
  "vapi": {
    "tools": [
      {
        "templateToolId": "9cf05400-00e4-40ed-98e3-7ae7fbe14346",
        "hookRole": "availability"
      },
      {
        "templateToolId": "8097aa3c-cb72-4e7b-9f6a-1b788f990f05",
        "hookRole": "create_booking"
      },
      {
        "templateToolId": "4b59270b-a240-44ae-bce9-6aaf7b3a1672",
        "hookRole": "resolve_contact"
      },
      {
        "templateToolId": "532347a9-b7f6-4e5d-ab38-76bd80419a35",
        "hookRole": "get_call_context"
      },
      {
        "templateToolId": "3c5449c7-36ec-4ebb-8d1b-eec481d1b9ea",
        "hookRole": "context_inject"
      },
      {
        "templateToolId": "70f3d5b3-fc62-42d0-854e-7c21b9319e2d",
        "hookRole": "manage_booking"
      },
      {
        "templateToolId": "838edbad-fc35-444b-865f-64b622af0121",
        "hookRole": null
      }
    ],
    "excludedTools": [
      {
        "templateToolId": "bf4b9260-0168-4beb-8a1b-52b5c4788f15",
        "reason": "transfer_to_human redirects a Twilio call through a scenario and store shared with NPC's production; a clone gets one with its own number (OPEN_QUESTIONS C3)."
      }
    ],
    "assistants": [
      {
        "templateAssistantId": "215286a3-0dcf-47a0-a845-5d6c2b0134d8",
        "role": "inbound"
      },
      {
        "templateAssistantId": "23d3cdb3-afbf-46ed-b71f-7b55e2947dcc",
        "role": "opt_in_follow_up_inbound"
      },
      {
        "templateAssistantId": "f08a7b8f-d687-45ab-8a19-d3e4efc054eb",
        "role": "strategy_session_inbound"
      },
      {
        "templateAssistantId": "598e8e6f-16de-432a-bdd7-6b1e89bb708e",
        "role": "ifc_inbound"
      },
      {
        "templateAssistantId": "cae508c6-3654-4b58-a900-c0425761053e",
        "role": "strategy_session_no_show"
      },
      {
        "templateAssistantId": "36c6f565-d0a7-4f90-8097-70159182e354",
        "role": "strategy_session_follow_up"
      },
      {
        "templateAssistantId": "be073b09-3cf2-4beb-a0f9-edf9c41ec058",
        "role": "quiz_follow_up"
      },
      {
        "templateAssistantId": "4045cabf-eec4-4deb-a4a7-2a5a289ba351",
        "role": "opt_in_follow_up"
      },
      {
        "templateAssistantId": "07d477e4-5a17-4e7f-b082-fed89b46710d",
        "role": "ifc_no_show"
      },
      {
        "templateAssistantId": "4c2831e2-d56d-48d5-a7a4-8fd92ed20b69",
        "role": "ifc_follow_up"
      },
      {
        "templateAssistantId": "a39ecd07-a23a-49eb-a3ad-7674efeafe71",
        "role": "discovery_no_show"
      },
      {
        "templateAssistantId": "f64f39e0-e016-409f-8cca-aeb754074de8",
        "role": "discovery_follow_up"
      },
      {
        "templateAssistantId": "a46ad64d-59c7-4b6e-9f1c-850baa8c715e",
        "role": "active_nurturing"
      }
    ],
    "squad": {
      "templateSquadId": "da489d4c-3795-4a4d-a9ce-3afae8bc6377"
    },
    "namePrefix": "NPC CI "
  },
  "identity": {
    "denylist": [
      "Naidu",
      "NPC",
      "npcservices",
      "npcservices.com.au",
      "Naidu Property Consulting",
      "NPC Services"
    ]
  }
}$manifest$::jsonb,
  'NPC CRM Independent''s native stack, built 9 Oct 2026 (clone repository voice-agents/crm-independent/HANDOFF.md §00.1).'
)
on conflict (crm_mode) do nothing;

insert into public.voice_stack_templates (crm_mode, enabled, disabled_reason, manifest, notes)
values (
  'dependent',
  false,
  $reason$The GoHighLevel booking template (Make 5978179) carries an unresolved private-token placeholder and no CFG reader, and every run of it errored. A dependent clone's stack is built once that template reads the stack's CFG (OPEN_QUESTIONS.md C1).$reason$,
  $manifest${
  "manifestVersion": 1,
  "label": "NPC — GoHighLevel stack",
  "make": {
    "zone": "us2",
    "teamId": 2731020,
    "hooks": [
      {
        "role": "availability",
        "templateHookId": 2704985
      },
      {
        "role": "create_booking",
        "templateHookId": 2704984
      },
      {
        "role": "resolve_contact",
        "templateHookId": 2705107
      },
      {
        "role": "get_call_context",
        "templateHookId": 2705106
      },
      {
        "role": "context_inject",
        "templateHookId": 2704945
      }
    ],
    "dataStores": [
      {
        "role": "ghl_contact_ids",
        "templateStoreId": 133627,
        "records": "none"
      }
    ],
    "scenarios": [
      {
        "role": "availability",
        "templateScenarioId": 5978159,
        "hookRole": "availability"
      },
      {
        "role": "create_booking",
        "templateScenarioId": 5978179,
        "hookRole": "create_booking"
      },
      {
        "role": "resolve_contact",
        "templateScenarioId": 5978434,
        "hookRole": "resolve_contact"
      },
      {
        "role": "get_call_context",
        "templateScenarioId": 5978425,
        "hookRole": "get_call_context"
      },
      {
        "role": "context_inject",
        "templateScenarioId": 5978051,
        "hookRole": "context_inject"
      }
    ],
    "connections": {
      "shared": [],
      "tenantOwned": [
        {
          "templateConnectionId": 10496865,
          "label": "The head's GoHighLevel location (NPC)"
        }
      ],
      "slotsByApp": {
        "highlevel": {
          "slot": "ghl",
          "appName": "highlevel",
          "appVersion": 1,
          "appModules": [
            "searchContacts",
            "createAContact"
          ],
          "label": "GoHighLevel location",
          "grantedBy": "stack"
        }
      }
    },
    "cfg": null
  },
  "vapi": {
    "tools": [
      {
        "templateToolId": "3d407940-f697-404c-a6d4-0137e79a0d9f",
        "hookRole": "availability"
      },
      {
        "templateToolId": "7d6b6d41-0059-44a9-a9c5-fdc0c8c6d218",
        "hookRole": "create_booking"
      },
      {
        "templateToolId": "05dd96f7-12e5-4d24-85dc-c2c43172bd1e",
        "hookRole": "resolve_contact"
      },
      {
        "templateToolId": "2c726b9d-bcd5-4334-b1a2-0e871554d9f9",
        "hookRole": "get_call_context"
      },
      {
        "templateToolId": "76dad303-a7fa-4e61-b933-c365b721b0cf",
        "hookRole": "context_inject"
      },
      {
        "templateToolId": "838edbad-fc35-444b-865f-64b622af0121",
        "hookRole": null
      }
    ],
    "excludedTools": [
      {
        "templateToolId": "bf4b9260-0168-4beb-8a1b-52b5c4788f15",
        "reason": "transfer_to_human redirects a Twilio call through a scenario and store shared with NPC's production; a clone gets one with its own number (OPEN_QUESTIONS C3)."
      },
      {
        "functionName": "ghl_delete_event_npc*",
        "reason": "The five GoHighLevel delete-event tools call scenarios that are inactive, marked invalid, and only ever emailed the admin; a dependent clone sends cancellations to a person (OPEN_QUESTIONS C2)."
      }
    ],
    "assistants": [
      {
        "templateAssistantId": "b834610e-469e-4f9f-9130-01a1fa751064",
        "role": "inbound"
      },
      {
        "templateAssistantId": "fdb1ecde-e884-4650-abd3-8c19a2a006dd",
        "role": "opt_in_follow_up_inbound"
      },
      {
        "templateAssistantId": "f958ec93-6f41-4507-a7b1-f8c8d54e775e",
        "role": "strategy_session_inbound"
      },
      {
        "templateAssistantId": "ed0aa90f-e5ea-439d-b086-f694cf5f978d",
        "role": "ifc_inbound"
      },
      {
        "templateAssistantId": "5aa70a8e-01fb-4bcb-b275-6822b4e7e3da",
        "role": "strategy_session_no_show"
      },
      {
        "templateAssistantId": "f8abe39e-0944-4a53-afa6-95ac1852f892",
        "role": "strategy_session_follow_up"
      },
      {
        "templateAssistantId": "044329e5-4709-49f9-81f7-d1e25ea28213",
        "role": "quiz_follow_up"
      },
      {
        "templateAssistantId": "9b4f7438-35b1-4d87-809a-03e56c2f9144",
        "role": "opt_in_follow_up"
      },
      {
        "templateAssistantId": "209964e0-9b0c-48b1-a190-9b462de21462",
        "role": "ifc_no_show"
      },
      {
        "templateAssistantId": "55685df0-3ab8-4b8b-8695-6640e4e06fc1",
        "role": "ifc_follow_up"
      },
      {
        "templateAssistantId": "9013efd8-c662-4466-99f9-bb9597b44cfb",
        "role": "discovery_no_show"
      },
      {
        "templateAssistantId": "d3f63417-ffdc-4505-91e8-f6ad6cd9841d",
        "role": "discovery_follow_up"
      },
      {
        "templateAssistantId": "66d3e994-32c4-4d38-90af-2351078ad0f7",
        "role": "active_nurturing"
      }
    ],
    "squad": {
      "templateSquadId": "13c37e4c-3289-4d0f-98f2-b16e2258c945"
    },
    "namePrefix": "NPC "
  },
  "identity": {
    "denylist": [
      "Naidu",
      "NPC",
      "npcservices",
      "npcservices.com.au",
      "Naidu Property Consulting",
      "NPC Services"
    ]
  }
}$manifest$::jsonb,
  'NPC''s GoHighLevel stack: the org-B copies of NPC''s assistants and the GoHighLevel scenarios their tools call (HANDOFF.md §01).'
)
on conflict (crm_mode) do nothing;
