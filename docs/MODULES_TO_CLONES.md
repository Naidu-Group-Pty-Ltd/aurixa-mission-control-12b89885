# Modules → clones: how the tie-up occurs

August 2026. The runbook for how a module captured from the prime becomes a
working feature on a clone, how the pricing tiers decide the set, and what
every path does in what order. Companion to
[`THE_CLONING_ENGINE.md`](./THE_CLONING_ENGINE.md) (the three engines and
their drains) and [`CLONE_PIPELINE_GAPS.md`](./CLONE_PIPELINE_GAPS.md) (the
nine gaps hand-cloning found, all closed). Everything countable below was
measured against the live Mission Control database on 2026-08-28.

> **27 Oct 2026: modules no longer decide which files a new clone receives.**
>
> Every clone `provisionCloneCore` creates is now a mirror of the tree it was
> created from, and `clones.sync_scope` defaults to `mirror`
> (`20261027100000`). The modules a clone has are still its `clone_modules`
> rows and its entitlements, and they still gate features at run time.
>
> What they no longer do is narrow the cascade. A module scope let through
> only the later changes inside the installed globs of a repository that had
> been created whole, so everything else was frozen at creation. Measured on
> the prime at `1e18e4b`, a launch-tier clone would never have received 3,624
> app-code files or 285 functions.
>
> The CRM is the one clone still module-scoped. Its move to mirror waits on a
> rehearsal (`DELIVERY_SYSTEM_PLAN.md`, W1 and D7). Where this runbook
> describes a module cascade for a new clone, read it as history.

> **29 Oct 2026: every library module has a place on the price list.**
>
> The library follow settled the catalogue at prime@83a3218 (run `7e505791`,
> 22:34 UTC): 143 approved modules, 22 of them new since July. Measured with
> `module-mapping.ts` against those 143, **105 resolved on no plan at all** —
> a Scale clone's recorded entitlement named 32 modules, Launch's 22. Most were
> the pieces detection splits a feature into: `backend-*` workers no route
> reaches, operator consoles, public share pages, sub-pages.
>
> Each is now placed with the module whose feature it serves, as the prime
> gates it (`MODULE_COMPANIONS`), or recorded as not sold and why
> (`NOT_SOLD_MODULES`: two test files detection read as routes, and NPC's own
> GoHighLevel migration tooling). Launch resolves 91 modules, Growth 92, Scale
> 117, and every plan with every add-on 135; the other eight are the unsold
> ones. See [Placement](#placement). The Pricing page names any module the
> follow brings in that nothing places (`unplacedModules`).
>
> The same day the owner made the **Accountant Portal** an add-on in no tier,
> sold as the Solicitor Portal is, with its **price undecided**: its Stripe
> product (`prod_VX6f7zMP6x6zyo`) carries an A$1 placeholder price that nothing
> quotes or charges, and until it is priced a workspace has it by an operator's
> grant only (`priceUndecided`, `isModuleGrantable`).

> **D18: a contract's exclusions are price-list slugs, and they reach the
> clone.**
>
> An agreement used to exclude library module ids. It now excludes price-list
> slugs (`client_agreements.excluded_module_slugs`, `20261027140000`).
> `provisionCloneCore` writes them in the clone's own INSERT, and the balance
> response sends them to the clone as `entitlements.excluded`. See
> [Contractual exclusions](#contractual-exclusions).

> **D16: a new clone meters on the plan it was sold, from the moment it
> exists.**
>
> The plan a clone gates on is its metering tenant's, which the balance
> response reports as `tenant.billing_plans.slug`. Nothing at provisioning
> used to create that tenant. The first call that needed it did, through
> `ensureTenant`, on the cheapest active plan, `free`: measured 27 Oct 2026,
> NPC Test (sold `launch`), Preflight and the CRM (both sold `scale`) all gate
> on `free`. `provisionCloneCore` now creates the tenant, or adopts the one the
> clone has, on the plan it was sold, straight after the clone's INSERT
> (`clone-metering-tenant.server.ts`). A sold slug `billing_plans` does not
> hold is refused before anything is created. No billing period starts and no
> allowance is issued until the activation payment, which does both. The three
> clones above stay on `free` until launch, by the owner's decision of 27 Oct.

---

## The two vocabularies, and the join

| vocabulary | lives in | counts today |
| --- | --- | --- |
| **technical** — what detection found in the prime repo | `modules` (134 rows, all approved) | 134/134 file globs + backend manifest + layer; 115 with edge functions; 114 with tables + required secrets |
| **commercial** — what a customer buys | `src/lib/pricing/aurixa-catalog.ts` (3 tiers, ~23 priced modules) mirrored in `billing_plans` (launch/growth/scale, `metadata.tier`) and `addon_modules` (23 active; slugs identical to the priced catalogue) | — |

The join is `src/lib/pricing/module-mapping.ts` — curated, pure, tested.
`resolveEntitledModules(plan, addons)` walks the tier inheritance chain,
applies the always-installed shell, the alias table and any operator
overrides (`pricing_module_map`, managed from the pricing map panel), and
returns exactly three kinds of outcome: **installs**, **entitlement-only**
(a sub-feature key inside an already-installed module), and **unmapped** —
surfaced for an operator, never guessed.

**Measured coverage (2026-08-28, against all 134 live modules):**

| plan | modules resolved | entitlement keys | unmapped |
| --- | --- | --- | --- |
| launch | 22 | 20 | 0 |
| growth | 23 | 23 | 0 |
| scale | 32 | 32 | 0 |
| any tier + ALL 23 add-ons | 36 | — | 1 — `intelligence-hub` |

`intelligence-hub` is the one priced item with no confident technical
counterpart; bind it via the pricing map panel's override when its
implementation lands. That it reads as *unmapped* rather than silently
resolving to nothing is the design working.

## Placement

The join above runs from the price list to the library. Placement runs the
other way: every library module has exactly one place, and a test against the
library as production held it (`liveLibrary.fixture.ts`, 143 modules at
prime@83a3218) fails if one has none or two.

| place | where it is recorded | resolves on |
| --- | --- | --- |
| the shell | `ALWAYS_INSTALLED` | every plan |
| a tier's feature | `TIER_FEATURES`, mirrored on the website's pricing page, via `TIER_FEATURE_ALIASES` where the names differ | that tier and above |
| a priced module | `aurixa-catalog.ts`, via `PRICED_MODULE_ALIASES` | the tiers that include it, or its purchase |
| a companion | `MODULE_COMPANIONS`: the module whose feature it serves | wherever that module is |
| not sold | `NOT_SOLD_MODULES`, with the reason | no plan |

**A companion goes where its anchor goes.** `resolveEntitledModules` adds every
companion of a module it installs, transitively, and `libraryModulesOf` does
the same, so a contract exclusion withholds an anchor's companions with it:
excluding `aml-ctf` withholds `aml`, `backend-aml` and `backend-didit`. A
companion whose anchor is not in the catalogue installs nothing.

**A place writes down the prime's decision; it never makes a commercial one.**
Each companion sits where the prime's route guard or server check already opens
it. The Portfolio Analysis Review page is gated by `client.review`, so it rides
Clients; Partner Referrals, Loan Writer Undertakings and Partner Compliance are
gated by `agreements`; Workflow Playground by `integrations`. Three modules
the sheet predates are now tier features, each where the prime opens it:
Quantitative Reports, Templates and Auto Report Generation on Launch. A paid
page under Clients (Borrowing Capacity, Lenders) is installed with Clients and
shut by its entitlement key, as the paid client tabs are.

**A new module is named, never left on no plan.** The library follows the
prime by itself (D19). A feature merged there arrives with no place, and
`unplacedModules` lists it on the Pricing page (`getModuleMap`) until it is
placed. A failed library read says so rather than reporting nothing unplaced.

## What "installing a module" actually does

Three different mechanisms, one per artefact kind — and knowing which is
which is most of this document's value:

1. **Schema (tables, functions, RLS, triggers).** Arrives WHOLESALE at
   backend provisioning: the drain replicates the prime's **live catalogue**
   by introspection (641 tables, 1,149 policies, …), not per module. This is
   why `modules.clone_migration_sql` is **empty for all 134 rows and
   `apply_on_install` false — by design, not omission**: the per-module
   migration path (`applyModuleMigrations`) exists for genuinely additive
   module SQL and currently has nothing to do, because every clone's schema
   is a full prime replica. A module's `database_tables` manifest documents
   its footprint; it does not install it.
2. **Code (the module's files).** `clone_modules` rows drive the cascade:
   `file_globs` scope which files flow. A template/fork clone starts as a
   full byte copy anyway; module-scoped cascades matter for **updates** —
   prime changes flowing per module — and for the provision-time cascade that
   seeds a fresh repo's module files.
3. **Features (what the tenant can actually use).** `entitled_plan_slug`,
   `entitled_module_slugs` and `entitlement_keys` on the clone row, stamped
   by `reconcileCloneEntitlements`, are Mission Control's record of what the
   plan entitles. **The clone does not read them.** It gates on its balance
   response: the plan slug and `entitlements.addons`, less
   `entitlements.excluded` (`/api/public/tokens/balance`). Measured 27 Oct
   2026, nothing in the prime reads `entitlement_keys` or
   `entitled_module_slugs`. The paragraph below and
   [The hand-made clone is special](#the-hand-made-clone-is-special) were
   written before that was measured.

That third mechanism is the one the hand-made clone was missing: 18 modules
were injected on 2026-08-28 while `entitled_plan_slug` stayed NULL and
`entitled_module_slugs` stayed `[]`. Injection writes rows; **reconciliation
turns features on.** The repair for any such clone is one action: the clone
page → entitlements → reconcile with its plan (`reconcileClone`).

## The order, per path

### Wizard (`/clones/new`)

1. `TierModulePicker` resolves the tier + add-ons through
   `previewTierModules` (same join as above); operator refines.
2. `provisionCloneCore` — repo (fork/template), `clones` row with
   `entitled_plan_slug`, the metering tenant on the plan sold
   (`ensureCloneMeteringTenant`, D16), add-on purchase rows, `clone_modules`,
   provision cascade, API key, Codex secrets, subdomain reservation,
   deployment enqueue. The plan's slug is checked against `billing_plans`
   before the repository is created. A tenant that cannot be settled holds
   the backend back and fails the submit, naming why; submitting again with
   the same details reuses the clone, settles the tenant first and queues
   the backend.
3. `provisionBackend` → `clone_backends` queue → the drain builds the
   Supabase project (introspection), deploys edge functions, shells
   secrets, seeds the admin.
4. Entitlement reconciliation on plan events (`drainPlanChanges` /
   `reconcileClone`).

### Signed agreement (`/agreements`, provision-on-signature)

The autonomous path; every step is the wizard's own machinery:

1. **Preflight** (`assessProvisioningPreflight`) — before anything is
   created: the six credentials the pipeline spends (`GITHUB_APP_*`,
   `SB_MGMT_API_TOKEN`, `SB_ORG_ID`, `CREDENTIALS_ENC_KEY`), prime config
   resolvable, module catalogue non-empty, and ONE live probe — reading the
   prime's branch through the GitHub App, the exact call a broken
   installation id fails on. Refusal is named and nothing is spent.
2. **Contractual exclusions, against the picks.** Every picked library module
   an excluded price-list slug maps to is dropped (`effectiveModuleIds`).
3. `provisionCloneCore` — as above, with idempotency key `agreement:<id>`.
   The exclusions go into `clones.contract_excluded_module_slugs` in the
   clone's own INSERT, so the reconcile it runs already honours them. A retry
   that finds the clone writes the agreement's current exclusions onto it.
   The metering tenant goes on the agreement's plan
   (`client_agreements.plan_slug`, which signature-time provisioning
   requires). A tenant it could not settle fails this step, before the
   reconcile and the backend enqueue below.
4. **Initial entitlement reconcile** — stamps
   `entitled_plan_slug/_module_slugs/entitlement_keys` from tier + add-ons
   minus exclusions, and installs any entitled module the operator did not
   hand-pick. Fatal if it fails, precisely so no clone can exist in the
   "installed but unfunctional" state.
5. Backend enqueue — after the reconcile on purpose, so the queue's
   authoritative module set (`clone_modules`) is already complete.

Until D18 the exclusions were written between steps 3 and 4, after
`provisionCloneCore` returned. Its reconcile had already installed the
excluded modules by then, and the second reconcile could only record them as
revoked.

### Plan changes (the life of the clone)

Stripe plan events queue `plan_change_events`; `drainPlanChanges` runs
`reconcileCloneEntitlements`: upgrades install, downgrades revoke
entitlements and **leave every file in place** (instant re-upgrade, nothing
in flight breaks). Contractual exclusions are subtracted from **every**
resolution — an upgrade can never re-install what the agreement bargained
away (`applyContractExclusions`).

## Contractual exclusions

A signed agreement can take modules out of the tier it sells. It records them
as **price-list slugs**: `MODULES[].slug` in `aurixa-catalog.ts`, such as
`aml-ctf`, `finance-portal` or `market-updates`
(`client_agreements.excluded_module_slugs`). A contract is negotiated in that
vocabulary, and the prime gates on it.

It used to record library module ids (`excluded_module_ids`): rows of
`modules`, which name code (`aml`, `commercial`, `backend-aml`) rather than
what was sold, and which a library reset loses. That column is superseded.
Nothing reads it, and a save writes it empty. Measured 27 Oct 2026, no
agreement and no clone held an exclusion, so nothing was translated.

| step | where | what happens |
| --- | --- | --- |
| recorded | `configureAgreementProvisioning` | Checked by `validateContractExclusions`. A slug the price list does not know is refused by name, and so is one the same selection buys as an add-on. One the plan does not include is accepted and changes nothing. |
| picks | `effectiveModuleIds` | Every picked library module an excluded slug maps to is dropped. |
| clone row | `provisionCloneCore` | Written to `clones.contract_excluded_module_slugs` in the clone's own INSERT. |
| every reconcile | `applyContractExclusions` | Subtracted, as below. |
| the clone | `/api/public/tokens/balance` | Sent as `entitlements.excluded`. |

**The reconcile.** For each excluded price-list module:

- it leaves `includedModules` and `addonModules`;
- the library modules it maps to leave `moduleSlugs`: the operator's override
  `module:<slug>` first, else `mapPricedModule` (`libraryModulesOf`). A
  library module that a priced module still in effect also maps to stays, and
  the result names it (`sharedModulesKept`). A tier baseline keeps nothing:
  the AML/CTF baseline maps to `aml` too, and excluding `aml-ctf` removes it;
- its `ENTITLEMENT_ONLY_MODULES` key leaves `entitlementKeys`. For
  `client-ai` and the other entitlement-only items, that key is the only gate.

A slug the price list does not know is reported (`unknownExclusions`, and in
the audit row) and subtracts nothing.

**The clone.** A clone reads none of Mission Control's bookkeeping, so the
balance response is where its exclusions reach it:

```
entitlements: { addons: string[], excluded?: string[] }
```

- `excluded` holds the clone's exclusions, sorted and de-duplicated. It is
  present, possibly `[]`, whenever the clone's row was read, and `[]` for a
  platform-level key, which has no clone. It is absent only when the read
  failed, and the clone then keeps the exclusions it last knew.
- `addons` never contains an excluded slug, and the AML derivation never adds
  `aml-ctf` when the contract excludes it.
- A billing-exempt tenant's `addons` is the whole price list, less its
  exclusions (D17), so the prime's last-known-good cache keeps what its
  exemption grants on a live answer.

A failed read never fails the balance call. The derivation is
`balanceEntitlements.pure.ts`.

## Guardrails inventory (where each lives)

| guardrail | where |
| --- | --- |
| Unmapped is surfaced, never guessed | `module-mapping.ts` (`unmapped` outcome), pricing map panel |
| Every library module has one place, and a new one is named | `MODULE_COMPANIONS`, `NOT_SOLD_MODULES`, `unplacedModules` (pricing map panel); the placement tests against `liveLibrary.fixture.ts` |
| An undecided price is never quoted, sold or recorded as charged | `priceUndecided` (out of `PURCHASABLE_MODULES`, grantable by `isModuleGrantable`), `presentAddonRow` on every catalogue read, `grantAddon` records no amount |
| Clone secret writes can never reach the prime | `cloneSecretTarget.pure.ts` — ref is a return value, not an argument |
| Identity secrets generated per clone, never copied | `planCloneSecrets` (`generated` class) |
| Clone repo re-targeted off the prime before handover | `clone-repo-retarget.server.ts` |
| Parity gate after backend provisioning | `computeParity`, recorded on `clone_backends` |
| Provisioning idempotency | idempotency key on `provisionClone`; CAS claim on agreements |
| Failed auto-provision never auto-retries | `decideProvisionOnSignature` (`failed_needs_operator`) |
| Engine preflight before autonomous spend | `assessProvisioningPreflight` |
| Contractual exclusions persist for the clone's life, and reach it | `clones.contract_excluded_module_slugs`, written in the clone's INSERT, subtracted in every reconcile, sent as `entitlements.excluded` |
| A new clone meters on the plan it was sold, never on `free` by default | `ensureCloneMeteringTenant`, run by `provisionCloneCore` beside the INSERT; `resolveSoldPlan` refuses a slug `billing_plans` lacks before anything exists |
| Drains scheduled + single-driver enforced | `20260826000000_schedule_the_engine.sql`, `check:cron`, `check:cron-auth` |

## The hand-made clone is special

`npc-client-dashboard` (the only clone today) was built OUTSIDE this engine
— repo hand-mirrored (`VITE_CLIENT_FACING=true` build differences), backend
hand-introspected. Consequences, all expected:

- Cascades to it run in **PR mode, "awaiting manual reconcile"** — its tree
  legitimately diverges from the prime, so nothing auto-merges. Module files
  land when those PRs are merged.
- Its backend already holds the full prime schema, so module installs are
  purely a code + entitlement question.
- It has never been entitlement-reconciled. Until an operator runs
  `reconcileClone` with its plan, gated features stay off regardless of what
  is installed. That is the "modules seem unfunctional" observation, and it
  is one click, not a defect.

Engine-provisioned clones hit none of this: they are born from the template,
cascade cleanly, and (via the agreement path) are reconciled at birth.
