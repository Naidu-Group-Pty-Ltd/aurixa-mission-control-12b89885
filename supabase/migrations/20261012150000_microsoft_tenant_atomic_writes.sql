-- @asserts rpc:microsoft_tenant_add
-- @asserts rpc:microsoft_tenant_update
--
-- Adding a Microsoft tenant, and changing one, each become ONE transaction.
--
-- Until now each was two writes made by the server: the credentials into the
-- Vault (microsoft_tenant_credentials_put) and the row beside them, with the
-- server undoing the first when the second failed. An undo is a guess at what
-- the first write replaced, made from a snapshot taken before it. Two admins
-- saving the same tenant at once could both take that snapshot before either
-- wrote, and one's undo could put back credentials the other had already
-- replaced: the row's hints would describe one secret while the Vault held
-- another. Even with no failure, two edits interleaved — A stores, B stores,
-- B writes the row, A writes the row — paired one admin's row with the other
-- admin's secret.
--
-- These two functions make the pair indivisible:
--
-- * microsoft_tenant_update locks the tenant's row, then writes the new
--   credentials (when there are any) and the row in the caller's single
--   transaction. Both land or neither does. A second edit of the same tenant
--   waits on the lock and then works from the first one's result.
-- * New credentials say which credentials_version they were merged from. If
--   another edit stored credentials since, this one is refused
--   (microsoft_tenant_changed) rather than quietly replacing them with values
--   merged from what the first admin saw: a field left blank "keeps the
--   stored value", and the stored value is no longer the one that was read.
-- * New credentials must arrive with their hints and fingerprint, so the row
--   can never describe a secret other than the one stored.
-- * microsoft_tenant_add inserts the row and stores its credentials in one
--   transaction, so a tenant without credentials never exists, even for the
--   moment between two writes.
--
-- Only the columns an admin's edit may set can be given; anything else is
-- refused, never ignored (microsoft_tenant_patch_invalid). Both functions are
-- executable by the service role only, like the three Vault functions in
-- 20261012120000, and store credentials through microsoft_tenant_credentials_put
-- so there is still one place that writes the Vault.
--
-- microsoft_tenant_credentials_put itself keeps its grant: the application
-- deployed before this migration calls it directly until the deployment that
-- calls these functions replaces it, and nothing in the application calls it
-- after that.

CREATE OR REPLACE FUNCTION public.microsoft_tenant_update(
  p_tenant UUID,
  p_patch JSONB,
  p_credentials TEXT DEFAULT NULL,
  p_expected_version INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_patch JSONB := COALESCE(p_patch, '{}'::JSONB);
  v_row public.microsoft_tenants;
  v_next public.microsoft_tenants;
  v_key TEXT;
  v_version INTEGER;
BEGIN
  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'microsoft_tenant_patch_invalid: the changes are not an object';
  END IF;
  SELECT k INTO v_key
    FROM jsonb_object_keys(v_patch) AS k
   WHERE k <> ALL (ARRAY[
     'label', 'default_mailbox', 'secret_expires_on',
     'directory_hint', 'client_hint', 'secret_hint', 'fingerprint',
     'granted_roles', 'verified_at', 'verify_error'
   ])
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'microsoft_tenant_patch_invalid: % cannot be changed this way', v_key;
  END IF;

  IF p_credentials IS NOT NULL THEN
    IF NOT (v_patch ?& ARRAY['directory_hint', 'client_hint', 'secret_hint', 'fingerprint']) THEN
      RAISE EXCEPTION 'microsoft_tenant_patch_invalid: new credentials need their hints and fingerprint';
    END IF;
    IF p_expected_version IS NULL THEN
      RAISE EXCEPTION 'microsoft_tenant_patch_invalid: new credentials need the version they replace';
    END IF;
  END IF;

  -- The lock every other edit of this tenant waits on until this transaction
  -- ends. microsoft_tenant_credentials_put and microsoft_tenant_remove take
  -- the same row lock.
  SELECT * INTO v_row
    FROM public.microsoft_tenants
   WHERE id = p_tenant AND removed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'microsoft_tenant_not_found';
  END IF;

  IF p_credentials IS NOT NULL THEN
    IF v_row.credentials_version <> p_expected_version THEN
      RAISE EXCEPTION 'microsoft_tenant_changed';
    END IF;
    -- Bumps credentials_version, so no token taken with the old credentials
    -- is used again. Rolled back with everything else if the row below fails.
    PERFORM public.microsoft_tenant_credentials_put(p_tenant, p_credentials);
  END IF;

  -- The row as the patch describes it: given columns replaced, the rest kept.
  -- Only the allowed columns are written back, so what the put above changed
  -- (vault_secret_id, credentials_version) is never overwritten from v_row.
  v_next := jsonb_populate_record(v_row, v_patch);
  UPDATE public.microsoft_tenants
     SET label = v_next.label,
         default_mailbox = v_next.default_mailbox,
         secret_expires_on = v_next.secret_expires_on,
         directory_hint = v_next.directory_hint,
         client_hint = v_next.client_hint,
         secret_hint = v_next.secret_hint,
         fingerprint = v_next.fingerprint,
         granted_roles = v_next.granted_roles,
         verified_at = v_next.verified_at,
         verify_error = v_next.verify_error,
         updated_at = now()
   WHERE id = p_tenant
  RETURNING credentials_version INTO v_version;

  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.microsoft_tenant_add(p_details JSONB, p_credentials TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_details JSONB := COALESCE(p_details, '{}'::JSONB);
  v_new public.microsoft_tenants;
  v_key TEXT;
  v_id UUID;
BEGIN
  IF jsonb_typeof(v_details) <> 'object' THEN
    RAISE EXCEPTION 'microsoft_tenant_patch_invalid: the details are not an object';
  END IF;
  SELECT k INTO v_key
    FROM jsonb_object_keys(v_details) AS k
   WHERE k <> ALL (ARRAY[
     'label', 'default_mailbox', 'secret_expires_on',
     'directory_hint', 'client_hint', 'secret_hint', 'fingerprint',
     'granted_roles', 'verified_at', 'verify_error', 'created_by'
   ])
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'microsoft_tenant_patch_invalid: % cannot be set this way', v_key;
  END IF;
  IF p_credentials IS NULL OR length(p_credentials) = 0 THEN
    RAISE EXCEPTION 'microsoft_tenant_credentials_empty';
  END IF;

  v_new := jsonb_populate_record(NULL::public.microsoft_tenants, v_details);
  INSERT INTO public.microsoft_tenants (
    label, default_mailbox, secret_expires_on,
    directory_hint, client_hint, secret_hint, fingerprint,
    granted_roles, verified_at, verify_error, created_by
  ) VALUES (
    v_new.label, v_new.default_mailbox, v_new.secret_expires_on,
    v_new.directory_hint, v_new.client_hint, v_new.secret_hint, v_new.fingerprint,
    v_new.granted_roles, v_new.verified_at, v_new.verify_error, v_new.created_by
  )
  RETURNING id INTO v_id;

  PERFORM public.microsoft_tenant_credentials_put(v_id, p_credentials);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.microsoft_tenant_update(UUID, JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.microsoft_tenant_add(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_update(UUID, JSONB, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_add(JSONB, TEXT) TO service_role;
