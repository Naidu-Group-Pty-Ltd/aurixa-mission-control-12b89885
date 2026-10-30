# The live audit

Mission Control's half of the live audit: Chromium, driven by Playwright,
uses Prime's **production** application as a member of staff while Claude
reads Prime's repository to decide what to exercise and to find the code
behind what breaks. It is for **bug and error detection only** — crashes,
uncaught exceptions, error screens, failed requests, broken pages and links,
screens stuck loading, data that contradicts itself on screen. Security
scanning stays with Codex Security.

Prime's half — the runner, the workflow, and everything that keeps a run from
changing production — is described in Prime's
`docs/operations/LIVE_AUDIT.md`, beside `.github/live-audit/` and
`.github/workflows/live-audit.yml`.

**Prime is the acid test.** The owner decided on 29 Oct 2026 that the audit
runs on Prime alone until it has been cycled through enough times to bolt onto
the clones (`LIVE_AUDIT_TARGETS` in `src/lib/live-audit-policy.ts`, enforced
where a run is queued). The workflow is a prime-only feature in both
registers (`src/server/primeOnlyFeatures.pure.ts` here, `scripts/lib/
primeOnlyFeatures.mjs` on Prime), so the cascade never carries it to a clone.

## The page

**Observability → Live Audit** (`/live-audit`). Operators read; an admin acts.

| Tab           | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Findings      | Every defect, ranked by severity. A finding opens to how a person reaches it (the recorded steps), the screenshot, the console, the stack and the requests, the files and lines Claude's reading of the code points at, its fixes and its whole history. An admin asks Claude for a fix, re-tests it (a run with the finding's page first), triages it, or changes its severity — a person's severity sticks across later runs. |
| Runs          | Each run: what it covered, what the guard held back (by endpoint, so the guard can be tuned), which model it ran on and whether a person chose it, what it spent, and its timeline. An admin cancels a run in flight.                                                                                                                                                                                                           |
| Fixes         | Every fix Claude drafted, its pull request, and whether a later complete run confirmed the defect gone.                                                                                                                                                                                                                                                                                                                         |
| Settings      | Models, effort per phase, the nightly switch and time, budget and limits, viewports, screenshots, the guard's allow and block lists, automatic fixes.                                                                                                                                                                                                                                                                           |
| Engine health | Every piece the audit needs and whether it is there, with what to do when it is not. Presence only, never a value.                                                                                                                                                                                                                                                                                                              |

## How a run goes

1. **Queued.** A person's **Run audit now** (or **Preview a branch**, or a
   finding's **Re-test now**), or the nightly hook when it is switched on,
   writes a `live_audit_runs` row first (`enqueueLiveAuditRun`,
   `src/server/live-audit-dispatch.server.ts`). One run is in flight per
   target (`live_audit_runs_one_active`).
2. **Dispatched.** `workflow_dispatch` on Prime's `live-audit.yml` with the
   run id, the target, the backend, the settings snapshot and a callback key
   derived for this run alone. A refused dispatch leaves the run queued with
   its error; the sweep retries it after 5, 10, 15 minutes and fails it after
   the third attempt.
3. **Reported.** The runner calls `/api/public/hooks/live-audit`
   (`src/server/live-audit-callback.server.ts`): started, a context request
   (the findings Mission Control already holds, so the runner re-tests them and
   Claude can name duplicates), progress per phase, findings in signed batches,
   then completed or failed.
4. **Stored.** Findings are upserted in Postgres by
   `live_audit_ingest_findings`, under row locks; screenshots go to the
   private `live-audit-evidence` bucket, one per finding, replaced as it is
   seen again, and are shown through a ten-minute signed link.
5. **Finalised.** `live_audit_finalize_run` closes the run and resolves by
   absence — **only on a run the runner reports complete, and only on the page
   templates it reports it covered**.

### Who a callback is believed from

The same scheme as the Codex workflows, with its own derivation label
(`src/server/live-audit-keys.server.ts`): the master never leaves Mission
Control (`LIVE_AUDIT_WEBHOOK_SECRET`, else the Codex scan master); each run
and each fix signs `<unix seconds>.<body>` with a key derived for it alone;
the timestamp must be inside fifteen minutes; every accepted signature is
recorded and an exact replay is refused. An unknown run and a bad signature
get the same 401; a closed run's key opens nothing (409); a workflow run URL
outside Prime's repository is refused. A Codex key can never verify a
live-audit callback, or the reverse.

### A finding's life

| From              | Event                                                                                                     | To                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| —                 | first reported                                                                                            | `open`                                                           |
| `open`/`triaging` | a person asks for a fix, or automatic fixes pick it                                                       | `fix_queued` → `fix_in_progress` → `fix_pr_open`                 |
| `fix_pr_open`     | the pull request merges (GitHub webhook, or the sweep)                                                    | `fix_merged`                                                     |
| `fix_merged`      | absent from the next complete run covering its page (two for a defect that does not recur on every visit) | `resolved` (`fixed`), and the fix is marked confirmed            |
| `fix_merged`      | seen again                                                                                                | `open` (`fix_ineffective`)                                       |
| `open`            | absent from two complete runs covering its page (four when it does not recur on every visit)              | `resolved` (`absent`)                                            |
| `resolved`        | seen again                                                                                                | `open` (`regressed`)                                             |
| any open state    | a person dismisses it or calls it a false positive, with a reason                                         | `dismissed` / `false_positive` — and it stays so when seen again |

A run that stopped early, failed, timed out or was canceled resolves nothing.

## Fixes

Every live-audit defect is fixed by **Claude**, whatever its severity
(`src/server/live-audit-fix.server.ts`). A fix is `codex-remediation.yml`
(version 5) on Prime, dispatched with `kind: "bug"`, the defect's steps,
console, stack, requests and suspected files as evidence, and the model and
effort from the settings. The workflow refuses a live-audit defect that names
another engine, works on a `live-audit/fix-…` branch, and runs every guard a
security fix passes. The pull request opens as a draft and **a person merges
it** while the audit is being proven; the next complete run covering the page
confirms the defect gone, or reopens it.

The fixes flow through **the Anthropic key**: `ANTHROPIC_API_KEY` in Mission
Control, which the Actions secret sync writes into Prime's repository for the
Claude Code fixes. Until it is set, every fix — a person's or automatic —
says it is waiting on the key and nothing is dispatched; the runs themselves
still crawl and report from the browser alone, and say that Claude stood down.

**Automatic fixes** (off until switched on): after each completed run, the
sweep drafts fixes for up to N of that run's open defects, worst and surest
first, above the confidence threshold, reproduced or recurring on every
visit, and never for one whose two automatic fixes in the last thirty days did
not merge.

Fix pull requests are followed by the GitHub webhook (`hooks.github.tsx` →
`src/server/live-audit-pr-sync.server.ts`) and, for any delivery that went
missing, by the sweep at most hourly per pull request.

## The sweep and the nightly run

| Hook                        | Schedule                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hooks/live-audit-sweep`   | every 10 minutes                                  | Fails a run whose dispatch was refused three times, one whose workflow never started within 45 minutes, and one still running 110 minutes after it started (a cancelled or timed-out job runs no failure step); fails a fix whose workflow went silent for 150 minutes; prunes old receipts. Then, if the GitHub budget allows (`role: "actor"`): re-dispatches, the latest run's automatic fixes, and fix pull requests the webhook missed. |
| `/hooks/live-audit-nightly` | the settings' time (`13 16 * * *` UTC by default) | Nothing unless the nightly switch is on; one nightly run a night; yields first on a low GitHub budget (`role: "scan"`).                                                                                                                                                                                                                                                                                                                      |

The nightly time is moved from the page (`live_audit_set_nightly_schedule`,
admin only); the switch is the settings row, so turning it on is one click and
never a migration.

## Alerts

`live_audit_findings_detected` when a run finds new critical or high defects
or some come back; `live_audit_run_failed` at the third failed run in a row
(not the fourth); `live_audit_fix_ready` when Claude's fix pull request opens.
Each can be muted under **Settings → Notifications**.

## Setting it up

1. Merge the live audit's pull requests here and on Prime (the workflow must
   be on Prime's default branch to be dispatched). Apply the two migrations
   (`20261030110000_live_audit_notification_kinds.sql`,
   `20261030110100_live_audit.sql`).
2. On Prime: create a **view-only admin** staff account for the audit and put
   its user id in the repository variable `LIVE_AUDIT_USER_ID`. Without it,
   runs see only the signed-out pages.
3. Set `ANTHROPIC_API_KEY` in Mission Control — a key from the Anthropic
   workspace the audit should bill to — and run the Actions secret sync for
   Prime. Optionally set the repository variable
   `LIVE_AUDIT_ANTHROPIC_WORKSPACE_ID` on Prime.
4. Choose the audit model and the fix model under **Settings** (until then
   runs use the default, `DEFAULT_AUDIT_MODEL` in `src/lib/live-audit-policy.ts`, and record that it was the default).
5. Run one by hand, read **Runs → Held back by the guard**, and allow any
   function there you know only reads. Then switch the nightly run on, and
   automatic fixes when the findings have earned it.

**Engine health** checks every one of these.

## Bringing it to the clones

When it has proven itself on Prime: remove the `live-audit` entry from
`src/server/primeOnlyFeatures.pure.ts` and Prime's
`scripts/lib/primeOnlyFeatures.mjs` together; add the clone ids to
`LIVE_AUDIT_TARGETS`; give runs a target (`target_key` is already on every
table, and the settings check accepts a clone id); and decide which Anthropic
key a clone's audit and fixes run on — the Codex secret sync removes
`ANTHROPIC_API_KEY` from clone repositories today
(`CLONE_CODEX_REPO_SECRETS`, `src/server/github-secrets.server.ts`).

## Files

| Where                                                                             | What                                                                                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20261030110000_…`, `…110100_live_audit.sql`                  | Notification kinds; tables, policies, bucket, `live_audit_ingest_findings`, `live_audit_finalize_run`, `live_audit_set_nightly_schedule`, cron jobs |
| `src/lib/live-audit-policy.ts`                                                    | Where it runs, states, models, what a run is sent, fix eligibility, fix evidence                                                                    |
| `src/lib/live-audit-contract.ts`                                                  | What the runner promises and what is accepted from it                                                                                               |
| `src/server/live-audit-*.server.ts`                                               | Keys, dispatch, callbacks, fixes, pull request sync, sweep, alerts                                                                                  |
| `src/routes/live-audit.tsx`, `src/components/live-audit/`                         | The page                                                                                                                                            |
| `src/lib/live-audit.functions.ts`                                                 | The page's server functions                                                                                                                         |
| `src/routes/hooks.live-audit-*.tsx`, `src/routes/api.public.hooks.live-audit*.ts` | Cron hooks and callbacks                                                                                                                            |
