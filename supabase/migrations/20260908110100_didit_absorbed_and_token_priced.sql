-- Didit's money stops at Aurixa; the workspace pays in tokens.
--
-- @asserts none:sets flags and prices on existing catalog rows. `rows:` counts
-- @asserts none:a table, and every table here already holds rows, so it would
-- @asserts none:pass whether or not this ran. The effect is asserted by the
-- @asserts none:verification block at the end, which fails the migration if
-- @asserts none:any of the three edits did not land.
--
-- Three edits, all data:
--
--  1. `DIDIT_API_KEY` is marked `absorbed`. Aurixa pays the USD 0.30 and does
--     not recharge it; `record_api_usage_event` now rates such a call
--     `absorbed` — cost recorded, charge zero.
--
--  2. Its resale prices go to zero, on the base row and on all three
--     per-operation overrides. `absorbed` short-circuits before resale is
--     read, so this changes no arithmetic today. It exists for the day
--     somebody clears the flag without reading this file: they will then
--     charge nothing, which is a visible under-charge, rather than charging
--     money on top of the tokens already deducted — the tenant paying twice
--     for the same verification is the failure worth engineering against.
--     COST is untouched, so the margin report keeps reading the real 0.30.
--
--  3. The token price is made honest where it is already PUBLISHED.
--
--     `report_credit_costs` is the platform's price list — a clone resolves
--     its reserve from it through `getCreditCostForKind`, and the Aurixa
--     Systems pricing page renders it to customers. It has carried
--     `aml_identity_check` at 5 credits since 28 July. That row is the
--     ATTEMPT price and a verified identity costs it twice, so the row is
--     renamed to say "per attempt" (the public table shows name, category
--     and credits, and nothing else) and the doubling is written into the
--     description and the metadata for the operator UI.
--
--     Nothing new is seeded. A second price list is the defect this whole
--     change set exists to remove: the prime had a literal 400 in one route,
--     a 4 in a fallback table and nothing at all in the route that actually
--     runs, while the published number said 5.

BEGIN;

UPDATE public.api_provider_rates
   SET absorbed = true,
       resale_micros_per_unit = 0,
       notes = 'ABSORBED. Aurixa pays Didit and does not recharge the money: a workspace is '
            || 'charged 5 tokens per consumed attempt and 5 more for a verified identity '
            || '(prime: _shared/aml/verificationTokenPrice.pure.ts). Cost per call is real and '
            || 'still recorded — ID verification USD 0.20, passive liveness USD 0.05, face match '
            || 'USD 0.05, so a completed sequence is USD 0.30, none of it on a free tier '
            || '(measured against the live account 8 Sep 2026). Resale is 0 so that clearing '
            || '`absorbed` under-charges visibly rather than billing money on top of the tokens.',
       updated_at = now()
 WHERE secret_name = 'DIDIT_API_KEY';

UPDATE public.api_provider_rate_features
   SET resale_micros_per_unit = 0,
       notes = COALESCE(notes, '') || ' Resale zeroed: this vendor is absorbed and charged in tokens.',
       updated_at = now()
 WHERE secret_name = 'DIDIT_API_KEY';

-- The published price is per ATTEMPT. The credit_cost itself is NOT changed:
-- 5 is what customers have been quoted and what the clone already resolves.
UPDATE public.report_credit_costs
   SET name = 'AML — Identity Check (per attempt)',
       description =
         'Provider-backed identity verification. Charged once when an attempt is consumed '
      || 'and a second time if the identity is verified, so a verified customer costs twice '
      || 'this and a decline costs it once. A photograph the provider could not read, and any '
      || 'failure of ours, consume no attempt and cost nothing.',
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'charge_model', 'per_attempt_doubled_on_success',
         'reserve_multiplier', 2,
         'priced_by', '_shared/aml/verificationTokenPrice.pure.ts',
         'vendor_cost_absorbed', true
       ),
       updated_at = now()
 WHERE slug = 'aml_identity_check';

-- Asserted by effect. A data migration that ran and changed nothing is the
-- failure mode this corpus has already paid for (`DO $$ … EXCEPTION WHEN
-- OTHERS THEN NULL $$`), and none of the three edits above creates an object
-- an assertion kind can probe for.
DO $$
DECLARE _absorbed boolean; _resale numeric; _features integer; _rate integer;
BEGIN
  SELECT absorbed, resale_micros_per_unit INTO _absorbed, _resale
    FROM public.api_provider_rates WHERE secret_name = 'DIDIT_API_KEY';
  IF _absorbed IS DISTINCT FROM true OR _resale IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'didit absorption did not converge: absorbed=% resale=%', _absorbed, _resale;
  END IF;

  SELECT count(*) INTO _features FROM public.api_provider_rate_features
   WHERE secret_name = 'DIDIT_API_KEY' AND resale_micros_per_unit <> 0;
  IF _features > 0 THEN
    RAISE EXCEPTION 'didit absorption did not converge: % per-operation override(s) still charge', _features;
  END IF;

  SELECT count(*) INTO _rate FROM public.report_credit_costs
   WHERE slug = 'aml_identity_check'
     AND is_active
     AND credit_cost > 0
     AND metadata->>'token_kind' = 'aml_identity_check'
     AND metadata->>'charge_model' = 'per_attempt_doubled_on_success';
  IF _rate <> 1 THEN
    RAISE EXCEPTION 'token price did not converge: % priced, active aml_identity_check row(s) carrying the charge model', _rate;
  END IF;
END $$;

COMMIT;
