-- ===========================================================================
-- The rate limiter learns two things it never had: a bucket, and an identity
-- that is not a key
--
-- @asserts column:token_api_rate_limits.bucket
-- @asserts rpc:check_api_rate_limit
-- @asserts table:public_rate_limits
-- @asserts rpc:check_public_rate_limit
--
-- `check_api_rate_limit(_key_id uuid, _limit integer)` takes a uuid, and
-- `token_api_rate_limits.key_id` is `uuid NOT NULL REFERENCES
-- clone_api_keys(id)`. There is exactly one counter per key and no way to name
-- anything else. Four routes needed something else, and all four invented it
-- by composing a string into the key:
--
--     checkRateLimit(`gate:${key.id}`, 120)                      clones.gate
--     checkRateLimit(`gate:checkout:${key.id}`, 12)              clones.gate.checkout
--     checkRateLimit(`storefront:checkout:${data.h ?? data.uid}`) storefront.checkout
--     checkRateLimit(`storefront:setup:${data.h ?? data.uid}`)    storefront.setup
--
-- `'gate:550e8400-…'::uuid` is `22P02 invalid input syntax for type uuid`. The
-- RPC therefore errored on every call, `checkRateLimit` fails CLOSED on a DB
-- error by design, and all four routes returned **429 to every request ever
-- made of them**. Measured over 24h on 2026-09-16, before this migration:
--
--   * NPC Property Dashboard   666 gate reads, 666 answered 429  (100%)
--   * npc-client-dashboard     519 gate reads, 519 answered 429  (100%)
--
-- Not one has ever succeeded. Between them these four are the entire payment
-- path: the activation gate's verdict, its pay-to-unlock button, and both
-- storefront purchase routes — including the pricing page the gate falls back
-- to when minting a session fails. The clone fails OPEN on a 429, so the
-- visible effect was nothing at all.
--
-- These were the only 4 of ~30 `checkRateLimit` call sites passing anything
-- other than a bare `key.id`. Every other route was, and is, unaffected.
--
-- ## Two different problems, two different fixes
--
-- The gate's two routes hold a real `clone_api_keys` row and wanted a SEPARATE
-- ALLOWANCE on it, so that a browser polling the verdict every five minutes
-- could never spend the budget a token reservation depends on. That is a
-- second dimension on an existing counter: `bucket`.
--
-- The storefront's two routes hold no key at all — `h` is a handoff uuid and
-- `uid` is an arbitrary string from a pricing-page link, and the routes are
-- reachable with no credential whatsoever. There is no `clone_api_keys` row to
-- point at, so the FK cannot be satisfied and `bucket` does not help. Widening
-- `_key_id` to text would "fix" them by destroying the FK that makes the keyed
-- counter mean anything. They get their own table instead, with no FK, because
-- an anonymous caller is genuinely not a key and pretending otherwise is what
-- produced this defect in the first place.
--
-- ## Why the old function is dropped rather than overloaded
--
-- `CREATE OR REPLACE` cannot add a parameter; it would leave
-- `check_api_rate_limit(uuid, integer)` standing beside
-- `check_api_rate_limit(uuid, integer, text DEFAULT '')`, and a two-argument
-- call then matches both — `42725 function is not unique`. That would break
-- the 26 call sites this migration is meant to leave alone. One function, one
-- signature, a defaulted third parameter.
--
-- Existing rows take `bucket = ''`, which is what the two-argument call still
-- resolves to, so a key part-way through a window keeps its count and no
-- caller observes a reset.
-- ===========================================================================

-- ─── The bucket, for callers that do hold a key ─────────────────────────────
ALTER TABLE public.token_api_rate_limits
  ADD COLUMN IF NOT EXISTS bucket text NOT NULL DEFAULT '';

-- Re-key on (key_id, bucket, window_start). `key_id` stays the leading column,
-- so the index that serves the FK to clone_api_keys is unchanged.
ALTER TABLE public.token_api_rate_limits
  DROP CONSTRAINT IF EXISTS token_api_rate_limits_pkey;
ALTER TABLE public.token_api_rate_limits
  ADD CONSTRAINT token_api_rate_limits_pkey
  PRIMARY KEY (key_id, bucket, window_start);

DROP FUNCTION IF EXISTS public.check_api_rate_limit(uuid, integer);

CREATE OR REPLACE FUNCTION public.check_api_rate_limit(
  _key_id uuid,
  _limit integer DEFAULT 60,
  _bucket text DEFAULT ''
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _window timestamptz := date_trunc('minute', now());
  _count integer;
  _b text := coalesce(_bucket, '');
BEGIN
  INSERT INTO public.token_api_rate_limits (key_id, bucket, window_start, count)
  VALUES (_key_id, _b, _window, 1)
  ON CONFLICT (key_id, bucket, window_start)
  DO UPDATE SET count = public.token_api_rate_limits.count + 1
  RETURNING count INTO _count;

  -- Best-effort cleanup of old windows (older than 10 min)
  DELETE FROM public.token_api_rate_limits
   WHERE window_start < now() - interval '10 minutes';

  IF _count > _limit THEN
    RETURN jsonb_build_object('ok', false, 'count', _count, 'limit', _limit, 'retry_after_seconds',
      EXTRACT(epoch FROM (_window + interval '1 minute' - now()))::int);
  END IF;
  RETURN jsonb_build_object('ok', true, 'count', _count, 'limit', _limit);
END;
$$;

-- ─── The keyless counter, for callers that hold nothing ─────────────────────
-- No foreign key, deliberately: the identity is a pricing-page `uid` or a
-- handoff id belonging to somebody who has not authenticated. `scope` is what
-- `bucket` is on the keyed table — the endpoint family — and is part of the
-- key so two endpoints cannot spend each other's allowance.
CREATE TABLE IF NOT EXISTS public.public_rate_limits (
  scope text NOT NULL,
  identity text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, identity, window_start)
);
ALTER TABLE public.public_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators read public rate limits" ON public.public_rate_limits;
CREATE POLICY "Operators read public rate limits" ON public.public_rate_limits
  FOR SELECT TO authenticated USING (is_operator(auth.uid()));

CREATE OR REPLACE FUNCTION public.check_public_rate_limit(
  _scope text,
  _identity text,
  _limit integer DEFAULT 60
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _window timestamptz := date_trunc('minute', now());
  _count integer;
  -- Bounded on purpose: an anonymous caller chooses this value, and an
  -- unbounded one is a row as wide as the request wants to make it. 200 is the
  -- cap the storefront's own Zod schema already puts on `uid`.
  _id text := left(coalesce(_identity, ''), 200);
BEGIN
  INSERT INTO public.public_rate_limits (scope, identity, window_start, count)
  VALUES (_scope, _id, _window, 1)
  ON CONFLICT (scope, identity, window_start)
  DO UPDATE SET count = public.public_rate_limits.count + 1
  RETURNING count INTO _count;

  DELETE FROM public.public_rate_limits
   WHERE window_start < now() - interval '10 minutes';

  IF _count > _limit THEN
    RETURN jsonb_build_object('ok', false, 'count', _count, 'limit', _limit, 'retry_after_seconds',
      EXTRACT(epoch FROM (_window + interval '1 minute' - now()))::int);
  END IF;
  RETURN jsonb_build_object('ok', true, 'count', _count, 'limit', _limit);
END;
$$;

-- Signatures changed, so PostgREST's schema cache has to be told.
NOTIFY pgrst, 'reload schema';
