-- Aurixa Systems Pricing Model 2026 Final Review — the catalogue rows.
--
-- @asserts rows:addon_modules>=25
-- @asserts check:pricing_module_map.mapping_kind=external
--
-- Source: "Aurixa_Systems_Pricing_Model_2026_Final_Review_-__Set_in_stone.xlsx",
-- sheets TIER PRICING, AML STRUCTURE, MODULE CATALOGUE and DECISIONS. Every
-- figure is TAX-INCLUSIVE — the amount a customer pays, with GST derived from
-- it (÷11) and never added to it.
--
-- ── What this migration deliberately does NOT do ─────────────────────────────
--
-- It does not move a single price on a row that is already linked to Stripe,
-- and that is the whole reason it is this short.
--
-- `seat_plans.price_cents` and `addon_modules.price_min_cents` are what the
-- pricing page SHOWS. `seat_plans.stripe_price_id` and
-- `addon_modules.stripe_price_id` are what Stripe actually CHARGES. Writing the
-- first without the second is the defect 20260728235000 named in as many words
-- — "advertise $504 and bill $749" — and this reprice is exactly the shape that
-- produces it, because a Stripe price is immutable: the new amounts are new
-- price ids, so every linked row's id has to move in the same breath as its
-- figure.
--
-- Both syncs already do that atomically, from `lib/pricing/aurixa-catalog.ts`,
-- which this change has already updated:
--
--   • stripe-catalog-sync.server.ts  → seat_plans (price_cents, stripe_price_id,
--     metadata.annual_stripe_price_id, the base/annual figures) in one update.
--   • stripe-module-sync.server.ts   → addon_modules (name, category,
--     price_min_cents, price_max_cents, stripe_product_id, stripe_price_id) in
--     one update.
--
-- So the tier and module REPRICE is an Apply on the Pricing page, not a line in
-- this file. Duplicating it here would put a second implementation of the
-- cutover in the tree and give the two somewhere to disagree.
--
-- What is left is the three things neither sync can do:
--
--   1. INSERT. `planModuleSync` updates by slug and never invents a row — its
--      own test pins that ("refuses to invent catalog rows the migration never
--      created"). The 2026 model adds two modules, so without this file
--      `solicitor-portal` never acquires a Stripe link and never reaches the
--      pricing page at all.
--   2. `included_in_plans` and `sort_order`. The module sync writes neither.
--   3. The `mapping_kind` CHECK, which now has to admit `external`.
--
-- New rows are inserted with NO Stripe link, which is the honest state: the
-- audit block at the foot of 20260728235000 already warns about exactly that,
-- and the next Apply fills it in. A null id cannot mischarge anybody; a
-- populated one that points at an archived price can.

-- ─── 1. The two modules the 2026 model adds ─────────────────────────────────
--
-- M21 Solicitor Portal ($299) is an ordinary purchasable add-on.
--
-- M23 Builder / Developer Portal ($699) is priced and real and is NOT sold
-- through a checkout — the workbook marks it "Direct sale" on all three tiers
-- and D05 leaves the purchaser and scope open. It is recorded here because a
-- customer is quoted it and an operator has to see it; the module sync
-- withholds it from Stripe on the catalogue's `directSale` flag, and a null
-- `stripe_price_id` on this row is therefore its permanent, correct state
-- rather than a link waiting to be made.

INSERT INTO public.addon_modules
  (slug, name, description, price_min_cents, price_max_cents, currency, billing_period,
   category, included_in_plans, is_active, sort_order, metadata)
VALUES
  ('solicitor-portal', 'Solicitor Portal',
   'Partner / compliance hand-off portal. Purchaser and portal scope: D05.',
   29900, 29900, 'AUD', 'monthly', 'Administration', ARRAY[]::text[], true, 225,
   '{"tax_inclusive": true, "gst_included": true}'::jsonb),
  ('builder-developer-portal', 'Builder / Developer Portal',
   'Sold directly rather than through a checkout. Purchaser and portal scope: D05.',
   69900, 69900, 'AUD', 'monthly', 'Administration', ARRAY[]::text[], true, 226,
   '{"tax_inclusive": true, "gst_included": true, "direct_sale": true}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name              = EXCLUDED.name,
  description       = EXCLUDED.description,
  currency          = EXCLUDED.currency,
  billing_period    = EXCLUDED.billing_period,
  category          = EXCLUDED.category,
  included_in_plans = EXCLUDED.included_in_plans,
  is_active         = true,
  sort_order        = EXCLUDED.sort_order,
  metadata          = public.addon_modules.metadata || EXCLUDED.metadata;
-- price_min_cents / price_max_cents are deliberately absent from the DO UPDATE
-- list: on a re-run this row may already be linked to a Stripe price, and the
-- rule at the top of this file is that a displayed figure never moves without
-- the id beside it. On first insert the VALUES supply them; after that the
-- module sync owns them.

-- ─── 2. Tier inclusions, and the one contradiction they carry ───────────────
--
-- `included_in_plans` is display data — which tiers already bundle the module,
-- so the page can say "included" instead of offering to sell it again. It is
-- read straight from MODULE CATALOGUE's Launch / Growth / Scale columns.
--
-- One row is not a transcription. **Market News Feed (M01) is marked Included
-- for Growth in the workbook, and `market-updates` is Scale-only in the
-- deployed entitlement gate** (the prime's `planEntitlements.ts` says so in its
-- own comment: "Scale-bundled ONLY — Launch and Growth reach it through the
-- separately purchased add-on"). The workbook knows: D01 records the conflict,
-- says this pass did not re-audit deployed code, and leaves it **Open**.
--
-- This migration does not answer D01. It removes the contradiction between two
-- of OUR systems, in the only direction that cannot hurt a customer: the row
-- said Growth included it while the gate refused it, which promises a paying
-- Growth customer a feature the product then denies. Aligned to the gate, a
-- Growth customer is offered the add-on and gets what they buy. If the owner
-- confirms the workbook's Growth inclusion, the gate and the catalogue have to
-- move together — the pricing row alone is not the fix.

UPDATE public.addon_modules AS m SET
  included_in_plans = v.included_in,
  sort_order        = v.sort_order
FROM (VALUES
  ('market-updates',           ARRAY['scale']::text[],                       10),
  ('commercial-industrial',    ARRAY['scale'],                               20),
  ('opportunity-marketplace',  ARRAY['scale'],                               30),
  ('intelligence-hub',         ARRAY[]::text[],                              40),
  ('report-comparisons',       ARRAY['growth','scale'],                      50),
  ('cashflow-comparisons',     ARRAY['growth','scale'],                      60),
  ('email-copilot',            ARRAY[]::text[],                              70),
  ('call-logs',                ARRAY[]::text[],                              80),
  ('portfolio-analysis',       ARRAY['scale'],                               90),
  ('send-portfolio',           ARRAY['scale'],                              100),
  ('client-forms',             ARRAY['launch','growth','scale'],            110),
  ('borrowing-capacity',       ARRAY['scale'],                              120),
  ('lenders',                  ARRAY[]::text[],                             130),
  ('client-ai',                ARRAY['scale'],                              140),
  ('agreements',               ARRAY['scale'],                              150),
  ('marketing',                ARRAY['scale'],                              160),
  ('deal-pipeline',            ARRAY['growth','scale'],                     170),
  ('aml-ctf',                  ARRAY[]::text[],                             180),
  ('model-hub',                ARRAY['scale'],                              190),
  ('finance-portal',           ARRAY['scale'],                              200),
  ('integrations',             ARRAY[]::text[],                             210),
  ('api-usage',                ARRAY['scale'],                              220),
  ('solicitor-portal',         ARRAY[]::text[],                             225),
  ('builder-developer-portal', ARRAY[]::text[],                             226),
  ('aurixa-agent',             ARRAY[]::text[],                             230)
) AS v(slug, included_in, sort_order)
WHERE m.slug = v.slug;

-- `client-forms` keeps all three tiers and its $49 on purpose. The workbook
-- renames M13 to "Advanced Forms Builder" and marks it Add-on on every tier —
-- but D07 is Open and says, in the workbook's own words, to confirm "a
-- genuinely incremental, production-ready advanced/custom scope BEFORE selling
-- it separately", and to "avoid charging twice for standard forms". Flipping
-- this row would start charging for standard forms on the strength of an
-- unresolved decision, which is the one thing the sign-off rule forbids.

-- ─── 3. Lenders is not for sale, and now says so ────────────────────────────
--
-- MODULE CATALOGUE M25 prints "Not for sale" where every other row prints a
-- number. The $99 in this table is historical: it was never withdrawn, so a
-- quote builder reading the row would offer it. The figure stays (deleting it
-- loses the history) and the description now contradicts it in the one place
-- an operator reads.

UPDATE public.addon_modules
   SET description = 'In development. Not for sale — the listed figure is historical and is not a current price.'
 WHERE slug = 'lenders';

-- ─── 4. A priced module may map to another deployment ───────────────────────
--
-- `mapping_kind` had three answers and the Builder / Developer Portal is none
-- of them. It installs nothing on a clone (it is another deployment entirely),
-- so 'installs' is false; it gates no sub-module here, so 'entitlement' is
-- false; and 'unmapped' is an OPEN QUESTION — the index
-- `idx_pricing_module_map_unmapped` exists so an operator can find and answer
-- them. Leaving a settled fact sitting in the unanswered pile is how a real
-- gap stops being visible.
--
-- `external` is the settled answer: mapped, deliberately, to somewhere that is
-- not this clone. `lib/pricing/module-mapping.ts` already returns it.

ALTER TABLE public.pricing_module_map
  DROP CONSTRAINT IF EXISTS pricing_module_map_mapping_kind_check;
ALTER TABLE public.pricing_module_map
  ADD CONSTRAINT pricing_module_map_mapping_kind_check
  CHECK (mapping_kind IN ('installs', 'entitlement', 'external', 'unmapped'));

COMMENT ON COLUMN public.pricing_module_map.mapping_kind IS
  'installs = ships technical modules to the clone; entitlement = flips a '
  'SUB_MODULE_MATRIX key; external = real and deliberately served by another '
  'deployment (Builder / Developer Portal); unmapped = nobody has decided yet.';

-- ─── 5. Audit ───────────────────────────────────────────────────────────────
--
-- Names what is still owed rather than asserting the job is done. An active,
-- purchasable module with no Stripe link is not broken — it is waiting for the
-- Apply that links it — but it cannot be checked out until then, and that is
-- worth saying out loud at the end of a reprice.

DO $$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT slug, price_min_cents FROM public.addon_modules
     WHERE is_active AND stripe_price_id IS NULL
       AND slug NOT IN ('lenders', 'builder-developer-portal')
     ORDER BY sort_order
  LOOP
    n := n + 1;
    RAISE WARNING 'Module % (% cents) has no Stripe price yet — run the module sync before it can be bought.', r.slug, r.price_min_cents;
  END LOOP;
  IF n = 0 THEN
    RAISE NOTICE 'Every purchasable module is linked to a Stripe price.';
  END IF;
  RAISE NOTICE 'Tier and module AMOUNTS are not written by this migration. Run the catalogue and module syncs from the Pricing page to move price_cents / price_min_cents and their Stripe ids together.';
END $$;
