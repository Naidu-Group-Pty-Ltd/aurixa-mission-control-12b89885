-- ─────────────────────────────────────────────────────────────────────────────
-- The App installation becomes a metered provider — counted, never charged.
--
-- Measured 19 Sep 2026: `api_usage_events` held 209 rows for the previous six
-- hours and every one was Airtable. Thirty providers had a rate row; GitHub had
-- none. So the scarcest resource in this system — one App installation's hourly
-- window, shared by eleven scheduled lanes — was the one thing nothing counted.
--
-- It had already been exhausted twice. On 16 Sep a 5,000-call window opening at
-- 09:23 was spent by 09:41, which is what `githubBudget.pure.ts` was written
-- for. On the night of 18–19 Sep it went again, and because a quota refusal
-- mid-pass was indistinguishable from a migration a clone had rejected,
-- `NPC Client Dashboard`, `NPC Test` and `Preflight Property Group` were moved
-- to `failed` between 02:14 and 03:34 — each named after a migration it had
-- never been sent.
--
-- Both of those are fixed in code. This row is what makes the NEXT one
-- diagnosable: "what spent the window?" becomes one query over
-- `api_usage_events` instead of an afternoon reading cron schedules. That
-- afternoon's hand audit also got the answer wrong — it missed
-- `deployment-drain`, on the second-busiest schedule in the system.
--
-- WHY IT IS ABSORBED AND COSTS ZERO
--
-- Two separate reasons, and both matter.
--
--   * These calls spend MISSION CONTROL's own installation, not a credential
--     forwarded to a tenant. `API_USAGE_METERING.md` states the rule: guessing
--     which credential a call spent bills the wrong tenant. A cascade runs FOR
--     a clone but is not paid for BY one, so the events are written against the
--     `prime` tenant, which is `billing_exempt`, and carry no `clone_id`.
--
--   * A GitHub App call costs no money at all. The scarce thing is the rate
--     limit, not the invoice. So the rate is 0/0 and the row exists to make the
--     calls COUNTABLE rather than chargeable — `absorbed` is the vocabulary
--     this schema already has for "cost recorded, charge zero", and it is how
--     `DIDIT_API_KEY` is filed.
--
-- A non-zero resale here would invent revenue out of a diagnostic.
--
-- @asserts rows:api_provider_rates>=30
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.api_provider_rates
  (secret_name, provider, display_name, category, unit,
   cost_micros_per_unit, resale_micros_per_unit, included_free_units,
   currency, is_billable, absorbed, notes)
VALUES
  ('GITHUB_APP_PRIVATE_KEY', 'github', 'GitHub App installation', 'platform', 'request',
   0, 0, 0, 'AUD', false, true,
   'Counted, never charged. A GitHub App call costs no money — the scarce resource is the '
   || 'installation''s hourly rate-limit window, which eleven scheduled lanes share. Metered so '
   || 'that "what spent the window?" is answerable from the ledger rather than from cron '
   || 'schedules; see githubUsageMeter.ts and cascade/githubBudget.pure.ts. Events are written '
   || 'against the prime tenant with no clone_id, because the installation is Mission Control''s '
   || 'own and attributing it to a tenant would invent a charge out of a diagnosis.')
ON CONFLICT (secret_name) DO UPDATE
  SET provider               = EXCLUDED.provider,
      display_name           = EXCLUDED.display_name,
      category               = EXCLUDED.category,
      unit                   = EXCLUDED.unit,
      cost_micros_per_unit   = EXCLUDED.cost_micros_per_unit,
      resale_micros_per_unit = EXCLUDED.resale_micros_per_unit,
      is_billable            = EXCLUDED.is_billable,
      absorbed               = EXCLUDED.absorbed,
      notes                  = EXCLUDED.notes,
      updated_at             = now();
