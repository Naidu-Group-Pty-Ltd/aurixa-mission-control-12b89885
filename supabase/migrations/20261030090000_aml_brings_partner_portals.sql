-- AML/CTF Compliance brings every partner portal.
--
-- @asserts rows:addon_modules>=33
--
-- The owner's decision of 29 Oct 2026: a workspace on any plan that includes
-- AML/CTF Compliance has the Finance, Solicitor, Accountant and Builder /
-- Developer portals at no extra cost, and one without it keeps the price list
-- as it stands. `src/lib/pricing/aurixa-catalog.ts` records it
-- (`includedWithAml`, `AML_BUNDLED_MODULES`), and the balance response derives
-- the portals wherever AML/CTF is held (`balanceEntitlements`).
--
-- This changes no price and no tier. It gives the five rows descriptions that
-- say so, because the storefront and the workspace's own billing page print a
-- row's description under its name, and marks the four portals
-- `metadata.included_with_aml` for anything reading the table. Catalogue reads
-- outside the database take the flag from the catalogue itself
-- (`presentAddonRow`), and the module sync writes it back whenever it replaces
-- a row's metadata. The internal decision references the old descriptions
-- carried ("Purchaser and portal scope: D05") are dropped: a customer reads
-- these.
--
-- The Accountant Portal's row is inserted by 20261029190000, which runs first.
-- If it has not, its UPDATE matches nothing and changes nothing.

UPDATE public.addon_modules
SET description = 'The difference between a tier''s with- and without-AML headline price. Brings the Finance, Solicitor, Accountant and Builder / Developer portals at no extra cost.'
WHERE slug = 'aml-ctf';

UPDATE public.addon_modules
SET description = 'Also unlocks client Send To Finance and Finance Messages. Included with Scale, and with any plan that includes AML/CTF Compliance.',
    metadata    = metadata || '{"included_with_aml": true}'::jsonb
WHERE slug = 'finance-portal';

UPDATE public.addon_modules
SET description = 'Partner / compliance hand-off portal. Included with any plan that includes AML/CTF Compliance; otherwise an add-on on every tier.',
    metadata    = metadata || '{"included_with_aml": true}'::jsonb
WHERE slug = 'solicitor-portal';

UPDATE public.addon_modules
SET description = 'Partner hand-off portal for the client''s accountant. Included with any plan that includes AML/CTF Compliance; otherwise its price is to be confirmed, and it is enabled on request.',
    metadata    = metadata || '{"included_with_aml": true}'::jsonb
WHERE slug = 'accountant-portal';

UPDATE public.addon_modules
SET description = 'Included with any plan that includes AML/CTF Compliance; otherwise sold directly rather than through a checkout.',
    metadata    = metadata || '{"included_with_aml": true}'::jsonb
WHERE slug = 'builder-developer-portal';
