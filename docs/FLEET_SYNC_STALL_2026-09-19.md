# The day the whole fleet stopped, and the six reasons it did

On 19 September 2026 all four clones were **69 commits behind prime**, frozen at
`d86f485c`, with eight `cascade_events` pending and 32 queued `cascade_results`
that nothing would ever claim. Two of them had been holding at migration
frontier `20261201100000` for days. All four read `status: ready`.

Six independent causes, each sufficient on its own, each reporting as normal
operation. This is what each was and what now stops it.

---

## 1. The blast-radius gate, on all four clones

**`src/lib/blast-radius.ts`, `src/server/cascade-trigger.server.ts`**

The fourth clone was registered at 05:20:23. The next prime commit cascade —
06:59:52, PR #2703 — counted four clones against `AUTO_MERGE_THRESHOLD = 3`,
gated, and so did all seven after it. Among the withheld commits was PR #2702,
*"Close the one table in this database with RLS switched off"*: the gate was
withholding a security fix from every tenant, which is the clearest possible
sign it was asking the wrong question.

Three things made it a stall rather than a pause.

**There was no first operator.** A webhook event carries `initiated_by = NULL`,
and the refusal it printed read *"Auto-merge across 4 clones (>3) requires a
second operator."* `approveCascade` is the only writer of `approved_at`
anywhere in this codebase and it is a UI act; `cascade_approvals` has never
held a row. A control whose only discharge is an act nobody is positioned to
perform is an outage.

**Three is a growth cliff, not a radius.** Every real deployment passes it in
its first month, after which every prime commit — around fifty a day — needs a
human. The human either rubber-stamps or the fleet stops.

**It is the same decision asked twice.** A commit cascade does not propose a
change; it replays one prime already merged, reading prime's head at run time.
Holding it does not keep tenants on the reviewed state — it widens the gap
from it.

**The rule now**: the fleet-size count binds a cascade somebody *started*.
`CascadeOrigin` defaults to `operator`, so every existing call site keeps
today's gate and only the webhook path opts out. What bounds an automatic
cascade is content, not arithmetic, and that already runs per file — the path
approvals, the sync exclusions, the dry-run boundary, and `deletionPropagation`'s
withholding of prime deletions. A scheduled cascade stays gated deliberately:
a schedule is a named person's standing decision and its brand pushes are
irreversible.

### The half that fixing the rule does not fix

`requires_approval` is stamped once, at insert, from a clone count read in that
instant, and nothing ever read it again except to refuse. Changing
`assessBlastRadius` moves none of the eight stuck rows.

A data fix repairs eight rows once, and the next time the rule moves — or a
clone is decommissioned, or a threshold is retuned — the queue strands again
with nothing reporting it. So **the gate is re-read where it is enforced**:
`reassessRecordedGates` in the drain, over `gateReassessment.pure.ts`.

Three rules make that safe.

- **It never approves.** No `cascade_approvals` row, no `approved_at`, no
  operator impersonated. Those say *a second person looked*. This says
  something weaker: *the question was answered from inputs that have moved.*
  An event a person HAS approved is never touched.
- **It only ever relaxes.** A gate no longer owed is cleared; a gate the
  current rule would impose on an event that never carried one is not added.
- **It says why, on the row.** A `requires_approval` that flips with no story
  is indistinguishable from a gate somebody bypassed.

It runs **before** the fold, so a discharged commit event folds in the same
tick — eight stuck rows settle into one carrier delivering prime's head, not
eight passes of the same work.

`gateAndArming.contract.test.ts` now pins the narrower rule: every read of
`requires_approval = true` in the drain must pair with a recorded approval (the
rescue claim) *or* with `approved_at IS NULL` (the re-assessment). A bare read
is the bypass, and both pairings must be present so the count cannot pass
vacuously.

---

## 2. `npc-test-76b3b3` — a missing HTTP header

**`src/server/githubUserAgent.pure.ts`, `prime-backend.server.ts`**

The clone's own `status_detail` carried the reason verbatim and nobody read it:

> The prime's copy of `20261202000000_seed_template_library_v13_cash_flow_foots.sql`
> could not be read (HTTP 403): *Request forbidden by administrative rules.
> **Please make sure your request has a User-Agent header***

That migration is 41,671,969 bytes, which is why it is the only file on the
fleet that takes the streaming path, and why the failure looked like a size or
quota problem. It was neither. `fetchBlobTextStream` was the one place in
`src/server` that called `fetch` against `api.github.com` by hand instead of
going through Octokit — and Octokit sets a User-Agent on every request, which
is exactly why every other GitHub lane worked and only this one did not. The
installation was around 750 calls into a 5,000/hour window at the time.

It was **deterministic**: every blob that path was ever asked to stream was
refused, on every attempt, for ever — a permanent block wearing a rate limit's
status code.

**The rule now**: every request to GitHub names itself, and
`githubUserAgent.contract.test.ts` scans the server tree for any
`api.github.com` fetch without one. The first version of that guard passed a
planted violation because the *comment* above the header said the words
"User-Agent" — comments are stripped before anything is judged now, and the
header must be SET (`"User-Agent":` as a key), not merely mentioned.

---

## 3–4. `npc-client-dashboard` and `preflight-property-group` — a hole in the prime's ledger

**`migrationDependencyScope.pure.ts`, `backend-provisioning.server.ts`**

`20261202090000_builder_marketplace_ranking.sql` is on prime's `main` and has
**never been applied to the prime's database** — asserted by effect, not by the
ledger: every object it declares (`rank_item_score`, `rank_builder_band`,
`rank_applied_at`, `builder_network_stock_ranked`,
`builder_network_apply_stock_ranks`) is absent from the prime's live catalogue.
So is `20261206000000`, which enables RLS on a table the prime reports
`rls_enabled: false`.

The upstream cause is that the prime's `apply-migration.yml` is
`workflow_dispatch` with a required file input, and says so in its own header:
*"Deciding which file is a human judgement made before dispatch."* The ledger
records what somebody remembered to dispatch, not what merged. Rule #71 is
then correct to withhold — and `partitionByDependency` amplifies one unrecorded
version into a permanent fleet-wide barrier, because `holes` is declared once
outside the walk and only ever appended.

**Corpus position is not dependency**, and this fleet is the proof: the hole
touches `builder_network_*`; the three migrations it withheld are
template-library seed and active-master refresh work on
`template_library_entries` / `report_templates`. **No object in common.** What
those two tenants got for the barrier's caution was a report catalogue three
releases stale — detailed financial modelling still appearing in the Investment
Compass, the exact condition `TIER_FRAMEWORK § Decision E` exists to prevent.

**The rule now**: a hole blocks a later migration only where that migration
names something the hole creates. Everywhere the evidence cannot be
established the prefix barrier applies unchanged. It stays fail-closed exactly
where it is blind:

- a candidate whose SQL will not load, or is past `MAX_SCOPING_BYTES`, is
  blocked by every hole — an oversize refusal, a GitHub 403 and an unknown id
  all resolve to the same `null`;
- a hole that declares no relation at all blocks alone and by name. That is
  the `rollback_*_rls_policies.sql` case, and those files are what the prefix
  barrier was written for;
- the match is a **mention**, not a parse. A name appearing in a string
  literal or a `format()` counts as a dependency. Every way the test is wrong
  is a way that keeps today's behaviour.

One thing a test caught in the module's first draft: `stripSqlNoise` removes
dollar-quoted bodies, which is right for *what does this file create* and
dangerous for *what does it reference* — a `plpgsql` body calling the hole's
function is a real dependency, and Postgres will not refuse the CREATE, so
nothing downstream would catch it either. Comments are stripped; bodies are
kept.

### And the condition now has a name

`prime_ledger_hole` joins `BlockageClass`. Before this it had no class, no
`FleetMigrationResult` field, no notification and no row — its only trace was
prose in `status_detail` while both clones read `status: ready` with
`migration_blocked_at` NULL.

- **`owner: operator`** — the act that clears it is on the prime and is a
  person's: dispatch the migration, or decide it should not exist.
- **`selfHeals: false`** — nothing here may apply DDL to the prime, and
  stamping its ledger instead would send tenants a migration whose prerequisite
  state does not exist, which is precisely what rule #71 forbids. The custodian
  entry says so in those words.
- **Standing, not conditioned on divergence** — it is wrong right now whatever
  today's convergence says, and it will hold the *next* migration too.
- **One blockage per hole version**, fingerprinted on that version, so the row
  is stable across passes and **discharges itself** the moment the prime's
  ledger records the version and the next pass stops reporting `blockedBy`.
  Nobody has to remember to close it.

The evidence costs nothing to gather: `partitionByDependency` has recorded
`blockedBy` into `clone_backends.migrations_applied` since it was written, and
nothing had ever read it back.

`clone_sync_blockages.class` is CHECK-constrained, so the class had to be added
to the column or every write would have been rejected there while looking, from
the function, exactly like a write nobody attempted — the same failure
`client_reminders.reminder_type` and `template_library_entries.category` have
already cost this programme.
`blockageClassColumn.contract.test.ts` pins the pair.

---

## 5. `npc-crm-independent-6505dc` — parity called the security posture a defect

**`handoff-parity.server.ts`**

Its schema matched the prime exactly — 529 tables, 435 functions, 32 buckets,
66 cron jobs, 83 enums, 401 triggers, nothing missing, nothing extra — and it
read *"Backend provisioned but DOES NOT MATCH the prime — missing_secrets:58"*,
`risk_level: blocking`.

Among those 58: `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `DIDIT_API_KEY` and
`SB_MANAGEMENT_ACCESS_TOKEN`. Every one is a credential this platform has
decided, in writing and in code, must never reach a tenant — an Airtable PAT
carries its whole base scope, a Didit key carries its application's session
list (measured: eight customers' names and live pre-signed URLs to their
passport portraits), and a Supabase management token reaches every project in
an account. `primeOnlySecrets.pure.ts` exists to **sweep** such a name off a
clone that somehow holds one.

So parity was reporting the platform's own security posture as a fault and
pointing an operator at a remedy another part of this codebase actively undoes.
A control that reads as a fault teaches people to clear it.

**The rule now**: a name policy withholds is reported as `withheld_by_policy`,
never as missing, and never blocks. It is still shown — a clone lacking them is
worth seeing. The counts stay describing what each project *holds*, because
netting the withheld out of them would make two honest numbers disagree with
the Secrets page beside them.

---

## What is still owed, and it is not in this repository

Three migrations sit on prime's `main`, unrecorded in its ledger and
**genuinely unapplied**:

| File | Size |
|---|---|
| `20261202090000_builder_marketplace_ranking.sql` | 17,324 B |
| `20261204000000_client_files_bucket_and_accrual_repair.sql` | 12,502 B |
| `20261204010000_email_followup_reminders.sql` | 3,246 B |

(`20261206000000_extension_migration_status_rls.sql` is a fourth, and the one
with a security consequence: it enables RLS on a table the prime currently
reports `rls_enabled: false`.)

Each is small, none needs the chunker, and all are written idempotently
(`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE
VIEW/FUNCTION`). Applying `20261202090000` alone discharges the held-back
migrations on both clones at the next fleet tick, because
`partitionByDependency` recomputes the barrier from the prime's ledger on every
run — nothing needs un-sticking by hand.

Two things must not be done instead. **Do not stamp
`supabase_migrations.schema_migrations` by hand**: the prime's database
genuinely lacks these objects, and a stamp would send two tenants a migration
whose prerequisite state does not exist. And **verify by effect, not by the
ledger row** — after dispatch, re-read the prime's types and confirm
`builder_network_stock_ranked` and `rank_item_score` are present.

## One open contradiction, deliberately not guessed at

`clone_backends.chunk_cursor` reads `{"migrationId":"20261202000000",
"statementsDone":1}` on `npc-client-dashboard` and `...2` on
`preflight-property-group` — the 41 MB seed recorded as part-streamed — while
both clones' union ledger reports that version applied. One of the two is
wrong, and only one of them can be right about whether the template schema
landed. Settling it needs a row count against `template_library_entries` on
both projects.
