-- @asserts column:clones.contract_excluded_module_slugs
--
-- Contractual module exclusions.
--
-- A signed agreement can EXCLUDE modules the tier would normally include —
-- "second tier flow, some module excluded from what the final deployment
-- should be". The agreement records that negotiation
-- (client_agreements.excluded_module_ids), but nothing carried it onto the
-- clone: the entitlement reconciler resolves a plan's full module set and
-- diffs against what is installed, so the first plan-change reconcile after
-- provisioning would quietly re-install and re-entitle exactly what the
-- client bargained away.
--
-- This column is the durable form of that negotiation on the clone itself.
-- `reconcileCloneEntitlements` subtracts it from every resolution — initial,
-- upgrade, downgrade, manual — so an exclusion holds for the life of the
-- clone unless an operator clears it here. It is deliberately separate from
-- `revoked_module_slugs`, which the reconciler COMPUTES (entitled-set drift);
-- this one is an INPUT a person recorded.

ALTER TABLE public.clones
  ADD COLUMN IF NOT EXISTS contract_excluded_module_slugs TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.clones.contract_excluded_module_slugs IS
  'Module slugs contractually excluded for this clone (from the signed agreement). Subtracted from every entitlement resolution; never re-installed by plan changes.';
