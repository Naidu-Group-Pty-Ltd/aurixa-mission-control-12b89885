# The day the whole fleet stopped, and the six reasons it did

On 19 September 2026 all four clones were **69 commits behind prime**, frozen at
`d86f485c`, with nine `cascade_events` pending and 36 queued `cascade_results`
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
_"Close the one table in this database with RLS switched off"_: the gate was
withholding a security fix from every tenant, which is the clearest possible
sign it was asking the wrong question.

Three things made it a stall rather than a pause.

**There was no first operator.** A webhook event carries `initiated_by = NULL`,
and the refusal it printed read _"Auto-merge across 4 clones (>3) requires a
second operator."_ `approveCascade` is the only writer of `approved_at`
anywhere in this codebase and it is a UI act; `cascade_approvals` has never
held a row.

Stated carefully, because the first version of this paragraph overstated it:
the gate was **undischarged, not undischargeable**. Three operator accounts
exist, the `cascade_approvals` INSERT policy is a `NOT EXISTS` form so a NULL
`initiated_by` passes it, the code guard `ev.initiated_by === context.userId`
is likewise false against NULL, and `listPendingApprovals` would have listed
all eight. What actually bound was attendance — last operator sign-in
7 September, all eight notifications unread. That is a severity argument, not
an impossibility one, and it is still the argument for the change: a control
that needs a human per commit at fifty commits a day is one that gets
rubber-stamped or ignored.

**Three is a growth cliff, not a radius.** Every real deployment passes it in
its first month, after which every prime commit — around fifty a day — needs a
human. The human either rubber-stamps or the fleet stops.

**It is the same decision asked twice.** A commit cascade does not propose a
change; it replays one prime already merged, reading prime's head at run time.
Holding it does not keep tenants on the reviewed state — it widens the gap
from it.

**The rule now**: the fleet-size count binds a cascade somebody _started_.
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
  operator impersonated. Those say _a second person looked_. This says
  something weaker: _the question was answered from inputs that have moved._
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
rescue claim) _or_ with `approved_at IS NULL` (the re-assessment). A bare read
is the bypass, and both pairings must be present so the count cannot pass
vacuously.

---

## 2. `npc-test-76b3b3` — a missing HTTP header

**`src/server/githubRequestHeaders.pure.ts`, `prime-backend.server.ts`**

The clone's own `status_detail` carried the reason verbatim and nobody read it:

> The prime's copy of `20261202000000_seed_template_library_v13_cash_flow_foots.sql`
> could not be read (HTTP 403): \*Request forbidden by administrative rules.
> **Please make sure your request has a User-Agent header\***

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

**The rule now**: every request to GitHub names itself, assembled in one place
by `githubApiHeaders`, and `githubRawFetch.contract.test.ts` derives the call
sites from source and checks that each also counts before it spends.

That helper came from `main`, which landed the same diagnosis independently
while this branch was in flight. A second module naming the same header was
written here and then **deleted rather than left beside it** — the helper's own
comment says why: _"a literal at each call site is how three of them come to
disagree."_

One thing worth keeping from the discarded version: its first guard passed a
planted violation because the _comment_ above the header said the words
"User-Agent". Comments have to be stripped before anything is judged, and the
header must be SET (`"User-Agent":` as a key) rather than merely mentioned —
which is what `main`'s version already does.

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
_"Deciding which file is a human judgement made before dispatch."_ The ledger
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
dollar-quoted bodies, which is right for _what does this file create_ and
dangerous for _what does it reference_ — a `plpgsql` body calling the hole's
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
  today's convergence says, and it will hold the _next_ migration too.
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
read _"Backend provisioned but DOES NOT MATCH the prime — missing_secrets:58"_,
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
worth seeing. The counts stay describing what each project _holds_, because
netting the withheld out of them would make two honest numbers disagree with
the Secrets page beside them.

---

## What is still owed, and it is not in this repository

Three migrations sit on prime's `main`, unrecorded in its ledger and
**genuinely unapplied**:

| File                                                        | Size     |
| ----------------------------------------------------------- | -------- |
| `20261202090000_builder_marketplace_ranking.sql`            | 17,324 B |
| `20261204000000_client_files_bucket_and_accrual_repair.sql` | 12,502 B |
| `20261204010000_email_followup_reminders.sql`               | 3,246 B  |

(`20261206000000_extension_migration_status_rls.sql` is a fourth, and the one
with a security consequence: it enables RLS on a table the prime currently
reports `rls_enabled: false`.)

Each is small, none needs the chunker, and all are written idempotently
(`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE
VIEW/FUNCTION`). All four are needed, not one: `20261204020000` and
`20261204030000` carry `blockedBy: ["20261202090000", "20261204000000",
"20261204010000"]`, so applying the first alone discharges only
`20261203000000` and `20261203010000`, and `20261206000000` becomes the next
barrier the moment the corpus passes it.

**Do not stamp `supabase_migrations.schema_migrations` by hand**: the prime's
database genuinely lacks these objects, and a stamp would send tenants a
migration whose prerequisite state does not exist.

## Correcting this document: the hole is not what holds the frontier

The first version of this page said applying `20261202090000` would discharge
the held-back migrations "at the next fleet tick". **That is wrong**, and the
mistake was reading a status line instead of the clone's own cursor.

All three stalled clones carry
`chunk_cursor = {"migrationId": "20261202000000", "statementsDone": …}` — 6, 12
and 1 respectively as this was written — at frontier `20261201100000`. Version
`20261202000000` **is** in the prime's ledger, so `partitionByDependency` puts
it in `send`, not `orphaned`: it sits _before_ the hole. It is the
41,671,969-byte single-`INSERT` template seed, chunked at
`DEFAULT_SEED_STATEMENT_BYTES` into dozens of statements, and the three clones
are a handful of statements into it. Discharging the hole cannot move any of
them until that seed lands.

**And the sentence that misled is a null fallback.** `fleet-migration.server.ts`
reads `const syncedTo = latestApplied ?? "the prime's latest recorded
migration"`, so _"Synced to the prime's latest recorded migration — N
migration(s) held back behind …"_ on all three clones means the pass completed
**zero** migrations. The held-back clause is true. The clause in front of it
reads as the opposite of what it means.

The seed's own livelock — no wall-clock budget and no persisted chunk cursor on
the fleet path, so every pass restarted at statement 1 — was closed by #225
before this branch merged main, and the cursors are advancing again
(`npc-client-dashboard` went 1 → 6 between 12:31 and 13:01).

Two things follow for anyone verifying this. **Verification is the clone's
`chunk_cursor` reaching null and `migration_version` advancing**, not a re-read
of the prime's types — the latter says the dispatch worked and nothing about
whether a tenant moved. And **`rescueScopedOrphans` provably does not cover
this corpus's two largest orphans**: `MAX_SCOPING_BYTES` is 2 MB against 41 MB
seeds, so `readSql` returns null, the orphan is `indeterminate` and the prefix
barrier is retained — by design, and worth stating plainly rather than leaving
to be discovered.

## The seed was read twice per attempt, and now is not

`applyChunkedSeed` called `readSeedShape(streamSql(m))` and then
`chunkSeedStatements(streamSql(m), shape, …)`. `readSeedShape` is
`walk(chunks, () => {})` — a full walk of the file that discards every tuple —
so the 41,671,969-byte seed was read **twice per attempt**: ~80 MB of blob
traffic to buy one bounded group of statements inside a 45-second budget.

Measured 19 September 2026 at 13:01, `npc-test-76b3b3` completed a pass having
advanced **zero** statements. The budget went on the reading.

The second walk is not redundant and was not removed. It re-derives the shape
and `chunkSeedStatements` refuses when the two disagree — _"the blob changed
between reads"_ — which is a real control. What changed is where the FIRST
reading comes from: a cursor that names this migration and carries a shape is
that reading, taken by an earlier pass. So the file is read once on a resumed
pass, and the comparison now spans PASSES rather than the microseconds between
two reads in one — which is the interval over which a seed can actually be
re-released.

Three rules carry it.

**A remembered shape is whole or absent.** `StoredSeedShape` carries every
field of `SeedShape`, `tail` above all: `tail` is the statements that follow
the `ON CONFLICT` clause and `chunkSeedStatements` emits them as a final group,
so a shape that dropped it would silently stop sending them on every resumed
pass — the half of a seed nothing downstream would report missing. The first
draft of the stored type had three fields; typechecking caught it. Every
rejection falls back to reading the file, which is exactly what every pass did
before, so nothing here can make a pass worse than it was.

**Empty is not absent.** `onConflict` and `tail` are checked for TYPE and not
for length. A seed with no `ON CONFLICT` clause and nothing after it is
ordinary, and a length check would reject every one of them and quietly
restore the double read.

**A mismatch against a remembered shape is not a malformed seed.** Read fresh
in the same pass, a disagreement means the file is not seed-shaped and a person
must apply it by hand. Taken off the cursor it means the prime re-released the
seed between passes: the file is fine, the recorded position was cut from a
body that no longer exists, and asking an operator to apply 41 MB by hand would
be the worst available answer. That branch drops the cursor and holds; the next
pass reads fresh and starts from statement 0.

## 6. The recorded frontier was two versions ahead of the clone

Found by a diagnostic sweep that finished after the five above were written,
and it is a **SQL migration ledger** fault rather than a cascade one — the
half of this work that was asked for and that the first five causes did not
touch.

Both introspection branches of `provisionCloneBackend` set the frontier to

```ts
latestApplied =
  [...snapshot.migrations].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.id ?? null;
```

That is the newest migration **file in the prime's repository**. It is not a
reading of the clone, and — because of §3–4 above — it is not even a reading of
the prime: four files sit on the prime's `main` that its ledger has never
recorded.

Measured on `npc-crm-independent-6505dc`: `clone_backends.migration_version`
reads `20261204010000` while that clone's own
`supabase_migrations.schema_migrations` tops out at `20261203010000`. **The
recorded frontier is two versions ahead of what the clone holds**, and a
frontier ahead of the truth is the one direction that loses data silently:
`migration-sync` computes `corpus − frontier`, so both versions are skipped as
applied and nothing will ever send them again. It is the same shape as
`cursorRanPastEnd` — a recorded position past the end of what actually
happened, believed because nothing ever compared it against its subject.

It also explains why that clone looked ahead of the other three. It is not: the
other three sit at `20261201100000` because a `sql_migration` replay wrote
theirs from what it applied. Same fleet position, two writers, two numbers.

**A version column is a reading of the thing it names.**
`migrationFrontier.pure.ts` resolves it, and the structural reason it cannot
reintroduce the fault is that it is handed readings and never a corpus — there
is no file list in its input to sort and take the last of. Precedence:

1. **The clone's own ledger** (`max(version)`), because the column names the
   clone. This also catches a stamp that half-succeeded, which a reading taken
   from the source never could.
2. **The prime's ledger**, only where the clone could not be read — what
   `stampMigrationLedgerFromPrime` copies row for row, so a derivation rather
   than a guess, and labelled as one.
3. **Nothing.** Where neither can be read the column is left exactly as it was.

The third is the half that matters. Writing `null` there would mean "this clone
has applied no migrations", which sends the next sync to replay the whole
corpus against a populated database — the failure
`stampMigrationLedgerFromPrime`'s own guard exists to prevent, arriving dressed
as an ordinary status write. So `resolveMigrationFrontier` can answer _do not
write_, and the caller spreads rather than assigns.

**`null` is not the same as unreadable.** A clone whose ledger answers with no
rows genuinely has an empty ledger, and that is worth recording — it is the
state a full replay is the right answer to. Only "we could not look" withholds.

Two things worth keeping about how this was checked. `supabase` is untyped in
`runBackendProvisioning`, so `tsc` accepted the whole reading object being
poured into a `text` column without a word; a spec checks the shape instead.
And the first source-level assertion **passed vacuously**: it forbade
`latestApplied = [...snapshot.migrations]`, and a planted
`latestApplied = { version: [...snapshot.migrations]... }` walked straight past
it because the corpus was one level deeper than the regex looked. The rule is
now stated twice over — every assignment is one of three named constructors
(a literal is not a call), and no assignment's right-hand side may mention the
corpus at all — and a second plant laundering the corpus through a sanctioned
constructor is caught by the second half.

## 7. A partial delivery settled as finished, and nothing ever re-offered it

`cascadeEventStatus` maps a run with `failed > 0` and at least one success to
`partial`, and `executeCascade` writes it with `completed_at` — the event's
final settle. `partial` is then terminal to every retry path: the drain claims
`.eq("status", "pending")`, and its only revival rule matches a result row
still at `pushing` past the stall cutoff, which a `failed` row can never be.

Measured: **15 partial events and 17 failed rows** across all three cascading
clones — Preflight (8, 4–11 Sep), NPC Client Dashboard (4, 8 Sep), NPC Test
(1, 16 Sep, still open).

**The harm to date is zero, and that is the finding.** Every one of those drops
was rescued by coincidence: a later full-tree commit cascade reads prime's head
when it runs and happened to carry the same paths. That is a property of
today's traffic rather than a guarantee. It evaporates exactly when deliveries
stop — which is the fleet's state right now — and it cannot help a SCOPED
delivery at all, because nothing fleet-wide supersedes one.

The catalogue already named the repair. `requeue_dropped_clone` has carried the
policy text _"Queue this clone's part again as a NEW scoped delivery, never by
reviving a settled one"_ since it was catalogued, and **nothing implemented
it**: `runCustodian` dispatched exactly one act and every other fell to an else
returning _"is enabled and has no implementation in this build"_. So the ledger
raised the condition, the catalogue named the cure, and there was no cure.

It is built now, and it is **deliberately still `enabled: false`**. Those are
different states, and the distinction is the point: pushing a tenant's code is
an outward-facing act, and turning it on is an operator's decision the way
`retarget_proposal_urls` was turned on by a deliberate step. What changed is
that the flip is now against a real act rather than against an else branch.

Four rules carry `planRequeue`, and the refusals are most of it — a custodian
that mints a duplicate delivery every tick is worse than one that mints none.
**It fails closed on every unreadable fact**, because minting on "I could not
check" mints on every tick a database hiccups. **It refuses when a delivery is
already queued for this clone**, since a cascade reads prime's head when it
runs and one already waiting will carry everything this one would. **It
inherits the parent's mode** — a repair may re-run a delivery, it may not
decide that what was offered for review is now merged. And **it names its
parent in `retry_of`**, which is the key the lineage panel already walks, so
the repair appears beside what it repairs with no change to any surface.

Two contracts moved, both deliberately. The custodian's write-surface test
asserted **two** tables and now asserts three, because the catalogued act
cannot be performed without minting a delivery. What that test was guarding is
surface creep, and that guard is kept in a stronger form than a list: the
custodian may only ever **INSERT** a `cascade_events` row, never update or
delete one. A settled `partial` event is a true record — that delivery did land
for those clones, on that day, at that SHA — and rewriting its status to re-run
it would destroy the record in order to reproduce the event. The minted
delivery is also armed in the same act and asserted to be, because an event
with no result row is one the engine holds for ever for want of anything to do.

The in-place alternative was considered and rejected on a measurement rather
than on taste: `decideExhaustedEvent` refunds an attempt whenever the event's
result rows were written recently, so an in-place retry would rewrite the
failed row every pass, refund every time, and never reach the ceiling that
retires it. A fresh event has its own attempts and its own ceiling.

**And one assertion here was wrong and was corrected rather than defended.**
The first version of the guard demanded that every class stamped
`selfHeals: true` have an implemented act. Four classes failed it — and the
field's own documentation settles the question against the test: _"May a
custodian re-run the work that clears this, without any new decision being
taken?"_ `selfHeals` is a statement about whether a re-run would be a
judgement, not a promise that anything re-runs. Those four are a backlog, not a
lie. The rule that does hold, and that produces a dead control when broken, is
narrower: **an act that is switched on must be an act that exists.**

## 8. An approval offered over a hold no approval can release

The same sweep found a third, and it is the one with a user at the end of it.

`oversizeHold` returned `reason: "manual_reconcile"`. So a file over the
8 MB cascade ceiling appeared in `needsReconcile`, the dry-run card drew
**"Approve prime's copy for held path(s)…"** over it, and `approveCascadePaths`
wrote a fourteen-day approval row. But `decideHoldRelease` filters
`partition.held` at `cascade-engine.server.ts:1497` and an oversize hold is not
pushed into that array until `:1919` — some four hundred lines later. **The
approval could never reach one.** An operator approved, was told it had
worked, and the next cascade held the same file again. On every cascade, for
ever.

The two files it holds are
`20261202000000_seed_template_library_v13_cash_flow_foots.sql` (41,671,969 B)
and `20261203000000_seed_template_library_v14_tier_separation.sql`
(41,678,125 B). **All three cascading clones therefore run report template
library seed v12 against prime's v14** — v14 being the tier-separation seed
that stops an Investment Compass opening on three pages of financial modelling
it is defined by not carrying — and every cascade reports success.

**Moving the push above the release block was the other candidate fix and it is
the wrong one.** Releasing an oversize path sends it into the prepare loop,
which fetches it and hits the identical ceiling. The approval would have
started succeeding while the file still did not land: a dead control that had
learned to say yes.

So an oversize hold gets its own `reason`. **A ceiling is not a decision.**
`reportableHeld` keeps both kinds, because the file still differs upstream and
is not travelling and dropping it from the list would restore the silence that
rule exists to end; `approvableHeld` is `manual_reconcile` alone, and it is
what both the engine's release filter and the card's offer now read — those two
being the ends that drifted. The card lists the ceiling's paths with what is
actually true about them and offers no button.

Three smaller things came with it. **The engine publishes which held paths are
the ceiling's**, because an approval dialog is drawn over paths and a path
carries no reason — the card had nothing to exclude them _by_. **The note
stopped being true and was fixed**: it ended "the migration sync refuses a body
this size as well", which was right when written and was overtaken by the
migration lane learning to chunk a seed-shaped INSERT from a stream. The
database does get these two files; the clone's _repository_ does not, and an
operator told otherwise goes looking in the wrong place. And **the release
filter reads the shared helper** rather than its own inline
`=== "manual_reconcile"`.

### What is deliberately not fixed here

The repository cascade still cannot carry a 41 MB file. Doing so means
committing an oversize blob through the Git Data API rather than the contents
API — real work, with its own failure modes, and not something to bolt onto a
change whose point is that a control was lying. What changes here is that the
product stops offering a button that cannot help and starts saying what is
actually required.

### A note on the instrument, since it nearly took this section with it

The first version of this section's contract test asserted against a
comment-stripped copy of `cascade-engine.server.ts` and failed on a rule the
file obeys. The stripper had deleted **13,438 characters of real code**:
line 1415 is

```
  // `src/integrations/**` would otherwise reach the clone's backend identity
```

and `/**` inside a line comment opens a block comment that the usual
`replace(/\/\*[\s\S]*?\*\//g, "")` runs past, closing at the next `*/`
anywhere below. `moduleScopeDiff.contract.test.ts` documents this exact trap
already — _"Read RAW. The usual comment-stripping regex eats from the first
`/_` it meets"\* — so the repository has paid for it once.

Measured across `src/`: **twelve line comments in eleven files** open a false
block comment. Two contract tests strip block comments and read one of those
files, and **neither is currently vacuous** — `oversizeHold.contract.test.ts`
uses positive assertions guarded by a "the slices this file reads exist" test,
and `backendSync.contract.test.ts` strips a different file that carries none.
So this is a live hazard with no current casualty, recorded rather than fixed
with a repository-wide ratchet for something biting nothing. The local remedy
is the one used here: strip **line comments only**, which cannot swallow code,
and write patterns specific enough that prose would not satisfy them.

### The ratchet, one month later — and why "biting nothing" was wrong

Closed 20 Sep 2026. The paragraph above declined a repository-wide ratchet
"for something biting nothing", and that judgement did not survive a
measurement:

|                                  | 19 Aug (recorded above) | 20 Sep (measured)         |
| -------------------------------- | ----------------------- | ------------------------- |
| files carrying a false opener    | 11                      | **15**                    |
| contract tests reading one       | 2                       | **10**                    |
| real code a naive strip destroys | not measured            | **1,056 lines, 66 files** |

The two worst readings are `cascade-engine.server.ts`, where the naive
expression destroys **123 lines beginning at `partitionCascadePaths(…)`** and
which two contract tests read, and `backend-provisioning.server.ts`, where it
destroys 20 beginning at ``redirectSet.add(`${site}/*`)`` and which seven
read. Neither test failed, because a scan that sees less code answers the same
question with a confident wrong number.

The commonest opener turned out not to be a comment at all. It is **data** — a
glob in a string (`pattern: "scripts/**"`) or in a template literal. That is
why the replacement scans with string awareness rather than pattern-matching
the file, and why its governing rule is **never eat code**: where it cannot
tell a regex literal from a division it returns the line whole, keeping prose,
because keeping prose costs a test a name it must tolerate while eating code
costs it the truth in silence.

Forty-three modules carried a copy. Forty were TypeScript and are now one
(`sourceComments.pure.ts`); the other three were **SQL**, which is a different
rule — no `//`, `--` to end of line — and are now one of their own
(`sqlComments.pure.ts`), with the read-only gate's deliberately stricter
ordering named rather than hidden. `oneCommentStripper.contract.test.ts` is
the ratchet, and it forbids the _shape_ (a regex spelling both an opener and a
closer) rather than one spelling of it, so a line-anchored comment filter —
which cannot run past the line it tests — stays allowed.

Three things it found on the way, each worth more than the fix:

- **A test anchored its slice on a comment.** `fleetPassIsBudgeted` located a
  branch by `"? // Said before the level reading"`. With prose removed the
  slice silently became empty rather than failing to find its landmark, and
  four assertions passed on `""`. It anchors on code now.
- **The migration rewrote its own witness.** The script replaced the naive
  regex inside the test that exists to prove the naive regex is wrong, leaving
  it comparing the new stripper to itself. Caught only because that assertion
  is `not.toContain`.
- **The gate detected itself**, exactly as the orphan ratchet did, and the
  self-exclusion then hid a second hole: widening it to `.test.ts` left the
  gate green — there was nothing to catch on the real tree — while disarming
  it for the 37 of 40 strippers that lived in test files. The scan takes its
  corpus as a parameter now, so the skip is exercised rather than trusted.
