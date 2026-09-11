-- @asserts check:clone_backend_secrets.status=minted
--
-- A model key MINTED for one clone on Aurixa's own provider account.
--
-- ## What this is for
--
-- Every clone runs on the same forwarded model keys today, so each vendor's
-- own dashboard shows one undifferentiated bill and the only per-tenant figure
-- anywhere is the one this platform computes for itself. Minting a key per
-- clone makes the vendor's ledger agree with ours, which is what makes a
-- disputed charge answerable.
--
-- Four of the five providers publish an endpoint that creates a key
-- (OpenRouter, OpenAI, Perplexity, Google). Anthropic does not — its own
-- documentation says so — and `llmKeyProvisioning.pure.ts` carries that as a
-- capability rather than a fault.
--
-- ## Why it cannot reuse a status that already exists
--
-- `inherited` means the prime's ONE key was forwarded. `set` means the TENANT
-- supplied their own. A minted key is neither: it is Aurixa's money, spent for
-- one clone, on a credential that exists only for that clone.
--
-- That is not a naming preference. The two existing statuses each carry a
-- consequence a minted key must not inherit:
--
--   `set`        `resolve_api_key_billability` rates it `byok` — NOT billable,
--                zero cost. A minted key recorded as `set` would have Aurixa
--                pay the vendor and recharge nobody, silently, for ever.
--   `inherited`  the fleet forward sweep treats it as a name it owns, so the
--                next reconcile would push the shared fleet key straight over
--                the minted one. And the operator's remedy differs: a bad
--                forwarded key is fixed on Mission Control and re-forwarded,
--                where a bad minted key is revoked at the vendor.
--
-- ## The three edits below are one change
--
-- Each of them fails SILENTLY on its own, which is why they are in one file:
--
--   1. The CHECK must accept `minted`, or every write is rejected by the
--      server while looking, from the function that tried it, exactly like a
--      write nobody attempted — the shape a CHECK-constrained `reminder_type`
--      already cost this platform once.
--   2. `resolve_api_key_billability` must RATE it, or it falls to the `ELSE
--      'no_key'` arm, which is not billable. Adding the status without the arm
--      loses the revenue this feature exists to capture, and every reading
--      stays green throughout.
--   3. `SETTLED` in `fleetSecretForward.server.ts` must include it, or the
--      half-hourly sweep overwrites the minted value with the fleet key and
--      the ledger flips back to `inherited` — the minting undoing itself
--      within thirty minutes. That one is TypeScript rather than SQL, and a
--      test asserts it beside this migration.
--
-- The constraint is REPLACED rather than widened, because Postgres has no
-- "add a value to a CHECK".
--
-- No BEGIN/COMMIT: the migration drain already runs each file inside a
-- transaction, and opening a second one is refused by `migrationQueueCorpus`
-- before it can reach a clone.

-- 1. The column accepts it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clone_backend_secrets_status_check'
  ) THEN
    ALTER TABLE public.clone_backend_secrets
      DROP CONSTRAINT clone_backend_secrets_status_check;
  END IF;

  ALTER TABLE public.clone_backend_secrets
    ADD CONSTRAINT clone_backend_secrets_status_check
    CHECK (status IN (
      'missing', 'set', 'failed', 'inherited', 'authorised_no_value', 'withheld', 'minted'));
END $$;

-- 2. The rating knows what it costs.
--
-- `minted` returns the reason `inherited`, deliberately and not as a
-- shortcut. `api_usage_events.billing_reason` answers "who paid for this
-- call", and for a minted key the answer is identical to a forwarded one:
-- Aurixa's account, recharged to the tenant at the resale rate. Introducing a
-- seventh billing reason that behaves exactly like `inherited` would mean
-- every rate rule, every rollup arm and every settlement query had to learn a
-- synonym, and the one that forgot would be the one that silently charged
-- nothing.
--
-- Which key was spent stays legible where it belongs: `clone_backend_secrets`
-- keeps `minted`, and that is what the operator's remedy is read from.
CREATE OR REPLACE FUNCTION public.resolve_api_key_billability(_clone_id uuid, _secret_name text)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _status text;
BEGIN
  IF _clone_id IS NULL THEN RETURN 'no_key'; END IF;
  SELECT status INTO _status
    FROM public.clone_backend_secrets
   WHERE clone_id = _clone_id AND name = _secret_name;
  IF _status IS NULL THEN RETURN 'unknown_secret'; END IF;
  RETURN CASE _status
    WHEN 'inherited' THEN 'inherited'
    -- Aurixa's money either way: forwarded from the prime, or minted for this
    -- clone on Aurixa's provider account. Both are recharged.
    WHEN 'minted'    THEN 'inherited'
    WHEN 'set'       THEN 'byok'
    -- The key was deliberately taken off this clone, so a call it makes is
    -- one Mission Control made for it, on our credential.
    WHEN 'withheld'  THEN 'brokered'
    -- 'missing', 'failed' and 'authorised_no_value' stay unbillable: each
    -- means no working credential exists on either side of the broker.
    ELSE 'no_key'
  END;
END
$function$;

