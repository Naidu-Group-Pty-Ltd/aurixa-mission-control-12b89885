# What actually drives a clone

August 2026. Written because the question "what is the engine behind the
cloning process?" did not have an answer anyone could point at, and the honest
answer turned out to be **three engines, two of which had never run**.

Everything here is measured against the live Mission Control database
(`0fb4d803-…`, project `dduzbchuswwbefdunfct` is the prime PRODUCT) and this
repository at the commit that adds this file.

---

## There is no single engine. There are three, plus a synchronous prologue.

Creating a clone is one operator action and four independent machines.
`provisionClone` (`src/server/clone-provisioning.functions.ts`) runs
**synchronously**, inside the request, and does everything that is fast:

| Step                                                        | Where                                              | Fails how                   |
| ----------------------------------------------------------- | -------------------------------------------------- | --------------------------- |
| Fork / template the GitHub repo                             | `octokit.repos.createFork` / `createUsingTemplate` | fatal, returns `{ok:false}` |
| Insert the `clones` row, modules, add-on purchases          | `supabase.from("clones").insert`                   | fatal                       |
| Issue the Aurixa API key and write it into the clone's repo | `cascadeApiKeyToRepo`                              | logged, non-fatal           |
| Sync GitHub Actions secrets                                 | `syncRepoSecrets`                                  | logged, non-fatal           |
| Reserve the subdomain                                       | `reserveCloneSubdomain`                            | logged, non-fatal           |

Everything slow is a **row in a queue**, and each queue has its own worker
behind a `/hooks/*` route driven by `pg_cron`:

| Queue               | Worker                              | Cadence      | What it produces                                                                                           |
| ------------------- | ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `cascade_events`    | `/hooks/cascade-drain`              | every minute | the module files, merged into the clone's repo                                                             |
| `clone_backends`    | `/hooks/backend-provisioning-drain` | every minute | the clone's own Supabase project — schema, edge functions, secrets, seeded admin                           |
| `clone_deployments` | `/hooks/deployment-drain`           | every minute | the Vercel project, its environment (including this clone's OWN Turnstile site key), the build, the domain |

That is the whole engine. There is no orchestrator above these three; they are
coupled only through data, and only in one place — `deployment-drain` will not
sync a clone's environment until `clone_backends` has published a URL and an
anon key.

One thing rides on `syncing_env` rather than having a queue of its own, and the
placement is not interchangeable: the clone's **Turnstile widget** is minted
there ([`CLONE_TURNSTILE_IDENTITY.md`](./CLONE_TURNSTILE_IDENTITY.md)). Vite
inlines `VITE_*` at BUILD time, so a site key that arrives after `deploying` is
a site key the bundle does not have. It is best-effort by design — a clone that
cannot get a widget reaches production saying its security check is
unconfigured, rather than failing to deploy — and the refusal is recorded on the
identity row instead of being swallowed.

---

## Two of the three had never been scheduled

`cron.job` on the live database held **16** hook jobs. Twenty-two are required.
`backend-provisioning-drain` and `cascade-drain` were both absent, along with
`entitlement-drain`, `codex-nightly`, `codex-sweep` and `feedback-forward-retry`.

Each of the six has a migration that was supposed to schedule it, and each of
those migrations does this:

```sql
SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;

IF v_secret IS NULL THEN
  RAISE NOTICE 'Vault entry cron_secret not found; skipping … schedule.';
  RETURN;                              -- the migration ends here
END IF;

v_headers := jsonb_build_object('Authorization','Bearer ' || v_secret)::text;
PERFORM cron.schedule('backend-provisioning-drain-1min', '* * * * *',
  format($f$… headers:=%L::jsonb …$f$, v_headers));
```

The vault was empty when they ran. Each raised a NOTICE into a migration log
nobody reads, each was **recorded as applied**, and the schedule never
happened. `cron_secret` is present now, but a migration already marked applied
does not run again, so the gap was permanent.

### Why every check said this was fine

- **`cron.job_run_details`** reports on jobs that exist. A job that was never
  created has no failing run to report — the honest signal is a job that is
  _missing_, and nothing was asking that question.
- **`check:cron`** asked "does a migration name this hook path?" It does. The
  migration that declines to schedule it still contains the URL.
- **`check:cron-auth`** asked "does a scheduled command that sends
  `Authorization` read the vault?" These commands do not contain the word —
  the header is hidden behind `format(%L)` and a `v_headers` variable — so it
  skipped them. Widening that rule from the _header_ to the **`/hooks/` path**
  found eleven jobs, not six.
- The **UI** was the most confident of all. `provisionBackend` writes
  `status_detail = "Queued — background worker will start within ~60 seconds"`.

### What an operator would have seen

Nothing that names the cause. The repo is created, every row is written, and:

1. `clone_backends` sits at `pending` with that "~60 seconds" message, forever.
2. `deployment-drain` — the one engine that _was_ running — advances the
   deployment to `syncing_env`, finds no anon key, and **waits**. That is
   correct: deploying a build wired to nothing is worse than not deploying.
3. Six hours later `STUCK_HOURS` marks the deployment `failed`:
   _"Stuck in syncing_env for more than 6h"_.

The only failure the platform ever reports is on the one component that was
working, and it names the wrong thing.

---

## The fix is the shape, not the value

Reading the secret at install time is what makes scheduling conditional on it,
and it was never necessary. Every healthy job on this deployment reads the
vault **inside** its command:

```sql
'Authorization','Bearer ' || (SELECT decrypted_secret
                                FROM vault.decrypted_secrets
                               WHERE name = 'cron_secret' LIMIT 1)
```

Evaluated per run, so a rotated secret needs no reschedule — and with nothing
read at install time, there is nothing left for the schedule to be conditional
on. A missing secret then fails the way it should: a 401 in
`net._http_response` — which is where you have to read it. `cron_delivery_health()`
reports the RUN, not the delivery: it matches a response by digits pulled out of
`cron.job_run_details.return_message`, and pg_cron records `"1 row"` there for a
`SELECT net.http_post(...)`, never the request id. So its `last_http_status` and
`delivered` are NULL for every job on every call. See the 26 Aug entry in
[`LIVE_CHANGES_2026-08-20.md`](./LIVE_CHANGES_2026-08-20.md).

`20260826000000_schedule_the_engine.sql` writes all eleven that way. It is
idempotent, and against the live job set it adds exactly the six that are
missing and leaves the sixteen healthy ones byte-identical — verified against a
real PostgreSQL 16 with `cron` and `vault` stubs, in five scenarios: replay
from zero, re-run, the live shape, **an empty vault** (all eleven still get
scheduled), and legacy-name retirement.

`check:cron-auth` now keys on the `/hooks/` path rather than the word
`Authorization`, and honours `cron.unschedule` so a retired name is not judged.
`check:cron` additionally fails when two jobs drive the same endpoint — the
duplicate-fire defect this repo has already had once.

---

## What was NOT wrong

Worth stating plainly, because the failure above is loud enough to cast doubt
on everything near it.

- **The schema path works and is not the migration replay.**
  `docs/CLONE_PIPELINE_GAPS.md` §1 recorded that the only path was a replay of
  the prime's migrations, and that it halts on migration #1. That is still true
  of the replay — and it is no longer the path. `provisionCloneBackend` defaults
  to `schemaStrategy: "introspection"`, and so does the worker's own call, so a
  clone gets the prime's **live catalogue**, which is the method that was proven
  by hand against `plisdzywzleljorrphxv` (641/641 tables, 491/491 functions).
- **The three convergence rules §7 said that path would need are implemented**
  in `schema-introspection.server.ts`: `add column if not exists` for tables
  that already exist, repeated function passes until the failure count stops
  falling, and `conindid` filtering so constraint-backed indexes are not
  double-created.
- **`deployment-drain` waiting was correct behaviour**, not a bug. Its only
  fault was inherited: its own Bearer was empty until 20 Aug (see
  `PRIME_HAS_TWO_HALVES.md`).

---

## Still open

_(updated 28 Aug 2026)_

- **Provider credentials — Vercel is live now.** `VERCEL_API_TOKEN`,
  `VERCEL_TEAM_ID` and `VERCEL_WEBHOOK_SECRET` are configured and proven: the
  hand-made clone's deployment ran the full pipeline to `live` on
  2026-08-28 (`npc.aurixasystems.com.au`).
- **`CLOUDFLARE_API_TOKEN` is set and the scope is wrong.** Measured on
  2026-08-29 by `/hooks/turnstile-reconcile` against production:
  `cloudflareConfigured: true`, `accountConfigured: true`, and the widget
  creation refused with Cloudflare's `Authentication error`. That is the
  scope failure, not a missing credential — the documented scopes for this
  token (Zone Read, Zone Settings Edit, Analytics Read) verify as an
  **active** token and refuse the Turnstile endpoint. Add
  **Account · Turnstile · Edit** to the token, on the account in
  `platform_hosting_config.cloudflare_account_id`; the sweep picks it up on
  its next ten-minute pass with nothing else to do. Until then a clone
  deploys with no site key and its login page says the security check is not
  configured — the prime's widget is never substituted.
- **No ENGINE-provisioned clone has run end to end.** The one clone in the
  fleet was built by hand; its backend and deployment exercised the drains,
  but `provisionClone → backend-provisioning-drain → deployment-drain` has
  never produced a clone from scratch. The first template-provisioned clone
  is still the first real test. The signed-agreement path
  ([`MODULES_TO_CLONES.md`](./MODULES_TO_CLONES.md)) now runs
  `assessProvisioningPreflight` before spending anything, precisely so that
  first run cannot start into a half-configured engine.
- **17 codex scans have been stalled for weeks** (10 `running` since 31 Jul–6
  Aug, 7 `queued` since 27 Jul) because `codex-sweep` is the worker that clears
  them. On its first run it marks the hung ones failed and may re-dispatch up
  to seven month-old scans; that is bounded and is what the sweeper is for.

## A clone's token-signing key is its own, and provisioning captures it

The clone's custom auth mints Supabase access tokens itself
(`_shared/jwt.ts`, read as `SUPABASE_JWT_SECRET ?? JWT_SECRET`) and its own
project validates them. Two things were wrong.

**It was classified `vendor` — the class that COPIES the prime's value.**
`JWT_SECRET` is in no other list, so `classifySecret` fell through to
`vendor`, and a `prime_secret_forwards` row with `inherit=true` would have
handed every clone the prime's signing key. That does not merely break the
clone (its own project would reject those tokens); it lets the clone MINT
tokens the PRIME's database accepts, for any `sub` and any role. No
forwarding row exists, so nothing was ever shared — but the whole point of
`TENANT_SCOPED_SECRETS` is that adding one later must be impossible, and it
is now in that set.

**The ledger asked for a name that cannot be set.** `SUPABASE_` is reserved
by Supabase's secrets API; `extractSecretNames` and `classifySecret` both
already excluded the prefix, so `SUPABASE_JWT_SECRET` could only ever read
`missing` no matter what an operator did. `JWT_SECRET` is the settable
spelling and the one the clone's code already falls back to.

Two rules carry it. **Never inherited is not never written** — a value that
belongs to THIS clone is exactly what should land, so `planCloneSecrets`
takes `selfValues` and provisioning supplies the project's own key.

It is read from **`GET /v1/projects/{ref}/postgrest`**, whose
`PostgrestConfigWithJWTSecretResponse` carries `jwt_secret`: it is PostgREST's
configuration, and the signing key belongs to it because PostgREST is what
validates the tokens. It is deliberately NOT taken from the create-project
response — `V1ProjectResponse` carries `id`, `ref`, `organization_id`,
`organization_slug`, `name`, `region`, `created_at` and `status`, and nothing
else. That was the first implementation here and it would have captured
`undefined` on every clone while looking correct, because the field is
optional and absence degrades silently to "pending". Reading the config
instead also means the key is available at ANY time rather than once, so a
project Mission Control ADOPTED is covered exactly like one it created, and an
existing clone can be repaired without an operator ever seeing the value.

And **a signing key is never generated** — the `identity` class mints a fresh
random value, which is right for `INTERNAL_EDGE_SECRET` and actively worse
here: PostgREST validates against the project's own key, so a random one
produces tokens rejected by the very database they are for.

### Repairing the clones that were provisioned before any of that

Provisioning covers clones provisioned _after_ the capture existed and nothing
else. Every clone already in the fleet has `JWT_SECRET` missing, and so does
any project adopted rather than created here. The documented remedy for those
was a person opening the clone's Supabase settings and pasting a signing key
into a box — for a value Mission Control can read for itself.

`clone-jwt-secret-reconcile` reads it (`cloneSecretRepair.server.ts`, decided
by `cloneSecretRepair.pure.ts`). It runs every 30 minutes, and it settles: the
sweep reads the candidate list and the ledger in bulk and decides from those,
so once every clone holds its key a pass is two queries and no Management API
call at all. Resolving a write target is three more queries and reading the key
is a Management API call; neither is paid for a clone the ledger already says
is done. A source test pins the ordering, because that is the whole claim.

Four rules carry it.

**The ref that reads is the ref that writes.** `getProjectJwtSecret` returns
one project's signing key and `setCloneSecretValue` writes an environment
variable onto one project. If those two refs could ever differ this hands one
tenant another tenant's signing key — the exact defect `tenant_scoped` exists
to prevent, arrived at from the other direction. So there is one `projectRef`
const and both calls take it, it comes from `resolveCloneSecretTarget` (which
refuses the prime's project, refuses Mission Control's own, and refuses when it
cannot tell), and a source-contract test asserts both — the damage needs a live
Management API token, which is exactly what a test must not hold.

**A missing ledger row is as repairable as one that says `missing`.** The
fleet's rows were written under `SUPABASE_JWT_SECRET`, a name the secrets API
refuses outright, so clones predating the fix have no row under the settable
spelling at all. Only `set` stops the repair — `inherited` deliberately does
not, because for a tenant-scoped name it cannot legitimately happen and reading
it as "already done" would leave that row standing and silent.

**A failed read is recorded as `failed`, never left as `missing`.** They are
different states and the 30-minute cooling-off window is keyed off the second
one, so a project whose config the Management API refuses costs two calls an
hour rather than sixty.

**The value never appears anywhere.** Not in a log line, not in the
`deployment_events` row, not in a return value, not as a prefix. A signing key
is authority, and an event row is read by more people than can read the project
it came from.

---

## What a new clone now boots with, that it did not before

A clone provisioned onto a **paid plan** now carries an activation gate: it
works normally for a window (72 hours by default) and is then locked behind a
payment screen until Stripe captures its activation payment. See
[`CLONE_PAYMENT_GATES.md`](./CLONE_PAYMENT_GATES.md).

It is armed inside `provisionCloneCore` rather than in the wizard's server
function, because that pipeline has **two** callers — the operator wizard and
the signed-agreement flow — and a gate armed in only one would leave every
agreement-provisioned clone ungated.

It is deliberately **not** a fifth queue. The reason is the failure this
document opens with: a gate whose CLOSING depended on a worker would fail OPEN
under exactly the fault recorded above — six jobs that were never scheduled,
silently, with every check green — and nothing would report it. So the gate's
state is derived on every read from stored facts, and no worker exists to be
missing.

The prime and every clone that already exists are unaffected, by construction:
a `clone_payment_gates` row IS the gate, this is the only code path that writes
one, and a test asserts no migration backfills the table.

---

## Re-running a backend: two levers, and the state that had neither

September 2026. Added after the first two engine-provisioned clones reached
`ready` and could not be brought forward when the engine behind them was
fixed.

`clone_backends` is a queue with exactly one writer,
`enqueueCloneBackendProvisioning` — the upsert IS the contract with the drain,
and a second writer of that row shape is how the queue and the worker drift.
Everything that wants a pass run asks that function, and it has two modes.

| The row is | The lever                            | What it does                                                                         |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `failed`   | `/hooks/backend-provisioning-retry`  | mints a fresh admin credential and re-queues, resuming onto the same project         |
| `ready`    | `/hooks/backend-provisioning-repair` | converges it onto the current engine, resuming onto the same project, seeding nobody |
| in flight  | neither                              | a worker has it; a fresh upsert would reset its attempts and credential under it     |

The dashboard's **Reprovision** button now picks between the two by status, per
clone, through the same enqueue.

### Why a repair is not just the retry with a looser guard

**It seeds nobody, and that is the point.** `seedProductAdminIdentity` rewrites
`password_hash` and clears `failed_login_attempts` and `locked_until` on an
existing row unconditionally. Over a clone that has been handed over, running
it again is a silent password reset and a lockout release, reported as a
successful step. The admin identity belongs to the tenant. So a repair carries
no credential at all — which is also what makes a clone repairable after a
terminal failure has cleared the queued one.

Two consequences follow from a queued row with no credential, and both are in
the drain:

- **the claim** cannot require `queued_admin_password_enc`, so that predicate
  moved out of the query and into the same JS filter the `retry_after` backoff
  uses (a composed PostgREST `.or()` is forbidden here — one never parsed, and
  the claim it guarded had never once succeeded). The candidate window widened
  from five rows to ten, because unclaimable rows now reach the filter;
- **the stranded sweep** must skip it. That sweep fails a parked row precisely
  BECAUSE it has no credential and so can never be claimed — which is a
  repair's normal state. Without the exclusion it would fail a pass that was
  working, 45 minutes in, telling the operator to retry something that had not
  gone wrong.

`repair_requested_at` carries the flag, and its presence means "the pass now
queued is a repair". It is spent on any terminal outcome, success or failure:
left standing, the next ordinary provisioning of that clone would be taken for
a repair and would skip the admin seed.

### What a repair actually costs

Almost nothing, and that is a property of the hardening rather than of the
repair. Every replication step asks the target before it writes — the schema
stages prove themselves reconciled in one round trip per side, extensions
report `already_present`, cron and the realtime publication compare before
adding, and the deploy step asks the project which functions it holds. So a
repair over a complete clone reconciles what is already right and carries only
what is missing.

### The state this was built to reach

On 3 September 2026 both engine-provisioned clones were at `ready` holding **0
of the prime's 32 storage buckets** and **9 of its 86 secrets** — two engine
defects whose fixes landed after those clones finished. There was no way to
apply the fixes: the enqueue refused a `ready` row, the retry hook refused
anything that was not `failed`, and the dashboard's Reprovision button wrote
`status='pending'` itself, with no credential, producing a row nothing could
claim and which the stranded sweep then marked `failed` three quarters of an
hour later. It reported "Re-queued N backends" every time.

The remedy the product offered for a clone provisioned before a fix was to
destroy a tenant's Supabase project and build a new one.

---

## A count cannot see a definition that drifted

September 2026. The schema stages skip themselves when the clone holds at
least as many objects as the prime, which is what makes a resumed pass cheap
(24 round trips became 2). A count answers _does the clone hold as many of
these_. It cannot answer _are they the same ones_, and for anything whose
identity is its DDL rather than its existence those are different questions.

Measured on both engine-provisioned clones. The prime's
`builder_stock_items_rearm_settlement` fires

```
AFTER INSERT OR UPDATE OF enrichment_status, image_work_stage
```

and both clones carry a trigger of that name firing `AFTER INSERT` alone —
the narrow form the prime's own **repository** still declares, copied before
the prime was widened by hand in its live project. One trigger row on each
side, so every count reconciles, the stage is skipped for ever, and the
trigger silently does not fire for the updates it exists for.

Only the parity report saw it, because parity keys triggers per EVENT:
`builder_stock_items.builder_stock_items_rearm_settlement.AFTER.UPDATE`.
**Seeing it was never the problem** — the schema build had no way to act on
what parity found.

Two things had to change.

**`pg_get_triggerdef` renders a bare `CREATE TRIGGER`**, which is an _error_
against a trigger that already exists — so the one statement that could
repair a drifted trigger was the one guaranteed to fail. `CREATE OR REPLACE
TRIGGER` (Postgres 14+, and every project here runs 17) replaces the
definition. A **constraint** trigger is deliberately left alone: `CREATE OR
REPLACE CONSTRAINT TRIGGER` is not valid syntax, so rewriting one would turn
a trigger that merely fails as a duplicate into a trigger that fails to
parse.

**The stage has to be entered at all.** A definition digest rides in the same
prefetch union as the count, so proving a triggers stage finished still costs
nothing. Two rules keep it honest:

- **only EQUALITY is conclusive.** Equal digests prove the clone holds
  exactly the prime's definitions and the stage is skipped for free. Unequal
  digests prove nothing — a clone legitimately holds objects the prime has
  since dropped, and treating that as _not reconciled_ would re-apply all 474
  triggers on every pass, which is the closed loop the `tables` stage already
  had once;
- **the count still gates it.** A digest can never promote a stage that has
  not got enough objects yet.

So an unequal digest sends the stage on to compare _definition lists_, and
only the prime definitions the clone does not already hold are applied. That
set is normally empty, and when it is not it names exactly what drifted. The
cost is two round trips on a stage that would otherwise be skipped, and only
when the digests differ — the price of being able to act on drift at all.

`tables` remains the older exception for the same underlying reason, stated
in its own comment: `create table if not exists` skips a table that already
exists, so **column** drift survives with the counts matching exactly.

---

## A job the prime has disabled is replicated as disabled, or not at all

September 2026. The prime disables exactly **two** of its 47 scheduled jobs —
`sync-ghl-conversations-cron` and `sync-ghl-marketing-assets-6h` — and those
two are the only two missing from **both** engine-provisioned clones, each of
which holds 45 jobs and not one inactive. Two of two, twice, on independent
runs.

The deactivation used to be

```sql
update cron.job set active = false where jobname = '…';
```

a direct write to an extension's catalogue table, issued in the **same
multi-statement batch** as the schedule. So whatever refused it took the
schedule down with it, and the job was left **absent** rather than
present-and-active — which is exactly the shape the clones are in.

`cron.alter_job(jobid, active := false)` is pg_cron's own API for this and is
what the direct write should always have been. Two rules go with it:

- **it runs as its own statement**, so a failure to deactivate can never
  discard a schedule that succeeded;
- **a job that cannot be disabled is withdrawn and reported**, never left
  running. A copy of a job the prime deliberately stopped, running on a
  tenant's database, is worse than not having it: silence there is work
  nobody asked for.

The exact reason the catalogue write was refused is not established here —
the engine records the per-job error and that record lives in the parity
report, which was unreadable while Mission Control's own database was down.
The correlation is 2/2 across two runs and a direct catalogue write is the
wrong API regardless, so this is fixed on its own merits rather than on a
diagnosis. The next repair pass will say what the error was, if there still
is one.

### Why triggers is the only class with a digest

Measured across every definitional class on 4 Sep 2026, prime against clone,
scoped to `public` and `aml`:

| class     | prime | clone | definition digests                   |
| --------- | ----- | ----- | ------------------------------------ |
| views     | 14    | 14    | **identical**                        |
| functions | 620   | 620   | differ — **by design**, see below    |
| policies  | 1,154 | 1,155 | differ by the known surplus (+1)     |
| indexes   | 2,166 | 2,169 | differ by the known surplus (+3)     |
| triggers  | 474   | 474   | differ by **one drifted definition** |

Only triggers carried real drift, and the other three rows are each a reason
NOT to extend the digest naively.

**A clone's function bodies must differ from the prime's.** The pipeline
re-points any function body that names the prime's project, and it does:
exactly four of the prime's 620 functions name `dduzbchuswwbefdunfct`
(`bootstrap_cron_vault`, `dispatch_web_push_for_portal_notification`,
`dispatch_web_push_on_notification`, `invoke_pdf_parse_recover_stuck_jobs`),
and exactly four on the clone name the clone's own ref with **zero** still
naming the prime. Those four are the whole difference. So a functions digest
would be permanently unequal _because the engine did its job_ — and if
inequality were ever treated as conclusive it would re-apply 620 definitions
on every pass, for ever.

**Policies and indexes differ only by the surplus** a clone keeps when the
prime drops something (see the surplus reading). That is the same reason
digest inequality is never conclusive for triggers either.

**Views are byte-identical**, so there is nothing to add there.

The rule this leaves: a digest belongs to a class only where an identical
definition on both sides is the _expected_ outcome. That is triggers today,
and it is a per-class judgement rather than a mechanism to spread.
