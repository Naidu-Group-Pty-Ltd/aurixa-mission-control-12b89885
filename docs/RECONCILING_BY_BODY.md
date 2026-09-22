# 82% of the prime's migrations were withheld from every clone, and the evidence that they had run was in the ledger the whole time

Measured on the prime (`dduzbchuswwbefdunfct`) on 22 September 2026:

```
1,002  migration files on npc-property-dashbord@main
1,012  rows in supabase_migrations.schema_migrations
  180  versions the two have in common          <- what a clone could be sent
```

Eighteen per cent. `scopeCorpusToPrime` decides what a clone may run by exact
membership of the prime's ledger — the right rule, keyed on the wrong thing —
and `partitionByDependency` then treats every withheld version as a barrier, so
one hole orphans every runnable migration behind it. **The first corpus file
was a hole**, so a clone starting from nothing could be sent nothing at all.

`MIGRATION_PIPELINE.md` named this in 2026-08 and left it: *"two different
namespaces describing the same history"*, and *"the 67 … are not reconciled,
and deliberately so"*. Reconciling by TIMESTAMP was the thing to refuse, and it
was refused correctly. This is the other reconciliation.

## The ledger stores the SQL it ran

`supabase_migrations.schema_migrations.statements` is a `text[]`. On this prime
every one of the 906 rows that has a body holds exactly ONE element — the whole
file as the CLI sent it. So the ledger is not merely an index of versions; it is
a record of bytes, and nothing had ever read it.

The pair that proves it. The repo holds
`20250831091525_eafc9d31-…-c82e64771733.sql`; the ledger holds `20250831091523`.
Two seconds apart, which is enough for a version match to fail. The bodies are
**byte-identical**, 151 bytes, `md5 d6725d25bb2616357d9d65f8ccbc0145` on both
sides — Postgres's and Node's.

## The rule

> **A migration has been applied when the prime's ledger holds a body whose
> EXECUTABLE bytes are exactly its own.** Bytes that cannot execute — trailing
> whitespace, a leading comment block — may differ, and nothing else may.

`migrationBodyIdentity.pure.ts` is the one home of it: the normalisation ladder,
the single SQL expression the ledger side is digested by, and the test for
whether a version is a real instant at all.

| | before | after |
| --- | ---: | ---: |
| runnable | 180 | **785** |
| cleared by version | 180 | 180 |
| cleared by body | — | 605 |
| withheld | 822 | 217 |

Of the 605: **539 byte-identical**, 51 differing only in trailing whitespace,
15 only in a leading comment.

## Why this is stronger than the version test, not weaker

The old module's own header raised the objection: a rule elastic enough to
bridge a three-second skew is elastic enough to bridge onto
`20250124120001_rollback_client_data_rls_policies.sql`, whose stated purpose is
to undo an RLS fix and which reached a tenant once already.

That is exactly right about TIMESTAMPS and does not touch bodies. A body can
only clear a migration whose SQL the prime's ledger holds, which is the same
sentence as "the prime ran it". The test cannot bridge anywhere; it can only
confirm. Verified by execution over the real corpus: both rollback scripts are
still withheld, and **0 of the 605 clearances rest on bytes the ledger does not
hold**.

It is also stronger than the version test, which this corpus can fool:
`MIGRATION_VERSION_COLLISIONS.json` records 32 groups covering 77 files that
share a version string. Digests are therefore keyed by repo PATH, never by
migration id.

## Over-normalising cannot promote anything, by construction

Five `refresh_active_masters_from_library_vN` files differ only in a header
comment, and the third rung of the ladder collapses them. That is safe, and not
by luck: every rung removes only bytes that do not execute, so two bodies that
collide anywhere on the ladder have identical executable bytes — provably, for
all inputs. The proof is four lines and it is in the module header; a test walks
every pair of a fixture set and asserts it, and a second test asserts the
fixture actually produces collisions so the first is not vacuous.

Measured on the real corpus: **11 collision groups, 0 with differing executable
bytes.** So "which of these files did the prime run" is a question with no
consequence — and the answer is still recorded (`sharedWith`) rather than
asserted, because the ledger genuinely cannot say.

## The rung a match reports is the rung that produced it

Found while transcribing this rule into the prime's own guard, by writing the
test first: `migrationBodyForms` **deduped**, so the index of a match was an
index into a shorter list rather than a rung.

A body carrying a leading comment and no trailing whitespace has rung 1 equal
to rung 0. Deduped, rung 1 disappears — and a leading-comment match then lands
at index 1, which `bodyFormLabel` reads as *"identical but for trailing
whitespace"* about a file whose whitespace is identical.

Measured on the prime the day it was found: **0 files affected**, because every
leading-comment match in that corpus happens also to carry trailing whitespace.
Nothing on `/prime` was ever wrong. It was right by coincidence, which is the
shape this repository has had to repair twice already, so the coincidence is
removed rather than relied on: identical rungs are kept, `index === rung` for
every input, and the cost is at most two extra sha256 over a body already in
memory.

Dropping an EMPTY rung is still safe and stays, because an empty rung can only
ever be followed by empty ones — rung 1 empty means the whole body is
whitespace, and then rung 2 is empty too. The drop removes a suffix; it never
moves a surviving index.

Rung 2's label changed with it. It is `executableBody`, which discounts a
leading comment block **and** trailing whitespace, so it is named for what it
asserts — *identical in what executes* — rather than for one of the two things
it ignores.

## The prime carries the same rule, and a guard built on it

`npm run check:applied-body-digests` in `npc-property-dashbord` records, for
each migration file, a sha256 the prime's ledger holds and which that file
produced — **690 of 1,002 files**, against 83 a version key could reach — and
fails when one of them changes. That is the other half of this work: Mission
Control decides what a clone may be sent by these bytes, so editing an applied
migration silently withholds it from the whole fleet, and everything the
dependency order puts behind it.

The rule is transcribed there rather than imported, because that check runs on
every pull request with no network and no dependency on this repository. Two
copies of one rule is how the two come to disagree, so the properties the rule
turns on are pinned on both sides — here in `migrationBodyIdentity.pure.test.ts`
and there in `src/lib/deploy/__tests__/appliedBodyDigests.spec.ts`. If they ever
drift, the symptom is that this page's reading of the fleet and that manifest
describe different corpora.

## A read that failed is not a body that did not match

Three withheld reasons now, not two:

- `never_applied` — the ledger holds neither this version nor these bytes.
- `skew_suspected` — the bodies disagree AND a machine-stamped ledger row sits
  within ten seconds. The residue, and weaker evidence than it used to be.
- `body_unread` — the body was past the digest ceiling or GitHub would not serve
  it, so the comparison never ran.

The third exists because folding it into the first would send an operator to
dispatch files that may already be on the prime.

## The skew window is a TIME test and now only speaks about times

The corpus is written by two generators:

- **machine-stamped** `<YYYYMMDDHHMMSS>_<uuid>.sql` — Lovable's, 626 files. The
  version is the moment.
- **hand-named** `<digits>_<words>.sql` — 376 files. The digits order the file.
  This corpus holds `…096000`, `…097000` and `…098000` — minute 96 of an hour —
  and thirty files whose whole time component is `000000`.

Measured: of the hand-named files the prime HAS run, **every one** sat outside
the ten-second window. `never_applied` there was the right answer for no reason
at all, and `skew_suspected` would have been a confident statement derived from
a number that is not a time. The test is now asked only of machine-stamped
versions, and only after the body test has said no.

The window stays at ten seconds rather than widening. The distribution justifies
widening it — 524 of 617 machine-stamped bodies were stamped inside it, 86
between 11 and 60 seconds, 7 about twelve hours out — and every one of those 617
is now cleared by its body instead, which is not a guess at all. What is left is
a diagnostic sentence beside a withheld file, and a 120-second window over a
corpus where 300 files were authored in one afternoon would attach a "nearest
prime version" to almost everything and inform nobody.

## What it costs

The corpus is 536 MB and that is not the cost: 531 MB of it is 14 generations of
`seed_template_library`, and all 16 files over 256 KB are already cleared by
their version. **986 files are under the ceiling and come to 4.17 MB**, read
eighty blobs to a GraphQL query — about ten requests — and cached against the
prime's commit, which has no staleness to manage because a commit's bytes do not
change. A tick that finds the cache warm costs nothing. Measured against the
real corpus, `body_unread` is **0**.

Every failure falls the same way: a body that cannot be read produces no digest,
no digest withholds, and a GitHub outage degrades the fleet sync to exactly the
behaviour it had before bodies were read — the version match alone.

## What this does not fix

The 217 still withheld, **208 of them hand-named**. Those are the real backlog,
and an earlier audit established what they are: the prime's ledger does not
record them, and the objects they create mostly exist anyway — 38 of 38 tables
and 31 of 31 functions sampled from the "never applied" set were already present.
They were applied by hand and never stamped. Reconciling them needs the
catalogue, not the ledger, which is Fleet Manager → Prime Ledger Reconciliation.

This also changes nothing for a clone that was stamped with the whole repo at
provisioning: `plisdzywzleljorrphxv` holds both `20250831091523` and
`…091525`. What it changes is the reading, which was under-reporting the prime's
own position by 605 migrations, and the barrier, which a genuinely-behind clone
now meets 217 times instead of 822.

## What the fleet actually carries, measured after the change

Measured 22 Sep 2026 against the live prime (`dduzbchuswwbefdunfct`, 1,019
ledger rows, 906 with a body, 904 distinct) and the prime repository at
`05808a3d` (1,021 files), by driving `scopeCorpusToPrime` itself rather than
re-deriving its arithmetic:

| | runnable | withheld | never applied | skew suspected | body unread |
| --- | --- | --- | --- | --- | --- |
| version key alone | **192** | 829 | 382 | 447 | 0 |
| body key as well | **798** | 223 | 220 | **3** | 0 |

606 files are cleared by body — 539 byte-identical, 52 identical but for
trailing whitespace, 15 identical in what executes. Nine share a digest with
another corpus file and are reported rather than acted on.

The second column is the one worth reading twice. **The skew window went from
deciding 447 files to deciding three**, which is the whole of §"Why the window
stays at ten seconds": it is a diagnostic sentence now, not a load-bearing
guess.

### The barrier is nine files, and they are the same nine everywhere

`partitionByDependency` run over the same corpus against each clone's own
ledger, same day:

| clone | already there | holes | would send | orphaned |
| --- | --- | --- | --- | --- |
| `plisdzywzleljorrphxv` | 986 | 17 | 0 | 18 |
| `umrtusxohxjxzodxorim` | 986 | 17 | 0 | 18 |
| `egrmsulhtmqnmhvuccxr` | 986 | 17 | 0 | 18 |

Identical, to the row. Of the seventeen holes, seven are migrations added to
the repository the same morning and one is `TEMPLATE_RLS_POLICY.sql`, which is
not a migration and sits last, so it withholds nothing. The other **nine are
migrations the prime has never run**, and they sit at corpus position 542 —
early enough that every runnable file after them is orphaned, which is why
`would send` is zero on all three.

Flipping exactly those nine to runnable, and changing nothing else, moves every
clone to **19 sent, 8 holes, 8 orphaned** — the eight being that morning's work
and the sentinel. So the nine are the barrier this programme can lift; the
remainder is ordinary in-flight churn that clears itself as the prime applies
it.

### The fourth deployment cannot be reconciled by either key

`qvuwrvwzjyigptmnijyb` (CRM) answers 166 already there, 216 holes, 620
orphaned, first hole at corpus position **1** — a different condition, and
older than this work. Its ledger holds 980 rows of which **980 have no
statements at all**, so the body key has nothing to read; and its versions are
not the repository's. Sampling 118 parseable corpus versions across the whole
corpus and asking that ledger how close it comes:

| exact version | within 60s | within 12h ± 60s | neither |
| --- | --- | --- | --- |
| 19 | **91** | 2 | 25 |

Ninety-one of 118 are present under a stamp a few seconds off the repository's,
which is the same apply-time stamping §"Why a version is not the identity"
describes, at a scale that makes version matching useless rather than merely
imperfect. **It is not a clone missing 836 migrations.** Nothing here should be
widened to accommodate it: a 60-second window is a guess, and a guess that
clears 91 files is worse than one that clears three. The remedy is to re-stamp
that ledger from the bodies it does not have, which is an operator act on that
project, not a matching rule.

### The nine were applied, and the prediction held

Dispatched through the prime's own `apply-migration.yml` on 22 Sep 2026, all
nine in one run, in corpus order. The run succeeded, and every one was then
confirmed **by effect rather than by the workflow's report**: the loose
`resolve_report_template` grants went 3 → 0 with `service_role` retained, the
all-full finance permissions row went 1 → 0, `render_jobs_select_auth` was
replaced by `render_jobs_select_self`, `template_finalize_v2` now preserves
`v_created_by`, `template_components.created_by` carries a default, the
reminder cron carries `x-cron-secret`, and the builder-invoice column and its
partial index exist.

Re-measured immediately afterwards against each clone's own ledger:

| clone | already there | holes | would send | orphaned |
| --- | --- | --- | --- | --- |
| `plisdzywzleljorrphxv` | 986 | 7 | **19** | 9 |
| `umrtusxohxjxzodxorim` | 986 | 7 | **19** | 9 |
| `egrmsulhtmqnmhvuccxr` | 986 | 7 | **19** | 9 |

**Zero files sendable became nineteen**, on all three, to the row. The seven
remaining holes are the five `urban_centre` migrations and one `approvals` one
added to the repository that morning, plus the non-migration sentinel — the
team applied the seventh while this was running, which is what ordinary churn
draining looks like. No security migration remains among them.

One correction worth keeping: the first effect probe reported the builder
invoice column absent, and the probe was wrong, not the migration. The column
is `builder_invoice_current_payment_id`; the probe asked for `current_payment`.
A probe that names the wrong column answers exactly like a migration that did
not run, which is `check-edge-column-names.mjs`'s lesson arriving from the
other direction.
