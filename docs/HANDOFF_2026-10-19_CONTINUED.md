# Handoff, continued — the gate passes, and the refresh that could not carry it

**Written 19 Oct 2026, from 15:30 UTC, and updated at 16:10 UTC, by the session
that continued
[`HANDOFF_2026-10-19_AIRTABLE_CASCADE_AND_CI_GATES.md`](./HANDOFF_2026-10-19_AIRTABLE_CASCADE_AND_CI_GATES.md)
(14:05 UTC, on Mission Control #345's branch).** Read that one for the access
list, F1–F14 and the commands it gives; read this one for where things stand
now. It replaces that document's §1 (state) and §2 (plan). Its §3–§7 still
hold, with the three corrections in §3 below.

> **Read F19 first.** A client's confidential Borrowing Capacity Snapshot was
> committed at the root of Prime on 6 Aug 2026 and has been carried to every
> clone since. Prime #3343 removes it from Prime's tip. Removing it from the
> history, and deciding whether the exposure needs any notice, are the
> owner's decisions.

This session's GitHub identity is `lavan96`. Its branches are
`claude/sweet-tesla-pdemno` in Prime and in Mission Control (MC). Every state
below is something you can re-read, and every step is a command you can run.

**Updated 20 Oct 2026, 02:45 UTC, by the session that continued this one.** It
re-read every row of §1 (marked ‡), found F20 (§3), and pushed only to its own
branches, `claude/confidential-report-cleanup-at2jfw`, in Prime, MC and
npc-crm-independent. In Prime and MC that branch is the open pull request's
head plus one commit, so carrying it into #3343 or #346 is a fast-forward. It
pushed to no other session's branch and opened no pull request: both wait on
the owner's word (Step C, §5).

**Updated again at 03:40 UTC.** On the owner's word, #3343 and #346 were
fast-forwarded at 02:49 UTC onto `6546c389` and `da38d5c6`, and the CRM
deletion became npc-crm-independent-6505dc#124. Its first `CI` run could not
start, so it also carries #123's `ci.yml` (Step E). All three are green now.
Rows marked ◊ were re-read at 03:40.

**Merges need the owner.** This session merged Prime #3342 (step 1 of the plan).
The session's safety controls then refused the next merge-related action as
"merge without review", so no other merge was attempted. Every remaining merge
below is the owner's to approve, or to make.

---

## 1. State at hand-over (15:35 UTC, 19 Oct 2026; rows marked † re-read at 16:05, ‡ at 02:45 UTC on 20 Oct, and ◊ at 03:40 UTC)

| Piece | Where | State |
|---|---|---|
| Prime: actions pinned, Deno and the Supabase CLI from their releases | npc-property-dashbord#3342 | **Merged** 14:39:50 UTC as `66290065` (merge commit, `--match-head` `f2eef880`). On `main`: CI 9085 green; Deploy Supabase functions 1124 green, but it deployed nothing (§3, F17); PDF Import Release Gate 4438 green. Deploy the PDF-import sidecar (run 3) and Deploy the render container (run 5) `startup_failure`: they name `google-github-actions/*`, the owner's allow-list item. |
| ◊ Prime: `listings-cache` memory fix | npc-property-dashbord#3341, head `efeead42` | Open, unchanged. Green on its own CI 9082. `mergeable_state: unstable` only for the old `static-and-fast`. Its three pin commits are cherry-picks of #3342's, so they merge as no-ops. **Merging it redeploys every Edge Function** (it changes `supabase/functions/_shared/listingsCache.pure.ts`, and a `_shared/` change deploys all), which is also the CLI step's first production run. ◊ Still at that head, and still `unstable` on the old `static-and-fast` alone. |
| †‡◊ Prime: the `pdf-extraction-v3-gates` fix (the handoff's step 3) | npc-property-dashbord#3343, branch `claude/sweet-tesla-pdemno`, head **`6546c389`** (5 commits) | **`static-and-fast` passed on `60495442`** — run 39275041962, job 118137024278, 15:06–15:08 UTC, the first green run of that check since it was created. On the runner Playwright installed Chromium v1248 `--with-deps`, the detector found it, the pure suites ran 50 tests and the e2e passed 2, giving `releaseReady: true` with 7 required checks: 0 failed, 0 skipped, 0 unavailable. **Then Codex's review (15:26) found the first cut too narrow (P1) and too lenient on expired signatures (P2), and applying its rule found F19.** Both accepted: `e86bec0a` removes `report.pdf` and `final.png`, and `9563070a` bans media anywhere but named asset directories and makes every complete signature a finding. Both threads were answered and resolved. Locally on `9563070a`: release-gate specs 53 passed, CI's Template Builder step 345 files and 4,394 tests passed, the static and fast gates PASS, and the tracked scan reads 0. ‡ **CI on `9563070a` finished green but for one check.** `verify`, `security`, all three shards, `template-geometry`, `static-and-fast` and `pdf-import-regression` passed, and the rest were skipped by scope. `pdf-import-release-gate` (run 39281399479, job 118156219877) failed at 50/100 on exactly the two files `e86bec0a` deletes (F20). The fix is `6546c389`, whose parent is `9563070a`. ◊ **#3343 was fast-forwarded onto it at 02:49 UTC.** On `6546c389`, `pdf-import-release-gate` passed (run 39360974034, job 118426828417), as did `static-and-fast`, `pdf-import-regression` and `security`; `template-geometry` and all three `verify` shards passed too, and `verify` went green at 03:13 UTC (CI run 39360973961), with `abs-register-liveness`, `render-container` and `supply-chain` skipped by scope. **It is green, `mergeable_state: clean`, and waits only on the owner's merge.** The description now covers the fifth commit. |
| †‡◊ MC: a refresh over hand commits proceeds where both sides agree or merge cleanly | aurixa-mission-control-12b89885#346, branch `claude/sweet-tesla-pdemno`, head `da38d5c6` | ‡ **Ready** (marked at 16:08), `mergeable_state: clean`. **New since 14:05, and now a prerequisite for #379** (§3, F15). Tests 448 files / 9,061 passed locally. CI green on `228064c6` (run 39282801101: Typecheck · Lint · Build, and the Lovable install check). Codex reviewed `228064c6` and found nothing. Needs a Lovable publish after merge. ◊ Fast-forwarded onto `da38d5c6` (the 02:45 update) at 02:49 UTC, and CI is green on it (run 935). The description now names F20 and #124. This second update is one commit on top of it, on `claude/confidential-report-cleanup-at2jfw`. |
| MC: forwarded configuration follows MC's value | aurixa-mission-control-12b89885#345 | Unchanged; held on purpose until #3341 is on all four clones (F4). |
| †‡◊ Clone `npc-client-dashboard` cascade | npc-client-dashboard#379, head `06d2d096` | Unchanged and still held on `static-and-fast` (run 62, 13:03 UTC). The 15:00 pass deferred its refresh (F15); the 15:03 pass found the statement for prime `66290065` equal to its head ("carries this exact tree"). Every pass since has deferred the same way, the latest at 15:59:00 (events `0aa71083`, `58333aed`, `d9fd07ee`, `0b329741`). Its tree holds both F19 files. ‡ Unchanged on 20 Oct: the passes at 02:35 and 02:37 UTC deferred its refresh in the same words. ◊ So did the pass at 03:39 UTC (event `0b329741`). |
| ‡◊ Clone `npc-crm-independent`: pins | npc-crm-independent-6505dc#123, head `86a9fa5b` | Unchanged on 20 Oct. Every check green except `static-and-fast` (the V2 scanner, not required). It is not a cascade PR, so MC's drain does not hold it; it merges when a person merges it. ◊ Still at that head. #124 carries its `ci.yml` byte for byte, so the two merge in either order (Step E). |
| †‡◊ Clone `npc-crm-independent`: cascade | npc-crm-independent-6505dc#121, head `25acc6eb` | Unchanged since 17 Oct. Its last run failed `verify` and `security` on F10's held files, and never ran `static-and-fast`. The engine is still working it: four `pushing` rows (events `0aa71083`, `58333aed`, `d9fd07ee`, `0b329741`), each at `attempts` 3, last touched 15:50–15:59, with no `pr_url` yet. Its tree holds both F19 files, and the cascade cannot remove them there (Step E). ‡ On 20 Oct its rows still cycle from `queued` to `pushing` about once a minute, the latest at 02:37 UTC (events `58333aed`, `d9fd07ee`, `0b329741`), with no `pr_url` and no `error_message`. ◊ The same at 03:40 UTC, the latest cycle at 03:39 (event `0b329741`), and its head is still `25acc6eb`. |
| ‡◊ Clone `npc-crm-independent`: the F19 deletion | npc-crm-independent-6505dc#124, branch `claude/confidential-report-cleanup-at2jfw`, head `6ebc853c` | **Opened at 02:49 UTC on 20 Oct.** `6ba9451d` removes `report.pdf` and `final.png` (Prime's blobs) on top of `main` `6322c63e`, and Codex reviewed it and found nothing. Its first `CI` run (631) ended in `startup_failure`, because a pull request's workflow is read from `main`, where every action is named by a tag. So `6ebc853c` carries #123's `ci.yml` byte for byte (blob `e92dbf46`), the only workflow the pull request triggers. Run 632 on `6ebc853c` then passed all six of its jobs by 03:38 UTC (`verify`, `security`, `supply-chain`, `render-container`, `template-geometry` and `abs-register-liveness`), and the Vercel preview built. **It is green and waits only on the owner's merge.** Step E says how it may land. |
| †‡◊ `clones` | MC database | Unchanged at 16:05, at 02:45 UTC on 20 Oct, and ◊ at 03:40: CD `cascading` (596 behind); CRM `cascading` (928); NPC Test `cascading` (635); Preflight `behind` (635). The two children wait on lineage for #379 ("Parent NPC Client Dashboard carries prime@881e7e0; this pass delivers prime@6629006"). |
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

### Step C — merge #3343, now on its fix, and #3341 (in either order)

**#3343 is on its fix.** `pdf-import-release-gate` failed #3343's previous head
on the two files it deletes (§3, F20). On the owner's word the pull request
was fast-forwarded onto the fix, `6546c389`, at 02:49 UTC on 20 Oct. Merge it
once its full gate there is green (§1):

```sh
gh api -X PUT repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/pulls/3343/merge \
  -f merge_method=merge -f sha=6546c389d5a0e117867d0d61fb8b8bbc1419857c   # or the head its full gate passed on
gh api -X PUT repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/pulls/3341/merge \
  -f merge_method=merge -f sha=efeead420b6046ae8585d4a5822253473d78dcb9
```

Use merge commits, never squash (Prime's steward convention). Merge #3343
whole: its commit `e86bec0a` (the F19 removal) is a separate commit so the
history reads plainly, but `9563070a`'s scanner fails without it, and only
`6546c389` lets the release gate pass with it.

With #346 live the order does not matter. If #346 is published first, the
refresh after #3341 moves #379 onto prime's pins with no merge at all. The
refresh after #3343 asks for exactly one three-way merge
(`pdf-extraction-v3-gates.yml`), which is clean on the real files; the review
commits added no path the hand commits touched. If #3343 lands first the same
holds.

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
scanner, and the drain lands it (`merge_method: "merge"`). The same refresh
should delete `report.pdf` and `final.png` from the clone, and it carries
`6546c389`'s release gate with them, so `pdf-import-release-gate` on #379 reads
the deletion as a deletion (F20).
`deletionPropagation.pure.ts` delivers a deletion where the clone's copy is
byte-identical to a version Prime held at that path, and the clone's blobs
(`2672038f…`, `f67340e2…`) are Prime's. Neither file is imported and two is far
under the 25-deletion cap. Measured under the final rule, #379's head reads
exactly those two findings and nothing else (§3 F16), so the refreshed head
scans clean. Confirm the deletion in the refresh's diff: if the probe comes
back `unsettled`, the file is kept and `static-and-fast` holds the PR on it.
Preflight Property Group and NPC Test follow by lineage; confirm the deletion
on their pull requests too. Watch:

```sql
select c.name, r.status, r.pr_url, r.updated_at, left(r.diff_summary, 200)
from cascade_results r join clones c on c.id = r.clone_id
order by r.updated_at desc nulls last limit 20;
```

### Step E — the CRM-independent line

As the handoff's step 5, with two additions. Merge #123 (`--match-head-commit
86a9fa5b86bca6995e6ed6bc7d9bb3b4bebc6db6`). Then wait until the engine has
finished re-pushing #121 (the four `pushing` rows above complete). Only then
make F10's held-file reconcile on its branch, naming `prime@<sha>` exactly once.

1. **Delete `report.pdf` and `final.png`, by #124 or in the reconcile.** The line is
   `sync_scope: modules`. It receives the files of its 135 installed modules
   plus the repository invariants, and a root file is neither, so no cascade
   will ever delete them there. The scanner still arrives, because `scripts/**`
   is an invariant. Once it does, `static-and-fast` on #121 reads exactly those
   two findings — measured on `25acc6eb` under the final rule, and nothing
   else — and MC's drain holds the PR on them until a person deletes the
   files. That is the correct verdict. A deletion is the clone's own change,
   not a held file, so it needs no `prime@` token.

   The deletion is npc-crm-independent-6505dc#124: `6ba9451d` on top of
   `main` `6322c63e`, and `6ebc853c`, which carries #123's `ci.yml` byte for
   byte so its checks can start. It merges in either order with #123: both
   carry the same `ci.yml`, so whichever lands second merges cleanly and
   that file drops out of its diff. Landed before the reconcile, it leaves
   the reconcile nothing to delete. (Or cherry-pick `6ba9451d` into the
   reconcile and close #124.)

   Either way, mind the run on `main`. The line's
   `pdf-import-release-gate.yml` runs on every push to `main` with no paths
   filter. Merged before #123, that run fails at startup like every
   unpinned workflow. Merged after #123 and before a cascade carries
   `6546c389`'s script there (`scripts/**` is an invariant), it reads the
   two deletions as two critical findings. Either way it goes red on `main`
   once and holds nothing, but say so if it happens. The pull request itself
   does not run that workflow, because its `pull_request` paths filter names
   no root file.
2. **Watch the fast tier there.** `pdf-extraction-v3-gates.yml` is a judging
   workflow, so on a module-scoped clone it is held, and the line keeps its
   own copy. That copy runs `npx playwright install chromium` without
   `--with-deps`. Prime's `resolveChromium` (in `scripts/**`) will find that
   browser, and the e2e's import fix arrives with `platform-core`, which names
   `qrCodeEncoder.ts`. If the browser then fails to launch for want of system
   libraries, port `--with-deps` into the line's copy by hand: the cascade
   will never carry it. This is unmeasured; on Prime the flag went in before
   any run could show whether it was needed.

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

## 3. Findings since 14:05 (F15–F20)

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

### F16. The V3 scanner on every tree the cascade will run it on

On a cascade PR `static-and-fast` scans the CLONE's tree, so Prime's tree
being clean was not enough to promise the hold lifts. Every tree that matters
was measured locally, twice: with the first cut of the rules (`60495442`) and
with the final rule after the review (`9563070a`, F19).

| Tree | Files | First cut | Final rule |
|---|---|---|---|
| Prime `main` `66290065` | 11,712 | 0 | 2 |
| Prime #3343 head `9563070a` | 11,712 | — | **0** |
| npc-client-dashboard #379 head `06d2d096` | 11,820 | 0 | 2 |
| npc-crm-independent `main` `6322c63` | 10,839 | 0 | 2 |
| npc-crm-independent #121 head `25acc6eb` | 11,275 | 0 | 2 |
| NPC Test `main` `099f60d` | 11,331 | 0 | 2 |
| Preflight `main` `83fcf05` | 11,289 | 0 | 2 |

The two findings are the same two files on every tree: `report.pdf` and
`final.png`, with the same blobs. Nothing else on any tree is a finding. So the
hold lifts wherever the cascade carries both #3343's rule and its deletion:
the mirror line by the cascade's own deletion rule (Step D), and the CRM line
only by hand (Step E). gitleaks 8.28.0, run as Prime's CI runs it, finds
nothing in the diff.

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
not hold anything. It goes green when the V3 scanner reaches the line and the
two F19 files are removed there by hand (Step E). #121 never ran that check:
its blockers are F10's.

### F19. A client's confidential report has been in every repository since 6 Aug

- **What.** `report.pdf` at the root of Prime is a nine-page Borrowing
  Capacity Snapshot for a named client, marked "PRIVATE AND CONFIDENTIAL",
  setting out that client's financial position. It was uploaded through
  GitHub's web interface at 16:38 UTC on 6 Aug 2026 as `report (2).pdf`
  (`1653a651`, "Add files via upload") and renamed a minute later
  (`f606c480`). `final.png` beside it arrived in a Lovable commit on 1 Aug
  (`71f9f164`). It is a 320×260 render of integration logos: no personal
  data, but not a product asset either. Nothing references either file.
- **Where.** The same two blobs (`2672038f…`, `f67340e2…`) sit on the default
  branch of all five repositories — Prime, npc-client-dashboard,
  npc-crm-independent, NPC Test and Preflight Property Group — and on both open
  cascade heads (#379, #121). Each clone is a separate deployment. Whether any
  clone repository has members outside NPC is something the owner knows and
  this session does not.
- **How it was missed.** V2 reported both, among 1,949 findings that nobody
  could act on. The first cut of V3 banned media only inside the PDF
  programme's own directories, so it lost them outright, and every tree read
  0. Codex's review of #3343 (P1) objected that the narrowing assumed where a
  private file could land. Applying the reviewer's repository-wide rule found
  these two.
- **What is done.** `e86bec0a` removes both from Prime's tip. The scanner now
  fails on any media outside named asset directories. The mirror line loses
  the files when the cascade carries #3343 (Step D). The CRM line needs a
  hand deletion (Step E).
- **What is not done, and is the owner's.**
  - **History.** Every repository's history still holds the file, under both
    names, and so does every fork, clone and pull-request ref that fetched
    it. Removing it means rewriting each default branch's history from
    `1653a651` onward. That is a force-push, which every open branch and
    checkout then has to re-base onto, and MC's `last_synced_sha` for every
    clone would name commits that no longer exist. It also means asking
    GitHub Support to purge cached views and pull-request refs. This session
    has done none of that.
  - **Notice.** Whether the exposure is an eligible data breach under the
    Privacy Act's Notifiable Data Breaches scheme (whether it is likely to
    result in serious harm), and whether the client should be told, is for
    the owner and their adviser. This document draws no conclusion.
  - **Was it served?** Not measured: this session's network policy refuses the
    deployments' hosts. A production build copies only `public/`, so a
    published site should not serve a root file. A Vite development preview
    can serve files from the project root. To check, run
    `curl -sI https://<host>/report.pdf` against each published site and each
    preview. A `text/html` answer is the single-page-app fallback. An
    `application/pdf` answer means the file is being served.

### F20. The release gate read the removal as the leak

- **What.** On #3343's head `9563070a`, `pdf-import-release-gate` (run
  39281399479, job 118156219877) failed at 50/100 with
  `[critical] no_private_pdfs_staged` (`report.pdf`) and
  `[critical] no_generated_images_staged` (`final.png`), the two files
  `e86bec0a` deletes. Every other check on that head passed or was skipped by
  scope.
- **Why.** `pdf-import-release-gate.mjs` listed its candidates (the committed
  range, the staged files and the unstaged files) with `git diff --name-only`,
  which lists a deleted path like any other, and `classifyArtifact` judges by
  path alone. So the pull request removing the report read as staging it.
- **The fix.** `6546c389`, one commit on top of `9563070a` on Prime's
  `claude/confidential-report-cleanup-at2jfw`, passes `--diff-filter=d` to all
  three listings. The lowercase filter drops deletions alone: a file that is
  added, modified, copied or renamed is still listed, a rename under its new
  path. `pdfImportReleaseGateDiffRange.spec.ts` pins the filter on all three
  and runs the script's own command in a real repository, with the unfiltered
  command as the control.
- **Measured locally, on the same commits.** The static gate with its Phase
  11D specs reads FAIL 50/100 before and PASS 100/100 after. CI's Template
  Builder step passes 345 files and 4,396 tests, and the V3 scanner reads 0.
  The build was not run here: `npm install` cannot fetch `xlsx` from
  `cdn.sheetjs.com`, which this session's network policy refuses. The commit
  touches no file the build reads, and #3343's CI built the tree before it.
- **Why it rides in #3343.** Every mirror clone's cascade PR that carries the
  deletion would fail the same check, and MC's drain reads every check on a
  cascade PR, so #379 would trade one hold for another. Carried together, the
  cascade delivers the fixed script with the deletion. npc-client-dashboard
  and npc-crm-independent both hold Prime's current script byte for byte
  (`d64804cf`), so it arrives there as a plain update.
- **The CRM line.** Its `pdf-import-release-gate.yml` runs on every push to
  `main` with no paths filter, so a deletion merged there is judged by
  whichever script the line holds at that moment (Step E).
- ◊ **On CI.** On `6546c389` the gate passed (run 39360974034, job
  118426828417): the same two deletions, now read as deletions.
- **The spec's import.** The new test imports
  `src/lib/deploy/__tests__/workflowHarness.ts`, which npc-crm-independent's
  `main` lacks, and that line's CI runs every spec under
  `src/lib/reportTemplate`. The cascade's import closure
  (`importClosure.pure.ts`) walks every `.ts` it writes, specs included, and
  carries what the clone lacks, so the harness should travel with the spec.
  Confirm it in that cascade's diff. Without it the spec fails to load
  there.

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
    `artifactScan.spec.ts` pins the rules and that the CLI is wired to them.
    §13, §14, §17 and §19 of the gate's document are updated.
  - `e86bec0a` — removes `report.pdf` and `final.png` (F19).
  - `9563070a` — the review: media, fonts and models are banned anywhere but
    the directories `PRODUCT_ASSET_PATHS` names, each with its reason, and
    every complete signature is a finding whatever its expiry. The notes
    channel is gone. The spec has 22 tests, and §13 and §17 record the
    change and how the first cut lost the two files.
  - Both Codex threads were answered, naming the commit, and resolved. The PR
    description was rewritten to match the branch.

  It builds on the parked `claude/serene-gates-b7f5pi-pdf-v3-gate`
  (`0982436b`, `fc5af9ed`).
- MC #346, branch `claude/sweet-tesla-pdemno`:
  - `d84e614f` — `refreshOverHumanWork.pure.ts` (agreement and three-way
    merge), the engine's call site, `refreshOverHumanWorkIsWired.contract.test.ts`
    and `CASCADE_MEMBRANES.md`;
  - this document.

### And on 20 Oct, by the session that continued this one

- Prime, `claude/confidential-report-cleanup-at2jfw` (#3343's four commits
  plus one): `6546c389`, the release gate lists no deleted file (F20).
- npc-crm-independent, `claude/confidential-report-cleanup-at2jfw`:
  `6ba9451d` removes `report.pdf` and `final.png` (F19), on `main`
  `6322c63e`.
- MC, `claude/confidential-report-cleanup-at2jfw` (#346's three commits plus
  one): the 02:45 update.
- On the owner's word, at 02:49 UTC: #3343 fast-forwarded onto `6546c389`,
  #346 onto `da38d5c6`, and npc-crm-independent-6505dc#124 opened from the
  CRM branch. `6ebc853c` on that branch carries #123's `ci.yml` (Step E),
  and #124 has one comment saying why its first CI run could not start. The
  three descriptions were rewritten to match.
- MC, `claude/confidential-report-cleanup-at2jfw` (#346's four commits plus
  one): this second update.

Until the owner's word it opened no pull request and pushed to no other
session's branch.

---

## 5. Only the owner can do these

1. Approve, or make, the merges in §2: MC #346, Prime #3343 and #3341, CRM
   #123, and later MC #345. Then publish MC after #346 and again after #345.
   Add npc-crm-independent-6505dc#124, in either order with #123 (Step E).
   #3343 and #346 now sit on `6546c389` and `da38d5c6`. This second update
   is one commit on top of #346: carry it in before the squash, or merge
   #346 first and open a pull request for this commit alone.
2. F19's three decisions: whether to purge the confidential report from the
   history of all five repositories; whether the exposure needs any notice
   (the client, the regulator); and the one-line `curl -sI` check of whether
   any deployment or preview ever served the file.
3. Everything in §6 of the 14:05 document still stands:
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
- **A gate made to pass by looking in fewer places protects less than it
  claims.** A check that cannot pass on a clean tree protects nothing, but
  the remedy is to judge better, not to look less. Narrowing the media rule
  to the programme's directories turned a confidential client report from a
  buried finding into no finding at all.
- **A reviewer's objection about scope is a measurement waiting to be run.**
  "This could let a private export through" was answered by running the
  wider rule over six trees, and it found one.
- **A deletion is the remedy, never the finding.** A check that judges
  files by path has to list only what a branch adds, changes or renames, or
  it fails the pull request doing what the check asks for (F20).
