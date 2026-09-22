# Migrations merged through a pull request never reached the database

Mission Control is edited in two places — this repository, and Lovable. Lovable
applies the migrations it authors. Nothing applied the ones that arrive here
through a pull request. They merged, they shipped in the repo, and the database
never saw them.

Measured on 2026-08-27, two examples that had both merged and neither existed:

| migration                                           | what it was for                             | what its absence cost                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260826070000_seed_mirror_exclusions`             | the mirror cascade's exclusion policy       | the cascade could still revert a clone's backend identity — the lead-magnet embed would go back to posting leads into the PRIME's database |
| `20260827030000_schedule_allowed_origins_reconcile` | the `ALLOWED_ORIGINS` reconciler's cron job | a worker that shipped correctly, deployed correctly, and was never once called                                                             |

Nothing reported either. **A migration that never runs looks exactly like one
that ran and did nothing.**

## Why `supabase db push` is not the fix

The obvious answer is to let the Supabase CLI apply what the ledger says is
pending. It cannot work here, and the reason is worth stating precisely because
it is not obvious from looking at either side alone.

`supabase_migrations.schema_migrations` and `supabase/migrations/` are **two
different namespaces describing the same history.** Lovable records a migration
under the timestamp at which _it_ applied the file, not the timestamp in the
filename. Against 207 files:

```
 35   exact version match in the ledger
105   a ledger row 2–5 seconds off the filename   <- same migration, Lovable's clock
 67   no ledger row within two minutes
```

The 105 are the tell. `20260419215311` in the repo is `20260419215308` in the
ledger — the same migration, three seconds apart, and no version-matching
reconciliation can join them.

The remaining 67 are hand-authored files with round timestamps
(`20260609120000`). Some are applied, by an operator running the SQL directly;
some are not; and **nothing in the database distinguishes those two cases.**

So `db push` pointed here would replay ~172 files, including `cron.schedule`
calls and seed `INSERT`s where a second application is not a no-op. The prime
repository reached the same conclusion independently — see the header of its
`.github/workflows/apply-migration.yml`, which measured its own ledger
under-reporting "by roughly two orders of magnitude" and settled on applying one
named file per dispatch.

## What runs instead

`.github/workflows/apply-migrations.yml`, on push to `main`.

It never asks the ledger what is pending. It asks **git what this push added** —
a question with an exact answer:

```
git diff --name-only --diff-filter=A <before> <after> -- 'supabase/migrations/*.sql'
```

Then it hands those files to Mission Control, which queues them in its own
database for a `postgres`-owned pg_cron job to apply. Everything else about the
corpus is left alone.

**The Management API path this replaced could never have worked.** Mission
Control's database is a Lovable Cloud project in _Lovable's_ Supabase
organisation: `get_project` answers 403, and Supabase's own documentation says
such a project has no service-role key and no direct database URL. The workflow
failed on every run and blamed a missing `SUPABASE_ACCESS_TOKEN`; setting it
would have changed the error, not the outcome. `docs/MIGRATION_QUEUE.md` carries
the replacement, and `docs/MIGRATION_AUTOMATION_OPTIONS.md` records every other
channel that was probed and blocked.

Four rules carry it.

**Only ADDED files.** A modified migration is reported as a warning and never
re-applied. Editing an applied migration is the mistake; running the new text
over a database that already has the old one is the damage.

**Filename order is apply order.** Two migrations added in one merge can depend
on each other, and the timestamp is the only ordering either of them states.

**A version already in the ledger is skipped**, so re-running a push applies
nothing.

**There is no target to get wrong any more.** The Management API token reached
every project in the organisation, so a wrong `PROJECT_REF` did not fail — it
wrote this control plane's admin schema onto somebody's tenant. The old script
needed a refusal list and a behavioural identity probe to defend itself against
its own configuration. Now the SQL goes to Mission Control and Mission Control
writes to the database it is connected to, which is the only answer there is.
That whole class of bug is gone rather than guarded.

**Enqueueing is not applying, and the workflow knows the difference.** It polls
until every submitted version reaches `applied` or `failed`, and exits non-zero
on failure, on a version the queue never received, and on the wait running out.
A run that only proved the POST succeeded would reintroduce the exact silence
this pipeline exists to remove — assert by effect, never by configuration.

## What it needs

| setting               | where                          | value                                                               |
| --------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `CRON_SECRET`         | Settings → Secrets → Actions   | the SAME value as `cron_secret` in Mission Control's Supabase Vault |
| `MISSION_CONTROL_URL` | Settings → Variables → Actions | this deployment's public origin                                     |

Neither is defaulted, and neither should be guessed. A wrong origin posts
migration SQL to somebody else's deployment. `cron_secret` is the value 32
scheduled jobs already authenticate with, and this platform has broken all of
them at once by changing it — **copy the existing value into GitHub, never the
other way round.**

`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are no longer read by
anything, and `.github/scripts/apply-migrations.mjs` is deleted rather than left
dormant: an applier holding an organisation-wide token is one
`workflow_dispatch` away from doing the thing its own refusal list existed to
prevent.

Without the secret the workflow fails loudly on the first merge that touches a
migration — which is the correct failure, and the opposite of the silence this
replaces.

## Ordering against the deploy

This runs on push to `main`; the application itself is published from Lovable.
Migrations therefore land **before or without** the code that uses them, which is
the safe order for the additive migrations this repo writes: a column that
exists before its reader is inert, a column that arrives after is a `42703`.

A migration that REMOVES something a live deployment still reads has to be
staged by hand, across two merges.

> **Since 2026-09-22 the two namespaces ARE reconciled — by body, never by
> timestamp.** The ledger stores the SQL it ran, so a matching body is proof the
> prime ran those exact bytes, which is strictly stronger than a version match.
> That took the prime's deliverable set from 180 of 1,002 to 785. See
> [RECONCILING_BY_BODY.md](./RECONCILING_BY_BODY.md). The refusal below still
> stands for everything it names: reconciling by PROXIMITY remains a guess, and
> the residue is the set that has no body in the ledger at all.

## The 67, and what was done about them

They are not reconciled, and deliberately so. "Not in the ledger" does not mean
"not applied" — several were applied by an operator running the SQL directly,
including `20260826000000_schedule_the_engine.sql`, whose cron jobs are live and
serving. Marking them applied would freeze a guess; re-applying them would
replay `cron.schedule` and seed data. Both are worse than leaving a known, named
backlog.

Two exceptions were recorded, because their state is not a guess — they were
applied by hand on 2026-08-27, verified by their effects (17 exclusion rows;
`allowed-origins-reconcile-15min` active in `cron.job`), and then written into
the ledger so the pipeline will not offer them again:

```
20260826070000  seed_mirror_exclusions
20260827030000  schedule_allowed_origins_reconcile
```

## The guard

`npm run check:migration-pipeline` (in CI) fails on the two ways a migration can
merge and never apply, both silent:

- **no 14-digit version** — cannot be recorded, so the workflow refuses it;
- **a duplicate version** — the ledger records a version once, so the second
  file applies and is then indistinguishable from the first, and a replay skips
  it entirely. Which file loses is decided by filename sort order.

It is deliberately static. Whether a migration has been _applied_ is a question
only the database can answer, and this project's ledger cannot answer it
honestly — which is the whole reason this document exists.

---

# The fleet: how a clone's DATABASE gets the prime's migrations

Everything above is about **Mission Control's own** schema — one project, and a
GitHub Actions workflow is the right shape for it because a red ✗ on the merge
commit is the loudest signal available.

The fleet is a different problem, and it was the bigger one.

## The gap

When the prime gains a migration, the cascade copies the **file** into every
clone's repository automatically. Nothing applied it to the clone's
**database**.

`fleetMigrationSync` has existed and worked the whole time. Its only caller was
a button on an admin page. So a fleet stayed in step with the prime exactly as
often as somebody remembered to press it — the same shape as every other defect
this programme has turned up: a capability that ships, reports green, and is
never invoked.

That is the ceiling on how many clones this platform can carry. One clone is a
click. Ten is a chore nobody does on the day it matters. The schema drifts, the
clone's edge functions start naming columns it does not have, and the symptom
arrives as PostgREST `42703`s inside a tenant's application rather than as
anything anyone here would recognise as a missed migration.

## Why Mission Control drives it, and not each clone's CI

The obvious alternative is to put the apply-on-merge workflow in every clone
repository too. It does not scale, for three concrete reasons:

- **N copies of the most dangerous credential.** The Management API token
  reaches every project in the organisation. Per-repo CI means it is configured
  in N repositories, each with its own project ref, and each ref is a chance to
  name the wrong tenant.
- **Clone repositories are mirrors.** The cascade overwrites them.
  `apply-migration.yml` is already in `DEFAULT_MIRROR_EXCLUSIONS` for exactly
  that reason, so a workflow living there is a file the cascade must be told to
  leave alone — one more thing to remember per clone.
- **Only Mission Control knows the fleet.** A clone's repository does not know
  which Supabase project it belongs to. `clone_backends` does.

Mission Control already holds one token that reaches every project, the project
ref for every clone, an idempotent applier (`applyPrimeMigrations`, which unions
both ledgers on the clone and skips what is applied), and a worker system. The
scalable answer is to use them.

|                       | Mission Control's own schema | the fleet                                                                          |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| targets               | 1 project                    | N projects                                                                         |
| driver                | GitHub Actions on merge      | `/hooks/fleet-migration-sync` every 30 min, `/hooks/fleet-migration-drain` every 5 |
| credential            | one repo secret              | the token Mission Control already has                                              |
| failure is visible as | a red check on the commit    | an operator notification, per clone                                                |

## Two cadences, because one case is a queue

The sweep runs every thirty minutes, and the migration that schedules it states
why: _"Nothing here is queue-draining: a clone's schema does not change between
ticks."_ That was true when it was written, and oversized seeds made it false
for one case.

Measured 20 Sep 2026, by running this repository's own `readSeedShape` and
`chunkSeedStatements` over the prime's
`20261203000000_seed_template_library_v14_tier_separation.sql`:

|                                |                               |
| ------------------------------ | ----------------------------- |
| seed                           | 41,678,125 bytes, 543 rows    |
| statements at the 1 MB ceiling | **45**                        |
| median statement               | 948,212 bytes                 |
| parse cost, both passes        | ~1.6 s                        |
| blob fetch, whole file         | ~2.4 s at ~17 MB/s            |
| send cost, per statement       | ~1.7 s                        |
| invocation budget              | 45 s, shared across the batch |

So a pass carries roughly two dozen statements and the rest waited half an
hour, per clone, with four such seeds outstanding. That is the arithmetic that
made a drain take days.

**`/hooks/fleet-migration-drain` is the same handler on a five-minute tick**,
serving only clones that carry a chunk cursor. It narrows an already-eligible
set (`scopeQueueToMode`, applied after `migrationEligibility`), so it reaches no
clone the sweep cannot, and it asks the fleet table whether anything is in
flight _before_ it reads the GitHub allowance — an idle tick is one indexed
select and no round trip to GitHub at all.

### What it is NOT: the prefix a resumed pass re-reads

A resumed pass streams the whole body and discards the statements it already
sent, because **GitHub's blob endpoint ignores `Range`** — measured, HTTP 200
carrying the full `Content-Length` with no `Accept-Ranges`, on both
`/git/blobs/{sha}` and `/contents/{path}`. That re-read is real, and it costs
about **2.4 s of a 45 s budget**: roughly 5% of a pass, against the ~1.7 s each
statement it then sends costs. Parking the body somewhere Range-capable to save
it would buy that 5% for a bucket, an upload, a lifecycle and a parser that can
start mid-file. The cadence was the other 95%.

## What the worker does

`runFleetMigrationSync` — one engine, two callers. The admin button and the cron
job both go through it, so they can never become two implementations of "sync
the fleet".

Each run:

1. **Reclaims stale claims.** `worker_started_at` is the claim, and reusing it is
   safe rather than lucky: the backend-provisioning drain claims `pending` and
   reclaims `pending`/`provisioning`/`migrating`/`seeding_admin`. It never looks
   at a `ready` row, which is the only status this touches.
2. **Counts what is not eligible**, before taking a batch.
3. **Takes a bounded slice** — five clones, ordered by how far behind they are,
   nulls first. A fleet-wide loop in one invocation is the shape that timed out
   the first mirror cascade at exactly 60,000 ms.
4. **Reads the prime's migrations once**, not per clone.
5. Per clone: **claim → apply → record → release**. The claim filter carries
   `worker_started_at is null`, so two overlapping runs cannot both take the same
   clone. pg_cron does not serialise its own job, and applying one migration
   twice concurrently is how a clone gets marked `failed` by a duplicate-object
   error it never really had.

## A clone falling out of the fleet is now loud

When a migration fails on a clone, its backend goes to `failed` — which takes it
out of the eligible set, so the next run will not see it. That is the right
behaviour and the wrong silence: without something saying so, the clone simply
stops receiving schema changes and nothing anywhere reports it.

Two things make it visible now. An operator notification names the clone, the
migration and the consequence in plain terms. And every run reports `excluded` —
the count of backends outside the eligible query — so "5 processed" can never be
read as "the fleet is in step" while three clones sit outside it.

## Three reads that must not be misread as emptiness

- a candidate list that could not be read → the run reports an error, never
  "0 clones, nothing to do";
- a claim that **errored** → recorded as a failure, never treated as a lost
  race. Conflating those is what left the screening consumer's claim looking
  like contention for months while it had never once succeeded;
- a clone that threw before any verdict → the claim is released and the status
  is left alone, because guessing a schema verdict is worse than retrying.

## Reading `withheld`

The fleet sync's corpus is the prime **repo**, narrowed to what the prime's
**database** has applied. What that narrowing removes is reported as `withheld`,
and on this deployment the first honest run reported:

```json
{ "success": true, "processed": 1, "advanced": 0, "upToDate": 1, "failed": [], "withheld": 828 }
```

828 of 962 files, which is alarming until you look at _why_. The repo filenames
and the ledger versions are offset by **seconds**:

```
repo    20250831091525   20250902092314   20251029030456
ledger  20250831091523   20250902092312   20251029030453
```

That is this document's own two-namespace problem seen from the other side:
Lovable stamps the ledger with the moment it _applied_ a file, not with the
version in the filename. Measured on the oldest 42 repo versions — **0 exact
matches, 25 within ten seconds, 17 genuinely never applied.**

So `withheld` is split by reason:

| reason           | means                            | what to do                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------- |
| `skew_suspected` | a ledger entry exists within 10s | nothing — the prime ran it, under a different timestamp |
| `never_applied`  | nothing near it                  | look at these                                           |

The window is measured, not picked: observed skews are 2–3 seconds.

**The classification never promotes.** `runnable` is decided by exact ledger
membership and by nothing else; the skew test runs only over migrations that
have _already_ been withheld, and its output reaches a report and an audit row.
Closing that loop is tempting — if `…091525` is "obviously" `…091523`, why not
run it? Because "obviously" is a guess about somebody else's timestamping, and a
tenant's database is on the other side of the guess. This corpus contains two
`rollback_*` scripts whose stated purpose is to undo a security fix; a matching
rule loose enough to bridge three seconds is loose enough to bridge onto one of
those. A test asserts a migration one second from a ledger entry is still
withheld.

**A `skew_suspected` count is not a clean bill of health.** It is harmless for a
clone stamped from the prime's ledger, because the effects are already present.
It is _not_ harmless for a clone built by replaying migrations from scratch —
that clone would come up short by exactly these files, and there is no key that
recovers them: the ledger's `name` column is empty for Lovable-applied rows and
holds a bare UUID for others.

## The ledger is a set; migrations are a sequence

Measured on `npc-client-dashboard`, 2026-09-01.

`scopeCorpusToPrime` clears a version for clones by exact membership of the
prime's ledger. That rule is right and stays. But the result is a SET, and a
set cannot say whether a cleared version sits behind a withheld one:

| version          | role                                                      | prime ledger | sent to the clone |
| ---------------- | --------------------------------------------------------- | ------------ | ----------------- |
| `20261012000000` | **defines** `ensure_builder_stock_settlement_scheduled()` | absent       | withheld          |
| `20261027010000` | **calls** it                                              | present      | **yes**           |

The clone answered `42883: function … does not exist`, `applyPrimeMigrations`
halted, and provisioning stopped at step 5 of 7 — four steps short of
`seedAdminUser`. That clone has 546 tables, zero users of any kind, and had
been unusable since 27 August. Three of the six versions the ledger records
above its frontier call that same withheld function.

`partitionByDependency` (`fleetCorpusScope.pure.ts`) refuses to step over a
hole. It **skips rather than halts** — halting at the first hole is precisely
what starved the admin seed, and a 546-table clone is not made more correct by
being denied an owner. And **every withheld version is a barrier**, not only
the ones classified `never_applied`: this prime's repo holds `20250912170521`
where its ledger holds `20250912050519`, twelve hours apart and therefore
classified `never_applied` by `SKEW_WINDOW_SECONDS`. A barrier that trusted the
classification would be trusting a test that is measurably wrong.

A version the CLONE already holds is never a hole, whatever the prime's ledger
says. Without that exception every clone freezes at its thirteenth migration.

## The ledger under-reports the prime's own schema

This is the reason clones now advance very little, and it is not skew:

- The prime's database **has** `ensure_builder_stock_settlement_scheduled()`
  (`pg_proc` = 1). Its ledger does not record the migration that creates it.
- Of 64 repo migrations after `20260831060152`, the ledger records **6**.
- 481 of its 890 rows carry an empty `name` and a version matching no repo
  file.

So "absent from the ledger" conflates two states that must never be merged: a
migration the prime deliberately never ran (a rollback script, future-dated
work) and one it ran under an id nothing wrote down. Only the second is
recoverable, and only with evidence about the SCHEMA rather than the
bookkeeping.

`primeLedgerReconciliation.pure.ts` supplies that evidence: it reads what a
migration CREATEs and asks the prime's live catalog whether those objects are
already there. `buildPrimeLedgerReconciliation` runs it and returns a report.
Three verdicts, and the third is the one that keeps it honest:

- `satisfied` — every object it creates already exists on the prime
- `unsatisfied` — at least one does not; the prime has not run it
- `indeterminate` — the SQL creates nothing this module can name

`indeterminate` is never merged into `satisfied`. A migration that only
`ALTER`s, `INSERT`s or rewrites policies has no creation to look for, and
"found nothing to check" is not "checked and found everything" — a pure-`ALTER`
migration and one of the two `rollback_*` scripts are indistinguishable to this
test, and one of those must never be stamped.

**Nothing here stamps a ledger.** The report is evidence for an operator, and
writing the prime's ledger stays an explicit, separate decision.

### Where it is, after a year of being nowhere

That report had **zero call sites** until 20 Sep 2026. It was written,
documented here, named by `blockageTaxonomy.pure.ts` in the comment defining
`prime_ledger_hole` — "the one function that computes object-level evidence for
exactly this" — and named again by `fleetBlockageRecord.test.ts` as this
repository's live instance of _a module is not shipped until something calls
it_. Nothing reached it.

It is now **Fleet Manager → Prime Ledger Reconciliation**, directly under the
sync card, because it answers the question that card raises: `withheld (not
applied on the prime)` is a count, and a count cannot say which of the two
states it is counting.

Three rules hold the surface. It **never runs on mount** — the reading is up to
120 GitHub blob fetches, and the sibling registry card loads eagerly only
because its reading is one tree listing. It **yields at the scan floor**, not
the actor floor, because `githubBudget.pure.ts` states the asymmetry: "a
measurement postponed costs a stale number, while an apply postponed costs a
clone sitting a migration behind the prime", and an operator's finger does not
change what the spend is for. And it **offers exactly one control, the
reading** — a second one would make `satisfied` read as permission.

The `prime_ledger_hole` blockage points at it, and keeps its refusal word for
word. What that sentence no longer does is assert the half it cannot see: it
used to open "the prime has that migration in its repository and **has not run
it**", which is a claim about the prime's schema from a row that has only read
its ledger.

### A body that was never read is not a body that creates nothing

Measured over the prime's own corpus on 20 Sep 2026, in the window this report
serves — the **118 migrations after `20260831060152`**:

|                                        |       |
| -------------------------------------- | ----- |
| carry a creation the module can verify | 68    |
| read, and create nothing it can name   | 41    |
| **never read at all**                  | **9** |

The 68 declare 321 objects: 122 columns, 91 indexes, 64 tables, 32 functions,
8 triggers, 3 views and 1 sequence.

Every one of the nine is a 41 MB template-library seed, refused by
`MAX_MIGRATION_BYTES` before the round trip — the largest and most
consequential bodies in the backlog, and the exact ones the chunked-seed lane
exists for. They were filed under the same word as the forty-one that _were_
read, which is `absent is never zero` in the place it costs most: a report
whose first act is to tell an operator those files "create nothing this module
can name" is describing files it never opened.

The row carries `unread` now — the reason and the size — and the summary counts
it. The **verdict stays `indeterminate`**, because it is still true and a
fourth verdict would have to be handled by every consumer of the three; what
changes is that `unread` is reported as a **subset** of it, so the three
verdicts still sum to the row count. Nothing streams those nine bodies to find
out: at 41 MB each that is ~370 MB on a button press, and all nine are
`INSERT`-only seeds that would come back `indeterminate` anyway. The honest
answer is the size and the word "not read".

### The class, ratcheted

A test that names one orphan cannot see the next one — the lesson the drain
lane paid for a day earlier ("a hand-list cannot see the call it does not
mention"). `serverExportsHaveCallers.contract.test.ts` derives the set instead:
every exported `function` in a `*.server.ts` is asked whether anything
references it.

Scanned over the whole of `src/`: **633 exported server functions, six with no
reference anywhere.** They are frozen with what each one is — a test seam
nothing seams, a fleet-wide selftest with no door, a formatter its own comment
says is "for notifications and the operator UI" while neither calls it — and
the list can only shrink.

Two things it had to learn by being run.

**A comment is not a caller** — and stripping them is not a regex over the
file. Two shapes in this codebase break the obvious one, and both produced
false orphans, which is the failure that gets a gate switched off:

```ts
redirectSet.add(`${site}/*`); //  a comment opener inside a template literal:
//                                a file-wide regex runs from here to the next
//                                closer and eats the declaration below it

const { retargetCloneRepo } = await import(
  /* @vite-ignore */ "@/lib/_server-shims/clone-repo-retarget.server"
); //  a comment that CLOSES mid-line: a tracker asking whether the line ENDS
//     with the closer opens a block and eats the rest of the module
```

The strip is line-oriented, only opens on a line whose first characters are the
opener, and looks for the closer anywhere after it. It is deliberately
conservative — a trailing comment after code survives — because missing an
orphan costs a name this list does not carry while inventing one costs every
run.

**A name in a quoted string is not a caller either**: a source contract
asserting `toContain("someFunction")` is bookkeeping about that function, the
same way this gate's own freeze list is. Template literals are left alone,
since `${…}` holds real code. A name inside a regex literal still counts, and
that limit is stated rather than chased — telling a regex from a division needs
a tokeniser, and a wrong one invents orphans. Where one function matters that
much it gets its own mounted contract, which is what
`primeLedgerReconciliationMounted.test.ts` is.
