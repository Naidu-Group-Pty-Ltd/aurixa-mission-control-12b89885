-- @asserts check:client_agreements.document_kind=builder_partner
-- @asserts column:client_agreements.builder_organisation_id
-- @asserts column:client_agreements.template_id
-- @asserts column:client_agreements.grant_access_on_signature
-- @asserts column:client_agreements.portal_access_status
-- @asserts column:client_agreements.portal_access_granted_at
-- @asserts check:client_agreements.portal_access_status=granted
-- @asserts table:builder_partner_agreement_templates
-- @asserts rpc:activate_builder_partner_agreement_template
--
-- Builder Partner Agreements — the agreement a builder signs before the
-- Builder Portal opens to them.
--
-- A builder reaches the Builder Portal through a pipeline that runs without a
-- person in it: the Aurixa website's builder waitlist posts to Mission
-- Control's /api/public/builders/apply, which hands the application to the
-- Builders Network's `submit_access_request`; that creates the organisation in
-- `pending_activation` and emails its owner an invitation. None of that is
-- touched here. What the pipeline deliberately does NOT do is grant access:
-- `approve_organisation` is still the only route from pending to `active`, and
-- it is an operator's decision (see builderAccessRequest.pure.ts on the
-- network). The agreement slots in exactly there — between the paperwork the
-- automation reaches and the vetting it never does:
--
--   application → organisation (pending) + owner invite   [unchanged]
--     → Builder Partner Agreement sent, signed, retained   [this]
--     → approve_organisation → Builder Portal access        [gated by this]
--
-- It is the same document engine as the Service Level Agreement and the
-- Subscription Agreement — one `client_agreements` row, the same DocuSign
-- lifecycle, refresh cron, Connect webhook and retention bucket — told apart
-- by `document_kind = 'builder_partner'`. What it adds:
--
--   * `builder_organisation_id` — the Builders Network organisation the
--     agreement admits. Not a foreign key: the organisation lives in the
--     network's database, and MC reaches it only through the federated admin
--     plane.
--
--   * `template_id` — the Builder Partner Agreement terms in force when it was
--     issued. The terms are supplied later and PLUGGED IN by an admin (see the
--     registry below); nothing here invents them.
--
--   * `grant_access_on_signature` and the `portal_access_*` columns — an admin
--     may arm an agreement so that the moment it is signed (and the signed copy
--     retained) Mission Control approves the organisation on the network itself.
--     The decision to admit is taken, by an admin, when arming; the signature is
--     the condition it waits on. `portal_access_status` records what happened.
--
-- The existing columns carry the rest, so the freeze and keep triggers need
-- only widening: `offer` holds the partner's particulars (schema-validated in
-- src/lib/agreements/builderPartner.pure.ts), `offer_reference` the agreement
-- reference (AUR-BPA-…), `issued_snapshot` what was issued (the terms' digest,
-- the particulars, and the generated Execution Schedule itself), and the
-- `signed_record_*` columns the retained signed copy.
--
-- Three rules carry it.
--
--   * AN ISSUED AGREEMENT IS A RECORD. Once an envelope exists the particulars,
--     reference, terms and organisation cannot change — widening the freeze
--     trigger the Subscription Agreement already has — and a signed or sent one
--     is never deleted.
--
--   * ONLY AN ADMIN ADMITS A BUILDER. Approving an organisation is admin-only on
--     /builders-network, and an armed agreement approves one. `client_agreements`
--     is writable by any operator session under its RLS policy, so a guard
--     trigger refuses a Builder Partner Agreement insert, update or delete made
--     from a signed-in session that is not an admin's. The service role — which
--     every server function uses, each checking the caller's role first — and
--     direct SQL are unaffected.
--
--   * THE TERMS ARE A FILE, AND A FILE IS IMMUTABLE. The registry holds each
--     uploaded terms document by digest in a private bucket. One is in force at
--     a time; a file's identity never changes; what a schedule prints about the
--     terms (name, version, countersignature, execution statement) freezes the
--     moment the terms are first put in force — correcting it is a new
--     registration of the same file — and terms any agreement was issued under
--     can never be deleted.

ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_document_kind_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_document_kind_check
  CHECK (document_kind IN ('sla', 'subscription', 'builder_partner'));

COMMENT ON COLUMN public.client_agreements.document_kind IS
  'sla = the fixed Service Level Agreement PDF; subscription = a completed Launch/Growth/Scale Subscription Agreement offer; builder_partner = the Builder Partner Agreement a builder signs before Builder Portal access.';

/* ───────────────────────────── the terms registry ───────────────────────────── */

CREATE TABLE IF NOT EXISTS public.builder_partner_agreement_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
    CONSTRAINT builder_partner_agreement_templates_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  version_label TEXT NOT NULL
    CONSTRAINT builder_partner_agreement_templates_version_check
    CHECK (length(btrim(version_label)) BETWEEN 1 AND 60),
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL
    CONSTRAINT builder_partner_agreement_templates_media_type_check
    CHECK (media_type IN (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )),
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL
    CONSTRAINT builder_partner_agreement_templates_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size INTEGER NOT NULL
    CONSTRAINT builder_partner_agreement_templates_byte_size_check
    CHECK (byte_size > 0),
  page_count INTEGER
    CONSTRAINT builder_partner_agreement_templates_page_count_check
    CHECK (page_count IS NULL OR page_count > 0),
  countersignature_required BOOLEAN NOT NULL DEFAULT false,
  execution_statement TEXT NOT NULL
    CONSTRAINT builder_partner_agreement_templates_execution_statement_check
    CHECK (length(btrim(execution_statement)) BETWEEN 20 AND 1200),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'staged'
    CONSTRAINT builder_partner_agreement_templates_status_check
    CHECK (status IN ('staged', 'active', 'retired')),
  activated_at TIMESTAMPTZ,
  activated_by UUID,
  retired_at TIMESTAMPTZ,
  retired_by UUID,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One set of terms in force at a time. The index is the rule; the activation
-- function below is only the convenient way to move it.
CREATE UNIQUE INDEX IF NOT EXISTS builder_partner_agreement_templates_one_active
  ON public.builder_partner_agreement_templates (status)
  WHERE status = 'active';

-- A file is its digest, and its object in the bucket is shared by every row
-- that registers it. The same file may be registered again — its name,
-- version, countersignature and execution statement freeze the moment it is
-- first put in force, so correcting any of them is a new registration of the
-- same bytes — but only one registration of a file waits to be put in force
-- at a time, so there is never a choice between two drafts of one document.
CREATE UNIQUE INDEX IF NOT EXISTS builder_partner_agreement_templates_one_staged_per_file
  ON public.builder_partner_agreement_templates (sha256)
  WHERE status = 'staged';

COMMENT ON TABLE public.builder_partner_agreement_templates IS
  'Builder Partner Agreement terms, uploaded by an admin and held by digest in the private agreement-templates bucket. At most one is active; the active one is what a Builder Partner Agreement is issued under and what gates Builder Portal access.';
COMMENT ON COLUMN public.builder_partner_agreement_templates.execution_statement IS
  'The sentence the generated Execution Schedule prints above the signature blocks. Frozen once the terms are first put in force.';
COMMENT ON COLUMN public.builder_partner_agreement_templates.countersignature_required IS
  'When true, Aurixa''s configured countersigner signs after the builder; when false Aurixa receives a copy.';

GRANT SELECT ON public.builder_partner_agreement_templates TO authenticated;
GRANT ALL ON public.builder_partner_agreement_templates TO service_role;
ALTER TABLE public.builder_partner_agreement_templates ENABLE ROW LEVEL SECURITY;

-- Operators see which terms are in force (the agreement pages and the Builders
-- Network console say so); nobody writes the registry from a browser. Every
-- write goes through an admin-gated server function on the service role, which
-- checks the uploaded file before a row exists.
DROP POLICY IF EXISTS "builder_partner_agreement_templates operator read"
  ON public.builder_partner_agreement_templates;
CREATE POLICY "builder_partner_agreement_templates operator read"
  ON public.builder_partner_agreement_templates FOR SELECT
  TO authenticated
  USING (public.is_operator(auth.uid()) OR public.is_admin(auth.uid()));

DROP TRIGGER IF EXISTS set_updated_at_builder_partner_agreement_templates
  ON public.builder_partner_agreement_templates;
CREATE TRIGGER set_updated_at_builder_partner_agreement_templates
  BEFORE UPDATE ON public.builder_partner_agreement_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.builder_partner_templates_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'staged' THEN
      RAISE EXCEPTION
        'Builder Partner Agreement terms "%" (%) have been in force and are kept as a record; retire them instead.',
        OLD.name, OLD.version_label
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- The file is the terms. Its identity never changes.
  IF NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.page_count IS DISTINCT FROM OLD.page_count THEN
    RAISE EXCEPTION
      'The uploaded terms file % cannot change; upload a new version instead.', OLD.sha256
      USING ERRCODE = 'check_violation';
  END IF;

  -- Terms that have been in force have been printed on schedules and sent.
  IF OLD.status <> 'staged' AND (
       NEW.name IS DISTINCT FROM OLD.name
    OR NEW.version_label IS DISTINCT FROM OLD.version_label
    OR NEW.countersignature_required IS DISTINCT FROM OLD.countersignature_required
    OR NEW.execution_statement IS DISTINCT FROM OLD.execution_statement
  ) THEN
    RAISE EXCEPTION
      'Builder Partner Agreement terms "%" (%) have been in force; their name, version, countersignature and execution statement are a record.',
      OLD.name, OLD.version_label
      USING ERRCODE = 'check_violation';
  END IF;

  -- Staged is where terms start, never where they return to.
  IF OLD.status <> 'staged' AND NEW.status = 'staged' THEN
    RAISE EXCEPTION 'Terms that have been in force cannot return to staged.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- And retired is where they end. Putting old terms back in force is a new
  -- registration of the same file, so the record of when a set stopped
  -- binding new builders is never rewritten.
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION
      'Builder Partner Agreement terms "%" (%) were retired and are not put back in force; register the file again instead.',
      OLD.name, OLD.version_label
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS builder_partner_templates_freeze
  ON public.builder_partner_agreement_templates;
CREATE TRIGGER builder_partner_templates_freeze
  BEFORE UPDATE OR DELETE ON public.builder_partner_agreement_templates
  FOR EACH ROW EXECUTE FUNCTION public.builder_partner_templates_freeze();

-- Put one set of terms in force, retiring whatever was. Serialised, so two
-- admins activating at once cannot both believe they won. Terms already in
-- force are returned as they are (their activation is not re-stamped), and
-- retired terms are refused here as well as by the freeze trigger.
CREATE OR REPLACE FUNCTION public.activate_builder_partner_agreement_template(
  p_template_id UUID,
  p_actor UUID
)
RETURNS public.builder_partner_agreement_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.builder_partner_agreement_templates;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('builder_partner_agreement_templates.activate'));
  SELECT * INTO v_row
    FROM public.builder_partner_agreement_templates
   WHERE id = p_template_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status = 'active' THEN
    RETURN v_row;
  END IF;
  IF v_row.status = 'retired' THEN
    RAISE EXCEPTION 'Retired terms are not put back in force; register the file again instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.builder_partner_agreement_templates
     SET status = 'retired', retired_at = now(), retired_by = p_actor
   WHERE status = 'active' AND id <> p_template_id;

  UPDATE public.builder_partner_agreement_templates
     SET status = 'active',
         activated_at = now(),
         activated_by = p_actor,
         retired_at = NULL,
         retired_by = NULL
   WHERE id = p_template_id
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.activate_builder_partner_agreement_template(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_builder_partner_agreement_template(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_builder_partner_agreement_template(UUID, UUID) TO service_role;

/* ───────────────────────────── the agreement row ───────────────────────────── */

ALTER TABLE public.client_agreements
  ADD COLUMN IF NOT EXISTS builder_organisation_id UUID,
  ADD COLUMN IF NOT EXISTS template_id UUID
    REFERENCES public.builder_partner_agreement_templates(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS grant_access_on_signature BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS portal_access_status TEXT
    CONSTRAINT client_agreements_portal_access_status_check
    CHECK (portal_access_status IS NULL
           OR portal_access_status IN ('pending', 'granted', 'failed', 'refused')),
  ADD COLUMN IF NOT EXISTS portal_access_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_access_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_access_detail TEXT;

-- A Builder Partner Agreement names the organisation it admits, the
-- particulars it was drawn on and its own reference; nothing else is one.
ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_builder_partner_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_builder_partner_check
  CHECK (
    document_kind <> 'builder_partner'
    OR (builder_organisation_id IS NOT NULL AND offer IS NOT NULL AND offer_reference IS NOT NULL)
  );

-- Access is granted to builders, not to clients: the columns mean nothing on
-- any other kind of agreement, and an armed SLA would be a lie on the page.
ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_portal_access_kind_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_portal_access_kind_check
  CHECK (
    document_kind = 'builder_partner'
    OR (grant_access_on_signature = false AND portal_access_status IS NULL)
  );

-- And the reverse: a builder is admitted, never provisioned. A signed Builder
-- Partner Agreement opens the Builder Portal on the network; it must never be
-- armed to create a clone, which is what `provision_on_signature` does for a
-- client's agreement — a repository, a dedicated backend and a deployment.
ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_builder_partner_no_clone_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_builder_partner_no_clone_check
  CHECK (
    document_kind <> 'builder_partner'
    OR (provision_on_signature = false AND provision_status = 'none')
  );

-- One agreement in flight per organisation. A signed one does not block the
-- next (re-papering a partner onto new terms is a new agreement); a declined or
-- voided one is finished.
CREATE UNIQUE INDEX IF NOT EXISTS client_agreements_one_open_builder_partner
  ON public.client_agreements (builder_organisation_id)
  WHERE document_kind = 'builder_partner' AND status IN ('draft', 'sent', 'delivered');
CREATE INDEX IF NOT EXISTS idx_client_agreements_builder_organisation
  ON public.client_agreements (builder_organisation_id);
CREATE INDEX IF NOT EXISTS idx_client_agreements_template
  ON public.client_agreements (template_id);

COMMENT ON COLUMN public.client_agreements.builder_organisation_id IS
  'Builder Partner Agreements only: the Builders Network organisation the agreement admits (the network''s own id; not a local foreign key).';
COMMENT ON COLUMN public.client_agreements.template_id IS
  'Builder Partner Agreements only: the registered terms the agreement was issued under. Frozen once an envelope exists.';
COMMENT ON COLUMN public.client_agreements.grant_access_on_signature IS
  'Builder Partner Agreements only: when true, the signed and retained agreement approves the organisation on the Builders Network automatically. Armed by an admin.';
COMMENT ON COLUMN public.client_agreements.portal_access_status IS
  'Builder Partner Agreements only: pending (an attempt is running), granted, failed (retried by the agreements sweep) or refused (needs a person).';

/* ───────────────────────────── the record rules ───────────────────────────── */

CREATE OR REPLACE FUNCTION public.client_agreements_freeze_issued_offer()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.docusign_envelope_id IS NOT NULL AND (
       NEW.document_kind           IS DISTINCT FROM OLD.document_kind
    OR NEW.offer                   IS DISTINCT FROM OLD.offer
    OR NEW.offer_reference         IS DISTINCT FROM OLD.offer_reference
    OR NEW.issued_at               IS DISTINCT FROM OLD.issued_at
    OR NEW.issued_snapshot         IS DISTINCT FROM OLD.issued_snapshot
    OR NEW.template_id             IS DISTINCT FROM OLD.template_id
    OR NEW.builder_organisation_id IS DISTINCT FROM OLD.builder_organisation_id
  ) THEN
    RAISE EXCEPTION
      'The agreement sent in DocuSign envelope % is a record and cannot change; raise a new one instead.',
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

CREATE OR REPLACE FUNCTION public.client_agreements_keep_issued_offer()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.document_kind IN ('subscription', 'builder_partner')
     AND (OLD.docusign_envelope_id IS NOT NULL OR OLD.signed_record_path IS NOT NULL) THEN
    RAISE EXCEPTION
      '% % was issued and is kept as a record; void it instead of deleting it.',
      CASE OLD.document_kind
        WHEN 'subscription' THEN 'Subscription Agreement offer'
        ELSE 'Builder Partner Agreement'
      END,
      OLD.offer_reference
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

-- The triggers themselves already exist (20260925100000); CREATE OR REPLACE
-- above changed their bodies in place. Re-created here so a replay of this
-- file alone still leaves them attached.
DROP TRIGGER IF EXISTS client_agreements_freeze_issued_offer ON public.client_agreements;
CREATE TRIGGER client_agreements_freeze_issued_offer
  BEFORE UPDATE ON public.client_agreements
  FOR EACH ROW EXECUTE FUNCTION public.client_agreements_freeze_issued_offer();

DROP TRIGGER IF EXISTS client_agreements_keep_issued_offer ON public.client_agreements;
CREATE TRIGGER client_agreements_keep_issued_offer
  BEFORE DELETE ON public.client_agreements
  FOR EACH ROW EXECUTE FUNCTION public.client_agreements_keep_issued_offer();

-- Only an admin admits a builder. `auth.uid()` is set only for a signed-in
-- session; the service role and direct SQL carry none, so server functions
-- (which check the caller's role themselves) and maintenance are unaffected.
CREATE OR REPLACE FUNCTION public.client_agreements_builder_partner_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin(auth.uid()) AND (
       (TG_OP IN ('UPDATE', 'DELETE') AND OLD.document_kind = 'builder_partner')
    OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.document_kind = 'builder_partner')
  ) THEN
    RAISE EXCEPTION
      'Builder Partner Agreements admit a builder to the Builder Portal and are managed by an admin.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS client_agreements_builder_partner_admin_only ON public.client_agreements;
CREATE TRIGGER client_agreements_builder_partner_admin_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.client_agreements
  FOR EACH ROW EXECUTE FUNCTION public.client_agreements_builder_partner_admin_only();

/* ───────────────────────────── the terms bucket ───────────────────────────── */

-- The uploaded terms. Private, and written only by the service role (the
-- admin-gated install path in src/server/builder-partner-agreements.server.ts):
-- no authenticated policy exists on purpose, so no browser session can list,
-- read, replace or delete the terms a builder signs. Operators and admins
-- download through server functions that check the recorded digest first.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'agreement-templates',
  'agreement-templates',
  false,
  15728640,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
