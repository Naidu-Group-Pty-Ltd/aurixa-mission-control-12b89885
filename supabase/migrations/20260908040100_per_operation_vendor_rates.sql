-- One vendor credential, three prices.
--
-- @asserts table:api_provider_rate_features
-- @asserts rows:api_provider_rate_features>=3
--
-- `api_provider_rates` carries one row per SECRET, so `DIDIT_API_KEY` had one
-- price for every call it makes: cost USD 0.20, resale USD 0.40. Measured
-- 8 Sep 2026 against the vendor's own counters, that is true of exactly one
-- of the three operations:
--
--     id_verification_api    USD 0.20
--     passive_liveness_api   USD 0.05
--     face_match_api         USD 0.05
--
-- So a complete identity verification costs USD 0.30 and the flat rate books
-- USD 0.60 — the platform's own ledger overstating what it paid by 2x — and
-- charges the tenant USD 1.20, which is 4x cost against the 2x the owner
-- actually set on the rate row. The direct (`inherited`) path has always been
-- priced this way; it simply never showed, because until the brokered route
-- started billing nothing was being charged at all.
--
-- **This is an override table, not a replacement.** `api_provider_rates`
-- keeps its `UNIQUE (secret_name)` and stays the single row the rate editor
-- reads and writes, so nothing about that surface changes and it cannot be
-- broken by a second row appearing under the same name. A feature with no
-- override is priced by the base row exactly as before, which is what keeps
-- every other vendor untouched.
--
-- The resale figures are NOT a new pricing decision. Each is the measured
-- cost multiplied by the margin already on the base Didit row (400000/200000
-- = 2.0), so the owner's own multiple is preserved and only the cost it
-- multiplies is corrected. Changing the margin is a commercial decision and
-- belongs to the owner; these three rows are where they would change it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_provider_rate_features (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_name            text NOT NULL,
  -- Matches `api_usage_events.feature`, which the caller supplies. A feature
  -- nothing prices simply falls back to the base row.
  feature                text NOT NULL,
  cost_micros_per_unit   numeric(18,6) NOT NULL CHECK (cost_micros_per_unit   >= 0),
  resale_micros_per_unit numeric(18,6) NOT NULL CHECK (resale_micros_per_unit >= 0),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_provider_rate_features_secret_fk
    FOREIGN KEY (secret_name) REFERENCES public.api_provider_rates(secret_name) ON DELETE CASCADE,
  CONSTRAINT api_provider_rate_features_key UNIQUE (secret_name, feature)
);

ALTER TABLE public.api_provider_rate_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins write api_provider_rate_features" ON public.api_provider_rate_features;
CREATE POLICY "Admins write api_provider_rate_features"
  ON public.api_provider_rate_features FOR ALL
  USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

DROP POLICY IF EXISTS "Operators read api_provider_rate_features" ON public.api_provider_rate_features;
CREATE POLICY "Operators read api_provider_rate_features"
  ON public.api_provider_rate_features FOR SELECT
  USING (is_operator(auth.uid()));

-- Measured 8 Sep 2026 from the vendor's own usage counters. Resale carries
-- the base row's existing 2.0 margin forward; see the header.
INSERT INTO public.api_provider_rate_features
  (secret_name, feature, cost_micros_per_unit, resale_micros_per_unit, notes)
VALUES
  ('DIDIT_API_KEY','id-verification', 200000, 400000,
   'Measured 8 Sep 2026: id_verification_api USD 0.20/request, no free tier.'),
  ('DIDIT_API_KEY','passive-liveness', 50000, 100000,
   'Measured 8 Sep 2026: passive_liveness_api USD 0.05/request, no free tier.'),
  ('DIDIT_API_KEY','face-match',       50000, 100000,
   'Measured 8 Sep 2026: face_match_api USD 0.05/request, no free tier.')
ON CONFLICT (secret_name, feature) DO UPDATE
  SET cost_micros_per_unit   = EXCLUDED.cost_micros_per_unit,
      resale_micros_per_unit = EXCLUDED.resale_micros_per_unit,
      notes                  = EXCLUDED.notes,
      updated_at             = now();

COMMIT;
