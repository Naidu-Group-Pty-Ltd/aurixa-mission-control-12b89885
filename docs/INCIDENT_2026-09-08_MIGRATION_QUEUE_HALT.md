# The migration queue was halted for 41 hours and nothing said so

**8 September 2026, 04:38 UTC → 9 September 2026, 09:00 UTC.**
Mission Control's database applied no migration for 41 hours. Eight migrations
accumulated behind one failed row, across three pull requests, while every
signal an operator would look at stayed green.

Read this before touching `public.schema_migration_queue`, before retrying a
failed queue row, and before assuming a migration that merged is a migration
that ran. `MIGRATION_QUEUE.md` carries the design; this carries what happened to
it.

## What broke

`aurixa.drain_schema_migrations()` applies each migration with `EXECUTE` inside
a PL/pgSQL function. A migration that opens its own transaction therefore raises

```
0A000  EXECUTE of transaction commands is not implemented
```

`20260908040000_brokered_usage_is_billable` wraps itself in `BEGIN; … COMMIT;`.
It failed at 04:38 on 8 September. **A failed migration halts the queue** —
migrations are ordered, and applying N+1 over a failed N is how a schema
silently diverges — so everything merged afterwards stopped applying.

Six files carried the same defect: the three from the brokered-billing set
(`20260908040000`, `040100`, `040300`) and the three from the absorbed-cost set
(`20260908110000`, `110100`, `110200`).

## Timeline

| run | when (UTC) | outcome |
| --- | --- | --- |
| 34 | 7 Sep 15:33 | success — the last migration to apply |
| 35 | 8 Sep 04:38 | `0A000`; 1 failed, 2 left pending |
| 36 | 8 Sep 06:03 | 3 pending, never applied |
| 37 | 9 Sep 00:25 | 2 pending, never applied |
| 38 | 9 Sep 01:09 | pending |
| 39 | 9 Sep 07:29 | pending |
| 40 | 9 Sep 09:00 | **success** — first clean run in 41 hours |

## Why nothing reported it

Four independent silences, and each one on its own was enough.

**The verdict is scoped to the caller's own versions.** `enqueue-migrations.mjs`
polls `action: "status"` for the versions IT submitted, so every later run
reported truthfully that its own files were "still queued" and never once named
the failed row holding the line. Three merges in a row said the same
uninformative true thing.

**`/api/health` is green either way.** It checks database reachability, secrets
and credential encryption. A database that has stopped accepting schema changes
is reachable, and answers in milliseconds.

**The failing signal was a workflow nobody is required to read.** The
`Apply migrations on merge` run went red on each of runs 35–39. Nothing
escalated, and a red check on a merged pull request is easy to walk past.

**Code shipped without its schema.** The 8 September work reached production
through Lovable's own publish while its migrations sat queued. The feature
appeared to work — which is what made the gap invisible rather than loud.

## The repair, and the two hazards it avoided

By the time the queue was unjammed, **the database was ahead of the queue in
places and behind it in others**, because the 8 September work had been applied
directly to the database when it was authored *and* committed as migration
files, which the queue then tried to replay.

Evidence that settled it — structural fingerprints, not the ledger:

- the live `billing_reason` constraint was the **9-value** form including
  `absorbed`, which only `20260908110000` introduces
- `public.api_provider_rate_features` existed (`20260908040100`)
- `public.api_provider_rates.absorbed` existed (`20260908110000`)
- `record_api_usage_event` already referenced `absorbed` (`20260908110100`)

**None of the six was executed.** Replaying them would have moved the database
backwards, and two of them were actively dangerous:

**`20260908040000` would have regressed the constraint.** It narrows
`billing_reason` to eight values, dropping `absorbed` — which the live schema
already had and three live rows already used. That is the error the replay
surfaced, and it was the symptom rather than the disease.

**`20260908040300` would have double-billed and un-absorbed.** Two reasons,
either sufficient:

1. its rollup update is `billable_quantity = billable_quantity + SUM(quantity)`
   — an **absolute**, not a delta (only the money columns use `new - old`), so
   re-running it would have added the whole brokered count a second time;
2. its predicate is `call_status = 'success' AND clone_id IS NOT NULL AND
   (status = 'withheld' OR metadata->'brokered' = 'true')`, which **matches the
   three `absorbed` rows** — it predates the `absorbed` concept, and would have
   flipped them to `brokered`/`billable`, charging for calls the business had
   decided to absorb.

So the six were marked applied **without executing**, their SQL backed up first,
and only `20260908160000` and `20260908170000` were allowed to run.

## Why `20260909072756` says DO NOT REPLAY

That migration is one-time repair scaffolding. It backs up six queued rows,
strips their transaction wrappers, and **resets those six rows to `queued`**.

Running it again would undo the decision above and replay `20260908040300`,
with both consequences in the previous section. Its own guard is what stopped it
the first time: the insert is not idempotent, a retry doubled the backup table
to twelve rows, and its count assertion refused. The row was **deleted** from
the queue rather than retried; the file remains only as the record of the
repair, carrying that warning in its header.

## Rules this produced

**A migration must never open its own transaction.** The drain already runs each
one in a transaction; a migration that opens one is asking for something it
already has. `NON_TRANSACTIONAL` in `migrationQueue.pure.ts` now refuses
`BEGIN;`, `COMMIT;`, `ROLLBACK;`, `START TRANSACTION` and `SAVEPOINT`.

**The semicolon is load-bearing.** PL/pgSQL opens a block with a bare `BEGIN`
and closes it with `END;`, and `stripSqlComments` deliberately does not
understand dollar-quoting — so a rule matching a bare `BEGIN` would refuse every
function body in the repository, including the queue's own bootstrap migration.
Matching `BEGIN;` / `COMMIT;` flags exactly the six offenders across all 258
files and no function bodies. `migrationQueueCorpus.test.ts` pins both
directions.

**A ratchet, not a ban.** A version already on the queue is history — `enqueue`
refuses to overwrite the SQL of a version it holds. The six are frozen by name:
the list may only shrink, a seventh fails the build, and a name that stops
offending fails too, because that means somebody edited a queued migration,
which cannot have reached the database.

**A guard that never runs is not a guard.** The corpus test was first written as
`.spec.ts`; this project's vitest include is `src/**/*.test.ts`, so it would have
passed for ever by never executing. Same class of silence as the outage itself.

**A read that FAILED is not a set that is EMPTY.** During diagnosis,
`supabase_migrations.schema_migrations` returned `[]` for all six versions — not
because none had applied, but because the role is denied that schema. Treating
that as evidence would have inverted the entire diagnosis. The structural
fingerprints were the real evidence, and they said the opposite.

**A migration merged is not a migration applied.** The gap between the two is
where this incident lived.

## Verification

- migration lane green (run 40), `main` CI green
- queue fully applied: nothing failed, nothing pending
- `clones.merge_drain_at` and `clone_backends.migration_blocked_at` present with
  both indexes; `merge_drain_at` observed advancing 09:10:02 → 09:15:02 across
  all three clones, which is the proof the published build is the new code —
  nothing else writes that column
- the two stranded clones back in the fleet migration sync, all three level at
  migration version `20261111010000`
- **billing untouched and independently checked**: billable quantity equals the
  brokered event count (724 = 724, 724 × 50 = 36,200 micros), the three
  `absorbed` rows are still non-billable, and the 9-value constraint stands. The
  double-count that was avoided would have read ≈1,448.

## Still open

1. **`resolve_api_key_billability` is still the August version.**
   `20260908040000`'s rewrite of it never applied and was deliberately not
   force-applied — metering is demonstrably working, and a live billing path is
   not something to change on a hunch at the end of a repair. It needs a fresh,
   reviewed migration.
2. **A migration applied directly by Lovable *and* committed as a file gets
   replayed by the queue, and a replay can regress live schema.** That is the
   root cause here, and nothing detects it.
3. **A migration can enter the queue having never existed in the repository.**
   Three did during this repair. The enqueue guard catches bad SQL at merge
   time; it cannot see a migration that never passed through a merge.
4. **The provisioning verdict on the recovered clones is stale.** NPC Test and
   Preflight Property Group still read `status: failed` with
   `status_detail: 'Provisioning ceiling exceeded'`. Nothing gates on it any
   more — that was the fix — but an operator reading the clone page sees a
   healthy clone reporting failure, which is the same class of misleading
   signal that cost the two days above.
