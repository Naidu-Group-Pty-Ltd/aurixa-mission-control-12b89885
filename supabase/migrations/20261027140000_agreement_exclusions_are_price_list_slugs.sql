-- @asserts column:client_agreements.excluded_module_slugs
--
-- A contract's module exclusions are price-list slugs, and they reach the
-- clone (docs/DELIVERY_SYSTEM_PLAN.md, D18).
--
-- Measured 27 Oct 2026, before this migration:
--
--   * `client_agreements.excluded_module_ids` (uuid[]) holds LIBRARY module
--     ids: rows of `modules`, the code detection found in the prime (`aml`,
--     `commercial`, `backend-aml`; 135 of them). Those name code, not what was
--     sold, and a library reset loses them without a word.
--   * The clone's copy, `clones.contract_excluded_module_slugs`, was written
--     only after `provisionCloneCore` returned. The reconcile inside it had
--     already installed the excluded modules by then, so the second reconcile
--     could only record them as revoked.
--   * Nothing told the clone. A clone gates on its balance response (the plan
--     slug and the add-on slugs), and that response carried no exclusions.
--   * There is nothing to translate. No agreement and no clone holds an
--     exclusion (2 agreements, 4 clones).
--
-- A contract exclusion is now a price-list module slug: `MODULES[].slug` in
-- `src/lib/pricing/aurixa-catalog.ts`, such as `aml-ctf`, `finance-portal` or
-- `market-updates`. A contract is negotiated in that vocabulary, and the prime
-- gates on it. The agreement records them in the new column. `provisionCloneCore`
-- writes them onto the clone in the clone's own INSERT. Every reconcile
-- subtracts them, and `/api/public/tokens/balance` sends them to the clone as
-- `entitlements.excluded`.
--
-- `excluded_module_ids` stays. Nothing reads it, and a save writes it empty.
-- Dropping a column a deployed build still selects is a 42703, so it can go in
-- a later migration, once no deployment names it.
--
-- Additive. Every existing row reads `{}`, which is what every row holds today.

ALTER TABLE public.client_agreements
  ADD COLUMN IF NOT EXISTS excluded_module_slugs text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.client_agreements.excluded_module_slugs IS
  'Price-list module slugs (MODULES[].slug in src/lib/pricing/aurixa-catalog.ts) the negotiation took out of this agreement. Checked against the price list on save. Written onto clones.contract_excluded_module_slugs in the clone''s INSERT when the agreement provisions. Supersedes excluded_module_ids.';

COMMENT ON COLUMN public.client_agreements.excluded_module_ids IS
  'Superseded by excluded_module_slugs (20261027140000). Held library module ids (rows of modules). Nothing reads it any more, and a save writes it empty.';

COMMENT ON COLUMN public.clones.contract_excluded_module_slugs IS
  'Price-list module slugs (MODULES[].slug in src/lib/pricing/aurixa-catalog.ts) this clone''s signed agreement excluded. Written in the clone''s INSERT by provisionCloneCore. Subtracted from every entitlement reconcile, and sent to the clone as entitlements.excluded by /api/public/tokens/balance. Held library module slugs until 20261027140000; no clone held one, so nothing was translated.';
