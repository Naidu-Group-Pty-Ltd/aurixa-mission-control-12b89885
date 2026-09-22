# The barrier a hole raises

`partitionByDependency` decides what a clone is sent. Until now it raised a
**blanket** barrier: the first corpus version the clone had not run orphaned
*every* runnable migration after it, whatever the two had to do with each
other.

That is the right default and a catastrophic everyday rule. Measured 22 Sep
2026 against the live fleet — prime ledger 1,032 versions, corpus 1,022 files
at `22015eb4`, the CRM clone's own 1,573 — the clone's **first hole is at
corpus ordinal 1**, `20250124120000_fix_client_data_rls_policies.sql`. So it
sent nothing, and had sent nothing since it was provisioned, while looking
from every reading like a clone with a large held-back backlog.

| | send | orphaned |
|---|---:|---:|
| blanket (before) | **0** | 38 |
| per-dependency (after) | **32** | 6 |

## What changed

`migrationDependencyFacts.pure.ts` reads, from a migration's own SQL, what it
**creates** and what it **requires**. A hole orphans a candidate only where the
candidate requires something that hole creates. It is a port of the prime's
`scripts/lib/migrationDependencyOrder.mjs`, which has computed that graph for
the prime's own ordering since it was written.

Three refusals in that module are load-bearing, and each was paid for on the
prime:

- **A PL/pgSQL body is not a reference.** Comments, string literals and
  dollar-quoted bodies are blanked *before* extraction, length-preserved, in
  one left-to-right scan.
- **`if exists` is not a requirement.** `drop … if exists` names an object it
  is prepared not to find. Counting those produced 88 wrong findings on the
  prime.
- **A foreign schema is evidence of nothing.** `auth`, `storage`, `pg_catalog`
  and thirteen others are not this corpus's to create.

## Absent, empty, non-empty — three different facts

`creates` and `requires` are optional, and their three states are the three
`bodyDigests` already had:

- **absent** — nobody read the body. The barrier falls back to blanket for that
  migration. This is the safe direction and it is not hypothetical: 18 corpus
  files are past `MAX_DIGEST_BYTES` and are never fetched, so they keep the
  blanket rule for ever.
- **empty** — read, and it names nothing. Nothing can be waiting for it.
- **non-empty** — read and answered.

**An unread body must leave the facts absent, never empty.** A file that
creates ten tables, declared to create none, would be certified unable to block
anything.

## Why the read is wider than the digest set

A candidate's `requires` lives in a file the **version test already cleared**.
`openScopedPrimeCorpus` therefore reads every corpus path, while attaching a
digest only where the version did not clear it — widening the read must not
widen what is digested, because a version-matched file never reaches
`scopeCorpusToPrime`'s digest branch but *does* reach `claimants`, and
attaching one there would change an operator-visible `sharedWith` on the
strength of an unrelated widening.

The read costs nothing extra per tick: the cache is keyed on the prime's
commit, and the 1,004 files under the ceiling come to 4.09 MB in total.

## The six that are still orphaned, and why that is right

Five are template-library seeds past the size ceiling. Their bodies are never
read, so their facts are absent, so they keep the blanket rule — which is the
three-state design working, not a gap in it.

The sixth is `20260921060000_market_updates_missing_indexes.sql`, and a
correction belongs here rather than a claim. It requires `market_updates`,
`market_ingestion_runs` and `market_source_fetch_runs`, and two holes create
them — so the barrier refuses it, which is the rule working as written. But
the rule is a **proxy**: it asks what the missing migrations CREATE, not what
the clone HOLDS. Queried on the CRM clone after the narrow landed, all three
tables already exist there — the provisioning copy brought the schema across.
So this refusal is **conservative rather than necessary**, and it costs one
migration.

It is deliberately not fixed here. Asking the clone's own catalogue is a
different question from reading the prime's corpus, it is a per-clone round
trip on a pass that already pays for a 1,004-blob body read, and the
conservative side of this particular error is a migration that waits rather
than one that runs against a schema that cannot carry it. Named so the next
person does not have to re-derive it.

## Measured in production, 22 Sep 2026

The harness predicted 32 send / 6 orphaned on the CRM clone
(`qvuwrvwzjyigptmnijyb`). What the deployed lane then wrote to
`clone_backends.status_detail`, unprompted:

| | before | after |
|---|---|---|
| held back | **38**, behind `20250124120000` | **6**, behind `20260703000000` |
| clone ledger | 1,573 versions | 1,575 and climbing |

The hole it names moved forward by twenty months, which is the narrow's whole
point: the barrier now stops at the first hole a candidate actually needs
rather than the first hole in the corpus.

Two things the first live passes taught, and a correction to the first draft
of this section.

**The scheduled pass was never being HEARD, and that predates this change.**
The first version of this paragraph blamed the cold body read for putting the
pass past pg_net's `timeout_milliseconds := 60000`. That was a guess dressed
as a cause, and `net._http_response` refutes it: over the six hours the table
retains, EVERY half-hourly sweep — 08:00, 08:30, 09:00, 09:30, 10:00, 10:30,
13:00, 13:30 — returned `status_code NULL` with `Timeout of 60000 ms reached`.
The narrow merged at **10:39**. Six of those eight fires are older than the
change. The only 200s in the window are hand-fired passes.

What is lost is the RESPONSE, not the request: the pass really runs, claims a
backend and applies a migration, and is then torn down before it can write its
verdict or release its claim. So `status_detail` goes stale (the CRM clone
read "38 held back" for hours after the pass that would have written "6" had
already run), `worker_started_at` strands until `reclaimStale` frees it, and a
clone advances one migration per fire instead of as many as its budget allows.
`20260922140000_fleet_sync_http_patience.sql` raises both fleet jobs to
150,000 ms — patience, not a bigger budget; the pass still stops itself at
`FLEET_PASS_BUDGET_MS`.

It is **`SCREENING_EXECUTION.md`'s rule from the other side**: a green cron run
is not a delivered request. `cron.job_run_details` said `succeeded` on every
one of those fires, because what pg_cron reports on is the SQL that queued the
call. The honest signal was `net._http_response.status_code`, and it was NULL.

**The lane takes clones in physical order with no `ORDER BY`**, so one clone
with a backlog can spend the whole 45 s budget several passes running while
another waits. Correct-but-slow; named here because it is what made the CRM
clone look untouched for four passes after the narrow was already live.

**Throughput is the open question, and it is not answered here.** With the
patience fix in, the 14:00 sweep was heard (HTTP 200), wrote a fresh verdict
and released its claim — and still reported `stoppedAtBudget: true` after
applying ONE migration to the CRM clone. Another clone applied six in a single
pass, so the budget is not simply being eaten by setup, and the difference is
not yet measured. At one per half-hourly pass the remaining 28 converge
overnight, so this is slow rather than stuck. What it needs is a measurement
of where the 45 s actually goes on that clone — not another guess, which is
what the paragraph above this one had to be withdrawn for.

## What is asserted

- `migrationDependencyFacts.pure.test.ts` — the extractor, including each of
  the three refusals above and the stateless-regex property.
- `fleetCorpusScope.pure.test.ts` — the narrow, and that a corpus with no facts
  partitions byte-identically to the blanket rule.
- `dependencyFactsReachThePartition.contract.test.ts` — a **source scan**, not a
  list of today's call sites, because a hand-list cannot see the call it does
  not mention. It refuses any production call that partitions on, or scopes a
  replay with, the raw `corpus.metas`; and it pins that the read is wide while
  the digest attachment is narrow. Both halves were proved by planting the
  defect and watching the scan fail.
- `sqlMigrationLane.contract.test.ts` pinned the literal string
  `{ corpus: corpus.metas, runnableIds }`, which asserted a spelling rather
  than a property — and the wrong spelling. It now asserts that the array the
  replay refuses on is the **same identifier** the partition cleared on: if the
  two disagree, the replay refuses to send what the lane just counted as
  pending.
