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
| Every gitleaks hit was `critical` (73 on this repository, all public anon keys, ids, secret names, PEM-handling code or fixtures) | Severity from what the credential is: anon JWT `info`, service_role `critical`, UUIDs / secret *names* / Airtable ids / content hashes / publishable keys (Stripe `pk_`, PostHog `phc_`, Mapbox `pk.eyJ`) `info`, generic rule `high` when named like a credential (secret, token, password, bearer, credential, private, api key) with a long random value, else `medium` (`low` in tests), PEM code with no key material `low`, known providers `critical`. Secrets never resolve by absence — they are resolved by a person as **rotated**. |
| osv-scanner severities were all `medium` (the CVSS vector was read as a number) | `max_severity`, else the CVSS v3 vector is scored, else the database severity. One finding per alias group. |
| PR scans reported pre-existing issues in touched files; nothing was posted on the PR | Semgrep runs with `--baseline-commit`, gitleaks scans the PR's commits, osv compares changed manifests with the base. A **"Codex Security" check run** with annotations is posted on the PR (App permission **Checks: read & write**); require it in branch protection to block merges. |
| `@latest` Codex CLI, unpinned semgrep, unverified binaries, actions by tag | Codex CLI `0.160.1`, semgrep `1.179.0`, gitleaks and osv-scanner verified by SHA-256, every action pinned to a commit. |
| The remediation workflow gave the OpenAI key and a push-capable token to every step, including the ones running code the model wrote | The OpenAI key exists only in the Codex step; `GITHUB_TOKEN` only in the push and PR steps, which build the commit from the patch file in a fresh repository (the checkout's `.git` is never trusted). gitleaks scans only the lines the patch adds; a patch touching `.github/workflows` is refused. |
| Approvals stayed valid after new commits; merges were not pinned | Approvals record the PR head (`head_sha`); only approvals of the current head count, and the merge is pinned to it (`sha`). |
| The self-healing queue could merge AI fixes unattended | `prime_config.codex_auto_merge_ceiling` (default `off`). Above the ceiling, two-key approval at the PR head is required even when released from the support queue. |
| A push to Prime cascaded to the fleet before the post-merge scan was even dispatched; no gate read scan results | Post-merge scan is enqueued first. `prime_config.codex_cascade_gate` (default `off`) holds automatic cascades while Prime has open findings at the configured severity; `cascade_events.hold_reason` keeps the drain's gate reassessment from discharging that hold. |
| Nothing could dismiss a finding; Prime had no posture card; the cron "save" changed nothing | Findings explorer with triage (reasons recorded, audit-logged), Prime posture card, scan drawer with scanner outcomes and completeness, real `pg_cron` rescheduling (`codex_set_nightly_schedule`). |

## October 2026, second pass

Migrations `20261018100000_codex_notification_kinds.sql` and
`20261018110000_codex_findings_ownership.sql`, and workflow version 3 in both
workflow files:

| Fault | Now |
|---|---|
| An intake partner could set a finding to any state, with no reason and no history; an unknown status word was dropped silently | Partner status words are mapped onto the states a person may set (`resolveIntakeState`): unknown words get **400**, a finding outside the partner's own prefix **404**, a change the triage rules refuse **409**. Verdicts carry the partner's reason, or one naming the partner. The update applies only from the state just read, and each change is an `intake.status` event in the finding's history. A credential is resolved only by the status `rotated` — a pentest portal's "fixed" says nothing about the key. Ticketing partners update their ticket, never the finding. |
| `/approvals` did not say why a cascade was held; fix PRs had no review queue | Held cascades show their `hold_reason`. `/security/scans#fix-prs` lists every fix PR waiting on a review, with its evidence and the two-key panel. |
| Engine health knew a repository's workflow version only from its last scan | It reads both workflow files from every fleet repository (`fleet_workflow_files`, cached, behind the GitHub spend gate), and the fleet table has a Workflow column. |
| The overview's "cascades in flight" tile counted the wrong thing | It counts cascades carrying merged security fixes: in flight, held, delivered in the last 7 days. |
| Nothing interrupted anyone: a nightly scan could find a committed service-role key and nobody heard | One notification per finished scan for a new critical, a newly exposed credential, a high-or-critical regression or a fix that did not work (`codex_findings_detected`); one when a scanner, or a repository's scans, fail three times running (`codex_scanner_failing`); a daily digest of overdue findings (`codex_findings_overdue`). Each kind is separately mutable. |
| Findings had no owner and no age | `assigned_to` / `assigned_at`, set by admins (one at a time or in bulk) and recorded in the finding's history. Response times by severity (`src/lib/codex-finding-sla.ts`): critical 7 days, high 30, medium 90, low 180, info none; the clock runs only while a finding is `open` or `triaging`. The explorer filters by owner and overdue (`/security/scans?overdue=1`), and its drawer lists and links tickets. |
| A pull request's edits to `.gitleaksignore`, `.gitleaks.toml`, `.semgrepignore` or `osv-scanner.toml` applied to **its own** scan, so a change could exempt itself | Before each scanner runs, the workflow restores the base's copies of those files (`pin_controls_to_base`; a symlink is replaced, never written through). The change's edits to them, to `.github/codex-security/` and to the two workflows are reported (`suppressions.changed`), with the inline suppressions it adds (`suppressions.nosemgrep_added`, `suppressions.gitleaks_allow_added` — inline markers are code, so they do apply to its own scan). The PR check lists them and is **neutral** when nothing else fails. |
| Semgrep's registry packs changed between nights, so the same code gained or lost findings with nothing to say why | Rules committed under `.github/codex-security/semgrep/` are used when present, read from the trusted commit (the base, for a pull request). Otherwise the registry packs are downloaded to files and hashed first. `result_summary.rulesets.semgrep` records the source and a digest of every rule file, and the scan drawer says whether the rules changed since the previous scan. Findings are also counted per scanner (`result_summary.by_scanner`). |
| A live token matched only by gitleaks' generic rule was filed `medium` — below the alert line, with a 90-day response time. Checked against this repository's full history, the one such hit was a cron bearer token committed in a migration | A generic match that survives every demotion and is named like a credential, with a long random value, is `high` (it alerts, 30-day response time). Publishable keys drop to `info`. On this repository the change moves exactly that one finding. |
| A drafted fix could make a finding vanish by silencing the scanner — and then be "confirmed" by the next scan | The remediation workflow refuses a patch that adds an inline suppression (semgrep's or gitleaks') or edits an ignore file or the scan rules. Its CI guard now reads unquoted, rename-free paths: a workflow file git printed quoted (a non-ASCII name) or renamed away used to pass it. |

## October 2026, third pass: nightly on Prime, fixed and merged by itself

Decided by the platform owner: **scans run once a night, on Prime only**;
**P0/P1 findings are fixed by Claude and P2 and below — info included — by
Codex**; **every fix
PR merges by itself, with no person in the loop**. Migration
`20261018120000_codex_autofix_settings.sql` and remediation workflow
version 4. This supersedes the two-key review, the auto-merge ceiling, PR
scans, post-merge scans and clone scans described in the passes above.

| Before | Now |
|---|---|
| Clones were scanned nightly and on demand, and their findings fixed on the clone | **Clones are not scanned or fixed** (`src/lib/codex-scan-policy.ts`, enforced in `enqueueScanNoAuth`). Prime's fixes reach them through the cascade. Their earlier scans stay readable on the clone page. The migration turns `codex_nightly_enabled` off on every clone; their Codex secrets are removed by the clone and fleet secret sync. |
| Every pull request was scanned, and every push to `main` re-scanned Prime | Neither. One full scan of Prime a night (`/hooks/codex-nightly`), plus **Scan Prime now**. `/hooks/github` still does the PR bookkeeping for fix PRs and cascades merges. |
| A fix waited for two admin approvals of its current head | After each nightly scan the sweep (`/hooks/codex-sweep` → `dispatchAutomaticFixes`) starts fixes by itself for open Prime findings, worst first, oldest first, up to `prime_config.codex_autofix_max_per_night` (default 10). Info findings are fixed too, last. A finding is tried at most twice in 30 days; anything gitleaks reported (a credential to rotate, or at info a public value the app needs) and anything being triaged is never auto-fixed. The scan's `autofix.dispatched` event claims it, so a night's fixes go out once. |
| Codex wrote every fix | `codex_findings.severity` decides (`src/lib/codex-autofix-policy.ts`): critical/high → **Claude Code** (`claude -p --bare --restricted`, file tools only), medium/low/info → **Codex**. The engine travels inside the `finding` dispatch input, so a workflow older than version 4 ignores it and uses Codex. |
| The fix's checks ran on the agent's working copy, as the job's own user, with `npm ci \|\| npm install` | They run on the **base plus the patch** — exactly the committed tree — as a separate user (`fixcheck`) that can read none of the job's files or the environment of the steps holding a token, with `npm ci` alone when a lockfile exists. A fix that fails them is **not pushed**: the run reports what broke and prints the patch. |
| A dependency fix arrived with stale lockfiles (neither agent can reach the registry) | The workflow regenerates `package-lock.json` with no install scripts, then rebuilds `bun.lockb` from it (`bun@1.3.11`, as CI's `lovable-install` job): updated in place, bun kept the vulnerable copy wherever a peer asked for a loose range, so Lovable's build would still have shipped it. Lockfiles are left out of the reported size. |
| Only CI workflows, scanner silencing and secrets were refused | Also refused: anything under `.github`, package-manager / git / hook / agent configuration (`.npmrc`, `bunfig.toml`, `.gitattributes`, `CLAUDE.md`, `AGENTS.md`, `.claude/`, …), changed `package.json` scripts, a package the project did not use, a dependency pointed at a URL, git repository or alias, a lockfile entry from a new host or carrying another package's tarball, symlinks and submodules, and the run's own callback key in the added lines. Tested by running the guard script on real diffs (`codex-remediation-guards.contract.test.ts`). |
| A fix PR merged on the fix workflow's own checks; the repository's CI never ran on it (GitHub starts no workflow for a PR that `GITHUB_TOKEN` opened) | The pr_merge lane **dispatches the repository's CI** (`ci.yml`, named by the workflow as `verification.ci`) on the fix branch with the App token, waits — without spending attempts, up to 3 hours — and merges only once that run passed on the verified commit (`src/server/fixCiGate.pure.ts`). A fix whose CI fails, or that changed after its checks, is **closed**, its branch deleted, and the finding reopened for a later night. |
| Merged fixes were held from the cascade until a post-merge scan | They cascade like any commit and pass the security gate (`SELF_HEALING_MERGE_TITLE`). |
| The scan and remediation master secrets were synced into repositories' Actions secrets | They never leave Mission Control; the Prime sync deletes the old copies. `ANTHROPIC_API_KEY` is synced alongside `OPENAI_API_KEY`. |

## October 2026, fourth pass: `main` protected, dependencies cleared, Node 24

| Before | Now |
|---|---|
| Mission Control's own `main` had no branch protection and no ruleset: any token with `contents: write` — the migration workflow's included — could push straight to it | Mission Control keeps a ruleset on its **own** repository's default branch (`src/server/missionControlRepo.pure.ts` says which repository; never Prime's, which `prime_config` names), **“Mission Control: protect the default branch”** (`src/server/missionControlBranchProtection.pure.ts`, applied by `mission-control-branch-protection.server.ts` through its App): no deletion, no force push, changes only through a pull request, and both of this repository's CI jobs — **“Typecheck · Lint · Build”** and **“Lovable install (bun.lockb)”**, reported by GitHub Actions — required. The nightly run creates it, and puts back anything removed from it; engine health shows it (“Protection on Mission Control's main”) and **Protect main now** applies it at once. `MISSION_CONTROL_GITHUB_REPO` (owner/repo) moves it; it refuses to act if that is Prime's repository. |
| — | Who may go past it: **Lovable's App** (it pushes to `main` directly; its App id is looked up from its bot account, 159125892, never from a name), **repository admins** and **organisation owners**. Mission Control's own App is deliberately **not** on the list: its fix merges are unattended, and GitHub refusing one whose checks did not pass is the gate on them Mission Control's code cannot get wrong. |
| — | It never protects `main` without Lovable on the list, never requires a check `ci.yml` has no job for, never rewrites a bypass list it was not shown, and never switches back on a ruleset a person switched off. A person may make it stricter; the nightly pass keeps that. |
| A fix an admin released merged without the repository's CI | It waits for the CI too, pinned to the head it ran on — GitHub would refuse it otherwise — and stays released while it waits. |
| `apply-migrations.yml` pushed the refreshed digest manifest to `main` with its own write token | It asks Mission Control (`propose_digests`, naming the repository it runs in), which opens the manifest on Mission Control's own repository as a pull request from `mission-control/applied-digests`, armed to merge itself once CI passes; a refresh asked for from any other repository is refused. The job is read-only now. The repository's “Allow auto-merge” is switched on for this. The first refresh (19 Oct 2026) read `prime_config` and opened its pull request on Prime; the nightly run closes it and deletes that branch (`retractStrayDigestProposal`). |
| The migration workflow recognised Lovable's migrations by the full address `159125892+gpt-engineer-app[bot]@…`, though the same account also commits as `lovable-dev[bot]` | It matches the account id alone, as its comment always said it did. A Lovable migration under the newer name would otherwise have run again. |
| Every run warned that its actions target Node 20: checkout v4.3.1 and setup-node v4.4.0 pinned in the codex workflows, unpinned `@v4` tags in `ci.yml`, `@v6`/`@v7` tags in the migration workflows, upload-artifact v4.6.2 in the scan | Every workflow pins the same Node 24 commits — checkout **v7.0.1**, setup-node **v7.1.0**, upload-artifact **v7.0.2** — each checked by its own `action.yml` (`runs.using: node24`) and held by `workflowActionPins.contract.test.ts`, which refuses a pin nobody recorded. Jobs that hold a secret switch setup-node's automatic dependency cache off; `ci.yml` runs with a read-only token and no credential in its checkout. Every job runs on `ubuntu-24.04`, the image it was verified on, rather than `ubuntu-latest`, which moves to Ubuntu 26 from 19 Oct 2026. |
| `npm audit` reported 9 highs: the nitro beta chain (nitro, env-runner, miniflare, sharp, undici, wrangler, `@cloudflare/vite-plugin`, Lovable's preset) and `node-forge`, which has no fix | **Zero.** nitro 3.0.260903-beta and `@cloudflare/vite-plugin` 1.64 carry fixed miniflare, sharp and undici; `node-forge` is gone — the App key's PKCS#1 → PKCS#8 wrap is plain code (`src/lib/rsa-key-pem.ts`), tested against Node's output and by signing an App JWT inside workerd. Details: `docs/AUDIT-2026-08.md`. |

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
 Mission Control                         Prime
 ───────────────                         ─────
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
| semgrep (`.github/codex-security/semgrep/` when committed, else `p/security-audit`, `p/secrets`, `p/owasp-top-ten`, downloaded and hashed) | injection, authz, unsafe APIs | rule impact/likelihood, else the rule's level | 0.8 with autofix, else 0.4 |
| osv-scanner | vulnerable dependencies | `max_severity`, else scored CVSS vector, else database severity | 0.9 when a fixed version exists |
| Codex CLI (optional, read-only sandbox, schema-checked answer) | logic-level flaws rules can't express | model-assigned, clamped to the enum | model confidence, default 0.5 |

Each scanner step is `continue-on-error` — one broken scanner degrades the
scan instead of failing it — and records its own outcome in
`result_summary.scanners.<name>.status` (`ok` / `failed` / `skipped`, with a
reason). The scan drawer, the fleet table ("Degraded") and engine health all
read it. Suppression files (`.gitleaks.toml`, `.gitleaksignore`,
`.semgrepignore`, `osv-scanner.toml`) and inline suppressions (`nosemgrep`,
gitleaks' allow comment) are honoured and reported in
`result_summary.suppressions` — except that a pull request is scanned with
the base's suppression files, and its edits to them are listed instead.

To pin semgrep's rules, commit them under `.github/codex-security/semgrep/`
(for example the three packs, fetched once from
`https://semgrep.dev/c/p/<pack>`). Scans then run exactly those files until
someone changes them, and a pull request that does is flagged on its check.
The cost: new registry rules arrive only when the files are refreshed.

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
| pg_cron `0 7 * * *` | `POST /hooks/codex-nightly` | Prime, a full scan (when `codex_nightly_enabled` on `prime_config`) |
| pg_cron `*/10 * * * *` | `POST /hooks/codex-sweep` | Re-dispatch stranded jobs, retire hung runs, then start the night's fixes once the scan has completed |
| Operator | `/security/scans` | **Scan Prime now** |

Pull requests, pushes and clones are not scanned (`src/lib/codex-scan-policy.ts`).

Both cron endpoints authenticate with `CRON_SECRET` as a Bearer token.

The sweeper re-dispatches a `queued` job that has sat undispatched for 10
minutes, backing off 5/10/15 minutes across at most 3 attempts, then fails
it. A `running` job with no terminal callback after 75 minutes (the workflow
itself times out at 60) is failed as `scan_timeout`; one never started after
6 hours is failed too. Either way its PR check, if any, is completed.

## Remediation — how a finding gets fixed

Mission Control never edits code itself; it starts an agent on Prime's own
runner, and the agent's patch must survive the workflow's guards, the
repository's checks and the repository's CI before it merges. Nobody
reviews it, by policy. **Draft Fix PR** starts the same pipeline for one
finding now.

```
 Mission Control                          Prime
 ───────────────                          ─────
 nightly scan completes
 /hooks/codex-sweep → dispatchAutomaticFixes
   ├── claim the scan (autofix.dispatched)
   ├── pick open findings, worst first, ≤ codex_autofix_max_per_night
   └── startRemediation (per finding) ───► codex-remediation.yml
        engine: Claude for P0/P1,            ├─ checkout base_ref (no stored token)
        Codex for P2 and below               ├─ claude -p --bare --restricted   (P0/P1)
                                             │  or codex exec --sandbox workspace-write
                                             │    ← edits real files, no network
                                             ├─ regenerate package-lock.json (no install scripts),
                                             │  rebuild bun.lockb from it
                                             ├─ stage in a pristine copy of .git → fix.patch
                                             ├─ refuse CI / config / dependency / link /
                                             │  silencing changes
                                             ├─ gitleaks + callback key on ADDED lines ─ HARD STOP
                                             ├─ checks on base + patch, as user `fixcheck`
                                             │    fail ─► report, push nothing
                                             ├─ commit from fix.patch in a fresh repo + push
                                             └─ gh pr create --draft (names ci.yml)
                                                     │
 /api/public/hooks/codex-remediation ◄──────────────┘
   └── persist PR, verification (+ ci), size, engine, model
                │
 self-healing pr_merge lane (every 2 minutes)
   ├── PR is the fix's own branch, at the verified commit
   ├── decideFixMerge: verified, no secret, ≤ 10 files, ≤ 400 lines
   ├── dispatch ci.yml on the fix branch ─► CI (App token, so it runs)
   ├── wait (attempt-neutral, ≤ 3 h) until it passed on that commit
   └── mark ready, squash-merge pinned to that commit, delete the branch
        (otherwise: close the PR, delete the branch, reopen the finding)
                │
        cascade to the fleet
                │
        next nightly scan ── finding gone? ── fix_confirmed_at
```

### The engines

| | Claude Code | OpenAI Codex CLI |
|---|---|---|
| Fixes | P0, P1 (critical, high) | P2, P3, P4 (medium, low, info) |
| Package | `@anthropic-ai/claude-code@2.1.289` | `@openai/codex@0.160.1` |
| Runs as | `claude -p --bare --restricted --tools "Read,Glob,Grep,Edit,Write" --permission-mode acceptEdits --permission-prompts none --strict-mcp-config` | `codex exec --sandbox workspace-write --ephemeral` |
| Can | read and edit files in the checkout | read the runner, write the checkout, run commands without network |
| Cannot | run commands, reach the web, write outside the checkout, write settings, git or package-manager files | reach the network |
| Key | `ANTHROPIC_API_KEY`, in its step only | `OPENAI_API_KEY`, in its step only |
| Limits | 30 minutes, 100 turns, `CLAUDE_FIX_MAX_BUDGET_USD` (default $10) | 30 minutes |

Both are installed, pinned, before any key is in reach, and get the same
prompt: the finding's title, severity, location, CWE, description, scanner,
rule and offending excerpt, framed as material to work on rather than
instructions. The repository variable `CLAUDE_FIX_MODEL` picks Claude's
model (unset: the CLI's default) and `CLAUDE_FIX_EFFORT` its effort
(default `high`). Each remediation row records its `engine`, and Claude's
records the `model` that did most of the writing.

### What stands between the model and Prime's `main`

| Guard | Behaviour |
|---|---|
| Secrets | gitleaks scans the lines the patch adds, and so does a check for the run's own callback key. A patch adding a secret is **never pushed**. |
| CI and automation | A patch touching anything under `.github` — workflows, local actions, the scripts they call — is refused. |
| Configuration | A patch touching package-manager, git, hook or agent configuration is refused: those decide what installs and runs, and what the next agent reads. |
| Dependencies | Changed `package.json` scripts are refused; so is a package the project did not already use, a dependency pointed at a URL, git repository or alias, and a lockfile entry from a new host or carrying another package's tarball. |
| Links | A symlink or a submodule is refused. |
| Scanner silencing | An added inline suppression, or an edit to `.gitleaks.toml`, `.gitleaksignore`, `.semgrepignore`, `osv-scanner.toml` or `.github/codex-security/`, is refused. |
| Credentials | Each API key exists only in its agent's step; `GITHUB_TOKEN` only in the push and PR steps, which never run git in the checkout. The job's temporary directory is closed to other users. |
| Checks | install (`npm ci` when a lockfile exists), typecheck, lint, test, build — whichever `package.json` defines — on the base plus the patch, as `fixcheck`, whose leftover processes are killed. A fix that fails is not pushed. |
| Repository CI | Dispatched by Mission Control on the fix branch; the fix merges only once it passed on the verified commit. GitHub enforces the same two checks on `main` (the ruleset above), and Mission Control's App cannot bypass them. |
| Size | At most 10 files and 400 lines, lockfiles not counted (`decideFixMerge`). |
| Pinning | The merge is pinned to the commit the checks and CI ran on; a push to the branch closes the fix. |
| Retries | A declined fix is closed, its branch deleted, the finding reopened. Automatic attempts that did not merge count: two in 30 days, then the finding waits for a person. |
| Fix confirmation | When a later full scan no longer reports the finding, the remediation is stamped `fix_confirmed_at`; if it still does, the finding reopens as "fix ineffective". |

### Failure modes, and what each one leaves behind

| Outcome | Result |
|---|---|
| No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` on Prime | The run fails at once, naming the secret sync; the finding returns to `open`. |
| The agent changes nothing (e.g. judges it a false positive) | `workflow.failed` with the agent's reasoning from `CODEX_FIX_NOTES.md`; no PR. |
| The agent stops early (turn or budget limit, timeout, error) | `workflow.failed` naming why; nothing pushed. |
| The lockfiles cannot be regenerated | `workflow.failed` with npm's or bun's error; nothing pushed. |
| A guard refuses the patch | `workflow.failed` naming what it touched; nothing pushed. |
| The checks fail | `workflow.failed` naming the failed checks, with their output; nothing pushed. |
| CI fails, or does not finish within 3 hours, on the fix | The PR is closed with the reason, its branch deleted, the finding reopened. |
| GitHub refuses the merge (conflict with an earlier fix, a rule on `main` the merge does not meet) | As above; the finding is tried again on a later night against the new `main`. |
| Workflow dies at any point | Remediation `failed`, the finding returned to `open`. |

### Following one

`/security/scans#fix-prs` lists the fixes in flight with their engine, PR,
and what each is waiting for — "Waiting for CI — `.github/workflows/ci.yml`
is in_progress on the fix" — and the scan-detail sheet shows, per finding,
the engine, blast radius, secret scan, each check and the CI. Declined and
failed fixes notify operators (`remediation_failed`); merged ones
`remediation_auto_completed`.

## Secrets

| Name | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | yes | Installation needs **Actions: read & write**, **Secrets: read & write**, **Contents** and **Pull requests: read & write**, **Checks: read & write** for PR checks, and **Administration: read & write** to keep `main` protected (rulesets, “Allow auto-merge”). |
| `CRON_SECRET` | yes | Mirror into Postgres: `ALTER DATABASE postgres SET app.settings.cron_secret = '…';` |
| `PUBLIC_APP_URL` (or `APP_PUBLIC_URL`) | recommended | Origin the scanner posts results back to. |
| `CODEX_SECURITY_WEBHOOK_SECRET` | optional | The scan **master**: per-job keys are derived from it, it never leaves Mission Control. Falls back to the auto-generated secret on the built-in `codex` row of `security_intake_sources`, which "Rotate signing key" on engine health replaces (the previous value keeps working for 24 hours). |
| `CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS` | optional | The scan master being rotated out, still accepted. Remove it a day after the rotation. |
| `CODEX_REMEDIATION_WEBHOOK_SECRET` | optional | The remediation master. Falls back to the scan master. |
| `CODEX_REMEDIATION_WEBHOOK_SECRET_PREVIOUS` | optional | As above, for the remediation master. |
| `ANTHROPIC_API_KEY` | **required for P0/P1 fixes** | Synced into Prime's Actions secrets by the Prime secret sync. Without it, critical and high findings cannot be fixed. |
| `OPENAI_API_KEY` | optional for scans, **required for P2 and below fixes** | Synced into Prime's Actions secrets. Without it, scans still run gitleaks/semgrep/osv-scanner; medium and low findings cannot be fixed. |

The masters never leave Mission Control: each scan job and remediation is
dispatched with a key derived for it alone, and the Prime sync deletes any
copy of a master an earlier version left in Prime's Actions secrets. Clones
hold no Codex secrets; the clone and fleet syncs remove them.

Repository variables on Prime (all optional): `CLAUDE_FIX_MODEL`,
`CLAUDE_FIX_EFFORT`, `CLAUDE_FIX_MAX_BUDGET_USD`, and `FIX_CI_WORKFLOW` (the
CI the merge lane runs on each fix, default `ci.yml`).

## Bringing it up

1. Apply the migrations (they apply on merge to `main`), including
   `20261018120000_codex_autofix_settings.sql`.
2. Merge `.github/workflows/codex-security-scan.yml` and
   `.github/workflows/codex-remediation.yml` to Prime's `main`. Engine health
   reads both and reports their versions.
3. Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in Mission Control, then run
   the **Actions secret sync for Prime** in Settings. Run the fleet sync once
   to remove the Codex secrets from the clones.
4. Make sure Prime's `ci.yml` keeps its `workflow_dispatch` trigger (engine
   health's "CI that fixes must pass" check). Give the App **Administration:
   read & write** and press **Protect main now** (or wait for the night): the
   ruleset requires exactly `ci.yml`'s two jobs, which the merge lane runs on
   every fix. Any other required check you add must also run on a fix PR — one
   that never runs (for example the retired "Codex Security" PR check) makes
   GitHub refuse every merge.
5. **Rotate both master secrets** (engine health): earlier versions synced
   them into repositories' Actions secrets.
6. Open **/security/scans**, read the **Engine health** card, and click
   **Scan Prime now**. Once it completes, the next sweep starts the night's
   fixes; **Automatic fixes** in the scheduling panel turns them off.

## Verifying without waiting for cron

```bash
# nightly scan of Prime
curl -X POST https://<mission-control>/hooks/codex-nightly \
  -H "Authorization: Bearer $CRON_SECRET"

# sweeper (also starts the night's fixes once the scan has completed)
curl -X POST https://<mission-control>/hooks/codex-sweep \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Performance notes

- Fleet overview moved from "fetch 500 jobs + every open finding, group in
  JS on each 30s poll" to the `codex_fleet_overview()` RPC, which does the
  `DISTINCT ON` and severity roll-up against partial indexes.
- The nightly run is one scan of Prime; the fleet pays nothing for it.
- The partner bridge went from 3 queries per finding to one lookup plus two
  batched writes.
- Each fix is one Actions run on Prime plus one CI run, and each merge one
  cascade, which is why `codex_autofix_max_per_night` paces a backlog.
