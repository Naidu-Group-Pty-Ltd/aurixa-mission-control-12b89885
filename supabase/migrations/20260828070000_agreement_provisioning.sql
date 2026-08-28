-- @asserts column:client_agreements.provision_status
-- @asserts table:docusign_connect_events
-- @asserts cron:agreements-refresh
--
-- Signed agreement → provisioned clone.
--
-- The Service Level Agreement raised at /agreements now carries the COMMERCIAL
-- SELECTION — which tier plan, which modules, which add-ons, and which modules
-- were explicitly excluded in the negotiation — and, when armed, the moment
-- DocuSign reports the envelope signed, Mission Control provisions the clone
-- from exactly those parameters: repo, module install set, entitlements,
-- dedicated backend, deployment enqueue. No operator in the loop unless the
-- operator chose to be.
--
-- Two arrival paths converge on one handler:
--   * DocuSign Connect webhook (/api/public/hooks/docusign, HMAC-verified) —
--     instant, once DOCUSIGN_CONNECT_HMAC_KEY is configured.
--   * The agreements-refresh cron below — polls non-terminal envelopes with
--     the SAME JWT credentials the send path already uses, so signature-drives-
--     provisioning works with no additional secret, just minutes later.
--
-- Idempotency is layered: the webhook ledger claims (envelope_id, event) by
-- unique constraint; provisioning claims the agreement by a compare-and-set on
-- provision_status; and the clone insert itself carries an idempotency key.
-- A Connect retry, a concurrent cron poll and a double-clicked button all
-- land on one clone.

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'agreement_provisioned';

ALTER TABLE public.client_agreements
  ADD COLUMN IF NOT EXISTS plan_slug TEXT,
  ADD COLUMN IF NOT EXISTS module_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS addon_slugs TEXT[] NOT NULL DEFAULT '{}',
  -- Modules the negotiation explicitly took OUT. Recorded, not derived: the
  -- effective install set is module_ids minus these, and keeping the
  -- exclusions named is what stops a later reconciliation "helpfully" adding
  -- a module the client bargained away.
  ADD COLUMN IF NOT EXISTS excluded_module_ids UUID[] NOT NULL DEFAULT '{}',
  -- Armed = signature triggers provisioning. Deliberately default FALSE: an
  -- agreement raised before this feature existed must not start provisioning
  -- retroactively when its envelope completes.
  ADD COLUMN IF NOT EXISTS provision_on_signature BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provision_status TEXT NOT NULL DEFAULT 'none'
    CHECK (provision_status IN ('none','armed','provisioning','provisioned','failed')),
  ADD COLUMN IF NOT EXISTS provision_error TEXT,
  ADD COLUMN IF NOT EXISTS provisioned_clone_id UUID REFERENCES public.clones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provision_region TEXT NOT NULL DEFAULT 'ap-southeast-2',
  -- The clone's seed admin. Defaults to the client's own signing address at
  -- arm time; editable before signature.
  ADD COLUMN IF NOT EXISTS admin_email TEXT;

CREATE INDEX IF NOT EXISTS idx_client_agreements_provision_status
  ON public.client_agreements (provision_status);
CREATE INDEX IF NOT EXISTS idx_client_agreements_clone
  ON public.client_agreements (provisioned_clone_id);

-- DocuSign Connect webhook ledger. One row per (envelope, event) delivery —
-- the unique constraint IS the idempotency claim (no read-then-write), the
-- same shape stripe_events uses. The payload is summarised, never stored
-- verbatim: Connect bodies carry recipient PII and, with includeDocuments
-- misconfigured, whole signed PDFs.
CREATE TABLE IF NOT EXISTS public.docusign_connect_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  docusign_status TEXT,
  agreement_id UUID REFERENCES public.client_agreements(id) ON DELETE SET NULL,
  hmac_valid BOOLEAN NOT NULL DEFAULT FALSE,
  decision TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, event_type)
);

GRANT SELECT ON public.docusign_connect_events TO authenticated;
GRANT ALL ON public.docusign_connect_events TO service_role;
ALTER TABLE public.docusign_connect_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "docusign_connect_events operator read" ON public.docusign_connect_events;
CREATE POLICY "docusign_connect_events operator read"
  ON public.docusign_connect_events FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));
-- Writes come only from the webhook route's service-role client; no
-- authenticated write policy on purpose.

CREATE INDEX IF NOT EXISTS idx_docusign_connect_events_envelope
  ON public.docusign_connect_events (envelope_id);
CREATE INDEX IF NOT EXISTS idx_docusign_connect_events_agreement_id
  ON public.docusign_connect_events (agreement_id);
CREATE INDEX IF NOT EXISTS idx_docusign_connect_events_created
  ON public.docusign_connect_events (created_at DESC);

-- Poll fallback: refresh every non-terminal envelope through the same JWT
-- credentials the send path uses, so "signed → provisioned" needs no webhook
-- to function. Every 10 minutes — an envelope signature is a human act; the
-- webhook is the instant path, this is the guarantee.
select cron.unschedule('agreements-refresh')
 where exists (select 1 from cron.job where jobname = 'agreements-refresh');

select cron.schedule('agreements-refresh', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://aurixa-mission-control.lovable.app/hooks/agreements-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'DRIFT_REFRESH_TOKEN' limit 1)
    ),
    body := '{}'::jsonb
  ) as request_id;
$cron$);
