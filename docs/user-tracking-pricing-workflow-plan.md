# User-Attributed Pricing & Purchase Workflow — Implementation Plan (Canonical Spec)

---

## ⚠ REVISION 3 (2026-07-13) — Mission Control's `/pricing` route removed.

The `/pricing` operator console described in Revision 2 has been fully migrated to the
Aurixa Systems website. Mission Control no longer serves any `/pricing` route:

- Operator discretionary purchases continue via `/billing/topup`, `/billing/seats`,
  and `/billing/catalog`.
- `storefrontPricingBase()` no longer falls back to Mission Control's own `/pricing`;
  when `PUBLIC_PRICING_SITE_URL` is unset it falls back to the storefront default
  (`DEFAULT_STOREFRONT_PRICING_URL` in `src/lib/storefront.ts`), so minted handoff
  links and packs `topup_url`s always land on the Aurixa Systems site.
- The storefront's `/pricing` page is intentionally **not linked** from the Aurixa
  Systems site's public navigation (Navbar/Footer) — it is reached only via handoff
  deep links minted for command-center users, or by direct URL.

---

## ⚠ REVISION 2 (2026-07-10) — Storefront topology. This section supersedes any conflicting statement below.

The original phases (1–4, all implemented) treated Mission Control's `/pricing` route as the
customer-facing pricing page. The corrected topology separates the three surfaces:

| Surface | Role |
|---|---|
| **Aurixa Systems website** (`aurixa-systems` repo) | **THE customer pricing page.** All user-centric monetisation — tokens, plans, seats, from the prime repo and every clone — flows through `aurixasystems…/pricing`. Users never see Mission Control. |
| **Mission Control** (this repo) | **Headless billing engine + oversight + discretionary control.** (1) Owns Stripe, the webhook, the catalog, handoffs, and the `purchases` ledger — it *monitors* every purchase. (2) Provides the **secondary manner**: operators grant tokens / apply comp top-ups / change billing & seat plans ad-hoc at our discretion, with every action recorded in the same ledger for 100% granular oversight. Its `/pricing` route is now an **operator-gated console** for pushing ad-hoc purchases on behalf of clients — never a customer route. |
| **Command centers** (`npc-property-dashbord`, prime + clones) | Origin of purchase intent. CTAs mint handoffs exactly as before — Mission Control now mints those links against the **storefront**, so no origin-side logic changed. |

### What implements Revision 2 in this repo

1. **`PUBLIC_PRICING_SITE_URL`** (env): full URL of the storefront pricing page. All handoff
   deep links (`POST /api/public/billing/handoff`) and packs `topup_url`s are minted against it
   via `storefrontPricingBase()` (`src/server/billing-handoffs.server.ts`). Unset = falls back
   to Mission Control's own `/pricing` so nothing breaks mid-rollout.
2. **Storefront REST API** (CORS-enabled for the static site; possession-based auth — the
   unguessable handoff token / (session, handoff) pair, never cookies):
   - `GET  /api/public/storefront/catalog` — public active catalog (plans/packs/setups/addons/reports).
   - `GET  /api/public/storefront/handoff?h=` — display-safe token resolution (clone name, username, intent).
   - `POST /api/public/storefront/checkout` — `{ h, mode, item_id, quantity }` → Stripe URL.
     Success/cancel redirect to `<storefront>/pricing/success|cancel` with the `(session_id, h)` pair.
   - `GET  /api/public/storefront/session?session_id=&h=` — receipt summary + fulfilment status + validated `return_url`.
   Shared engines: `src/server/checkout.server.ts` (extracted checkout core + handoff checkout),
   `src/server/checkout-session.server.ts`, `src/server/public-catalog.server.ts`.
3. **`/pricing` is operator-gated** (`ProtectedRoute`) and retitled "Pricing Console" — the
   discretionary purchase surface, alongside `/billing/topup`, `/billing/seats`, `/billing/catalog`.
4. **Discretionary-action oversight**: `grantTenantTokens`, `applyTenantTopup`,
   `assignTenantPlan`, `assignSeatPlan` now record `admin_grant` / `admin_topup` /
   `admin_plan_change` / `admin_seat_change` rows into `purchases`
   (`recordAdminAction`, amount 0, `origin_source='mission_control'`, operator identity).
   Rollups count them separately (`adminActionCount`) — never as purchases or revenue —
   and they are filterable in `/billing/purchases`.

### Deployment addendum
- Set `PUBLIC_PRICING_SITE_URL` once the aurixa-systems storefront is live; until then the
  legacy Mission Control landing keeps working.
- The origin repo's static fallback CTAs point at the storefront constant
  (`AURIXA_PRICING_URL` in `src/lib/missionControl.ts`) — set the production domain there too.

---

> **Repo role in this plan:** `aurixa-mission-control` is the **system of record**. It owns the
> pricing page (`/pricing`, branded "Aurixa Systems"), Stripe checkout, the webhook, the billing
> database, and the operator dashboard. Most of the new surface area lands here.
>
> **Companion plans (same branch `claude/user-tracking-pricing-workflow-deyg3i` in each repo):**
> - `npc-property-dashbord` → `USER_TRACKING_PRICING_WORKFLOW_PLAN.md` (origin side: command center CTAs + handoff edge function)
> - `aurixa-systems` → `docs/user-tracking-pricing-workflow-plan.md` (marketing-site entry point into the same flow)

---

## 1. Problem statement

When a user inside a command center (the NPC property dashboard — prime install or any clone)
purchases tokens, seats, or setup packages, they are deep-linked into Mission Control's pricing /
billing pages and on to Stripe Checkout. Two things are lost along the way:

1. **The initiating user's identity.** The `custom_users.id` of the person who clicked "Top up"
   in the command center never leaves that app. Mission Control and Stripe only ever see a
   `tenant_id` (and sometimes a `clone_id`).
2. **Durable purchase attribution.** There is no storage point that records *which clone/client
   and which end user* initiated each purchase, so Mission Control cannot answer
   "who bought what, from where, when" — the macro-trackability requirement.

## 2. Current state (verified in code)

### The flow today

```
NPC command center                     Mission Control                      Stripe
─────────────────                      ───────────────                      ──────
Top-up CTA
  openMissionControl(                 /billing/topup?tenant=<uuid>
    MISSION_CONTROL_TOPUP_URL) ────►  or /pricing (operator picks clone)
  (src/lib/missionControl.ts:126-137)      │
                                           │ createStripeCheckout()
                                           │ (src/lib/stripe.functions.ts)
                                           │ metadata: mode, item_id,
                                           │   item_slug, tenant_id,
                                           │   clone_id, quantity ──────────►  Checkout Session
                                           │                                        │
                                           ▼                                        ▼
                                     /api/public/stripe/webhook  ◄──────  checkout.session.completed
                                       apply_topup / setup_purchases /
                                       clone_seat_entitlements
```

### What already exists (build on, don't duplicate)

| Piece | Where | Notes |
|---|---|---|
| Pricing page w/ clone selector + `?clone=`/`?intent=` search params | `src/routes/pricing.tsx` | Auth round-trip already preserves `intent`/`clone`; extend the same pattern for user attribution |
| Checkout server fn | `src/lib/stripe.functions.ts` (`createStripeCheckout`) | Stamps `sharedMeta` onto session **and** subscription/payment-intent metadata — the extension point for user fields |
| Webhook w/ idempotent event claim | `src/routes/api.public.stripe.webhook.ts` | `handleCheckoutCompleted` is where the new `purchases` row gets finalised |
| Clone-authenticated public API | `src/routes/api.public.tokens.*` + `src/server/clone-api-keys.server.ts` (`resolveCloneApiKey`, `ensureTenant`) | `x-clone-api-key` header, scopes, rate limiting — reuse for the new handoff endpoint |
| Topup deep-link minting | `src/routes/api.public.tokens.packs.ts` | Already returns `topup_url = /billing/topup?tenant=<id>` — the precedent for server-minted deep links |
| Metering attribution | `api.public.tokens.reserve.ts` → `report_jobs.request_payload.user_id` | Report *usage* already carries the clone user id; purchases must reach parity |
| Tables | `tenants` (has `clone_id`, `external_ref`), `token_ledger` (has `metadata jsonb`), `setup_purchases`, `clone_seat_entitlements`, `stripe_events`, `notifications`, `audit_log` | No table records purchase→user attribution |

### The confirmed gaps

1. `createStripeCheckout` input schema has **no user identity field**; `sharedMeta` has no
   `origin_user_id` / `origin_source`.
2. The static deep links used by the prime repo (`/billing/topup`, `/billing/seats`, `/pricing`)
   carry **no tenant, no clone, no user**. Only the dynamically minted `topup_url` carries `tenant`.
3. **No storage** for "purchase initiated by user X from clone Y" — neither at checkout-creation
   time nor at webhook time.
4. **No dashboard view** of purchases (by clone, by tenant, by user, by period).
5. `createStripeCheckout` is gated by `requireOperator` — clone end-users **cannot legally reach
   checkout at all** unless an Aurixa operator does it for them. Any end-user self-serve flow
   needs a non-operator (handoff-authenticated) checkout path.
6. `/billing/success` (`lookupCheckoutSession`, `getCheckoutFulfillmentStatus`) is operator-only,
   so a clone end-user finishing payment can't see confirmation, and there is no
   "return to your command center" path.

## 3. Target architecture

### 3.1 The attribution contract (canonical field names, snake_case end-to-end)

These fields travel: **command center → handoff API → pricing/topup URL (opaque token) →
checkout metadata → Stripe → webhook → `purchases` table → dashboard.**

| Field | Type | Meaning |
|---|---|---|
| `origin_user_id` | text | `custom_users.id` (or equivalent) of the human who initiated the purchase in the origin app |
| `origin_username` | text? | Display name for dashboards (denormalised, best-effort) |
| `origin_source` | text | `clone:<slug>` \| `prime` \| `mission_control` \| `aurixa_site` |
| `handoff_id` | uuid? | The server-minted handoff token that carried the identity (null for operator-initiated purchases) |
| `tenant_id`, `clone_id`, `mode`, `item_id`, `item_slug`, `quantity` | — | Already exist today; unchanged |

**Trust rule:** `origin_user_id` is only ever asserted **server-to-server** under a clone API key
(the handoff endpoint) or derived from the Mission Control operator session. It is never read
from browser-supplied query params — a `?user_id=` query param would be trivially spoofable and
would poison the attribution data.

### 3.2 The handoff flow (new)

```
NPC edge function                    Mission Control                       Browser
`mission-control-handoff`            POST /api/public/billing/handoff
  verifyAuth(session) → userId ────► x-clone-api-key auth
                                     resolveCloneApiKey → clone_id
                                     ensureTenant(tenant_ref)
                                     INSERT billing_handoffs row
                                     return { url: /pricing?h=<uuid> } ──► window.open(url)
                                                                            │
                                     /pricing or /billing/topup            ▼
                                     resolveHandoff(h) → clone/tenant/user pinned
                                     createStripeCheckout(handoffId…)
                                     INSERT purchases (status=initiated)
                                     → Stripe (metadata carries attribution)
                                     webhook → UPDATE purchases (completed) + fulfil
```

### 3.3 New database objects (one migration)

```sql
-- Short-lived, single-purpose identity carrier minted server-to-server.
CREATE TABLE public.billing_handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clone_id        uuid REFERENCES public.clones(id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  origin_user_id  text NOT NULL,
  origin_username text,
  origin_source   text NOT NULL,                 -- 'clone:<slug>' | 'prime' | 'aurixa_site'
  intent          text,                          -- optional '<mode>:<item_id>' to auto-launch checkout
  return_url      text,                          -- where "back to your dashboard" points after success
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  consumed_at     timestamptz,                   -- set when a checkout session is created from it
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_handoffs_expiry_idx ON public.billing_handoffs(expires_at);
ALTER TABLE public.billing_handoffs ENABLE ROW LEVEL SECURITY;
-- No client policies: service-role only (server fns + public API).

-- Unified purchase-attribution ledger. One row per checkout attempt.
CREATE TABLE public.purchases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_checkout_session_id  text UNIQUE,
  stripe_payment_intent_id    text,
  stripe_subscription_id      text,
  mode                        text NOT NULL,     -- 'topup' | 'seat_plan' | 'setup_package'
  item_id                     uuid,
  item_slug                   text,
  quantity                    integer NOT NULL DEFAULT 1,
  clone_id                    uuid REFERENCES public.clones(id) ON DELETE SET NULL,
  tenant_id                   uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  handoff_id                  uuid REFERENCES public.billing_handoffs(id) ON DELETE SET NULL,
  origin_user_id              text,
  origin_username             text,
  origin_source               text NOT NULL DEFAULT 'mission_control',
  amount_cents                integer,
  currency                    text,
  payment_status              text,
  status                      text NOT NULL DEFAULT 'initiated',
                              -- 'initiated' | 'completed' | 'failed' | 'refunded' | 'abandoned'
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchases_clone_idx  ON public.purchases(clone_id, created_at DESC);
CREATE INDEX purchases_tenant_idx ON public.purchases(tenant_id, created_at DESC);
CREATE INDEX purchases_user_idx   ON public.purchases(origin_user_id, created_at DESC);
CREATE INDEX purchases_status_idx ON public.purchases(status);
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Operators read purchases" ON public.purchases
  FOR SELECT TO authenticated USING (public.is_operator(auth.uid()));
-- Writes via service role only (checkout fn + webhook).
```

Notes:
- `origin_user_id` is `text`, not a FK — it references a *foreign* auth system
  (the clone's `custom_users` table), which Mission Control cannot join against.
- Keep `setup_purchases` / `token_ledger` / `clone_seat_entitlements` as fulfilment tables;
  `purchases` is the attribution/reporting layer that spans all three modes. Do **not** try to
  retrofit attribution columns into each fulfilment table separately.
- Optional follow-up in the same migration: a cron-style cleanup (reuse the
  `hooks.expire-reservations` pattern) that marks `initiated` purchases older than 24 h as
  `abandoned` and deletes expired unconsumed handoffs.

## 4. Work plan (phased)

### Phase 1 — Attribution plumbing inside Mission Control (no cross-repo dependency)

Deliverable: every checkout initiated *by an operator* is already fully attributed and stored.

1. **Migration** — add `billing_handoffs` + `purchases` (§3.3).
2. **`src/lib/stripe.functions.ts`** — extend `InputSchema` with
   `handoffId: z.string().uuid().optional()` and (operator path) derive attribution:
   - If `handoffId` present: load + validate the handoff (unexpired, unconsumed, matching
     clone/tenant), take `origin_*` from it, mark `consumed_at`.
   - Else: `origin_user_id` = the operator's `auth.uid()`, `origin_source = 'mission_control'`.
   - Add `origin_user_id`, `origin_username`, `origin_source`, `handoff_id` to `sharedMeta`
     (they then propagate to subscription/payment-intent metadata for free via the existing spread).
   - After `checkout.sessions.create` succeeds: `INSERT INTO purchases (status='initiated', …)`
     with the session id. Failure to insert must not block checkout — log + `audit_log` instead.
3. **`src/routes/api.public.stripe.webhook.ts`** —
   - In `handleCheckoutCompleted`: upsert `purchases` on `stripe_checkout_session_id`
     (covers sessions created before this feature or where the initiated-insert failed), set
     `status='completed'`, `completed_at`, `amount_cents`, `currency`, `payment_status`,
     payment-intent/subscription ids, and copy all `origin_*` fields out of session metadata.
   - Pass attribution into fulfilment metadata: `apply_topup` ledger rows should carry
     `metadata: { origin_user_id, origin_username, origin_source }` (extend the RPC's
     `_metadata` param or write it into the ledger row post-hoc keyed on `source_ref`).
   - In `handleChargeRefunded`: also update the matching `purchases` row → `status='refunded'`.
   - New `notifications` insert on completed purchase
     (`kind: 'purchase_completed'`, body includes clone name + origin user + item + amount).
4. **Success page** — `billing.success.tsx` / `checkout-session.functions.ts`: read attribution
   from the `purchases` row so the confirmation shows *"purchased by <origin_username> for
   <clone name>"*.

### Phase 2 — Handoff API (unlocks end-user attribution from the command centers)

1. **New route `src/routes/api.public.billing.handoff.ts`** — `POST /api/public/billing/handoff`.
   - Auth: `resolveCloneApiKey(request.headers.get('x-clone-api-key'), ['tokens:read', 'tokens:meter'])`
     (introduce a dedicated `billing:handoff` scope in `clone-api-scopes.ts` and accept it too;
     existing keys keep working via the token scopes).
   - Rate limit via `checkRateLimit(key.id)` like every other public route.
   - Body (zod): `{ tenant_ref, display_name?, origin_user_id (1–200 chars), origin_username?,
     origin_source?, intent?, return_url? }`. Validate `return_url` is https and, ideally,
     matches the clone's `deploy_url` host to prevent open-redirect abuse.
   - `ensureTenant(key.clone_id, tenant_ref, display_name)` → insert `billing_handoffs` row →
     respond `{ ok, handoff_id, url, expires_at }` where
     `url = {PUBLIC_APP_URL}/pricing?h=<handoff_id>` (or `/billing/topup?h=…` when
     `intent` is a topup — match the target page to the intent mode).
2. **New server fn `src/lib/handoff.functions.ts`** — `resolveHandoff({ h })`:
   validates token (exists, unexpired, unconsumed) and returns
   `{ cloneId, cloneName, tenantId, originUserId, originUsername, intent, returnUrl }`.
   No auth middleware (the token itself is the credential), but never return more than the above.
3. **`src/routes/pricing.tsx`** — accept `h` in `validateSearch`; when present:
   - resolve it, pin the clone selector to the handoff's clone (hide/lock the dropdown),
   - show a "Purchasing for <clone> as <username>" banner,
   - pass `handoffId` into `createStripeCheckout`,
   - preserve `h` through the auth round-trip exactly like `intent`/`clone` today,
   - honour `intent` from the handoff for auto-launch (existing auto-resume effect).
4. **`src/routes/billing.topup.tsx`** — same treatment (accept `h`, derive tenant from it
   instead of requiring `?tenant=`).
5. **`api.public.tokens.packs.ts`** — optionally have the prime repo pass
   `origin_user_id`/`origin_username` when fetching packs so the minted `topup_url` becomes a
   handoff URL rather than a bare `?tenant=` link (keeps `OutOfTokensBanner` deep links attributed
   with zero extra round-trips). Keep the bare link as fallback.

### Phase 3 — Non-operator (handoff-authenticated) checkout

Today `requireOperator` blocks clone end-users from checking out. Options, in order of preference:

- **3a (recommended): handoff-scoped checkout.** New server fn `createHandoffCheckout` with *no*
  operator middleware: requires a valid unconsumed `handoff_id`, only allows the handoff's
  tenant/clone, only the item in `intent` (or any active catalog item if intent absent).
  The handoff token is single-use and expires in 30 min, which bounds abuse; Stripe itself
  handles payment auth. Mark handoff consumed at session-creation.
- **3b (fallback if 3a is deemed too open):** keep operator gating; clone users land on `/auth`
  first. This preserves attribution (the handoff still pins `origin_*`) but adds friction and
  requires issuing MC accounts to clone staff — probably wrong for the clone business model.

Also in this phase:
- `billing.success.tsx`: allow lookup by `session_id` **plus** matching `h` param (non-operator
  path) — return only the same summary fields the operator path returns.
- "Return to <clone name>" button on success/cancel pages using `billing_handoffs.return_url`.

### Phase 4 — Macro trackability: dashboard + reporting

1. **New route `src/routes/billing.purchases.tsx`** — operator-facing purchases explorer:
   - table: created_at, status, mode, item, quantity, amount, clone, tenant, `origin_username`
     (`origin_user_id` on hover/copy), `origin_source`;
   - filters: clone, mode, status, date range, origin_source; CSV export via existing `csv.ts`.
2. **Server fns `src/lib/purchases.functions.ts`** — `listPurchases` (filters + pagination),
   `purchaseRollups` (revenue + count grouped by clone / by origin_user / by month).
3. **`clones.$cloneId.tsx`** — add a "Purchases" section (recent purchases + lifetime revenue
   for that clone).
4. **`dashboard.tsx` / `metrics.tsx`** — headline tiles: revenue this period, purchases by
   source (operator vs clone-initiated), top clones by spend.
5. **Optional public read-back:** `GET /api/public/purchases?tenant_ref=&limit=&offset=`
   (clone-API-key auth, returns only that clone's rows) so command centers can render their own
   purchase history (consumed by the prime repo's Phase 4 — see its plan).

## 5. Rollout & compatibility

- Phase 1 is fully backwards compatible: old deep links keep working, attribution simply reads
  `origin_source='mission_control'` and the operator's uid.
- Phase 2 endpoints ship before the prime-repo CTAs flip over (prime repo falls back to today's
  static URLs whenever the handoff call fails — see its plan §4.2).
- Existing env vars are enough (`PUBLIC_APP_URL`, Stripe keys, service role). No new secrets.
- Webhook changes are idempotent by construction (upserts keyed on session id; the
  `stripe_events` claim logic is untouched).

## 6. Test plan

| Test | Type | Covers |
|---|---|---|
| `stripe.functions` builds `sharedMeta` with attribution (operator + handoff paths) | unit (vitest) | Phase 1/2 |
| Checkout insert failure does not block session creation | unit | Phase 1 |
| Webhook `checkout.session.completed` upserts `purchases` with metadata copied; replay is idempotent | unit w/ mocked Stripe event | Phase 1 |
| `charge.refunded` flips `purchases.status` | unit | Phase 1 |
| Handoff endpoint: bad key → 401, missing scope → 401, invalid `return_url` host → 400, happy path returns URL | integration | Phase 2 |
| Expired / consumed / unknown `h` on `/pricing` → clean fallback to normal page (no crash, no pin) | UI/unit | Phase 2 |
| Handoff survives the `/auth` round-trip like `intent` does | e2e (Playwright, Stripe test mode) | Phase 2 |
| Handoff-scoped checkout can only buy for its own tenant/clone | unit | Phase 3 |
| End-to-end: NPC CTA → handoff → checkout (Stripe test card) → webhook → `purchases` row has correct `origin_user_id`, `clone_id` → visible in `/billing/purchases` | e2e | all |

## 7. Risks & open questions

> **Re-measured 20 Sep 2026 — four of these five are not open, and one is open
> for a different reason than the heading implies.** Each bullet below states
> its own decision in the sentence that raises it; what the heading has been
> doing since is making settled policy look like a pending question. The
> attribution plan shipped — `20260710130000_purchase_attribution.sql` is
> applied and `origin_source` / `origin_username` are read in eight modules —
> so PII scope, `intent` validation, the slug-vs-id rule and the renewals rule
> are all decided **and implemented**.
>
> **Abandoned-row retention is the one still open, and it is unimplemented
> rather than undecided.** `abandoned` is in the `purchases.status` CHECK
> constraint and `purchase-backfill.server.ts` writes it on an expired Stripe
> session — but nothing anywhere deletes one: no `.delete()` on `purchases` in
> `src/server`, no `DELETE FROM public.purchases` in any migration, no pg_cron
> job naming the table. So the "suggest 90 days, then delete" below has never
> been enforced and every `initiated`/`abandoned` row since 10 July is still
> held. That is a retention decision over records of what a customer started to
> buy and did not, so it wants the owner's word before anything deletes — and a
> deletion sweep is the kind of worker `THE_CLONING_ENGINE.md` records six of as
> never scheduled at all, silently, so it must be asserted by its effect.

- **PII:** `origin_username`/emails are PII from clone systems. Keep to username only (no email)
  unless a business need appears; cover in RLS (operator-read) and note in privacy docs.
- **`intent` item validation:** handoff `intent` references catalog item ids across systems —
  validate against the live catalog at consume time, degrade to "no auto-launch" on mismatch.
- **Abandoned rows:** decide retention for `initiated`/`abandoned` purchases (suggest 90 days,
  then delete; completed rows retained indefinitely).
- **Clone slug vs id in `origin_source`:** plan uses `clone:<slug>`; the authoritative link is
  the `clone_id` column — `origin_source` is display/audit only.
- **Seat-plan renewals:** recurring invoices are *not* new purchases; only the initial
  checkout creates a `purchases` row. Renewal revenue reporting stays on Stripe/entitlements.
