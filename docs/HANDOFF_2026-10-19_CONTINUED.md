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

**Updated a third time at 04:54 UTC.** The owner said to proceed with merging
and publishing directly. So this session squash-merged MC #346 (`e117f94c`)
and published MC. It merged Prime #3343 (`f99219bb`) and #3341 (`adb6bc5e`)
with merge commits, then npc-crm-independent #124 (`b11f3de4`) and #123
(`2a26ddce`). MC's drain merged #379 itself at 04:36:47 UTC (`ba5efc24`).
The confidential report and the stray render are off the tip of Prime,
npc-client-dashboard and npc-crm-independent. NPC Test and Preflight still
hold them on `main`. Their cascade pull requests, NPC Test #228 and
Preflight #227, opened at 04:51 and 04:53 UTC. Each deletes both files, and
MC's drain lands them when green. They had waited since 16 Oct behind the
CRM line's cascade, which cannot finish a pass (F21, §3). Rows marked ※
were re-read at 04:54.

**Updated a fourth time at 05:20 UTC.** Between the third update and this
one, nothing was merged, pushed or published except this document. It
re-read NPC Test #228, Preflight #227 and the clones' backends, and found
two things (F22, F23, §3). First, both pull requests are green on every job
but `security`, which stopped at its first step. The engine kept each
clone's own `SECURITY_INVENTORY.json` for a person while delivering the
files it describes, so the copy it kept is stale. Regenerated from each
pull request's own tree, it is npc-client-dashboard's committed copy byte
for byte (blob `b6c0612a`). One commit on each branch settles it, and that
waits on the owner's word, because the branches are the engine's and both
repositories were attached read-only (Step I). Second, and larger: no
clone's backend has received an edge function since 12–13 Oct. Mission
Control's deploy lane has parked every clone's run for a person. So #3341's
`listings-cache` is in npc-client-dashboard's repository and not on its
Supabase project, and Step F's condition is about four backends, not four
repositories (Step J). Rows marked ¤ were re-read by 05:20, and again at
05:24, when both pull requests, all four parked runs and
npc-client-dashboard's `listings-cache` (version 4159, deployed 11 Oct
00:36:55 UTC) were unchanged.

**Updated a fifth time at 08:05 UTC.** On the owner's word to keep working
the pending tasks, this session wrote Mission Control's fix for each of F23,
F22 and F21: three commits on its own branch,
`claude/confidential-report-cleanup-at2jfw` (`05ab074e`, `108d02bd`,
`d4a3854c`), on top of the fourth update. Nothing was merged, published or
opened as a pull request. The branch carries three additive migrations,
which apply when it reaches `main`, so landing it is the owner's word (§5,
item 8). What each fix is, and how it was checked, is in §4. What each
changes once live is in Steps H, I and J. Rows marked ✦ were re-read at
08:00 UTC. The five F21 events still cycle, the four deploy runs are still
parked, Prime's head is still `adb6bc5e`, and #228 and #227 are unchanged
at their heads. Step I still waits on the owner's word: the repositories
are attached to this session read-only, so it could not make those two
commits.

**Updated a sixth time at 10:15 UTC, by the session that continued this
one.** Its branch is `claude/gifted-meitner-b3towe` in MC. Rows marked ♦
were re-read between 09:20 and 09:50 UTC.

- **#347 is live.** The owner merged it at 08:22 UTC (`941c61a1`, a merge
  commit) and published MC by 08:27. Its three migrations are applied.
  The five F21 events retired between 08:27 and 08:37, each with a
  `cascade_failed` notice. The merge drain's recount then rewrote all
  five as `completed` (F24).
- **Three acts on the owner's word,** asked and answered in this session at
  about 08:43 UTC:
  - a "Cascade now" for NPC Test, Preflight and the CRM line (event
    `e2c35fc3`, 08:43:48);
  - the rejection of the four parked deploy runs (08:44:14);
  - and, once the traces showed the cascade could not land #228 and #227
    (F25), Step I's two hand commits (`362bebb` on #228, `e74ee82` on #227).
- **F19's files are off every tip.** Both pull requests went green, and MC's
  drain merged #227 as `53fa3fd` (09:14) and #228 as `e211a45` (09:20).
  `report.pdf` and `final.png` are now absent from `main` in all five
  repositories. All three mirror clones read `in_sync` at `adb6bc5e`.
- **The backends are deploying again, slowly.** The 08:50 catch-up sweep
  planned four fresh whole-fleet runs. They share one bundle a two-minute
  tick between them, 17 by 09:33, because the prime snapshot spends ~50 s
  of each ~57 s pass (F26).
- **The first traces** say where passes die: the children's refreshes in
  the tree write and the proposal (F25), and the CRM line in `deliver`
  (F27).
- **The inbox is saturated** (F28). 5,834 notices wait in "Needs
  attention", and 95% of them are two kinds restating a condition that had
  not changed. That is how the seven notices that parked every clone's
  deploys on 12–13 Oct went unread for a week.
- **MC #349** is open as a draft with the six engine changes those
  readings call for: F24, F25, the snapshot's pool (F26), F23's remedy 1,
  the finer trace inside `deliver` (F27) and the notification repeats
  (F28). It is not merged or published; that is the owner's word (§5,
  item 9).

**Merges need the owner.** This session merged Prime #3342 (step 1 of the plan).
The session's safety controls then refused the next merge-related action as
"merge without review", so no other merge was attempted. Every remaining merge
below is the owner's to approve, or to make.

---

## 1. State at hand-over (15:35 UTC, 19 Oct 2026; rows marked † re-read at 16:05, ‡ at 02:45 UTC on 20 Oct, ◊ at 03:40 UTC, ※ at 04:54 UTC, ¤ at 05:20 UTC, ✦ at 08:00 UTC, and ♦ at 09:30–09:50 UTC)

| Piece | Where | State |
|---|---|---|
| Prime: actions pinned, Deno and the Supabase CLI from their releases | npc-property-dashbord#3342 | **Merged** 14:39:50 UTC as `66290065` (merge commit, `--match-head` `f2eef880`). On `main`: CI 9085 green; Deploy Supabase functions 1124 green, but it deployed nothing (§3, F17); PDF Import Release Gate 4438 green. Deploy the PDF-import sidecar (run 3) and Deploy the render container (run 5) `startup_failure`: they name `google-github-actions/*`, the owner's allow-list item. |
| ◊ Prime: `listings-cache` memory fix | npc-property-dashbord#3341, head `efeead42` | Open, unchanged. Green on its own CI 9082. `mergeable_state: unstable` only for the old `static-and-fast`. Its three pin commits are cherry-picks of #3342's, so they merge as no-ops. **Merging it redeploys every Edge Function** (it changes `supabase/functions/_shared/listingsCache.pure.ts`, and a `_shared/` change deploys all), which is also the CLI step's first production run. ◊ Still at that head, and still `unstable` on the old `static-and-fast` alone. ※ **Merged** at 04:05:51 UTC as `adb6bc5e` (merge commit), Prime's head now. Its acceptance was observed on `main`. CI 9092 is green. Deploy Supabase functions run 1125 printed CLI `2.121.0`, deployed 428 functions and verified CORS on 360. It held back `aml-reliance`, which is listed in `.github/deploy/held-functions.txt` and ships only through the administrator's release workflow (§5). Prime's `listings-cache` answered 546 up to 04:00 and 200 from 04:15. It synced 692 live records from `tblumTIRYBn92B2ST`, reconciled them, and read retention as effective. ¤ It reached npc-client-dashboard's repository with #379 and no clone's backend. On `plisdzywzleljorrphxv`, `listings-cache` is the copy deployed at 00:36:55 UTC on 11 Oct (F23). |
| †‡◊ Prime: the `pdf-extraction-v3-gates` fix (the handoff's step 3) | npc-property-dashbord#3343, branch `claude/sweet-tesla-pdemno`, head **`6546c389`** (5 commits) | **`static-and-fast` passed on `60495442`** — run 39275041962, job 118137024278, 15:06–15:08 UTC, the first green run of that check since it was created. On the runner Playwright installed Chromium v1248 `--with-deps`, the detector found it, the pure suites ran 50 tests and the e2e passed 2, giving `releaseReady: true` with 7 required checks: 0 failed, 0 skipped, 0 unavailable. **Then Codex's review (15:26) found the first cut too narrow (P1) and too lenient on expired signatures (P2), and applying its rule found F19.** Both accepted: `e86bec0a` removes `report.pdf` and `final.png`, and `9563070a` bans media anywhere but named asset directories and makes every complete signature a finding. Both threads were answered and resolved. Locally on `9563070a`: release-gate specs 53 passed, CI's Template Builder step 345 files and 4,394 tests passed, the static and fast gates PASS, and the tracked scan reads 0. ‡ **CI on `9563070a` finished green but for one check.** `verify`, `security`, all three shards, `template-geometry`, `static-and-fast` and `pdf-import-regression` passed, and the rest were skipped by scope. `pdf-import-release-gate` (run 39281399479, job 118156219877) failed at 50/100 on exactly the two files `e86bec0a` deletes (F20). The fix is `6546c389`, whose parent is `9563070a`. ◊ **#3343 was fast-forwarded onto it at 02:49 UTC.** On `6546c389`, `pdf-import-release-gate` passed (run 39360974034, job 118426828417), as did `static-and-fast`, `pdf-import-regression` and `security`; `template-geometry` and all three `verify` shards passed too, and `verify` went green at 03:13 UTC (CI run 39360973961), with `abs-register-liveness`, `render-container` and `supply-chain` skipped by scope. **It is green, `mergeable_state: clean`, and waits only on the owner's merge.** The description now covers the fifth commit. ※ **Merged** at 04:05:44 UTC as `f99219bb`. Its merge ran `pdf-extraction-v3-gates` on `main` (run 104). In `generated-full`, the private-artifact scan and the generated-full gate both passed, where the two scheduled runs before it on `main` (102 and 93) failed. PDF Import Release Gate 4442 on `main` is green. |
| †‡◊ MC: a refresh over hand commits proceeds where both sides agree or merge cleanly | aurixa-mission-control-12b89885#346, branch `claude/sweet-tesla-pdemno`, head `da38d5c6` | ‡ **Ready** (marked at 16:08), `mergeable_state: clean`. **New since 14:05, and now a prerequisite for #379** (§3, F15). Tests 448 files / 9,061 passed locally. CI green on `228064c6` (run 39282801101: Typecheck · Lint · Build, and the Lovable install check). Codex reviewed `228064c6` and found nothing. Needs a Lovable publish after merge. ◊ Fast-forwarded onto `da38d5c6` (the 02:45 update) at 02:49 UTC, and CI is green on it (run 935). The description now names F20 and #124. This second update is one commit on top of it, on `claude/confidential-report-cleanup-at2jfw`. ※ **Squash-merged** as `e117f94c` and **published** from Lovable. The live engine's first act on #379 was the preserving merge (`f0784bee`, 04:13:16 UTC). |
| MC: forwarded configuration follows MC's value | aurixa-mission-control-12b89885#345 | Unchanged; held on purpose until #3341 is on all four clones (F4). ※ Still held. #3341 is on npc-client-dashboard (through #379) and on no other clone (F21). ¤ Still held, and the condition is stricter than it read: #3341 has to be on each clone's **backend**, and it is on none (F23, Step J). ✦ Unchanged. ♦ Still held. #3341 is in every mirror clone's repository now, and its `listings-cache` is on none of the four backends yet: the fresh deploy runs land one bundle a pass (F26). |
| †‡◊ Clone `npc-client-dashboard` cascade | npc-client-dashboard#379, head `06d2d096` | Unchanged and still held on `static-and-fast` (run 62, 13:03 UTC). The 15:00 pass deferred its refresh (F15); the 15:03 pass found the statement for prime `66290065` equal to its head ("carries this exact tree"). Every pass since has deferred the same way, the latest at 15:59:00 (events `0aa71083`, `58333aed`, `d9fd07ee`, `0b329741`). Its tree holds both F19 files. ‡ Unchanged on 20 Oct: the passes at 02:35 and 02:37 UTC deferred its refresh in the same words. ◊ So did the pass at 03:39 UTC (event `0b329741`). ※ **Merged** by MC's drain at 04:36:47 UTC as `ba5efc24`. The live engine refreshed it at 04:13:16 with a preserving merge: `f0784bee` over `786f235c`, which carried 1,011 files from prime@`adb6bc5`. That refresh deleted both F19 files, and neither is on `main` now. Every check on `f0784bee` passed by 04:36:39, `verify` included. On `main`, Deploy Supabase functions 239 and PDF Import Release Gate 981 are green, as is pdf-extraction-v3-gates 65; CI 1309 was still running. The two container deploys hit `startup_failure` (the §5 allow-list). The passes since read *"Nothing to cascade: all 65 differing path(s) are withheld by this clone's exclusion policy"*. Eight of those 65 paths are the oversized seed migrations. ¤ CI 1309 on `ba5efc24` finished green at 04:55:28 UTC. Deploy Supabase functions 239 is green because it stands down on a clone (*"Supabase functions deployed by Mission Control"*), so it deployed nothing (F23). |
| ‡◊ Clone `npc-crm-independent`: pins | npc-crm-independent-6505dc#123, head `86a9fa5b` | Unchanged on 20 Oct. Every check green except `static-and-fast` (the V2 scanner, not required). It is not a cascade PR, so MC's drain does not hold it; it merges when a person merges it. ◊ Still at that head. #124 carries its `ci.yml` byte for byte, so the two merge in either order (Step E). ※ **Merged** at 03:48 UTC as `2a26ddce`, after #124. On `main`, CI 634 is green on every job, and PDF Import Release Gate 475 and Deploy Supabase functions 80 are green too. Deploy the PDF-import sidecar and Deploy the render container (run 2 each) hit `startup_failure` (the §5 allow-list). |
| †‡◊ Clone `npc-crm-independent`: cascade | npc-crm-independent-6505dc#121, head `25acc6eb` | Unchanged since 17 Oct. Its last run failed `verify` and `security` on F10's held files, and never ran `static-and-fast`. The engine is still working it: four `pushing` rows (events `0aa71083`, `58333aed`, `d9fd07ee`, `0b329741`), each at `attempts` 3, last touched 15:50–15:59, with no `pr_url` yet. Its tree holds both F19 files, and the cascade cannot remove them there (Step E). ‡ On 20 Oct its rows still cycle from `queued` to `pushing` about once a minute, the latest at 02:37 UTC (events `58333aed`, `d9fd07ee`, `0b329741`), with no `pr_url` and no `error_message`. ◊ The same at 03:40 UTC, the latest cycle at 03:39 (event `0b329741`), and its head is still `25acc6eb`. ※ MC's drain restated it over `2a26ddc` at 04:10:56 UTC. That commit is `f0248243`, and its message reads *"the proposal's side stands for every path it states (939 restated, 6 deleted)"*. It still carries prime@`0da692c` across 945 files. It is still red on `verify` (F10's held files) and on `security`, whose regenerated `SECURITY_INVENTORY.json` disagrees with the committed copy. The engine has pushed nothing to it since, and cannot (F21). ✦ Still at `f0248243`. The five events still cycle: between 07:48 and 07:55 UTC each was claimed in turn (`58333aed` 07:48, `85347b61` 07:50, `0b329741` 07:53, `d9fd07ee` 07:54, `cc61ed81` 07:55), and each CRM row was back at `pushing` or `queued`. In `58333aed`, NPC Test's and Preflight's rows are `pr_opened` (#228, #227). In `d9fd07ee`, Preflight's row was `pushing` at 07:54. In the other three, both children's rows are `skipped`. ♦ Still at `f0248243`. All five F21 events retired between 08:27 and 08:37 UTC, and `e2c35fc3` (this session's Cascade now) at 09:19:05. That event's CRM pass was the line's first traced one: it entered `deliver` at 25.3 s and recorded nothing after it (F27). Nothing has been pushed to the line since 17 Oct. |
| ‡◊ Clone `npc-crm-independent`: the F19 deletion | npc-crm-independent-6505dc#124, branch `claude/confidential-report-cleanup-at2jfw`, head `6ebc853c` | **Opened at 02:49 UTC on 20 Oct.** `6ba9451d` removes `report.pdf` and `final.png` (Prime's blobs) on top of `main` `6322c63e`, and Codex reviewed it and found nothing. Its first `CI` run (631) ended in `startup_failure`, because a pull request's workflow is read from `main`, where every action is named by a tag. So `6ebc853c` carries #123's `ci.yml` byte for byte (blob `e92dbf46`), the only workflow the pull request triggers. Run 632 on `6ebc853c` then passed all six of its jobs by 03:38 UTC (`verify`, `security`, `supply-chain`, `render-container`, `template-geometry` and `abs-register-liveness`), and the Vercel preview built. **It is green and waits only on the owner's merge.** Step E says how it may land. ※ **Merged** first, at 03:47 UTC, as `b11f3de4`. Its `main` run (CI 633) was cancelled by #123's push a minute later. PDF Import Release Gate 474 could not start, because that workflow was not yet pinned on that commit. Both F19 files are off `main`. |
| †‡◊ `clones` | MC database | Unchanged at 16:05, at 02:45 UTC on 20 Oct, and ◊ at 03:40: CD `cascading` (596 behind); CRM `cascading` (928); NPC Test `cascading` (635); Preflight `behind` (635). The two children wait on lineage for #379 ("Parent NPC Client Dashboard carries prime@881e7e0; this pass delivers prime@6629006"). ※ At 04:44 UTC: CD `in_sync` at `adb6bc5e` (0 behind). CRM `cascading`, 939 behind, last cascade 17 Oct 04:00. NPC Test `cascading` and Preflight `behind`, 646 behind each, last cascade 16 Oct. NPC Test #228 and Preflight #227 opened at 04:51 and 04:53 UTC; their checks were running. ¤ Both children's pull requests are red on `security` alone (F22). ✦ At 08:00: CD `in_sync` at `adb6bc5e`, 0 behind. CRM `cascading`, 939 behind, last cascade 17 Oct 04:00. NPC Test and Preflight `cascading`, 646 behind each, last cascade at 04:51 and 04:53 UTC on 20 Oct. Prime's head is still `adb6bc5e`, so no new event has been made since 04:09. ♦ At 09:29 UTC: CD, NPC Test and Preflight `in_sync` at `adb6bc5e`, 0 behind, the children's last cascade at 09:20:16 and 09:14:29. CRM `cascading`, 939 behind, last cascade 17 Oct 04:00. |
| ¤ Clone NPC Test: cascade | npc-test-76b3b3#228, branch `aurixa/cascade-ba5efc2-mvg7gwco`, head `d203fa37` | Carries 1,042 files from npc-client-dashboard@`ba5efc2` (prime@`adb6bc5`), including the deletion of `report.pdf` and `final.png`. CI run 39371757583 finished at 05:14 UTC. `verify` and its three shards, `template-geometry`, `render-container`, `abs-register-liveness` and `supply-chain` are green. `security` is red at its first step, the inventory diff, and every later step was skipped. The committed `SECURITY_INVENTORY.json` is blob `6d71ffda`; the generator run on this head writes `b6c0612a` (F22). ✦ Unchanged at `d203fa37`, `mergeable_state: unstable`. ♦ **Merged** by MC's drain as `e211a45` at 09:20 UTC, after this session's `362bebb` (the regenerated inventory, blob `b6c0612a`, on the owner's word). Every check passed on `362bebb`, `security` and `verify` included. Neither F19 file is on `main`. |
| ¤ Clone Preflight: cascade | preflight-property-group#227, branch `aurixa/cascade-ba5efc2-mvg7jo1k`, head `e254d163` | Carries 1,109 files and the same deletion. CI run 39371948120 finished at 05:15 UTC with the same result: everything green but `security`, red on the inventory diff. Committed blob `73bab274`; regenerated `b6c0612a` (F22). ✦ Unchanged at `e254d163`, `mergeable_state: unstable`. ♦ **Merged** by MC's drain as `53fa3fd` at 09:14 UTC, after this session's `e74ee82` (the same regeneration, the same blob). Every check passed. Neither F19 file is on `main`. |
| ¤ Clone backends: edge functions | MC `remediation_runs`, `edge_function_deploy` | Each clone's latest run is parked `awaiting_validation`, the fourth of a chain whose first three the planner retired itself: npc-client-dashboard `28ddbe05` (parked 12 Oct 16:20 UTC), npc-crm-independent `12cce521` (12 Oct 16:34), Preflight `6b905563` (12 Oct 15:48) and NPC Test `10638fbc` (13 Oct 16:24). Each reads *"1 bundle(s) deployed over 30 passes and more remain"*. On `plisdzywzleljorrphxv` the last function the lane deployed is `generate-investment-report`, at 16:20:48 UTC on 12 Oct (F23). ✦ All four unchanged: `awaiting_validation`, 31 of 30 attempts, none rejected. ♦ **All four rejected** at 08:44:14 UTC on the owner's word, by the same write the admin button makes (no ticket was linked to any of them). The 08:50 catch-up sweep planned four fresh whole-fleet runs (`be33dee3` CD, `638d36d8` CRM, `91387dc1` NPC Test, `0598f988` Preflight), status `planned`. By 09:33 they had landed 9, 2, 3 and 3 bundles, 17 rows in `clone_function_deploys`: one bundle every two minutes or so across the fleet, because the drain serves one run a tick (F26). CD's first were `bulk-import-clients` and `estimate-property-value`, never on that project before. Every pass's `pass_ms` reads a 49–59 s snapshot of a 55–66 s pass (F26), and two passes ran long enough to be reclaimed by the 20-minute stall rule. On `plisdzywzleljorrphxv`, `listings-cache` is still the 11 Oct copy. |
| ✦ MC: the engine fixes for F21, F22 and F23 | aurixa-mission-control-12b89885, branch `claude/confidential-report-cleanup-at2jfw`, head `d4a3854c` | Three commits on top of the fourth update (§4), no pull request. Three additive migrations: `20261020090000_clone_function_deploys`, `20261020100000_cascade_results_progressed_at` and `20261020100500_cascade_results_pass_trace`. Checked locally on `d4a3854c`: 469 test files and 9,441 tests passed, along with `tsc --noEmit`, the seventeen repository checks, Prettier and ESLint (one warning, also on `main`). MC runs no CI on a branch without a pull request, so CI has not seen it. ♦ **Merged** by the owner as #347 (`941c61a1`, 08:22 UTC), published by 08:27, and its three migrations applied (the digest manifest refresh #348 lists them). The new retirement text was on the 08:27 notice. |
| ♦ MC: Cascade now for the children and the CRM line | MC `cascade_events` `e2c35fc3`, scope `selected` | Created at 08:43:48 UTC on the owner's word: `pr` mode, NPC Test, Preflight and NPC CRM Independent, the rows the Cascades page writes. Claimed at 08:46, 08:57 and 09:08, and retired at 09:19:05 with nothing delivered. Its three traces are F25's and F27's readings: NPC Test was ended in `tree`, Preflight in `proposal`, and the CRM line in `deliver`. The children were landed by hand instead (Step I). |
| ♦ MC: the engine changes the traces call for | aurixa-mission-control-12b89885#349 (draft), branch `claude/gifted-meitner-b3towe` | Six engine commits on `main` `4e94c9bc`, then this update and two corrections: `5493b9a1` (F24), `47330853` (F25), `c47b3f90` (F26), `4930b4aa` (F23 remedy 1), `64ee4047` (F28) and `d30fbd48` (F27). CI's build failed on `cdb2f148`: `64ee4047` put the drift rule under `src/server/`, which TanStack Start's import protection denies to client-reachable code, so the last commit moves it to `src/lib/`. No migration. Checked locally on the head: `npm run build` (and the same build failing with the old import), `tsc --noEmit`, the eighteen `check:*` scripts, and the full suite, 472 files and 9,487 tests. Every new guard was shown to fail on the defect it names. Not merged or published. |
| `clone_backend_secrets.AIRTABLE_TABLE_NAME` | all four clones | `inherited`, last set in September; `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` `withheld`. Unchanged until #345 is published. |

---

## 2. Execution plan — what remains, in order

### Step A — the owner approves the merges

Every step below that merges needs the owner's go-ahead, or the owner's own
hands. Nothing else in this list is blocked.

※ **Given** on 20 Oct, before 03:45 UTC: proceed with merging and publishing
directly.

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

※ **Done.** #346 was squash-merged as `e117f94c` and published. The
acceptance was observed: the preserving merge `f0784bee` landed on #379 at
04:13:16 UTC.

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

※ **Done.** #3343 merged as `f99219bb` (04:05:44 UTC) and #3341 as
`adb6bc5e` (04:05:51), both with merge commits. Both acceptances were
observed: the CLI `2.121.0`, 428 functions deployed, and `listings-cache`
at 200 with 692 records; `generated-full` green in run 104 (§1).

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
on their pull requests too.

※ **npc-client-dashboard is done**: #379 merged as `ba5efc24`, both files
deleted, every check green. **NPC Test and Preflight are not.** From the
first pass after #379 merged, their lineage hold is satisfied, because CD
carries prime@`adb6bc5`, which is prime's head. But in any event whose CD
row is still queued, they sort behind the CRM row (both CD and the CRM are
roots), and the CRM row's pass never returns (F21). In an event whose CD
row is done, they are roots too, and the round robin puts them first. That
is how they moved. NPC Test #228 opened at 04:51:21 UTC (1,042 files) and
Preflight #227 at 04:53:29, each from prime@`adb6bc5` through CD's branch.
Neither file is at the root of either head (`d203fa37`, `e254d163`), and
both are still on each `main`. MC's drain lands them when their checks are
green. Watch:

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

※ **#124 and #123 are merged**: `b11f3de4`, then `2a26ddce`. The two files
are off the line's `main`. The rest of this step is stuck. It waits for the
engine to finish re-pushing #121, and F21 shows that cannot happen as the
engine stands. Step H says what can.

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
※ Still waiting: #3341 is on one clone of four. It needs NPC Test and
Preflight to land (Step D) and the CRM line to move (Step H).
¤ And "on a clone" means on its backend. A cascade's merge deploys no
function on a clone (F23), so #3341 is on no clone yet. Read it from each
clone's project: the Management API's
`GET /v1/projects/<ref>/functions/listings-cache` has to report an
`updated_at` later than the merge that carried #3341 (Step J).
♦ #3341 is now in all three mirror clones' repositories, and still on no
backend. The deploy lane is moving again (Step J), but at one bundle a
pass, and `listings-cache` is about 41st in its order on
npc-client-dashboard. #349's pool (F26) is what brings that within hours.

```sql
select c.name, s.name, s.status, s.set_by, s.last_set_at, s.last_error
from clone_backend_secrets s join clones c on c.id = s.clone_id
where s.name = 'AIRTABLE_TABLE_NAME' order by c.name;
```

### Step G — verify each clone's `listings-cache`, and update these documents

As the handoff's steps 7–8.

### Step H — get the CRM line's cascade moving again (F21)

Nothing is lost by waiting. No write reaches the line while it is stuck.
But nothing reaches it at all, and each stuck event spends a 60-second
invocation every time it is claimed. There are two ways, and they can be
combined:

1. **Make the pass keep what it reads** (in MC; F21's remedy). This is the
   class. A clone whose pass cannot finish in one invocation never
   finishes, and every pass it misses makes the next one larger.
2. **Or shrink the pass** by landing #121. That means F10's reconcile on its
   branch, plus the regenerated security inventory, so it goes green and the
   drain merges it. The CRM's standing diff then drops by roughly what #121
   carries. Step E's "wait for the engine" condition cannot be met, and
   since #346 it is no longer what made a hand commit safe there. A refresh
   of a proposal carrying hand commits now merges where both sides agree or
   merge cleanly, and defers otherwise. It never overwrites them. Whether
   the drain should land 945 files of a five-day-old prime on the line is
   still the owner's call.

Retire the stuck events only after one of these. Retirement skips every row
an event never reached, NPC Test's and Preflight's included, so it must not
come before they land.

✦ **Remedies 2 and 3 are written, and so is the measurement remedy 1
needs:** `d4a3854c` on this session's MC branch (§4). Once it is merged
and its migration has run:

- **The five events retire.** No row yet carries `progressed_at`, so each
  retires at its first judgement after a reclaim. The exception is an
  event whose last attempt settled a clone after the deploy: that one
  retires one claim later. It is marked failed with a notification, and
  its `queued` and `pushing` rows become `skipped`. The caution above no
  longer bites. The rows behind #228 and #227 are `pr_opened` (event
  `58333aed`), and retirement touches only `queued` and `pushing` rows. If
  Preflight's row in `d9fd07ee` is still in flight then, it is skipped too,
  which costs nothing: #227 already carries that delivery.
- **The line still receives nothing.** That waits on remedy 1, or on #121.
  But an event that reaches it now retires, visibly, after three cuts,
  instead of cycling for ever. And its row's `pass_trace` names the stage
  each pass was in when the platform ended it, with the time.
- **Design remedy 1 from that reading,** not from the two candidates in F21.
  Read it with:

  ```sql
  select e.id, c.name, r.status, r.pass_trace
  from cascade_results r
  join cascade_events e on e.id = r.cascade_event_id
  join clones c on c.id = r.clone_id
  where r.pass_trace is not null
  order by r.updated_at desc limit 20;
  ```

  `describePassTrace` (`src/server/cascade/passTrace.pure.ts`) turns one
  trace into a sentence. A trace with no `outcome` is a pass that was ended
  in its last stage.

♦ **It went as written, and the reading is in.** The five events retired
between 08:27 and 08:37 UTC, each with its notice. The line's first traced
pass ran on 20 Oct at 09:08:03, in this session's `e2c35fc3`:

| Stage entered | At |
|---|---|
| `listing` | 0 s |
| `functions` | 4.5 s |
| `closure` | 5.7 s |
| `held` | 19.3 s |
| `variants` | 19.3 s |
| `deletions` | 21.2 s |
| `prefetch` | 21.2 s |
| `prepare` | 23.2 s |
| `deliver` | 25.3 s, and nothing after it |

Two of F21's guesses are now answered (F27). The import closure costs
13.6 s, so it is not where the line dies. The line never reaches the tree
write at all. The variant merges and the held probes, which used to pause
it, now cost nothing: their verdicts are on the ledger. So remedy 1 starts
inside `deliver`. In the deployed engine that is one mark for about a dozen
steps. #349 gives each its own (`registry`, `baselines`, `surface`,
`workflow`, `survivors`, `specs`, `recount`, `references`), so the line's
first pass after it is live names the step. Read it with the query above.

### Step I — land NPC Test #228 and Preflight #227 (F22)

Both are green on every job but `security`, and that job stops at the
inventory diff. The engine held `docs/security/SECURITY_INVENTORY.json` for
a person, and its own note names the remedy: `npm run security:inventory`
regenerates it from the repository. On each head the generator writes blob
`b6c0612a`, npc-client-dashboard's committed copy. Every other node step of
the job then passes as CI runs it. So one mechanical commit on each branch,
naming no prime commit, turns it green, and MC's drain merges it. That takes
F19's two files off the last two tips. This session did not make those
commits. The branches are the engine's, and both repositories were attached
to it read-only, so the commit waits on the owner's word. On each branch:

```sh
git clone --depth 1 --branch aurixa/cascade-ba5efc2-mvg7gwco \
  https://github.com/Naidu-Group-Pty-Ltd/npc-test-76b3b3
cd npc-test-76b3b3
node scripts/security/security-inventory.mjs --write
git hash-object docs/security/SECURITY_INVENTORY.json   # b6c0612a…
git commit -am "Regenerate the security inventory the cascade held back"
git push origin HEAD
```

Then the same in preflight-property-group on
`aurixa/cascade-ba5efc2-mvg7jo1k`. If the engine refreshes a branch first,
regenerate on the new head rather than reuse the blob: the hash is a fact
about that tree. A refresh after the commit merges over it (#346) rather
than overwriting it.

✦ `108d02bd` (F22) makes a lineage child take its parent's baseline. The
holds now count only the prime-only functions the source tree holds. Once
it is live, the next pass to reach NPC Test and Preflight should refresh
#228 and #227 with `b6c0612a` and turn `security` green, with no hand
commit. That is expected from the rule, not shown: no pass has run it yet.
It also needs an event that reaches them, which takes a Prime merge or
"Cascade now". The one commit above is still the fast route, and it still
waits on the owner's word.

♦ **Done, by hand, on the owner's word.** The Cascade now (`e2c35fc3`) did
reach both children, and both passes were ended before they could push.
NPC Test's was ended in the tree write, and Preflight's in the proposal
(F25). So, on the owner's word, this session made the commit above on each
branch, after re-running the generator on each head (`b6c0612a` on both):

- `362bebb` on #228;
- `e74ee82` on #227.

Both went green on every check. MC's drain merged #227 as `53fa3fd` at
09:14 UTC and #228 as `e211a45` at 09:20. F19's two files are off the tip of
all five repositories.

### Step J — get the clones' backends deploying again (F23)

1. **Now, in MC, by an administrator.** Reject the four parked runs
   (`28ddbe05`, `12cce521`, `6b905563`, `10638fbc`), from /support/tickets
   or the clone's backend deploy card. Do not approve them. Each already
   stands at 31 of 30 attempts, so an approved run parks again at the next
   prime merge. Rejecting frees the clone's one open slot. The next cascade
   merge or catch-up sweep then plans a fresh run, with a fresh chain. At
   the 12 Oct pace that is one bundle per clone every six to eight minutes,
   stalest first. `listings-cache` is about 41st in that order on
   npc-client-dashboard, so about five hours.
2. **The class, in MC's engine.** One of F23's remedies, or more. Until
   one lands, every chain ends parked again. The last ones took between
   two and a half and four and a half days.

   ✦ Remedy 3 is written: `05ab074e` on this session's MC branch (§4).
   Each bundle the lane lands is recorded in `clone_function_deploys`,
   with the digest of what it sent and the version the Management API
   answered with. A Prime merge then re-owes only the bundles whose
   source changed. Every pass also records `pass_ms`, where it spent its
   window, which is the measurement remedy 2 asks for. It unparks nothing,
   so item 1 is still the first act. The ledger starts empty, so a fresh
   run's first generation still owes every bundle once.
   `docs/EDGE_DEPLOY_LEDGER.md` models it at two deploys a pass and a
   merge every nine passes. On that model a whole-fleet run completes at
   about pass 215, where before it parked at about pass 279. Measured over
   Prime's 340 first-parent commits since 12 Oct with the lane's own
   modules: 1,383 bundle deploys re-owed under the ledger, against 135,763
   when every commit restarts the generation.

♦ **Item 1 is done.** On the owner's word, the four runs were rejected at
08:44:14 UTC. The write is the one `rejectRemediationRun` makes, compared
on each run's status and last update so a concurrent decision would have
won. None was linked to a ticket. The 08:50 catch-up sweep planned four
fresh whole-fleet runs, and the remediation drain took them.

**Item 2 has its measurement, and the larger half of the answer.** The
fresh runs' `pass_ms` (F26):

| Clone | Snapshot | Pass |
|---|---|---|
| Preflight | 49.3 s | 57.0 s |
| CD | 53.8 s | 59.3 s |
| CD | 49.6 s | 56.0 s |
| NPC Test | 55.7 s | 64.1 s |

Each pass landed one bundle, and the drain serves one run a tick, so
across the fleet that is one bundle every two minutes or so (17 by 09:33).
A pass that runs long is reclaimed only after 20 minutes in `executing`,
as NPC Test's and Preflight's have been. The ledger works: 15 rows by
09:28 UTC, and the bundles it recorded are skipped as proven. #349's pool
cuts the snapshot to about 16 s. That leaves about 29 s of each pass for
deploys, at 5–10 s each. Remedy 1 is in #349 too. Nothing is parked now,
so it changes nothing until a run parks again.

♦ **And without #349 they will park again.** At 10:19 UTC the four runs had
landed 26 bundles (CD 12, CRM 3, NPC Test 7, Preflight 4), and
`listings-cache` was on none of the four backends. CD's run still owed 389
bundles. At about eight an hour that is two days, and at #349's three or
four a pass it is about fifteen hours. A pass that overruns is
reclaimed after 20 minutes and charged an attempt, and 90 minutes in, the
runs stood at 3 or 4 of their 30. At that rate each exhausts its attempts
in 11–15 hours and parks. The planner then retires a park that records
only exhaustion and plans a fresh run, three times in a row, and the
fourth waits for a person: about two days from now, if nothing changes.
The ledger keeps what landed, so no bundle is owed twice. #349's pool is
what keeps a pass inside its window.

---

## 3. Findings since 14:05 (F15–F28)

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

### F21. The CRM line's cascade cannot finish a pass, and nothing retires it

- **What production shows.** Five events are `running` at once:
  - `d9fd07ee`, created 19 Oct 05:32;
  - `58333aed`, created 19 Oct 07:09;
  - `0b329741`;
  - `85347b61` and `cc61ed81`, created 20 Oct 04:05 and 04:09.

  Each holds a row for the line. The line has not completed a pass since
  17 Oct 04:00 (`clones.last_cascade_at`). Its standing diff was 390 files on
  26 Sep, 985 on 16–17 Oct, and is 1,360 now. pg_net keeps six hours of
  answers. In the six hours to 04:46 UTC on 20 Oct, 117 calls timed out at
  exactly 60,000 ms, 6 `hooks/cascade-drain` ticks claimed work and answered
  200 (`{"held":"resuming"}`), and 238 found nothing to claim. Every claim
  recorded on the five events from 04:23 to 04:49 falls in a tick that timed
  out. A pass the caller abandons can still finish: #379's refresh took about
  70 s, NPC Test's #228 76 s and Preflight's #227 77 s, and all three
  landed. No pass on the line has. After a cut its row is never written
  again: `updated_at` stays within a second of `started_at`, so the pass
  dies before its first ledger write and its pause never lands.
- **Why one pass cannot fit.** [`CASCADE_ONE_TICK.md`](./CASCADE_ONE_TICK.md)
  made the 26 Sep pass of 409 files fit by batching prime's text, at about
  35 s of the drain's 45-second budget. It also names what it does not change:
  "One clone that cannot fit still blocks the clones queued behind it."
  - **A pause keeps nothing.** Text is never ledgered; only binaries are. So
    the next pass starts from nothing, and every pause reads "4 of 1360
    file(s) prepared". The four are the line's binaries, and nothing else can
    ever count.
  - **When the line goes first, it pauses and repeats.** `cc61ed81`'s pass
    paused at about 46 s (04:22:02 to 04:22:48), and the next pass made the
    same reads again.
  - **When it does not go first, it is cut.** Its pass then reaches a stage
    no budget gates, and runs past pg_cron's wait. The database cannot say
    which stage. The two candidates are the import closure, whose prefetch
    is "Never cut short by the budget", and the tree write, which the
    budget does not gate. The children's passes (1,038 and 1,102 files)
    finished late; the line's (1,360 files and 35 held variants) has not.
- **Why nothing retires them.** `judgeExhaustedEvents` refunds an event at the
  attempt ceiling when its newest `cascade_results.updated_at` is under 15
  minutes old, reading that as "the last pass grew the ledger before it was
  cut". But the engine writes `status: 'pushing', started_at` to the row
  before any work (the update just before `processClone` in
  `cascade-engine.server.ts`), and a trigger stamps `updated_at` on every
  write. So a pass cut before it learned anything still reads as converging,
  and is refunded. All five events sit at `attempts` 3 and cycle:
  - the claim;
  - the cut at 60 s;
  - the stall reclaim ten minutes later;
  - the refund;
  - the next claim.

  The six-hour log shows a refund at 00:35, 03:50, 04:03, 04:15 and 04:37.
  Refunds made in ticks that timed out cannot report themselves.
- **What it held back, and what it did not.** NPC Test and Preflight waited
  four days, but the line was not the main reason.
  - **The lineage hold.** It kept them from moving until #379 merged:
    "Parent NPC Client Dashboard carries prime@881e7e0; this pass delivers
    prime@adb6bc5". #379 was itself stuck (F15) until #346 went live. So
    their last cascade was 16 Oct, 646 commits ago, and they still hold
    F19's files on `main`.
  - **The ordering.** A pass offers its clones least recently touched first,
    then `orderByLineageDepth` puts every root before every child. CD and
    the line are both roots. So in an event whose CD row is still queued,
    the children come after the line's row, which never returns, and they
    wait for the event's next claim after the ten-minute stall reclaim. By
    then CD's row is done, so they are roots too and the round robin puts
    them first. It costs a claim, not a day.
  - **Moving again.** Once CD carried prime's head, they moved. NPC Test's
    #228 opened at 04:51:21 UTC, carrying 1,042 files from prime@`adb6bc5`,
    and Preflight's #227 at 04:53:29. Neither file is at the root of either
    head (`d203fa37`, `e254d163`); both are still on each `main`.
  - **The pinned order.** `passOrder.test.ts` pins `["cd", "crm", "child"]`
    as the intended order, which is the order that starved them.
- **Five events for one commit.** Each running event delivers prime's head at
  run time, so all five deliver `adb6bc5` now and each repeats the others'
  work. The fold absorbs only queued events, never one that has started.
- **The remedy, in MC's engine.** None of this is made here; this finding is
  the measurement.
  1. **A pass keeps what it reads.** Ledger prepared text as clone blobs, the
     way binaries already are, at least once a pass has paused in `prepare`.
     Then a resumed pass reads only what is new. The import closure's answer
     must resume too, or be budgeted.
  2. **An exhausted event is judged by its ledger.** For example, `onProgress`
     stamps a time into `progress`, or the judge compares the ledger's size
     between passes. Never by `updated_at`, which the claim itself bumps.
  3. **A child follows its own parent, not every root.** Use a stable
     topological order over the round robin, so a child never waits behind
     a clone it does not depend on. The smallest of the three: it saves
     the children one claim each time CD needs a pass.

  ✦ **Status.** Remedies 2 and 3 are written (`d4a3854c`; Step H), with a
  trace of each pass's stages. One change from the text above: the judge
  counts a settled row as progress, as well as a grown ledger. That is what
  `drainOne` already counts for a pass that returns (`done > 0` or
  `progressed`). On the ledger alone, a pass the platform cut after it
  finished a clone would have read as one that learned nothing. Remedy 1 is
  not attempted. The trace is the measurement it needs, and there is none
  until the fix is live.

  ♦ **Remedies 2 and 3 are live** (#347, 08:27 UTC), and the five events
  retired as written. Remedy 1 waits on F27's reading.

### F22. The children's cascades are red on the baseline the engine kept for them

- **What CI shows.** NPC Test #228 (run 39371757583) and Preflight #227
  (run 39371948120) passed every job but `security` by 05:15 UTC on
  20 Oct. `security` failed at its first step,
  `npm run security:inventory && git diff --exit-code -- docs/security/SECURITY_INVENTORY.json`,
  and skipped every step after it.
- **Why.** The engine held the file for a person on both: *"This clone does
  not carry the GoHighLevel account migration (all 28 functions), which the
  prime keeps for itself, so the prime's security baseline is a static
  analysis of a different repository. The clone's own copy is kept. … Not
  reconciled here: `get-portal-client-data` takes source files from both
  the prime and this clone…"*. So each clone kept its own copy (`6d71ffda`
  on NPC Test, `73bab274` on Preflight), while the pass delivered the
  1,042 and 1,109 files that copy describes, new edge-function test files
  among them. Kept, it is stale.
- **Here the hold protects nothing.** Its trigger counts the prime-only
  functions a clone's tree lacks. Both children lack them, so it fires. But
  these passes deliver from npc-client-dashboard, which lacks the same 28.
  Its committed baseline, `b6c0612a`, regenerated by hand on #379
  (`5b6cf760`), is an analysis of the same function set. Run on each pull
  request's own head, the generator writes `b6c0612a` byte for byte. The
  engine cannot know that without running the generator, and it cannot run
  one: it composes trees over the API.
- **The rest of the job would pass.** On each head, every node step after
  the inventory was run here as CI runs it, with
  `BACKEND_DEPLOYED_BY=mission-control` (the scope job prints that both
  repositories set it). Each one passed: the registry, the static scan, the
  policies, every migration and index check, error disclosure, mass
  assignment, column names, cron callers, the baseline invariants, public
  validation, the negative tests and the launch-gate aggregator. The Deno
  steps and gitleaks were not run here. They were green on #379, and by
  the baseline's own measure these trees hold the same functions, so they
  are expected to pass, not shown to.
- **The remedy** is Step I, one commit per branch. In the engine, the hold
  could compare a lineage child with its source rather than with the
  prime. A child whose parent withholds the same functions would then take
  the parent's baseline, as a mirror takes the prime's.
- ✦ **The engine half is written** (`108d02bd`; Step I).
- ♦ **It is live** (#347) **and not yet shown.** The first pass to reach the
  children after it (`e2c35fc3`) was ended in the tree write before it
  could push (F25), and #228 and #227 were landed by hand (Step I).

### F23. No clone's backend has received a function since 12–13 Oct

- **What the clone shows.** On npc-client-dashboard's project
  (`plisdzywzleljorrphxv`), apart from one `street-view` write on 16 Oct,
  the last function deployed is `generate-investment-report`, at
  16:20:48 UTC on 12 Oct. That afternoon's deploys landed one bundle every
  six to eight minutes (15:10, 15:18, 15:26 … 16:14, 16:20). Its
  `listings-cache` is the copy deployed at 00:36:55 on 11 Oct, so #3341's
  fix, merged into the repository at 04:36 on 20 Oct, is not running there.
  `estimate-property-value` and `bulk-import-clients` are in the repository
  and not on the project at all.
- **Why a merge deployed nothing.** On a clone, `Deploy Supabase functions`
  stands down (*"Supabase functions deployed by Mission Control"*) and is
  green for that reason. MC's `edge_function_deploy` lane deploys a clone's
  functions, through one open run per clone, and every clone's run is
  parked `awaiting_validation`:

  | Clone | Run | Parked (UTC) |
  |---|---|---|
  | npc-client-dashboard | `28ddbe05` | 12 Oct 16:20 |
  | npc-crm-independent | `12cce521` | 12 Oct 16:34 |
  | Preflight | `6b905563` | 12 Oct 15:48 |
  | NPC Test | `10638fbc` | 13 Oct 16:24 |

  Each reads *"1 bundle(s) deployed over 30 passes and more remain"*. Each
  is the fourth of a chain whose first three the planner retired itself
  (`supersessionVerdict`, `MAX_CONSECUTIVE_SUPERSESSIONS = 3`), so it stays
  in front of a person. Every later plan folds into it and says
  `— BLOCKED`. Each park sent a notification to /support/tickets. The
  seven sent from 12 Oct 15:48 to 13 Oct 16:24 UTC are all unread.
- **Why every run parks.** These are whole-fleet runs (`slugs: null`),
  about 400 bundles each. On 12 Oct a pass landed one bundle. The parked
  run's last pass reads `in_flight: {done: 1, of: 60}` and
  `paused_at_budget: true`. A clone got a pass every six to eight
  minutes, so a whole generation needs about two days with the prime
  still. But `planDeployGeneration` restarts the generation on every prime
  merge (the parked run says `source_moved: true`), the prime merges about
  twenty times a day, and `planEdgeDeployResume` charges a restart an
  attempt. So a run never completes. It parks after about thirty prime
  merges, three such parks are retired, and the fourth waits. While a
  chain runs, the stalest-first order (#317) keeps the bundles turning
  over: 368 of the 427 functions on that project date from 11–12 Oct.
  Once it parks, nothing turns over.
- **What it costs.** Every function change merged to Prime since 12 Oct is
  in the clones' repositories and not on their backends. F4's precondition
  for MC #345 is about the backend, and no cascade alone can meet it.
  npc-client-dashboard's own cache shows the wait. `listings-cache`
  answers 200 there, two to four calls an hour. But `listings_cache` holds
  one table, `tblWIg5cs85O30pcY`, with 171 rows, 19 live, the newest first
  seen on 8 Sep, and nothing verified since 16:00 UTC on 8 Oct.
- **The remedies.** Step J's first act is an administrator's, now. The
  class is MC's engine, and none of this is made here. Smallest first:
  1. **A cascade's named deploys are not folded into a parked whole-fleet
     run.** `planFunctionDeploy` folds every plan into the clone's one open
     run, parked or not. A named run for what a merge changed would land
     in a pass or two.
  2. **A pass carries more than one bundle.** Measure first where a pass
     spends its 45 seconds. Before its first deploy it lists the clone's
     functions, reads the prime's head, and fetches a snapshot of sixty
     functions over the GitHub API. Then it deploys, and
     `generate-investment-report` was the last bundle landed. Not measured
     here.
  3. **A merge re-owes only what it changed.** A restart re-owes all ~400
     bundles because the prime moved, and that is what makes a whole-fleet
     run unfinishable. If each bundle recorded the source it was built
     from, a merge would re-owe only the bundles whose sources moved.

  ✦ Remedy 3 is written (`05ab074e`; Step J), and it records each pass's
  timing, which remedy 2 needs measured first. Remedy 1 is not attempted.

  ♦ Remedy 3 is live (#347). Remedy 1 is written (`4930b4aa`, in #349).
  Remedy 2 has its measurement and the first half of its answer (F26).

### F24. The merge drain's recount turned each retirement back into a success

- **What production shows.** #347 retired the five F21 events between
  08:27 and 08:37 UTC on 20 Oct. Each was marked `failed`, with a
  `cascade_failed` notice, and each row it never reached was settled
  `skipped` with *"Skipped: the carrier event was retired after 3 attempts
  without processing this clone."* All five read `completed` now. Their
  summaries were last written between 09:20:10 and 09:20:16 UTC, just
  after #227 and #228 merged. `0b329741` reads *"3 merged · 0 PRs · 0
  failed · 1 skipped (of 4) · 1 awaiting manual reconcile"*. In each event
  the CRM line's row is one of those carrier skips, and in `d9fd07ee` so
  is Preflight's.
- **Why.** The merge drain re-derives an event from its rows whenever one
  of them is linked to a pull request (`recountEvent` in
  `cascadeMergeDrain.server.ts`). It read a carrier's skip as a deliberate
  one, a clone that needed nothing, and an event with no failed row is
  `completed`. So any later movement on another row undid the retirement.
  The first rewrites came within eight minutes of each retirement, while
  #227 and #228 were still open.
- **What it costs.** `headRedelivery` redelivers prime's head only after an
  automatic failure, so an event that reads `completed` asks for nothing,
  and the clone it never reached waits for the next Prime merge. The
  blockage taxonomy reads a retired event by its status too. And the
  Cascades page shows the CRM line's four days without a pass as five
  completed cascades.
- **The remedy** is `5493b9a1` in #349.
  - `carrierSettlement.pure.ts` owns the sentence a carrier writes on a row
    it never reached, and `terminaliseOrphanedRows` composes it from the
    fate.
  - `countResults` counts such a row as *never reached*, and
    `cascadeEventStatus` counts it against the event. So a retired event
    reads `failed`, or `partial` where it merged or opened something.
  - The recount never rewrites a reviewer's rejection or a fold's
    supersession, whose first words other readers key on.

  It rewrites no event by itself, so the five keep their `completed`
  unless something recounts them. What changes is that a retirement from
  then on stays one. Under it, `0b329741` would read *"3 merged · 0 PRs ·
  0 failed · 0 skipped (of 4) · 1 never reached · 1 awaiting manual
  reconcile"*, and be `partial`.

### F25. The children's refreshes died in the tree write, in the same place each pass

- **What production shows.** The first traces came from the Cascade now
  `e2c35fc3`, claimed at 08:46, 08:57 and 09:08 UTC, one clone a claim:

  | Clone | Files | Before the tree | Last stage entered |
  |---|---|---|---|
  | NPC Test | 1,042 | 30.6 s | `tree` |
  | Preflight | 1,109 | 28.0 s | `proposal`, at 55.0 s |

  Neither recorded anything after its last stage, and neither branch
  moved. The event retired at 09:19:05 having delivered nothing.
- **Why.** The tree write was the one stage that never asked the
  invocation budget. It writes the delivery as a chain of `createTree`
  calls, 120 entries a chunk, and Preflight's ten chunks took 27.0 s. A
  pass that reached the tree at 28–31 s ran past the hook's 60 s. The next
  pass judged everything again and wrote the same chain again from the
  start, so it died in the same place.
- **What it cost.** The engine could not refresh the two pull requests that
  take F19's files off the last two tips. They were landed by hand (Step
  I).
- **The remedy** is `47330853` in #349.
  - `writeTreeChain` (`treeChain.pure.ts`) asks the budget before every
    chunk but the pass's first, and stops with the chain kept. A pass that
    wrote some of the chain and has no window left for the commit stops
    too.
  - The ledger keeps `tree_chain`: a key over the clone tree the chain
    starts from and every entry of every chunk, the chunks done, and the
    tree reached. A pass resumes it only where it is about to write the
    very same chain. A chain whose tree GitHub has collected starts again
    from the clone's tree, in the same pass.
  - `ledgerGrew` counts a chain that moved, so a pass that kept one is
    refunded like a pass that kept blobs.

  Checked on a simulation of the measured 1,109-file delivery: the chain
  completes in two passes, neither runs past 60 s, and the tree is the one
  a single uninterrupted chain writes. The simulation fails when the gate
  is removed. That the proposal then fits in what a resumed pass has left
  is expected, not shown.

### F26. The deploy lane's snapshot takes the whole tick, so four clones share one bundle every two minutes

- **What production shows.** After the parked runs were rejected (08:44:14
  UTC), the 08:50 catch-up sweep planned four whole-fleet runs. By 09:33
  they had landed 17 bundles between them: CD 9, CRM 2, NPC Test 3 and
  Preflight 3. `clone_function_deploys` recorded them one at a time, from
  08:52:59 to 09:33:07, about one every two minutes. Every pass records
  `pass_ms`, and the snapshot is most of it. The latest pass of each run:

  | Run | Snapshot | Deploy | Pass |
  |---|---|---|---|
  | CRM `638d36d8` | 50.4 s | 4.6 s | 55.3 s |
  | NPC Test `91387dc1` | 59.0 s | 6.7 s | 65.9 s |
  | CD `be33dee3` | 50.8 s | 6.0 s | 56.9 s |
  | Preflight `0598f988` | 49.2 s | 10.1 s | 59.5 s |

- **Why one bundle a tick.** The remediation drain executes due runs least
  recently served first, inside one 47-second tick, and starts no run with
  under 15 s left (`sweepSupportRemediations`). One run's snapshot spends
  the tick. So the four clones take turns, each gets a pass every eight
  minutes or so, and each pass lands one bundle. A pass that runs past the
  platform's limit sits in `executing` until the 20-minute stall reclaim,
  as Preflight's did at 09:34.
- **Why the snapshot takes 50 s.** `fetchPrimeBackendSnapshot` reads every
  file of every function at the prime's head, to prune each bundle and
  digest it. Measured locally against a GitHub that answers instantly,
  that is 30 GraphQL batches carrying 33.2 MB, in 1.6 s. At production's
  ~1.5 s a call, the batches one after another take 47.6 s, which is what
  the passes record.
- **What it costs.** A whole-fleet run is about 400 bundles a clone. At one
  bundle a clone every eight minutes, a first generation takes about two
  days a clone. The ledger (F23, remedy 3) means a Prime merge no longer
  restarts it, so it finishes. But `listings-cache` waits its turn, and on
  `plisdzywzleljorrphxv` it is still the 11 Oct copy.
- **The remedy** is `c47b3f90` in #349. The batches run four at a time,
  with the same requests and the same answers, and a batch GraphQL cannot
  answer still falls back to REST alone. At ~1.5 s a call that is 16.1 s,
  leaving about 29 s of the tick for three or four deploys. That is
  computed from the batches, not measured in production; `pass_ms` will
  say. Two further steps are not taken:
  1. **Keep the snapshot between passes.** It is a function of the prime's
     head, which moves about twenty times a day, while a clone takes a pass
     every eight minutes. Kept against the head commit, most passes would
     read it rather than rebuild it.
  2. **Deploy more than one bundle at a time.** A deploy is mostly a wait
     on the Management API. Measure first whether one project takes
     parallel deploys.

### F27. The CRM line dies in `deliver`, not where F21 guessed

- **What production shows.** The line's first traced pass, in `e2c35fc3`
  at 09:08:03 UTC, entered `deliver` at 25.3 s and recorded nothing after
  it (Step H's table).
- **What it settles.** F21 named two candidates, and the trace rules out
  both. The import closure takes 13.6 s (5.7 s to 19.3 s), so it is not
  where the line dies. And the pass never reaches the tree write. The held
  probes and the variant merges, which used to pause it (*"line variant
  merges asked for 24 of 35 held path(s)"*), take no time now: their
  verdicts are on the ledger.
- **What it does not.** In the deployed engine, `deliver` is one mark for
  everything from the prepared files to the tree. That is about a dozen
  steps, and most of them read the clone over the API: the config, the
  security registry and baselines, the mobile surface, the deploy
  workflow, the files that must survive prime's deletions, the spec
  channel, the recount and the reference check. One name cannot say which.
- **The remedy** starts with the reading. #349 marks each of those steps
  (`47330853` and `d30fbd48`), so the line's first pass after it is live
  names the step, and F21's remedy 1 is designed from that. Until then the
  line receives nothing, and #121 (`f0248243`) stays as it is.

### F28. The inbox is saturated, so the notices that needed a person went unread

- **What production shows.** At 09:45 UTC on 20 Oct, 7,919 notifications
  are unread. The "Needs attention" inbox, which has left successes out
  since 18 Sep (`notificationDisposition.ts`), holds 5,834 of them, and
  5,542 (95%) are two kinds:

  | Kind | Unread | Last 7 days |
  |---|---|---|
  | `drift_high` | 4,625 | 1,934 |
  | `deployment_bundle_identity` ("Wrong backend in the bundle") | 917 | 153 |

  Of the 374 inbox notices written in the last 24 hours, 361 were those
  two. Among the rest sit 32 `remediation_awaiting_validation`, including
  the seven that parked every clone's deploys on 12–13 Oct (F23), and 117
  `cascade_failed`: 149 notices, 2.6% of the inbox. In the last 30 days
  `read_at` was set on 140 notices:
  139 `cascade_blocked`, which the merge drain clears itself when a
  proposal closes, and one `tokens_alert`.
- **Why `drift_high` repeats.** The fleet drift scan meant to notify when a
  clone enters a behind state. Its guard read `sync_status` alone (`behind`
  or `failed`), so it never held for a clone in `cascading`, which a stuck
  clone holds for days. And the title check behind it always passed,
  because the titles are model-authored and never repeat. NPC CRM
  Independent drew one at 08:30, 08:45, 09:01, 09:15 (two) and 09:31 UTC,
  each about the same 939 commits, each in new words. The scan also calls
  a model for every clone that is behind, every fifteen minutes, whether
  or not it notifies; #349 does not change that.
- **Why the bundle notice repeats.** Every correctly configured clone's
  bundle names the prime's project ref, because that is how a build
  recognises the prime (`PRIME_BACKEND_REF` in
  `src/lib/primeDeployment.ts`). So a scan of the text can only read
  `carries_both`, which is *unproven* by its own definition, and each one
  is written as an `error`. All 917 are `carries_both`. MC trusts a
  build's own declaration over the scan: a `supabase` block in
  `/version.json`, written through the same resolver the client runs. The
  CRM line's `vite.config.ts` writes it, and the line has drawn none of
  these since 20 Sep. Prime's `buildVersionManifest` writes `{ buildId }`
  alone, and so do its three mirrors. So every probe of them reads
  `carries_both`: on every deploy, every six hours, and after each re-sync
  rebuild.
- **What it cost.** The notices F23 depended on were sent, and nobody read
  them for a week.
- **The remedy.**
  - `64ee4047` in #349 stops the repeats, and raises nothing that was not
    raised before. `driftNoticesToRaise` keeps the old guard and adds the
    transition the scan can see: a scan whose stored suggestions already
    held a high one has announced the episode. `repeatsLastBundleNotice`
    reports `carries_both` once per artefact, plus once more when the
    re-sync asked for that artefact changed nothing, which is a different
    sentence. `carries_prime` keeps its cadence. The tests replay the
    model's answers and the notice metadata production wrote, and fail
    when the old rule is put back.
  - **The root of the bundle notice is in each clone's build, and is not
    made here.** The CRM line's `buildVersionManifest(env)` is the change:
    it resolves the target with `resolveSupabaseTarget` over Vite's own
    `loadEnv`, and writes `supabase: { projectRef, source }`. But
    `vite.config.ts` is `protected` on all four clones
    (`clone_sync_exclusions`, seeded from `DEFAULT_MIRROR_EXCLUSIONS`), so
    no cascade carries it. It has to be made in each mirror's own
    repository, as the CRM line made it in its own, and in Prime, so that a
    clone provisioned from now on starts with it. Each clone's next build
    then declares `carries_own`, and the check stops inferring. That is
    four pull requests, each the owner's word (§5). Prime's half is
    written: `629db7de` on Prime's `claude/gifted-meitner-b3towe`, with no
    pull request. It is the CRM line's plugin and spec, ported, and three
    of the spec's six tests fail on Prime's config without it.

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

### And from 03:45 UTC on 20 Oct, on the owner's word

- npc-crm-independent #124 merged as `b11f3de4` (03:47), then #123 as
  `2a26ddce` (03:48), both with merge commits.
- MC #346 squash-merged as `e117f94c`, carrying the 03:40 update, and
  published from Lovable. This session's MC branch was then reset onto it,
  since it held only merged history.
- Prime #3343 merged as `f99219bb` (04:05:44) and #3341 as `adb6bc5e`
  (04:05:51), both with merge commits.
- Not this session's acts: MC's drain merged npc-client-dashboard #379 as
  `ba5efc24` (04:36:47), and the engine opened NPC Test #228 (04:51:21)
  and Preflight #227 (04:53:29).
- MC, `claude/confidential-report-cleanup-at2jfw`: this third update, with
  F21. It is one commit on top of MC's `main` and no pull request.
- MC, the same branch: the fourth update, with F22 and F23, one commit on
  top of the third. Nothing else was merged, pushed or published.

### And from 05:30 UTC on 20 Oct, on the owner's word to keep working

On MC's `claude/confidential-report-cleanup-at2jfw`, in this order, on top
of the fourth update:

- `05ab074e` — **F23: a Prime merge re-owes only the bundles it changed.**
  - `clone_function_deploys` (migration `20261020090000`) records each
    bundle the lane lands: the digest of exactly what it sent
    (`functionBundleDigest.pure.ts`), and the function id and version the
    Management API answered with.
  - A copy counts as current only where Prime's digest is unchanged AND
    the clone still lists that very deploy. Every doubt resolves to owed,
    and a ledger that cannot be read leaves the lane as it was.
  - The generation and its skip list are planned at the commit the
    snapshot read, so the revision judged is the revision deployed.
  - A move is charged an attempt only where the ledger could not carry it.
  - Every result records what was owed, the ledger's reading, and
    `pass_ms`.
  - `docs/EDGE_DEPLOY_LEDGER.md` has the measurement and the model.
- `108d02bd` — **F22: a lineage child's security baselines are measured
  against its parent.**
  - `withheldBySource` keeps only the withheld functions the source tree
    holds. From the prime that is all of them, so nothing changes off the
    lineage edge.
  - The hold notes and the pull request body name the source rather than
    the prime. With the prime as source, every sentence is byte-identical.
- `d4a3854c` — **F21: an exhausted event is judged by kept progress.**
  - `progressed_at` (migration `20261020100000`) is stamped in exactly two
    places. One is a ledger flush holding an entry the pass did not start
    with. The other is a row's settlement, and all four settlements in the
    clone loop go through `writeSettlement`. The judge reads it, and never
    `updated_at`.
  - A child follows its own parent (`orderByLineage`, a stable topological
    order). It no longer waits behind every root.
  - Each pass's stages are written to `pass_trace` (migration
    `20261020100500`; `passTrace.pure.ts`) without waiting on the write.
    Each clone then waits, bounded at two seconds, for its outcome to
    land. A rate-limited or server-deferred clone records `deferred`.
  - Every new guard was shown to fail on the defect it names, by planting
    it: a settlement written around the helper, a stamp on the `pushing`
    mark, the flush removed, a deferral recorded as a failure.
- This fifth update.

All three engine changes read their new columns defensively. Every writer
carries on without its column: the ledger flush and the settlement retry
without the stamp, the trace stops writing, and the deploy ledger reports
the failure and moves on. Every reader takes a failed read as no verdict.
So the publish and the migrations may land in either order. Until
the migrations run, the five events are left at the ceiling rather than
refunded, and nothing claims them. Checked locally on `d4a3854c`: 469 test
files and 9,441 tests passed, along with `tsc --noEmit`, the seventeen
repository checks, Prettier and ESLint. Nothing was merged, published or
opened as a pull request.

### And from 08:30 UTC on 20 Oct, by the session that continued this one

Its branch is `claude/gifted-meitner-b3towe` in MC. Besides that branch,
it pushed only to two of the engine's, on the owner's word.

- On the owner's word, at about 08:43 UTC:
  - Cascade now for NPC Test, Preflight and NPC CRM Independent (`pr`
    mode): event `e2c35fc3`, written as the Cascades page writes it.
  - The four parked deploy runs rejected (`28ddbe05`, `12cce521`,
    `6b905563`, `10638fbc`), by the write `rejectRemediationRun` makes.
  - Then, once the traces showed the engine could not land them, Step I's
    two commits: `362bebb` on npc-test-76b3b3
    `aurixa/cascade-ba5efc2-mvg7gwco`, and `e74ee82` on
    preflight-property-group `aurixa/cascade-ba5efc2-mvg7jo1k`. Each is the
    regenerated `docs/security/SECURITY_INVENTORY.json` (blob `b6c0612a`)
    and nothing else. MC's drain merged both.
- On MC's `claude/gifted-meitner-b3towe`, on `main` `4e94c9bc`, as draft
  pull request #349 (on the owner's word to push and open one):
  - `5493b9a1` — **F24**: a retired event stays failed through the merge
    drain's recount.
  - `47330853` — **F25**: the tree write asks the budget and is kept where
    it stops. The trace splits the spec channel, the recount and the
    reference check out of `deliver`.
  - `c47b3f90` — **F26**: the prime snapshot fetches its GraphQL batches
    four at a time.
  - `4930b4aa` — **F23, remedy 1**: a merge's named list runs beside a
    parked whole-fleet run (`plansBesideParked`).
  - `64ee4047` — **F28**: a standing condition is announced once, not
    every scan (`driftNoticesToRaise`, `repeatsLastBundleNotice`).
  - `d30fbd48` — **F27**: the trace names the five steps left inside
    `deliver`.
  - This sixth update, a correction to F28's remedy (`cdb2f148`), and the
    fix for the build CI refused on it: the drift rule moves from
    `src/server/` to `src/lib/`, because TanStack Start's import protection
    denies `**/server/**` to client-reachable code and
    `fleet-drift.functions.ts` is reached from `/fleet-manager`.
- On Prime's `claude/gifted-meitner-b3towe`, with no pull request:
  `629db7de`, the build declares its backend in `version.json` (F28's
  root, for clones provisioned from now on).

  None needs a migration. Each new guard was shown to fail on the defect
  it names, by putting the old rule back. Checked locally on the head:
  `npm run build`, `tsc --noEmit`, the eighteen `check:*` scripts,
  Prettier on every changed source file, and the full suite, 472 files and
  9,487 tests. Nothing was merged or published.

---

## 5. Only the owner can do these

0. ※ Done at 04:54 UTC: every merge in item 1 except MC #345, and MC is
   published. What is left of it is #345 and its publish, which still wait
   on Step F.
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
3. ※ Release `aml-reliance` to production. #3341's deploy held it back:
   it is listed in `.github/deploy/held-functions.txt`, and only the
   "Release a held Supabase function" workflow, dispatched by a repository
   administrator, ships it (Prime's `HELD_FUNCTION_RELEASE.md`).
4. ※ F21's decision (Step H): the engine fix, or landing #121, or both.
   Until one is made, the CRM line receives nothing and Step F waits.
   ✦ The engine fix's first half is written (`d4a3854c`), and landing it is
   item 8. It retires the cycling events and measures the line's passes.
   The line still needs remedy 1, or #121, before it receives anything.
   ♦ Remedies 2 and 3 are live and the events retired. Remedy 1 waits on
   F27's reading, which needs #349 live (item 9).
5. ¤ Step I's word: commit the regenerated inventory onto NPC Test #228
   and Preflight #227, or say who should. It is all that stands between
   F19's two files and the last two tips. ♦ Done on the owner's word:
   `362bebb` and `e74ee82`, merged as `e211a45` and `53fa3fd`.
6. ¤ Step J: an administrator rejects the four parked deploy runs in MC,
   and the owner chooses F23's engine remedy. Until a run is moving, no
   clone runs any function merged since 12 Oct, and Step F cannot be met.
   ♦ The rejections are done and the runs are moving. Remedy 3 is live, and
   remedy 1 and the first half of remedy 2 are in #349 (F26).
7. Everything in §6 of the 14:05 document still stands:
   - the Actions allow-list for `google-github-actions/*` and `superfly/*`;
   - a workspace-scoped Anthropic key for MC's autofix;
   - the rotations;
   - the eight oversized template-seed migrations.
8. ✦ Whether to land this session's MC branch: open a pull request from
   `claude/confidential-report-cleanup-at2jfw`, squash-merge it as MC does,
   and publish. The merge applies three additive migrations. The fourth
   and fifth updates of this document ride along.
   ♦ Done: merged as #347 (`941c61a1`) and published by 08:27 UTC.
9. ♦ Whether to land #349: mark it ready, merge it (#347 went in as a
   merge commit, which keeps each finding's commit on `main`), and
   publish from Lovable. It needs no migration, and this update rides
   along. Once it is live, the CRM line's next pass names where it dies
   (Step H), each deploy pass should land three or four bundles, a retired
   event stays failed, and the inbox stops repeating itself.
10. ♦ The root of F28's bundle notice. Add the CRM line's
    `buildVersionManifest(env)` to `vite.config.ts` in npc-client-dashboard,
    npc-test-76b3b3 and preflight-property-group, and in Prime. The file is
    `protected` on every clone, so no cascade carries it, and each is a pull
    request in its own repository. Prime's half is written (`629db7de` on
    Prime's `claude/gifted-meitner-b3towe`), and the same plugin block
    applies unchanged to each mirror's copy. Until then #349 keeps that
    notice to one per artefact.

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
- **A pass that keeps nothing between ticks grows until it never fits.**
  The line's standing diff went 390, 985, 1,360 while every pass started
  from nothing, and the longer it stood still the larger it became (F21).
- **Judge progress by the ledger, never by `updated_at`.** Every claim
  writes `pushing`, which the trigger stamps, so a pass cut before it
  learned anything reads as one that converged, and is refunded for ever.
- **A child waits for its parent, not for every root.** Ordering by depth
  puts every child behind every root, so a root that never returns costs
  every child a claim.
- **A merged cascade is not a deployed backend.** On a clone the deploy
  workflow stands down and is green for it. Read the function's deploy
  time on the clone's own project (F23).
- **A copy kept for a person goes stale the moment the pass lands.** A
  baseline held while the pass delivers what it describes is wrong after
  the merge. The hold's note names the command; somebody has to run it
  (F22).
- **Work folded into a parked run is queued behind nobody.** A park that
  absorbs every later plan turns one stopped run into a stopped lane.
- **Judge a cut pass as a returned one is judged.** The drain refunds a
  returned pass that settled a clone or grew its ledger. So the judge of a
  cut pass counts exactly those two. Counting the ledger alone retires a
  convergence that finishes a clone each pass.
- **An instrument that can drop its last word reads like the failure it
  measures.** A trace written without waiting can lose its outcome when
  the invocation returns, and a trace with no outcome is what a killed pass
  looks like. So the outcome is waited for, bounded, once the work is done.
- **A lineage child's baselines are its parent's.** Count the functions a
  clone withholds against the tree its bytes come from, never against the
  prime.
- **A recount must not rewrite a carrier's verdict.** A row an event never
  reached is not a row that needed nothing. Read as a deliberate skip, it
  turned five retirements back into successes within minutes (F24).
- **Every stage that can take seconds asks the budget, the last one too.**
  The tree write was the one stage that did not, so two passes died in it,
  in the same place, pass after pass (F25).
- **Measure where the window goes before deciding what to put in it.** The
  deploy lane's snapshot spent 50 of 57 seconds, so the four clones shared
  one bundle a tick. `pass_ms` showed it on the first pass that recorded it
  (F26).
- **An instrument's first reading moves the question.** The CRM trace ruled
  out both of F21's candidates and named a stage holding a dozen steps, so
  the next instrument goes inside that stage (F27).
- **A standing condition is announced once.** An alarm that restates an
  unchanged state every fifteen minutes buries the alarm that matters: 95%
  of the inbox was two such kinds, beside the park notices nobody read
  (F28).
- **Run the build, not only the type checker and the tests.** TanStack
  Start's client import protection is a rule only the build applies. F28's
  first push passed `tsc`, the eighteen checks and 9,487 tests, and CI's
  build refused it for importing a pure module under `src/server/` from a
  client-reachable `.functions.ts`.
- **A protected file is fixed once in every repository that protects it.**
  The CRM line added its `version.json` declaration to its own
  `vite.config.ts`, which every clone protects, so no cascade could carry
  it anywhere. The prime and its three mirrors never got it, and the
  mirrors drew 913 such notices between 19 Sep and 20 Oct (F28).
