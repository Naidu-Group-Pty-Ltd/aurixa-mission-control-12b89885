# Handoff — Prime's CI head, the Cloud Run removal and the children's workflow reconciles

**Written 21 Oct 2026, from 18:30 UTC, by the session that took over when the
previous one stopped.** That session (branch `ccr-1c6390f6-4pds8i` in MC) ran
out of context at 17:47 UTC and left no record of its last day. This document
is that record and the state at hand-over. **Brought up to date at about
06:05 UTC on 22 Oct**, after Prime #3359 and #3360 had reached every clone but
the CRM line (§0). §1–§5 are the state at 19:55 UTC on 21 Oct, kept as the
record of how it got there. It is deliberately short: read it first, and go to
[`HANDOFF_2026-10-19_CONTINUED.md`](./HANDOFF_2026-10-19_CONTINUED.md) only for
the cascade engine's findings F15–F31.

The owner's task, as given to the previous session: *focus completely on the
cascade worktree and the state of the Prime repo, and start by cleaning it so
that its CI head is clean and green, so that the cascade engine does not carry
forward faulty or broken code.*

---

## 0. State at about 06:05 UTC on 22 Oct

| Piece | State |
|---|---|
| Prime `main` | `d4fb7612`: #3360 (amenity register M11), merged 05:02:39 UTC. Before it, `d59560fe`: #3359, merged 22:42:18 UTC on 21 Oct, which retired Cloud Run from rendering and deleted `scripts/render-service/redeploy.sh`. Green on `main`: CI 9168 (39725763962) and Deploy 1133 (39725764001) on `d4fb761`; CI 9165 (39688407647) and PDF Import Release Gate 4454 (39688407975) on `d59560f`; the scheduled RBA refresh 26 (39697916342), migration drift check 42 (39685335564), AML sanctions refresh 85 (39680404078), and scheduled CI 9162 (39669359544, at its second attempt). |
| CD | `main` `911341a`: cascade #396 (prime@`d4fb761`, 5 files) merged 05:25:40 UTC; #395 (prime@`d59560f`, 15 files) merged 23:08:02 UTC on 21 Oct. CI 1355 (39727963615) and Deploy 246 (39727963612) green. MC: `in_sync`, 0 behind, at `d4fb7612`. |
| npc-test-76b3b3 | `main` `7371abe`: cascade #239 merged 05:48:44 UTC. CI 594 (39730160468) and Deploy 166 green. MC: `in_sync`, 0 behind, at `d4fb7612`. |
| preflight-property-group | `main` `9b509e2`: cascade #239 merged 05:51:39 UTC. CI 583 (39730440713, finished 05:59:47) and Deploy 163 green. MC: `in_sync`, 0 behind, at `d4fb7612`. |
| The CRM line | `cascading`, 1,064 behind, at `555df3ce`; last cascade 05:16 UTC on 21 Oct. #121 stays for a person. |
| MC `cascade_events` | Nothing live. The newest, 708b6a3a (prime@`d4fb7612`), finished `partial` at 05:50:04 UTC, and the merge drain has since recounted it: "3 merged · 0 PRs · 0 failed · 0 skipped (of 4) · 1 never reached · 3 awaiting manual reconcile". |

**How the children got #3356** (§5 expected it from 40ad41df's redelivery).
They got it from d6769363, a redelivery of prime@`638f2918` that finished
`partial` at 21:03:02 UTC: NPC Test #237 and Preflight #237 merged at 20:59–21:05
UTC with #3356's deletions and specs. Before that, each child's #236 (merged
20:59 UTC) moved `backendIsolation.spec.ts` to `src/lib/deploy/__tests__/`, the
port of CD #387 and #388, so §6.2 is done. Every child cascade since then
(#237, #238, #239) has held the same seven files for a person, as it should:
`clientFacing.ts` and its test, `renderAssetNormalisation.spec.ts`,
`lead-magnet-embed.html`, the moved `backendIsolation.spec.ts`,
`amlCasesCutoverLinkClientFacing.test.tsx` and `networkGuard.spec.ts`.

| Landing | When (UTC) | What |
|---|---|---|
| Prime #3359 | 21 Oct 22:42:18 | Cloud Run retired from rendering; `redeploy.sh` deleted |
| CD #395 | 21 Oct 23:08:02 | prime@`d59560f`, 15 files, `67ee9be` |
| NPC Test #238 | 22 Oct 00:45:06 | `efc606f` |
| Preflight #238 | 22 Oct 00:50:35 | `99198c9` |
| Prime #3360 | 22 Oct 05:02:39 | amenity register M11 |
| CD #396 | 22 Oct 05:25:40 | prime@`d4fb761`, 5 files, `911341a` |
| Preflight #239 | 22 Oct 05:51:39 | `9b509e2` |
| NPC Test #239 | 22 Oct 05:48:44 | `7371abe` |

**The CRM line is redelivered and cut, every time.** prime@`d59560fe` was
redelivered three times (fb302fd5, 5dc48128, ede0c2ee), about 95 minutes apart:
the 60-minute cooldown plus about 35 minutes of attempts. Each found the three
delivered clones in sync and spent its three attempts on the CRM, whose pass is
cut by the 60-second isolate limit every tick. The redelivery ceiling (three a
head) bounds it, so it is waste rather than a loop. Expect 708b6a3a's first
redelivery at about 06:50 UTC, with the same outcome for the CRM. Changing
which line a head waits on is an engine decision.

**Five retirements said nothing had happened.** 02047006, 302d58ff, fb302fd5,
5dc48128 and ede0c2ee each carry the fixed sentence "No pass
completed within 3 attempts and the last one kept nothing". It was not true.
302d58ff delivered CD #395 before its CRM pass was cut every tick; fb302fd5
delivered NPC Test #238 and Preflight #238 and found CD in sync. MC now
composes the sentence from the rows as the passes left them
(`composeRetirementSummary`, `exhaustedEvents.pure.ts`). Under it, 02047006
would read: *"Retired after 3 attempts, part-way through. Already in sync: NPC
Client Dashboard, NPC Test and Preflight Property Group. Not finished: NPC CRM
Independent."* Three things it does not do:

- **It changes no status.** A retired event stays `failed`, so the head
  redelivery and the blockage taxonomy (`attempts_exhausted`) read it exactly
  as before.
- **It backfills nothing.** The stored summaries stay as written.
- **It is not the last word.** If a row moves after the retirement (a
  proposal the passes opened merges), the merge drain's recount rewrites the
  summary as its counts line, as it already did.

**The clone retarget looked for the isolation spec in the wrong place.**
`retargetCloneRepo` step 2b rewrites a clone's `backendIsolation.spec.ts` to
name the clone's own project, and read only `src/lib/__tests__/`. Since the
moves (CD #387/#388, the children's #236s) it would have answered "absent" on
every repository carrying the spec, and a clone made from one of them would
have kept its parent's project ref and failed its first CI run. It now reads
`src/lib/deploy/__tests__/` first and the old path second. The old path in
`docs/LATERAL_MEMBRANE.md` (line 362) is a measurement from before the move
and is left as written.

**Scheduled workflows failing on CD and the children only.** The RBA
refresh, the migration drift check and the AML sanctions refresh have failed
on CD, NPC Test and Preflight since about 15 Oct, while all three are green on
Prime. The cause has not been looked into.

---

## 1. State at 19:50 UTC (superseded by §0)

| Piece | State |
|---|---|
| Prime `main` | `638f2918`: #3358, another session's two-document change, merged 19:12 UTC. It sits on `f5a2d5bc`, #3356, merged 18:56 UTC. Green on `main`: CI 9161 (39659591456), CI 9160 (39657220142), PDF Import Release Gate 4452 (39657220105) and the scheduled pdf-extraction-v3-gates 106 (39659212358). No `startup_failure` since #3356 merged; the last was run 39622804154, at 15:07 UTC. |
| npc-client-dashboard (CD) | `main` `fbe5e30e`: cascade #394 merged 19:41:48 UTC on full CI 1349 (39660035687), green. On `main`, CI 1350 (39663884660) and PDF Import Release Gate 986 (39663884651) are green. MC `clones`: `in_sync`, 0 behind, at prime@`638f2918`. |
| npc-test-76b3b3 | `main` `a14bf5d2`: cascade #234 merged 18:24 UTC and reconcile #235 merged 19:06 UTC. CI 584 (39658714278) green on `main`. MC: `behind`, 4. No open pull request. |
| preflight-property-group | `main` `fc9ba5c2`: cascade #234 merged 18:21 UTC and reconcile #235 merged 19:06 UTC. CI 573 (39658738125) green on `main`. MC: `behind`, 4. No open pull request. |
| The CRM line | `cascading`, 1,059 behind. Its #121 stays for a person. |
| MC `cascade_events` | Nothing live. The newest event, 40ad41df (prime@`638f2918`), finished `partial` at 19:38:00 UTC (§5). |

## 2. What landed between the eighth update and this one

**Mission Control** (all five are live: #354's rule was live by 08:40 UTC,
when CD's cascade #383 held a spec on a protected workflow, which only that
rule does, and a publish carries everything merged before it):

- #351 (F29) 20 Oct 17:58, #345 (forwarded Airtable settings) 19:06,
  #352 (F30) 20:16, #353 (F31) 21 Oct 04:29, #354 (spec channel) 08:32.

**Prime** (`npc-property-dashbord`): #3346 (production credentials only in the
`supabase-production` environment; function deploys only from `main`),
#3344, #3345 (`version.json`), #3348, #3349, #3350, #3351, #3352 (object-index
spec gated on the tree), #3347 (reporting engine audit), #3353 (closure
report), #3354 (the three Fly workflows install `flyctl` from Fly's release),
#3356 (the two Cloud Run deploy workflows removed, §3), and #3358 (another
session's record of Victoria's first transport load).

**The render container is on Fly.io.** `deploy-render-fly.yml` ran on
`0634333e` as runs 39634860422 (16:26 UTC) and 39641193177 (17:09 UTC), both
green: https://aurixa-weasyprint-service.fly.dev, with production
(`dduzbchuswwbefdunfct`) repointed. The second run repeated the first: each run
mints a new token, so it opened a window of about 90 s in which the edge
functions held the old token. Read a workflow's run history before
dispatching it.

**CD**: #382 and #384 (its protected workflows reconciled with prime's, and
`productionCredentialScope.spec.ts` carried by hand), #387 and #388
(`backendIsolation.spec.ts`: its recognisers fixed, and moved to
`src/lib/deploy/__tests__/` so CI runs it), #390 (the tree-gated object-index
spec, ahead of the cascade), #380 (`version.json`), and cascades through #393,
then #394 (§3).

**NPC Test and Preflight**: #229 and #228 (`version.json`) merged 20 Oct
17:44. On 21 Oct, cascade #234 and reconcile #235 merged on each (§4).

## 3. Why #3356, and what CD's cascade did with it

`deploy-weasyprint-service.yml` and `deploy-pdf-parse-service.yml` named
`google-github-actions`, so every merge touching their paths left a
`startup_failure` on `main` (most recently run 39622463033). Neither ever sent
traffic to a revision. The owner chose to remove them entirely. The render
container deploys by `deploy-render-fly.yml`; the PDF sidecar stays on Cloud
Run and ships by hand (`pdf-parse-service/DEPLOY.md` §8).

Measured before marking it ready, so the hour of full gate was not spent on a
foreseeable failure:

- All 21 runnable specs that read `.github/workflows` passed on the head (565
  tests). The two that read only their own AML workflows need `xlsx` (§7).
- `maps-credential-remediation.yml`, which #3356 edits and which still names
  `google-github-actions`, runs on `push` only for a feature branch, so the
  merge started no new `startup_failure`. None has appeared since.
- CD held prime's exact pre-#3356 copy of all 16 files #3356 touches. Applied
  to CD's `main`, the 21 specs passed (562 tests). Nothing held the spec
  updates back: CD's protected workflows matched prime's, and its own
  `vcr-prune.yml` is not under an exclusion, which is what #354's hold
  requires (`heldByExclusion`).

**What the cascade did.** MC opened CD #394 at 18:59 UTC with #3356's 16 files
and updated it in place to 17 when #3358 merged (head `64617ea9`). Full CI 1349
was green: security, render-container and the three verify shards. The bot
merged it at 19:41:48 UTC. It:

- deleted both deploy workflows, because CD's copies were byte-identical to a
  version prime itself held;
- delivered `productionCredentialScope.spec.ts` and
  `workflowActionPolicy.spec.ts` beside the workflows they read;
- recomputed CD's security baselines to its own 402 functions rather than
  copying prime's;
- held ten files for a person. One is `src/lib/__tests__/clientFacing.test.ts`,
  which asserts CD's own hiding decisions. The other nine are seed migrations
  v20–v28, 40.2–41.4 MB each, over the 40 MB GitHub accepts as one blob; the
  pull request says the migration sync chunks them, so CD's database still
  receives them;
- withheld 55 paths CD owns, and left alone 157 that exist only in CD.

The platform shard's agent unit tests took 11 min 24 s of that run, against
about 6.5 min on CI 1343. That is most of a cascade's 25-minute full gate.

## 4. The children's reconcile (NPC Test #235, Preflight #235)

Both children protect the same five workflows as CD
(`clone_sync_exclusions`). Two differed from prime and the two Builder Stock
workflows were still present. While they differ, #354's rule holds every spec
that lists `.github/workflows` (`productionCredentialScope`, `networkGuard`
and `workflowActionPolicy`), so neither child had any of the three.

Each pull request did what no cascade can, and nothing more:
`apply-migration.yml` and `rotate-internal-edge-secret.yml` took prime's bytes
(`3acce0bc`, `1386cdd3`, which CD carries), and the two Builder Stock
workflows were deleted. Both workflows are `workflow_dispatch` only, so the
merge ran nothing; on a clone an unset `SUPABASE_PROJECT_REF` still fails
closed. Every script they call is byte-identical across all four
repositories. After the merge, each child's `.github/workflows` listing
matched CD's before #394: 33 files, the same blobs.

The held specs were **not** copied in by hand, unlike CD's #384. A hand copy
would have been the pre-#3356 version, which goes red the moment #3356's
cascade deletes the two workflows. The cascade delivers each spec beside the
workflows it reads.

| Child | #234 (MC cascade from CD@`398235c`) | #235 (reconcile) | `main` CI |
|---|---|---|---|
| NPC Test | 457 files, merged 18:24 UTC | merged 19:06:30 UTC (`a14bf5d2`) | CI 584 (39658714278) green |
| Preflight | 10 files, merged 18:21 UTC | merged 19:06:40 UTC (`fc9ba5c2`) | CI 573 (39658738125) green |

Both reconciles merged on a green full gate, each as a merge commit. Before
that, the end state was measured on each child: #234, the reconcile, and
#3356's files as CD passes them on, with the three specs at their post-#3356
versions. It passed 601 tests in 24 files on each child. Fixed:
`edgeSecretWorkflowOwnership`'s two "stay deleted" tests and
`backendIsolation`'s "fail closed on an unset ref". Still failing, on `main`
and everywhere after: the children's own `backendIsolation` test "no source
file names the prime", which CI does not run (§6).

## 5. What came next: the children's delivery of #3356 (done, §0)

Neither child has #3356 yet. Both prime events held the children (and the CRM)
behind CD while #394 gated, as the lineage rule requires. Each event then
retired them after three attempts, and finished `partial`:

| Event | Prime commit | Retired the children at | CD #394 merged |
|---|---|---|---|
| 81ba72b1 | `f5a2d5bc` (#3356) | 19:21:20 UTC | 19:41:48 UTC |
| 40ad41df | `638f2918` (#3358) | 19:38:00 UTC | 19:41:48 UTC |

**Expected, not yet observed:** the head-redelivery rule
(`headRedelivery.pure.ts`) mints a `scheduled` redelivery of a `partial` head
event on the first idle tick after a 60-minute cooldown. For 40ad41df the
cooldown ends at 20:38:00 UTC. The redelivery reads prime's head when it runs.
CD already carries `638f2918`, so nothing holds the children.

The same shape happened today: 7f2cf756 (prime@`0634333e`) finished at
16:44:01 UTC; its redelivery bdea9cf9 was created at 17:44:02 UTC and opened
both children's #234.

Expect each child to receive:

- the deletion of the two Cloud Run deploy workflows, which ends their
  `startup_failure`s. The last were 39632464754 on Preflight and 39652467325 on
  NPC Test;
- `maps-credential-remediation.yml` at prime's bytes;
- the CLAUDE.md and document updates;
- the three specs held until the reconcile: `networkGuard`,
  `productionCredentialScope` and `workflowActionPolicy`.

That end state was measured at 601 tests in 24 files per child (§4). If the
pull requests open around 20:40 UTC, a 25-minute full gate puts the merges
around 21:05–21:10 UTC. Do not press "Cascade now" or mint an event by hand:
the redelivery does this, and a hand-made event runs beside it.

## 6. Open, and the owner's to decide

1. **Cloud Run, after #3356 and #3359.** Nothing in this repository or any
   clone's still deploys to it or calls it: `redeploy.sh` is gone from Prime
   (#3359), CD (#395) and both children (#238), Prime's edge functions have
   rendered on Fly since 17:11 UTC on 21 Oct, and MC never sent any clone a
   render URL or token. What is left is in Google Cloud, and no session here
   holds a Google login, so it is the owner's:
   1. Confirm the service has served nothing since the switch:
      ```
      gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="weasyprint-service" AND logName="projects/npc-property-dashboard/logs/run.googleapis.com%2Frequests" AND timestamp>="2026-10-21T17:11:00Z"' --project npc-property-dashboard --limit=20 --format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'
      ```
   2. If it has served nothing, delete it:
      ```
      gcloud run services delete weasyprint-service --region australia-southeast1 --project npc-property-dashboard
      ```
   3. **Hold** the role removals on
      `weasyprint-deployer@npc-property-dashboard.iam.gserviceaccount.com`
      (`cloudbuild.builds.editor`, `storage.admin`, `run.admin`,
      `iam.serviceAccountUser`) until it is known which account
      `GCP_DEPLOY_SERVICE_ACCOUNT` names: the Maps credential remediation signs
      in as that one, and it may be this account.
   4. Delete the `GCP_SA_KEY` repository secret if it exists.
   5. Leave `pdf-parse-service` alone: the PDF sidecar stays on Cloud Run.

   Two things recorded for whoever touches the Fly side next: the render
   service is stated as $10–15 a month and costs about $31, and the Fly deploy
   workflow prints "repointed: yes" even after a failure. The Cloud Run strings
   still in shared edge code were left on purpose: editing `_shared/`
   redeploys about 429 functions.
2. **Done.** The children's `backendIsolation.spec.ts` moved to
   `src/lib/deploy/__tests__/` in NPC Test #236 and Preflight #236, the port
   of CD #387 and #388 (§0).
3. **CD's two exclusion rows for the deleted Builder Stock workflows**
   (`af696884-bd8a-4404-b868-6700096783fb`,
   `0f924553-422b-4cc1-bde5-50a42a3bbff0`): they guard paths that no longer
   exist. The previous session recommended keeping them; unanswered.
4. **The CRM line's #121** stays for a person: no session lands it.
5. **Not new, recorded for completeness:** prime's seed migrations v20–v28
   are over GitHub's 40 MB blob limit, so no clone's repository receives
   them (§3). They stay held until they are smaller, or until a person pushes
   them from a local clone.

## 7. Notes for the next session

- **The proxy denies `cdn.sheetjs.com`**, where Prime's `xlsx` comes from, so
  `npm ci` fails. Install without it:
  1. drop `xlsx` from `package.json`, and from the lockfile's `packages[""]`
     and `packages["node_modules/xlsx"]`;
  2. run `npm ci --ignore-scripts`;
  3. run `git checkout -- package.json package-lock.json`.

  Only specs that import a spreadsheet parser need it. The four repositories
  share `package.json` and the lockfile, so one install can be linked into
  each clone's tree.
- **CI runs named spec paths.** A spec under `src/lib/__tests__/` runs only if
  a step names it, so a red local run there may be red nowhere in CI.
- **Measure a cascade before it happens.** Laying the delivery onto the
  clone's tree in a scratch worktree (`git worktree add --detach`) and running
  the specs that read it answers in minutes what a cascade pull request answers
  in an hour of full gate.
- **A child behind a gating parent waits for the redelivery.** An event's
  three attempts span about 25 minutes, the same as the parent's full gate.
  Today, all three events retired their held children 1–20 minutes before
  CD's cascade merged. So the children receive each prime change about an
  hour later, from the head redelivery, not from the original event. The
  design covers it; it is not a fault. Changing it is an engine decision.
- **`merged` reads false for a merged cascade** in the GitHub tool's
  pull-request listing. Read `merged_at` and the merge commit instead.
- **A cascade's full gate takes about 25 minutes,** most of it in the platform
  shard's agent unit tests (§3).
