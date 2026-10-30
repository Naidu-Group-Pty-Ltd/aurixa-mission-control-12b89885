-- @asserts column:live_audit_settings.audit_account
--
-- The live audit's staff account, named here by its username.
--
-- The audit's session is minted on Prime for one account, and until now only
-- for the one a GitHub admin put in Prime's repository variable
-- LIVE_AUDIT_USER_ID, by a custom_users id nobody sees in the application.
-- The owner creates the account in Prime's User Management (an admin with
-- the Read Only preset); this is where it is named. The run's settings carry
-- it as `audit_account`, and Prime's `session` job (workflow version 2)
-- resolves it there. Prime's repository variable still wins when it is set.
--
-- Naming an account is not trusting it: the mint reads the account first and
-- refuses one that is deleted, deactivated, a superadmin, or able to edit or
-- delete in any module, so naming a colleague's working account mints
-- nothing. Empty: runs see Prime's signed-out pages only, and say so.
ALTER TABLE public.live_audit_settings
  ADD COLUMN IF NOT EXISTS audit_account TEXT;

ALTER TABLE public.live_audit_settings
  DROP CONSTRAINT IF EXISTS live_audit_settings_audit_account_shape;
ALTER TABLE public.live_audit_settings
  ADD CONSTRAINT live_audit_settings_audit_account_shape
  CHECK (audit_account IS NULL OR audit_account ~ '^[A-Za-z0-9._@+-]{2,80}$');

COMMENT ON COLUMN public.live_audit_settings.audit_account IS
  'The Prime username the live audit signs in as: an admin with the Read Only preset. Resolved on Prime at each run; Prime refuses an account that can edit or delete anything.';
