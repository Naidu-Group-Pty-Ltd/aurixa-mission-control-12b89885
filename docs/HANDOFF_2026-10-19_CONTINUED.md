# Handoff, continued — the gate passes, and the refresh that could not carry it

**Written 19 Oct 2026, from 15:30 UTC, by the session that continued
[`HANDOFF_2026-10-19_AIRTABLE_CASCADE_AND_CI_GATES.md`](./HANDOFF_2026-10-19_AIRTABLE_CASCADE_AND_CI_GATES.md)
(14:05 UTC, on Mission Control #345's branch).** Read that one for the access
list, F1–F14 and the commands it gives; read this one for where things stand
now. It replaces that document's §1 (state) and §2 (plan). Its §3–§7 still
hold, with the three corrections in §3 below.

This session's GitHub identity is `lavan96`. Its branches are
`claude/sweet-tesla-pdemno` in Prime and in Mission Control (MC). Every state
below is something you can re-read, and every step is a command you can run.

**Merges need the owner.** This session merged Prime #3342 (step 1 of the plan).
The session's safety controls then refused the next merge-related action as
"merge without review", so no other merge was attempted. Every remaining merge
below is the owner's to approve, or to make.

---

## 1. State at hand-over (15:35 UTC, 19 Oct 2026)

| Piece | Where | State |
|---|---|---|
| Prime: actions pinned, Deno and the Supabase CLI from their releases | npc-property-dashbord#3342 | **Merged** 14:39:50 UTC as `66290065` (merge commit, `--match-head` `f2eef880`). On `main`: CI 9085 green; Deploy Supabase functions 1124 green, but it deployed nothing (§3, F17); PDF Import Release Gate 4438 green. Deploy the PDF-import sidecar (run 3) and Deploy the render container (run 5) `startup_failure`: they name `google-github-actions/*`, the owner's allow-list item. |
| Prime: `listings-cache` memory fix | npc-property-dashbord#3341, head `efeead42` | Open, unchanged. Green on its own CI 9082. `mergeable_state: unstable` only for the old `static-and-fast`. Its three pin commits are cherry-picks of #3342's, so they merge as no-ops. **Merging it redeploys every Edge Function** (it changes `supabase/functions/_shared/listingsCache.pure.ts`, and a `_shared/` change deploys all), which is also the CLI step's first production run. |
| Prime: the `pdf-extraction-v3-gates` fix (the handoff's step 3) | npc-property-dashbord#3343, branch `claude/sweet-tesla-pdemno`, head `60495442` | **`static-and-fast` passed** — run 39275041962, job 118137024278, 15:06–15:08 UTC, the first green run of that check since it was created. On the runner Playwright installed Chromium v1248 `--with-deps`, the detector found it, the pure suites ran 50 tests and the e2e passed 2, giving `releaseReady: true` with 7 required checks: 0 failed, 0 skipped, 0 unavailable. The fast lane was green; the PR was marked ready at 15:23 and the full gate (CI run 39277428548) is running. |
| MC: a refresh over hand commits proceeds where both sides agree or merge cleanly | aurixa-mission-control-12b89885#346, branch `claude/sweet-tesla-pdemno` | Draft. **New since 14:05, and now a prerequisite for #379** (§3, F15). Tests 448 files / 9,061 passed locally; MC CI running. Needs a Lovable publish after merge. |
| MC: forwarded configuration follows MC's value | aurixa-mission-control-12b89885#345 | Unchanged; held on purpose until #3341 is on all four clones (F4). |
| Clone `npc-client-dashboard` cascade | npc-client-dashboard#379, head `06d2d096` | Unchanged and still held on `static-and-fast` (run 62, 13:03 UTC). The 15:00 pass deferred its refresh (F15); the 15:03 pass found the statement for prime `66290065` equal to its head ("carries this exact tree"). |
| Clone `npc-crm-independent`: pins | npc-crm-independent-6505dc#123, head `86a9fa5b` | Unchanged. Every check green except `static-and-fast` (the V2 scanner, not required). It is not a cascade PR, so MC's drain does not hold it; it merges when a person merges it. |
| Clone `npc-crm-independent`: cascade | npc-crm-independent-6505dc#121, head `25acc6eb` | Unchanged since 17 Oct. Its last run failed `verify` and `security` on F10's held files, and never ran `static-and-fast`. The engine is still working it: four `pushing` rows (events `0aa71083`, `58333aed`, `d9fd07ee`, `0b329741`) restarted 15:15–15:19, with no `pr_url` yet. |
| `clones` | MC database | CD `cascading` (596 behind); CRM `cascading` (928); NPC Test `cascading` (635); Preflight `behind` (635). The two children wait on lineage for #379. |
| `clone_backend_secrets.AIRTABLE_TABLE_NAME` | all four clones | `inherited`, last set in September; `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` `withheld`. Unchanged until #345 is published. |

---

## 2. Execution plan — what remains, in order

### Step A — the owner approves the merges

Every step below that merges needs the owner's go-ahead, or the owner's own
hands. Nothing else in this list is blocked.

### Step B — merge MC #346 and publish it

```sh
gh api -X PUT repos/Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885/pulls/346/merge \
  -f merge_method=squash -f sha=<the PR's head when its CI is green>
```

Mark it ready first (`draft: false`). MC squash-merges its own PRs. Then
publish MC from Lovable (`deploy_project` on
`0fb4d803-5071-4093-be25-5afbcf116476`, or Publish in the editor). This must be
live before #379 can move: §3 F15 explains why, and why there is no other
way through short of a hand commit on the cascade branch.

Acceptance: the next pass's row for npc-client-dashboard reads
`pr_opened`/`skipped` with a preserving merge on #379, not `Proposal #379
carries this clone's own commits; its refresh was deferred`.

### Step C — merge Prime #3343, then #3341 (or the other way round)

```sh
gh api -X PUT repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/pulls/3343/merge \
  -f merge_method=merge -f sha=60495442052bb57f7e38def6ce7d1ce426402b2f   # or the head its full gate passed on
gh api -X PUT repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/pulls/3341/merge \
  -f merge_method=merge -f sha=efeead420b6046ae8585d4a5822253473d78dcb9
```

Use merge commits, never squash (Prime's steward convention). With #346 live the order does not
matter. If #346 is published first, the refresh after #3341 moves #379 onto
prime's pins with no merge at all. The refresh after #3343 asks for exactly
one three-way merge (`pdf-extraction-v3-gates.yml`), which is clean on the real
files. If #3343 lands first the same holds.

If either lands BEFORE #346 is published, its refresh of #379 defers again
(F15). The engine retries only on a later pass, so once #346 is live, press
**Cascade now** for NPC Client Dashboard in Mission Control rather than wait
for the next prime push.

Acceptance for #3341: `deploy-supabase-functions` on `main` deploys every
function; its "Install the Supabase CLI" step prints `2.121.0`; Prime's next
`listings-cache` run answers 200 (not 546) and syncs `tblumTIRYBn92B2ST` with
about 680 records. Acceptance for #3343: its merge triggers
`pdf-extraction-v3-gates / generated-full` on `main` (the paths filter matches
the new spec), its first chance to pass there.

### Step D — let MC carry it to #379 and the children

Nothing to do by hand once B and C are done. The engine refreshes #379 with a
preserving merge, `static-and-fast` runs on the refreshed head with the V3
scanner (measured clean on that tree, §3 F16), and the drain lands it
(`merge_method: "merge"`). Preflight Property Group and NPC Test follow by
lineage. Watch:

```sql
select c.name, r.status, r.pr_url, r.updated_at, left(r.diff_summary, 200)
from cascade_results r join clones c on c.id = r.clone_id
order by r.updated_at desc nulls last limit 20;
```

### Step E — the CRM-independent line

Unchanged from the handoff's step 5. Merge #123 (`--match-head-commit
86a9fa5b86bca6995e6ed6bc7d9bb3b4bebc6db6`). Then wait until the engine has
finished re-pushing #121 (the four `pushing` rows above complete). Only then
make F10's held-file reconcile on its branch, naming `prime@<sha>` exactly once.

### Step F — MC #345, only after #3341 is on all four clones

Unchanged (F4). The SQL to verify it needs the real columns (§3, F17).

```sql
select c.name, s.name, s.status, s.set_by, s.last_set_at, s.last_error
from clone_backend_secrets s join clones c on c.id = s.clone_id
where s.name = 'AIRTABLE_TABLE_NAME' order by c.name;
```

### Step G — verify each clone's `listings-cache`, and update these documents

As the handoff's steps 7–8.

---

## 3. Findings since 14:05 (F15–F18)

### F15. The refresh deadlocked on the hand commits' own bytes

The handoff's step 4 said there was nothing to do by hand. That was wrong, for
a reason no document had recorded. MC's `refreshOverHumanWork.pure.ts` defers
any refresh of a proposal carrying hand commits when a path the hand commits
changed is ALSO changed by the new statement. It never asked what either side
changed the path *to*. #379 carries the three hand commits of the earlier
session, written byte for byte from Prime's #3342 so that the clone could run
CI at all.

- **What happened.** Once #3342 merged, the 15:00 pass read: *"Proposal #379
  carries this clone's own commits; its refresh was deferred: the refresh
  would change 29 path(s) the proposal's own commits also changed
  (`.github/workflows/address-service.yml`, …)"*.
- **The measurement.** Of the 31 paths both sides touched, 30 are
  byte-identical to Prime's `main`. The 31st is `apply-migration.yml`, the
  clone's protected copy, which never conflicts. The 15:03 pass then computed
  the statement for prime `66290065` and found it equal to #379's head tree.
- **Why it deadlocks.** The proposal is right but held on `static-and-fast`,
  whose fix is Prime's next change, and every next change defers the same
  way. #3343 adds one more both-changed path, `pdf-extraction-v3-gates.yml`
  (the hand commit pinned it, and Prime pins it and adds `--with-deps`).

MC #346 reads agreement (the same blob and mode, or both deleted) as
agreement. It three-way merges a path both changed differently with the
`threeWayMerge` held variants already use, and overlays it only when clean.
On the real three versions of that workflow the merge is clean and gives
Prime's text exactly. Everything else still defers as before.

The only way through without #346 is a hand commit on #379's branch porting
Prime's new scanner byte for byte (never naming a `prime@` token on files that
are not held). That is a write to a clone's cascade branch, and it is the
owner's call. #346 removes the class rather than the instance.

### F16. The V3 scanner is clean on every tree the cascade will run it on

On a cascade PR `static-and-fast` scans the CLONE's tree, so Prime's tree
being clean was not enough to promise the hold lifts. The V3 rules, run
locally on every tree that matters, gave 0 findings and 0 notes on each:

| Tree | Files |
|---|---|
| Prime `main` + #3343 | 11,713 |
| npc-client-dashboard #379 head `06d2d096` | 11,820 |
| npc-crm-independent `main` `6322c63` | 10,839 |
| npc-crm-independent #121 head `25acc6eb` | 11,275 |
| NPC Test `main` `099f60d` | 11,331 |
| Preflight `main` `83fcf05` | 11,289 |

gitleaks 8.28.0, run as Prime's CI runs it, finds nothing in the new spec.

### F17. Three corrections to the 14:05 document

- **Step 1's acceptance cannot be observed on #3342.**
  `deploy-supabase-functions` runs on `main` because its own file changed, but
  no function changed, so the "Install the Supabase CLI" and "Deploy" steps
  were skipped (run 1124, 25 s, green). The CLI step's first production run
  is #3341's merge, and that merge deploys every function.
- **The step 6 SQL names columns that do not exist.**
  - `clone_backend_secrets` holds `id, clone_id, name, status, last_set_at,
    last_error, set_by, created_at, updated_at`. There is no `source` and no
    `value`.
  - `prime_secret_forwards` holds `name, inherit, description, created_by,
    created_at, updated_at`.
- **Step 4 was not "nothing to do by hand"** (F15).

### F18. The CRM line's red `static-and-fast` on #123 is the same V2 scanner

It is not required on that repository and #123 is not a cascade PR, so it does
not hold anything. It goes green when the V3 scanner reaches the line. #121
never ran that check: its blockers are F10's.

---

## 4. What shipped in this session

- Prime #3342 merged: `66290065`.
- Prime #3343, branch `claude/sweet-tesla-pdemno`:
  - `8757ba7b` — the fast tier finds Chromium where Playwright installs it
    (`resolveChromium`), the workflow installs it `--with-deps`, and the e2e's
    directory import names `index.js`.
  - `60495442` — the V3 scanner. `artifactScanRules.mjs` holds the rules, with
    a storage-signature parser that counts a URL only when it carries its
    scheme's complete parameter set. `artifact-scan.mjs` is the CLI.
    `artifactScan.spec.ts` (19 tests) pins the rules and that the CLI is
    wired to them. §13, §14, §17 and §19 of the gate's document are updated.

  It builds on the parked `claude/serene-gates-b7f5pi-pdf-v3-gate`
  (`0982436b`, `fc5af9ed`).
- MC #346, branch `claude/sweet-tesla-pdemno`:
  - `d84e614f` — `refreshOverHumanWork.pure.ts` (agreement and three-way
    merge), the engine's call site, `refreshOverHumanWorkIsWired.contract.test.ts`
    and `CASCADE_MEMBRANES.md`;
  - this document.

---

## 5. Only the owner can do these

1. Approve, or make, the merges in §2: MC #346, Prime #3343 and #3341, CRM
   #123, and later MC #345. Then publish MC after #346 and again after #345.
2. Everything in §6 of the 14:05 document still stands:
   - the Actions allow-list for `google-github-actions/*` and `superfly/*`;
   - a workspace-scoped Anthropic key for MC's autofix;
   - the rotations;
   - the eight oversized template-seed migrations.

---

## 6. Rules that bit, so they are not paid for again

- **A conflict is a statement about content, not about who touched a path.**
  Two sides that changed a path to the same bytes agree, and a planner that
  cannot see that turns "fix it at prime" into a deadlock.
- **A check is proved on the tree it judges.** A scanner clean on Prime proves
  nothing about a clone's cascade PR until it has been run on the clone's
  tree.
- **An acceptance criterion must be observable on the change it is attached
  to.** A deploy step that runs only when a function changed cannot be
  accepted on a change that touches no function.
- **Read the column names before the query** (still true). Two of the 14:05
  document's queries named columns that do not exist.
