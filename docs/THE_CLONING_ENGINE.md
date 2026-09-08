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

---

## The bucket travels; the prime's objects do not

4 September 2026, and the most serious thing this pre-flight found.

The engine's governing rule is **structure only, never data** — the
replication path carries schema, functions and configuration, and no prime
row is ever destined for a clone. The rule held for rows. It had never been
tested for **storage objects**, because bucket CREATION had never once
succeeded: every bucket answered 404 at the Management API, so the object
copy in the same step could not run and nobody found out what it would do.

Fixing creation made the second half of that step run for the first time. It
began walking all 32 of the prime's buckets — **59,050 objects, 25.1 GB** —
copying what it found onto a tenant's Supabase project. Before the pass was
stopped by hand it had moved 21–24 branding assets onto each clone and, onto
one of them, **a customer document and a customer form**.

`SEED_ASSET_LIMITS` bounded it only by accident: 500 objects and 512 MB **per
bucket**, across 32 buckets, authorises ~16,000 objects and ~16 GB. **A limit
is not a policy.**

So the copy is allow-listed and **`SEED_ASSET_BUCKETS` is empty**. That is the
policy rather than a placeholder. A bucket earns a place in it by being seed
material the product genuinely needs and that belongs to nobody — never by
being small, and never by being convenient. Adding a name there is a
disclosure decision, so it is made once, in the open, and a test asserts the
list stays empty until somebody does.

Three things follow.

**Withholding is recorded, not silent.** A bucket whose contents were
deliberately not copied carries `contents_withheld` with the reason, so an
operator reading the replication report sees a decision rather than a copy
that failed.

**The loop is budgeted.** It had no deadline check of any kind — not in front
of it, not inside it — so the worker was killed rather than pausing, which
costs a hard attempt where a pause costs sixty seconds. Both clones sat on
"Replicating storage buckets…" until that was found. Deferral is **between
buckets, never mid-bucket**: a half-copied bucket is worse than an uncreated
one.

**The pause is thrown outside the catch.** Inside it, a `BudgetPause` is
swallowed as a failed replication and the pipeline runs on to mark a clone
ready holding some of the prime's 32 buckets — the same rule the cron and
realtime steps already follow, and a failure that does occur travels with the
pause rather than being lost behind it.

### What this cost, and why it was cheap

Both affected projects were rehearsal workspaces owned by the same account, in
the same Supabase organisation, so nothing left the owner's control. With a
paying tenant it would have been a data-protection breach: the prime's buckets
hold listing photographs, generated reports, uploaded documents and the
identity captures `aml-idv-retention` deletes on a clock.

The general lesson is the one this programme keeps relearning: **a step that
has never worked has never been tested.** Every measure taken against the
bucket step — the limits, the "structure only" control in the runbook, the
report that listed it as held — was measuring a step that returned 404 before
reaching any of the behaviour those measures were about.

### A test that enumerates its instances cannot pin a class

The budget rule above had a test, and the test carried this comment:

> The test now pins the class, so a fourth per-item step added without a
> deadline fails it.

It could not. It was `it.each` over three hardcoded function names.
`replicateStorageBuckets` was not among them, had no deadline check of any
kind, and was never checked — for as long as the step 404'd, nothing noticed.

The set is derived from the source now: every exported async function in the
module that runs an awaited call inside a `for` loop must either take the
invocation deadline and check it **inside** that loop, or appear in a named
exemption list. Each exemption states a **bound**, not an opinion:

| function                                        | why it needs no deadline                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `deployEdgeFunction`                            | inner helper; `deployEdgeFunctions` holds the budget                                                                 |
| `enforceRequiredExtensions`                     | bounded by the prime's extension set (9), writes only what is absent                                                 |
| `repointPrimeUrlsInFunctions`                   | bounded by its own predicate — measured 4 Sep 2026: four functions name the prime ref                                |
| `applyPrimeMigrations`, `applyModuleMigrations` | the legacy migration-replay path, not the default strategy — a known gap on an unused path, named rather than hidden |

The discovery also asserts it found something, because a scan that silently
matches nothing makes every assertion after it vacuous — which is the failure
this replaces.

---

## A bucket may not ask for more room than the project allows

4 September 2026, found by the first pass that ever created buckets.

Two of the prime's 32 were refused on every clone:

| bucket       | `file_size_limit` |        |
| ------------ | ----------------- | ------ |
| `vsl-media`  | 21,474,836,480    | 20 GB  |
| `qa_exports` | 104,857,600       | 100 MB |

both answering

```
400 {"statusCode":"413","error":"Payload too large",
     "message":"The object exceeded the maximum allowed size"}
```

A bucket's limit may not exceed the **project's** global upload limit, and a
fresh project gets the platform default while the prime's has been raised.
The error names the bucket, so it reads as a bucket fault — and **no
bucket-level retry could ever have fixed it**, because the setting that
refuses it is one level up.

`replicateStorageConfig` reads the prime's `config/storage` and patches the
clone's before any bucket is created. Two rules:

- **it never LOWERS a clone's limit** to match the prime. The buckets are what
  need room; a clone that already allows more is not a defect to correct;
- **a failure is reported and non-fatal**, and says what it will cost: the
  buckets that fit are still worth creating, and the ones that do not now say
  exactly why rather than looking like a storage fault.

This is the third defect in one step found by making the step work
(F26 → F34, F35, and this). The step had returned 404 for its whole existence,
so nothing downstream of that 404 had ever executed.

### The bucket results were computed and dropped, like the two before them

F25's rule was that **a result that is computed must be recorded somewhere a
person looks** — it moved the per-item cron and realtime results into the
parity report, because "the words were the only copy" and the next step
overwrote them.

The bucket results were left out of that fix and had exactly the same fault.
When two of the prime's 32 buckets were refused on every clone, the only
record of _why_ was a status line that the pg_cron step replaced seconds
later. Diagnosing it required changing the engine to say what it already knew,
which is the definition of the gap.

`storage_buckets` and `storage_config` now travel in the parity report beside
`cron_jobs` and `realtime_publication`. The project-level limit is carried out
of the pipeline rather than only logged, and **both exits carry it** — the
repair path returns early, and without it a repair would report a blank where
a provision reports a reason.

### The bucket step asks the clone what it already holds

Measured 4 September 2026, immediately after the two oversized buckets were
fixed: **both clones held all 32 of the prime's buckets while the engine still
reported `28 of 32 carried to the next pass`** — and never got past this step
to reach the secrets. It re-attempted every bucket on every pass and spent the
whole budget answering "exists" 32 times.

That is the rule the schema stages and the cron step already follow:
**verifying a built thing must not cost what building it did.** The clone's
buckets are listed once for the whole step, and a bucket is skipped only when
its **configuration also matches** — existing is not the same as correct, and
a bucket whose size limit or visibility drifted is exactly what this step
exists to repair. A clone whose buckets cannot be listed is treated as holding
**none**, which puts every bucket back on the create path: the fallback does
the work rather than assuming it is done.

## A function the prime's repo deleted is not a shortfall on the tenant

`computeParity` compared the prime's **deployed** edge functions against the
clone's, and reported everything the prime ran and the clone did not as
`missing_edge_functions`. That count is a **blocking issue**, and a handoff
leaves `draft` only when `blocking_issues` is empty:

```ts
if (handoff.state === "draft" && parity.blocking_issues.length === 0) { … }
```

Measured 4 Sep 2026, on both engine-provisioned clones: ten such functions,
and not one of them is declared by the prime's repository at `main`.

| Function | What it is |
| --- | --- |
| `manage-partner-agreements` | Deleted — the prime's own docs record the removal |
| `finance-portal-agreements` | Deleted, same change |
| `agreement-centre-render` | Deleted, same change |
| `gamma-agreement-generator` | Belonged to the same withdrawn feature |
| `sync-vault-internal-secret` | A one-off repair, run once |
| `mc-diag-tmp`, `mc-wallet-diag` | Diagnostics |
| `tmp-ghl-field-probe`, `ghl-workflow-probe`, `builder-stock-inpaint-probe` | Probes |

So every clone this engine will ever produce was permanently un-handoff-able,
for ten reasons no act on the clone could discharge. The clone was right and
the verdict was wrong.

**What the repo declares and what the prime happens to be running are
different questions.** A clone is contracted to carry the first. The second is
the prime's own deployment history, dead code included, and measuring a tenant
against it makes the tenant answer for somebody else's residue.

Three rules hold the fix.

**The narrowing is disclosed, never silent.** What the prime runs and its repo
has dropped is reported as `prime_only_undeclared` and named in the summary
line. Hiding it would trade a verdict nobody can clear for a verdict nobody
can trust, which is the worse of the two.

**A declared set that is not known is not an empty one.** `declaredEdgeFunctions`
is `readonly string[] | null`; `null` restores exactly the old comparison. The
tree walk that produces the list is never capped, skipped or filtered — that is
why `declaredFunctionSlugsFromPaths` reads the TREE rather than the snapshot's
`functions` array, which two economies narrow and a third empties outright.

**Every comparison states what the contract is, or states that it cannot.** A
test rejects any `computeParity` call made with two arguments: a caller that
genuinely has no repo context passes `{ declaredEdgeFunctions: null }` and says
so.

## A fixed cost in front of the first stage is a livelock

Widening the secret-name scan to every bundle the prime defines was the right
fix for nine-of-eighty-six secrets. It also made the snapshot the dominant
fixed cost of a pass — ~1,033 files across 423 bundles, about thirteen batched
GraphQL requests plus the decode — and that cost is paid **before the first
stage runs**.

Measured 4 Sep 2026 across half an hour of one-minute ticks:

```
{"processed":1,"results":[{"ok":false,"error":"deploying edge functions","budgetPaused":true}]}
{"processed":1,"results":[{"ok":false,"error":"replicating the pg_cron schedule","budgetPaused":true}]}
```

Every invocation claimed one job, spent its 50 s, and paused at the same stage
it had paused at the tick before. `attempts` stayed 0 — a budget pause is
forward progress by construction — so nothing anywhere reported a problem.
Two clones sat there indefinitely, each one pass from finishing.

That is not slow progress. **When the fixed prologue exceeds the invocation
budget, the pipeline cannot advance at any number of ticks**, and the signal
that would say so is the one signal the design deliberately treats as healthy.

The two things the expensive fetch buys — the secret names and the declared
slug list — are properties of `(repo, commit)`. Nothing about a clone can
change them. So they are cached by commit in `prime_snapshot_scans`, and a
pass skips the fetch when all three hold:

- the schema is not being resumed (a resumed pass omits the fetch anyway),
- a complete scan is cached for **exactly this commit**, and
- the clone already holds every function the repo declares, so no bundle would
  be deployed even if it were fetched.

Miss any one and the pass buys the fetch exactly as before.
`shouldSkipFunctionSource` is pure so the conditions are pinned rather than
described.

Three rules bite.

**The key is the commit, never the branch.** A branch moves; a scan attributed
to a moved branch is a scan of a tree nobody has.

**Only a complete scan is written.** `scanIsCacheable` judges completeness by
`functionSourceOmitted` — the flag — and not by the list looking plausible. A
pass that read no bundle did not produce those names, whatever they are, and
recording its empty list under a real commit would teach every later pass that
the prime references no secrets at all: the nine-of-eighty-six defect, made
permanent and indistinguishable from a correct answer.

**An empty cached list is a miss.** The prime references 86 secrets. Zero is
the shape a broken scan leaves behind, so it buys the fetch rather than being
trusted.

## An absent function source has two causes, and only one is a reason to stop

The fix above moved the wall rather than removing it, and production said so
within four minutes of the publish:

```
Paused at the invocation budget — the edge functions need the prime's source,
which this pass did not fetch — taking a full snapshot next tick
```

Both clones, every tick, for the same good reason each time. The pass declined
the fetch **because the project already holds every function the repo
declares**, and then the edge-function stage refused to proceed *because the
pass had declined the fetch*. A livelock one stage earlier than the last one.

The guard it hit was written for a different cause and was right about that
one: a resumed schema pass declines the fetch and provably cannot reach this
stage, so arriving here with no source meant something had gone wrong, and
deploying nothing while reporting success is the worst outcome available. What
the guard could not do is tell that cause from the new one.

**The distinction is settled against the project, never against the snapshot.**
`declaredFunctionSlugs` is the repo's tree walk and is complete on every pass
including this one; the project is asked what it is actually running. If
anything declared is not yet deployed, the pass pauses and fetches — today's
behaviour. If nothing is, the stage is already satisfied, says so, and the
pipeline moves on.

Both conservative readings still pause. **An empty declared list is "not
established", never "the prime has no functions"** — the same rule
`functionSourceOmitted` exists to state. And a project whose function list
cannot be read counts as holding nothing, so every declared slug reads as
outstanding and the pass buys the fetch.

The lesson is the general one, and it is now two for two: **a stage that
refuses on the ABSENCE of an input has to know why the input is absent.**
Declining to buy something is not the same as failing to get it.

## The schema build was undoing the re-point, every pass

Exactly four of the prime's 620 database functions embed its project ref, and
step 5c rewrites them to the clone's own — **a clone whose functions call the
prime's project is a tenant reaching into somebody else's database**, which is
why that control exists and why the audit checked it end to end.

The functions stage compared the prime's definition text against the clone's.
So those four read as outstanding on **every pass**, and were re-applied *with
the prime's ref in them*, for step 5c to rewrite again later in the same pass.

Caught mid-pass on the NPC Test clone, 4 Sep 2026:

```
bootstrap_cron_vault                          NAMES THE PRIME
dispatch_web_push_for_portal_notification     NAMES THE PRIME
dispatch_web_push_on_notification             NAMES THE PRIME
invoke_pdf_parse_recover_stuck_jobs           NAMES THE PRIME
```

Its pass had run the functions stage and had not yet reached step 5c. Between
those two points sit the edge-function deploy, the buckets, the storage config
and the auth policy — and **passes pause constantly in that window, because
that is the whole design.** A clone can sit pointing at the prime indefinitely,
and a pass that dies there leaves it that way. A clone marked `ready` by a pass
that died in the window would ship like that.

Nothing reported it. Both stages did exactly what they were written to do, the
count reconciled at 620 = 620, and the re-point step reported four successful
rewrites every time — which reads as the control working rather than as the
control fighting the stage in front of it.

**The rewrite moves to the way IN.** What the clone should hold is the
re-pointed text, so that is what "already held" has to mean, and a definition
that genuinely needs applying is applied already pointing at the clone. That
closes the window rather than narrowing it, and the four stop being permanently
outstanding work that every pass pays for before it can reach the tail.

`repointPrimeUrlsInFunctions` stays exactly where it is. It is the repair for
every clone provisioned before this, which nothing else would correct — it now
simply has nothing left to undo.

The general rule: **two steps that correct each other are not two controls,
they are one oscillation.** The clone's state between them is real, reachable
and, here, wrong.

## A count cannot see WHICH index is missing

The trigger digest closed this for triggers and left it open for indexes, and
the first completed repair found the gap:

```
missing_indexes:1 — public.builder_stock_items_org_development_unit_design_key
```

That is a partial, expression-based UNIQUE index — the key that stops duplicate
builder stock rows. Both sides report **2,166 indexes**, so `cloneCount >=
primeCount` reconciles and the stage is skipped; the clone legitimately holds a
surplus (introspection creates and never drops), which guarantees the count can
never fall short however much is missing.

It was **never attempted**: `aurixa.ddl_failures` holds no record of it, because
the stage was skipped rather than failing. Parity could see it; the builder
could not act on it.

Indexes are digested by **name**, not by definition. Only equality is
conclusive, exactly as for triggers — and here an unequal digest is the
*ordinary* state, because the surplus guarantees it. So it sends the stage on
to compare name lists and **apply only what the clone lacks**. Entering costs
one query and, when nothing is missing, zero statements.

## An authorised forward that did not happen is not an unauthorised name

The same parity report read `missing_secrets:72`. Most of that is correct and
expected: the engine never writes a placeholder, so a vendor secret nobody
marked inheritable stays unset for an operator to supply.

**Ten of the seventy-two were not that.** They were marked inheritable in
`prime_secret_forwards` and silently did not travel: `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_MAPS_API_KEY`,
`DOMAIN_API_KEY`, `GAMMA_API_KEY`, `FIRECRAWL_API_KEY`, `API2PDF_API_KEY`,
`PDF_PARSE_SERVICE_TOKEN`, `WEASYPRINT_SERVICE_TOKEN` — exactly the vendor keys
a tenant is supposed to boot with under the prime's accounts.

The cause is not a bug in the forward: the model reads the prime's credentials
out of **Mission Control's own environment**, so a name MC does not hold cannot
travel however it is marked. The defect is that both cases reported as
`missing`, so nothing anywhere distinguished *"nobody said this may travel"*
from *"somebody said it may, and it did not"* — and the remedies are different.
One is filled in on the clone; the other is fixed on Mission Control, or the
forward is withdrawn.

`authorised_no_value` is its own status, and it went on the **column** as well
as in the code: `clone_backend_secrets.status` is CHECK-constrained, so a
status the column will not accept is refused by Postgres while looking, from
the function, exactly like a write nobody attempted. That is how this table's
ledger came to be empty once already.

## A failed backend with no recorded enqueuer had no lever at all

The retry hook attributes a retry to the row's ORIGINAL enqueuer — the honest
reading of "do that enqueue again", and the fix for a first live call that tried
to write a literal `"system"` into a uuid column. It also **refused** a row
carrying no enqueuer, pointing the operator at the clone page, whose button
routes back to this same hook.

So a failed backend with a null `enqueued_by` had no lever anywhere in the
product. Measured 4 Sep 2026: the NPC Client Dashboard clone sat `failed`
holding a **complete schema** — 649 tables, 624 functions, 2,166 indexes, 32
buckets — unrecoverable for want of an audit field.

**The authority to retry is the CRON_SECRET the handler already verified, not
the column.** Attribution is a record, not a permission, and refusing to repair
a tenant's backend because the audit trail is incomplete gets the trade
backwards. An unknown enqueuer is carried as `null` — which the column accepts —
and SAID in the audit metadata, so a reader can tell "nobody recorded who first
asked" from "this person asked again".

Two things stay exactly as they were. Only a `failed` row may be retried:
widening attribution must not widen which rows qualify. And no literal is ever
written into the uuid column, which is the defect that produced this rule in the
first place.

## The surplus is dropped for indexes, and for nothing else

Introspection creates and never drops, so a clone keeps every object the prime
has since removed. That has been reported and not acted on — correctly, because
nothing in a schema distinguishes a prime leftover from something a tenant added,
and removing the wrong one destroys data.

**An index is the one class where that risk does not exist.** It holds no data of
its own: dropping one can only relax a constraint or remove an access path, and
both are recoverable by creating it again. A table may hold tenant rows, dropping
a policy WIDENS access, and a constraint may be the only thing guarding a column
— so those stay reported and untouched, and a test asserts this module issues no
DROP for any of them.

It is not cosmetic. Measured on **both** clones:

```
builder_stock_items_org_development_unit_key
  CREATE UNIQUE INDEX … (organisation_id, development, unit) WHERE …
```

The prime replaced it with one that also keys on the house design — precisely so
two units in one development with different designs are legal — and then dropped
the old one. The clones kept both, so **every clone refuses builder stock rows
the prime accepts.** A surplus object that changes behaviour, found by looking
rather than assumed absent.

Three guards. A **constraint-backed** index is never dropped: it belongs to a
constraint, and removing it is that other act. The sets are keyed by **schema and
name**, because an index name is unique only within its schema and a collision
across two could otherwise hide a shortfall or target the wrong object. And a
clone whose index list cannot be read yields an empty held set and therefore **no
drops at all** — the same failure direction as the create path, where unreadable
means "do the work", never "assume it is done".

Every drop is recorded on the stage the operator reads. Three per-item steps have
already computed a result and thrown it away; a removal is the one that must
least be silent.

## A pass that did nothing overwrote three facts with the shape of nothing

The fleet migration sync wrote its result unconditionally. So a clone that was
already level — the ordinary, healthy case, where the pass applies nothing —
had three facts replaced:

| Column | Was | Became |
| --- | --- | --- |
| `migration_version` | the version provisioning recorded | `null` |
| `migrations_applied` | what it applied | `[]` |
| `status_detail` | the parity verdict | `Synced to null` |

Measured 4 Sep 2026: **both** ready clones carried exactly that. The third — the
one that is `failed`, and therefore outside this worker's query — still held its
real version and its three migration rows. **Only the healthy clones lost their
record**, which is the wrong way round and is why nobody noticed.

The status line is the worst of the three. It replaced the verdict the
provisioning run had just written — *"Backend provisioned but DOES NOT MATCH the
prime — missing_secrets:72"* — with a string that means nothing and reads like a
bug. That is the two-writers-of-one-status-field rule again: the last writer
wins, and **a sync that applied nothing has nothing to say about the row's
health.**

A no-op pass now writes only what it genuinely establishes — where the prime is
(`source_repo`, `source_ref`, `source_sha`) and the release of its own claim —
and leaves every fact about the clone's schema as it found it. Where the pass
did do something, a null `latestApplied` is never interpolated into prose.

Saying nothing on a no-op must not become saying nothing at all: a failure and a
held-back migration still report exactly as before, and a test pins both.

## A body too big to hold is not a migration that failed

`openPrimeMigrationCorpus` refuses a body past its ceiling, and the ceiling is
right: the template-library seed is one 39 MB `INSERT`, and this runtime cannot
hold it — a 39 MB file is a 52 MB base64 response, a 78 MB UTF-16 string and a
second copy for the split, against a 128 MB isolate.

`applyPrimeMigrations` has always been able to STREAM such a body and send it as
statements the Management API will take. **Only one of its four callers ever
supplied the option.** The other three rethrew the refusal into the generic
failure path, where a failed migration means the clone REJECTED something — so
the fleet sync read `failures.length > 0`, moved the clone to `failed`, ejected
it from its own eligible query, and notified operators that "no further prime
migrations will reach this clone's database."

That is exactly where `NPC Client Dashboard` sat from 3 September, under
`Migration failed at 20260916100000_seed_template_library_v9_report_part_
numbering.sql`. Nothing was wrong with the clone. Nothing had been sent to it.

Two halves to the fix, and the second is the one that matters.

**The two scoped callers now pass the stream they already hold.** Both build a
corpus and both pass `loadSql` from it; `openSqlStream` is on the same object.
One line each. Neither passes a cursor — the self-healing lane persists one
because it runs inside a hard invocation budget, while these are reclaimed after
`STALE_CLAIM_MINUTES` and re-send from the first statement, which is idempotent
because the chunker carries the file's own `ON CONFLICT` clause on every
statement and the ledger row is written only after the last one lands.

**And an oversize refusal is now its own outcome, `heldOversize`.** It halts the
replay exactly as a failure does — the versions after it would run against a
schema missing its effect — and it must never move the clone out of `ready`. The
status line says so in words, because an operator who reads "failed" goes looking
for what the clone rejected and there is nothing to find. With the stream wired
in this branch should be unreachable from both callers; it is kept because it is
the safety net for the next caller, and because the cost of getting it wrong was
measured rather than imagined.

Two things came out of the same file. The sync BUTTON carried its own copy of the
no-op-overwrite defect — `migration_version: latestApplied` unconditionally, so
one press on a level clone would have re-erased the version the scheduled sweep
had just been fixed for keeping. And the discarded-error ratchet had been reading
three of that file's writes as checked **because the word `error` appears in
them — as the name of the `error_message` column**. They were never checked. All
three are bound and branched now and the file's budget is 0.

## The internal signing pair was written by one hand

Every scheduled job on the prime calls an edge function through
`cron_signed_internal_headers`, which HMAC-signs the request with the vault's
`internal_edge_secret`; the function verifies it against `INTERNAL_EDGE_SECRET`
from its environment. **One secret, two places** — and the call works only
while they are the same string. Strict signed verification is hard-locked in
`auth_v2.ts`: there is no fallback to a bearer key.

Provisioning wrote exactly one of them. `planCloneSecrets` classifies
`INTERNAL_EDGE_SECRET` as an identity secret — correctly never inherited from
the prime, since a shared value makes a request signed for either deployment
valid on the other — and **minted a random for the environment that it kept
nowhere.** Nothing wrote the vault half. Measured 6 Sep 2026, identically on all
three clones: the vault held `supabase_url` and nothing else, and
`cron.job_run_details` recorded **~13,900 failed runs in 24 hours per clone**,
every one `internal_edge_secret not configured in vault`. The 138 calls a day
that did leave a clone's database came back 400 or 401. No background job on any
clone had ever run — the prime's own "17,174 refused invocations" incident,
replayed on every tenant from the day it was built.

Four rules carry the fix, in `signingPair.pure.ts` and
`cloneSigningPair.server.ts`.

**The vault is the source of truth, because the environment cannot be read
back.** The Management API lists secret names and never returns a value, so the
only side that can say what the pair IS is the database. The step reads the
vault; a usable value is reused and the environment re-asserted with it; none
is minted and written **vault first, then environment**. If the environment
write fails, the next pass finds the vault value and tries again — it
converges, it never rotates.

**One writer of the value.** Before this, every repair pass minted a fresh
random for the environment (the generic generator has no memory), so even a
populated vault would have been out of step after the next repair. The pair
step decides the value and hands it to the secrets batch through `selfValues`;
the identity branch of `planCloneSecrets` honours a decided value and mints
only for a name nobody decided. Two deliveries of the same value are
idempotent; two *decisions* were the defect.

**The verifier's floor is the plan's floor.** `auth_v2.ts` ignores a key under
16 characters and the signer raises on one, so a vault value below that is
treated as absent and replaced rather than trusted. A generator that cannot
meet the floor throws, because a too-short pair stamped `set` is worse than no
pair.

**The ref that reads is the ref that writes.** The vault is read on one project
and the environment written on the same one, both from
`resolveCloneSecretTarget`, which refuses the prime and Mission Control's own.
The `supabase_service_role_key` placed beside it in the vault — the gateway
credential the signer also needs, and the one the prime's vault carries — is
read from that same project's API keys, so it can only ever be the clone's own.

Two more things. **A ledger reading `set` does not settle this sweep**, unlike
the JWT one: `set` was being written by the generic generator for a value the
vault never received, so on the fleet as it stands it is exactly the state that
needs repairing. What makes a settled fleet cheap instead is the step itself —
one vault read per clone and no write when both halves already agree. And **the
value never reaches an event row, a log line or the recorded outcome**; a test
scans every `console.*` line in the module and the whole of `recordEvent` for
it. `MARKET_INGESTION_CRON_SECRET` was deliberately NOT paired at first: ten
functions gate on it, but the prime itself set no such setting, so the clones
mirrored the prime faithfully there and an engine that invented one would be
inventing a value the prime does not hold. That became a data-driven rule on
6 Sep — see "The prime's own pairs" below.

`/hooks/clone-signing-pair-reconcile` runs every thirty minutes and is what
carries the fleet as it stands.

## F52 — the clone's link to Mission Control was delivered to a file nothing reads

Every clone is issued a Mission Control API key at creation. The key is hashed
into `clone_api_keys` and its plaintext committed into the clone's repository as
`.aurixa/credentials.json`, "so the clone's frontend can read it at build time".
**Nothing reads that file** — not the prime, not any clone, not a workflow. What
reads the key is the prime's edge functions: `_shared/missionControl.ts`,
`missionControlCatalog.ts`, `missionControlSeats.ts`, `missionControlDevices.ts`
and four more, every one through `Deno.env.get("MISSION_CONTROL_URL")` and
`Deno.env.get("MISSION_CONTROL_CLONE_API_KEY")`. Neither name was ever written to
a clone's environment. Measured 6 Sep 2026: every key in `clone_api_keys` had
`last_used_at` NULL — no clone had ever presented one — and one clone had no key
row at all. Every token reservation, seat check and catalogue read on every
clone failed with "MISSION_CONTROL_URL or MISSION_CONTROL_CLONE_API_KEY missing".

The webhook half had the same shape. `fireTokenWebhook` signs each event with
the endpoint row's secret and the clone's `mission-control-webhook` function
verifies against `MISSION_CONTROL_WEBHOOK_SECRET`. No clone had an endpoint row,
and the one row that existed was global and pointed at a misspelt prime
hostname — every delivery since May answered `error code: 1016`.

Four rules carry the fix, in `missionControlLink.pure.ts` and
`cloneMissionControlLink.server.ts`.

**The link is written to the place that reads it.** Four names, one batch — the
URL, the key, the agency name and the webhook secret — in ONE secrets request,
so a half-written link cannot exist. The pipeline runs it as step 5g and hands
the values to the secrets batch through `selfValues`, exactly as the signing
pair does.

**The key is minted where it is delivered, and never rotated on a repair.** A
key's plaintext exists once, at mint. The row records `delivered_project_ref`
and `delivered_env_at`, so "is this project linked" is a fact the next pass
reads rather than guesses: a live key delivered to THIS project is left alone;
a new one is minted only when none is; and the link keys an earlier pass minted
but never delivered — or delivered to a project the clone no longer has — are
revoked when the new one lands. The repository cascade is untouched: whether a
credential nobody reads should keep being committed is a decision for the
owner, recorded in the pre-flight report rather than taken here.

**The webhook endpoint is the readable half.** Its secret lives in
`token_webhook_endpoints`, which is what the sender signs with, so a pass reuses
it and re-asserts the environment — the same convergence rule the signing pair
follows. The link owns exactly one endpoint per clone, recognised by URL shape
(`https://<ref>.supabase.co/functions/v1/mission-control-webhook`); an endpoint
an operator registered by hand is never touched.

**The ref that is written is the ref the key is recorded against.** Every
environment write takes the one `projectRef` from `resolveCloneSecretTarget`
(or, at provisioning, the ref the pipeline is building), and the key row is
stamped with that same ref. `/hooks/clone-secrets-reconcile` carries the fleet
as it stands, twice an hour.

## The clone's OWN secrets, and the ledger that said `missing` for what was there

Three of the prime's features need a secret that belongs to the deployment and
to nobody else. Password-reset tokens are hashed with `RESET_TOKEN_PEPPER`, and
`resetTokens.ts` THROWS without one — so every password reset on every clone
failed. Web push signs with a VAPID key pair, and `send-web-push` answered 503
on every clone for want of one. CSRF tokens are peppered. None of the three can
be inherited — a shared pepper makes reset tokens interchangeable across tenants
and a shared VAPID key makes every tenant's push identity the same key — and
only one of them was minted at all (`CSRF_TOKEN_PEPPER`, as a fresh random on
every repair pass).

`cloneOwnedSecrets.pure.ts` carries the rules. **Minted once, mirrored in the
clone's vault, re-asserted from there**: the environment cannot be read back,
so a pass that minted anew would ROTATE — outstanding reset tokens stop
verifying and every push subscription, bound to the VAPID public key it
subscribed with, goes dead. **A key pair is one thing**: a public key without
its private half signs nothing, so if either half is missing or malformed the
PAIR is re-minted, and a generator that produces a malformed key throws rather
than write a value `setVapidDetails` would refuse. **Mirror the prime's shape;
never invent a pair the prime does not hold**: `FINANCE_PORTAL_CRON_SECRET` has
a database half the prime's own cron reads from ITS vault, and the reminder job
is scheduled only where that entry exists — so a clone gets its own only where
the prime holds one, the prime is read for NAMES and never for a value, and a
prime that cannot be read is "unknown", never "none". `MARKET_INGESTION_CRON_SECRET` follows the same rule: a clone gets its own
only where the prime holds the database setting — see "The prime's own pairs".

The same pass fixed what the ledger SAID. `clone_backend_secrets` read `missing`
for `TURNSTILE_SECRET_KEY`, `REQUIRE_TURNSTILE`, `RESEND_API_KEY` and
`RESEND_FROM_EMAIL` on every clone that had all four, because the batch only
knew what IT had written and the identity steps write directly. The batch now
takes `settled` — names another step wrote, with the time it did — records them
`set` at that time and writes nothing; a `REQUIRE_TURNSTILE` the batch could
neither settle nor derive is `tenant_scoped`, because the prime's `true` on a
clone with no widget refuses every login.

## Deployment config is derived from THIS clone's hostnames — and re-derived when they change

`DERIVED_DEPLOYMENT_CONFIG` used to hold one name. Left unset, `APP_BASE_URL`
made a clone's builder-portal invite link to
`https://command-centre.npcservices.com.au` — the prime's own site — and
`WEBAUTHN_RP_ID` unset switched passkeys off. Eleven names are derived now:
the public URL trio, the web-push host, the WebAuthn relying party (its id, its
origins and its display name), the Mission Control URL and agency name, and
`AML_PROVIDER_MODE=live` — the one constant, because a clone is a production
deployment of a reporting entity and the prime's own rule is that production
never runs the AML simulator.

Two rules. **The canonical origin is the hostname the clone is FOR** —
`CloneOrigins.canonicalOrigin`, the allocated subdomain, outranking the hosting
provider's origin that `siteUrl` falls back to until the custom domain is live;
a passkey relying party or an invite link bound to a provider hostname goes
wrong the moment the domain goes live. And **the WebAuthn origins are only the
relying party's own host and subdomains**, because a browser refuses a
credential whose relying party is not a registrable suffix of the page's host.

The derivation runs at provisioning, again from the deployment drain the
moment a domain goes live (`applyCloneDerivedConfig`, beside
`applyCloneAllowedOrigins`), and from the reconcile sweep — writing only what
moved since its own last write, so a value an operator set by hand for a name
it does not own is never stomped.


## The prime's own pairs — and the rule that lets every clone follow

Two of the prime's scheduled jobs (`agent-planner-run-scheduled`,
`market-qa-subscriptions-run-due`) sent `x-cron-secret` from
`current_setting('app.market_ingestion_cron_secret')`, which was never set, to
ten market functions comparing it against `MARKET_INGESTION_CRON_SECRET`, which
was never set either: **401 on every tick on the prime**, and — because a clone
mirrors the prime's shape — on every clone. And nothing COULD set it: the
first pass tried, and the role that owns the database answered `42501:
permission denied to set parameter` — on this platform `postgres` is not a
superuser, and a placeholder parameter can be set database-wide or on a role
only by one. So a database setting can never be a mirror the engine keeps. The
two jobs were moved onto the vault (the prime's `market_cron_secret_from_vault`
migration, which is also their first declaration — both had been scheduled by
hand), and the market pair is a vault pair like the finance one. The finance reminder function
compares the same header against `FINANCE_PORTAL_CRON_SECRET`, whose vault half
the prime never held; and its schedule had since moved onto the signed envelope
(`cron_invoke_signed_function`) and sends no header at all, so the function
also had to learn to accept the envelope from `pg_cron` — that half is in the
prime repository.

By the owner's decision on 6 Sep 2026 the prime is paired too. Four rules.

**One module hands the prime's ref to a secret writer, and it is
`primeSecretPairs.server.ts`.** Every clone-side writer takes its ref from
`resolveCloneSecretTarget`, which refuses the prime by design; this one takes
it from `resolvePrimeBackendRef` — the resolver that refuses to name Mission
Control's own project — and nowhere else, and hands the writer
`PRIME_PAIR_SPECS` and nothing else. A test asserts every clause, and that no
third module calls the generic writer.

**The vault is the only mirror.** It is the one store this role can write on
every project, and a test asserts the writer never reaches for `ALTER
DATABASE`, `ALTER ROLE` or `ALTER SYSTEM`.

**Converge, never rotate.** `/hooks/prime-secret-pairs` runs hourly. A pass
over a prime whose mirror already holds a usable value reuses it and
re-asserts the environment; only a missing half is minted. A pass over a
prime somebody half-changed puts it back.

**Once the prime holds a half, every clone follows — with its OWN value.** The
clone sweep reads the prime's shape (`readPrimeShape`: vault names, never a
value) and `OWNED_SECRET_SPECS` gates the two pairs on it. A clone whose prime
holds `finance_portal_cron_secret` mints its own; one whose prime holds
`market_ingestion_cron_secret` mints its own. The prime's value never travels.

## A clone is a PROJECT, not only a database

The whole AML/CTF module was dead at the API layer on every clone, from the day
each was built, for **two independent reasons — each fatal on its own, and the
second hidden behind the first**.

**PostgREST serves only the schemas its project exposes.** The prime's
`db_schema` is `public, graphql_public, aml`; a fresh project gets the platform
default, which is the first two. So all 29 modules across 22 edge functions
that reach `.schema('aml')` answered `PGRST106 Invalid schema: aml`. Measured
6 September 2026 on NPC Test: `aml-verification-processor` returned HTTP 500 on
**510 of 510** cron runs in twenty-four hours, logging exactly that. The prime's
same function returned 200 on all 1,410.

**And the `aml` schema had no grants of any kind** — no schema `usage`, no table
privileges, no default privileges, for any API role. So fixing the exposure
alone would have moved the error to `permission denied` and looked like a brand
new fault.

### Why nothing saw it

Neither is a database object. Catalog introspection compares tables, columns,
indexes, policies and triggers, and it was **right about every one of them**:
the 113 `aml` tables and their 112 RLS policies are present and byte-identical
to the prime. They were simply not addressable. This is the same class as
[the project's upload limit](#a-bucket-may-not-ask-for-more-room-than-the-project-allows),
which made two storage buckets impossible to create for a reason no
bucket-level retry could ever fix.

The grants half has a second cause, and it is
[the index lesson](#a-count-cannot-see-which-index-is-missing) again in a new
place. The grants stage reconciled on **one number across every replicated
schema and all three API roles**. A clone's `public` grants are written by this
stage in a uniform sweep and legitimately come out ABOVE the prime's, so the
total satisfied `cloneCount >= primeCount` while `aml` held nothing at all. The
stage was **skipped rather than failed**, so nothing was recorded anywhere:
`aurixa.ddl_failures` is empty of it, and parity reported the clone exact.

### What now holds it

- **`replicateApiConfig`** mirrors the prime's exposed schemas through the
  Management API, beside `replicateStorageConfig`, for the same reason and in
  the same place. It **never narrows** — a schema only the clone exposes
  survives — and a failure is reported and non-fatal.
- **The API is the deterministic way to apply it, and the only timely one.**
  Writing `pgrst.db_schemas` onto the `authenticator` role — what the endpoint
  does underneath, and what the dashboard's *Exposed schemas* control writes —
  does eventually reach PostgREST, but only when it next recycles and re-reads
  its in-database config. `NOTIFY pgrst, 'reload config'` does not bring that
  forward: two of them over seventeen minutes changed nothing, and the schema
  became reachable about eighteen minutes later on PostgREST's own schedule.
  **A correction to an earlier reading of this**: the conclusion at the time
  was that the role setting never reaches a running PostgREST at all. It does.
  What it does not do is land when you ask it to — and a repair pass that
  cannot say when its own effect arrives is not a repair, which is why this
  goes through the API rather than a migration.
- **Grants are digested**, so a surplus on one schema can no longer mask an
  absence on another. The SCHEMA acls ride in the same digest as the table
  acls, because a missing `usage` makes every table grant inside it unreachable
  and a digest blind to it would reconcile a clone that cannot read one row.
- **The stage diffs before it applies** — it asks the clone what it holds and
  carries only the rest, the rule the indexes and triggers stages already
  follow. That is what keeps entering it cheap now that a legitimate surplus
  keeps its digest unequal for ever.
- **Schema `usage` lands first**, because every table grant under it is inert
  until it does.
- **Default privileges are replicated**, so a table created by a migration
  cascaded later is not born unreachable and this deficit cannot re-open
  silently.
- **Grants are read from `pg_class.relacl`, never from
  `information_schema.role_table_grants`.** That view is filtered to grants
  whose grantor or grantee is a role the *current* user belongs to, so two
  projects read by two connections answer two different questions. That is not
  a comparison.

## Identity verification costs money here and tokens there

Didit bills **Aurixa**, not the tenant. A complete verification is three
standalone calls — `id_verification_api` USD 0.20, `passive_liveness_api` USD
0.05, `face_match_api` USD 0.05 — and **none of the `_api` endpoints carries a
free tier**, which was measured against the live account on 8 September 2026
rather than read off the pricing page: the 500/month allowance belongs to the
workflow/session features, and the direct `/v3/` routes this product calls
meter under a separate `_api` counter. USD 0.30 per verification, on the
prime's own credential, for every clone, because the key stops here and the
CALL travels (see the verification broker).

**Aurixa shoulders that money.** A workspace pays in tokens instead:

| what happened | tokens |
|---|---|
| an attempt was consumed | **5** |
| …and the identity was verified | **5 more** |
| a photograph the provider could not read, or any failure of ours | **0** |

So a verified customer costs 10, a genuine decline costs 5, and a retake costs
nothing. There is **no monetary line on a clone's statement for Didit at all**.

### Where each half lives, and why it is not one place

| the rule | lives in | why there |
|---|---|---|
| **the number** — what one attempt costs | Mission Control `report_credit_costs.aml_identity_check` | it is the platform's price list, a clone resolves its reserve from it through `getCreditCostForKind`, and it is what the Aurixa Systems pricing page publishes to customers |
| how the number is applied (attempt, doubled on success) | prime `supabase/functions/_shared/aml/verificationTokenPrice.pure.ts` | the clone is the party that knows whether an attempt was consumed |
| when to reserve, commit or release | prime `_shared/aml/standaloneVerification.ts` | one hold, taken after the last free step and settled at the single settle write |
| that Didit's money is not recharged | Mission Control `api_provider_rates.absorbed` | the money is Mission Control's; the clone never sees a vendor invoice |

**There is ONE number and Mission Control owns it.** The index has carried
`aml_identity_check` at 5 credits since 28 July 2026; that row is the ATTEMPT
price and a verified identity costs it twice, which is why nothing in the
prime states a price of its own — a literal there would be a second list
disagreeing with the one customers are quoted. Repricing in Mission Control
moves both halves together and reaches every workspace without a deploy. The
constant in the prime is the FALLBACK for an unreachable Mission Control, set
to what a reachable one would have said.

The split is deliberate and it is the same split the rest of this engine uses:
**a clone decides what happened, Mission Control decides what it costs.**
Neither can be moved to the other side. A clone cannot be trusted to assert
its own money model (`normalizeEvent` strips `brokered` at the public boundary
for exactly this reason), and Mission Control cannot know whether a
photograph was legible.

### What a clone inherits, and what it does not

**Nothing here is provisioned per clone.** That is the point, and it is worth
stating because every other section on this page is about something that had
to be carried.

- **The charge rule is code**, so it arrives through the cascade like any
  other prime change. A clone that is behind on the cascade charges nothing —
  it does not charge *wrongly*.
- **`absorbed` and the token price are one row each in Mission Control's own
  catalog**, fleet-wide. There is no per-clone copy to drift, and the price is
  polled rather than deployed.
- **The credential does not travel.** `DIDIT_API_KEY` is `withheld` on every
  clone and the broker holds it. A clone that somehow held one would be rated
  `byok` and absorb nothing, which is correct: it would be spending its own
  money.
- **The two Mission Control secrets are already forwarded** —
  `MISSION_CONTROL_URL` and `MISSION_CONTROL_CLONE_API_KEY`, which the token
  reservation needs and which the same clone already uses for reports.

One thing **is** carried and must land: the prime migration
`20261114090000_verification_workspace_out_of_tokens.sql`, which widens
`aml.verification_checks.provider_error_category` to admit
`workspace_out_of_tokens`. Until it applies, a refusal write is rejected by
the column while looking, from the edge function, exactly like a write nobody
attempted — the `reminder_type` defect this platform has already paid for
once. The migration asserts its own effect and raises if the constraint did
not widen, so a clone that misses it fails loudly at apply time rather than
quietly at refusal time.

#### Landing it is two acts, and the second one is the one that gets forgotten

**A migration in the prime's repo is not a migration a clone may run.**
`scopeCorpusToPrime` decides the runnable set by exact membership of the
prime's own `supabase_migrations.schema_migrations` and by nothing else — the
prime's ledger is the authority on what the schema IS, the repo is the
authority on what each version SAYS, and a version needs both to reach a
tenant. Merging the pull request supplies only the second.

The prime does not apply on merge and deliberately cannot. `supabase db push`
trusts that ledger, and this ledger under-reports by about two orders of
magnitude — measured 13 August 2026, it called 133 migrations pending while
all but one family of the tables and functions those files declare already
existed — so a push would replay ~130 applied migrations including data
mutations that are not no-ops the second time. `apply-migration.yml` applies
exactly the one file it is dispatched with, and choosing the file is a human
judgement made before dispatch.

So the order is:

1. Merge the prime pull request.
2. Dispatch **`apply-migration.yml`** on the prime's `main`, with
   `file: supabase/migrations/20261114090000_verification_workspace_out_of_tokens.sql`
   and **`record_version: true`**.
3. Confirm the ledger row exists. That row is what the fleet sync reads.
4. The next `backend-catchup` tick moves the migration from `withheld` to
   `runnable` and applies it to every clone.

**Step 2's checkbox is the whole risk.** Applying without recording leaves the
prime perfectly correct and every clone permanently withheld — and the sync
then reports `pending: 0` beside "clone already at prime migration head within
the fleet sync's scope", which is TRUE, reads as healthy, and is how a fleet
comes to be missing one column constraint that nothing will ever raise again.
The `withheld` count is a single number in the eight hundreds and cannot be
read in either direction on its own; the breakdown beside it is what an
operator should look at, and `never_applied` is the half that matters.

This is not special to Didit. It is how **every** schema change in this
programme reaches a tenant, and it is the one step in the cascade that no
timer performs.

#### And a third act, which is where this one actually stopped

Both acts above were performed for `20261114090000` and the next tick still
carried nothing. `pending: 0`, `withheld: 879` — unchanged — and one field
that had been `0` all day now read **`held_back: 1`**.

**A runnable migration sitting behind a withheld one is held, not applied.**
`applyPrimeMigrations` is handed the whole corpus alongside the runnable set
for exactly this reason: `runnable` on its own cannot say whether a cleared
version sits behind an uncleared one, and applying N while N−1 is unaccounted
for is how a migration lands against a schema its author never saw. The
result carries `blockedBy`, and the count of those is `held_back`.

Fourteen files sit between the prime's ledger head (`20261112010000`) and
this one, and **none of them is in the prime's ledger** — so the newest
migration in the tree is behind fourteen withheld ones and cannot move.

Measured, and this is the part that matters: those fourteen are **applied but
unrecorded**, not missing. `crime_reference`, `transport_stops`,
`investment_report_sections` and `planning_data_cache` all exist on the prime
*and* on the clones. This is the ledger under-report the apply workflow's own
header describes, seen from the other end — and the consequence is larger
than one migration:

> **Until the prime's ledger catches up with the prime's schema, the fleet
> sync can deliver no new migration to any clone, ever.** Not this one and
> not the next one. It reports the condition as a single integer in a field
> beside two larger ones, and every other signal reads healthy.

The remedy is to record the applied-but-unrecorded versions on the prime —
`apply-migration.yml` with `record_version: true`, per file, once it has been
confirmed that the file's effect is already present. That is a per-file
judgement against a production database and it is the owner's to make, not a
sweep to automate: recording a version whose effect is *absent* tells every
clone it is done and withholds it for good, which is the same silence in the
other direction.

What was done here instead, and why it is the narrow option: the one CHECK
widening was applied directly to each clone and recorded under the same
version, after confirming all three carried byte-identical constraints and
that the change only ever widens. One additive, idempotent, self-asserting
statement is a safe thing to hand-apply; fourteen files including table
creations and data mutations is not.

### Four rules that keep it from drifting

**The trigger is the product's own `attempt_consumed`, never "a call was
made."** This product's definition of an attempt is deliberately narrower than
"we spent money": `capture_unusable` — the provider looked and could not
examine the document — consumes none, and every infrastructure condition is
recorded without touching the customer's attempt count. Charging on the same
signal means a workspace is never billed for our failures or for a bad
photograph, and the token ledger and the attempt counter cannot disagree,
because they are the same fact read once.

**The reserve is the maximum and the commit is the truth.** The charge is
unknown until the vendor answers and the vendor is not asked until the answer
can be paid for, so the hold is twice the attempt price and the settle is
nothing, once or twice it. Reserving one would let a success land that nobody
could pay for. The price is read ONCE, before the reserve, and carried on the
hold — the catalog is cached for minutes, and settling at a price the
reservation was not taken at is how a workspace comes to be asked for more
than was held.

**Only an explicit refusal blocks.** An unreachable, slow or unparseable
Mission Control lets the verification run *unmetered*, and the row records
that it did. Same asymmetry as the activation gate, for the same reason: the
enforcement that protects revenue is Mission Control's own 402, while the
failure this could otherwise cause is refusing to verify somebody who has
paid. A settle that never lands is recorded, never thrown — it must not turn a
completed verification into a failure.

**A workspace out of tokens is not a vendor out of credit.**
`workspace_out_of_tokens` and `insufficient_credits` send an operator to
opposite remedies (top up Mission Control; top up the Didit account), so they
are separate codes and a test asserts they cannot be spelled the same. The
check stays `technical_failure`, no attempt is consumed and no customer
outcome is written, so `retry_verification_processing` re-runs it once the
balance is topped up.

### Checking it on a clone

Four readings, in the order that isolates a fault:

1. **Is the price there?** On the clone's repo, `git log -1 --format=%H --
   supabase/functions/_shared/aml/verificationTokenPrice.pure.ts`. Absent means
   the cascade has not delivered it and nothing is charged.
2. **Can the column record a refusal?** On the clone's database,
   `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname =
   'verification_checks_provider_error_category_check'` — it must contain
   `workspace_out_of_tokens`. Absent, ask the PRIME's ledger before suspecting
   the clone: `SELECT 1 FROM supabase_migrations.schema_migrations WHERE
   version = '20261114090000'`. Missing there means the dispatch above never
   happened, the fleet sync is correctly withholding the file, and no clone
   will ever receive it however many times the catch-up runs. Present there
   and still absent on the clone, read `held_back` on the latest
   `sql_migration` run: non-zero means the file is runnable but sits behind
   an unrecorded predecessor, and the prime's ledger — not the clone — is
   what needs the repair.
3. **Did a real verification charge?** On the clone,
   `SELECT outcome_detail->'standalone'->'token_charge' FROM
   aml.verification_checks WHERE provider = 'didit_standalone' ORDER BY
   completed_at DESC LIMIT 5`. `metered: false` means Mission Control was
   unreachable at the time — a real condition, not a silent zero — and
   `attempt_tokens` is the price the hold was taken at, which should equal the
   index's `credit_cost` unless it was repriced since.
4. **Did the money stay ours?** On Mission Control, `SELECT billing_reason,
   sum(rated_micros), sum(cost_micros) FROM api_usage_events WHERE secret_name
   = 'DIDIT_API_KEY' GROUP BY 1`. `absorbed` rows must show a real cost and a
   zero charge. A `brokered` row appearing again means `absorbed` was cleared
   on the rate — and the tenant is being billed twice.
