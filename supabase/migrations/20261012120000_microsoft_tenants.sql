-- @asserts table:microsoft_tenants
-- @asserts column:email_campaigns.tenant_id
-- @asserts column:email_campaign_messages.tenant_id
-- @asserts column:email_campaign_sending_mailboxes.tenant_id
--
-- Microsoft tenants beyond the one in the deployment's secrets. See
-- docs/EMAIL_CAMPAIGNS.md, "Microsoft tenants".
--
-- ## Why the credentials live in the Vault
--
-- The first tenant's credentials are deployment secrets (MICROSOFT_TENANT_ID,
-- MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_MAILBOX_EMAIL), set
-- in Lovable and read by the Worker from its environment. A running
-- deployment cannot add to that environment: there is no API for it, and the
-- Worker only sees what it was deployed with. So tenants added from the
-- console keep their credentials in the database's own secret store —
-- Supabase Vault, where this deployment already keeps `cron_secret` and
-- `public_app_url` — encrypted at rest, and treated the way a deployment
-- secret is: written from the console, never read back to it.
--
-- One Vault secret per tenant holds all three values as JSON (tenant ID,
-- application/client ID, client secret). The table keeps only what the
-- console shows: a label, the default mailbox, and HINTS — the last four
-- characters of the two IDs and the first three of the secret, which is the
-- hint the Azure portal itself shows beside a client secret, so the right one
-- can be found there when it is time to rotate.
--
-- ## Who can do what
--
-- * Operators read the table (it holds no secret) — a campaign picks its
--   tenant from it.
-- * Nobody writes it with a browser session: every write goes through an
--   admin-gated server function using the service role.
-- * The Vault is reached only through the three functions below, executable
--   by the service role and nobody else.
--
-- ## Removal
--
-- A tenant is never deleted. Removing one destroys its Vault secret and
-- stamps `removed_at`; the row stays, because campaigns and the message
-- ledger name it and the record of which tenant a message left from must
-- outlive the credentials. A tenant a RUNNING campaign uses cannot be removed.
--
-- ## Campaigns and messages
--
-- `email_campaigns.tenant_id` is the tenant a campaign sends with; null is the
-- deployment's own (the Lovable secrets), which is what every existing
-- campaign keeps. `email_campaign_messages.tenant_id` records which tenant
-- each message actually left through, written before the send like the rest
-- of the message row. The sending-mailboxes view gains the tenant, because the
-- bounce scan has to read each mailbox with the credentials of the tenant it
-- lives in.

CREATE TABLE IF NOT EXISTS public.microsoft_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- The mailbox this tenant's campaigns send from when they do not name one —
  -- the counterpart of MICROSOFT_MAILBOX_EMAIL. Optional.
  default_mailbox TEXT CHECK (default_mailbox IS NULL OR default_mailbox ~ '^[^@\s]+@[^@\s]+$'),
  directory_hint TEXT NOT NULL CHECK (length(directory_hint) <= 16),
  client_hint TEXT NOT NULL CHECK (length(client_hint) <= 16),
  secret_hint TEXT NOT NULL CHECK (length(secret_hint) <= 8),
  -- When the client secret expires, if the admin entered it. Azure secrets
  -- expire (24 months at most), and an expired one stops every campaign on
  -- the tenant at once — the console warns ahead of it.
  secret_expires_on DATE,
  -- sha256 of "<tenant id>:<client id>", lower-cased, computed by the server:
  -- the same application registration cannot be added twice.
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  -- The Vault secret holding the credentials. Set by
  -- microsoft_tenant_credentials_put; cleared when the tenant is removed.
  vault_secret_id UUID,
  -- Bumped on every credential write, so a cached token for the old
  -- credentials is never reused after a rotation.
  credentials_version INTEGER NOT NULL DEFAULT 0,
  -- From the last successful verification: the application permissions the
  -- token carried. Advisory, like everywhere else in this feature.
  granted_roles TEXT[],
  verified_at TIMESTAMPTZ,
  verify_error TEXT,
  removed_at TIMESTAMPTZ,
  removed_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.microsoft_tenants IS
  'Microsoft 365 tenants campaigns can send through, beyond the deployment''s own (its Lovable secrets). Credentials are in Supabase Vault, reached only by the service role; this table holds labels and hints.';
COMMENT ON COLUMN public.microsoft_tenants.fingerprint IS
  'sha256 of lower(tenant id) || '':'' || lower(client id). One live row per application registration.';
COMMENT ON COLUMN public.microsoft_tenants.vault_secret_id IS
  'vault.secrets row holding {tenantId, clientId, clientSecret} as JSON. Read only through microsoft_tenant_credentials().';

CREATE UNIQUE INDEX IF NOT EXISTS microsoft_tenants_fingerprint_live
  ON public.microsoft_tenants (fingerprint) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS microsoft_tenants_label_live
  ON public.microsoft_tenants (lower(btrim(label))) WHERE removed_at IS NULL;

ALTER TABLE public.microsoft_tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read Microsoft tenants" ON public.microsoft_tenants;
CREATE POLICY "Operators read Microsoft tenants"
  ON public.microsoft_tenants FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- The Vault, behind three functions
--
-- plpgsql, so creating them does not require the vault schema to exist yet
-- (a replay from empty creates functions before the platform's extensions).
-- Executable by the service role only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.microsoft_tenant_credentials_put(p_tenant UUID, p_credentials TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret UUID;
  v_name TEXT := 'microsoft_tenant_' || p_tenant::TEXT;
BEGIN
  IF p_credentials IS NULL OR length(p_credentials) = 0 THEN
    RAISE EXCEPTION 'microsoft_tenant_credentials_empty';
  END IF;

  SELECT vault_secret_id INTO v_secret
    FROM public.microsoft_tenants
   WHERE id = p_tenant AND removed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'microsoft_tenant_not_found';
  END IF;

  -- A secret left behind by an earlier attempt that never recorded its id is
  -- found by name and reused rather than colliding with it.
  IF v_secret IS NULL OR NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_secret) THEN
    SELECT id INTO v_secret FROM vault.secrets WHERE name = v_name;
  END IF;

  IF v_secret IS NULL THEN
    v_secret := vault.create_secret(
      p_credentials,
      v_name,
      'Microsoft Graph application credentials for a Mission Control sending tenant'
    );
  ELSE
    PERFORM vault.update_secret(v_secret, p_credentials);
  END IF;

  UPDATE public.microsoft_tenants
     SET vault_secret_id = v_secret,
         credentials_version = credentials_version + 1,
         updated_at = now()
   WHERE id = p_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.microsoft_tenant_credentials(p_tenant UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value TEXT;
BEGIN
  SELECT s.decrypted_secret INTO v_value
    FROM public.microsoft_tenants t
    JOIN vault.decrypted_secrets s ON s.id = t.vault_secret_id
   WHERE t.id = p_tenant AND t.removed_at IS NULL;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.microsoft_tenant_remove(p_tenant UUID, p_actor UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret UUID;
BEGIN
  SELECT vault_secret_id INTO v_secret
    FROM public.microsoft_tenants
   WHERE id = p_tenant AND removed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'microsoft_tenant_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.email_campaigns WHERE tenant_id = p_tenant AND status = 'running'
  ) THEN
    RAISE EXCEPTION 'microsoft_tenant_in_use';
  END IF;

  -- Overwritten first, with the same call the credentials were written by, so
  -- they are gone even where this role may not delete from the Vault; then
  -- deleted outright where it may.
  IF v_secret IS NOT NULL THEN
    PERFORM vault.update_secret(v_secret, '{}');
  END IF;
  BEGIN
    DELETE FROM vault.secrets
     WHERE id = v_secret OR name = 'microsoft_tenant_' || p_tenant::TEXT;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'microsoft_tenant_remove: Vault secret overwritten, not deleted (%)', SQLERRM;
  END;

  UPDATE public.microsoft_tenants
     SET vault_secret_id = NULL,
         removed_at = now(),
         removed_by = p_actor,
         updated_at = now()
   WHERE id = p_tenant;
END;
$$;

REVOKE ALL ON FUNCTION public.microsoft_tenant_credentials_put(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.microsoft_tenant_credentials(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.microsoft_tenant_remove(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_credentials_put(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_credentials(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_remove(UUID, UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Which tenant a campaign sends with, and which tenant a message left through
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.microsoft_tenants(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.email_campaigns.tenant_id IS
  'The Microsoft tenant this campaign sends with. Null is the deployment''s own (its Lovable secrets).';
CREATE INDEX IF NOT EXISTS idx_email_campaigns_tenant_id
  ON public.email_campaigns (tenant_id);

ALTER TABLE public.email_campaign_messages
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.microsoft_tenants(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.email_campaign_messages.tenant_id IS
  'The Microsoft tenant this message left through. Null is the deployment''s own. Written before the send.';
CREATE INDEX IF NOT EXISTS idx_email_campaign_messages_tenant_id
  ON public.email_campaign_messages (tenant_id);

-- The column is appended, so the view's existing columns keep their places
-- and CREATE OR REPLACE is enough.
CREATE OR REPLACE VIEW public.email_campaign_sending_mailboxes
WITH (security_invoker = true) AS
SELECT
  lower(mailbox) AS mailbox,
  max(queued_at) AS last_used_at,
  count(*)::BIGINT AS messages,
  tenant_id
FROM public.email_campaign_messages
WHERE mailbox IS NOT NULL
GROUP BY lower(mailbox), tenant_id;

COMMENT ON VIEW public.email_campaign_sending_mailboxes IS
  'Each (mailbox, tenant) a campaign message has left from, and when last. The bounce scan reads every one used recently, with that tenant''s credentials. Reads with the caller''s own rights.';

GRANT SELECT ON public.email_campaign_sending_mailboxes TO authenticated;
