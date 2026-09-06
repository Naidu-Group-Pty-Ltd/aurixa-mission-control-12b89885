-- ─────────────────────────────────────────────────────────────────────────────
-- Didit travels to the fleet, by the owner's decision (6 Sep 2026).
--
-- Identity verification on every clone runs the same Didit application as the
-- prime: the credential is not clone-specific, so the three credential names
-- and the two threshold values the standalone verifier requires are authorised
-- forwards. The values are read out of Mission Control's OWN environment at
-- provisioning/repair time (the forwarded-key model); until Mission Control
-- holds them, every clone's ledger reads `authorised_no_value` for these names
-- — which is the honest state, not an error.
--
-- The thresholds are compliance policy rather than secrets, but they are
-- environment-held on the prime deliberately (changing the compliance position
-- is a deployment action with a record), and `readStandaloneThresholds` returns
-- null unless BOTH are present — a forwarded key without its thresholds leaves
-- the standalone verifier unconfigured.
--
-- The rate row is what makes a forwarded verification BILLABLE: a usage event
-- whose secret has no rate lands as `rate_missing` and is metered but never
-- charged. Unit is one API call; the dearest single call (ID verification,
-- USD 0.20) is the per-request fallback, mirroring the prime's own
-- `aml.provider_configs` note — passive liveness and face match are USD 0.05
-- each, so a full three-call sequence is USD 0.30.
--
-- @asserts rows:prime_secret_forwards>=45
-- @asserts rows:api_provider_rates>=20
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.prime_secret_forwards (name, inherit, description) VALUES
  ('DIDIT_API_KEY', true,
   'Fleet-wide Didit key — identity verification on every clone runs the prime''s Didit application and is recharged per tenant (owner''s decision, 6 Sep 2026).'),
  ('DIDIT_WEBHOOK_SECRET', true,
   'Signs Didit''s webhook callbacks. One Didit application across the fleet, so one signing secret.'),
  ('DIDIT_WORKFLOW_ID', true,
   'The hosted-flow workflow id of the fleet''s shared Didit application.'),
  ('DIDIT_LIVENESS_THRESHOLD', true,
   'Compliance policy, not a secret: the standalone verifier is unconfigured unless both thresholds are present. Environment-held so a change is a recorded deployment action.'),
  ('DIDIT_FACE_MATCH_THRESHOLD', true,
   'Compliance policy, not a secret — the second of the pair readStandaloneThresholds requires.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.api_provider_rates
  (secret_name, provider, display_name, category, unit,
   cost_micros_per_unit, resale_micros_per_unit, included_free_units,
   currency, is_billable, notes)
VALUES
  ('DIDIT_API_KEY', 'didit', 'Didit identity verification', 'compliance', 'request',
   200000, 400000, 0, 'USD', true,
   'Per API call. Dearest single call (ID verification, USD 0.20) as the per-request fallback; passive liveness and face match are USD 0.05 each, so a completed sequence is USD 0.30. Source: docs.didit.me pricing, observed 2026-08-11.')
ON CONFLICT (secret_name) DO NOTHING;
