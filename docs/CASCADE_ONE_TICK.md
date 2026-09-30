# A pass that keeps nothing between ticks has to fit inside one

Read this before changing `primeTextBatch.pure.ts`, `readBlobTextsBatched`,
`primeVersionBatch.pure.ts`, the history walk in `cascadeDeletions.server.ts`,
or the kept-spec channel's reads in `processClone`.

## What production showed

On 26 Sep 2026 the cascade to `npc-crm-independent-6505dc` could not finish
a pass. Its result row's progress read `prepared: {}` against a total of 390
files (prime@c19ab0a) and then 399 (prime@0e89502): not one file prepared,
on any tick. Two events failed at the attempt ceiling with *"No clone
completed inside the invocation budget in 3 attempts … One clone's pass is
larger than one tick"*.

The damage was not confined to that clone. The drain works a fleet event's
clones in one loop, and when an event dies at the ceiling every clone still
queued behind it is skipped. The drain works parents before children, and
both of those clones are children of NPC Client Dashboard, so they always sat
behind the independent. **NPC Test and Preflight Property Group last received
a cascade from the 19:29 UTC event on 25 Sep.** Each of the four carrier events
after it skipped both of them as *"failed at the attempt ceiling — one clone's
pass is larger than one tick"*. Two more events were folded into a carrier,
which is ordinary.

`invocation_cut` is supposed to heal itself: a pass that stops at the budget
keeps what it prepared, and the next tick resumes. That is true only for work
that is KEPT, and the pass ledger keeps prepared blobs. A text file travels
inline in the tree write and is never ledgered. A module-scoped clone's
delivery is almost all source text, so every tick started from nothing, read
the same files again and stopped in the same place.

## Where the time went

Measured by replaying that pass offline, through the real engine, against the
real prime and clone trees. The clock charges 400 ms for each REST call, and
1.5 s plus 1 s per MB for each GraphQL call. It allows six connections at
once, because a Worker holds no more, and a 40-second budget, five seconds
tighter than the drain's 45.

| | before | after |
|---|---:|---:|
| per-file contents reads | 486 | 24 |
| GraphQL requests | 0 | 18 |
| files prepared inside the budget | **0 of 399** (paused) | **409 of 409** |
| outcome | paused, nothing kept | pull request opened at 40.7 s |

Before, the import closure read each candidate module one contents call at a
time just to learn what it imports. The prepare loop then read the same files
again to write them. The budget ran out before the loop prepared its first
file.

## What changed

1. **Prime's text is read by blob id, a batch at a time, once per pass**
   (`primeTextBatch.pure.ts`). The closure and the prepare step share one
   reading. A text is kept only where its git blob id equals the id prime's
   tree listing holds for the path, so a file GraphQL altered (Latin-1 comes
   back as UTF-8) is read the old way. Only regular files are asked. A link
   takes the old road, because the contents API answers it with the file it
   names. Five batches run at once: nothing else in the pass is in flight
   while a prefetch runs.
2. **The history walks are read in one request** (`primeVersionBatch.pure.ts`).
   A walk used to read one revision per contents call, in series, so a clone
   whose copy matched nothing recent paid ten round trips for one path.
   `listCommits` still decides the walk, and the walk still stops at the first
   version the clone holds. Only a regular file's id is taken, and only a
   clean response may say "nothing here". A revision the request did not
   answer exactly is read per contents call, where a rate limit is thrown as
   it always was.
3. **The kept-spec channel reads both sides of a hop at once.** The clone's
   side skips every blob prime's side is asking, so a shared blob is still
   read once. This is the same dedupe as when the sides took turns.

**The delivery is the same.** Replayed with no latency and no budget, the new
engine writes the same 409 entries, byte for byte, as the unhurried run
before the change, and reports the same holds, notes and counts.

## How much room is left

At the rates above, the last file is prepared at about 35 s. The rest is the
tree write, which the budget does not gate.

The replay was repeated with GitHub about a quarter slower: REST at 500 ms,
GraphQL at 2 s plus 1.5 s per MB. Against the drain's real 45 seconds, 406 of
the 409 files cross. The subject carry is cut at the budget, the three it did
not reach are held and named, and the next pass carries them.

The drain refunds an attempt to any tick that lands at least one clone. So a
fleet event now drains over successive ticks: the independent completes on a
tick it starts, and the clones behind it follow.

## What it does not change

- **No rule.** Every file meets the same exclusions, holds, membranes and
  ceilings. The batches change how bytes are fetched, never which bytes are
  delivered or why.
- **The floor is yesterday's behaviour.** A batch that fails, or answers
  something it cannot prove, sends those files down the per-file road.
- **One clone that cannot fit still blocks the clones queued behind it.** This
  change makes the independent's pass fit. It does not change what the drain
  does when a pass never fits.

## The blob ceiling, measured on the way

The same investigation found that GitHub's create-blob endpoint refuses from
about 42 MB, not at the documented 100 MB. So three template-library seeds
were streamed on every pass into certain refusals. See
[`CASCADE_LARGE_FILES.md`](./CASCADE_LARGE_FILES.md#the-ceiling-that-is-left).
