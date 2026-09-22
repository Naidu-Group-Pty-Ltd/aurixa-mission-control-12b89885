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

One is a real dependency:
`20260921060000_market_updates_missing_indexes.sql` requires `market_updates`,
`market_ingestion_runs` and `market_source_fetch_runs`, which two holes create.
Refusing it is the barrier doing its job.

The other five are template-library seeds past the size ceiling. Their bodies
are never read, so their facts are absent, so they keep the blanket rule —
which is the three-state design working, not a gap in it.

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
