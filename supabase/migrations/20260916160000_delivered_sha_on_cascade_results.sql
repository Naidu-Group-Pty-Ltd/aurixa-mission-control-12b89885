-- @asserts column:cascade_results.delivered_sha

-- THE POINTER RECORDS WHAT A PASS DELIVERED, NEVER WHAT CREATED THE EVENT.
--
-- `clones.last_synced_sha` is a PRIME revision: `runDriftRefresh` measures
-- commits-behind FROM it, in the prime repository. The merge drain advanced
-- it from `cascade_events.source_sha` — which, since the fold made
-- provenance permanent (16 Sep 2026, 10:24), is the push that CREATED the
-- carrier event, not the head its pass resolved and shipped. The two agree
-- only when nothing folded between the push and the run.
--
-- Measured 16 Sep 2026, 15:15: npc-test-76b3b3 merged a cascade whose tree
-- was prime@7674f46's, was stamped with the carrier's provenance fa292ce7 —
-- 84 commits earlier — and the next drift scan read "Critical Sync: 84
-- commits behind Prime" on a clone whose content matched prime's head byte
-- for byte outside its designed exclusions. The two clones that synced
-- through a same-day manual event read correctly, because that event's
-- provenance HAPPENED to equal the delivered head; the one that synced
-- through the folded carrier did not. A reading that depends on how the
-- event came to exist is not a reading of the clone.
--
-- The engine resolves prime's head once per pass (`sourceSha`) and every
-- terminal verdict it writes is a claim about THAT revision. This column
-- carries it on the result row, so the consumer that advances the pointer
-- after a drain merge (`advanceClone`) reads the delivery — the engine's
-- own direct-success path already stamped the resolved head — and the
-- event's provenance stays what the fold requires it to be: permanent, and
-- never confused with what shipped.
--
-- Legacy rows stay NULL and the drain falls back to provenance for them:
-- an understatement inside a folded window, never an overstatement, and it
-- self-corrects on the first pass that writes the column.
alter table public.cascade_results
  add column if not exists delivered_sha text;

comment on column public.cascade_results.delivered_sha is
  'The prime head this pass resolved and delivered, or verified already present. NULL on rows written before 16 Sep 2026. The clone sync pointer advances from this, never from cascade_events.source_sha (event provenance).';
