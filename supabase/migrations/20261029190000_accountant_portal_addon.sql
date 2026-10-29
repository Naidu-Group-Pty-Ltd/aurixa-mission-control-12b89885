-- The Accountant Portal, sold as an add-on whose price is not yet decided.
--
-- @asserts rows:addon_modules>=33
--
-- The owner's decisions of 29 Oct 2026: the Accountant Portal is sold as the
-- Solicitor Portal is (D17), an add-on included in no tier; its price is not
-- decided; its Stripe product carries an A$1 placeholder price; and until a
-- price is set, a workspace has it by an operator's grant, never through a
-- checkout. `src/lib/pricing/aurixa-catalog.ts` records all four
-- (`priceUndecided`).
--
-- The module sync updates rows by slug and never invents one, so the row
-- starts here, as 20260922090000 started the Solicitor Portal's.
--
-- Its price columns cannot be empty, so they hold the placeholder. Every
-- catalogue read outside the database presents the row with no price
-- (`presentAddonRow`), and `metadata.price_undecided` says the same to anything
-- reading the table. No Stripe link is written: a linked price is what a
-- checkout sells, and the module sync leaves this row unlinked for as long as
-- the catalogue withholds the module.

INSERT INTO public.addon_modules
  (slug, name, description, price_min_cents, price_max_cents, currency, billing_period,
   category, included_in_plans, is_active, sort_order, metadata)
VALUES
  ('accountant-portal', 'Accountant Portal',
   'Partner hand-off portal for the client''s accountant. Price to be confirmed; until it is, the portal is enabled on request.',
   100, 100, 'AUD', 'monthly', 'Administration', ARRAY[]::text[], true, 227,
   '{"tax_inclusive": true, "gst_included": true, "price_undecided": true}'::jsonb)
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
-- price_min_cents / price_max_cents are left out of the DO UPDATE list for the
-- reason 20260922090000 gives: once a price is decided, the module sync owns
-- them, and a re-run must not move a displayed figure away from its Stripe id.
