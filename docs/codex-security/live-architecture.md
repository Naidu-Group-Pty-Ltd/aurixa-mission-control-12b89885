# Codex Security — live architecture

Phases 0–6 built the whole pipeline (schema, UI, remediation PRs, partner
bridge, intake adapters) around a scan API that does not exist. This
document describes what actually executes today, and how to verify it.

## October 2026: what the hardening pass changed

Migration `20261018090000_codex_findings_canonical.sql` and workflow
version 2 (`WORKFLOW_VERSION: "2"` in both workflow files,
`src/lib/codex-workflow-contract.ts`) fixed these faults:

| Fault | Now |
|---|---|
| One HMAC secret signed every callback, was sent to every repo as a dispatch input, and was printed in every step's log by job-level `env:` | Each scan job and remediation signs with its **own derived key** (`codex-callback-keys.server.ts`). The workflows read it from the event payload, `::add-mask::` it, and keep it in a 0600 file. Signatures cover `<unix seconds>.<body>` with `x-codex-timestamp`, a 15-minute window, and replay receipts (`codex_callback_receipts`). Callbacks to closed jobs get 409; run and PR URLs must point into the job's own repository. |
| A failed scanner download, an unreachable OSV API or a crashed AI pass wrote an empty report — which read as "clean" and resolved every open finding of that scanner | Each scanner step writes `status/<name>.json` from its real exit code. Only a scanner that reported `ok` may resolve a finding by its absence, and only when the scan is complete (every batch arrived, `callback_failures = 0`). |
| A finding was a new row per scan; triage, regressions and "fix confirmed" all looked at different copies | **One row per (target, fingerprint)**, `target_key` = clone id or `prime`, plus `:pr:<n>` for pull request scans. `codex_finding_observations` records every scan that saw a finding; `codex_finding_events` is its history. Ingest and finalize run in Postgres (`codex_ingest_scan_findings`, `codex_finalize_scan`) under row locks. |
| Fingerprints included the line number: a line added above a finding resolved it and opened a "new" one | Content-based fingerprint v2 (rule + the code it matched). `legacy_fingerprint` lets Mission Control re-key existing findings in place, keeping their triage. |
| Every gitleaks hit was `critical` (73 on this repository, all public anon keys, ids, secret names, PEM-handling code or fixtures) | Severity from what the credential is: anon JWT `info`, service_role `critical`, UUIDs / secret *names* / Airtable ids / content hashes `info`, generic rule `medium` (`low` in tests), PEM code with no key material `low`, known providers `critical`. Secrets never resolve by absence — they are resolved by a person as **rotated**. |
| osv-scanner severities were all `medium` (the CVSS vector was read as a number) | `max_severity`, else the CVSS v3 vector is scored, else the database severity. One finding per alias group. |
| PR scans reported pre-existing issues in touched files; nothing was posted on the PR | Semgrep runs with `--baseline-commit`, gitleaks scans the PR's commits, osv compares changed manifests with the base. A **"Codex Security" check run** with annotations is posted on the PR (App permission **Checks: read & write**); require it in branch protection to block merges. |
| `@latest` Codex CLI, unpinned semgrep, unverified binaries, actions by tag | Codex CLI `0.160.1`, semgrep `1.179.0`, gitleaks and osv-scanner verified by SHA-256, every action pinned to a commit. |
| The remediation workflow gave the OpenAI key and a push-capable token to every step, including the ones running code the model wrote | The OpenAI key exists only in the Codex step; `GITHUB_TOKEN` only in the push and PR steps, which build the commit from the patch file in a fresh repository (the checkout's `.git` is never trusted). gitleaks scans only the lines the patch adds; a patch touching `.github/workflows` is refused. |
| Approvals stayed valid after new commits; merges were not pinned | Approvals record the PR head (`head_sha`); only approvals of the current head count, and the merge is pinned to it (`sha`). |
| The self-healing queue could merge AI fixes unattended | `prime_config.codex_auto_merge_ceiling` (default `off`). Above the ceiling, two-key approval at the PR head is required even when released from the support queue. |
| A push to Prime cascaded to the fleet before the post-merge scan was even dispatched; no gate read scan results | Post-merge scan is enqueued first. `prime_config.codex_cascade_gate` (default `off`) holds automatic cascades while Prime has open findings at the configured severity; `cascade_events.hold_reason` keeps the drain's gate reassessment from discharging that hold. |
| Nothing could dismiss a finding; Prime had no posture card; the cron "save" changed nothing | Findings explorer with triage (reasons recorded, audit-logged), Prime posture card, scan drawer with scanner outcomes and completeness, real `pg_cron` rescheduling (`codex_set_nightly_schedule`). |

## Why nothing was running

| # | Fault | Effect |
|---|-------|--------|
| 1 | `codex-security-client.server.ts` POSTed to `https://api.openai.com/v1/security/scans` — an endpoint OpenAI has never shipped | Every enqueue threw; jobs flipped straight to `failed`. |
| 2 | Dispatch ran in a floating `(async () => {…})()` that nothing awaited | On Cloudflare Workers the isolate is reclaimed once the response is written, so jobs were stranded at `queued` with no event row and no error. |
| 3 | `clones.repo_full_name` and `clones.github_app_installation_id` did not exist | Every select naming them returned a PostgREST error, silently disabling clone scans, clone remediations, and the Actions secret sync. |
| 4 | Code read `APP_PUBLIC_URL`; `.env.example` documented `PUBLIC_APP_URL` | Callback URLs silently fell back to a hardcoded host. |
| 5 | The intake adapter inserted `scan_job_id: NULL` into a `NOT NULL` column | Every non-webhook intake write failed. |
| 6 | No sweeper, despite `failure_count` / `next_attempt_at` existing | One lost dispatch stranded a job, and the dedup window then suppressed every later scan of that target. |
| 7 | `codex-remediation.yml` called `…/v1/security/remediations` | Draft-fix PRs could never be produced. |

## What runs now

```
 Mission Control                         Target repo (Prime or clone)
 ───────────────                         ────────────────────────────
 enqueueScanNoAuth
   ├── insert codex_scan_jobs (queued)
   └── dispatchCodexScan ──────────────► workflow_dispatch
        (GitHub App, awaited)             codex-security-scan.yml
                                            ├── gitleaks      (secrets)
                                            ├── semgrep       (SAST)
                                            ├── osv-scanner   (deps)
                                            └── codex exec    (reasoning)
                                                    │
 /api/public/hooks/codex-security ◄──────────────────┘
   ├── HMAC verify                        scan.started / progress /
   ├── carry forward triage verdicts      completed / failed
   ├── flag regressions
   ├── auto-resolve fixed findings
   └── recount summary
```

### Engines

`CODEX_SECURITY_ENGINE` selects the executor:

- **`github_actions` (default)** — dispatches `.github/workflows/codex-security-scan.yml`
  in the target repo through the Aurixa GitHub App. Needs no key beyond the
  existing `GITHUB_APP_*` configuration.
- **`http`** — the original vendor-API passthrough, retained behind the flag
  so a real hosted scan API can be adopted later without touching a caller.

`workflow_dispatch` only accepts a branch or tag as its ref, so PR scans
dispatch on the repo's default branch and pass the head SHA through as the
`scan_ref` input.

### Scanners

| Scanner | Finds | Severity source | Auto-fix confidence |
|---|---|---|---|
| gitleaks (working tree; full history on manual and nightly scans) | committed credentials | what the credential is — see the table above | 0.35 (0.1 for info) |
| semgrep (`p/security-audit`, `p/secrets`, `p/owasp-top-ten`) | injection, authz, unsafe APIs | rule impact/likelihood, else the rule's level | 0.8 with autofix, else 0.4 |
| osv-scanner | vulnerable dependencies | `max_severity`, else scored CVSS vector, else database severity | 0.9 when a fixed version exists |
| Codex CLI (optional, read-only sandbox, schema-checked answer) | logic-level flaws rules can't express | model-assigned, clamped to the enum | model confidence, default 0.5 |

Each scanner step is `continue-on-error` — one broken scanner degrades the
scan instead of failing it — and records its own outcome in
`result_summary.scanners.<name>.status` (`ok` / `failed` / `skipped`, with a
reason). The scan drawer, the fleet table ("Degraded") and engine health all
read it. Suppression files (`.gitleaks.toml`, `.gitleaksignore`,
`.semgrepignore`, `osv-scanner.toml`) and `nosemgrep` comments are honoured
and reported in `result_summary.suppressions`.

### Fingerprints and cross-run state

Every finding has a content-based `fingerprint` (v2) and lives on one row per
target. The rules (`src/lib/codex-finding-lifecycle.ts`, mirrored in SQL and
exercised by tests):

- `dismissed` / `false_positive` verdicts survive re-scans; they need a reason.
- A `resolved` finding that reappears is reopened as a regression — unless it
  was a credential resolved as `rotated` (history will report it for ever).
- A `fix_merged` finding still reported after the merge reopens as "fix
  ineffective"; one that disappears is resolved as `fixed` and its
  remediation stamped `fix_confirmed_at`.
- Absence counts only on a complete scan, only for scanners that reported
  `ok`, only for full-tree kinds with a full scope (or the PR's own target).
  Deterministic scanners resolve on one miss, the Codex review on three,
  credentials never.
- A pull request's findings live on `<target>:pr:<n>` and close with the PR.

### Scheduling

| Trigger | Route | Scope |
|---|---|---|
| pg_cron `0 7 * * *` | `POST /hooks/codex-nightly` | Prime + every clone with `codex_nightly_enabled` |
| pg_cron `*/10 * * * *` | `POST /hooks/codex-sweep` | Re-dispatch stranded jobs, retire hung runs |
| GitHub `pull_request` | `POST /hooks/github` | PR head SHA, scoped to the diff vs the base ref |
| GitHub `push` to default branch | `POST /hooks/github` | Post-merge revalidation of Prime |
| Operator | `/security/scans` | Prime, a single clone, or the whole fleet |

Both cron endpoints authenticate with `CRON_SECRET` as a Bearer token.

The sweeper re-dispatches a `queued` job that has sat undispatched for 10
minutes, backing off 5/10/15 minutes across at most 3 attempts, then fails
it. A `running` job with no terminal callback after 75 minutes (the workflow
itself times out at 60) is failed as `scan_timeout`; one never started after
6 hours is failed too. Either way its PR check, if any, is completed.

## Remediation — what "Draft Fix PR" actually does

Yes, it writes real code. The button does **not** apply a patch from an API;
it starts an agent inside the target repository.

```
 Mission Control                          Target repo (Prime or clone)
 ───────────────                          ────────────────────────────
 draftRemediationPR(findingId)
   ├── admin gate + in-flight dedup
   ├── insert codex_remediations (queued)
   └── workflow_dispatch ───────────────► codex-remediation.yml
        (GitHub App, awaited)               │
                                            ├─ checkout base_ref (no stored token)
                                            ├─ codex exec --sandbox workspace-write
                                            │    ← edits real files in the tree
                                            ├─ measure blast radius → fix.patch
                                            ├─ refuse .github/workflows changes
                                            ├─ gitleaks on ADDED lines ── HARD STOP
                                            ├─ repo's own checks on a copy (report only)
                                            ├─ commit from fix.patch in a fresh repo + push
                                            └─ gh pr create --draft
                                                    │
 /api/public/hooks/codex-remediation ◄─────────────┘
   ├── persist PR + verification + blast radius
   └── mirror finding state
                │
     two independent admin approvals of the PR's current head
                │
        mergeRemediationPR ──────────────► re-read PR, mark ready, merge pinned to head
                │
        cascade to fleet (Prime only)
                │
        next full scan ── finding gone? ── fix_confirmed_at
```

### The engine

**OpenAI Codex CLI (`@openai/codex`)**, run headless as `codex exec` on the
target repo's own GitHub Actions runner, sandboxed with
`--sandbox workspace-write`. It gets a checkout of `base_ref` and edits files
directly — which is why the patch follows the conventions of the surrounding
code rather than being a context-free diff.

It is given the finding's title, severity, file, line, CWE, description, the
reporting scanner and rule id, and the offending source excerpt captured at
scan time. Authentication is `OPENAI_API_KEY`, pushed into each managed repo
by the settings-page secret sync. **Without that key remediation cannot run
at all** — scans still work, since gitleaks/semgrep/osv-scanner need no key.

Recorded on every remediation row as `engine` (`codex_cli`), so a future
engine swap stays auditable.

### What stands between the model and your default branch

| Guard | Behaviour |
|---|---|
| Secret-leak scan | gitleaks scans the lines the patch adds. A patch adding a secret is **never pushed**. |
| CI changes | A patch touching `.github/workflows` is refused. |
| Credentials | The OpenAI key exists only in the Codex step. `GITHUB_TOKEN` exists only in the push and PR steps, which never run git in the checkout: the commit is built from `fix.patch` in a fresh repository, applied to the index only, hooks disabled. |
| Repo's own checks | `typecheck`, `lint`, `test`, `build` — whichever `package.json` defines — run against a copy of the patched tree. Failures are reported, not fatal: a reviewer must be able to see a broken fix rather than have it silently discarded. |
| Blast radius | Files touched and lines added/removed are measured and shown, so a "smallest possible change" that sprawled across 40 files is visible before approval. |
| Draft PR | Always opened as a draft. |
| Two-key merge | Two distinct admin approvals **of the PR's current head** required; the requester cannot approve their own; a push after an approval needs approving again. The merge re-reads the PR (branch, repository, base) and is pinned to that head. Enforced server-side from the database. |
| Auto-merge ceiling | `prime_config.codex_auto_merge_ceiling`, default `off`. Only fixes at or below it may merge through the self-healing queue unattended; anything above needs the two-key rule even when released from the support queue. |
| Draft→ready | GitHub refuses to merge a draft and has no REST endpoint to clear the flag, so the merge path clears it via the GraphQL `markPullRequestReadyForReview` mutation first. |
| Fix confirmation | Merging proves a patch landed, not that the vulnerability is gone. When a later full-tree scan no longer reports the finding, the remediation is stamped `fix_confirmed_at`. |

Only the commit step is scoped to the exact paths Codex touched — captured
before the verification step runs, so `npm ci` / build output can never end
up in the PR.

### Failure modes, and what each one leaves behind

| Outcome | Result |
|---|---|
| No `OPENAI_API_KEY` in the repo | Workflow fails immediately with a message pointing at the settings-page secret sync. |
| Codex changes nothing (e.g. judges it a false positive) | Reported as `workflow.failed` carrying Codex's own reasoning from `CODEX_FIX_NOTES.md`; no PR is opened. |
| Patch introduces a secret | Push refused, remediation failed with the leak count. |
| Repo checks fail | Draft PR still opened, marked ⚠️ on the PR and in Mission Control. |
| Workflow dies at any point | Remediation set to `failed`, and the finding is returned to `open` — it must not sit in `fix_drafted` with no PR behind it. |

### Reviewing one

The scan-detail sheet shows, per finding: the engine that wrote the patch,
blast radius, secret-scan verdict, each verification check with output for
failures, the PR and run links, the approval count, and whether a later scan
has confirmed the fix. An expandable explainer above the findings list spells
out the whole pipeline in-product.

## Secrets

| Name | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | yes | Installation needs **Actions: read & write**, **Secrets: read & write**, and **Checks: read & write** for PR checks. |
| `CRON_SECRET` | yes | Mirror into Postgres: `ALTER DATABASE postgres SET app.settings.cron_secret = '…';` |
| `PUBLIC_APP_URL` (or `APP_PUBLIC_URL`) | recommended | Origin the scanner posts results back to. |
| `CODEX_SECURITY_WEBHOOK_SECRET` | optional | The scan **master**: per-job keys are derived from it, it never leaves Mission Control. Falls back to the auto-generated secret on the built-in `codex` row of `security_intake_sources`, which "Rotate signing key" on engine health replaces (the previous value keeps working for 24 hours). |
| `CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS` | optional | The scan master being rotated out, still accepted. Remove it a day after the rotation. |
| `CODEX_REMEDIATION_WEBHOOK_SECRET` | optional | The remediation master. Falls back to the scan master. |
| `CODEX_REMEDIATION_WEBHOOK_SECRET_PREVIOUS` | optional | As above, for the remediation master. |
| `OPENAI_API_KEY` | optional for scans, **required for remediation** | Synced into each managed repo as an Actions secret. Without it, scans still run gitleaks/semgrep/osv-scanner; remediation cannot author patches. |

## Bringing it up

1. Apply `supabase/migrations/20260727140000_codex_security_engine_live.sql`
   and `supabase/migrations/20261018090000_codex_findings_canonical.sql`.
2. Copy `.github/workflows/codex-security-scan.yml` and
   `.github/workflows/codex-remediation.yml` into Prime; the fleet cascade
   carries them to every clone (clone provisioning pushes the secrets
   automatically). Engine health shows which repositories still report an
   older workflow version.
3. Once every repository reports version 2, **rotate the signing key**
   (engine health): older copies printed the previous one in their logs.
4. Open **/security/scans** and read the **Engine health** card. Every
   blocking misconfiguration is listed there with its exact fix — missing
   secret, missing App permission, missing workflow file, dead cron.
5. Click **Scan Prime Now** and watch the job go
   `queued → running → completed` with findings attached. Triage Prime's
   first results before turning on the cascade gate or PR-check failure.

## Verifying without waiting for cron

```bash
# nightly fan-out
curl -X POST https://<mission-control>/hooks/codex-nightly \
  -H "Authorization: Bearer $CRON_SECRET"

# sweeper
curl -X POST https://<mission-control>/hooks/codex-sweep \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Performance notes

- Fleet overview moved from "fetch 500 jobs + every open finding, group in
  JS on each 30s poll" to the `codex_fleet_overview()` RPC, which does the
  `DISTINCT ON` and severity roll-up against partial indexes.
- Nightly fan-out dispatches 5 clones concurrently instead of serially.
- The partner bridge went from 3 queries per finding to one lookup plus two
  batched writes.
- PR scans are diff-scoped, so they cost seconds rather than minutes and
  only report what the PR actually introduced.
