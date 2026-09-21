# The fleet had no view of the tree it is copied from

Read this before touching `primeHealth.pure.ts`, `prime-health.server.ts`,
`src/routes/prime.tsx`, or `PASSING_CONCLUSIONS` in
[`cascade/autoMergeGate.pure.ts`](../src/server/cascade/autoMergeGate.pure.ts).

Mission Control observes the fleet in six places and every one of them looks
**downstream**. `/health` walks each clone and pings it. `/drift` lists what
they have diverged on. `/cascades` reports what was delivered. `/slo` and
`/metrics` measure the delivering. Nothing looked at the repository all of it
is copied from, and the fleet cannot be healthier than that tree.

---

## 1 · What the cascade already refuses, and where it stops asking

The merge gate is the most carefully argued module in this repository, and
[`CASCADE_ON_MERGE.md`](./CASCADE_ON_MERGE.md) records the freeze that bought
each of its rules. `decideCascadeMerge` refuses to merge a cascade's pull
request when:

- nothing has reported (`no_checks` — "a tree nothing has built");
- a required job has not reported yet (`awaiting_required`);
- anything finished red (`failing`);
- every red job ended within 20s of starting (`never_started` — an Actions
  billing condition, not a bad tree);
- the check runs cannot be read at all (`checks_unreadable`).

And `reclassifyAgainstBase` goes one better: it works out whether a failure is
the proposal's or the clone's own default branch's, because reporting both as
`failing` read twenty good proposals as twenty bad ones.

**None of that is asked one step earlier, of the repository the proposal is
copied from.** `hooks.github.tsx`, on a `push` to prime's default branch:

```
resolve prime_config
  → confirm repo and ref
    → createCascadeForAllClones(...)     // every clone, unconditionally
```

There is no check-run read on that path. The signal is not unavailable
either — the same webhook receives prime's own `check_suite` deliveries and
discards them, under a comment that says so:

```ts
// Not a clone. The prime's own check suites arrive here too, and
// the prime is not in the merge drain's work list.
```

So a commit that fails `verify` on prime is proposed to every clone within
seconds of landing. What happens next depends on `default_cascade_mode`, and
neither outcome is good:

| mode         | what a red prime produces                                                        |
| ------------ | -------------------------------------------------------------------------------- |
| `pr`         | N pull requests, each sitting red, none of which any clone caused                |
| `auto_merge` | the gate holds every one of them and **the fleet silently stops receiving code** |
| `notify`     | N drift notices about a tree nobody should adopt                                 |

**`pr` and `auto_merge` differ less than their names suggest**, and the page
says so because the first draft of it got this wrong. `cascadeMergeDrain`
claims its work list with `.eq("status", "pr_opened")` and **no mode filter**,
so it merges a green `pr`-mode proposal exactly as it merges an `auto_merge`
one. The real difference is timing: `auto_merge` also reads the checks at the
moment it opens the proposal and lands a green one immediately. In both modes
a red prime ends the same way — nothing lands, and nobody is told.

The `auto_merge` case is the September shape recorded in
[`FLEET_SYNC_STALL_2026-09-19.md`](./FLEET_SYNC_STALL_2026-09-19.md) and in
`NEVER_STARTED_CEILING_MS`'s own header: proposals growing to several hundred
files while every clone ran the prime as it stood days earlier, with every
individual signal reading normally.

---

## 2 · What was built, and what deliberately was not

**Built: the reading.** `/prime` answers, in one place, the questions an
operator previously had to open GitHub for —

1. has prime's head been built, and did it pass?
2. is that commit travelling, or is it stranded?
3. which of the last fifteen commits went out red?
4. what is queued behind it in open pull requests?
5. how often does prime break, and is it red _right now_ in a streak?
6. did the last cascade actually land on each clone?

**Not built: a gate.** Nothing here refuses a cascade. That would be a change
to the fan-out with its own failure mode — a prime whose CI is merely slow
would stop the fleet, which is the `in_flight` state and is not a refusal —
and it is a decision about revenue-bearing machinery rather than about a
dashboard. What is closed is that the condition was not _observable_.

This distinction is drawn on the page itself, permanently, in
`GateStanding`. **A control that does not exist must not be implied by a light
that looks like one.** This repository has paid for the inverse already — Stage
9's "Approve the gate" button, disabled behind a reason field, that did nothing
when pressed — and the rule it bought runs in both directions. An operator who
reads the red band as a stop sign is worse off than one who never opened the
page.

---

## 3 · The rules

### The prime is judged by the standard its own output is judged by

`assessPrimeGate` calls `decideCascadeMerge(checks, REQUIRED_CHECKS)` — the
cascade's own module, not a copy of its thresholds. That is the point rather
than a convenience. A second implementation would be a second opinion, and the
first time the two disagreed this page would be reassuring an operator about a
tree the merge drain was about to refuse. `primeHealth.pure.test.ts` asserts
the import and the call site by reading the source, because a copy would pass
every behavioural test in that file.

The same rule reaches one level further down. `PASSING_CONCLUSIONS` — what
`neutral`, `skipped` and `stale` mean — is now **exported** from
`autoMergeGate.pure.ts` rather than retyped. It had been inlined twice in the
page as `["success", "neutral", "skipped", "stale"].includes(...)`, which is a
third and fourth statement of one rule living in JSX where no unit test reaches
it. A source-level test asserts the copies stay gone, and it was proven
non-vacuous by planting one back.

### Five states, because "not proven" and "proven bad" have opposite remedies

`PrimeSafety` is `proven | refused | in_flight | unproven | unknown`, and
collapsing it to a boolean is how `unknown` comes to render green.

| state       | means                               | remedy points at                      |
| ----------- | ----------------------------------- | ------------------------------------- |
| `proven`    | required checks ran and passed      | nothing                               |
| `refused`   | something finished red              | the failing job on prime              |
| `in_flight` | CI is still working                 | nothing — it is not a no              |
| `unproven`  | nothing built it, or no job started | prime's workflows, or Actions billing |
| `unknown`   | the signal could not be read        | the App's `Checks` permission         |

`isProven()` is the one place that decides whether a state may be presented as
good, exported so surfaces ask rather than compare. `safety === "proven"` at a
call site is one refactor away from `safety !== "refused"`, which answers yes to
`unknown` — precisely the shape of the payment-gate defect where an unrecognised
reason word drew a full-width demand for money.

### A read that failed is never a read that found nothing

`assessPrimeGate(null)` is a permission error; `assessPrimeGate([])` is a tree
nothing has built. They are different arguments, produce different states and
name different remedies. The same distinction runs through the gather:
`prime-health.server.ts` asks seven questions of two systems, **each failing on
its own with its own `*Error` channel beside its data**, so a GitHub incident
costs one panel rather than the page.

The cascade ledger carries it too. A failed `cascade_events` read yields `null`
rather than `[]`, so `assessCascadeCoverage` answers `unknown` instead of
`uncarried` — an unreadable ledger must never be reported as a fleet that has
stopped cascading.

### `unobserved` is a reading, and it is never a pass

CI for every open pull request and every row of the commit ledger is resolved
by matching head SHAs against **one** 100-run window, rather than one API call
each. This installation's hourly allowance is the scarcest resource in the
system and has been exhausted twice (see `githubUsageMeter.ts`), so the page
costs six calls in total and is attributed to a named lane.

The trade is that a head the window does not name cannot be judged. It reads
`unobserved`, renders amber, and says so on hover. It does **not** default to
green: that would be the empty-reading defect this platform has already shipped
in `sanctions_entries`, in `placesAvailability` and in `builder_network_stock_ranked`.

A head whose only runs were _cancelled_ is also `unobserved` rather than
passing — nothing built it.

### A pending cascade covers prime's head whatever SHA it names

`assessCascadeCoverage` checks three things in order: an event naming this
commit, then any event still queued, then `uncarried`.

The middle step is not an optimisation. `createCascadeForAllClones` deliberately
folds a push into an unclaimed pending cascade rather than creating a second
one, and says why — "that event reads prime's head when it runs, so it will
deliver this push's content". Without the fold rule, the fleet's most ordinary
state would raise a false alarm on every visit.

`uncarried` is the one worth surfacing: prime has moved, no event names the
commit, and none is queued that would pick it up. The webhook did not arrive, or
it was declined. Nothing anywhere reported that before.

### Absent is never zero

A workflow with no decided run has `successRate: null`, rendered `—`. Rendering
`0%` would report a healthy prime as entirely broken. `trend.empty` says which
case it is, and the worst-first sort puts an unmeasured workflow **beside a bad
one rather than at the healthy end**, because "unmeasured" is not "fine".

Cancelled and skipped runs are a third bucket, counted separately from failures.
That is deliberately **wider** than the merge gate's `PASSING`, and the
difference is the question: the gate asks "may this merge?", where a cancelled
run is not evidence the tree is good and must block; a trend asks "how often
does prime break?", where counting operator-cancelled runs as failures reports a
repository as unreliable because somebody pressed cancel.

### Precedence in the headline is stated, not emergent

Two conditions can be true at once and the page has one headline, so
`assessPosture` orders them: **a red head outranks everything** (it is what
breaks clones), then an **uncarried** head (a fleet-wide stall wearing the
costume of a quiet day), then anything unproven or unreadable. Only a proven
head with something carrying it reads as settled, and a test asserts no
combination of a non-proven gate with any coverage state can answer `ok`.

---

## 4 · What the page reads, and what it costs

| #   | call                                    | what it buys                                 |
| --- | --------------------------------------- | -------------------------------------------- |
| 1   | `repos.getBranch`                       | the head SHA everything else is keyed on     |
| 2   | `checks.listForRef`                     | the gate verdict                             |
| 3   | `actions.listWorkflowRunsForRepo` (100) | the trend **and** CI for every PR and commit |
| 4   | `repos.listCommits` (15)                | the commit ledger                            |
| 5   | `pulls.list` (30 open)                  | what is queued to become the next payload    |
| 6   | `rateLimit.get`                         | free — counts against nothing                |

The branch is resolved **first** and every later call is keyed on the SHA it
returned, so the whole page describes one commit. Asking each endpoint for
`main` independently would let a push land mid-read and produce a page whose
checks, commits and coverage silently describe two different trees.

Database reads: `prime_config`, the last 60 `cascade_events`, and the
`cascade_results` of the most recent one. All through `context.supabase`, so
everything is read under the caller's own RLS — a fleet-wide reading must not be
a way to read rows the operator could not read directly.

Deliberately **not** cached. `/health` caches because it probes every clone;
this is six calls against one repository, and "is prime green right now?" is
worthless a snapshot old.

---

## 5 · Two halves, and only one of them is measured here

[`PRIME_HAS_TWO_HALVES.md`](./PRIME_HAS_TWO_HALVES.md) records what conflating
them cost: every clone-provisioning path that said "replicate from the prime"
replicated from Mission Control's own database instead, succeeded, and produced
confident wrong results.

The health reading above measures the **repo** half only; the backend half
(`prime_config.supabase_project_ref`) is _named_ in the Provenance strip and
reads amber when unset. §7 adds a panel that reads BOTH, and keeps them apart
for the same reason: two halves, two `LedgerHalf` readings, two independent
failures, and neither ever produces a number about the other.

---

## 7 · The SQL ledger — where good code fails to travel

On the code half a bad commit travels **immediately**: a push fans out to every
clone with no check-run read anywhere on the path. On the migration half the
failure is the exact opposite and much quieter — **good SQL does not travel at
all**, and nothing on the prime says so.

`scopeCorpusToPrime` is the rule, and it is the right rule: a clone is never
sent a migration the prime's own `supabase_migrations.schema_migrations` does
not record. It is what stopped two `rollback_*` scripts undoing an RLS fix on a
tenant. But the prime's `apply-migration.yml` is `workflow_dispatch` on a named
file, so its ledger records **what somebody remembered to dispatch**, not what
merged. A migration that lands on `main` and is never dispatched holds every
clone at the version before it — and everything after it too.

Measured 19 September 2026: four migrations sat on prime's `main` unrecorded,
and two tenants had been held at `20261201100000` behind them. The condition's
only trace anywhere was free text in `clone_backends.status_detail`, while both
clones read `status: ready`.

| Reading        | Where it comes from                                                            | Cost                                                                 |
| -------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| the **corpus** | `supabase/migrations/*.sql` at prime's head, over GitHub                       | `repos.getBranch` + one recursive `git.getTree`, held 60s in-process |
| the **ledger** | `supabase_migrations.schema_migrations` on `prime_config.supabase_project_ref` | one statement over the Management API, no GitHub budget              |

No migration **body** is read. That is the whole difference between this panel
and `buildPrimeLedgerReconciliation`, which reads up to 120 bodies and is a
press for exactly that reason. This one loads with the page and yields at the
scan floor.

Four rules carry it:

- **The frontier is the newest RUNNABLE version, never the newest file.** That
  expression is the fault [`migrationFrontier.pure.ts`](../src/server/migrationFrontier.pure.ts)
  exists to make unspellable — a recorded position past the end of what actually
  happened, believed because nothing compared it against the thing it describes.
- **An empty ledger is `unreadable`, never `aligned`.** `assertPrimeLedgerUsable`
  refuses a fleet sync on exactly that reading; a page calling it a clean bill of
  health would be agreeing with the one state the sync lane will not act on.
- **A skew suspicion is reported beside the count, never subtracted from it.** A
  ledger row within ten seconds of a repo version is consistent with Lovable
  stamping its apply time — but two migrations authored seconds apart are
  indistinguishable to that test, so it is a hypothesis for a person.
- **Ledger rows matching no repo file are counted and never listed.** 481 of
  this prime's 890 rows are that shape; a list of 481 is noise, while the count
  is exactly why the ledger is a poor witness for the question it is asked.

---

## 8 · One clone, held against the prime

The fleet page answers "is this clone healthy". This panel answers the inverse,
which is the only question the source of the fleet is entitled to ask: **of
everything wrong with that clone, how much did the prime cause?**

`clone_sync_blockages` has carried an `owner` on every row since the taxonomy
was written — [`blockageTaxonomy.pure.ts`](../src/server/cascade/blockageTaxonomy.pure.ts)
calls it "the field everything else turns on" — and no surface had ever grouped
by it. An operator looking at six open blockages had six sentences and no way to
see which two were theirs to fix on the prime.

Three readings, from three places that fail apart:

| Half       | Source                                                     | What it is                                          |
| ---------- | ---------------------------------------------------------- | --------------------------------------------------- |
| code       | `clones.last_synced_sha`, `commits_behind`                 | Mission Control's record of a pass, labelled as one |
| migrations | `clone_backends.migration_version` vs the prime's frontier | a **cursor**, never the clone's own ledger          |
| blockers   | `clone_sync_blockages` where `cleared_at is null`          | every open reason, split by side                    |

**The side is derived, never listed.** `sideOfBlockage` reads
`BLOCKAGE_POLICY[cls].owner`; a second hand-written list of prime-side classes
is how the two come to disagree, and the disagreement would be silent because a
class missing from such a list simply lands on the other side and looks
deliberate. The one class named explicitly is `prime_ledger_hole` — its owner is
`operator` because a person decides, and the person is standing at the **prime**,
dispatching a migration there.

Four more rules:

- **A read that failed is `null`, never `[]`.** "Nothing is blocking this clone"
  is a claim a query that did not answer cannot make, so an unread blockage
  ledger outranks every clean reading beneath it: a clone carrying prime's head
  at prime's frontier with an unreadable blockage table is not converged, it is
  a clone we cannot describe.
- **Every number names its basis.** `cloneMigrationStanding.pure.ts`'s entire
  header is the bill for treating a cursor as a ledger — it offered "5 PENDING"
  where two were already applied and one could never be sent.
- **A cursor ahead of the prime is a finding, not a pass.** It is the direction
  that loses data silently: the next sync computes what is owed from that number,
  so every version between the two is skipped as applied and nothing offers them
  again. And a cursor that is not a `YYYYMMDDHHMMSS` version is `unknown` rather
  than ordered — lexicographically `"9"` sorts above `"20261204010000"`.
- **The prime's side is resolved on the server, never accepted from the page.**
  `primeHeadSha` and `frontier` ride the assessment. A request field asserting
  what the server is being asked to decide is the pattern IPV 1.1.0 forbids.

The selector itself costs **no GitHub call**: an operator lands on the drop-down
before asking a question, and buying a tree walk to draw it would spend the
window on nobody's behalf. It is also read first and returned whatever happens
after it, so the one state an operator most needs the page in is not the state
with no way to pick a different clone.

---

## 9 · Diagnosing a migration, and fixing it at the source

§7 counts what the prime is holding back. This answers the next question —
_that one, why is it sitting there, and is it safe to run?_ — and, on one
verdict out of nine, offers to run it.

It matters to the fleet rather than only to the prime.
`fleetCorpusScope.pure.ts` sends a clone only what the prime's ledger records,
and `partitionByDependency` refuses to step over a version the prime has not
run. So one unrun migration on the prime is a barrier for every clone behind
it, and everything after it in corpus order queues up behind that barrier. The
backlog a clone reports is very often not the clone's at all.

### The layers, cheapest first, each failing on its own

|     | layer                                | what it costs                                    |
| --- | ------------------------------------ | ------------------------------------------------ |
| 1   | the filename                         | nothing — a `rollback_*` script is an undo       |
| 2   | the corpus listing                   | one tree walk, cached 60 s — collisions and size |
| 3   | this file's statements               | one blob, cached by commit                       |
| 4   | the prime's live catalogue           | one statement                                    |
| 5   | a rolled-back trial run on the prime | one statement                                    |

None of them is inferred from another's silence. A layer that could not answer
reaches the verdict as a named absence, which is why `undiagnosed` exists
beside `would_fail` and is never merged into it.

### The one rule the whole feature rests on

**A body carrying transaction control may never be dry-run.** The trial run is
`BEGIN; SET LOCAL lock_timeout; SET LOCAL statement_timeout; <body>; ROLLBACK;`,
and a `COMMIT;` inside the body would end that transaction and make everything
before it permanent — a "test" that writes to the prime's production database,
which would look exactly like a success.

So the statement scan gates the run rather than annotating it, and it is
asserted twice: by source order in `primeMigrationDoctorMounted.test.ts`, and
behaviourally in `primeMigrationDiagnosis.server.test.ts`, which captures every
statement the module sends and asserts the transcript is **empty** for such a
body. A verdict is a thing the module computed; the transcript is a thing the
database would have seen.

Two more parts of that wrapper are load-bearing. `lock_timeout` is why a
diagnostic cannot block the prime's own traffic — a trial run waiting on a lock
held by a live transaction would queue every reader behind it. Both timeouts
are `SET LOCAL`, so neither outlives the rollback onto the pooled connection
the next caller gets.

### Why eliding function bodies is safe, and how that is kept true

A PL/pgSQL `BEGIN` is a block opener, not a transaction, so the scanner
replaces every dollar-quoted body with a placeholder before looking for
transaction control. Without that, every `create function … $$ begin … end $$`
in the repository would read as a transaction and the feature would refuse
nearly everything.

That is safe because **a function cannot commit — only a procedure invoked by
`CALL` can** — and the prime's corpus contains **0 procedures and 0 `CALL`
statements**. Because that is a measurement rather than a law, `CREATE
PROCEDURE` and `CALL` are their own hazard with nothing currently to catch: the
day the corpus gains one, the scan notices rather than going quietly wrong.

### Two things the trial run will not do

It is bounded by **request size**, at 1 MB. Above that the answer would be
about the transport rather than the migration —
`apply-migration.yml` exists partly because a ~19 MB `INSERT` is _"too large
for one Management API request"_, and a request-size refusal read back as
`would_fail` would be this console blaming a file for its own plumbing. The
number costs almost nothing: of the prime's 1,002 files, 986 are under 256 KB
(p50 is 2.1 KB, p90 is 11 KB), 13 are past `MAX_MIGRATION_BYTES` and never get
a body at all, and **exactly one** sits between the two ceilings — a 3.76 MB
template-library seed, which is the shape the chunking route was built for.

And it is never made for a file whose answer the FILE already settles: an undo
is not sent even inside a transaction that rolls back, and neither is a version
two files carry. Both are safe to send and both would be pointless, and sending
an RLS-undo script to a production database "because it rolls back" is an
exception nobody reading the code would expect.

### Calibration, and the rule the measurement killed

Every threshold here was set by counting over the prime's own **988 readable
migration files (11,070 statements)** on 20 Sep 2026, because a caution that
fires on a quarter of the corpus is one operators learn to dismiss — the
eleven-unreadable-chips failure, committed on the screen that offers to run
something.

|                                                         | files | share |
| ------------------------------------------------------- | ----- | ----- |
| untestable (transaction control or an added enum value) | 48    | 4.9%  |
| destroys data                                           | 32    | 3.2%  |
| would duplicate rows if run twice                       | 36    | 3.6%  |

The escape hatch being under 5% is what makes gating on it affordable.

One rule was written, measured and **removed**, and the reasoning is worth more
than the rule was. A general "could this statement succeed a second time?"
check produced **2,411 hits — 22% of every statement in the repository** — of
which `CREATE POLICY` alone was 1,592 across 320 files. What survived the
narrowing is the distinction that actually matters: a second `CREATE TABLE`,
`CREATE INDEX` or `ADD CONSTRAINT` fails **loudly**, with `42P07`/`42710`,
having changed nothing, and the repair is mechanical; a second unguarded
`INSERT` **succeeds**, and duplicates rows. That is the case
`apply-migration.yml`'s own header names — _"data mutations … where a second
application is not a no-op"_ — and it is 62 statements across 36 files.

Three exclusions are recorded for the same reason: `DROP POLICY` (153 files —
the `DROP POLICY IF EXISTS … CREATE POLICY` idiom loses nothing), `DROP
FUNCTION`/`DROP TRIGGER` (452 statements across 141 files, almost all
drop-and-recreate in the same file, and it destroys code rather than data), and
`UPDATE` (257 statements across 161 files, routinely idempotent by
construction).

### A finding the survey turned up

**32 versions in the prime's corpus are carried by two files each — 77 files,
of which 45 can never be recorded.** `schema_migrations.version` is the primary
key, so one of each pair is permanently absent from the ledger; and a version
the ledger cannot record is a hole `partitionByDependency` refuses to step
over, for ever. `20260717000000` is both `add_builder_invoice_current_payment`
and `restrict_finance_portal_notification_routing` — two unrelated migrations
that cannot both be stamped.

No amount of running anything clears that. The repair is a rename in the prime
repository, which is why the survey rides every diagnosis report and is drawn
as a standing notice rather than as one file's verdict.

### The act, and the four things that bound it

The console does not apply anything itself. It dispatches
`apply-migration.yml` on the prime, which is the workflow that already exists
there for this act and which holds the credential to do it — and the credential
is exactly why. That workflow's header records the reasoning: a Supabase
personal access token _"carries the whole account … including [projects]
created after the token was issued"_, while a database URL reaches one database
and can be rotated for one deployment. The act belongs where the narrow
credential is.

What this adds is the judgement in front of it. That workflow says the quiet
part out loud — _"Deciding **which** file is a human judgement made before
dispatch, not a thing this workflow infers"_ — and until now that judgement was
a person reading SQL in a browser tab.

1. **`dispatchable` is an ALLOW-list of one verdict.** `ready`, and nothing
   else. The shape `payingCanUnlock` was rewritten into after a deny-list
   answered yes to every word the build had never heard of; a verdict added
   tomorrow is refused by default. `already_applied` is deliberately _not_
   dispatchable — re-running a migration the prime has already run is the exact
   danger `apply-migration.yml`'s header names.
2. **The verdict is re-taken at the moment of the act**, server-side, including
   the trial run. A reading an operator looked at five minutes ago describes a
   schema that has since moved — and a request field asserting the server's own
   conclusion is the pattern IPV 1.1.0 forbids. `dispatchable` travels out to
   the browser; it never travels back. The page sends a version and nothing
   else.
3. **One file, named, and never a set.** There is no "apply all". The prime's
   ledger under-reports by roughly two orders of magnitude — 133 migrations
   called pending on 2026-08-13 where all but one family already existed — so a
   loop over "everything pending" would replay data mutations that are not
   no-ops.
4. **One apply at a time.** `apply-migration.yml` declares `concurrency:
apply-migration, cancel-in-progress: false`, so a second dispatch queues
   behind the first rather than racing it — and then runs. For an idempotent
   file that is harmless; for one of the 36 carrying an unguarded `INSERT` it
   duplicates rows. The window is narrow (once the run lands, the version is in
   `schema_migrations` and the next diagnosis answers `already_applied`) and it
   is exactly the minute an operator is most likely to click again, having seen
   nothing happen. The activation gate paid for this class once already:
   _"paying twice was one click away."_ So the dispatch asks GitHub whether a
   run is in flight and refuses while one is — and a probe that FAILED does not
   refuse, because the conservative side of a disclosure is to say nothing
   rather than to invent a reason.
5. **Withholding the shortcut never withholds the act.** Every refusal names
   what to do instead, and `apply-migration.yml` is still on the prime and
   still runnable by hand. That is what makes gating on one verdict affordable
   rather than obstructive.

The page draws the button on the server's `dispatchable` field and never on a
verdict word — a comparison in JSX would be a second copy of the allow-list
living where no test reaches it, and a test refuses any `verdict ===` in the
route. The confirmation restates the **same** `remedy` sentence the card draws,
because two statements of what is owed is how one screen comes to warn about
something the other does not.

### Read-only, structurally

The judgement and the gathering are one pair of modules and the act is a
separate one, so the reader can be asserted incapable of writing by source
position — no `insert`, `update`, `upsert`, `delete` or `rpc`, no
`writeAuditLog`, and no `dispatches`. A later edit cannot make the reader the
writer. On the writing side the order is asserted too: diagnose, refuse,
request, **then** record. An audit row written first would name an act that may
not have happened.

### What it is not

- **It cannot repair a file.** It says what is wrong; editing the SQL is a
  commit to the prime repository like any other.
- **It cannot close a collision.** That is a rename, and nothing here renames
  anything.
- **It is not a queue.** One file at a time, chosen by a person, with the
  evidence in front of them.

## 9a · The same question, over the whole withheld set

Section 9 diagnoses ONE migration, and the drop-down it is chosen from lists
filenames and nothing else — so "which of these twenty-five is the problem?"
could only be answered by opening them one at a time, at two Management API
statements and a trial run each.

`/prime-migrations` answers it in one bounded read, and adds the question
nothing in the product answered at all: **is this migration safe to run
twice?** — which matters here because `apply-migration.yml` runs `psql` with no
`--single-transaction`, so a half-failed file is fixed and dispatched again over
statements that already ran.

[`MIGRATION_HEALTH.md`](./MIGRATION_HEALTH.md) carries it: the four readings and
the measurement that chose them over a boolean, why the survey's vocabulary may
not share a word with the verdicts above, the one cascade both surfaces walk,
and the three ways the pass is bounded.

---

## 10 · What is open

- **The gate itself.** Refusing a cascade from a red prime is the obvious next
  step and is not taken here. The design question it turns on: `in_flight` is
  the common state immediately after a push, so a naive gate would delay every
  cascade by the length of `verify` (~17 minutes) or stall the fleet whenever
  CI is slow. A considered version probably defers rather than refuses, and
  that is a change to the fan-out, not to a dashboard.
- **Alerting.** Nothing raises a notification on `uncarried` or on a standing
  red streak. Given that
  [`CASCADE_PIPELINE_HEALTH.md`](./CASCADE_PIPELINE_HEALTH.md) measured 79% of
  the notification channel to be successes and normal operating states, adding
  volume there without addressing that first would be adding to the noise the
  escalation channel already died of.
- **The window's edges.** A repository busier than 100 runs between visits will
  read `unobserved` on older commits. That is honest but it is a ceiling, and
  the fix is pagination rather than a larger page.
- **The comparison reads records, not the clone.** `commits_behind` and
  `migration_version` are Mission Control's own columns, and the panel labels
  them as such rather than pretending otherwise. Reading each clone's live
  ledger is what `getCloneMigrationStatus` does, at one Management API call per
  clone; folding that in would make selecting a clone a great deal more
  expensive than it currently is, and the honest cursor is enough to answer
  "who is holding this one".
- **This console is not cascaded.** Mission Control is not in the cascade graph
  at all — the prime is `Naidu-Group-Pty-Ltd/npc-property-dashbord` and the
  clones are that product, a different application entirely. Nothing on this
  page can travel to a clone, and nothing should: it reads `prime_config`,
  `cascade_events` and `clone_sync_blockages`, which are this deployment's own
  tables.
- **The trial run is a moment, not a guarantee.** It proves the file applies
  against the schema the prime has _now_. Between the trial and the dispatch
  another migration can land, and `apply-migration.yml` applies statements one
  at a time with no enclosing transaction — so a file whose second half fails
  leaves its first half applied. That is why data loss and duplicate-row
  statements are disclosed on a `ready` verdict rather than hidden by it.
- **48 files cannot be tried at all.** Transaction control and added enum
  values are 4.9% of the corpus, and for those the page explains and offers
  nothing. Making them testable would mean splitting a body at its own
  transaction boundaries and trying each piece, which is a different and much
  larger thing than this.
- **The panel has not been rendered against production.** Every judgement here
  is covered by tests, and the scanner was calibrated by executing it over all
  988 readable files in the prime's corpus — but the page itself needs an
  authenticated admin session on a deployment, and the layout has been reasoned
  from the design system rather than measured in a browser.
