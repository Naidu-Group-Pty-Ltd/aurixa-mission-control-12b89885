# Handoff — Airtable intake to the clones, the Actions policy and the `pdf-extraction-v3` gate

**Written 19 Oct 2026, 14:05 UTC, for whoever continues this in another account.**
It is self-contained: read it first, then
[`AIRTABLE_CASCADE_HANDOVER_2026-10-19.md`](./AIRTABLE_CASCADE_HANDOVER_2026-10-19.md)
for the detailed findings F1–F10 this one builds on. Nothing below needs the
session that wrote it; every state is a thing you can re-read, and every step
is a command you can run.

The session's GitHub identity was `mithrubanbupathy3-design`; every branch it
pushed is named `claude/serene-gates-b7f5pi*`. Its last acts were read-only
except for pushing one parked work-in-progress branch (§4) and this document.

---

## 0. What you need

| Access | Used for |
|---|---|
| GitHub, org `Naidu-Group-Pty-Ltd`: `npc-property-dashbord` (Prime), `aurixa-mission-control-12b89885` (Mission Control, MC), `npc-client-dashboard`, `npc-crm-independent-6505dc` | merging, pushing, reading Actions |
| Organisation Actions settings (owner) | the allow-list in §6 |
| MC's database — Lovable project `0fb4d803-5071-4093-be25-5afbcf116476` (`query_database`), or the MC Supabase project's SQL editor | reading `clones`, `cascade_results`, `cascade_events`, `clone_backend_secrets`, `prime_secret_forwards` |
| Supabase projects: Prime `dduzbchuswwbefdunfct`, NPC Client Dashboard `plisdzywzleljorrphxv`, NPC CRM Independent `qvuwrvwzjyigptmnijyb`, NPC Test `umrtusxohxjxzodxorim`, Preflight `egrmsulhtmqnmhvuccxr` | verifying the `listings-cache` sync on each deployment |
| Airtable: live base `appFNPL7iYiuQyHAO`, table **Property Intake Master** `tblumTIRYBn92B2ST` (680 records when measured); retired `apptyShYE0yzL4IGB` / `tblWIg5cs85O30pcY` | the value every clone must end up syncing |

Two things about tooling that cost time this session. From a Claude Code
session GitHub's GraphQL is refused (`gh pr view`, `gh pr merge` fail with
403); the REST routes work (`gh api repos/{owner}/{repo}/pulls/{n}`,
`gh api -X PUT …/pulls/{n}/merge`). From a normal shell both work. And MC's
database column names must be read from `information_schema.columns` before
they are used in a query — several were guessed wrong earlier.

---

## 1. State at handoff (14:03 UTC, 19 Oct 2026)

| Piece | Where | State |
|---|---|---|
| Prime: every action pinned to a commit SHA; Deno 2.9.7 and the Supabase CLI 2.121.0 installed from their own releases with sha256 checks | [PR #3342](https://github.com/Naidu-Group-Pty-Ltd/npc-property-dashbord/pull/3342), branch `claude/serene-gates-b7f5pi-pin-actions`, head `f2eef8809aefe43b8f12964c8305be856aa456a7`, base `main@6bd6e863` | **Ready to merge.** CI 9084 (run `39260469123`) finished green on every job. `mergeable_state: unstable` only because the non-required `pdf-extraction-v3-gates / static-and-fast` check is red (§3, F11). **Merge this first.** |
| Prime: `listings-cache` sheds the unread bulk columns as each page arrives (the 57 MB "Memory limit exceeded" fix) and the marketplace reads the deployment's own table | [PR #3341](https://github.com/Naidu-Group-Pty-Ltd/npc-property-dashbord/pull/3341), branch `claude/serene-gates-b7f5pi`, head `efeead420b6046ae8585d4a5822253473d78dcb9` | Ready, CI 9082 green. Carries #3342's commits (its body says so). **Merge second**, with a merge commit. |
| Prime: fix for the never-passing `pdf-extraction-v3-gates` check | branch `claude/serene-gates-b7f5pi-pdf-v3-gate`, head `fc5af9ed`, two WIP commits on `f2eef880`, **no pull request** | Parked, half built (§4). |
| MC: a forwarded configuration value follows MC's value (`FLEET_CONFIGURATION` + `refresh`) | [PR #345](https://github.com/Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885/pull/345), branch `claude/serene-gates-b7f5pi`, head `79d00c37` (this document goes on top) | Green, `mergeable_state: clean`. **Deliberately not merged** until Prime's fix is on every clone (§2 step 7 explains the order). |
| Clone `npc-client-dashboard`: cascade `prime@6bd6e86` + three hand commits (pins, the held `App.tsx` reconcile, the Supabase CLI step) | [PR #379](https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/379), branch `aurixa/cascade-70132e8-mvb39lqx`, head `06d2d096969172a797bc3754ac05de424f6f8aef` | CI 1307 green. **Held by MC's merge drain** on `static-and-fast` (red, run 62 at 13:03 UTC). Never convert it to a draft. |
| Clone `npc-crm-independent`: its 30 workflows pinned, Deno and Supabase CLI from releases | [PR #123](https://github.com/Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc/pull/123), branch `claude/serene-gates-b7f5pi-crm-pin-actions`, head `86a9fa5b86bca6995e6ed6bc7d9bb3b4bebc6db6`, base `main@6322c63e` | **Ready to merge.** CI 630 (run `39260237971`) green on all six jobs — the first full green run in that repository. |
| Clone `npc-crm-independent`: cascade `prime@0da692c` | [PR #121](https://github.com/Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc/pull/121), head `25acc6eb`, base `main@6a0601dc` | Red for its own reasons (F10 in the findings doc). MC's engine is re-pushing it: four `cascade_results` rows `pushing` (started 13:32–13:41 UTC, events `0b329741`, `d9fd07ee`, `0aa71083`, `58333aed`) and one `queued`, none completed. |
| MC cascade ledger for `npc-client-dashboard` | `cascade_results` | One `queued` row (event `0aa71083`, into which the 11:16 cascades were folded: "a commit cascade delivers prime's head at run time"). Every `pr_opened` row for #379 since 16 Oct 14:54 reads `Open · Not merging — 1 check(s) failing: static-and-fast (failure)`. |
| `clone_backend_secrets.AIRTABLE_TABLE_NAME` | all four clones | still `inherited` with the retired table value; the live value is re-sent by the `:15/:45` fleet sweep **only after** MC #345 is merged and published (§2 step 7). |
| Organisation Actions policy | enterprise/org settings | Since ~11:00 UTC: full-length SHA pins required; only GitHub-owned actions admitted. Measured by effect (F6). `google-github-actions/*` and `superfly/*` are still refused — owner's allow-list (§6). |

---

## 2. Execution plan — the remaining scope, in order

Do the steps in this order. Steps 1–2 are one command each. Step 3 is the
piece of work. Steps 4–8 are mostly waiting and verifying.

### Step 1 — merge Prime #3342 (pins, Deno, Supabase CLI)

```sh
gh pr merge 3342 --repo Naidu-Group-Pty-Ltd/npc-property-dashbord --merge \
  --match-head-commit f2eef8809aefe43b8f12964c8305be856aa456a7
# From a Claude Code session (GraphQL refused), the same through REST:
gh api -X PUT repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/pulls/3342/merge \
  -f merge_method=merge -f sha=f2eef8809aefe43b8f12964c8305be856aa456a7
```

Merge commit, never squash: Prime's steward convention. Then watch the first
production run of the from-release Supabase CLI step:

```sh
gh run list --repo Naidu-Group-Pty-Ltd/npc-property-dashbord \
  --workflow deploy-supabase-functions.yml --limit 3
```

Acceptance: `deploy-supabase-functions` on `main` completes green; its
"Install the Supabase CLI" step prints `2.121.0`.

### Step 2 — merge Prime #3341 (the `listings-cache` memory fix)

```sh
gh pr merge 3341 --repo Naidu-Group-Pty-Ltd/npc-property-dashbord --merge \
  --match-head-commit efeead420b6046ae8585d4a5822253473d78dcb9
```

Acceptance: `deploy-supabase-functions` deploys `listings-cache` (it is on the
changed-function list because `supabase/functions/listings-cache/**` changed);
in the Prime Supabase project (`dduzbchuswwbefdunfct`) the next `listings-cache`
run finishes with HTTP 200 rather than 546, and its sync record names
`tblumTIRYBn92B2ST` with about 680 live records.

### Step 3 — make `pdf-extraction-v3-gates / static-and-fast` pass, at the Prime

This is the blocker for the clones: MC's merge drain reads **every** check on a
cascade pull request and holds #379 on this one. The check has **never
passed** (F11). Fix it at the Prime; the cascade carries the fix to every
clone. Never patch it on a clone (the next cascade reverts a clone-side edit
to a file the prime also holds).

Three independent faults, each sufficient on its own; §3 has the evidence:

- **F11** the scanner's rules flag names, not values — 1,949 findings on a
  clean tree;
- **F12** `environment-profile.mjs` looks for Chromium at the author's sandbox
  path, so on a GitHub runner the fast tier reads `unavailable → blocked`
  even after `npx playwright install chromium`;
- **F14** the e2e cannot load under Playwright's loader because one import
  names a directory that carries a `package.json`.

Start from the parked branch (§4 says exactly what is in it):

```sh
git fetch origin
git checkout claude/serene-gates-b7f5pi-pdf-v3-gate
git rebase origin/main          # after step 1; main then carries f2eef880
```

3a. **Refine the storage-signature rule** in
`scripts/regression/pdf-extraction-v3/artifactScanRules.mjs`. Measured over
all 11,713 tracked files the module reports exactly one finding — a spec
fixture, `https://bucket.s3.amazonaws.com/x?X-Amz-Signature=1` in
`src/lib/agent/__tests__/amlCommandCentre.spec.tsx`. A URL naming one
signature parameter is not a signature. Make `STORAGE_SIGNATURE_RE` a parser
instead: parse the URL and count it only when it carries the scheme's complete
set — S3 SigV4 `X-Amz-Algorithm + X-Amz-Credential + X-Amz-Date + X-Amz-Expires
+ X-Amz-Signature` (expiry = Date + Expires), S3 V2 `AWSAccessKeyId + Expires +
Signature` (epoch), GCS V4 `X-Goog-Algorithm + X-Goog-Credential + X-Goog-Date
+ X-Goog-Expires + X-Goog-Signature`, Azure SAS `sig + se (+ sv)`. Complete and
unexpired → finding; complete and expired → `notes` (reported, never failing),
the same treatment the Supabase `object/sign` rule already gives; incomplete →
nothing outside the programme scope, a finding inside it. Then re-measure:

```sh
node --input-type=module -e '
import { scanFiles } from "./scripts/regression/pdf-extraction-v3/artifactScanRules.mjs";
import { readFileSync, statSync } from "node:fs"; import { execSync } from "node:child_process";
const files = execSync("git ls-files",{encoding:"utf8"}).split("\n").filter(Boolean);
const r = scanFiles(files, (f)=>{ try { const size=statSync(f).size; return { size, text: size>2e6 ? "" : readFileSync(f,"utf8") }; } catch { return null; } });
console.log("findings", r.findings.length, "notes", r.notes.length); for (const f of r.findings) console.log(f.code, f.file, f.detail);'
```

Expect `findings 0`. (At `fc5af9ed` it prints `findings 1 notes 0` in 2.7 s.)

3b. **Wire the CLI onto the rules module.** Replace the body of
`scripts/regression/pdf-extraction-v3/artifact-scan.mjs` (keep its path and
its three modes `--staged`, `--dir <path>`, `--json`; keep exit 1 on any
finding):

```js
#!/usr/bin/env node
/**
 * PDF Extraction V3 · E12 — private-artifact leakage scanner (V3 CLI).
 * The rules live in ./artifactScanRules.mjs; read its header before changing one.
 * Usage: node artifact-scan.mjs [--staged] [--dir <path>] [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { scanFiles, SCAN_REPORT_VERSION, MAX_TEXT_BYTES } from './artifactScanRules.mjs';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const jsonOut = args.includes('--json');
const dirArgIdx = args.indexOf('--dir');
const scanDir = dirArgIdx >= 0 ? args[dirArgIdx + 1] : null;

function listFiles() {
  if (scanDir) {
    if (!existsSync(scanDir)) return [];
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git/.test(full)) walk(full); }
        else out.push(path.relative(ROOT, full));
      }
    };
    walk(scanDir);
    return out;
  }
  const cmd = stagedOnly ? 'git diff --cached --name-only --diff-filter=ACMR' : 'git ls-files';
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean); }
  catch { return []; }
}

function read(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  try {
    const size = statSync(full).size;
    return { size, text: size > MAX_TEXT_BYTES ? '' : readFileSync(full, 'utf8') };
  } catch { return null; }
}

// Everything under a --dir is programme scope: that mode scans report and evidence directories.
const { findings, notes } = scanFiles(listFiles(), read, { scopeAll: scanDir !== null });
const report = {
  version: SCAN_REPORT_VERSION,
  scanned: stagedOnly ? 'staged' : (scanDir ?? 'tracked'),
  leakCount: findings.length,
  findings,
  noteCount: notes.length,
  notes,
};

if (jsonOut) console.log(JSON.stringify(report, null, 2));
else if (findings.length === 0) {
  console.log(`✓ artifact-scan: no private-artifact leaks (${report.scanned})`);
  for (const n of notes) console.log(`  note [${n.code}] ${n.file}: ${n.detail}`);
} else {
  console.error(`✗ artifact-scan: ${findings.length} leak(s) detected (${report.scanned})`);
  for (const f of findings) console.error(`  - [${f.code}] ${f.file}: ${f.detail}`);
}
process.exit(findings.length === 0 ? 0 : 1);
```

3c. **Detect Chromium the way Playwright resolves it** in
`scripts/regression/pdf-extraction-v3/environment-profile.mjs`:

```js
import { createRequire } from 'node:module';

/**
 * The pinned path is this repository's own pre-installed browser (the author's
 * sandbox, PW_CHROMIUM_PATH overrides). Where it is absent — every GitHub
 * runner — the browser `npx playwright install chromium` put down is the one
 * Playwright itself resolves, so ask Playwright. Measured 19 Oct 2026: the old
 * check read `hasChromium: false` on every CI run, so the fast tier recorded
 * its browser checks `unavailable` and the gate decided `blocked`.
 */
function resolveChromium() {
  const pinned = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  if (existsSync(pinned)) return pinned;
  try {
    const { chromium } = createRequire(import.meta.url)('playwright-core');
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch { /* Playwright is not installed here: there is no browser to find. */ }
  return null;
}
// in detectEnvironmentProfile():
//   const chromiumPath = resolveChromium();
//   const hasChromium = chromiumPath !== null;
```

`playwright.config.ts` already pins `executablePath` to the same pinned path
when it exists and otherwise uses Playwright's own browser, so the detector and
the config agree.

3d. **Install the browser with its system libraries** in
`.github/workflows/pdf-extraction-v3-gates.yml`: all three
`npx playwright install chromium` lines become
`npx playwright install --with-deps chromium`. A browser whose libraries are
missing fails at launch, which the gate would report as a real failure.

3e. **The e2e's directory import is already fixed** on the branch
(`src/lib/reportTemplate/qrCodeEncoder.ts` imports
`../security/vendor/qrcode/index.js`). With it, locally:
`npx playwright test --config=playwright.config.ts tests-e2e/pdf-extraction-v3`
→ `2 passed (10.2s)`.

3f. **Write the spec**
`src/lib/reportTemplate/ingestion/releaseV3/__tests__/artifactScan.spec.ts`
(that directory is what the static tier's vitest step runs, so the gate
exercises its own scanner). Import `scanFiles`/`scanText`/`classifyPath` from
`../../../../../../scripts/regression/pdf-extraction-v3/artifactScanRules.mjs`
— `src/lib/ops/__tests__/migrationDrift.spec.ts` imports an `.mjs` the same way
and needs no declaration file. **Build every planted value at runtime** (a
service-role JWT from a base64url-encoded payload, a PEM block from a header
plus a repeated base64 line, a vendor token from a prefix plus a generated
suffix, a signed URL with `exp` = now + 1 day) so the spec file itself holds no
leak-shaped literal and needs no exemption. Cases to pin, flagged ↔ not:

- service-role JWT flagged; anon JWT (`role: anon`) not; a JWT with no role not;
- PEM header followed by key material flagged; a bare header (placeholder,
  regex, template literal) not;
- a vendor format flagged (`sk-ant-…`, `AKIA…`, `pat….<64 hex>`);
- `apiKey: "<40 random hex>"` flagged; `password: 'Harbour…'` (20 chars) not;
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` not;
- Supabase `object/sign?token=<JWT exp future>` flagged; `exp` past → in
  `notes`, not in `findings`; the same past token inside `reports/x.json`
  flagged (programme scope);
- `?token=<JWT>` on an arbitrary host not flagged; a complete S3 V4 signature
  set flagged, one lone `X-Amz-Signature=1` not;
- `public/brand/mark.png` not flagged; `reports/pdf-extraction-v3/page.png`
  flagged; `tests-e2e/pdf-extraction-v3/.pdf-v3-tmp/a.pdf` not;
- `.env` flagged, `.env.example` not;
- `blob:https://…` in `src/lib/__tests__/x.spec.ts` not, in a `--dir` scan
  (`scopeAll: true`) flagged;
- `data:image/png;base64,<300 chars>` in `src/assets/x.svg` not, inside the
  programme scope flagged; `data:application/pdf;base64,<300>` flagged anywhere;
- `projects/p/locations/us/processors/x` and `https://x-abc.run.app` flagged;
- `scripts/security/check-security-gate-negatives.mjs` and `.gitleaks.toml`
  are text-scan exempt (they hold a planted Google API key on purpose).

3g. **Docs.** In `docs/pdf-import/extraction-v3-e12-golden-release-gates.md`:
§13 says what V3 judges (values, programme scope, notes vs findings, the named
exemptions) and records the 19 Oct measurement; §14 notes that Chromium is
resolved through Playwright and installed `--with-deps`; §19 adds that the
static tier's `--staged` scan sees nothing in CI (no staged diff) and that the
tracked-tree scan step before it is the one that counts.

3h. **Prove it locally before pushing:**

```sh
node scripts/regression/pdf-extraction-v3/artifact-scan.mjs            # ✓ … no private-artifact leaks (tracked)
npm run pdf-import:v3:gate:static                                       # exit 0, releaseReady true
npx playwright install chromium   # or rely on /opt/pw-browsers/chromium where it exists
npm run pdf-import:v3:gate:fast                                         # exit 0, releaseReady true
npx vitest run src/lib/reportTemplate/ingestion/releaseV3/__tests__     # old suite + the new spec
npx tsc --noEmit -p tsconfig.app.json && npm run lint
```

3i. **Open the PR as a draft, mark it ready once, merge on green** (the
steward convention; a draft runs the fast lane, ready runs the full gate). The
paths filter of `pdf-extraction-v3-gates` matches the changed files, so
`static-and-fast` runs on this PR — its first green run ever is the proof that
the clones' hold will lift. Merge with a merge commit.

### Step 4 — let MC refresh and merge the cascades

Nothing to do by hand. When Prime `main` moves, MC's commit cascade delivers
Prime's head into #379 (and `npc-crm-independent` #121) at run time; the
refreshed heads carry the fixed scanner, `static-and-fast` runs on them and
passes, and the drain merges (`merge_method: "merge"` — the cascade commit
names the prime SHA; never squash a cascade PR). Watch it:

```sql
select c.name, r.status, r.pr_url, r.completed_at, left(r.diff_summary, 200)
from cascade_results r join clones c on c.id = r.clone_id
order by r.completed_at desc nulls first limit 20;
```

The hold reason lives in `diff_summary`; it should stop saying
`Not merging — 1 check(s) failing: static-and-fast`. Preflight Property Group
and NPC Test are children of `npc-client-dashboard` in the lineage and follow
once #379 is on its `main`. If a refreshed #379 still fails that check, read the
run's log: the gate now fails only for a reason it names.

### Step 5 — the CRM-independent line

5a. Merge #123 (green):

```sh
gh pr merge 123 --repo Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc --merge \
  --match-head-commit 86a9fa5b86bca6995e6ed6bc7d9bb3b4bebc6db6
```

5b. #121 is red for its own reasons (F10 in the findings doc): the engine's
tree disagrees with files the clone deliberately holds —
`googleMapsProxies.security.test.ts` against the removed `street-view`,
`stepUpPasswordAssured.spec.ts` against `messaging-hub/recovery.ts`,
`supabaseJsVersionPins` (its FROZEN list of 13 GoHighLevel functions and
`voice-automation-settings`), `phantomColumnWrites`, and the security
inventory. Each is a `manual_reconcile` on that clone, done once, naming
`prime@<sha>` in the commit, **after** the engine finishes re-pushing #121
(wait for the four `pushing` rows to complete; touching the branch underneath
the engine is what produced "Already proposed — PR #121 carries this exact
tree" loops before). Four of its workflows still name `google-github-actions/*`
or `superfly/*` and cannot start until §6.

### Step 6 — only after Prime's fix is on all four clones: merge MC #345

Order is load-bearing (F4): #345 makes the `:15/:45` fleet sweep re-send
`AIRTABLE_TABLE_NAME=tblumTIRYBn92B2ST`; a clone whose `listings-cache` still
holds the 57 MB pages fails with "Memory limit exceeded" the moment it is
pointed at the live table. So:

```sh
gh pr merge 345 --repo Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885 --squash \
  --match-head-commit <head after this document's commit>
```

MC squash-merges its own PRs. Then publish MC from Lovable
(`deploy_project` on `0fb4d803-5071-4093-be25-5afbcf116476`, or the Lovable
editor's Publish). The next sweep after publish writes the value; verify:

```sql
select c.name, s.name, s.source, left(s.value, 3) as value_prefix, s.updated_at
from clone_backend_secrets s join clones c on c.id = s.clone_id
where s.name = 'AIRTABLE_TABLE_NAME' order by c.name;
```

(Read the real column names from `information_schema.columns` first.)

### Step 7 — verify every clone syncs the live table

On each clone's Supabase project, the next `listings-cache` run must finish
HTTP 200 (no 546), and its sync record must name `tblumTIRYBn92B2ST` with the
live count (~680 at Prime). `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` stay
**withheld** on every clone — the read is brokered by MC
(`GET /api/public/listings/{tables|records|selftest}`); only
`AIRTABLE_TABLE_NAME` travels. If a clone's broker read answers a refusal,
`AIRTABLE_KEY_OWNERSHIP.md` in Prime's `docs/integrations/` has the rule and
F1 in the findings doc has the measured failure.

### Step 8 — update the findings document and close

Append the merges and their timestamps to the "Where things stand" table in
`AIRTABLE_CASCADE_HANDOVER_2026-10-19.md`, and record the first green
`static-and-fast` run number.

---

## 3. Findings new since the findings document (F11–F14)

### F11. `pdf-extraction-v3-gates / static-and-fast` has never passed, and it is what holds the cascade

- MC's `autoMergeGate.pure.ts` (`REQUIRED_CHECKS = ["verify","security"]`,
  line 86) reads **all** check runs on the head; any completed non-passing
  check is `failing`; `reclassifyAgainstBase` names it `base_broken` only when
  the same check, **by name**, fails on the base. `main`'s scheduled job is
  named `generated-full`, the PR job `static-and-fast`, so the names never
  match and the reason stays `failing`. `cascadeMergeDrain.server.ts`
  880–906 then calls `writeReconciliation(...)` and returns `held` — which is
  the `Not merging — 1 check(s) failing: static-and-fast (failure)` in every
  `pr_opened` row for #379 since 16 Oct 14:54.
- #378 merged (by `aurixa-mission-control[bot]`, 16 Oct 14:42) because the
  workflow has a `paths:` filter (`src/lib/reportTemplate/ingestion/releaseV3/**`,
  `scripts/regression/pdf-extraction-v3/**`, `tests-e2e/pdf-extraction-v3/**`,
  the workflow file) and #378 touched none, so no `static-and-fast` check
  existed on it. #379 carries Prime's pin commit, which edits the workflow
  file, so the check runs — and fails.
- It has failed **12 of 12** pull-request runs on Prime since the workflow was
  created (run 1, 24 Jul 2026, by `lavan96`; codex runs 3–4; dependabot
  23/82/84; this session's 94–99) and every scheduled run on
  `npc-crm-independent` `main` (22–29) and Prime `main` (90–93).
- Prime's branch protection does **not** require it (#3341 and #3342 are
  `unstable`, not `blocked`), so Prime's own merges proceed; only MC's drain
  is blocked by it.
- The V2 scanner, run on Prime's tracked tree (19 Oct): **1,949 findings** —
  `credential` 1,661 (every `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`, every
  `password:` column in a migration: the *name* of a secret), `signed_url` 209
  (`jsonwebtoken` inside registry URLs in `bun.lock`/`package-lock.json`,
  email click-tracking links in the Airtable migration dumps, inline data URIs
  in brand SVGs and sample fixtures), `private_media_committed` 46
  (`public/brand/*.png`, `public/icons/*`, `public/templates/*.pdf|jpg`),
  `font_or_model_binary_committed` 12 (`public/fonts/*`), `bearer_token` 20
  (test fixtures), `env_file` 1 (`.env.example`). Nothing it reported was a
  leak.
- What a value-based rule set finds on the same tree (measured, values never
  printed): the three `-----BEGIN … PRIVATE KEY-----` strings are a
  placeholder label (`src/lib/integrations/registry.ts`), a regex and a
  template literal (`docusign-auth.ts`, `manage-agency-agreements/index.ts`),
  with no key material in any of the three files; the bearer and
  secret-literal hits are test fixtures of 16–28 characters; the 38 JWTs with
  a role are all `anon` (the published key); 204 JWT-shaped tokens with no role
  (and 816 in all) are email click-tracking tokens (payload `exp`, `id`,
  `url`) in `docs/integrations/airtable/npc-emails/migration/pass1-create/
  emails.batch-*.json`, with expiries in the future — they open nothing; no
  Supabase `object/sign` URL in the tree carries a JWT at all (every one is a
  fixture like `?token=abc`); the only well-known vendor token format present
  is the Google API key deliberately planted in
  `scripts/security/check-security-gate-negatives.mjs` and allow-listed in
  `.gitleaks.toml`. **No committed secret was found.**

### F12. The fast tier can never reach the browser on a runner

`environment-profile.mjs` sets `hasChromium = existsSync(process.env.PW_CHROMIUM_PATH
|| '/opt/pw-browsers/chromium')` — the author's sandbox path (a symlink to a
Chromium 1194 build there), never present on a GitHub runner, where
`npx playwright install chromium` puts the browser where
`playwright-core`'s `chromium.executablePath()` resolves it
(`~/.cache/ms-playwright/chromium-<build>/…`). So the fast tier records
`quality.browser-evidence` and `export.parity` as `unavailable`, the decision
is `blocked`, `releaseReady` is false and the step exits 1 — even once the
scanner is fixed. Fix in §2 step 3c.

### F13. The CRM cascade loops on the invocation budget

`cascade_results` for `npc-crm-independent` repeats "Paused at the invocation
budget — 4 of 985 file(s) prepared; the rest resume next tick" (16–17 Oct) and
"Already proposed — PR #121 carries this exact tree (854 file(s))"; today the
four `running` events each hold a `pushing` row started 13:32–13:41 UTC with
`pr_url` null and `files_changed` 0, plus one `queued`. The engine is doing
what it says; do not touch the branch under it (§2 step 5b).

### F14. The e2e could not load under Playwright, for one import

`tests-e2e/pdf-extraction-v3/generated-corpus.e2e.ts` imports the renderer,
which imports `qrCodeEncoder.ts`, which imported `../security/vendor/qrcode` —
a directory that carries a `package.json`. Playwright's resolver hands a
directory with a `package.json` to Node ("let Node.js figure out the correct
import"), and Node's ESM loader refuses a directory path
(`ERR_UNSUPPORTED_DIR_IMPORT`), so Playwright reported `No tests found` and
exited 1. The other directory imports in that graph (`./blocks`, `./adapters`,
`../cdir` …) have no `package.json` and resolve to their `index.ts`. With the
import written as `../security/vendor/qrcode/index.js` both tests pass locally
(2 passed, 10.2 s). The fault was invisible in CI only because F12 stopped the
e2e from ever being attempted there.

---

## 4. The parked branch: `claude/serene-gates-b7f5pi-pdf-v3-gate`

Two work-in-progress commits on top of `f2eef880` (#3342's head); no pull
request was opened.

- `0982436b` — adds `scripts/regression/pdf-extraction-v3/artifactScanRules.mjs`
  (the pure V3 rule set: `classifyPath`, `scanText`, `scanFiles`,
  `isProgrammeScope`, `decodeJwtPayload`, `isPrivilegedJwt`,
  `signedTokenState`, `shannonEntropy`, the `VENDOR_TOKEN_FORMATS` table, the
  `TEXT_SCAN_EXEMPT` list; its header records the measurement and the rules)
  and changes `src/lib/reportTemplate/qrCodeEncoder.ts` to import
  `../security/vendor/qrcode/index.js` (F14).
- `fc5af9ed` — removes the over-broad "any URL carrying a JWT token parameter"
  rule after measuring the 816 click-tracking JWTs.

Not yet done on it: §2 steps 3a (signature parser), 3b (CLI onto the module —
`artifact-scan.mjs` on the branch is still V2), 3c, 3d, 3f, 3g, 3h, 3i. The
rules module alone, over the whole tracked tree at `fc5af9ed`: 1 finding (the
S3 fixture), 0 notes, 2.7 s. The release-v3 vitest suite
(`releaseGate.pure.spec.ts`) passes locally as it stands; `tsc`/`lint` were
not run on the branch.

Design decisions already taken there, so you do not re-decide them:

- **Values, never names.** A credential is recognised by its format or by a
  decoded JWT payload; `SUPABASE_SERVICE_ROLE_KEY` as an environment-variable
  *name* is never a finding.
- **Programme scope** (`scripts/regression/pdf-extraction-v3`,
  `tests-e2e/pdf-extraction-v3`, `src/lib/reportTemplate/ingestion/releaseV3`,
  `reports/`, `.pdf-v3-evidence/`, and everything under a `--dir`) is the only
  place media, fonts, models, `blob:` URLs and inline image data are banned —
  it is the only place a private corpus artefact can land. An inline PDF is
  banned anywhere. `.pdf-v3-tmp/` stays the approved temp scope.
- **An expired signature is a note, not a failure**, and is still reported —
  the V2 header's "false positives are reported, not silently ignored" is kept.
- **Text-scan exemptions are named and justified**: the scanner and its rules
  module, `redaction.ts`, `.gitleaks.toml`,
  `scripts/security/check-security-gate-negatives.mjs`. They are still
  path-scanned.
- `processor_resource` and `service_endpoint` are unchanged from V2 (both
  measured at zero on the tree).
- Never fix any of this on a clone, and never make the gate pass by weakening
  MC's drain or by `continue-on-error`. If the browser tier genuinely cannot
  run on a runner, the honest fallback is to run only what can pass on the PR
  job and move the browser tier to dispatch/nightly, documented — not to mark
  it green.

---

## 5. What shipped this session (for the record)

- Prime #3342 (`f2eef880`): 30+ workflows pinned to commit SHAs; Deno 2.9.7
  and Supabase CLI 2.121.0 installed from GitHub releases with sha256 checks
  in the nine workflows that used `supabase/setup-cli`; `CI_SCOPE.md` records
  the two publishers still refused.
- Prime #3341 (`efeead42`): `listings-cache` sheds `UNREAD_BULK_COLUMNS` as
  each Airtable page arrives; the marketplace reads the deployment's own table
  (`cacheTableKey` names no table id). Carries #3342.
- MC #345 (`79d00c37`): `FLEET_CONFIGURATION` + `refresh` so a forwarded
  configuration value follows MC's value; the findings document
  `docs/AIRTABLE_CASCADE_HANDOVER_2026-10-19.md`; this handoff.
- `npc-client-dashboard` #379: three hand commits on the engine's cascade —
  `3922a634` pins + Deno, `5b6cf760` the held `App.tsx` reconcile,
  `06d2d096` the Supabase CLI step in nine workflows (byte-identical to Prime).
- `npc-crm-independent` #123 (`86a9fa5b`): 30 workflows pinned; Deno and the
  Supabase CLI from releases; CI 630 is the repository's first full green run.
- Prime branch `claude/serene-gates-b7f5pi-pdf-v3-gate` (`fc5af9ed`): §4.
- Earlier legs (all merged before this one): the security scan hardening,
  nightly scans on Prime only, autofix routing (P0/P1 → Claude, P2+ → Codex),
  Prime `main` protection through MC's App, the npm-audit highs, Node 24 pins,
  `ubuntu-24.04` runners, the scan/fix workflows copied into Prime (#3323),
  Codex keys synced to Prime and removed from clones (MC #344).

---

## 6. Only the owner can do these

1. **Organisation Actions allow-list**: admit `google-github-actions/*`
   (`auth`, `setup-gcloud` — the two Cloud Run deploys and
   `maps-credential-remediation`) and `superfly/*`
   (`flyctl-actions/setup-flyctl` — `address-service`, `routing-service`,
   `deploy-render-fly`), or ask for each to be replaced the way the Supabase
   CLI was. Until then those six workflows on Prime (and four on
   `npc-crm-independent`) fail at startup; `CI_SCOPE.md` names them.
2. **A workspace-scoped Anthropic API key for MC's autofix** (the Claude engine
   in the remediation workflow), set in MC's environment.
3. **Rotations owed**: the signing key, `CRON_SECRET` on three projects, and
   the nine leaked credentials from the scan findings. Also: a per-job
   `CALLBACK_SECRET` value was printed in a Prime Actions log earlier in this
   programme (the repository is public, so the log is public); the remediation
   workflow mints a key per job, so the blast radius is that job, but treat the
   value as burned and confirm it is not reusable.
4. **Eight template-seed migrations over 40 MB** must be pushed by a person
   (the session's push was refused on size).

---

## 7. Rules that bit, so they are not paid for again

- **Fix at the Prime; the cascade carries it.** A clone-side edit to a file
  the prime also holds is reverted silently by the next cascade.
- **Never convert a cascade PR (#379, #121) to a draft**, never squash one,
  never weaken MC's merge gate or silence a scanner to get one through.
- **A check that cannot pass on a clean tree protects nothing** — and holds
  the whole fleet behind it. Measure a scanner's findings against the tree it
  guards before trusting its verdict.
- **Read the production evidence before modelling the behaviour**: the hold
  reason was in `cascade_results.diff_summary` all along; the gate's history
  was in its run list; the e2e's fault was one command away.
- **A pre-installed browser path is not a detector.** Ask the tool that will
  launch the browser where it would look.
- **Never print a secret value**; measure by masked shape (prefix + length) and
  by decoded *claims*, never the token.
- `gh pr …` GraphQL is refused inside a Claude Code session; use `gh api`.
  MC's column names come from `information_schema.columns`; enum values from
  `enum_range`.
