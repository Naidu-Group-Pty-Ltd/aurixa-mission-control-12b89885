-- Didit's money stops at Aurixa; the workspace pays in tokens.
--
-- @asserts none:sets flags and prices on existing catalog rows and seeds one
-- @asserts none:token_rates row. `rows:` counts a table, and every table here
-- @asserts none:already holds rows, so it would pass whether or not this ran.
-- @asserts none:The effect is asserted by the verification block at the end,
-- @asserts none:which fails the migration if any of the three did not land.
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
--  3. `token_rates` gains the identity-verification price, so what a
--     workspace is actually charged is visible in the operator UI and
--     repriceable there. It is reference data: `reserve_tokens` takes the
--     amount from the caller, and the prime states it in
--     `_shared/aml/verificationTokenPrice.pure.ts`. Both are recorded in the
--     notes so neither can be repriced in ignorance of the other.

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

INSERT INTO public.token_rates (kind, base_cost, per_unit, notes)
SELECT 'aml_identity_check', 10, '{"attempt": 5, "verified": 5}'::jsonb,
       'Customer identity verification (Didit standalone). 5 tokens are charged when an '
    || 'attempt is CONSUMED and 5 more when the identity is verified, so a verified customer '
    || 'costs 10 and a decline costs 5. base_cost is the worst case, which is what the clone '
    || 'reserves before the first paid call. An attempt is not consumed for a photograph the '
    || 'provider could not read, or for any failure of ours — the clone decides that, in '
    || '_shared/aml/verificationTokenPrice.pure.ts, and this row must be repriced with it. '
    || 'Aurixa absorbs the vendor USD 0.30 separately; see api_provider_rates.absorbed.'
 WHERE NOT EXISTS (SELECT 1 FROM public.token_rates WHERE kind = 'aml_identity_check');

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

  SELECT count(*) INTO _rate FROM public.token_rates WHERE kind = 'aml_identity_check';
  IF _rate <> 1 THEN
    RAISE EXCEPTION 'token price did not converge: % rows for aml_identity_check', _rate;
  END IF;
END $$;

COMMIT;
