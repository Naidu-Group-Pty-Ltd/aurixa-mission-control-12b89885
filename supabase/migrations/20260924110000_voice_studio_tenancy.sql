-- Voice Cloning Studio: the client's VAPI key, and the tool backend a deployed
-- fleet talks to.
--
-- @asserts table:voice_studio_vapi_credentials
-- @asserts table:voice_tenant_configs
-- @asserts table:voice_tenant_contacts
-- @asserts table:voice_tenant_call_context
-- @asserts table:voice_tenant_appointments
-- @asserts table:voice_tenant_tickets
--
-- ## The tenant is the project
--
-- A deployed fleet belongs to one cloning project, and every row it writes is
-- keyed by that project. Not by clone: a project can target a lead or a
-- prospect that has no clone yet (a pilot, a demonstration), and the fleet it
-- deploys still needs somewhere to keep the people it talks to.
--
-- Aurixa's own fleet is untouched. Its tools keep answering from the CRM
-- (voice-tools.server.ts); a tenant's tools answer from these tables, through
-- /api/public/voice/t/$tenantKey/webhook. The two never share a row.
--
-- ## Two tables hold secrets and are closed to every browser
--
-- voice_studio_vapi_credentials holds the client's VAPI private key and
-- voice_tenant_configs holds the per-tenant webhook secret and the Make
-- transfer hook. Both are encrypted by the application
-- (src/server/crypto.server.ts, CREDENTIALS_ENC_KEY) before they are written,
-- and both tables have RLS on and NO policy, so only the service role can read
-- them. The Studio shows a fingerprint, never a value, and no server function
-- selects the encrypted column for a browser.

CREATE TABLE IF NOT EXISTS public.voice_studio_vapi_credentials (
  project_id   UUID PRIMARY KEY REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  api_key_enc  TEXT NOT NULL,
  -- The last four characters and a hash prefix: enough to tell two keys apart,
  -- never enough to use one.
  fingerprint  TEXT NOT NULL,
  verified_at  TIMESTAMPTZ,
  last_error   TEXT,
  set_by       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.voice_tenant_configs (
  project_id          UUID PRIMARY KEY REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  -- Opaque and random: the webhook URL names it, so it must not be guessable
  -- and must not change when the business is renamed.
  tenant_key          TEXT NOT NULL UNIQUE,
  webhook_secret_enc  TEXT NOT NULL,
  secret_fingerprint  TEXT NOT NULL,
  -- Off until a deploy has written the booking window the tools answer from.
  enabled             BOOLEAN NOT NULL DEFAULT false,
  business_name       TEXT,
  timezone            TEXT NOT NULL DEFAULT 'Australia/Sydney',
  booking_window      JSONB,
  booking_types       JSONB NOT NULL DEFAULT '[]'::jsonb,
  transfer_hook_url_enc TEXT,
  escalation_number   TEXT,
  call_log_url        TEXT,
  call_log_secret_enc TEXT,
  package_id          UUID REFERENCES public.voice_studio_packages (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_tenant_configs_package_idx ON public.voice_tenant_configs (package_id);

CREATE TABLE IF NOT EXISTS public.voice_tenant_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  email       TEXT,
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'voice_inbound',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One person per number per tenant; the tool resolves by number.
CREATE UNIQUE INDEX IF NOT EXISTS voice_tenant_contacts_phone_key
  ON public.voice_tenant_contacts (project_id, phone);

CREATE TABLE IF NOT EXISTS public.voice_tenant_call_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  vapi_call_id     TEXT NOT NULL,
  caller_phone     TEXT,
  normalized_phone TEXT,
  contact_id       UUID REFERENCES public.voice_tenant_contacts (id) ON DELETE SET NULL,
  first_name       TEXT,
  full_name        TEXT,
  contact_state    TEXT,
  contact_found    BOOLEAN,
  contact_created  BOOLEAN,
  confirmed_intent TEXT,
  caller_reason    TEXT,
  handoff_ready    BOOLEAN NOT NULL DEFAULT false,
  source           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_tenant_call_context_call_key
  ON public.voice_tenant_call_context (project_id, vapi_call_id);
CREATE INDEX IF NOT EXISTS voice_tenant_call_context_phone_idx
  ON public.voice_tenant_call_context (project_id, normalized_phone, updated_at DESC);
CREATE INDEX IF NOT EXISTS voice_tenant_call_context_contact_idx
  ON public.voice_tenant_call_context (contact_id);

CREATE TABLE IF NOT EXISTS public.voice_tenant_appointments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES public.voice_tenant_contacts (id) ON DELETE SET NULL,
  booking_type  TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed', 'no_show')),
  vapi_call_id  TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS voice_tenant_appointments_time_idx
  ON public.voice_tenant_appointments (project_id, starts_at);
CREATE INDEX IF NOT EXISTS voice_tenant_appointments_contact_idx
  ON public.voice_tenant_appointments (contact_id);
-- Two live bookings may not start at the same instant for one tenant. The
-- tool checks first; this is what makes a race between two calls lose
-- cleanly instead of double-booking.
CREATE UNIQUE INDEX IF NOT EXISTS voice_tenant_appointments_slot_key
  ON public.voice_tenant_appointments (project_id, starts_at)
  WHERE status IN ('scheduled', 'confirmed');

CREATE TABLE IF NOT EXISTS public.voice_tenant_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.voice_studio_projects (id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES public.voice_tenant_contacts (id) ON DELETE SET NULL,
  reference     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        TEXT,
  email         TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  vapi_call_id  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_tenant_tickets_reference_key ON public.voice_tenant_tickets (reference);
CREATE INDEX IF NOT EXISTS voice_tenant_tickets_project_idx ON public.voice_tenant_tickets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_tenant_tickets_contact_idx ON public.voice_tenant_tickets (contact_id);

-- ── Row security ────────────────────────────────────────────────────────────

ALTER TABLE public.voice_studio_vapi_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_tenant_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_tenant_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_tenant_call_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_tenant_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_tenant_tickets ENABLE ROW LEVEL SECURITY;

-- The two secret-bearing tables: service role only, and nothing granted to a
-- browser role at all, so a policy added by mistake later still reads nothing.
REVOKE ALL ON public.voice_studio_vapi_credentials FROM anon, authenticated;
REVOKE ALL ON public.voice_tenant_configs FROM anon, authenticated;
GRANT ALL ON public.voice_studio_vapi_credentials TO service_role;
GRANT ALL ON public.voice_tenant_configs TO service_role;

-- What the deployed fleet wrote: operators read it, admins correct it.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'voice_tenant_contacts',
    'voice_tenant_call_context',
    'voice_tenant_appointments',
    'voice_tenant_tickets'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS "Operators read %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Operators read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.is_operator(auth.uid()))',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS "Admins write %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Admins write %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()))',
      t
    );
  END LOOP;
END $$;

-- Spelled out rather than looped: scripts/check-rls-policies.mjs reads the
-- tables named in a FOREACH array as policied, and the two secret tables must
-- stay on its service-role-only list.
DROP TRIGGER IF EXISTS voice_studio_vapi_credentials_touch ON public.voice_studio_vapi_credentials;
CREATE TRIGGER voice_studio_vapi_credentials_touch BEFORE UPDATE ON public.voice_studio_vapi_credentials
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();
DROP TRIGGER IF EXISTS voice_tenant_configs_touch ON public.voice_tenant_configs;
CREATE TRIGGER voice_tenant_configs_touch BEFORE UPDATE ON public.voice_tenant_configs
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();
DROP TRIGGER IF EXISTS voice_tenant_contacts_touch ON public.voice_tenant_contacts;
CREATE TRIGGER voice_tenant_contacts_touch BEFORE UPDATE ON public.voice_tenant_contacts
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();
DROP TRIGGER IF EXISTS voice_tenant_call_context_touch ON public.voice_tenant_call_context;
CREATE TRIGGER voice_tenant_call_context_touch BEFORE UPDATE ON public.voice_tenant_call_context
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();
DROP TRIGGER IF EXISTS voice_tenant_appointments_touch ON public.voice_tenant_appointments;
CREATE TRIGGER voice_tenant_appointments_touch BEFORE UPDATE ON public.voice_tenant_appointments
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();
DROP TRIGGER IF EXISTS voice_tenant_tickets_touch ON public.voice_tenant_tickets;
CREATE TRIGGER voice_tenant_tickets_touch BEFORE UPDATE ON public.voice_tenant_tickets
  FOR EACH ROW EXECUTE FUNCTION public.touch_voice_studio_row();

COMMENT ON TABLE public.voice_studio_vapi_credentials IS
  'A cloning project''s VAPI private key, encrypted by the application. Service role only; the Studio shows the fingerprint.';
COMMENT ON TABLE public.voice_tenant_configs IS
  'What a deployed fleet''s tools answer from: the tenant key in its webhook URL, its encrypted secret, booking window and types. Service role only.';
