-- @asserts column:client_agreements.document_kind
-- @asserts column:client_agreements.lead_id
-- @asserts column:client_agreements.offer
-- @asserts column:client_agreements.offer_reference
-- @asserts column:client_agreements.issued_at
-- @asserts column:client_agreements.issued_snapshot
-- @asserts column:client_agreements.signed_record_path
-- @asserts check:client_agreements.document_kind=subscription
-- @asserts table:agreement_issuing_profile
-- @asserts enum:notification_kind
--
-- Subscription Agreements — the approved Launch, Growth and Scale offers.
--
-- /agreements has raised one document until now: the Service Level Agreement,
-- a fixed PDF with a handful of prefilled tabs. The Subscription Agreement is
-- a different kind of document. It IS the offer: fifty fields of Word content
-- controls (customer, package, price, dates, Schedule A4 records, Schedule E5
-- disclosures) that Mission Control completes from a recorded offer and sends
-- through the same DocuSign flow, lifecycle, refresh cron, Connect webhook and
-- provision-on-signature pipeline the SLA already uses. So it lives on the
-- same row, told apart by `document_kind`, rather than in a parallel table
-- with a parallel lifecycle.
--
-- Three rules carry it.
--
--   * The offer is the source of truth until it is sent, and a record after.
--     `offer` is the operator's working copy (schema-validated in
--     src/lib/agreements/subscriptionOffer.pure.ts, never free-form here);
--     `issued_snapshot` is what was actually issued — the composed field text,
--     totals, dates, rate card, template id and digest, and the SHA-256 of the
--     exact .docx DocuSign received. The template says "We retain the accepted
--     document and commercial snapshot before activating the purchase"; the
--     snapshot is that commercial snapshot, written before the envelope is.
--
--   * An issued offer never changes. The trigger below refuses any change to
--     the offer, its reference or its snapshot once an envelope exists. A
--     correction is a NEW offer under a new reference, which is also what the
--     agreement's own clause 1.2 requires ("an uncompleted template is not an
--     offer"; acceptance identifies "the complete offer").
--
--   * The accepted document is retained BEFORE the purchase activates. The
--     same clause goes on: "We retain the accepted document and commercial
--     snapshot before activating the purchase; missing acceptance evidence
--     cannot be replaced by recording an assumed earlier signature." So when
--     DocuSign reports a subscription envelope completed, the combined signed
--     PDF — with DocuSign's certificate of completion — is copied into the
--     private `agreement-records` bucket and its digest recorded here, and
--     provision-on-signature refuses a subscription agreement whose signed
--     record has not been retained. DocuSign's own copy lives under the
--     account's retention settings; this one lives under ours.
--
-- A lead is not yet a client. An agreement can be raised for a
-- `waitlist_leads` row that was never converted, so `lead_id` links the two
-- directly; contact and account stay optional exactly as before.
--
-- `agreement_attention` is the one new notification: an envelope DocuSign
-- accepted that could not be recorded, or a signed agreement whose record
-- could not be retained. Both need a person, and neither fits the existing
-- signed/declined/provisioned kinds, which describe outcomes rather than
-- faults.
--
-- The issuing profile is Aurixa's standing facts — Schedule E5's service
-- profile, hosting and processing disclosures, the legal, support and privacy
-- contacts, the correction route, the default payment method and the A4
-- usage-authority wording. One row, maintained by an admin, copied into each
-- new offer so every issued offer carries its own facts rather than pointing
-- at a profile that may have moved since.

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'agreement_attention';

ALTER TABLE public.client_agreements
  ADD COLUMN IF NOT EXISTS document_kind TEXT NOT NULL DEFAULT 'sla'
    CONSTRAINT client_agreements_document_kind_check
    CHECK (document_kind IN ('sla', 'subscription')),
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES public.waitlist_leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer JSONB,
  ADD COLUMN IF NOT EXISTS offer_reference TEXT,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issued_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS signed_record_path TEXT,
  ADD COLUMN IF NOT EXISTS signed_record_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS signed_record_retained_at TIMESTAMPTZ;

-- A subscription agreement without its offer, or without the reference that
-- the document prints beside the signature, is not a subscription agreement.
ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_subscription_offer_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_subscription_offer_check
  CHECK (document_kind <> 'subscription' OR (offer IS NOT NULL AND offer_reference IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS client_agreements_offer_reference_key
  ON public.client_agreements (offer_reference)
  WHERE offer_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_agreements_lead
  ON public.client_agreements (lead_id);
CREATE INDEX IF NOT EXISTS idx_client_agreements_document_kind
  ON public.client_agreements (document_kind);

COMMENT ON COLUMN public.client_agreements.document_kind IS
  'sla = the fixed Service Level Agreement PDF; subscription = a completed Launch/Growth/Scale Subscription Agreement offer.';
COMMENT ON COLUMN public.client_agreements.offer IS
  'The operator''s working Subscription Agreement offer (schema 1). Frozen once an envelope exists.';
COMMENT ON COLUMN public.client_agreements.signed_record_path IS
  'Object path in the private agreement-records bucket of the retained signed PDF (with DocuSign''s certificate of completion).';
COMMENT ON COLUMN public.client_agreements.issued_snapshot IS
  'What was issued: composed field text, totals, dates, rate card, template id/digest and the SHA-256 of the .docx sent to DocuSign.';

CREATE OR REPLACE FUNCTION public.client_agreements_freeze_issued_offer()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.docusign_envelope_id IS NOT NULL AND (
       NEW.document_kind   IS DISTINCT FROM OLD.document_kind
    OR NEW.offer           IS DISTINCT FROM OLD.offer
    OR NEW.offer_reference IS DISTINCT FROM OLD.offer_reference
    OR NEW.issued_at       IS DISTINCT FROM OLD.issued_at
    OR NEW.issued_snapshot IS DISTINCT FROM OLD.issued_snapshot
  ) THEN
    RAISE EXCEPTION
      'The offer sent in DocuSign envelope % is a record and cannot change; raise a new offer instead.',
      OLD.docusign_envelope_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- A retained signed record is evidence; it is written once.
  IF OLD.signed_record_path IS NOT NULL AND (
       NEW.signed_record_path   IS DISTINCT FROM OLD.signed_record_path
    OR NEW.signed_record_sha256 IS DISTINCT FROM OLD.signed_record_sha256
  ) THEN
    RAISE EXCEPTION
      'The retained signed record % cannot be replaced.', OLD.signed_record_path
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS client_agreements_freeze_issued_offer ON public.client_agreements;
CREATE TRIGGER client_agreements_freeze_issued_offer
  BEFORE UPDATE ON public.client_agreements
  FOR EACH ROW EXECUTE FUNCTION public.client_agreements_freeze_issued_offer();

-- And an issued offer is not deleted. /agreements only ever deletes drafts,
-- but a draft is a status, and the evidence rule should not rest on every
-- future caller remembering to filter by it.
CREATE OR REPLACE FUNCTION public.client_agreements_keep_issued_offer()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.document_kind = 'subscription'
     AND (OLD.docusign_envelope_id IS NOT NULL OR OLD.signed_record_path IS NOT NULL) THEN
    RAISE EXCEPTION
      'Subscription Agreement offer % was issued and is kept as a record; void it instead of deleting it.',
      OLD.offer_reference
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS client_agreements_keep_issued_offer ON public.client_agreements;
CREATE TRIGGER client_agreements_keep_issued_offer
  BEFORE DELETE ON public.client_agreements
  FOR EACH ROW EXECUTE FUNCTION public.client_agreements_keep_issued_offer();

CREATE TABLE IF NOT EXISTS public.agreement_issuing_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one row: the unique constraint admits one TRUE, the check admits
  -- nothing else.
  singleton BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agreement_issuing_profile IS
  'Aurixa''s standing Subscription Agreement facts (Schedule E5 disclosures, contacts, correction route, default payment method, A4 usage wording). Copied into each new offer.';

GRANT SELECT, INSERT, UPDATE ON public.agreement_issuing_profile TO authenticated;
GRANT ALL ON public.agreement_issuing_profile TO service_role;
ALTER TABLE public.agreement_issuing_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agreement_issuing_profile operator read" ON public.agreement_issuing_profile;
CREATE POLICY "agreement_issuing_profile operator read"
  ON public.agreement_issuing_profile FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

-- The profile is printed into every offer Aurixa issues, so only an admin may
-- change it.
DROP POLICY IF EXISTS "agreement_issuing_profile admin write" ON public.agreement_issuing_profile;
CREATE POLICY "agreement_issuing_profile admin write"
  ON public.agreement_issuing_profile FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS set_updated_at_agreement_issuing_profile ON public.agreement_issuing_profile;
CREATE TRIGGER set_updated_at_agreement_issuing_profile
  BEFORE UPDATE ON public.agreement_issuing_profile
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The retained signed records. Private, and written only by the service role
-- (the signed-status path in src/server/subscription-agreements.server.ts):
-- no authenticated policy exists on purpose, so no browser session can list,
-- read, replace or delete an executed agreement. Operators download through a
-- server function that checks the recorded digest first.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('agreement-records', 'agreement-records', false, 52428800, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
