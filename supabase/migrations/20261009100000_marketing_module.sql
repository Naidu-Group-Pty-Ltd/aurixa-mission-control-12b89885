-- @asserts table:marketing_connections
-- @asserts table:marketing_channel_snapshots
-- @asserts table:marketing_reports
--
-- The Marketing module: Aurixa Systems' own advertising, read from Meta, Google
-- Ads (YouTube placements), TikTok and the YouTube channel, and set beside the
-- leads and deals it produced.
--
-- It is the prime's Marketing module (npc-property-dashbord, docs/marketing/
-- YOUTUBE_AND_TIKTOK.md) carried across. The engine that reads and judges the
-- figures is the same files byte for byte (src/lib/marketing/engine, pinned by
-- MARKETING_ENGINE.lock.json); what differs is where the credentials live and
-- what a lead is. The prime keeps its vendor keys as edge-function secrets set
-- on its Integrations page; Mission Control has no such page for its own
-- accounts, so an administrator enters them on /marketing/connections and they
-- are stored here, encrypted by the application. A lead is a `waitlist_leads`
-- row, and a lead becomes revenue through `crm_deals`.
--
-- ## Three tables
--
-- - `marketing_connections` — one row per source, holding its account
--   identifiers in clear (an ad account id, a channel id: they name an account
--   and grant nothing) and its credentials encrypted (`enc:v1:…`). Closed to
--   every browser role: the server functions read it with the service role and
--   return fingerprints, never a value. A policy here would hand a browser the
--   ciphertext of an advertising token.
-- - `marketing_channel_snapshots` — one row per channel, account and day,
--   written by the nightly recorder and by every visit to the YouTube page. The
--   YouTube Data API answers lifetime counters only, so a channel's growth
--   exists only if somebody recorded it; and the advertising platforms restate
--   recent days, so the newest reading of a day replaces the older one.
--   `metrics` holds only what the source MEASURED — an absent key is a figure
--   the vendor did not report, never a zero.
-- - `marketing_reports` — every digest and weekly brief a model wrote, with the
--   facts it was given, so a brief can be re-read beside the figures it was
--   written from.
--
-- Operators READ the snapshots and reports through their own session (the
-- policies below); every write is the service role, after `requireOperator`.
--
-- ## The prime's new vendor keys
--
-- The prime now meters four more hosts against four secret names. Each names
-- ONE account — a channel, an ad account, an advertiser — so none is ever
-- forwarded to a clone (it would show one agency another's advertising), and
-- they are recorded here as metered and not billable, the way META_ADS_ACCESS_
-- TOKEN already is. Without a row a clone's usage lands as `unknown_secret`.
--
-- ROLLBACK:
--   DROP TABLE public.marketing_reports;
--   DROP TABLE public.marketing_channel_snapshots;
--   DROP TABLE public.marketing_connections;
--   DELETE FROM public.api_provider_rates WHERE secret_name IN
--     ('YOUTUBE_API_KEY','YOUTUBE_OAUTH_REFRESH_TOKEN','GOOGLE_ADS_DEVELOPER_TOKEN','TIKTOK_ADS_ACCESS_TOKEN');

-- ─────────────────────────────────────────────────────────────────────────────
-- Connections
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketing_connections (
  source TEXT PRIMARY KEY
    CONSTRAINT marketing_connections_source_check
    CHECK (source IN ('meta_ads', 'google_ads', 'tiktok_ads', 'youtube_data', 'youtube_analytics')),
  -- Account identifiers and options. Never a credential.
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT marketing_connections_settings_object CHECK (jsonb_typeof(settings) = 'object'),
  -- Each credential encrypted by the application; never selected for a browser.
  secrets_enc JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT marketing_connections_secrets_object CHECK (jsonb_typeof(secrets_enc) = 'object'),
  -- Last four characters and a hash prefix per credential: enough to tell two
  -- keys apart, never enough to use one.
  fingerprints JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT marketing_connections_fingerprints_object CHECK (jsonb_typeof(fingerprints) = 'object'),
  -- The vendor accepted these credentials at this moment.
  verified_at TIMESTAMPTZ,
  -- The account the vendor answered for, in its own words ("Aurixa Systems").
  account_name TEXT,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_connections IS
  'Mission Control''s own advertising and YouTube credentials, one row per source. Credentials are encrypted by the application and read only by the service role.';

ALTER TABLE public.marketing_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_connections FROM anon, authenticated;
GRANT ALL ON public.marketing_connections TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Daily readings
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketing_channel_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL
    CONSTRAINT marketing_channel_snapshots_channel_check
    CHECK (channel IN ('youtube_channel', 'youtube_ads', 'tiktok_ads', 'meta_ads')),
  -- The vendor's identifier for the account read. Never a credential.
  account_ref TEXT NOT NULL
    CONSTRAINT marketing_channel_snapshots_account_ref_check
    CHECK (char_length(account_ref) BETWEEN 1 AND 64),
  snapshot_date DATE NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT marketing_channel_snapshots_metrics_object CHECK (jsonb_typeof(metrics) = 'object'),
  currency TEXT
    CONSTRAINT marketing_channel_snapshots_currency_check
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  source TEXT NOT NULL DEFAULT 'scheduled'
    CONSTRAINT marketing_channel_snapshots_source_check
    CHECK (source IN ('page_view', 'scheduled')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_channel_snapshots_one_per_day UNIQUE (channel, account_ref, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_marketing_channel_snapshots_date
  ON public.marketing_channel_snapshots (snapshot_date DESC);

COMMENT ON TABLE public.marketing_channel_snapshots IS
  'One reading per channel, account and day. A later reading of the same day replaces the earlier; metrics hold only what the source measured.';

ALTER TABLE public.marketing_channel_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read marketing snapshots" ON public.marketing_channel_snapshots;
CREATE POLICY "Operators read marketing snapshots"
  ON public.marketing_channel_snapshots FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Digests and weekly briefs
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.marketing_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL
    CONSTRAINT marketing_reports_kind_check
    CHECK (kind IN ('digest', 'weekly_brief')),
  channel TEXT NOT NULL
    CONSTRAINT marketing_reports_channel_check
    CHECK (channel IN ('meta_ads', 'youtube_ads', 'tiktok_ads', 'youtube_channel', 'all')),
  range_since DATE NOT NULL,
  range_until DATE NOT NULL,
  content TEXT NOT NULL,
  -- The facts the model was handed, exactly. A brief is only as good as these.
  facts JSONB NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT marketing_reports_facts_object CHECK (jsonb_typeof(facts) = 'object'),
  model TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_reports_range_order CHECK (range_until >= range_since)
);

CREATE INDEX IF NOT EXISTS idx_marketing_reports_created
  ON public.marketing_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_reports_kind_channel
  ON public.marketing_reports (kind, channel, created_at DESC);

COMMENT ON TABLE public.marketing_reports IS
  'Every marketing digest and weekly brief a model wrote, with the facts it was written from.';

ALTER TABLE public.marketing_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read marketing reports" ON public.marketing_reports;
CREATE POLICY "Operators read marketing reports"
  ON public.marketing_reports FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- The prime's new vendor keys: metered, never forwarded, never billed
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.api_provider_rates
  (secret_name, provider, display_name, category, unit,
   cost_micros_per_unit, resale_micros_per_unit, included_free_units,
   currency, is_billable, notes)
VALUES
  ('YOUTUBE_API_KEY', 'youtube', 'YouTube Data API', 'marketing', 'request',
   0, 0, 0, 'AUD', false,
   'The tenant''s own key for its own channel. Quota-priced by Google (10,000 units a day free), not money; never forwarded.'),
  ('YOUTUBE_OAUTH_REFRESH_TOKEN', 'youtube-analytics', 'YouTube Analytics API', 'marketing', 'request',
   0, 0, 0, 'AUD', false,
   'The channel owner''s consent to read its analytics. Free; never forwarded.'),
  ('GOOGLE_ADS_DEVELOPER_TOKEN', 'google-ads', 'Google Ads API', 'marketing', 'request',
   0, 0, 0, 'AUD', false,
   'The tenant''s own developer token and ad account. Free to call; never forwarded.'),
  ('TIKTOK_ADS_ACCESS_TOKEN', 'tiktok-ads', 'TikTok Business API', 'marketing', 'request',
   0, 0, 0, 'AUD', false,
   'The tenant''s own advertiser token. Free to call; never forwarded.')
ON CONFLICT (secret_name) DO NOTHING;
