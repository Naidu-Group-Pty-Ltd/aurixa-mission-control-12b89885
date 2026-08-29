-- @asserts table:clone_turnstile_identities
--
-- Per-clone Turnstile (CAPTCHA) identity.
--
-- Every deployment in this fleet renders the SAME Cloudflare Turnstile widget:
-- the site key is hard-coded in the login page and the paired secret reaches a
-- clone as an ordinary inherited vendor credential. That is one widget for the
-- prime and every tenant, and it is wrong in three separate ways:
--
--   * Cross-tenant replay. A Turnstile token is bound to a (site key, secret)
--     PAIR, and `siteverify` reports the hostname it was issued for without
--     anyone checking it. One widget across the fleet therefore means a token
--     farmed from any tenant's login page — or the prime's, which is public —
--     verifies on every other tenant. The CAPTCHA stops being a per-deployment
--     control at all.
--   * Shared rotation blast radius. Rotating the widget at Cloudflare breaks
--     sign-in on every tenant at once, with an error that names nothing. This
--     is exactly the failure `RESEND_API_KEY` already produced here.
--   * Domain coupling. A Turnstile widget only issues tokens for hostnames on
--     its allow-list, so every new tenant domain has to be added to the
--     prime's widget — and the prime's widget then lists every customer.
--
-- So a clone gets its OWN widget: its own site key (public, published into the
-- clone's bundle as VITE_TURNSTILE_SITE_KEY) and its own secret (written to
-- the clone's Supabase project as TURNSTILE_SECRET_KEY). One tenant's token
-- verifies for that tenant alone.
--
-- The SECRET is never stored here. Cloudflare returns it on creation and on
-- rotation; it goes straight onto the clone's project and only its last four
-- characters are kept, the same rule `clone_email_identities` follows.

CREATE TABLE IF NOT EXISTS public.clone_turnstile_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id UUID NOT NULL UNIQUE REFERENCES public.clones(id) ON DELETE CASCADE,

  -- Cloudflare's widget id IS the site key, and it is public by design: it is
  -- rendered in the login page's HTML.
  site_key TEXT,
  widget_name TEXT,
  -- The hostnames the widget will issue tokens for. Derived from the clone's
  -- own origins; a widget with no domain issues nothing.
  domains TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'managed'
    CHECK (mode IN ('managed','non-interactive','invisible')),

  status TEXT NOT NULL DEFAULT 'unprovisioned'
    CHECK (status IN ('unprovisioned','provisioned','failed','revoked')),

  -- Identification without storage. Never the secret itself.
  secret_last4 TEXT,
  secret_written_at TIMESTAMPTZ,
  -- Set once the clone is fail-CLOSED: with its own secret in place the clone
  -- also carries REQUIRE_TURNSTILE=true, so a later secret loss refuses
  -- sign-in visibly instead of silently serving a login with no CAPTCHA.
  fail_closed_at TIMESTAMPTZ,
  -- The site key still has to reach the clone's BUILD. Recorded separately
  -- because a bundle is only rebuilt on the next deployment.
  site_key_published_at TIMESTAMPTZ,

  last_error TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clone_turnstile_identities TO authenticated;
GRANT ALL ON public.clone_turnstile_identities TO service_role;

ALTER TABLE public.clone_turnstile_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clone_turnstile_identities admin read" ON public.clone_turnstile_identities;
CREATE POLICY "clone_turnstile_identities admin read"
  ON public.clone_turnstile_identities FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "clone_turnstile_identities admin write" ON public.clone_turnstile_identities;
CREATE POLICY "clone_turnstile_identities admin write"
  ON public.clone_turnstile_identities FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS clone_turnstile_identities_updated_at ON public.clone_turnstile_identities;
CREATE TRIGGER clone_turnstile_identities_updated_at
  BEFORE UPDATE ON public.clone_turnstile_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_clone_turnstile_identities_status
  ON public.clone_turnstile_identities (status);
