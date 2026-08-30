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

| Queue               | Worker                              | Cadence      | What it produces                                                                 |
| ------------------- | ----------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| `cascade_events`    | `/hooks/cascade-drain`              | every minute | the module files, merged into the clone's repo                                   |
| `clone_backends`    | `/hooks/backend-provisioning-drain` | every minute | the clone's own Supabase project — schema, edge functions, secrets, seeded admin |
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

*(updated 28 Aug 2026)*

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
