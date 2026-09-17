<!-- SYNCED COPY. The canonical file is the prime's
     npc-property-dashbord/docs/builder-portal/45-network-extraction-plan.md,
     whose own header names this path as its Mission Control mirror; when the
     two disagree, the prime wins. Re-sync by copying that file over this one
     wholesale — do not edit here. Companion (measured FK boundary): the
     prime's docs/builder-portal/44-network-extraction-boundary.md. -->

<!-- Canonical home of the Builder Portal → Builders Network extraction plan.
     The Mission Control repo carries a synced copy at docs/builders-network-extraction-plan.md;
     when the two disagree, this file wins. Companion: 44-network-extraction-boundary.md. -->

# Builder Portal → Aurixa Builders Network — implementation plan (rev 2)

Extract the Builder Portal from the per-clone NPC Property Dashboard and rebuild it as a
central multi-vendor platform at `builders.aurixasystems.com.au`. One auth gateway, many
builder organisations, and a connection graph back to each workspace.

**Rev 2 supersedes rev 1 entirely.** Rev 1 was written against a month-stale checkout of the
prime (1,613 commits behind), a superseded Mission Control repo, and a first production
measurement that a second snapshot contradicted. Everything below is re-grounded on
`origin/main` of every repo as of 2026-09-14 and on executed proof, with the deltas called
out where they change a decision.

---

## Context

Every Aurixa customer gets a fork of the prime repo plus its own dedicated Supabase project.
One deployment = one tenant, with no `tenant_id` anywhere in the prime's `public` schema.
Right for the Client, Finance and Solicitor portals — those counterparties belong to one
agency. Wrong for builders: a builder's 40-unit development exists **once**, not once per
agency that sells it. So the Builder Portal leaves the clone and becomes one platform, and
clones connect to it.

### The estate, as it actually is

- **The prime** (`npc-property-dashbord`): the Builder Portal is alive and actively growing —
  60 builder migration files (59 portal + 1 finance false-positive), ~30 pages, 28 edge
  function dirs (two new since rev 1: `builder-stock-image-settler`, a background image
  worker, and `builder-stock-link-callback`, an inbound Make-scenario callback authorised by
  one-time capability tokens). The stock subsystem carries its own visual language now — the
  **drawing-set system** (`src/styles/builder-drafting.css`, `.builder-portal-theme`,
  `docs/builder-portal/VISUAL_SYSTEM.md`) — plus a server-side image pipeline, manual-stats
  overrides, and deep marketplace integration on the clone side (map pins, address
  composition, image vision).
- **Mission Control** moved: the live repo is **`Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885`**
  (PR #174, 270 migrations, 194 routes). The old `aurixa-mission-control` froze around
  PR #85/late August and is retired — PR #87 there (rev 1's reserved-slugs change) has been
  closed as superseded. The new repo adds, relevantly: **Vercel deployment provisioning**
  with a pure subdomain-allocation module that finally enforces `reserved_slugs` on the
  deploy path; an expanded clone-key scope catalogue; **`anthropic:federate`** — a signed
  identity-assertion + JWKS pattern (`api.public.anthropic.identity` / `.jwks`); and
  **`cloneMigrationStanding.pure.ts`** — clone migration standing measured against the
  clone's own ledger, with `supabase/migrations/MIGRATION_VERSION_COLLISIONS.json` (42
  version-collision groups, 98 files) frozen in the prime and CI-guarded.
- **The fleet is real**: three provisioned clones plus the prime.
- **`aurixa-systems`** is unchanged in role: a prerendered marketing site with no auth. It
  gets a "for builders" page and nothing else.

### What production holds (`dduzbchuswwbefdunfct`, snapshot 2026-09-14)

65 builder-portal tables, 147 `builder_*` functions, 3 storage buckets.

| | rows |
|---|---:|
| `builder_organisations` / `builder_portal_users` | 2 / 3 |
| `builder_stock_items` / `builder_stock_item_images` | 1,014 / 3,069 |
| `builder_stock_uploads` (all / live) | 106 / 2 |
| storage objects (749 MB total) | 1,103 |
| `builder_projects`, `builder_units`, `builder_transactions`, construction, documents | 0 |

The growth between snapshots is explained: **stock-list upload testing is in progress**
(confirmed by the user). Numbers here are evidence of what was true once — re-measure before
every phase that moves or deletes data.

**The boundary is mostly cold, and the two hardest edges have never been used:**

| Entanglement | live rows |
|---|---:|
| E1 — `transaction_case_links` builder slot | **0** |
| E2 — `builder_transactions.client_id` | **0** (no transactions at all) |
| E3 — `builder_stock_selections` | 1 |
| E4 — `aml.partner_organisations` linked to a builder org | 2 |
| E5 — `portal_terms_acceptances.builder_user_id` | 3 |
| E6 — builder rows in `cross_portal_*` | 0 |

So the FK re-point (Phase 5) is a zero-row operation; the real data move is the stock corpus
plus three small E3/E4/E5 row sets.

### ⚠ The fleet-wide SQL halt — diagnosed and fixed

Every clone's migration sync was halting, and the mechanism is now proved end to end:

1. Three builder-stock migrations carry **August version strings**
   (`20260816140000`, `20260818120000`, `20260819090000`) but were written against
   `builder_stock_uploads` **as it exists after `20260915000000` and `20260916000000`** —
   including `deleted_at`, which only `20260916000000` adds.
2. Production and the early clones hold them because they were applied in **merge order**;
   a fresh replay runs in **version order**, so it reaches `20260816140000` first and fails.
3. Mission Control's `applyPrimeMigrations` (verified in `aurixa-mission-control-12b89885`,
   `backend-provisioning.server.ts`) **halts the entire replay on the first failure** —
   "schema state beyond this point is undefined" — so nothing after `20260816140000` ever
   applies to that clone. Ten later stock files then miss `builder_stock_settlement_target`
   purely as a cascade.
4. It compounds: `20260816140000` is a **frozen version collision** with
   `20260816140000_seed_template_library_v8_investment_narrative.sql`; the builder file
   sorts first within the shared version, so its failure also blocks that seed forever.

**The fix** (landed on the working branch, in PR #2650):
`supabase/migrations/20260816130000_builder_stock_uploads_bootstrap.sql` — hoists
`builder_stock_uploads` in its **current** shape (base + the `20260916000000` additions,
verbatim), `IF NOT EXISTS`, with RLS + the service-role policy from birth. Chosen over
renumbering the thirteen affected files because renumbering would make them *pending again*
on every clone that already applied them; the bootstrap re-runs nothing anywhere — it
no-ops on the prime, on any clone that got the table historically, and on re-apply. Both
later migrations stay correct over it (`IF NOT EXISTS` / `DROP`-first by name throughout).

**Proof**: strict version-order replay of all 60 builder files — **0 failures** (was 13);
bootstrap re-applied over the full schema — clean no-op; `builder:db:network-check` now
**requires single-pass convergence**, so a future inversion fails CI and names the deferred
files; `check-migration-version-collisions` (0 new), `check-migration-security` and
`migrations:index:check` all pass.

**Rollout**: merge to prime `main` → each clone's next sync picks up the bootstrap as
pending (it sorts before the failing file), applies it, and the halted chain completes.
No clone-side action, no data movement, no MC change required. Existing clone ledgers are
untouched. After the fleet is green, confirm standing via MC's clone-ledger reading
(`cloneMigrationStanding.pure.ts`), not the cursor.

### Executed proof (Phase 0 is now partly done)

`npm run builder:db:network-check` — landed on the working branch, draft PR
[npc-property-dashbord#2650](https://github.com/Naidu-Group-Pty-Ltd/npc-property-dashbord/pull/2650) —
builds a database containing nothing of the prime except labelled fixtures, replays **all 59
builder migrations, green in 2 fixpoint passes**, creates **64 tables**, and audits the
boundary from `pg_constraint`:

- **Outbound FKs: exactly two**, both to `clients` (E2, E3). Nothing else leaves.
- **Inbound created by the builder corpus: exactly two** — the E1 case-link slot (stays in
  the clone) and `document_processing_jobs.builder_document_version_id` (the queue travels,
  so that edge becomes internal to the network).
- **The corpus was not replayable in version order** — 13 of 59 files only applied on a
  second pass, which is the same fault that halted the fleet (section above). The
  `20260816130000` bootstrap fixes it: strict version-order replay is now green in one
  pass, and the check fails if an inversion ever returns. **The network baseline is still a
  consolidated squash** — 60 files of history replayed into a fresh project is a worse
  baseline than one reviewed schema, and the collisions problem (below) doesn't travel.
- 23 non-builder-named migrations touch builder objects; 1 builder-named migration is
  Finance. **The boundary is enumerated from `pg_constraint`, never from filenames** —
  production carries **nine inbound FKs, seven `CASCADE`**, five of them from
  `cross_portal_*` tables the Solicitor cutover also lives in
  (`docs/builder-portal/44-network-extraction-boundary.md` records the full table).

---

## Corrections that stand, and new ones

1. **Not the `aurixa-systems` repo** (unchanged): prerendered marketing site, no auth, no
   component library, loose TS, no CI. The subdomain belongs to the Aurixa estate; the code
   does not belong in the marketing repo. → **New standalone repo** (user-confirmed).
2. **One trust edge, not four** (unchanged): the builder's counterparty is the workspace.
   Client/finance/legal visibility is a projection across the connection, never a session.
3. **Mission Control is the trust anchor — and it now ships the exact pattern to copy.**
   Rev 1 designed hash-introspection from scratch. The new MC already federates identity to
   clones for Anthropic: a clone presents its `mck_*` key with an `anthropic:federate`
   scope, MC returns a **short-lived signed assertion**, the relying party verifies against
   **MC's published JWKS** — MC sits on the token path about once an hour per clone and off
   the request path entirely. The Builders Network should be the second relying party on
   that machinery, not the first user of a new one (§2).
4. **The brand is the drawing set, not the Aurixa dark palette.** Rev 1 said "copy the
   marketing tokens". Wrong now: the portal has its own designed language —
   `builder-drafting.css`, `.builder-portal-theme`, title blocks, drafting line weights,
   plate-sheet stock pages — with its own mounted-usage specs
   (`builderPortalUiMounted.spec.ts`, `builderDraftingMounted.spec.ts`). It travels intact.
5. **The agreement machinery the sync design borrowed is deleted, deliberately.** The prime
   is "partner agreements — TEMPLATES ONLY": issuance/acceptance/execution and eleven shared
   modules (`syncStamp.pure.ts`, `partnerAccess.pure.ts`, `pendingDelivery.ts`,
   `useAgreementSync.ts` among them) are **gone**, with a spec asserting they stay gone,
   because *facilitating and recording a contract between two independent businesses made
   the platform look like a participant in it*. Two consequences: the sync/stamp/state
   patterns are **re-created as shapes** (this plan now carries their rules; the modules
   cannot be imported), and the connection graph must stay **access control, never
   agreement formation** — scopes are grants a side can revoke, not contracts the platform
   witnesses (§2, §6).
6. **`builders` is not a reserved slug** (unchanged, still true in the new repo — the
   `20260715032618` baseline is byte-identical). Migration written, validated three ways on
   Postgres 16, and **delivered as a git patch** for `aurixa-mission-control-12b89885`,
   because this session can read that repo but holds no push credential for it (cross-owner
   attach refused; remedy below in §10).
7. **The admin plane is mostly deleted, not moved** (unchanged) — with one addition: the
   in-portal **Compliance Passport** shipped (`partner_portal_memberships`,
   `buildCasePassportView(…, 'partner')`, per-portal surface flags), so E4 is now a live,
   designed surface rather than a stub adapter (§3 E4).

---

## Target architecture

```
                 ┌───────────────────────────────────────────┐
                 │  Mission Control (…-12b89885)             │  trust anchor · JWKS
                 │  clones · clone_backends · clone_api_keys │  operator console
                 │  platform_hosting_config · Vercel deploys │  /builders-network/*
                 └────────┬───────────────────────┬──────────┘
     assertion (builders: │                       │ provisions clones,
     federate) + JWKS     │                       │ issues mck_* keys
   ┌──────────────────────▼──────┐         ┌──────▼─────────────────────────┐
   │  Aurixa Builders Network    │         │  Clone (prime fork) ×3 + prime │
   │  builders.aurixasystems.com.au        │                                │
   │                             │◄────────┤  x-aurixa-assertion (per call) │
   │  64-table builder schema    │─────────►  builder-network-inbound (HMAC)│
   │  + connection graph         │  HMAC   │                                │
   │  ONE auth gateway           │         │  builder_network_connections   │
   │  orgs·users·inventory·stock │         │  builder_network_transactions ─┐
   │  transactions·construction  │         │  builder_network_stock_items   │
   │  delivery·collaboration     │         │  builder_network_client_refs   │
   │  own terms·docs queue·flags │         │                           FK   │
   └─────────────────────────────┘         │  transaction_case_links ◄──────┘
                                           │  (4th slot, now local)         │
                                           └────────────────────────────────┘
```

Central system of record; each clone keeps a thin mirror of only what it must join against
locally, so `transaction_cases` and `guard_transaction_case_links()` keep working unchanged
in shape.

---

## 1. Repo and deployment

**New repo `aurixa-builders` under `Naidu-Group-Pty-Ltd`.** Doesn't exist yet; see §10 for
the session-access logistics.

- **Frontend**: keep the prime's app shape — Vite + React Router + shadcn + TanStack Query,
  strict TS (`tsconfig.portals-strict.json` already exists in the prime and covers the
  portal; carry that standard). The pages, libs and query hooks port with import-path edits.
- **Visual system**: `builder-drafting.css` + `.builder-portal-theme` + the drawing-set
  components travel intact, along with their mounted-usage specs — the rule "a component is
  not shipped until something renders it; a class is not shipped until something wears it"
  transfers as-is.
- **Backend**: a new dedicated Supabase project; the 15 portal-facing functions + the two
  stock workers port as-is (Deno, no aliases). Every function gets an explicit
  `verify_jwt` declaration — the prime's `check-verify-jwt-declared.mjs` rule (an omitted
  block silently means `true`) travels to the new repo's CI.
- **Hosting**: the new MC provisions Vercel deployments and owns the Cloudflare zone; the
  network rides the same rails as the fleet — a Vercel project (or Worker; decide with the
  proxy spike) with DNS in `platform_hosting_config`'s zone and an `edge_dns_records` row
  with `purpose='platform_service'` so the fleet view knows the record is managed.
- **Turnstile**: a widget is a per-deployment `(site key, secret)` pair and `siteverify`
  hostnames are not checked by the login handlers — the network mints **its own** pair,
  exactly as MC mints one per clone. Never inherit the prime's.
- **Vendor keys and metering**: the network is a new deployment of the metering rules —
  Resend and any model calls go through `meteredFetch` with an `apiUsageBilling` entry, or
  its costs land on nobody.

### The `/fn/*` proxy (unchanged, still the single highest-leverage hardening)

The entire browser transport is one function (`invokeBuilderFunction`,
`src/lib/builderPortal.ts`) hardcoding the Supabase URL + anon key. On the network origin,
a single server route — **allowlisting function names explicitly, never a wildcard** —
forwards method/body/cookie headers, injects the anon key server-side, returns `Set-Cookie`
verbatim, and makes the API same-origin. Payoff: `__Host-builder_session_token` moves from
`SameSite=None` to `Lax` and the ambient-CSRF class disappears; keep `enforceCsrf` anyway
(it already no-ops without a cookie).

> Trap (unchanged): `createBuilderSessionCookie` lives in `_shared/auth.ts`, not in
> `builderSessionToken.ts`. The `SameSite` change and the `__Host-` assertion are in two
> files.

---

## 2. The connection graph

### Identity: a workspace is Mission Control's `clones.id`

Unchanged, and the new repo strengthens it: `resolveCloneApiKey` still returns `clone_id`;
slugs are now explicitly renameable/suffixable under `subdomainAllocation`; project refs
still change on handoff. Slug for search, FQDN for display, `clones.id` for identity.

### Trust: relying party on MC federation (revised — copy `anthropic:federate`)

Primary mechanism, mirroring `api.public.anthropic.identity` + `.jwks` exactly:

1. MC adds scope **`builders:federate`** (per-workspace opt-in, default false) to the scope
   catalogue, and a `builders` audience to the identity endpoint (or a sibling
   `api.public.builders.identity`): a clone presents its own `mck_*` key and receives a
   **short-lived signed assertion** naming `{clone_id, slug, display_name, scopes, exp}` —
   everything read from the authenticated clone's own row, nothing from the request body,
   refusal (never silent correction) when the body disagrees.
2. The clone's `_shared/builderNetwork.ts` — **the only module allowed to speak to the
   network**, the `missionControl.ts` rule — caches the assertion and sends it as
   `x-aurixa-assertion` on every network call.
3. The network verifies **offline against MC's published JWKS**. MC sits on the token path
   (once an hour per clone), never the request path. Revocation = short TTL + MC refusing
   the next mint; no fleet credential ever transits or rests in the vendor-facing service.

Fallback (kept in the plan as the simpler alternative if the identity endpoint turns out to
be Anthropic-specific in ways not worth generalising): `sha256(mck key)` introspection with
a 300 s cache — the network never sees or stores a raw key either way.

**Scopes MC adds**: `builders:federate` (workspace opt-in), `builders:operate` (the operator
console → network admin API, NULL-clone platform key). The old `builders:introspect` is only
needed under the fallback.

### Schema (network side) — unchanged in shape, restated

`workspace_registry` (MC directory cache, `mc_clone_id` unique), `workspace_connections`
(org × workspace, `state`, `initiated_by`, `scopes[]`, per-connection webhook secrets,
partial-unique on live rows), `connection_scope_keys` (seeded:
`transactions:share, stock:publish, construction:share, collaboration:messages,
delivery:handover, documents:share, aml:reliance` — each directional),
`workspace_connection_events` (append-only).

- States are **`none | invited | active | revoked`, revoked terminal, re-connection is a new
  row**. The module that carried this shape (`partnerAccess.pure.ts`) is deleted from the
  prime; the network re-creates the shape as its own pure module, and this plan is now the
  reference for its rules.
- Both onboarding paths (user-confirmed): workspace-initiated invite (short-lived hashed
  invite code) and builder-initiated application. **An invite matching an existing ABN or
  contact email becomes a connection request against the existing organisation, never a
  second organisation.**
- **Connections are access control, not agreements.** The prime deleted agreement formation
  because facilitating contracts between independent businesses made it look like a
  participant. Scopes are unilateral, revocable grants; no signature ceremony, no execution
  record beyond the audit trail. If a commercial agreement is ever needed, it is a template
  download, per `TEMPLATES_ONLY.md`.
- On revocation, the clone's mirror rows **freeze, never delete** — deleting them breaks
  `transaction_case_links` FKs.
- Network → clone remains **HMAC-SHA256 over the raw body** to `builder-network-inbound`,
  per-connection secrets minted by the clone at connection time (nothing writes Supabase
  secrets programmatically). The `mission-control-webhook` shape, `constantTimeEqual` included.

---

## 3. The six entanglements (boundary now measured; see doc 44 for the FK table)

### E1 — `transaction_case_links.builder_transaction_id` + guard (unchanged design, 0 rows)

Clone keeps the column, constraints, widened CHECKs and trigger column-list byte-identical.
New clone table **`builder_network_transactions` whose PK IS the network's transaction id**
(cutover is a pure FK re-point), carrying `connection_id` (set-once, trigger-enforced in the
`builder_enforce_stock_selection_org` shape), nullable `client_id → clients ON DELETE SET
NULL` (the guard's assertion column), status/stage, `remote_updated_at`, `source_version`.
Guard's fourth branch changes one identifier + gains a `NOT FOUND →
BUILDER_TRANSACTION_NOT_MIRRORED` message; `CROSS_CLIENT_CASE_LINK` stays byte-identical
(e2e asserts the string). A missing mirror row already fails closed (`SELECT … INTO` leaves
NULL; `NULL IS DISTINCT FROM case_client` is true).

Staleness: webhook → **sweep, not queue** (idempotent reconcile; ask what's waiting,
subtract what's applied) → synchronous re-validation on link creation, the one synchronous
cross-boundary call.

### E2 — `builder_transactions.client_id` (unchanged, 0 rows)

Becomes `connection_id` + `remote_client_ref` + `remote_client_label`, all nullable
(`CHECK ((connection_id IS NULL) = (remote_client_ref IS NULL))`) — unsold inventory and
direct-to-public sales exist. **`remote_client_ref` is a stored random uuid per
(connection, client), never an HMAC** — a derived ref is a cross-vendor correlation handle.
Clone keeps the reverse map (`builder_network_client_refs`), revocable and rotatable.

### E3 — Stock marketplace (bigger than rev 1 knew, still the same split)

The stock subsystem is now ~38 of the 59 migrations, an image pipeline (settler worker,
sanitisation/eligibility ladders), manual-stats overrides, and **an inbound Make callback**
(`builder-stock-link-callback` — one-time capability tokens, caller authority read from the
row this product wrote when it asked; the design survives relocation as-is, but **the Make
scenario's target URL must be re-pointed to the network origin at cutover**).

Split unchanged: items/uploads/images/pipeline are builder-owned and travel;
`builder_stock_publications` (visibility per connection) and
`builder_stock_selection_announcements` (**no `client_id`, no `internal_notes`, ever**) are
new network tables; the clone keeps `builder_stock_selections` with `stock_item_id`
re-pointed at a `builder_network_stock_items` mirror (same PK trick), `client_id` /
`selected_by_user_id` / `internal_notes` staying — they were always Command Centre data.
Gate = clone flag `builder_stock_marketplace` (fails closed; **read through the server,
never the table from a browser** — the flag-read trap is documented three times over) AND
`stock:publish` on the connection. `BuilderStockTab` + `marketplaceBuilderStock.ts` stay in
the clone re-pointed at the mirror; the clone-side listings integration (map pins, address
composition, `StockPicture`) already reads projections and keeps working from mirror data.

> `builder_stock_selections.selected_by_user_id` holds an `auth.users` id **by convention
> with no FK** — strip it in the export transform.

### E4 — AML / Compliance Passport (revised: the surface shipped)

Reliance is the reporting entity's obligation → per-connection, never central (unchanged).
What's new: the in-portal **Compliance Passport** is live machinery —
`partner_portal_memberships`, enrolment that maps a real portal identity and never re-points
an existing binding, `buildCasePassportView(…, 'partner')` as the single assembler,
per-portal surface flags resolved **server-side**, and a nav-placement spec (compliance
entry second in every portal).

Design consequence: the network portal keeps the same UI surface, but its data path becomes
**network → clone server-side call** (the browser never crosses origins): the network
resolves the builder session, then calls the owning clone's `aml-reliance` with a
network-signed assertion carrying `{connection_id, remote_organisation_id, actor_ref,
actor_label}`; the clone verifies against the connection secret and re-runs the same
org-vs-connection cross-check it does today, sourced `'builder_network_connection'`.
`aml.partner_organisations.builder_organisation_id` loses its FK (kept as an opaque remote
identifier) and gains `builder_network_connection_id`. `BUILDER_FORBIDDEN_KEYS` is
re-asserted on **both** sides. AML metering stays with the clone — the workspace pays for
AML on its own cases. Passports accumulate per connection in the portal's filing-cabinet
pattern; `subject_label` is only sent where the partner may read the matter (the existing
disclosure rule, now enforced across a network boundary).

### E5 — Terms (unchanged)

Network gets its own `builder_terms_versions` / `builder_terms_acceptances`. The prime's
generalised tables are **never un-generalised** (MIG-01 is one-way): delete builder rows,
keep `builder_user_id` with a dead-column comment.

### E6 — Release-control plane (unchanged)

Builder branches deleted, not migrated; `builder_organisations.status` covers what the flag
gated. Five `cross_portal_*` tables hold CASCADE FKs to `builder_organisations` — Phase 7
drops the constraints explicitly, or dropping the org table takes Solicitor cutover state
with it.

---

## 4. Builder-owned vs connection-scoped (unchanged, one addition)

The schema is already two-party (`builder_projects` carries both `developer_organisation_id`
and `builder_organisation_id` with a differ-CHECK); multi-vendor is a new axis, not a new
concept. Builder-owned: identity, inventory, stock (including manual-stats overlays —
`manual_stats` is read-time decoration and travels untouched), documents, tasks. Connection-
scoped: transactions, reservations, publications, announcements, delivery/handover,
workspace-originated notifications. The three deliberate exceptions stand: construction
cases builder-owned with optional connection; transactions' connection nullable;
**collaboration participant-scoped** (`builder_user | organisation | workspace`,
`num_nonnulls(...)=1`), fanned out per workspace participant through its own privacy
contract.

RLS stays service-role-only everywhere; the browser holds no Supabase credential once the
anon key moves into the proxy; `security-check.mjs` travels and keeps asserting zero
browser storage.

---

## 5. The auth gateway (unchanged core, three additions)

The existing gateway is already multi-org and already the cleanest of the four portals
(cookie-only `__Host-` token, hashed sessions table failing closed without the pepper,
derived governance, deny-by-default permissions, no browser storage, Turnstile + rate
limits). Changes:

| Change | Where |
|---|---|
| Origin allowlist → `https://builders.aurixasystems.com.au` + localhost | `builderSessionToken.ts` |
| Delete Lovable-specific CSRF carve-outs | `csrfGuard.ts` |
| `carriesForeignPortalSession` → a `__Host-`/no-`Domain` assertion (the portal is a sibling subdomain of every tenant; this is the axis that matters now) | `builderSessionToken.ts` + a test |
| `SameSite=None → Lax` once the proxy lands | `_shared/auth.ts` cookie factory |
| `/fn/${fn}` + drop the bundled anon key | `builderPortal.ts` |
| Insert `email_verification_required` **second** in the governance chain | `builderPortalAuth.ts` |
| **New**: per-deployment Turnstile pair; **new**: explicit `verify_jwt` declaration per function; **new**: network's own flag table read server-side only | config / CI |

Registration (both paths, confirmed): `builder-portal-register` (unverified user + org at
`pending_verification` + owner membership) and `builder-portal-verify-email` (own token
table in the reset-token shape — never the invite table). Org claiming: ABN capture → hold
for lookup/operator approval; existing org → join request to owners; **never auto-join on a
domain match**.

Admin plane disposition (unchanged): agency-edits-builder-data functions **deleted**;
member/permission/org admin **lifted into the portal** re-gated on org-owner permissions;
approval/suspension/deletion-lifecycle/quarantine/moderation into the **MC operator console
at `/builders-network/*`** (never `/modules/builder`, which is the unrelated entitlement
Module Builder), calling the network's admin API with a NULL-clone key scoped
`builders:operate` — MC must not hold the network's service-role key. Plus the small clone
"Connected Builders" surface.

---

## 6. Sync (mechanism unchanged; provenance changed)

Direction table stands as in rev 1: MC → network (directory, key validity); network ↔ clone
(connection state, network authoritative); clone → network (client refs, selections —
labels only, never PII); network → clone (transactions, stock content, construction
progress, acknowledgements); `transaction_case_links` and terms **never cross**; AML content
never leaves the clone.

- **Polling stamp**: the four-scalar shape (`count`, `latest`, `pendingRequests`,
  `attention`), `stampKey`/`stampsDiffer`, 20 s human-facing / 5 min server reconcile —
  re-created as a network-owned pure module. The rules that were earned and must carry:
  **a null previous stamp is not a change** (or every worker restart resyncs every
  connection); the stamp is stored **with its scope**, and the scope is `connection_id`;
  the stamp says *whether*, a monotonic `source_version` says *what*.
- **Outbox + privacy contract, both directions**: extend the clone's existing
  `cross-portal-outbox-worker` (claiming, idempotency, forbidden-key check, **throw rather
  than filter**, `critical` operational event) with a `builder_network` aggregate; the
  network gets the mirrored module. Forbidden sets as in rev 1 (client PII, internal notes,
  staff ids, other connections' identity, cost/margin fields, everything AML).

---

## 7. Execution phases

Deploy order inside every phase: **Mission Control → network → prime** (the anchor answers
before anyone asks; the prime is the fleet). The two hard edges are cold, so Phase 5 is a
zero-row re-point; the stock corpus is the real data move.

**Phase 0 — inventory, harness, reservations.** ✅ mostly done:
- ✅ **Fleet halt fixed**: `20260816130000_builder_stock_uploads_bootstrap.sql` — strict
  version-order replay 0/60 failures, no-op on re-apply, all migration CI gates green — in
  PR **#2650**. Merge this first; it is independent of everything else in the programme.
- ✅ `builder:db:network-check` green (60/60 in **one pass** — single-pass convergence is
  now enforced, so a returning inversion fails CI), 64 tables, boundary audited — PR **#2650**.
- ✅ Boundary doc `docs/builder-portal/44-network-extraction-boundary.md`.
- ✅ MC `reserved_slugs` migration written, validated (extend default + union row + dedupe;
  idempotent; warns-not-fails on a squatting clone), **delivered as a patch** for the new
  repo; old-repo PR #87 closed as superseded.
- ⬜ Land the patch in `aurixa-mission-control-12b89885` (blocked on session access, §10).
- ✅ **Extraction manifest**: `npm run builder:manifest` — exact row counts per builder
  table, the storage corpus, E1–E6 sized by live rows, the `pg_constraint` boundary with
  its delete rules, and the Phase 4 debris, written as a diffable JSON document.
  `--compare latest` reports what moved; `--fail-on-drift` fails when the SHAPE moved (a
  table, a view, a boundary edge, a migration between the two) rather than when the corpus
  grew. Every reading is a value or an explicit null with a reason — a manifest carrying a
  failed read exits non-zero and says it must not authorise a copy or a delete, because a
  count that silently failed and printed `0` reads exactly like an empty table. Re-run it
  before every phase that moves or deletes anything.

**Phase 1 — MC trust anchor.** In the new MC repo: `builders:federate` + `builders:operate`
scopes; generalise the identity/JWKS endpoint to a `builders` audience (or add
`api.public.builders.identity`); the shadow connections ledger (operator visibility only,
never authoritative); the `edge_dns_records` platform_service row. Unreachable without the
scopes → revoking them is a complete rollback.

**Phase 2 — stand up the network.** New repo + Supabase project. **Squash the 59 migrations
into a consolidated baseline** (mandatory — the corpus cannot replay in order; the harness's
fixpoint log is the dependency order, and `02-network-standalone.sql`'s shim list is the
edit list: when the squash is right, it applies against Part 1 alone). Carry every
explanatory comment. Port the 15 portal functions + 2 stock workers + new
register/verify-email/connections/stamp/inbound/outbox-worker functions, each with explicit
`verify_jwt`. Port the frontend with the drawing-set system and the strict-TS config. Wire
CI: `typecheck:builder-edge`, `test:builder-portal`, `security:builder-portal`,
`builder:db:network-check` (now proving the squash), verify-jwt declaration check.

**Phase 3 — clone-side mirror.** Prime, additive only: the four `builder_network_*` tables;
`_shared/builderNetwork.ts`; `builder-network-inbound`; outbox aggregate; all behind
`feature_flags.builder_network_enabled`, default false, fails closed, **read server-side**.

**Phase 4 — move the data.** Runbook with fresh measurements: [`46-phase4-data-move-runbook.md`](./46-phase4-data-move-runbook.md). Re-measure first (it grows while we work — stock testing is
live). Two orgs, three users, the stock corpus (1,014+ items, 3,069+ image rows, 749 MB+
objects across 3 buckets), the E3/E4/E5 rows. Re-issue invitations rather than porting
password hashes. Strip `selected_by_user_id` / `internal_notes`. **Reconcile the soft-delete
debris before copying** (104/106 uploads deleted, 138 orphaned image rows) — don't import
someone else's mess into a fresh database. Create the NPC clone's `workspace_connections`
row. **Re-point the Make scenario's link-recovery callback to the network origin.** Verify
with the harness's verifiers pointed at the network project.

**Phase 5 — re-point the FK.** ✅ Executed as
`20261122000000_builder_network_phase5_inbound_fk_release.sql`: all nine inbound
constraints released by their measured production names behind a per-edge orphan gate
(measured at execution: E4 2 rows / E5 3 rows, every other edge 0, orphans 0 everywhere);
columns kept as opaque remote references (Phase 4 preserved organisation ids, so the AML
partner links and consent records keep naming the same entities); every check and drop
`to_regclass`-guarded so a clone provisioned after Phase 7 — where the builder tables never
exist — replays it as a clean no-op. The same file carries the §3 E1 re-point in the
original's ship-together discipline: `builder_network_transactions` created (PK IS the
network's transaction id; connection set-once; service-role-only RLS),
`transaction_case_links.builder_transaction_id` re-FK'd onto it `ON DELETE SET NULL`
behind its own zero-orphan gate, and the guard's fourth branch reads the mirror with
`NOT FOUND → BUILDER_TRANSACTION_NOT_MIRRORED` while `CROSS_CLIENT_CASE_LINK` stays
byte-identical — without this half, the first post-cutover link would be refused against
yesterday's copy and Phase 7 would leave the trigger reading a dropped relation. Verified
by execution: `builder:db:verify:transactions` 113/113 on a live PostgreSQL, second apply
included. Deferred BY NAME to Phase 6/7 (it needs the stock mirror, which does not exist
yet): `builder_stock_selections` (1 row) stays in the clone per §3 E3 but still carries
seven FKs into builder tables — Phase 7's drop list must exclude it and release those
first. Reversal valid only until Phase 7 — that window is a hard gate.

**Phase 6 — turn `/builder/*` off in the clone.** ✅ Executed. Every `/builder` path
resolves to one redirect (`BuilderPortalMoved`, the SPA's 302: `location.replace` onto the
network origin named once in `src/lib/builderNetworkOrigin.ts`) carrying `?from=<hostname>`
— the hostname rather than the MC slug, because the slug has never been published into a
clone's bundle and the hostname is the workspace's public name, resolvable by MC. The
announce-first precondition was met in order: accounts and stock migrated in Phase 4, the
three owners emailed before the redirect merged. The sixteen portal-session functions are
retired from deploy (filtered out of every list branch of the workflow, explicit dispatch
requests included — bringing one back is a reviewed edit, not a form field) and from
`typecheck:builder-edge`; they stay in the repository and in `config.toml` until Phase 7
deletes them, and their live deployments keep answering session cookies until then — which
is why the admin plane's freeze exempts CONTAINMENT. The eight `builder-*-admin` functions
are read-only by server-side refusal now (`_shared/builderPortal/adminFreeze.ts`, one rule
classified by each function's own `READ_OPERATIONS`, drift-guarded by
`src/lib/security/builderAdminFreeze.spec.ts`): record mutations answer 403 naming the
network, reads stay, and suspension / membership revocation / session revocation survive
because removing a ceremony must never remove a control. The E4 in-portal Passport door is
closed structurally (`portalHandoff` → `portal_moved` for the builder surface, checked
before enrolment and the flag) until E4's network → clone server-side call ships; the
emailed `/passport/<token>` link — portal-independent — remains the builder partner's way
in, and at execution exactly one live grant (one builder partner organisation) read
through the portal. Portal pages are unrouted, never deleted — Phase 7 removes the files.
The non-CI static suite `tests/builder-portal/` still documents the PRE-move portal (63
failing assertions after the cut, 44 of them pre-existing; every added one pins the old
route tree) — it is the record of a surface that left, and it retires at Phase 7 beside
`security:builder-portal` and the schema, never gets “fixed” to describe the redirect.

**Phase 7 — delete from the prime.** One-way; soak first.
- Delete the 59 builder migration files. Before deleting, check each against
  **`MIGRATION_VERSION_COLLISIONS.json`**: `applyPrimeMigrations` skips by VERSION, so
  deleting a builder file that shares its version with a surviving non-builder file
  *changes which file a fresh clone gets at that version*. Ten of the 42 collision groups
  are in the prime's ledger; several involve builder files. Resolve those cases explicitly
  (renumber the survivor or fold it) rather than delete blind.
- Standing after deletion is now measured by **`cloneMigrationStanding.pure.ts`** against
  each clone's own ledger — extra applied versions raise no alarm, and the rev 1 worry
  about a cursor regression is largely retired by that module; verify on one clone before
  fleet rollout.
- One decommission migration through the clone-sync path: **drop the nine inbound
  constraints first** (five cross_portal CASCADE, terms, doc-jobs, aml, case-links), then
  tables in reverse FK order, then storage. **Every statement `IF EXISTS`** —
  `applyPrimeMigrations` halts a clone's whole replay on first error. Archive per-clone
  dumps first. Delete builder rows from `portal_terms_acceptances`, keep the dead column.
  Drop `security:builder-portal` from the `security:test` chain and audit that chain.
- Never `DROP TABLE … CASCADE` — that is how Solicitor cutover state and every portal's
  consent records die.
- Drop, don't leave dormant: a 65-table schema nothing tests any more is pure attack
  surface.

**Phase 7 execution record — in waves, because the deletion is not one act.** The client
marketplace (`builder-stock-marketplace`) serves paying customers off five builder tables,
so dropping the schema in one migration would have taken the marketplace down with the
portal. The order that keeps it up:

- **Wave 1 ✅ (PR #2659).** The archive precedes everything: `builder_archive` live on the
  prime — 66 snapshots, 6,222 rows, counts verified against sources, no anon/authenticated
  grants (the same SQL re-runs idempotently as the decommission migration's opening).
  `decommission-builder-portal-functions.yml` deletes the sixteen retired portal-session
  deployments on dispatch — allow-listed to exactly those names, absent-tolerant, project
  ref resolved as the deploy workflow resolves it. Dispatched after merge; the sixteen
  verified gone from the project while the admin family, pipeline workers, marketplace
  read and network sync door still answer. And `PartnerOnboardingWizard` stops walking
  the doomed step: builder partners get `portal_moved` (no provisioning call, no invite,
  no enrolment), the emailed Passport link named as their way in.
- **Wave 2 ✅ (this change).** The marketplace stops reading anything Phase 7 deletes:
  `20261123000000_builder_network_stock_mirror.sql` creates `builder_network_stock_items`
  / `_item_images` / `_organisations` — full column shape, PK-no-default ids (the
  network's ids, per E3), service-role-only RLS — and seeds them from the source tables
  in the same file (`to_regclass`-guarded, ON CONFLICT DO NOTHING, so a post-deletion
  clone no-ops the seed and takes sync data later). Every read in
  `builder-stock-marketplace` re-points at the mirrors; `supply_builder_image` /
  `create_builder_image_upload` refuse 410 `builder_stock_images_moved` (they wrote the
  dying pipeline); `select_for_client` resolves attribution from the item's own
  `created_by_builder_user_id` (the uploads cross-read retires) and no longer writes
  `builder_notifications` (a feed with no reader); the Command Centre card's "Add a
  picture" control became a disclosure. Image BYTES stay in the prime's
  `builder-stock-images` bucket and rows keep naming them — storage moves in wave 4,
  after the network serves mirror imagery over the connection.
- **Wave 3 ✅ (this change) — the one-way deletion.** Every name below is measured, not
  recalled. `20261124000000_builder_portal_decommission.sql`, ordered: quiet the two
  dynamic settlement jobnames (guarded — the prime holds zero); re-run wave 1's archive
  for clones (to_regclass-guarded, count-manifested; the prime no-ops on all 68
  relations); delete the 3 builder rows of `portal_terms_acceptances` (archived slice
  first, columns and CHECKs untouched); drop the portal's own view and redefine the two
  SURVIVING views shape-identically without their builder legs, `security_invoker`
  stated (`partner_agreement_records`, `cross_portal_rollout_reconciliation` — a view
  blocks DROP TABLE, and nothing here may CASCADE); re-shape `builder_stock_selections`
  (six FKs released by measured names, `stock_item_id` re-pointed at the mirror
  SET NULL per E1's precedent with its NOT NULL dropped, the org guard swapped onto the
  mirror byte-identical, and the whole table CREATE IF NOT EXISTS in final shape because
  its creating migration is deleted and the table survives); break the one FK cycle
  (`builder_stock_items_primary_image_fk` — note `_fk`); drop the 63 tables
  children-before-parents (58 topo-sorted over the live FK graph + 5 isolated); then
  drop 168 functions with identity args, AFTER the tables — every measured dependent was
  a trigger or CHECK on a dropped table, and the survivors
  (`builder_enforce_stock_selection_org`, `builder_stock_touch_updated_at`,
  `guard_transaction_case_links`, `resolve_cross_portal_feature_mode_for` — full body
  reads only surviving tables) are excluded by name. Repo side: **70** builder migration
  files existed, not the plan's 59 — ten hide under UUID filenames, found by content —
  and 69 are deleted while `20260810000000` is RECLASSIFIED (its shared release-plane
  columns survive; its builder functions were dropped by the migration anyway), which
  keeps its collision group intact; the collision JSON loses 10 groups and edits 1, and
  `security:migration-versions` stays green both ways. 27 function directories deleted
  with their `config.toml` blocks (409 declare `verify_jwt`, checker green); the deploy
  workflow's RETIRED machinery removed with the dirs it guarded; the decommission
  workflow WIDENED to the 12 further deployments (the reviewed edit its header
  demanded), including `builder-stock-inpaint-probe`, which was deployed but never had
  a directory. `aml-reliance` severed at both sites (`resolveBuilderSession` gone; the
  workspace resolver and both enrolment ops answer 410 `portal_moved`), releasing the
  three session modules; `_shared/builderStock` kept the marketplace's 11-module
  closure + `builderStockAddress.pure` (imported from `src` — the sweep that found it
  is why closures are verified against BOTH sides), and `primaryImage.ts` lost its
  pipeline half, which wrote a dropped table. Frontend: both portal trees, the Command
  Centre admin surface (its edge functions read dropped tables; the archive is the
  operator's record), 16 orphan libs, `builder-drafting.css`, and
  `addressWithoutLeadingDesignation` MOVED into the address module for the card titles
  that survive. ~120 repo paths deleted (95 pipeline test files); 5 builder-stock specs
  and 13 surviving-surface contract tests rewritten to the moved contract. **Fresh-clone
  replay safety**: surviving migrations that referenced builder tables were edited —
  the FK clauses Phase 5 released live are removed from 20260801000300/000400,
  20260805100000 and its UUID twin (fresh = fleet), and both surviving views' creating
  migrations carry the builder-less definitions (a view is validated at creation) —
  then PROVEN by differential replay of the full surviving corpus against main's on a
  local PostgreSQL 16.
  Deliberately untouched: `builder_invoices` / `build_progress_payments` (finance
  tables wearing the prefix, zero FKs into the component — measured), the terms portal
  CHECK still admitting 'builder' (a valueless vocabulary entry, not a surface), and
  `_shared/auth.ts`'s builder cookie writer (caller-less; a later tidy).
- **Wave 3 tail ✅ — applied and verified on the live prime (14 Sep 2026).** The first
  dispatch REFUSED, and correctly: `2BP01 cannot drop table builder_allocations because
  other objects depend on it — function builder_create_allocation(…) depends on type
  builder_allocations`. **A function declared `RETURNS <table>` holds a hard pg_depend
  edge on that table's composite ROW TYPE**, so §8's drop came too late for §7. The
  census behind that order asked what each table HOLDS (triggers, CHECKs, foreign keys)
  and never what holds the table, and no body-text scan can see the class at all —
  measured on the live prime, **46 functions** carry a doomed row type and block **38 of
  the 63** tables, including `claim_builder_stock_image_work` and
  `complete_builder_document_processing`, which do not even wear the prefix. The
  differential replay could not have caught it: the degraded harness never created those
  functions. New **§6.5** releases exactly that set before §7 and is **derived from the
  catalogue rather than listed** — a second copy of 46 identities is a list to drift
  from, and the doomed set needs no second list either (builder-prefixed tables minus the
  named survivors), a predicate checked against the live prime before being trusted:
  it returns **63**, §7's hand-written list exactly, catching **0** survivors. The failed
  run left nothing behind (one implicit transaction, full rollback), so the file was
  EDITED rather than repaired by a second migration — it described an act that had not
  happened anywhere yet. Applied on run #52; verified by effect, thirteen measures:
  **0** portal tables, **0** portal functions, **0** builder terms rows, **0** residual
  builder FKs on `builder_stock_selections` with **1** mirror FK, the org guard reading
  the mirror, both views kept and the portal's own gone, `builder_archive` intact at 67
  relations, the version recorded, and the marketplace's supply untouched (2
  organisations, 1,014 items, 2 active, 2,931 images). The widened decommission workflow
  then removed the 12 remaining deployments: of 419 edge functions, the builder family
  is now exactly `builder-stock-marketplace` and `builder-network-inbound`.
  A follow-up ([#2662](https://github.com/Naidu-Group-Pty-Ltd/npc-property-dashbord/pull/2662))
  clears the CI-only surfaces the deletion could not see from `supabase/` and `src/`:
  both Cloudflare workers (the PDF one imports the deleted shared election; the image
  one's only dispatchers were the deleted settler and inpaint probe), their ci.yml job
  and typecheck step, the two now-targetless secrets workflows, the deleted
  builder-portal security checker still named in the security job's own step list, and a
  vitest step whose four filter paths had all been deleted — **vitest exits 1 when every
  filter matches nothing**, so the step kept for the portal would have failed for not
  finding it. The two workers remain DEPLOYED on Cloudflare: deleting a directory does
  not undeploy, so that removal is account-side and outstanding.
- **Wave 4 (deferred, post-connection).** Delete the storage bytes once the network
  serves the mirror's imagery — dropping them earlier blanks every card.

**Phase 8 — marketing. ✅ (14 Sep 2026)** `/builders` on `aurixa-systems`
([PR #204](https://github.com/Naidu-Group-Pty-Ltd/aurixa-systems/pull/204)) — what the
network is, four steps to get listed, the Passport arriving already attested, and both
primary actions leaving for `builders.aurixasystems.com.au`. No auth was added. Wired the
way that repo requires rather than the way it looks: an **eager** import (a lazy route
prerenders as an empty shell and fails the build), a `ROUTE_METADATA` entry (the suite
fails a route with no entry and an entry with no route), the `llms.txt` Product section,
regenerated `sitemap.xml`/`llms.txt`, a footer link and a cross-link from `/industries` —
the supply side of the same market, so the two point at each other. Two decisions
recorded there: the hero visual is LOCAL (the three `*HeroVisual` components are one per
page, and one list reaching many firms is not among them) and it is deliberately **not in
the navbar**, because that bar was already at its overflow limit at `lg` with seven items
and needed resizing for the eighth. 276/276 including the prerender gates — one real
`<h1>`, 35 KB of markup against a 5 KB floor.

**And the network now wears the brand** ([aurixa-builders PR #3](https://github.com/Naidu-Group-Pty-Ltd/aurixa-builders/pull/3)),
which was not in the plan and should have been: the portal was still in the prime's
inherited cream-and-purple scheme, so a builder crossing from the marketing site met what
looked like a different company. Every colour is now a conversion of a token in
`aurixa-systems/src/index.css`'s `@theme` block, with Inter and Playfair Display
self-hosted, and the portal opens dark because the site is dark and only dark. The rule
that carries it: **that palette had three authorities** — the stylesheet paints the first
frame, `BrandProvider` writes the same tokens INLINE (which win), and the white-label
resolver used to derive four of them — so a disagreement is a page that changes colour on
hydration. The CSS is generated from the maps, the provider applies the maps, and a spec
fails on drift. Running the resolver over a fully declared palette was itself destructive
(it replaced the focus ring and the hover fill with the primary, and the chart ramp with
hue rotations of it); that derivation is for a tenant who picks ONE colour.
**And rendering the page found a real bug no reading would have**:
`getReadableForeground` chose its ink at a luminance threshold of 0.45 when the crossover
is 0.1791, so the teal button drew white text at **2.93:1**. It measures both candidates
now — the same button is **6.74:1**.

---

## 8. Verification

- **Exists now**: `builder:db:network-check` (fixpoint replay + `pg_constraint` boundary
  audit; already caught one wrong assumption — the doc-jobs inbound edge — during its own
  development). Travels to the network repo to prove the squash.
- **Travels**: 22 unit suites + 9 e2e suites + the local-db verifiers + the security checks
  (`security:builder-portal`, migration-security keeplist policy, verify-jwt declarations,
  mounted-usage specs for the drawing-set UI).
- **New tests** (rev 1 list stands): `__Host-`/no-`Domain` sibling isolation; guard parity
  (`CROSS_CLIENT_CASE_LINK` byte-identical + `BUILDER_TRANSACTION_NOT_MIRRORED`); privacy
  contract both directions (throws, records critical event); assertion verification
  (JWKS path: expired/wrong-audience/revoked-scope refused; MC never sees a raw key on the
  fallback path); connection state machine (revoked terminal, re-connection is a new row);
  stamp rules (null-previous, scope-keyed); reconciliation convergence + idempotence;
  decommission idempotence (with-tables / without-tables / twice); proxy allowlist refusal;
  invite-dedup (existing ABN → connection request, never a second org).
- **End-to-end manual script** (rev 1's stands, two updates): step 0 becomes "MC issues a
  `builders:federate`-scoped key and the clone fetches an assertion"; add "re-point a Make
  link-recovery callback and complete one recovery round-trip against the network".

---

## 9. Rules that bite (consolidated)

- **The scoping root does not move.** `builder_organisations.id` was always the boundary.
  Anything adding `workspace_id` to a builder-owned table has misread the model.
- **The mirror is a boundary, not a cache** — fails closed on absence, re-validates
  synchronously on link creation, converges by sweep. A webhook is not delivery.
- **The boundary is `pg_constraint`, never a filename** — 23 non-builder-named migrations
  touch builder objects; one builder-named migration is Finance;
  `cross_portal_reconciliation_runs`'s builder FK appears in no builder file at all.
- **A version string is a replay position, not a date** — files written against a later
  file's tables halted the whole fleet. The `20260816130000` bootstrap fixed the standing
  instance and `builder:db:network-check` fails on a new one; a migration must apply
  against the schema as it exists at its own version.
- **Version collisions make deletion tricky**: `applyPrimeMigrations` skips by version;
  deleting one file of a shared version changes what fresh clones get. Check
  `MIGRATION_VERSION_COLLISIONS.json` per deleted file.
- **Drop inbound constraints before tables; never let CASCADE decide** — seven of nine
  inbound FKs cascade, five into Solicitor-shared tables.
- **A dependency census must ask BOTH directions.** What a table holds (triggers,
  CHECKs, foreign keys) is the easy half; what holds the table is the half that
  refuses the drop. `RETURNS <table>` binds a function to the table's composite ROW
  TYPE, invisible to any scan of function bodies and to a replay harness that never
  created the function — 46 of them, blocking 38 of 63 tables, and the first apply
  found every one of them at once. Ask `pg_depend` from `pg_proc` to `pg_type` before
  ordering a teardown, and where the set can be DERIVED, derive it: a list of 46
  identities beside an existing list of 168 is a second thing to drift from, and the
  clone whose catalogue differs by one is the one it fails on.
- **`__Host-` is structural** — the portal is a sibling subdomain of every tenant; the
  cookie factory lives in `_shared/auth.ts`, not where an auditor will look.
- **A deterministic client ref is a correlation handle** — mint random per (connection,
  client).
- **The projection throws, never filters.**
- **Connections are access control, never agreement formation** — the platform deleted
  agreement facilitation on purpose; do not rebuild it under another name.
- **The credential stops travelling; the call travels** — the platform's own rule, now
  proven three times (listings broker, verification broker, Anthropic federation). The
  network is the next relying party, not a new credential system. Neither MC nor the
  network ever holds the other's service-role key.
- **`is_active` is not "can sign in"; `not_required` is not "clear"** — model access and
  obligations as states, never booleans.
- **`connection_id NOT NULL` invents counterparties** — builders build and sell without a
  workspace.
- **A proxy at your own origin is an open relay unless it allowlists.**
- **Flags are read through the server, never from the browser** — RLS filters instead of
  erroring, so a browser read returns `[]` with HTTP 200 and every flag coerces false;
  three surfaces have hit this, `useBuilderStockMarketplaceFlag` among them.
- **An unmapped vendor call is billed to nobody** — `meteredFetch` + billing map, or the
  network spends invisibly.
- **Re-measure before every destructive phase** — the dataset grows while we work, and two
  snapshots forty minutes apart disagreed by an order of magnitude once already.
- **A component is not shipped until something renders it; a class until something wears
  it** — the portal's own visual system learned this twice; the ported repo keeps the specs
  that enforce it.

---

## 10. Open items and logistics

1. **Repo access** — RESOLVED: the live MC is a session source and Phase 0–1 landed there
   directly (PR #175); `aurixa-builders` exists under `Naidu-Group-Pty-Ltd` (public, CI
   green, PR #1) with the network's Supabase project `htfluofznhxeumblwbww` provisioned
   and its schema applied and fingerprint-verified against the committed baseline.
2. **Old MC repo**: PR #87 closed as superseded. If the old repo is fully retired, consider
   archiving it so the two stop diverging silently — the branch protections and the org
   redirect made this session's first MC work land in the wrong place without a single
   error message.
3. **Metering identity for the network** — **DECIDED 2026-09-14: one tenant PER BUILDER
   ORGANISATION** (owner's call). Implemented: MC's `approveNetworkOrganisation` runs
   `ensureTenant(null, 'builders-network:<org uuid>', legal name)`, so the ledger exists
   from the day of approval, through the existing tenant machinery rather than a parallel
   one.
4. **Assertion vs introspection**: confirm the identity/JWKS endpoint generalises to a
   second audience cleanly; fall back to hash introspection if not. Either way the raw key
   never reaches the network.
5. **Storage move** — **DECIDED 2026-09-14: RE-KEY to a network-native scheme** (owner's
   call): objects are re-created under network paths and every `storage_path` column is
   rewritten in the same Phase 4 pass, with counts asserted before and after — a bigger
   move than preserving paths, chosen for the clean long-term layout.
6. **Native in-network AML compliance** stays deferred behind the server-side call (E4).

---

## Addendum — the marketplace ranking console (17 Sep 2026)

`/builders-network` now carries the marketplace ranking panel. Mission Control
does not compute the ranking and **cannot edit a score**: the network scores
builders hourly from measured evidence and publishes the answer to every clone.

What MC holds are the instruments, each behind the existing `builders:operate`
federation assertion and each recorded with an actor, a reason and an expiry:

| Operation | What it does |
| --- | --- |
| `ranking_overview` | The ranked builders, their confidence, their band, live overrides and placements |
| `ranking_explain` | One builder's full signal breakdown, including what could not be measured |
| `ranking_set_override` / `ranking_clear_override` | Pin to a position, or take a builder out of the marketplace |
| `ranking_set_freeze` | Hold the published order still — it does not fall back to a default ordering |
| `ranking_set_placement` / `ranking_clear_placement` | A commercial placement: a capped, labelled band above the organic order |

Three things the console deliberately does not offer. **There is no
`set_merit_score`** — an operator who could type one could tell a builder a
number no evidence produced, and the confidence, band and unmeasured list beside
it would become decoration. **A reason is not optional**: the ten-character floor
is enforced at the column, at the network's door and in the prompt, so all three
cannot become different standards. And **an override expires by default**
(90 days) — a standing one has to be asked for explicitly, because the failure
mode is not a badly chosen expiry but the pin nobody remembered to renew.

The reasoning and the measurements are in the prime:
`npc-property-dashbord/docs/builder-portal/47-builder-ranking.md`.
