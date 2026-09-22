# The prime's migrations could be diagnosed one at a time, and chosen blind

Read this before touching `assessIdempotency`, `idempotencyWalk`,
`surveyMigration`, `stopBeforeTrialRun` or `corpusFacts` in
[`primeMigrationDiagnosis.pure.ts`](../src/server/primeMigrationDiagnosis.pure.ts),
[`primeMigrationHealth.server.ts`](../src/server/primeMigrationHealth.server.ts),
or `/prime-migrations`.

**§10 onwards is the repair** — read it before touching
[`primeMigrationRemedy.pure.ts`](../src/server/primeMigrationRemedy.pure.ts),
[`primeMigrationRemedy.server.ts`](../src/server/primeMigrationRemedy.server.ts)
or the `RerunPanel` on `/prime`.

`/prime` already diagnoses ONE migration properly — it reads the file, asks the
prime's own catalogue about it and tries it inside a transaction that is always
rolled back. That is the right depth for the file an operator has chosen. It is
the wrong shape for **choosing** one: the drop-down that feeds it lists
filenames and nothing else, so "which of these is the problem?" could only be
answered by opening them one at a time, at two Management API statements and a
trial run each.

And nothing anywhere in the product answered the second question at all:
**is this migration safe to run twice?**

---

## 1 · Why the second run is a real question here

`apply-migration.yml` runs

```
psql -v ON_ERROR_STOP=1 -f "$FILE"
```

with **no `--single-transaction`**, and its own header says so: statements apply
in order, the run stops at the first error, and what came before it stays
applied. So a file that fails half way leaves a partially-migrated schema, and
the repair is to fix the file and dispatch it again — over statements that
already ran.

That is not a theoretical property. It is the state an operator is standing in
at the exact moment they most need an answer, and the answer differs sharply by
statement:

| second run                                                | what happens                                     | how it is found                       |
| --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `CREATE TABLE` / `INDEX` / `POLICY`                       | fails with `42P07`/`42710`, **changing nothing** | immediately; the file stops           |
| unguarded `INSERT`                                        | **succeeds**, and duplicates rows                | never, until somebody reads the table |
| `IF NOT EXISTS` / `OR REPLACE` / `DROP … IF EXISTS` first | no-op                                            | —                                     |

The middle row is the one worth a chip. The top row is worth saying **as the
mild outcome it is**, because an operator who reads "not safe to re-run" on a
quarter of the corpus learns to dismiss it.

---

## 2 · Why it is a reading and not a flag, with the number that decided it

`DATA_REWRITE` in the diagnosis module already recorded what a general "could
this statement succeed twice?" rule measures over this corpus:

> **2,411 hits — 22% of every statement in the repository**, of which
> `CREATE POLICY` alone was 1,592 across 320 files.

A boolean drawn from that is red nearly everywhere and says nothing. So
`assessIdempotency` answers with four readings and lets the silent one outrank
the loud one:

```
rewrites_data   >   fails_loudly   >   rerunnable
unreadable  is never any of them
```

Measured over the prime's own corpus on **21 Sep 2026** — 1,002 files, 989
readable here (13 past the ceiling), 11,072 statements:

```
 688  re-runnable throughout      (68.7%)
 265  a second run FAILS LOUDLY   (26.4%)
  36  a second run REWRITES DATA   (3.6%)
  13  unreadable                   (1.3%)
```

The 36 are the finding. `20250902103046_…` carries five unguarded `INSERT`s and
**no** collisions at all — so a second dispatch of that file writes five sets of
rows again and reports success.

### The pairing that had to be modelled

`DROP POLICY IF EXISTS x ON t; CREATE POLICY x ON t …` is the standard
idempotent RLS idiom, and `DESTRUCTIVE` already excludes it for that reason. A
reading that looked at the `CREATE` alone would call every one of those files
collision-prone. Modelling the pairing — an **earlier** drop of the same object,
in the same file — keeps **212 files** out of `fails_loudly`. Without it the
indicator is noise.

Two bounds on it:

- **`IF EXISTS` is required on the drop.** A bare `DROP x` is itself a statement
  whose second run fails, so pairing one with a `CREATE` would move a file out
  of `fails_loudly` on the strength of a statement that puts it back in.
- **Order matters.** A drop below the create does not make the create safe, and
  a test plants exactly that.

---

## 3 · Two vocabularies, held apart on purpose

The survey answers a different question from the diagnosis, and they may not
share a word:

|                    | question                                                           | vocabulary                                      |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `DiagnosisVerdict` | may this console run it **now**?                                   | `ready`, `would_fail`, …                        |
| `SurveyStanding`   | what stands in its way, **before** anything is asked of the prime? | `needs_a_trial_run`, `blocked`, `hand_apply`, … |

`needs_a_trial_run` is the whole point of the separation. It is what a perfectly
healthy file reads in a list, it is drawn **amber**, and it is emphatically not
`ready`: a survey has no evidence that a body applies, only that nothing in the
file forbids trying. A green row on a page that never opened a database would be
a promise nobody made — the inverse of the dead "Approve the gate" button whose
lesson `/prime`'s own header records.

A test asserts the two sets are disjoint. **It was vacuous when first written**
and that is worth keeping: both lists were typed by hand in the test, so
renaming a standing to `ready` left it green. Both unions are now DERIVED from
runtime arrays (`SURVEY_STANDINGS`, `DIAGNOSIS_VERDICTS`) and the test reads
those, so a member added tomorrow is in both or in neither.

---

## 4 · One cascade, walked by both

The layers that refuse a migration before the database is involved —
undo, duplicate version, already applied, oversize, unread, position unknown,
blocked, unsafe to test — live once, in `stopBeforeTrialRun`, and the diagnosis
and the survey both read its answer.

If each walked its own copy of the order, the list and the page would eventually
disagree about the same file, and the disagreement would be **silent** because
each is right about itself. A test drives eight inputs through both surfaces and
asserts they stop at the same layer.

`null` from that function means nothing in the FILE objects. It does not mean
the file is good — which is exactly where the two callers part company.

---

## 5 · What a survey pass costs, and the three ways it is bounded

```
1 × repos.getBranch + git.getTree   (cached 60s in-process, shared with the ledger card)
1 × select version from schema_migrations   (the ledger assessment's own, reused)
≤ 25 × blob read                    (4 in flight)
0 × trial run, 0 × catalogue read, 0 writes
```

- **The set** is bounded by `PrimeLedgerReading.withheld`, capped at
  `WITHHELD_ROWS` newest-first while `withheldCount` stays exact — so a page
  that surveys twenty-five of three hundred **says so** rather than implying the
  corpus is small. `SURVEY_LIMIT === WITHHELD_ROWS` is asserted, because nothing
  else tied them.
- **The concurrency** is bounded at four. A burst of twenty-five blob requests is
  what a rate limiter notices.
- **Each body** is bounded by the corpus ceiling, which refuses before the round
  trip wherever the tree listing carried a size.

It reuses `buildPrimeLedgerAssessment` rather than deriving its own answer to
"which migrations is the prime holding back". A second computation of that
question would eventually disagree with the first, and both numbers would be
plausible while neither named its source.

---

## 6 · What the tree listing alone already says

Three facts cost nothing beyond the listing every other reading here already
pays for, and they are the ones a per-file diagnosis cannot show:

- **Duplicate versions.** `supabase_migrations.schema_migrations.version` is the
  PRIMARY KEY, so a version two files carry can only ever record one of them.
  The other is permanently absent from the ledger, `fleetCorpusScope.pure.ts`
  withholds whatever the ledger does not record, and `partitionByDependency`
  refuses to step over it — so **every clone queues behind it for ever**. On
  this prime: 32 versions across 77 files. Nothing you run closes that hole; a
  rename in the prime repository is the only repair.
- **Files past the reading ceiling.** Nothing is wrong with them; they go
  through the prime's own workflow, which streams a file of that size in one
  piece.
- **Files named as an undo.** Withheld on purpose, for ever, and correctly.

`sizeOf` answers `null` for a blob the listing carried no size for, and that is
counted separately and never folded into either bucket. **An unknown size is not
a small one** — the same rule `loadSql` applies one line below when it fetches an
unsized blob rather than waving it through.

---

## 7 · The direction each judgement errs, which is not the same direction

The dry-run gate treats what it cannot classify as a **hazard**, because a
missed hazard defeats a `ROLLBACK` against a production database and the cost of
being wrong is one migration applied by hand.

The re-run reading is a **disclosure beside a verdict** — it gates nothing — and
the same asymmetry there would paint the whole corpus. So a statement that names
no object it could collide with reads as re-runnable, and the two places it
cannot see are NAMED rather than guessed:

- a body the console never read is `unreadable`, never `rerunnable`;
- a `DO $$ … $$` block, whose contents the scanner deliberately elides so a
  PL/pgSQL `begin` is not read as a transaction, is **counted** and said out
  loud beside the reading. 217 files carry one and 179 of those read
  re-runnable, so it is a caveat on about a fifth of the corpus rather than a
  footnote nobody meets.

---

## 8 · What is asserted

- `assessIdempotency` — five planted defects caught: order-insensitive pairing,
  a bare `DROP` accepted as a guard, an unread body reading re-runnable, the
  loud outcome outranking the silent one, uncapped notes.
- `surveyMigration` — three more: a standing drifting from its layer, a healthy
  file worded as ready, a standing borrowing a verdict word.
- `readPrimeCorpusHealth` — eight: unbounded set, unbounded concurrency, a
  failed listing saying nothing, an unknown position reading as none, nothing
  ever blocked, oversize read as a failure, a null count becoming zero, and the
  survey limit drifting from the reading's cap.
- The surface — seven, in `primeMigrationHealthMounted.test.ts`: the page absent
  from the nav, the row no longer handing a version to the diagnosis, a survey
  computed and thrown away, the healthy standing drawn green, a column name
  reaching an operator, a GitHub lane opened and never flushed, and the set
  un-bounded.

Read-only is asserted by source position, as the ledger and the blockage ledger
already are: no `insert`/`update`/`upsert`/`delete`/`rpc` in the gatherer, the
door or the pure module, and **no `runSqlOnProject` in this feature at all**.

---

## 9 · What it deliberately does not do

- **It does not apply anything.** The act lives in
  `primeMigrationDispatch.server.ts`, behind a FRESH diagnosis, behind an
  allow-list of one verdict. This page links to it and cannot perform it.
- **It does not re-derive the prime's position.** One assessment, read by both
  cards.
- **It does not read inside a `DO` block.** Doing so needs a PL/pgSQL parser,
  and the honest alternative — counting them and saying so — costs one line on
  the page.
- **It surveys only the withheld set.** A migration the prime has already run is
  not work, and the whole corpus is 1,002 bodies.

---

# The repair: what a reading is worth once something can act on it

`assessIdempotency` answers whether a second run of one of the prime's
migrations would be a no-op. Over the corpus it answers **`fails_loudly` for
265 files and `rewrites_data` for 36**, and until this was built that was where
the surface stopped: a chip, a list of statements, and a person opening an
editor.

`primeMigrationRemedy.pure.ts` proposes the smallest edit to the file that
would move it, and `primeMigrationRemedy.server.ts` carries that edit to the
prime as a pull request. Neither is a second opinion about what is wrong: the
planner reads `idempotencyWalk` — the same walk the chip reads, imported rather
than re-implemented — so a statement the page calls broken and a statement the
repair leaves alone cannot be different statements.

---

## 10 · It edits the FILE, and the run stays the ordinary run

The shorter route is to patch the body in memory and send *that* to the
database. It would work, once, and it would manufacture precisely the fault
`scripts/check-applied-digests.mjs` exists to detect — a version in
`schema_migrations` whose content is not what the repository holds. That check
measured **two of fifty-five settled rows already drifted**, with nothing
reporting it.

So the patched text goes to the repository, and `apply-migration.yml` later
runs the file the repository holds, exactly as it does today. A pull request
rather than a push, for the rule `autoMergeGate.pure.ts` states about the
fleet and which is no weaker here: nothing writes to a default branch except
through a pull request whose checks somebody has actually read. The prime's own
CI is what reads them.

The loop is therefore: **diagnose → plan → propose → (a person merges) →
re-diagnose → apply.** Two of those five are this product's, two are GitHub's,
and the middle one is a person's.

---

## 11 · The line that decides what is refused

> **A repair may never turn a loud failure into a quiet wrong answer, and may
> never claim a re-runnability it cannot deliver.**

Two families fail that line, and naming them is most of the module's value.

**An unguarded `INSERT`.** The obvious repair is `ON CONFLICT DO NOTHING`.
Against a table with no unique constraint covering those rows it is legal, it
never errors, and it **still inserts the duplicate** — so the chip would move to
`rerunnable` while the behaviour stayed exactly as it was. The module cannot see
the constraint set from the file, so it cannot tell the sound case from the
placebo. 62 statements across 36 files.

**`CREATE TYPE`.** There is no `IF NOT EXISTS`, and `DROP TYPE IF EXISTS`
cascades to every column declared with it. The idiom that does work —
`DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
— wraps the statement in a block this console's own scanner deliberately does
not read into, so it would move the chip by making the file **less** legible
rather than safer. 40 statements across 13 files.

`CREATE PUBLICATION` and `CREATE ROLE` are refused on the same footing. Neither
appears in the prime's corpus today, and they are named rather than left to fall
through to "no mechanical repair", because an absence with a reason is worth
more than a silence.

### The edge that was argued rather than assumed

Constraints. Dropping and re-adding one revalidates the table, and a primary or
unique key another table references cannot be dropped at all — so on a second
run the file can still stop. It stops **loudly**, having written nothing, which
is the same band it was already in; it never goes quiet. So the repair is
offered, with that cost stated on the row rather than discovered in review.

That is the whole of the line: the INSERT repair can go silent, the constraint
repair cannot.

---

## 12 · Nothing is offered that was not proved

A plan is not a list of intentions. `proveRepair` re-reads the composed patch
and the plan is **discarded** unless all three hold:

| check | the bug behind it |
| --- | --- |
| the bytes account exactly | every edit is an insertion, so anything else means an offset was wrong and something was overwritten |
| it parses to the statements it had, plus the ones inserted | a guard dropped in the wrong place can leave valid-looking text that splits differently, and a reading taken over the wrong statements is worse than no reading |
| the flagged count strictly fell | measured with the same module the chip reads, rather than inferred from the fact that repairs were planned |

A plan that fails any of those answers `unproven` and carries no patch.

`proveRepair` is a separate exported function rather than three lines inside the
planner, and the reason is worth recording: it is the one step whose whole job
is to catch a bug in the step before it, and **a check that can only be reached
through the code it is checking is a check nobody can demonstrate**. Planted
against the shipped planner, removing the branch broke no test, because every
family it plans happens to be sound. Extracted, each of the three checks fails a
test when removed.

What no fixture reaches is the planner ignoring the proof entirely — there is no
valid input whose patch fails it. That branch is pinned on the source instead,
in `primeMigrationRemedyMounted.test.ts`, which says so rather than dressing a
source contract up as execution.

---

## 13 · What it reads over the prime's own corpus, 21 Sep 2026

Over the 301 files `assessIdempotency` does not call re-runnable:

```
  255  every flagged statement has a sound repair      (healed)
   31  some do, some are refused                       (improved)
   15  none do                                         (no_repair)
    0  composed a patch that did not survive its proof (unproven)
```

```
 1,020 / 234  CREATE POLICY   → prepend DROP POLICY IF EXISTS
   333 /  91  CREATE INDEX    → IF NOT EXISTS
   222 /  97  CREATE TABLE    → IF NOT EXISTS
   180 /  99  CREATE TRIGGER  → prepend DROP TRIGGER IF EXISTS
    28 /  23  ADD COLUMN      → IF NOT EXISTS
    20 /  18  ADD CONSTRAINT  → prepend DROP CONSTRAINT IF EXISTS
    62 /  36  INSERT          → refused
    40 /  13  CREATE TYPE     → refused
```

Every `healed` file came from `fails_loudly` and none from `rewrites_data`,
which falls out of the design rather than being coded: a `rewrites_data` file
always carries the one statement that is refused, so the best it can reach is
`improved`.

Three of those numbers are load-bearing beyond their size.

- **0 anchor misses over all 1,913 flagged statements.** Every guard repair
  found the keywords it attaches to in the original bytes. That is what makes
  surgery on the file defensible rather than hopeful — and where it does not,
  the statement is refused as `not_located` rather than patched at a guessed
  offset.
- **0 pure-insertion failures.** Over every patch the planner composed, the
  original is a subsequence of the patched text and the lengths account. Nothing
  was deleted, reordered or reformatted anywhere in the corpus.
- **1,904 of 1,913 flagged statements are written with UPPER-CASE keywords.**
  The inserted text takes the case of the keyword it attaches to. That is not a
  nicety: a lower-case `if not exists` inside `CREATE TABLE` would be visible on
  every line of every diff a reviewer reads.

### What was proved by execution rather than by reading

A local PostgreSQL 16 was brought up and every repair family driven through it:
run the original, snapshot the catalogue, run it again; run the patched file,
snapshot, run it again.

```
21 / 21  families: the original fails its second run, the patched file
         applies twice, and one run of it lands a catalogue byte-identical
         to one run of the original
14 / 14  real corpus migrations that were self-contained enough to apply on
         a bare Supabase-shaped database: same result, 0 disagreements
```

272 of the corpus files were skipped because the **original** could not apply on
a bare cluster at all — they depend on earlier migrations, Supabase roles and
extensions this harness does not have. That is a limit of the harness and is
recorded rather than papered over: the 14 are real, and they are 14.

---

## 14 · The refusals that are about the repository, not the file

`plan.outcome` says whether a sound edit exists. `report.blocked` says whether
the repository is in a state where proposing it is right. They are separate
because they answer different questions, and the second one carries the refusal
worth reading twice:

**A migration the prime has already RUN is never edited.** The instinct is the
opposite — the whole point is to make a second run safe. But once a version is
in `schema_migrations` the file will never be dispatched again (the diagnosis
answers `already_applied` and the dispatch refuses on it), so the repair buys
nothing; and changing the file makes the repository disagree with the ledger,
which is the one thing the digest check forbids in as many words.

What the repair is *for* is the withheld set — the migrations the prime has not
run, which are the ones a clone is sitting behind, which are the ones
`/prime-migrations` lists. The prime's ledger under-reports by roughly two
orders of magnitude, so plenty of those have effectively run without being
recorded; those are unrecorded, the digest check cannot see them either, and
they are precisely the population that needs to survive a re-run.

The others:

- **A version two files carry.** A repair has to name one file, and a collision
  means the version does not. The remedy is a rename, which is a person's
  decision about which is the real migration — and the ledger is not even asked,
  because its answer could not matter.
- **A ledger that could not be read, or that reports nothing applied.** Blocked,
  not allowed: `a read that FAILED is not a row that is ABSENT`, on the one
  refusal that protects the repository from disagreeing with the database.
- **A body past the corpus ceiling.** A repair edits the file, and there is
  nothing to do without reading it.

---

## 15 · One branch per version, and an operator's "no" is not overridden

The branch is `mission-control/migration-repair/<version>` — a function of the
version alone. A second click finds the open pull request and returns it rather
than opening a second one; the cascade engine paid for the other behaviour with
**eight pull requests carrying the same fifty-seven files**.

A branch that exists with *no* open pull request means somebody closed one. That
is a decision. The act refuses rather than re-proposing, and says which branch
to delete to start again.

---

## 16 · What crosses to the browser, and what does not

The patched body is removed from the report at the server boundary —
`RemedyPlanView` is `Omit<RemedyPlan, "patched">`, and the door destructures the
patch away before the response type exists. Two reasons:

- it is the whole file, up to the corpus ceiling, and a page cannot do anything
  with it;
- once it is in the browser it is one edit away from being sent back, which is a
  request field asserting the server's own conclusion — the pattern IPV 1.1.0
  was written to forbid, here on a path that ends in a commit.

What the page draws is the capped rows and the exact counts. A test plans a
thousand-policy file and asserts the serialised report stays under 4 KB while
the patch is over 60 KB: **the report does not grow with the file.**

The act re-plans from a fresh read and commits the patch it just composed. Between
an operator reading a plan and clicking, the file may have been edited, the
version may have been applied, or the repair may have landed already.

---

## 17 · What the repair deliberately does not do

- **It does not run anything.** The confirmation says so in as many words: it
  changes a file, and the migration still has to be applied afterwards.
- **It does not merge.** The prime's checks run on the pull request and a person
  merges it.
- **It does not repair a file the prime has run**, for §14's reason.
- **It does not invent a guard for a statement it cannot guard soundly.** Both
  refusal lists are drawn on the page, because a surface that showed only what it
  would change would be answering half the question — on 36 of the prime's files
  the statement that matters is one it refuses to touch.
- **It does not read inside a `DO` block**, for the same reason the reading does
  not: that needs a PL/pgSQL parser, and the honest alternative is to count them
  and say so.

## 18 · An anchor is SQL, never a comment or a stored value

§13 recorded **0 anchor misses over 1,913 flagged statements** and called that
what makes surgery on somebody else's file defensible. It was true, and it was
the wrong measurement to stop at: it counted the anchors that were *found*, not
the anchors that were found **in the wrong place**.

The planner matched its anchor against the statement's raw SOURCE. `text` has
comments stripped and `head` has dollar-quoted bodies elided, but the source
still holds all of it — and a comment reading `-- add column for tracking`
matches an `ADD COLUMN` anchor exactly as the statement's own keywords do. So
does `DEFAULT 'create table zz'`. So does `DEFAULT $tag$add column$tag$`.

Four things followed, each found by driving the shipped planner over shapes the
prime's corpus does not contain and then applying both files to a real
PostgreSQL 16 and diffing the catalogue either side:

| written | became | harm |
| --- | --- | --- |
| `-- add column for tracking` | `-- add column IF NOT EXISTS for tracking` | the author's comment, rewritten in a pull request somebody merges |
| `DEFAULT 'add column b int'` | `DEFAULT 'add column IF NOT EXISTS b int'` | **a stored column default, silently changed** |
| `DEFAULT $tag$add column nope$tag$` | `…IF NOT EXISTS nope$tag$` | the same, through a dollar quote |
| `CREATE /* note */ TABLE t (n text DEFAULT 'create table zz')` | the guard went **inside the literal** | the plan read `healed` while the second run still failed `relation "t" already exists` |

The last row is the one that matters most, because it is the module's own
governing line broken in both directions at once: a quiet wrong answer, *and* a
re-runnability claimed that could not be delivered. Every gate said yes. The
patch was a pure insertion, the bytes accounted, the statement count held, and
`assessIdempotency` read the patched file as `rerunnable` — because the
`if not exists` it now found was the one inside the string.

There was a second, smaller harm in the same family. Where a comment came
*before* the statement it describes, the comment's lower-case match was the
first one, so `cased()` took its case from the comment and wrote
`ADD COLUMN if not exists a int` into an upper-case file — the diff noise §13
says the case-matching exists to prevent.

### The fix is at the one walk

`scanSqlStatements` has always known which stretches are SQL; it simply did not
say. It says now: every `SqlStatement` carries `codeSpans`, the parts of
`[start, end)` the state machine was in code for, recorded by the same single
pass that already strips comments and elides bodies. No second scanner, and
nothing that could drift from the reading.

The planner filters its anchor hits through `spansCode` and a hit outside them
is not an anchor. Where none survive the statement is refused `not_located` —
the refusal that already existed for a comment splitting the keywords, which is
the same fact one step along. It now collects **every** occurrence even for the
single-guard families, because the first occurrence in the bytes is not always
the statement's own keywords.

One hole in the first cut of that walk is worth recording, because it was
found by adversarial reading rather than by any of the sweeps. `closeCode`
pushed the run it had just ended but did not record that a run had ended, so a
literal, comment or body the file never CLOSES — a truncated file, or one cut
at the corpus ceiling — left the final close pushing a run from wherever code
last began straight through the unterminated text. On
`CREATE TABLE t (n text DEFAULT 'unterminated` the spans came out `[0,31]` and
`[0,44]`: overlapping, with the second calling the unterminated literal SQL.
An `inCode` flag closes it.

Two consequences worth stating. A dollar-quoted body is excluded by
construction, so the note on `ADD COLUMN` claiming an `ALTER` "carries no body a
`CREATE` could be hiding in" is no longer load-bearing — it was also wrong, since
an `ALTER` can carry a dollar-quoted `DEFAULT`. And the guard now takes its case
from the surviving SQL keyword, so a comment cannot decide how the file is
written.

**Measured over the prime's 1,002 migrations, before and after: every file's
outcome is unchanged** — 701 `nothing_to_do`, 255 `healed`, 31 `improved`, 15
`no_repair`, 0 `unproven`. This corrects shapes the corpus has not yet produced.
It is a latent defect closed, not a live one repaired, and the distinction is
the honest one: nothing the prime holds today would have been damaged.

### The same root, one module up

`createsObject`'s guard test read `/^create\s+(or\s+replace|.*\bif\s+not\s+exists)\b/`,
and `.*` walks into a literal for the same reason. A file containing
`CREATE TABLE t (n text DEFAULT 'create table if not exists z')` read
`rerunnable` — the one direction that matters, because `rerunnable` is the
reading that lets a file be dispatched again. It is `[^']*` now: no identifier
can be single-quoted and `IF NOT EXISTS` always precedes the name, so nothing
legitimate is lost. Measured across the prime's **11,110 statements: 0 change
either way**, in both the per-statement verdict and the whole-file reading.

### Three smaller things the same sweep found

- **`base_tree` was handed a commit sha.** GitHub documents it as a tree object,
  and every other writer here resolves the commit first
  (`cascadeConflictMerge.server.ts`). It is resolved now. This one could not be
  probed from the session that found it — no low-level git API is reachable —
  so it was fixed by matching the path this repository already proves works,
  rather than by assuming the service would resolve it.
- **A prepend wrote a bare `\n` into whatever the file used.** 0 of the prime's
  1,002 migrations are CRLF, so nothing is affected today; a repair that travels
  as a pull request should not be the thing that mixes line endings.
- **The kind set was read off the capped rows.** `repairs` stops at
  `REMEDY_ROWS`, and **65 of the prime's migrations plan more repairs than that**
  — so the commit message's list of shapes, and the pull request's warning that a
  re-added constraint revalidates the table, were both drawn from the first eight
  rows. A file whose only constraint repair sat at row nine would have carried
  that warning nowhere. `repairKinds` and `refusalKinds` are the whole file's,
  and the two places that claimed the unlisted repairs were "of the same shapes"
  stopped claiming it — the capped list cannot know.

### What the gates are now

`assertSoundPatch` gained the invariant that was missing: **every literal and
comment the author wrote still appears, in order, in the patched file.** It is a
subsequence rather than an equality because a prepended
`DROP POLICY IF EXISTS "name"` legitimately adds quoted identifiers, and it is
written in the test file from nothing the module exports. Because it sits in
the shared helper, every existing patch assertion gained it too.

Each of the seven fixes was planted back and fails a test: the code-span
filter, the guard bound, the `base_tree` resolution, the uncapped kind set, the
line ending, the walk's own transition at a line comment, and the flag that
stops an unterminated literal being read as code.
