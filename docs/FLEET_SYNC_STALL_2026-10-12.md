# Fleet sync stall, 11–12 Oct 2026, and handoff

Both lines fell behind prime. The client-dashboard line is the parent `npc-client-dashboard` and its children Preflight and NPC Test. The CRM-independent line is `npc-crm-independent-6505dc`. This document records the cause, the Mission Control fix on branch `claude/cascade-never-stuck`, and what is still owed to bring all four clones back in sync.

## What happened

- **The CRM row re-merged the same held variants on every pass.** It holds 26–32 held line variants (three-way merges of files the line edits). The engine decided each one afresh on every pass, at about five GitHub requests each, and remembered nothing. Every pass spent its window re-merging, paused, recorded nothing new, and spent an attempt. After three attempts each event was retired. Events retired this way: `adca3c7e`, `9aea274a`, `d6334800`, `211c4329`, `050dedb7`. `050dedb7` carries prime head `9b5e472c72c6c5ed9aef37f10465ad5a59956ad3`.
- **The client-dashboard line was starved behind the CRM row.** A paused clone ended the whole pass (`break`), and the CRM row was offered first again on the next tick. The client-dashboard parent and its two children were therefore never reached.
- **Prime's head was stranded.** Head event `0dd4e452` (prime `ec155f6`) had been folded into `211c4329`, which then failed. A failed event is never claimed again, so nothing would ever deliver prime's head.

## What the branch changes (Mission Control)

Branch `claude/cascade-never-stuck`, cut from `57487fcb`. Fixes A–E are engine changes in `src/server/cascade-engine.server.ts`; F is in the drain.

| Fix | What changed | Where |
|---|---|---|
| A, B, C | A variant merge verdict is stored in the pass ledger, keyed to the clone blob and the prime blob it read. The next pass reuses the verdict, and a `write` verdict's merged blob is read back rather than merged again. A transient hold is retried last and never pauses a pass by itself. Candidates are capped at `MAX_VARIANT_MERGE_CANDIDATES = 256`. A pass pauses only while a path it could ask and keep an answer for is still unasked. | `passProgress.pure.ts` (`variant_evidence`, `resumableVariantEvidence`, `variantRetryPaths`), `variantMerge.pure.ts`, `variantMergeRead.server.ts`, engine merge phase |
| D | A paused pass is refunded when its ledger grew by identity in any section (`ledgerGrew`), not by a count of two sections. | `passProgress.pure.ts`, engine clone loop |
| E | Clones are offered least-recently-touched first (round robin). Lineage still puts parents first. A paused clone now `continue`s to the next clone instead of `break`ing the pass. | `passOrder.pure.ts`, engine clone loop |
| F | **Head redelivery.** On an idle tick, the drain's beacon mints a NEW `scheduled` event, `scope_filter.retry_of` naming the failed one, when prime's head is owed a delivery that a failed event left undelivered. It never revives a settled event. The audit row is written first and acts as the counter. Limits: at most 3 redeliveries per head, 1 hour apart. It refuses when a delivery is already live, and it never overrides a reviewer's rejection. | `headRedelivery.pure.ts`, `hooks.cascade-drain.tsx` (`raiseDriftBeacon` → `redeliverHead`) |

Tests: `headRedelivery.test.ts` (47), `passOrder.test.ts`, `passProgress.test.ts` (variant evidence and `ledgerGrew`), and `passContinuation.contract.test.ts` (merge-phase and loop pins). `npx vitest run src/server/cascade src/routes` gives 1850 passed, and `tsc --noEmit` is clean.

## Still owed, in order

1. **Land the Mission Control PR for this branch** (Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885#334).
   - Drive CI to green, merge, then publish with Lovable `deploy_project` on project `0fb4d803-5071-4093-be25-5afbcf116476`.
2. **Verify the redelivery after deploy.**
   - Within a tick or two, a `cascade_events` row with `trigger = 'scheduled'` and `scope_filter->>'redelivers_head_event'` naming the head event should appear for prime `9b5e472`, with queued `cascade_results` for every clone.
   - Check with `query_database` on the Lovable project:
     ```sql
     select id, status, summary, scope_filter, created_at
     from cascade_events
     where trigger = 'scheduled'
     order by created_at desc
     limit 5;
     ```
   - The audit trail is `audit_log.action = 'cascade.head_redelivered'`.
   - If nothing appears, read the drain logs for `[cascade-drain] head redelivery`; `decideHeadRedelivery` returns its refusal reason.
3. **Land CD #348** (`Naidu-Group-Pty-Ltd/npc-client-dashboard`, branch `aurixa/cascade-50fabdf-mv2dj9lb`).
   - At 23:12 UTC on 12 Oct the engine re-proposed it as head `c8e261fb05`, cascading 691 files from prime `0a792ac`. On that head every check had passed except `verify`, which was still running at handoff. If `verify` passes, merge it. If it fails, read its job log first.
   - The earlier head (`b7537a5c2b`) failed agent specs. Reconcile `src/App.tsx` and the client-facing files at one prime revision, and carry the 12 held specs with their subjects.
   - A body draft existed in the previous session's scratchpad and is not preserved; rewrite it from the PR diff.
   - Rule: a spec and its subject travel together. Never fork a shared module on a clone; fix at prime.
4. **Land CRM #114** (`Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc`, branch `aurixa/cascade-06e4630-mv59b309`, head `92715d2c8e`).
   - Failing agent specs: `agentRbacContract`, `approvalPolicy`, `playbookAndSchedule` and `writableArguments`. `approvalPolicy` is missing `assign_client`, `delete_borrowing_capacity_scenario`, `list_borrowing_capacity_scenarios`, `estimate_capital_growth`, `estimate_property_expenses` and `update_client_pipeline`. The likely cause is that the agent head variant on the CRM line lags prime: reconcile the agent tool registry and policy files at prime's revision, keeping the CRM line's GoHighLevel removals.
   - The security check flags `supabase/migrations/20270105100000_messaging_hub_dispatch_cron.sql`, which schedules a `messaging-hub-dispatch` function the CRM line does not carry. Carry the function with it, or withhold the migration from the line. Never edit an applied migration.
5. **Merge the Preflight and NPC Test cascades** once CD #348 is in, and confirm all four `clones.sync_status = 'in_sync'` at prime's head.
6. **Follow-up — done.** An ambiguous variant base merges when every named base agrees. A held file whose newest reconcile names several prime revisions is merged against each of them (at most three), and is written or reported current only when every merge is clean and they all give the same text. Anything else holds the file and names the commit (`decideAcrossBases` in `variantMerge.pure.ts`, described in `CASCADE_MEMBRANES.md`).

## Caveats

- An open cascade PR on a clone (CD #348, CRM #114) can make newer passes skip as "Already proposed". Landing those PRs is what clears it.
- A new prime push while a redelivery is pending mints its own commit event. That is a known, harmless duplicate: the fold is commit-only.
- Clone IDs:
  - CD: `37b3e65a-716e-4141-9cb6-2e13583dbdd9`
  - Preflight: `2242c67f-…`
  - NPC Test: `7e2c004d-…`
  - CRM: `e97f18ab-a3e3-4350-a0c9-d3f8584d6243`
