-- @asserts check:clone_backend_secrets.status=federated
--
-- A clone that reaches Anthropic with no key at all.
--
-- ## What the status means
--
-- `federated` says: this clone holds no `ANTHROPIC_API_KEY` and must not, and
-- it reaches Anthropic by exchanging a five-minute Mission Control assertion
-- for a token bound to its own workspace. The spend is still Aurixa's — the
-- organisation, the workspace and the service account are all ours — so it is
-- billable and recharged to this tenant exactly as an `inherited` key's usage
-- is.
--
-- ## Why not `withheld`, which already does the mechanical half
--
-- The fleet sweep already has a channel for a name a clone must NOT hold, and
-- reusing it would have worked mechanically: a `withheld` name is actively
-- removed from the project rather than merely skipped. But `withheld` means a
-- PERSON deliberately took the credential off this clone, and two provisioners
-- read it that way — `decideLlmKeyMint` refuses to mint over it, and
-- `decideWorkspaceProvision` refuses with "this clone has no Anthropic calls
-- to attribute."
--
-- For a federated clone that second sentence is the opposite of true: it has
-- Anthropic calls, they are ours to bill, and it needs its workspace more than
-- any other clone does. The status carries the distinction the mechanism does
-- not.
--
-- ## The three edits are one change
--
-- Each fails SILENTLY on its own, which is why they are together — the same
-- shape `minted` needed, one migration earlier:
--
--   1. The CHECK must accept `federated`, or every write is rejected by the
--      server while looking, from the function that tried it, exactly like a
--      write nobody attempted.
--   2. `resolve_api_key_billability` must RATE it, or it falls to the
--      `ELSE 'no_key'` arm, which is not billable — Aurixa pays the vendor and
--      recharges nobody, silently, while every ledger reading stays green.
--   3. The fleet sweep must treat it as a name to REMOVE rather than one to
--      forward, or the shared organisation key returns within thirty minutes
--      and the clone stops federating — because the prime prefers a key
--      whenever one is present. That one is TypeScript rather than SQL, and a
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
      'missing', 'set', 'failed', 'inherited', 'authorised_no_value', 'withheld',
      'minted', 'federated'));
END $$;

-- 2. The rating knows what it costs.
--
-- `federated` returns the reason `inherited`, for the reason `minted` does:
-- `api_usage_events.billing_reason` answers "who paid for this call", and the
-- answer here is identical to a forwarded key's — Aurixa's account, recharged
-- to the tenant at the resale rate. A distinct billing reason that behaved
-- exactly like `inherited` would make every rate rule, rollup arm and
-- settlement query learn a synonym, and the one that forgot would be the one
-- that silently charged nothing.
--
-- It is NOT `brokered`. Mission Control signs the identity but makes no vendor
-- call: the clone calls Anthropic directly, and a `brokered` reading would
-- send anybody auditing a charge looking for a request Mission Control never
-- made.
--
-- Which credential was spent stays legible where it belongs:
-- `clone_backend_secrets` keeps `federated`, and the operator's remedy is read
-- from there.
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
    -- Still Aurixa's money, and the clone holds nothing at all: a short-lived
    -- token in Aurixa's organisation, bound to this clone's own workspace.
    WHEN 'federated' THEN 'inherited'
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
