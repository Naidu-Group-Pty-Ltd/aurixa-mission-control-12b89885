# Handoff — Prime's CI head, the Cloud Run removal and the children's workflow reconciles

**Written 21 Oct 2026, from 18:30 UTC, by the session that took over when the
previous one stopped.** That session (branch `ccr-1c6390f6-4pds8i` in MC) ran
out of context at 17:47 UTC and left no record of its last day. This document
is that record and the state at hand-over. It is deliberately short: read it
first, and go to
[`HANDOFF_2026-10-19_CONTINUED.md`](./HANDOFF_2026-10-19_CONTINUED.md) only for
the cascade engine's findings F15–F31.

The owner's task, as given to the previous session: *focus completely on the
cascade worktree and the state of the Prime repo, and start by cleaning it so
that its CI head is clean and green, so that the cascade engine does not carry
forward faulty or broken code.*

---

## 1. State at hand-over

| Piece | State |
|---|---|
| Prime `main` | `0634333e` (#3354). CI 9151 green. The only red runs on `main` are `startup_failure`s from the two Cloud Run deploy workflows, which the organisation's Actions policy refuses (it admits `actions/*` only, pinned by commit). |
| Prime #3356 — remove the two Cloud Run deploy workflows | Head `69f5e6ed`. Fast lane green; marked ready at 17:59 UTC, full gate run 39648737508. Merge with a merge commit once the full gate is green. |
| npc-client-dashboard (CD) | `in_sync` at prime@`0634333`. Its protected workflows already match prime's (#382, #384). |
| npc-test-76b3b3 #235 — reconcile | Head `12f409fb`. Fast lane green; marked ready 18:16 UTC. |
| preflight-property-group #235 — reconcile | Head `ebc69380`. Fast lane green; marked ready 18:18 UTC. |
| npc-test-76b3b3 #234, preflight-property-group #234 | MC's cascades from CD@`398235c` (457 and 10 files), opened 17:57–17:58 UTC. They carry #3354's three Fly workflows. Running their checks. |
| MC `clones` | CD `in_sync`, 0 behind. NPC Test and Preflight `cascading`, 84 behind (prime@`d3709be`). The CRM line `cascading`, 1,055 behind. |

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
report), #3354 (the three Fly workflows install `flyctl` from Fly's release).

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
spec, ahead of the cascade), #380 (`version.json`), and cascades through #393.

**NPC Test #229 and Preflight #228** (`version.json`) merged 20 Oct 17:44.

## 3. Why #3356, and what the cascade does with it

`deploy-weasyprint-service.yml` and `deploy-pdf-parse-service.yml` named
`google-github-actions`, so every merge touching their paths left a
`startup_failure` on `main` (most recently run 39622463033). Neither ever sent
traffic to a revision. The owner chose to remove them entirely. The render
container deploys by `deploy-render-fly.yml`; the PDF sidecar stays on Cloud
Run and ships by hand (`pdf-parse-service/DEPLOY.md` §8).

Measured before marking it ready, so the hour of full gate is not spent on a
foreseeable failure:

- All 21 runnable specs that read `.github/workflows` pass on the head (565
  tests). The two that read only their own AML workflows need `xlsx` (§6).
- `maps-credential-remediation.yml`, which #3356 edits and which still names
  `google-github-actions`, runs on `push` only for a feature branch, so the
  merge starts no new `startup_failure`.
- **CD's cascade of it should be green.** CD holds prime's exact pre-#3356
  copy of all 16 files #3356 touches. Applied to CD's `main`, the 21 specs pass
  (562 tests). Nothing holds the spec updates back: CD's protected workflows
  match prime's, and its own `vcr-prune.yml` is not under an exclusion, which
  is what #354's hold requires (`heldByExclusion`).

## 4. The children's reconcile (NPC Test #235, Preflight #235)

Both children protect the same five workflows as CD
(`clone_sync_exclusions`). Two differed from prime and the two Builder Stock
workflows were still present. While they differ, #354's rule holds every spec
that lists `.github/workflows` — `productionCredentialScope`, `networkGuard`
and `workflowActionPolicy` — so neither child had any of the three.

Each pull request does what no cascade can, and nothing more:
`apply-migration.yml` and `rotate-internal-edge-secret.yml` take prime's bytes
(`3acce0bc`, `1386cdd3`, which CD carries), and the two Builder Stock
workflows are deleted. Both workflows are `workflow_dispatch` only, so merging
runs nothing; on a clone an unset `SUPABASE_PROJECT_REF` still fails closed.
Every script they call is byte-identical across all four repositories.

The held specs are **not** copied in by hand, unlike CD's #384. A hand copy
would be the pre-#3356 version, which goes red the moment #3356's cascade
deletes the two workflows, if that cascade reaches a child before or beside
the reconcile. Once the protected files match, the cascade delivers each spec
beside the workflows it reads.

Measured on each child, on `main`, on the branch, on the branch laid over open
cascade #234, and at the end of the chain (#234, the reconcile, and #3356's 16
files as CD will pass them on, with the three specs at their post-#3356
versions): the end state passes 601 tests in 24 files on each child. Fixed:
`edgeSecretWorkflowOwnership`'s two "stay deleted" tests and
`backendIsolation`'s "fail closed on an unset ref". Still failing, on `main`
and everywhere after: the children's own `backendIsolation` test "no source
file names the prime", which CI does not run (§5).

## 5. Open, and the owner's to decide

1. **Cloud Run, after #3356:** delete the unused `weasyprint-service`
   service; the deploy service account still holds the four roles the removed
   deploys were granted (`DEPLOYMENT_PROTECTION.md`, "Known, not changed
   here"); delete `GCP_SA_KEY` if it exists rather than move it into the
   environment. `scripts/render-service/redeploy.sh` still targets Cloud Run
   and was left in place.
2. **The children's `backendIsolation.spec.ts`** is their own file (prime has
   none), sits where no CI step looks, and fails "no source file names the
   prime" on both. CD had the same and fixed it in #387 and #388; the same two
   changes would be one pull request per child.
3. **CD's two exclusion rows for the deleted Builder Stock workflows**
   (`af696884-bd8a-4404-b868-6700096783fb`,
   `0f924553-422b-4cc1-bde5-50a42a3bbff0`): they guard paths that no longer
   exist. The previous session recommended keeping them; unanswered.
4. **The CRM line's #121** stays for a person: no session lands it.

## 6. Notes for the next session

- **The proxy denies `cdn.sheetjs.com`**, where Prime's `xlsx` comes from, so
  `npm ci` fails. Install without it: drop `xlsx` from `package.json` and from
  the lockfile's `packages[""]` and `packages["node_modules/xlsx"]`, run
  `npm ci --ignore-scripts`, then `git checkout -- package.json
  package-lock.json`. Only specs that import a spreadsheet parser need it. The
  four repositories share `package.json` and the lockfile, so one install can
  be linked into each clone's tree.
- **CI runs named spec paths.** A spec under `src/lib/__tests__/` runs only if
  a step names it, so a red local run there may be red nowhere in CI.
- **Measure a cascade before it happens.** Laying the delivery onto the
  clone's tree in a scratch worktree (`git worktree add --detach`) and running
  the specs that read it answers in minutes what a cascade pull request answers
  in an hour of full gate.
