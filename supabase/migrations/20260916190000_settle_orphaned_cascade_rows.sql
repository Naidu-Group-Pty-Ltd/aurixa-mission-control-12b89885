-- @asserts none:data repair only — terminalises the orphaned-row backlog and closes historical worker windows; the resulting row counts are not stable claims

-- THE ACT THAT SETTLES AN EVENT SETTLES ITS ROWS — applied to the backlog.
--
-- A settled event's `queued`/`pushing` rows are invisible to every sweeper:
-- the reclaim rules read PENDING events, reconciliation reads `pr_opened`
-- rows, and the pointer derivation reads `succeeded` ones. Measured 16 Sep
-- 2026 during the battle-test audit: 124 such rows — 119 from the
-- August/September freeze (28 Aug – 2 Sep) and five minted as recently as
-- 14–15 Sep by the event-settling exits that never walked their rows. From
-- this change on, those exits terminalise their rows themselves
-- (`terminaliseOrphanedRows` in cascade-engine.server.ts); this settles the
-- rows they already left behind.
--
-- `skipped`, never `failed`: nothing failed IN the row — the carrier died
-- around it — and the message says so, so the register reads as a record
-- instead of a mystery. Idempotent: a second run matches nothing.
update public.cascade_results r
set status = 'skipped',
    error_message = 'Skipped: the carrier event settled without processing this row (terminalised 16 Sep 2026, pre-hardening backlog).',
    completed_at = now()
from public.cascade_events e
where e.id = r.cascade_event_id
  and e.status in ('completed', 'failed')
  and r.status in ('queued', 'pushing');

-- And the five pre-fence worker windows (31 Aug – 2 Sep): events settled as
-- `completed` with `worker_started_at` set, `worker_finished_at` and even
-- `completed_at` NULL — fossils from before the claim fence made window
-- discipline mandatory (every settle since 2 Sep closes its window; zero
-- half-open rows exist after that date). The recount guard reads the open
-- window as "still being executed" and refuses to derive over these events
-- for ever. The row's own `updated_at` is the last write it ever took — the
-- settle itself — so it is the honest witness for both stamps: a repair from
-- the record, not an invented timestamp.
update public.cascade_events
set worker_finished_at = updated_at,
    completed_at = coalesce(completed_at, updated_at)
where status in ('completed', 'failed')
  and worker_started_at is not null
  and worker_finished_at is null;
