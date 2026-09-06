# Hosting a clone: Vercel and Cloudflare

_Vercel owns the application. Cloudflare owns the name. They meet at exactly
one value._

**The fleet decision, and what it changed.** Every clone is staged on Vercel and
served at `<subdomain>.aurixasystems.com.au`, with DNS in Cloudflare. That is now
the platform default rather than an option: `hosting_provider_slug` defaults to
`vercel`, `auto_deploy` to `true`, and the fleet DNS default moved off Lovable's
A record. The five gaps that decision exposed — and what closes each — are in
[Automation, end to end](#automation-end-to-end) below.

---

## What this replaces

`provisionClone` creates a GitHub repo, installs the picked modules, issues an
Aurixa API key and cascades it into the repo, pushes the Codex Actions secrets,
and enqueues a Supabase backend. Then it stops. **Nothing builds the clone and
nothing serves it.** The word "Vercel" did not appear anywhere in this
repository before this change.

That absence is not visible as a missing feature — it is visible as five
things that look like unrelated defects:

| Symptom                                                             | Cause                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Clone health shows no uptime for any clone                          | `clone-health.server.ts` pings `clone.deploy_url`; it is always null                   |
| Security partners are assigned assessments with no target           | `target_urls: clone.deploy_url ? [clone.deploy_url] : []` → always `[]`                |
| The billing handoff return-URL host pin never engages               | It pins to `deploy_url` when present, and accepts any https URL otherwise              |
| A new clone's Supabase auth allow-list contains one guessed host    | `siteUrl: deploy_url ?? lovable_project_url` — **both** columns are written by nothing |
| The subdomain resolves to a host that has never heard of this clone | `platform_hosting_config.target_value` is ONE A record for the whole fleet             |

**`clones.deploy_url` is read in twenty places and written in none.** Neither is
`lovable_project_url`. Everything downstream of "where does this clone live"
has been running on a column that is always null, and each consumer degrades
quietly rather than failing — which is why none of them ever reported it.

## The split

**Vercel owns the application.** The project, the git connection, the
environment, the build, the deployment, and the canonical origin. One Vercel
project per clone, named from the clone slug, created once and reused forever.

**Cloudflare owns the name.** DNS in the Aurixa zone, plus the edge posture
(security level, bot-fight, WAF preset) it already owns through
`clone_edge_config`. Nothing about Cloudflare changes except _what the record
points at_.

**They meet at one value: the CNAME target Vercel issues for the custom
domain** — plus, when Vercel demands it, one TXT record proving we own the
name. That is the entire contract between them. Cloudflare never calls Vercel
and Vercel never calls Cloudflare; Mission Control carries the value across.

```text
provisionClone
  ├─ GitHub repo ─────────────────── exists
  ├─ module cascade ──────────────── exists
  ├─ API key → .aurixa/credentials ─ exists
  ├─ Codex Actions secrets ───────── exists
  ├─ clone_backends (Supabase) ───── exists
  └─ clone_deployments ──────────── NEW
        │
        │  pg_cron every minute → /hooks/deployment-drain
        ▼
  pending → creating_project → linking_repo → syncing_env → deploying
          → attaching_domain → verifying_domain → live
        │                            │
        │                            └─ enqueues edge_provisioning_jobs
        │                                 provision_subdomain (recordContent =
        │                                   the CNAME Vercel issued)
        │                                 verify_domain_txt (when challenged)
        │
        ├─ writes clones.deploy_url    ← only at `live`, never before
        └─ re-applies the backend's auth config with the real origin
```

---

## Eight rules, each earned

### R1 — A hosting provider is a contract, not an `if`

`HostingProvider` mirrors the `EdgeProvider` interface that already carries
Cloudflare/AWS/Azure. Vercel is `live`; the legacy Lovable custom-domain target
is registered as `manual` — it is a real way a clone can be served (it is how
every clone is served today), it simply has no API we drive.

`platform_hosting_config.provider_slug` has existed since the subdomain feature
shipped and **nothing has ever read it**. It is now the value that decides.

### R2 — The DNS target belongs to the deployment, not to the platform

`platform_hosting_config.target_value` is a single A record documented as
Lovable's `185.158.133.1`. That is correct for a platform where one origin
serves every clone by `Host` header. It is _wrong_ the moment each clone is its
own Vercel project: Vercel routes by the domains registered on a project, so a
fleet-wide CNAME means every clone resolves to a Vercel edge that has never
heard of it and answers `DEPLOYMENT_NOT_FOUND`.

So `target_value` stays as the **fleet default**, used when the resolved
provider is `manual` or when a clone has no deployment of its own, and a clone
whose deployment reports a target overrides it. `resolveDnsTarget` is the one
function that decides, and it is pure and tested.

### R3 — Never create a second project for a clone

`provisionClone` learned this the expensive way: a double-click forked two
GitHub repos, which is why `idempotency_key` exists. A duplicate Vercel project
is worse, because the second one takes the domain and the first keeps building.

`clone_deployments.clone_id` is the primary key, project creation is guarded by
a `409 Conflict`-tolerant lookup-then-create, and the worker adopts an existing
project of the same name rather than failing or renaming.

### R4 — A deployment that FAILED is not one that is ABSENT

`cron_delivery_health.delivered` is three-valued for this reason, and `CaseRead`
in the property dashboard carries `failed` separately from `row` for the same
one. A clone with no deployment requested, a clone whose deployment is still
building, and a clone whose build broke are three different facts and one badge
cannot say all three.

`deploy_url` is therefore written **only** on reaching `live`, and `live` means
the domain was observed resolving to this project — never constructed
optimistically from the slug. A URL we guessed is worse than no URL: it is what
`backend-provisioning` has been doing, and it produced an auth allow-list for a
host nothing served.

### R5 — A `VITE_` variable is public, and the code has to know that

Vite inlines every `VITE_`-prefixed variable into the client bundle at build
time. Marking it "encrypted" in Vercel protects it at rest and not at all in
the artefact. The Supabase **service-role key** and the clone's database
password must never be given a public name, and the failure is silent — the
build succeeds and the key ships.

`envPolicy.pure.ts` classifies every variable and **throws** when a value whose
name matches a secret pattern is about to be given a public prefix. It is a
pure module with tests, and the worker imports it rather than re-deriving the
rule.

### R6 — Auth config is re-applied once the origin exists

`applyAuthConfig` runs during backend provisioning, minutes before any
deployment exists, and builds `site_url` + `uri_allow_list` from the null
`deploy_url`. Re-running it at `live` is the whole fix; without it, a clone gets
a working URL and a backend that will not accept a sign-in from it.

### R7 — Mission Control's own Vercel calls are NOT metered to a tenant

`api_usage_events` is tenant recharge — `clone_id`, `tenant_id`, `secret_name`.
Every row bills someone. Mission Control creating a Vercel project is Aurixa's
platform overhead, not the tenant's vendor spend, and the prime repo's rule
holds in reverse: guessing which credential a call spent bills the wrong
tenant, so a call that belongs to no tenant is metered to none. Per-clone
hosting _cost_ is a real billing question and is deliberately left for a
separate change rather than invented here.

### R8 — The worker respects both APIs' limits

The edge drain already serialises per Cloudflare account for the 1200 req/5min
token cap. The Vercel client honours `Retry-After` on 429 and retries 5xx, and
the deployment drain runs a low concurrency because project creation and
domain attachment are heavy and rate-limited per team.

---

## Automation, end to end

The first pass built the pipeline. Committing the whole fleet to it exposed five
places that still needed a person, and each one failed quietly rather than
loudly.

### A1 — The defaults described the previous world

`hosting_provider_slug` shipped as `manual`, `auto_deploy` as `false`, and the
fleet DNS target as Lovable's A record `185.158.133.1` with `proxied = true`. A
clone provisioned on those defaults records `manual`, is never built, and points
its subdomain at an origin that has never heard of it.

`proxied` is the one that costs the most to diagnose. An orange-cloud record
terminates TLS at Cloudflare and hides the origin, so Vercel's certificate
challenge never arrives — the domain attaches, DNS resolves, the site even loads
through Cloudflare's edge, and the certificate never issues. Both dashboards show
the domain as correctly configured. `resolveDnsTarget` already forced DNS-only
for deployment targets; the stored default now agrees with it so the two cannot
drift.

**On a provider-managed fleet the fleet default is withdrawn entirely.** Vercel
routes by the domains registered on a project, so `cname.vercel-dns.com` for a
domain no project has claimed answers `DEPLOYMENT_NOT_FOUND` — a page that reads
as a broken build and sends whoever debugs it to the build logs instead of to the
domain. `resolveDnsTarget` returns null instead, and NXDOMAIN is the better
failure: unambiguous, correct, and costless to fix when the deployment reports
its target.

### A2 — The subdomain was never reserved

`provisionClone` never wrote `clones.subdomain`; the drain fell back to
`clone.slug`. That works until it doesn't, in three silent ways: `reserved_slugs`
is bypassed (a clone slugged `admin` takes `admin.aurixasystems.com.au`),
collisions reach `clones_subdomain_uidx` as a constraint violation whose error
every caller on this path discards, and a slug that is legal for a GitHub repo
(`My_Clone.v2`) is not legal for a hostname.

`subdomainAllocation.pure.ts` decides once, before anything is written: normalise
to an RFC 1123 label, refuse reserved names, suffix past collisions, and truncate
the **base** rather than the suffix — shortening the disambiguator re-collides,
which is the one thing the suffix exists to prevent. The server helper retries
exactly once on 23505, because a second collision against a re-read set is not a
race.

The drain now requires the reserved name and never falls back to the slug. A
clone with no name is live on the provider origin, which is a complete outcome
rather than a failure.

### A3 — A cascade did not rebuild anything

Vercel rebuilds on push only where **its** GitHub App is installed on the
repository. Mission Control forks clones through its own App and never installs
Vercel's, so a cascade merges code into forty repositories and forty live sites
go on serving the previous build, indefinitely.

`decideRedeploy` is the rule, and most of it is about when _not_ to: a cascade
must never enrol a clone that has no deployment row, never resurrect a `detached`
one, and never overturn an operator's `not_requested`. It fires on `succeeded`
only — a `pr_opened` result is a proposal, and the branch the deployment builds
from does not have the change on it yet.

### A4 — After `live`, a broken build was invisible

The drain polls a build only while the row is in `deploying` and stops at `live`.
Correct — polling every live clone forever burns the team rate limit on nothing —
but it leaves every subsequent build unobserved. The build fails, Vercel keeps the
previous production deployment serving, and the row goes on saying `live`. Which
is true, and useless: the clone is up, and it is not running what was pushed.

Those are two facts and one column cannot carry both, so build health is its own
set of columns and `status` stays the lifecycle. `/hooks/vercel` is the fast path
(HMAC-SHA1, production target only — a failing preview is a pull request that
will not merge). `sweepLiveBuilds` inside the already-scheduled drain is the
honest one: a webhook that was never delivered leaves no trace on either side,
which is the same reason `cron_delivery_health` exists.

### A5 — Deleting a clone left it serving

The Vercel project kept building, the domain stayed attached, and the CNAME kept
resolving. Worse than an orphaned resource: a running application on our domain,
for a customer who has been offboarded.

The obstacle is that everything needed to clean up is destroyed by the same
delete — `clone_deployments`, `edge_provisioning_jobs` and `edge_dns_records` all
cascade. Enqueuing a normal job does not help, because that job cascades too. So
`hosting_teardowns` holds everything **by value**, has no foreign key to `clones`
at all, and is filled by a `BEFORE DELETE` trigger rather than by a server
function — `bulkDeleteClones` is one delete path, an admin with SQL access is
another, and a trigger covers the ones nobody has written yet.

Teardown order is the reverse of provisioning: DNS first, then the project.
Removing the project while the CNAME still points at it leaves our own domain
serving `DEPLOYMENT_NOT_FOUND`. Only `managed` records are removed — deleting
somebody else's DNS record because a clone was deleted is collateral damage, not
cleanup.

### A6 — "All clones" excluded the ones that already existed

`reconcilePendingDeployments` only wakes rows that already sit at
`pending_platform`. A clone provisioned before this feature has no row at all, and
every decision in the system reads an absent row as "nobody asked".
`enrolFleetInDeployments` gives each one a row and a reserved name. It only
INSERTs, so a declined or detached deployment is never overturned, and `dryRun`
is the default because a fleet-wide write that creates a Vercel project per clone
is not something to learn the shape of by running it.

---

### A7 — A challenge is written wherever it appears

Vercel answered `addDomain` with no ownership challenge for two clones on
3 September 2026, and then — once their CNAMEs resolved — asked for a TXT on
`_vercel.<zone>` (`vc-domain-verify=<host>,<token>`). Only the attach step
queued `verify_domain_txt` jobs; the `verifying_domain` step recorded the
challenge on the row every two minutes for six hours, never wrote it, and then
failed both deployments as "stuck" with the exact record they needed sitting in
`domain_verification`. The live zone had no `_vercel` TXT at all.

The verifying step now queues the provider's challenges before it waits. The
job is keyed on the challenge's own value, so asking on every pass costs
nothing once it has been queued, and the status line says the record is being
written rather than that DNS is "propagating". `domainChallenge.contract.test.ts`
pins it against the source, because the drain needs a hosting credential to
run.

## Data model

| Table                                | Purpose                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clone_deployments`                  | One row per clone. The state machine, the provider refs, the domain, the CNAME target Vercel issued, and the worker's claim/attempt fields. `clone_id` is the PK — R3. |
| `deployment_events`                  | Append-only audit of every transition and every provider call, mirroring `edge_audit`.                                                                                 |
| `hosting_providers`                  | Registry row per provider so the UI can list them, mirroring `edge_providers`.                                                                                         |
| `platform_hosting_config` (extended) | `hosting_provider_slug`, `vercel_team_id`, `vercel_project_prefix`, `auto_deploy`.                                                                                     |
| `hosting_teardowns`                  | Work that must outlive the clone it belongs to. No FK to `clones` on purpose — see A5.                                                                                 |
| `clone_deployments.last_build_*`     | Health of the most recent production build, separate from `status`. `live` + `error` means serving the previous artefact.                                              |

`edge_provisioning_jobs` gains one action, `verify_domain_txt`. No schema change
— `action` is TEXT — but the worker and the doc both name it.

## Environment variables pushed to a clone's Vercel project

Public (inlined into the bundle, and that is intended):

- `VITE_SUPABASE_URL` — the clone's own project URL
- `VITE_SUPABASE_ANON_KEY` (and `VITE_SUPABASE_PUBLISHABLE_KEY`) — the publishable key
- `VITE_SUPABASE_PROJECT_ID` — the project ref
- `VITE_AURIXA_API_KEY` — the clone's Mission Control key, already committed
  to `.aurixa/credentials.json` in a private repo, so this adds no exposure

Refused, always, by `envPolicy`:

- the service-role key, the database password, any `*_SECRET`, `*_PRIVATE_KEY`,
  `*_SERVICE_ROLE*` or `*_TOKEN` under a public prefix

## Operator surfaces

- **Wizard** `/clones/new` step **6c · Deployment** — pick the provider, or opt
  out. Opting out is `not_requested`, which is distinct from failed (R4).
- **Clone page** — a deployment card: state, the origin, the domain, the CNAME
  Vercel wants, and the three actions (redeploy, re-sync env, retry).
- **Settings → Domains** — the hosting provider, team, project prefix and
  auto-deploy flag, beside the Cloudflare zone config they have to agree with.

## Guards

`npm run check:hosting` (`scripts/check-hosting-env-policy.mjs`, wired into CI
before the typecheck) covers the two failures on this path that produce no
runtime signal:

- **A secret given a public env name.** `envPolicy` throws for anything that
  goes through `buildCloneEnv`; the guard covers the other half — a literal
  somebody writes into a component, a script, or a second env builder that never
  imports the policy.
- **A deployment status the column refuses.** `clone_deployments.status` has a
  CHECK constraint and the state machine lives in TypeScript. When they drift the
  update fails with `violates check constraint`, and a discarded Supabase error
  turns that into a row that silently never advances.

Both were verified against deliberately reintroduced regressions. Note the guard
scopes its parity search to the `clone_deployments` table body: the first
`status … check (status in (…))` in the migration corpus belongs to
`clone_edge_config`, and a parity check comparing the wrong two lists fails
loudly on correct code while passing on the drift it exists to catch.

## Credentials

| Secret                  | Scope needed                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_API_TOKEN`      | Projects: read/write, Deployments: read/write, Domains: read/write on the team                                                                                                                                                      |
| `VERCEL_TEAM_ID`        | Optional; omit for a personal account                                                                                                                                                                                               |
| `VERCEL_WEBHOOK_SECRET` | The signing secret of a Vercel webhook pointed at `/hooks/vercel`. Absent, the receiver answers 503 rather than accepting unsigned writes to the fleet's hosting state; the reconciliation sweep still covers the gap, more slowly. |
| `CLOUDFLARE_API_TOKEN`  | Unchanged: `Zone:Read` + `DNS:Edit`                                                                                                                                                                                                 |

Absent `VERCEL_API_TOKEN` the whole path is **dormant, not broken** — the same
posture the subdomain feature already takes. Enqueue still succeeds and the row
sits at `pending_platform`, and the settings page's reconcile action fans the
backlog out when the token lands.
