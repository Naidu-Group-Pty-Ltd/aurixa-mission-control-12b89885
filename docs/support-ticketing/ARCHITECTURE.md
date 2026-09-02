# Support ticketing & self-healing remediation

How a support ticket travels from a tenant dashboard to a fix, and where a
human stands in the way on purpose.

## The path

```
NPC dashboard (Support tab)
  → aurixa-systems /support  (Support Portal form; validation + honeypot +
    30s client throttle; carries workspace_id & user_id from the URL)
  → aurixa-systems edge fn `support-ticket`  (server-side re-validation,
    per-IP windowed throttle, forwards with x-aurixa-support-secret)
  → POST /api/public/support/tickets   (this repo)
      auth  → security_intake_sources['support-portal'].hmac_secret when
              set (x-support-signature), else SUPPORT_INGEST_SECRET header,
              else open-but-rate-limited (ticket marked unverified)
      rate  → support_ingest_requests sliding windows (per IP and workspace)
      class → classifyTicket() — deterministic category × breakage-vector
              matrix, P0–P4, SLA minutes, lane  (src/lib/ticket-classification.ts)
      write → support_tickets + support_ticket_events + notification
      plan  → planTicketRemediation() for auto-remediable tickets
  → pg_cron `support-remediation-drain` (*/2) → /hooks/support-remediation-drain
      executes due remediation_runs, plans auto-merges for freshly verified
      scan remediations, rolls ticket statuses up, escalates SLA breaches
```

Operators work the queue at **/support/tickets** (nav: Security → Support
Ops): ticket list with P0–P4 KPIs, per-ticket timeline and runs, and the
**validation queue** where parked runs wait for an admin's approve/reject.

## The rulebook

One policy decides auto vs human, everywhere:
`decideRemediation()` in `src/lib/remediation-policy.ts`.

- **P2 and below flow through self-remediation.** P0/P1 never execute
  unattended — the classifier also pins `requiresHuman` on them.
- **Edge cases always go to a human**, whatever the priority:
  - destructive SQL (`src/lib/destructive-sql.ts` — DROP/TRUNCATE/unbounded
    DELETE-UPDATE/RLS-disabling/anon grants, tested statement analyzer);
  - unverified or size-unbounded patches (no verification, secrets not
    clean, > 10 files or > 400 lines);
  - tickets in `data_issue` / `billing` / `access` categories (value that
    no rollback recovers);
  - recovery claims with no telemetry to confirm them.
- The policy is re-checked **at execution time**, not only at planning —
  state can change in between.

## The lanes

| lane          | action                 | what it does                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| security_scan | `pr_merge`             | squash-merges a **verified** codex remediation draft PR (medium severity and below only); prime-scoped merges deliberately do NOT auto-cascade — a notification points at /cascades instead                                                                                                                                                         |
| security_scan | `rescan`               | enqueues a codex scan when no verified fix is waiting                                                                                                                                                                                                                                                                                               |
| redeploy      | `sql_migration`        | replays pending prime migrations onto the clone's Supabase project via the Management API — scoped to what the prime has itself applied (`openScopedPrimeCorpus`, the fleet sync's rule) and to nothing behind a hole, after the destructiveness gate, and bounded to a 45 s invocation budget with the same requeue rule as `edge_function_deploy` |
| redeploy      | `edge_function_deploy` | redeploys prime function bundles onto the clone project                                                                                                                                                                                                                                                                                             |
| monitor       | `monitor_recovery`     | watches `clone_health_beacons`; resolves on an `ok` beacon, parks for a human when there is no telemetry or attempts run out                                                                                                                                                                                                                        |

The scan pipeline self-heals even without a ticket: each drain pass turns
freshly verified `codex_remediations` (severity ⇒ P2 or below) into
`pr_merge` runs, deduped on remediation id. Critical/high findings keep the
existing two-key review gate untouched.

### A migration too big to hold is streamed, not withheld

The template-library seed is one 39 MB INSERT of 543 rows. The corpus refuses
any body past 8 MB (`MAX_MIGRATION_BYTES`), and the refusal is right: a body
that size cannot be sent as one Management API statement, and this isolate
cannot hold it either — a 39 MB file is a 52 MB base64 response, a 78 MB
UTF-16 string and a second copy for the split, against a 128 MB limit. For as
long as the prime's own ledger did not record the seed, the fleet scope
withheld it and nothing noticed. On 2 September 2026 at 13:56 UTC the prime
recorded it (applied by hand through the prime's `apply-migration` workflow),
and from that moment the lane would have parked every run as "unreadable" and
an approved run would have halted the replay on the same throw — with every
migration after the seed held back behind it, on every clone.

`seedChunking.pure.ts` is the prime workflow's tuple-boundary chunker written
as a two-pass STREAM: the first pass keeps only the INSERT header, the
`ON CONFLICT` clause, the trailing statements and the tuple count; the second
re-reads the blob and emits statements as tuples arrive, each carrying the
file's own clause, grouped to `DEFAULT_SEED_STATEMENT_BYTES`. No more than one
tuple and one statement exist in memory. The corpus opens the blob with the
raw media type (`openSqlStream`), so the bytes are never one string.

Four rules. **The checks are the prime script's, kept**: a line that is
exactly `  (` inside a dollar-quoted JSON schema would be taken as a tuple
boundary and every chunk around it would be invalid SQL while the parse
looked complete, so the dollar-quote tags must balance within every tuple; the
second read must find exactly the tuples the first did, or the blob changed
between reads. **The ledger row is written once, after the last statement** —
a half-sent seed is never "applied". **A budgeted pass resumes rather than
restarts**: statement boundaries are deterministic for a file and a budget, so
the run's heartbeat carries a `chunk_cursor` and the next pass skips what was
sent; a pass that sent part of the seed and nothing else still counts as
progress for the attempt decision. And **the gate assesses the skeleton** —
header, clause and tail, which is every statement the rows are poured into —
rather than parking the run as unreadable; the rows are data. A large file
that is NOT this shape is refused by name with the manual remedy, exactly as
before.

## Tables

`support_tickets`, `support_ticket_events` (append-only),
`remediation_runs`, `support_ingest_requests` (rate-limit ledger, pruned
after 7 days) — migration `20260812093000_support_ticketing_self_healing.sql`,
which also registers the `support-portal` intake source and schedules the
drain.

## Things that will bite

- **The drain is the heartbeat.** If the vault `cron_secret` was missing at
  migration time the cron was not scheduled (the migration warns loudly);
  drive it manually with `POST /hooks/support-remediation-drain` until fixed.
- **`security_intake_sources.hmac_secret` beats the env secret.** Setting a
  secret on the `support-portal` source switches the endpoint to signature
  auth; the aurixa-systems edge function must then sign bodies rather than
  send `x-aurixa-support-secret`.
- **Priority overrides re-derive the SLA** from the ticket's `created_at`,
  and land in the audit trail with the operator's reason.
- **`workspace_id` resolution is best-effort**: clone slug first, then
  `tenants.external_ref`, else unresolved (prime installs like `npc-prime`
  land here on purpose — clone_id null means prime scope to the planner).
