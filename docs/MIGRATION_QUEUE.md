# The migration queue

Read this before touching `public.schema_migration_queue`,
`aurixa.drain_schema_migrations()`, `src/server/migrationQueue.pure.ts`,
`src/server/migration-enqueue.server.ts`, `/hooks/migration-enqueue`, or
`.github/workflows/apply-migrations.yml`.

`docs/MIGRATION_AUTOMATION_OPTIONS.md` is the decision record this implements —
what was measured, what was tried, and why the obvious design was rejected.
This is what got built.

## The problem, stated exactly

Migrations merged to `main` were applied to Mission Control's database **by
hand**. The workflow built to automate it (PR #73) failed on every run, and its
message — *"SUPABASE_ACCESS_TOKEN is not set"* — pointed at a secret that could
not have helped:

```
list_projects (this account's Supabase auth) → 4 projects, none of them it
get_project('fgpvagejkaeqedcwvbte')          → 403 "You do not have permission"
```

Confirmed by Supabase's own documentation on identifying a Lovable backend:

> You won't see this project in your Supabase Dashboard, and you won't have
> access to service role keys or **direct database URLs**.

Mission Control's database is a Lovable Cloud project in **Lovable's** Supabase
organisation. No token issued to this account reaches it. Neither the Management
API nor `psql` was ever going to work, whatever secret was set.

## Why not a `SECURITY DEFINER` runner in `public`

That was the obvious design. It is rejected on three findings that were
**reproduced on this database**, not reasoned about:

1. **The 8-second ceiling cannot be escaped.** `authenticator` carries
   `statement_timeout=8s, lock_timeout=8s`, so every PostgREST call inherits it.
   Setting it in a function's `proconfig` does not help — the timer is armed when
   the top-level statement begins and a GUC change mid-statement does not re-arm
   it. Confirmed: a definer function with `SET statement_timeout='1s'` ran
   `pg_sleep(3)` to completion. And `current_setting()` inside the function
   reports the new value, so every way of checking the fix from inside reports
   success. **117 of 211** migrations do a top-level `CREATE INDEX` or `UPDATE`
   backfill.
2. **The dominant failure mode writes no record.** `EXCEPTION WHEN OTHERS` does
   not catch `57014 query_canceled`, so the statement timeout — the *most likely*
   failure given (1) — bypasses the accountability the design rests on.
3. **The runner would silently un-harden itself.** `pg_default_acl` grants
   `EXECUTE` on every new `public` function to `anon` **and** `authenticated`;
   77 of 145 public functions are anon-executable today. `CREATE OR REPLACE`
   preserves an explicit `REVOKE`; **`DROP` + `CREATE` does not** — so a future
   signature change applied *through the runner* restores `anon=X` and returns
   success. Of 45 `REVOKE ALL ON FUNCTION` statements in this corpus only 13 name
   `authenticated`.

## What was built

```
merge to main
  → apply-migrations.yml selects the files the push ADDED
  → POST /hooks/migration-enqueue          (Bearer CRON_SECRET)
  → public.schema_migration_queue          (service_role: SELECT, INSERT — nothing else)
  → schema-migration-drain, every minute, as postgres
  → aurixa.drain_schema_migrations()       (SECURITY INVOKER, non-exposed schema)
  → EXECUTE the SQL, stamp supabase_migrations.schema_migrations
  → the workflow polls until applied or failed, and is RED on failed
```

Finding 1 dissolves: the drain runs in a pg_cron background worker. `postgres`
has **no** `statement_timeout` in `pg_db_role_setting` — the 8s ceiling is an
`authenticator` setting and nothing else inherits it. The job's command sets its
own budget (`20min` statement, `30s` lock) rather than trusting a cluster
default.

Finding 3 dissolves: **there is no function in `public` at all.** The drain
lives in `aurixa`, which PostgREST answers `PGRST106` for, and which has no
`pg_default_acl` entry — every entry on this database is schema-scoped and there
is none for a schema that did not exist. It is `SECURITY INVOKER`, so a role that
somehow reached it would run the migrations with *its own* privileges, and
`has_schema_privilege('service_role','public','CREATE')` is `false`. **The
privilege comes from who runs the function — `postgres`, via cron — never from
the function.**

## The line that actually protects the queue is a REVOKE, not RLS

`service_role` has `rolbypassrls = true`. RLS never filters it; only `GRANT`s do.
And `pg_default_acl` grants `arwdDxtm` (**ALL**) on every new `public` table to
`anon`, `authenticated`, `service_role` **and `sandbox_exec`**.

So `CREATE TABLE` alone would have left the API key able to `UPDATE` a row to
`applied` without the SQL ever running, or `DELETE` the evidence that it failed.
The migration revokes the default grants and re-grants exactly `SELECT, INSERT`.
That is the control. Creating the table is not.

The named roles are revoked **conditionally**, because this corpus is replayed
onto clone databases and `sandbox_exec` is a Lovable Cloud role a plain Supabase
project does not have — `REVOKE … FROM <missing role>` aborts the whole replay.

## What is still true, and is not hidden

**A `service_role` holder can enqueue arbitrary SQL that executes as `postgres`
within a minute.** Any mechanism that lets Mission Control apply its own
migrations necessarily grants DDL to whatever credential Mission Control holds.
That is inherent, and it is a real increase — `service_role` has no DDL today.
What changes is that it is no longer one forgotten word away from `anon`.

The credential that **submits** work cannot **report** on it: every status
transition belongs to the drain, which `service_role` cannot reach.

## Rules that bite

**A failed migration HALTS the queue.** Migrations are ordered; applying N+1
after N failed is how a schema becomes something nobody can reproduce — the same
rule `applyPrimeMigrations` follows for a clone. Nothing after a failed row runs
until it is resolved.

**A failure leaves nothing applied.** The `EXECUTE` sits inside a PL/pgSQL
sub-block, which is a savepoint, so the migration's own effects are rolled back
before the failure is recorded. That is what makes the bounded retry safe.

**Three attempts, then terminal.** Two of the three exist to absorb lock
contention. A deterministic SQL error fails three times in three minutes and then
stops, rather than retrying forever.

**The attempt counter is incremented outside the savepoint**, or a migration that
fails deterministically would retry every minute for ever.

**`CONCURRENTLY` is refused at enqueue.** The drain applies a batch inside one
transaction, so `CREATE INDEX CONCURRENTLY` raises `25001`. Measured: **0 of 211**
files contain one. Refusing it at the door turns a confusing drain-time failure
an hour later into a red merge with the file named. `migrationQueue.pure.ts`
strips SQL comments first — a guard that fires on prose reports a contradiction
about correct code, and those are the guards people learn to silence.

**`version` is UNIQUE and a repeat submission is `ON CONFLICT DO NOTHING`.** Not
a merge: a version already on the queue is history, and overwriting its SQL from
a later submission is exactly the "edited an applied migration" mistake the
pipeline refuses everywhere else. `cron.schedule` calls and seed `INSERT`s in
this corpus are not idempotent, so a second application is not a no-op.

**Enqueueing is not applying.** The workflow polls until every submitted version
reaches `applied` or `failed` and exits non-zero on failure, on a version the
queue never received, and on the wait running out. A run that only proved the
POST succeeded would reintroduce the exact silence this replaces.

**A lost enqueue is not a slow one.** `judgeBatch` keeps `missing` separate from
`pending`, because reporting the two as one is how a caller waits out a timeout
for something that was never going to arrive.

**The advisory lock is transaction-scoped.** `pg_try_advisory_xact_lock`, so it
is released by the commit or the rollback and there is nothing to forget on an
error path. A session lock in a worker that dies mid-run parks the queue until
somebody notices.

## Configuration

| where | name | value |
| --- | --- | --- |
| GitHub **secret** | `CRON_SECRET` | the same value as `cron_secret` in Mission Control's Supabase Vault |
| GitHub **variable** | `MISSION_CONTROL_URL` | this deployment's public origin |

Neither is defaulted. A wrong origin posts migration SQL to somebody else's
deployment; a guessed `CRON_SECRET` is the value 32 scheduled jobs already
authenticate with, and this platform has broken all of them at once that way
before. **Do not change `cron_secret` to match a new GitHub secret — copy the
existing value into GitHub.**

`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are **no longer used** and
`.github/scripts/apply-migrations.mjs` is deleted rather than left dormant. A
dormant applier holding an organisation-wide token is one `workflow_dispatch`
away from writing this control plane's admin schema onto a tenant — which is
precisely what its own `FORBIDDEN_REFS` list existed to prevent.

## Bootstrap

`20260828030000_schema_migration_queue.sql` is the last migration that has to be
applied by hand, by definition: it is the thing that applies the rest.

## Operator surface

`/health` → **Migration effects**. A queued or failed migration appears above
the assertion list, and a failed one is drawn as the halt it is rather than as
one bad file.

## When this queue halted

`INCIDENT_2026-09-08_MIGRATION_QUEUE_HALT.md` records the 41 hours this queue
spent stopped, in September 2026, and is the one to read before retrying a
failed row. Three things from it bear repeating here:

**A failed migration halts the queue, and the halt is invisible from a caller's
own verdict.** `action: "status"` answers about the versions the caller
submitted, so three consecutive merges reported truthfully that their own files
were "still queued" and none of them named the failed row holding the line. If
migrations stop applying, read the queue whole — the head of it, not your part.

**Marking a row applied without executing it is sometimes the correct repair,**
and it was here: the database already carried the effect of six migrations that
had been applied out of band, so replaying them would have moved it backwards.
That decision needs evidence, and the evidence is structural — does the column
exist, does the constraint carry the value, does the function mention it — never
`supabase_migrations.schema_migrations`, which the app role cannot read and
which therefore answers `[]` to every question.

**One row on this queue must never run again.** `20260909072756` resets six
rows to `queued`; replaying what that releases would double a billing rollup and
charge for calls the business absorbs. Its header says so, and the incident
record says why.

## Recorded, never replayed

**A migration the platform applied before it was committed is RECORDED and
never re-executed.** Measured 12 Sep 2026; `20260912150000_recorded_never_replayed.sql`
carries the full working.

### The guard that was not one

`aurixa.drain_schema_migrations()` ran `EXECUTE v_row.sql` unconditionally. The
statement immediately after it —

```sql
INSERT INTO supabase_migrations.schema_migrations (version)
SELECT v_row.version WHERE NOT EXISTS (…)
```

reads like an already-applied guard and is not one. It prevents a duplicate
ledger **row**, not a duplicate **apply**.

### Why that matters here and not everywhere

Mission Control is edited in two places. This repository is one; Lovable is the
other, and Lovable **applies** the migrations it authors, then commits the file
afterwards:

| | |
| --- | --- |
| migration files in the corpus | 268 |
| authored by Lovable (`gpt-engineer-app[bot]`) | 141 |
| …of those, postdating this queue | 3 |
| …of those, that reached the queue and were replayed | 2 |

Both replays were harmless **by luck**. `20260909010118`'s own header says so:
*"every statement here is `IF NOT EXISTS` and the backfill is guarded."* That is
a property of those files, not of the pipeline.

The third shows the cost when the luck runs out. `20260909072756` reads **"DO
NOT REPLAY"** because releasing what it releases adds a rollup quantity a second
time — `billable_quantity + SUM(quantity)` is an absolute, not a delta — and
flips the `absorbed` rows to billable, charging for calls the business absorbs.
It escaped only because its own count assertion refused on the retry and an
operator deleted the row by hand.

### The ledger cannot answer it — measured, not assumed

The obvious fix is for the drain to skip a version already in
`supabase_migrations.schema_migrations`. Of the 141 Lovable-authored files:

```
ledger carries the file's OWN version exactly :  36
ledger carries a row within 10 seconds        : 138
no ledger row within 10 seconds               :   3

skew (ledger minus filename): -7s -4s -3s -2s +2s +3s +4s +5s +6s +7s
```

Lovable stamps the ledger when it **begins** applying and names the file when it
**writes** it. A version-equality test answers "never ran" for 105 files that
demonstrably ran; a ±10s window is a guess that, in a burst of migrations
seconds apart, lands on a different migration's row. **The ledger records that
something ran; it cannot say which file.**

The filename shape is not the answer either — `migrationProvenance.pure.ts` was
written in this repository after a shape heuristic misread six genuine applies,
and a UUID filename is a shape.

### So the submitter declares it, and the declaration is an ACCOUNT

`apply-migrations.yml` reads the author of the commit that **added** each file.
A migration added by the Lovable app was applied by Lovable before it reached
the repository. It is matched on the numeric account id (`159125892`), because a
display name can be changed and an account id cannot.

The two signals disagree on **4 of 268** files and the author is right both
times: one bot-authored file is slug-named (the shape would have replayed it)
and three UUID-named files were added by somebody else (the shape would have
skipped them).

### Three rules

**`recorded` is not a kind of `applied`.** "this queue ran it" and "this queue
was told it had already run" are different facts, and collapsing them loses the
distinction at the one moment it matters — when a migration's `@asserts` claim
later fails and the question is whether anything ever executed that file here.

**The declaration decides what to RUN and never what is TRUE.** If Lovable ever
commits a migration it did not apply, recording it would leave the schema
silently short of the effect. That is caught by machinery this repository
already runs: every migration declares a checkable effect, and
`migration-drift-hourly` (`17 * * * *`) evaluates those claims against the
database every hour and surfaces them on `/health`.

**Unknown means RUN.** An unreadable author warns and executes, which is the
behaviour that existed before this. A guard that skipped on doubt would leave
the schema short of an effect nobody applied.

### A shallow clone is refused, not tolerated

`git log --diff-filter=A -1 -- <path>` walks only the commits it has. At depth 1
that is the tip, so **every** file resolves to whoever made the last commit —
not silence, a confident wrong answer. A push authored by the Lovable app would
then mark its whole batch record-only and stamp all of it without running any of
it.

`apply-migrations.yml` checks out with `fetch-depth: 0` two steps above, so a
shallow clone there means the workflow has been edited into an inconsistent
state. The step refuses and names the cause rather than classifying.

This was found by CI, not by reasoning: the first version of the test read this
repository's real history, passed locally and failed on `ci.yml`, which checks
out at depth 1. The test now builds a fixture repository with known authors, so
it is coupled to the rule rather than to a mutable log.

## No path into the queue is ungated

`ci.yml` runs the migration gates and fires on the same push as
`apply-migrations.yml`. The two run **concurrently**, nothing makes the apply
wait, and a red `ci.yml` has never stopped a migration executing. On a direct
push there is no pull-request CI at all — and both migrations this queue has
ever replayed arrived exactly that way, from `gpt-engineer-app[bot]`, commit
messages "Work in progress" and "Changes", with no pull request and so no review
of any kind.

The four corpus gates therefore run **inside the apply job**, before the
submission, where a merge, a direct push and a `workflow_dispatch` all pass
them:

```
check-migration-pipeline     version format and uniqueness
check-migration-secrets      no credential literals
check-migration-replay       no re-creation collisions
check-migration-assertions   every migration declares a checkable effect
```

They are plain Node scripts over `supabase/migrations` and need **no
dependencies** — only Node ≥22.18, for the type stripping
`check-migration-assertions` uses to import the assertion grammar rather than
keep a second copy of it. Keeping `npm ci` off this path also keeps a registry
outage from being able to stop migrations applying.

The last gate is load-bearing in a new way: it is what makes a *recorded*
migration's effect checkable at all.
