# Finishing the delivery system

27 October 2026. This is the plan to finish how a change in the prime reaches
every clone: the module library, the cascade engine, migrations, function
deploys, secrets and provisioning. The aim is that shipping a feature, a fix or
a migration from the prime no longer needs a change in Mission Control.

Everything below was measured on 27 Oct 2026 against Mission Control's live
database and this repository at `7dcd33a`. The prime was read at `1e18e4b`,
which is the commit every clone's `last_synced_sha` names. Seven read-only
investigations fed it: the cascade engine, migrations, function deploys and
secrets, provisioning, the module library, the prime's contract with Mission
Control, and the operator's view. Figures cover the last 30 days unless a line
says otherwise.

## Where it stands

Every P0 item has shipped, in the release order §11 asks for, and so have L8
and L11 from P1. The sections below are the plan as written; this table says
what became of it.

| Item                                        | Shipped in                                                                       | Read back after publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1, W2                                      | #367                                                                             | See #367.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| W6, W5 (the three notices)                  | #369                                                                             | The four rows stranded under `0a3c9817` since 18 Oct were settled at 10:29 on 27 Oct, the first tick under W6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| W3, W4, W5 (auditor, custodian, holes), L11 | #370                                                                             | At the 11:22 audit tick on 27 Oct the three mirrors read `converged` with nothing owed (`falling_behind` with 4 owed since 8 Oct), with both SHAs recorded, and the custodian wrote no row on a quiet tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| W7                                          | #371                                                                             | NPC Test's `chunk_cursor` read null at 12:28 on 27 Oct (`20270130090000` at 12:10). The drain stopped claiming it after 12:20; its next heartbeat was the 12:30 fleet sync, which visits every clone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| W8, and W7's prime half                     | prime #3392                                                                      | `edge-function-bundles` is in the prime's register, rule 119 is in its rules, and the apply preflight refuses both rollback scripts, `reapply` included (read at `d72032e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L8                                          | prime #3393                                                                      | The delivery summary is on every prime pull request's `security` job page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D4 (the owner's decision)                   | #372                                                                             | The sweep deleted 85 functions between 13:28 and 14:21 on 27 Oct, ten per clone per pass: 28 from each dependent clone and `street-view` from the CRM, none failed and none kept. Re-listed at 14:25, each dependent clone holds exactly its 402, no clone lists a retired name, and `builder-stock-marketplace` and `builder-network-inbound`, which the prime keeps, are still deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The second audit (§13)                      | #374, #376                                                                       | Published at 17:59 and 18:37 on 27 Oct and read back the same evening (§13). C4 waits on the next lineage cascade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C7 (the owner's answer)                     | #378                                                                             | Both copies of `backendIsolation.spec.ts` stay, and the lateral lane treats each as its own deployment's file (`isLineOwnPath`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D13                                         | prime #3397; dashboard #435, CRM #141, Preflight #269, NPC Test #267; #379, #383 | The CRM's next dispatch was refused at the guard (run 40589507167), and the half-hourly sweep records who wrote each ledger row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D16                                         | #385                                                                             | No clone has been provisioned since. NPC Test, Preflight and the CRM stay on `free` until launch (the owner, 28 Oct).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D17                                         | prime #3408, #3417, #386                                                         | The prime's functions deployed 12:36–12:48 on 28 Oct and the clones' 12:50–13:26, all 18 byte-identical to the prime's. No clone has portal traffic, so a clone's refusal has not been observed. The four follow-ups were answered on 29 Oct and shipped in prime #3417 (§10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D18                                         | prime #3398, #3409; #381                                                         | Each deployment recorded the stated list on its next balance call on 28 Oct: the prime `[]` at 15:08:55, the dashboard at 16:02:08, the CRM at 16:03:26, and Preflight at 17:45:26, its first row. On NPC Test an exclusion set in Mission Control at 15:42:59 was recorded at 16:11:29, and after it was cleared at 16:19:49 NPC Test recorded `[]` at 17:43:11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D9 (the owed list)                          | prime #3401–#3405; #393, #394                                                    | Every owed file applied on the prime and all four clones with its `@effect` probe true; the 12:01 fleet sweep lists all 12 withdrawn files; the chart catalogue's 13 rows reached every clone with the prime's fingerprint by 14:58.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D20                                         | #387                                                                             | Report-only. The 14:37 pass on 28 Oct: 991 surplus privileges on 65 relations on the dashboard, NPC Test and Preflight each, and 1,198 on 78 on the CRM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D19                                         | #388, #405, #414                                                                 | An entry is approved only at a commit (a CHECK), and `(slug, version)` is unique. Before anyone pressed the reset that detects the catalogue again, its detection was replayed against prime@122b761 on 28 Oct. Pressed then, it would have read the 25 template seeds (37 to 43 MB) whole inside the 128 MB isolate after its wipe, made 7,199 GitHub calls and swallowed any that failed, and held the fleet's 328 installs only in memory. #405 reads by batch (95 queries and 7 blob reads for the same 143 modules), never asks for a file over 8 MB, writes no module when a file could not be read, records the snapshot before the wipe, restores what any earlier reset still owes, and runs alone. On 29 Oct the owner chose that the library follow the prime by itself instead (#414, §16): nobody presses the reset, and the first follow approves the catalogue at the prime's head. |
| D15 (the owner's step 0), and its guards    | #399, #401, #404; prime #3416                                                    | The switch applied at 21:32:00 on 28 Oct: the CRM reads `mirror` with 31 exclusions, its three new notes are the default policy's, and no other clone changed. Its first mirror cascade, CRM #158 at prime `122b761`, carried 259 files (231 added, 28 changed, none deleted) and merged on green at 22:00 (`b57d4d1`). That is the 20:41 replay's 245, 243 of them blob for blob and two at the newer copies of prime #3415, which merged at 21:17 between the replay and the switch, and 14 of #3415's files. None of `.claude/**`, the agent specs or `clientImportRecords.spec.ts` travelled, the security baselines were recomputed for the CRM (388 functions), and 9 files wait for a person, `parityRegister.ts` among them. It also carried the streaming half of prime #3413 (`streamSecureFunction.ts`) to the CRM.                                                                     |
| Outside the plan (§15)                      | #395, #397; prime #3411, #3413, #3414                                            | NPC Test's lock screen showed $999 and its button opened Stripe (`checkout_started`, plan `launch`, 17:42:10 on 28 Oct). Preflight's password recovery sent from its own domain at 17:43:51. After the 20:00 email audit both Resend rows read `set` on all four clones, from their projects' secret names. Prime #3413's refusal rule was in all four clones' live bundles by 21:04, and prime #3414's `authenticated-data` is byte-identical on the prime and the four clones (deployed 20:17–20:30), with the comments rule.                                                                                                                                                                                                                                                                                                                                                                    |

Still open: the rest of P1 (L1–L7, L9, L10), P2, and the owner's decisions in
§10. Of the owner's 27 Oct answers, D13, C7, D16, D17 and D18 have shipped and
been read back, D9's owed list is delivered, and D20 reports. D14 is parked by
the owner (28 Oct). D15 shipped on 28 Oct, the engine first and the switch
once it was live, and its guards with it (Where it stands). D19 no longer waits on the
reset: from 29 Oct the library follows the prime by itself (§16).
D3 and D8 are the ones that stand between this
fleet and a launch, and D3 is smaller than §4.2 read (§15). §14 records the
clones' open tables, found and closed on 28 Oct, and §15 what else 28 Oct
found.

---

## 1. The verdict

The machinery mostly works. Changes reach the three mirrors in about half an
hour, a changed function goes live in minutes when a run is open, and every
clone is currently on the prime's newest migration. What is missing is the
part that makes the machinery trustworthy without a person watching it. Six
problems stand behind almost every incident and hand-carry in the record:

1. **Mission Control works out what the prime ought to state.**
   - Which functions are prime-only, which belong to one CRM line, which
     secrets a function reads, which workflows a clone may run, which files are
     a deployment's identity, which files are generated: each is a list kept by
     hand in Mission Control, or a regex over the prime's source.
   - So every feature that adds one of these needs an edit here, and the lists
     have already drifted from the prime's (§4.6).
2. **Delivery is one event per push, patched five times.**
   - A creation fold, a claim fold, a carrier refresh, head redelivery and the
     drift beacon each patch the one-event-per-push model.
   - A pass that does not fit one tick is cut, retried and retired.
   - A clone whose pass never fits can be starved for days: the CRM's longest
     gap between merges was 269 h.
3. **"Done" is asserted by configuration, not by effect.**
   - A function counts as deployed because the deploy call returned 2xx, and
     the ledger that proves it currently proves nothing.
   - A migration counts as applied because the request returned 2xx.
   - A backend counts as `ready` whatever its parity check said.
   - Two migration appliers run with no shared lock.
4. **Signals that never settle.**
   - 6,028 notices sit unread under "Needs attention", and 77% of them are one
     language model rewording a number Mission Control already measures.
   - The custodian writes about 5,500 refusal rows a day and has acted once,
     on 19 Sep.
   - The convergence auditor has reported every mirror as falling behind since
     8 Oct, because of four files the engine itself rewrites.
   - The operator is told to trust the wrong reading (§4.5).
5. **One clone, two scopes.**
   - A module-scoped clone's repository is scoped by globs. Its backend is
     scoped to the whole prime.
   - The CRM is missing 495 prime files and holds 32 stale ones while reading
     `in_sync`.
   - Every clone a signed agreement provisions is created module-scoped, so it
     would never receive about 3,600 app files or 285 functions. **This is the
     one problem that would hurt a paying customer on day one.**
6. **Steps that exist only in people's memory.**
   - Dispatching each migration on the prime: one waited 16 days.
   - Giving Mission Control a value for each new vendor secret: 16 have none.
   - Deleting retired functions from clones: 28 are still live, 19 of them
     unauthenticated.
   - Carrying `App.tsx` routes by hand: the CRM's history shows six such
     reconciles.

The plan fixes these in three phases:

- **P0, before launch.** Correctness and honesty on the paths launch uses: no
  new clone is mis-scoped, no shared-code merge sets off a ten-hour redeploy,
  no control does something other than what it says, and no signal lies.
- **P1, launch week.** One place that answers "is this clone current with the
  prime, stage by stage, and who has to act".
- **P2, the following weeks.** The prime declares what Mission Control now
  infers, each clone converges on a target instead of a queue of pushes, and
  every stage is proven by effect. That phase is what removes the per-feature
  Mission Control edit for good.

---

## 2. How a change travels today

| What the prime changes | Lane in Mission Control                                                 | Cadence                                                        | Proof of delivery today                                                            |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Any file               | `cascade_events` → `/hooks/cascade-drain` → a PR per clone → auto-merge | webhook, then every minute; merge drain every 5 min            | The clone's pointer moves when its PR merges; the auditor diffs trees every 15 min |
| A migration            | the person dispatches the prime's apply → `/hooks/fleet-migration-sync` | sweep every 30 min, drain every 5 min                          | HTTP 2xx, then a separate ledger write                                             |
| An edge function       | `edge_function_deploy` runs → `/hooks/support-remediation-drain`        | planned on merge and by catch-up at :20/:50; drain every 2 min | Deploy call 2xx; ledger digest plus function version                               |
| A secret name          | regex over `Deno.env.get("X")` at provisioning; forwards by hand        | reconcilers every 5–30 min                                     | none per function                                                                  |
| A workflow             | cascades as a file; credentials by the deployer-declaration pass        | every 30 min                                                   | the CI watch (shipped 26 Oct)                                                      |
| A new clone            | `provisionCloneCore` → `clone_backends` → `clone_deployments`           | queues every minute                                            | per-stage counts; `ready` regardless of parity                                     |

Lineage: NPC Test and Preflight read NPC Client Dashboard's branch, not the
prime's. They wait until the dashboard's pointer equals the prime's head.

---

## 3. The measured baseline, and where it has to be

| Measure                                            | 27 Oct 2026                                                   | After P0                            | After P2                          |
| -------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| Push → merged on Client Dashboard (p50)            | 29 min (clone CI is most of it)                               | unchanged                           | ≤ 25 min                          |
| Push → merged on its children (p50)                | 43–47 min                                                     | ≤ parent + 2 min wake               | parent + one CI run               |
| CRM gap between merges, p90 / max                  | 38 h / 269 h                                                  | no retirement caused by a cut       | ≤ 2 h at rest                     |
| Passes cut by the platform (traced CRM passes)     | 48 of 67; `event_stuck_running` seen 222 times                | 0 for a week                        | 0                                 |
| Cascade-drain GitHub calls                         | 410,000; idle floor 2,400–2,700 a day; bad days 50,000–87,000 | bad days impossible (no cut loops)  | idle floor ≤ 500 a day (ETag)     |
| Edge bundles the ledger proves current             | **0 of ~400 per clone**                                       | ≥ 99%                               | ≥ 99%                             |
| Cost of the next shared-code merge                 | ≈1,580 redeploys, ≈10 h fleet-wide                            | only the bundles that changed       | same                              |
| Hot fix to a function, merge → live on every clone | 1–7 min with an open run; behind a refill, hours              | ≤ 10 min, changed bundles first     | ≤ 10 min, verified after deploy   |
| Migration merged → dispatched on the prime         | < 1 min to 2 h 11 min; one waited 16 days                     | unchanged                           | applied on merge, behind approval |
| Unread "Needs attention" notices                   | 6,028                                                         | ≈ 460, all real                     | each finding once                 |
| Custodian rows a day / acts ever                   | ≈5,500 / 1                                                    | < 20                                | < 20                              |
| Mirrors the auditor reads as converged             | 0 since 8 Oct                                                 | 3 of 3                              | every clone, the CRM included     |
| A new agreement clone's scope                      | **modules** (misses ≈3,600 app files and 285 functions)       | **mirror**                          | mirror of its line                |
| Last clone provisioned fresh                       | 19 Sep (the current path has never run in production)         | one rehearsal before launch (owner) | acceptance-checked every time     |

---

## 4. What the investigations found

Each finding cites the file and line it was read at, or the query it was
measured with.

### 4.1 Cascade engine

- **The webhook's inline run never wins.**
  - The webhook starts `executeCascade` without awaiting it
    (`hooks.github.tsx:234, :517`).
  - In none of 249 carried events did a pass start within 60 s.
  - Every first pass comes from the drain after `CREATION_ARM_GRACE_MS` = 90 s
    (`armGrace.pure.ts:27`).
- **Budget checks that are not honest.**
  - The first clone of every pass always runs.
  - Every later clone reserves only the slowest clone so far, not its own last
    pass (`cascade-engine.server.ts:947`).
  - The import closure is never cut short (`:2627`).
  - Everything from `deliver` to `references` is unchecked.
  - The prepare loop reserves one file's time (`:3244`).
  - The drain re-claims, in the same tick, an event that has just paused,
    because it excludes only failures (`hooks.cascade-drain.tsx:1124-1130`).
  - A claim can start at second 44 of a 45-second budget.
- **The fold ignores the arm grace the claim enforces.**
  - `eventFold.pure.ts` folds an event whose rows have not arrived yet.
  - Event `0a3c9817` was folded 0.29 s after it was created. Its four rows have
    sat `queued` under a completed event since 18 Oct.
- **Lineage starves the children.**
  - A child is released only when the parent's pointer equals the prime's head
    exactly (`cloneCascadeSource.pure.ts:135-140`).
  - The gap between prime pushes is 25.7 min at the median, and the parent
    needs 26–30 min to merge.
  - A red parent PR freezes both children: 15 red dashboard PRs, notices open
    26 h on average.
- **Three writers retire events, and each tells a different story.**
  - Retirement marks every unreached row `skipped`: 318 rows, clustered on
    11–12 and 20–23 Oct.
- **State kept as prose and parsed back.**
  - `Failed against prime@`, `retry n of m`, `Already proposed — PR #` (a LIKE
    filter on the merge drain's work list), and `isInvocationCut` substrings.

### 4.2 Edge functions and secrets

- **The deploy ledger proves nothing today.**
  - A bundle counts as current when the ledger's digest matches and the clone
    still lists the same function id at the same `version`
    (`edgeBundleLedger.pure.ts:61-66`).
  - Any project-wide secret write bumps every function's `version` without
    rebuilding it. Mission Control already documents this in
    `secretWriteDiff.pure.ts:6-27`.
  - On every clone, the build number in each function's `entrypoint_path`
    (`file:///tmp/user_fn_<ref>_<id>_<N>/source/…`) still equals the ledger's
    version: 400 of 402 bundles on Client Dashboard, Preflight and NPC Test,
    and 372 of 373 on the CRM. The listed `version` is one or two higher.
  - The cause was the database-password reconcile at 19:30 on 26 Oct, and on
    NPC Test also `ALLOWED_ORIGINS` at 22:05.
  - The next shared-code merge will therefore redeploy every bundle on every
    clone: about 1,580 deploys, roughly ten hours.
  - A hot fix waits its turn in stalest-first order. On 26 Oct,
    `manage-agency-agreements` reached NPC Test 402nd of 402, at 18:42.
- **Deletion never travels** (`cascadeBackendWork.pure.ts:39-42`).
  - 27 retired `builder-*` functions are live on the three dependent clones.
    19 run with `verify_jwt=false`, including `builder-portal-login` and
    `builder-portal-reset-password`.
  - `street-view` is live on all four clones.
- **Held functions are invisible to Mission Control.**
  - It never reads `held-functions.txt`.
  - All four clones run a build of `aml-reliance` that the prime itself has not
    released (prime last deployed 10 Oct; source changed 19 Oct; clones
    deployed 20–26 Oct).
- **Secrets have no single owner.**
  - About ten reconcilers write the same projects at different cadences.
    `MISSION_CONTROL_URL` alone has two writers in one hook.
  - Every extra write is another version bump.
  - 16 authorised vendor forwards have no value in Mission Control, so no clone
    ever receives them. They include `GOOGLE_MAPS_API_KEY`, the WeasyPrint and
    PDF-parse services, `AML_VERIFICATION_SERVICE_*`, and `RESEND_API_KEY` for
    Client Dashboard and Preflight.
- **No check after a deploy.**
  - There is no re-list, boot or CORS check.
  - `request_timeout`, which the prime declares for 93 functions, is never
    sent.

### 4.3 Migrations

- **Merging a migration on the prime does nothing on its own.**
  - A person must dispatch the prime's `apply-migration.yml`, which is
    `workflow_dispatch` only.
  - Until then the file is a hole on every clone.
  - On the last four merges the wait ran from under a minute to 2 h 11 min;
    `20270103090000` waited 16 days.
- **Apply and record are two requests** (`backend-provisioning.server.ts:3654`
  and `:3656`).
  - A pass killed between them leaves a change applied but unrecorded.
  - That has not happened yet. The window is real.
- **Two appliers with no shared lock.**
  - On 26 Oct the CRM's own `apply-migration.yml` applied five versions
    Mission Control was holding. This section first said both lanes applied
    `20270202090000` eleven minutes apart; they did not. The CRM's run at 21:40
    (40406322028) refused that version as already recorded, because Mission
    Control had recorded it at 21:30:41.
  - Its next run, 21:42:09–21:42:35 (40406460451), applied `20260921060000`,
    `20261221110000`, `20270111110000`, `20270111140000` and `20270122150000`
    through psql, without a single transaction. Those are exactly the versions
    Mission Control was holding behind four holes (`20260725010000`,
    `20260730290000`, `20260817000000`, `20260805140000`), and its four
    blockage rows for them cleared at 22:07 with nothing to say why.
  - No harm came of it, because the holes' objects exist on the CRM. But an
    unclaimed second applier defeats the dependency rule, and the rows it
    writes carry a one-statement body, a slug name and no provenance, so
    Mission Control keeps no record that it ran (D13).
  - The per-clone Sync button takes no claim.
- **A stale cursor costs 1,900 GitHub calls a day.**
  - NPC Test's `chunk_cursor` still names a seed its ledger recorded on 22 Oct.
  - In 24 h, 237 of 239 drain passes found the clone already current.
- **Legacy holes and rollback scripts.**
  - The CRM's 50 open `prime_ledger_hole` rows (185 holes in all) never clear.
    Nothing is held behind them.
  - Two of them are rollback scripts (`*_rollback_*_rls_policies`), and their
    blockage text tells the operator to dispatch them.
  - The prime's preflight would let them run.
- **Verification is a 2xx.**
  - `@effect` is never read; 41 of 1,130 migrations declare one.
  - The prime's own drift report skips every recorded version, which is how
    two migrations stayed absent on all four clones until the 26 Oct
    restatement.

### 4.4 Provisioning

- **The current path has never run in production.**
  - No clone has been provisioned since 19 Sep.
  - Every fix since then has only run as a reconciler over the four clones.
- **New clones default to module scope.**
  - The agreement flow passes no CRM line (`agreement-provisioning.server.ts:315-330`).
  - `provisionCloneCore` then keeps "the prime-sourced, module scope", and the
    column default is `'modules'` (`20260826040000_mirror_cascade_and_exclusions.sql:34`).
  - The repository is created from the prime's whole tree, so what module
    scope removes is every later update outside the installed globs. With the
    launch tier that is about 3,624 app-code files and 285 functions.
- **Problems a clone would hit on day one:**
  - The first production build can run before the environment is synced. NPC
    CRM Independent built at 05:25 and was synced at 07:19. A child of Client
    Dashboard would have pointed at the dashboard's live project in between.
  - `supabase-production` is created with no branch policy
    (`github-secrets.server.ts:214`). The prime restricts it to `main`.
  - The dashboard's own `vcr-prune.yml` arrives in every new child. Nothing
    strips it.
  - The wizard defaults to `us-east-1` (`clones.new.tsx:151`). The agreement
    path and three of the four clones use `ap-southeast-2`.
  - There is no capacity check for email domains on the wizard. Resend refused
    the CRM's domain, and its key arrived seven days later.
- **"Ready" means the pipeline finished, not that the clone works.**
  - Parity is written once and then overwritten by the fleet sync's status
    line.
  - No one place says "ready for a customer".

### 4.5 What the operator sees

- **Five surfaces show the same pointer, and three more are a language model
  restating it.**
  - On a mirror, the header says IN SYNC.
  - The card beneath it says "Falling behind · 4 owed", and adds that the
    repositories are the reading to trust. That reading is the wrong one: the
    four paths are the engine's own per-clone rewrites of
    `SECURITY_REGISTRY.json`, `SECURITY_INVENTORY.json`,
    `mobile/api-surface.json` and `auditRemediation.spec.ts`.
- **Noise, by kind:**
  - `drift_high`: 4,649 unread.
  - `deployment_bundle_identity` "Wrong backend": 917 unread. Every one is
    `carries_both`, which the module itself calls ambiguous by construction,
    and those notices triggered 240 rebuilds before 20 Oct.
  - `remediation_failed`: 116, about six per clone per day for the same
    standing fault.
- **The inbox's kind filter is a hand list of 22 kinds.**
  - It lacks `cascade_blocked`, `remediation_failed`,
    `deployment_bundle_identity` and `clone_ci_attention`.
  - "Mark all matching" can mark `cascade_blocked` read. The blockage ledger
    treats an unread one as a standing CI refusal.
- **Controls that do something else.**
  - On `/cascades`, "Manual select" has no clone picker and fires at the whole
    fleet. So does "By tag" with no tag chosen (`cascades.tsx:200`).
  - On the clone page, "Cascade now" only navigates to `/cascades`
    (`clones.$cloneId.tsx:329-331`).

### 4.6 The prime's contract

- **Published by the prime and never read by Mission Control:**
  - `held-functions.txt`;
  - `scripts/lib/primeOnlyFeatures.mjs`, of which Mission Control keeps its
    own copy. The two disagree: `edge-function-bundles` is missing on the prime
    side;
  - the `@effect` probes;
  - `MIGRATION_VERSION_COLLISIONS.json`.
- **Inferred by Mission Control:**
  - **Secret names**, by regex. That misses 27 files that read a name held in
    a variable, including the YouTube, Google Ads, TikTok, geocoder and OSRM
    settings.
  - **`verify_jwt`**, overridden by slug pattern.
  - **CRM-line functions**, kept in three hand-written copies.
  - **Identity files**, in `DEFAULT_MIRROR_EXCLUSIONS`.
  - **Workflow credentials**, hard-coded.
  - **Generated files and repository invariants.** The code's own comment says
    this is "not something any program here can compute".
- **Hand-carrying is how this has been closing.**
  - The CRM repository has 133 commits from Claude sessions against 107 from
    Mission Control's bot, and about 56 of them carry, reconcile or restate.

---

## 5. Where it has to end up

The work converges on five properties. Each phase moves toward them, and P2
completes them.

1. **The prime declares; Mission Control reads.**
   - Two files in the prime:
     - a hand-written `supabase/delivery-policy.json`, holding what cannot be
       derived: workflow behaviour on clones and the credentials each needs,
       identity files, the class of every secret, prime-only and line-only
       features, held and retired functions;
     - a generated `supabase/delivery-manifest.json`, holding per-function
       facts: `verify_jwt`, config, secrets read, held, retired. It also holds
       per-migration facts: data-only, `@effect`, withdrawn.
   - The prime's CI regenerates and byte-compares the manifest, and refuses an
     entry left out.
   - Mission Control reads both at the commit it cascades and checks their
     pins. It falls back to today's inference only where a pin does not match.
   - A new feature then reaches every clone with no Mission Control change,
     because the prime's CI will not let it merge undeclared.
2. **Every clone is a mirror of its line, and each converges on a target.**
   - Each clone has a target: the prime's head, or its parent's delivered head.
   - It has one work row with its own attempts and backoff.
   - That replaces the fold, the carrier refresh, head redelivery, the beacon
     and event-level retirement. One clone can no longer retire another's
     delivery.
   - One scope resolver is shared by the engine, the auditor, the lateral lane
     and the deploy lane.
3. **Every stage is proven by effect.**
   - Code, by the tree. Migrations, by the ledger plus `@effect` and the
     objects they create. Functions, by build identity after deploy. Secrets,
     by the names each function reads against the project's own list. CI, by
     its runs. The served build, by its `buildId` against the delivered commit.
   - All of it is read into one Delivery record per clone. The acceptance
     check for a new clone is the same reader, run until it passes.
4. **Every signal is a finding, said once.**
   - Each notice kind is deduplicated by fingerprint, announced once and
     cleared on recovery, the way `clone_ci_attention` already is.
   - Nothing restates a measured number through a language model.
5. **One authority per decision.**
   - One owner per secret, writing in one batch per clone per pass.
   - One applier per clone for migrations, holding the fleet claim.
   - One source each for scope, prime-only and line membership.

---

## 6. P0: before launch

Each item is sized to ship and be verified before launch. Each states the
change, the files, how it is accepted (by effect, not by the code being
merged) and how it is rolled back.

### W1. New clones are mirrors — launch blocker

- **Change.**
  - A clone created with no CRM line is inserted as a prime-sourced mirror
    (`sync_scope: 'mirror'`), the arrangement Client Dashboard runs on.
  - Its exclusion policy is already seeded before any cascade.
  - The module "provision cascade" is skipped for a mirror: the repository was
    just created from the whole tree, so it has nothing to add.
  - A new migration sets the `clones.sync_scope` default to `'mirror'`, so no
    other insert can silently create a module-scoped clone.
  - Which CRM line an agreement clone should join is decision D1. Until it is
    taken, the clone keeps the tree the agreement flow creates today, the
    prime's.
- **Files.** `clone-provisioning.server.ts`, `clone-provisioning.functions.ts`
  (the contract comment), a migration, the regenerated assertions and types,
  and tests.
- **Accepted when.**
  - A unit test shows the agreement input inserted as a mirror.
  - The column default reads `'mirror'` in production.
  - The next agreement clone shows `sync_scope='mirror'` and the 24 seeded
    exclusion rows, and the auditor measures it rather than reporting
    `unknown`.
- **Rollback.** Revert the commit and migrate the default back. No existing
  clone changes scope.

### W2. The deploy ledger proves a copy by its build

- **Change.**
  - Read the build number and function id from each listed function's
    `entrypoint_path`.
  - A copy is proven current when the function id matches and either its
    `version` or its build number equals the version the ledger recorded. A
    secret write moves the first and never the second. Any other deploy moves
    both.
  - Anything unparseable stays owed, so a format change costs a redeploy and
    never a skip.
  - Bundles whose digest differs from the ledger, or that have no ledger row,
    deploy before stalest-first, so a hot fix lands in the first pass.
- **Files.** `projectFunctionCopies.pure.ts`, `edgeBundleLedger.pure.ts`,
  `edgeDeployBatch.pure.ts`, `self-healing.server.ts`, their tests and
  `docs/EDGE_DEPLOY_LEDGER.md`.
- **Accepted when.**
  - On each clone's next catch-up run, `proven` reads ≈ 400 (≈ 372 on the CRM)
    instead of 0, and only changed bundles deploy.
  - The next shared-code merge deploys only the bundles it changed.
- **Rollback.** Revert. The lane falls back to version equality, which is
  today's behaviour.

### W3. A new clone's first day

- **Change.**
  - **(a)** The first production build waits until the environment is synced.
  - **(b)** `supabase-production` is created with a `main`-only deployment
    branch policy, the way the prime's is. The 30-minute credential pass applies
    the same policy to the existing clones.
  - **(c)** `vcr-prune.yml`, the dashboard's own workflow, joins the default
    exclusions so it is never delivered to a child. The retarget commit
    removes it from a repository created from a parent.
  - **(d)** Both the wizard and the backend fallback default to
    `ap-southeast-2`.
- **Files.** `hooks.deployment-drain.tsx` and the hosting provider,
  `github-secrets.server.ts`, `cloneCiCredential.server.ts`,
  `syncExclusions.pure.ts`, `clone-repo-retarget.server.ts`, `clones.new.tsx`,
  `backend-provisioning.server.ts`, and tests.
- **Accepted when.**
  - No build event precedes `deploying` in a rehearsal (D8).
  - A GET on each clone's environment shows the `main` policy.
  - A child created from the dashboard has no `vcr-prune.yml`.
- **Rollback.** Revert. The environment policy is removed by the same pass.

### W4. Controls do what they say

- **Change.**
  - `/cascades`:
    - "Manual select" gets a clone picker, and fires only at the clones picked.
    - "By tag" with no tag chosen cannot fire.
    - The confirmation names how many clones it will reach.
  - The clone page's "Cascade now" re-delivers that clone, through the one-clone
    spawn the cascade detail page already has, moved into a shared helper.
  - The inbox's kind filter is built from `ALL_NOTIFICATION_KINDS`.
  - Bulk "mark read" never marks `cascade_blocked`.
- **Files.** `cascades.tsx`, `cascades.$eventId.tsx`, `clones.$cloneId.tsx`, a
  shared helper, `notifications.tsx`, and tests.
- **Accepted when.**
  - Firing at one picked clone inserts exactly one `cascade_results` row.
  - "Cascade now" creates one event for that clone.
  - The filter lists every kind.
  - Bulk mark leaves `cascade_blocked` unread.
- **Rollback.** Revert. UI only.

### W5. Signals tell the truth

- **Change.**
  - **The auditor** counts the paths the engine rewrites for each clone as
    `reconciled`, not owed, using the constants the engine's own reconcilers
    export. It writes `prime_sha` and `clone_sha`.
  - **The custodian** writes a refusal only when it differs from the newest one
    for that blockage, and `custodianActed` counts only rows it actually wrote.
  - **`prime_ledger_hole`** names what is held behind the hole, or says that
    nothing is, and a clone's notes are its newest 50 holes, so a migration
    merged and not yet dispatched is never hidden behind legacy ones
    (`fleetBlockageRecord.pure.ts`). The two rollback holes read "never to be
    run". This item first raised the row only where something was held. What
    shipped (`3f3fd430`) keeps the rest, because a fresh hole usually holds
    nothing yet and is the one an operator can act on: `20270103090000` waited
    16 days for its dispatch with no row on the CRM.
  - **`remediation_failed`** is not raised again while an unread one stands for
    the same clone, action and error. It links to the clone.
  - **`drift_high` and `drift_medium`** are filed as records, not inbox items.
  - **`carries_both`** reads "unproven", not "wrong backend", and starts no
    rebuild.
- **Files.** `cascade/convergence.pure.ts`, `convergenceAudit.server.ts`,
  `custodian.server.ts`, `hooks.cascade-audit.tsx`,
  `cascade/blockageTaxonomy.pure.ts`, `self-healing.server.ts`,
  `notificationDisposition.ts`, `hosting/deployedBundleIdentity.*`, and tests.
- **Accepted when.**
  - On the next audit tick the three mirrors read converged with nothing owed.
  - The three open `unclassified` rows clear.
  - Custodian rows fall from about 5,500 a day to under 20.
  - No new `drift_high` reaches the inbox.
- **Rollback.** Revert. These are reports only: no part of delivery reads
  `clone_sync_blockages`.

### W6. A pass fits its tick

- **Change.**
  - Before each clone after the first, reserve that clone's own last pass
    time, from its row's `pass_trace`, as well as the slowest clone so far.
  - The drain claims nothing with less than a pass's headroom left, and never
    re-claims an event this tick already ran.
  - The fold leaves an event alone inside its arm grace.
  - Rows still `queued` under a settled event are settled.
- **Files.** `cascade-engine.server.ts` (the clone loop),
  `hooks.cascade-drain.tsx`, `cascade/eventFold.pure.ts`, and tests.
- **Accepted when.**
  - Traced passes with no outcome, `event_stuck_running` and `invocation_cut`
    fall to 0 for a week.
  - The four rows from 18 Oct are settled.
- **Rollback.** Revert. The reservations only ever stop a pass earlier.

### W7. Migration delivery cannot half-apply

- **Change.**
  - The ledger inserts travel in the same request as the migration's body, so
    a migration is applied and recorded together or not at all.
  - A `chunk_cursor` is cleared once the clone's ledger already holds its
    version.
  - The per-clone Sync button takes the fleet claim, so it cannot overlap a
    fleet pass.
  - The fleet lane's cron sweep is told the clone's CRM line.
  - On the prime, the apply preflight refuses rollback files.
- **Files.** `backend-provisioning.server.ts` (apply and record),
  `fleet-migration.server.ts`, `migration-sync.functions.ts`, the prime's
  `scripts/ops/applyPreflight.pure.mjs`, and tests.
- **Accepted when.**
  - A test asserts one request per file.
  - NPC Test's drain stops spending about 1,900 calls a day.
  - Dispatching `20250124120001` on the prime fails preflight.
- **Rollback.** Revert. The two-request form is today's behaviour.

### W8. The prime's half

- **Change.**
  - `edge-function-bundles` is added to the prime's register of prime-only
    features, so the two registers agree.
  - A rule file, `.claude/rules/operations/119-what-a-feature-needs-to-reach-a-clone.md`,
    with `paths:` over functions, migrations, workflows, `config.toml`,
    `App.tsx` and the secret registry. It is the checklist in §8, so a
    developer meets it the moment they touch one of those files.
- **Accepted when.** The prime's register specs pass, and the rule loads when
  one of those paths is read.

---

## 7. P1: launch week

| ID  | Change                                                                                                                                                                                                                                                                                                                                                    | Accepted when                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| L1  | **Delivery panel**: one row per stage (code, needs a person, migrations, functions, secrets, CI, served build), with its state, what it was read from and when, what is owed and who acts. It reads only existing readers, plus the CI watch's audit rows and the auditor's `owed_sample`.                                                                | Each cell matches the SQL for that clone; lint, style audit and build pass; a screenshot.                                      |
| L2  | **Acceptance check**: the same reader, run every 15 minutes on a new clone until it passes and daily after that, with one status pill. It covers repository identity, CI environment and credentials, parity, functions and secrets, cron health, reference data, Vercel and domain, email and Turnstile, key use, ledger drift, and convergence.         | It fails on today's four clones for the known reasons (vendor secrets, stale parity, entitlements). If it passes, it is wrong. |
| L3  | **Function parity sweep and secret coverage**, both read-only: proven versus owed bundles per clone, retired and absent slugs, secret names read against each project's list. A notice fires for anything owed over 60 minutes.                                                                                                                           | One notice per standing gap, cleared on recovery.                                                                              |
| L4  | **Migration dispatch alert**: a merged migration still undispatched after 2 h raises one notice naming it. The audit sample lists the newest withheld names, not the oldest.                                                                                                                                                                              | A test merge raises exactly one notice.                                                                                        |
| L5  | **Module-scoped clones measured**: the auditor uses the engine's scope resolver, moved into one shared function. A module pass reports the differing paths it did not offer.                                                                                                                                                                              | The CRM reads a measured state; a dry run reports 527 (495 missing plus 32 stale).                                             |
| L6  | **CRM to mirror rehearsal** (D7): withhold `.claude/**` for the independent line and add its two missing default rows, then a dry run. The flip happens only if the rehearsal is clean.                                                                                                                                                                   | No `.claude` or GoHighLevel writes; the CRM's CI is green on the rehearsal PR.                                                 |
| L7  | **Quieter remediation and cascades**: no retry of a 413, one notice per cascade, standing manual-reconcile paths shown once per clone, and retired `cascade_failed` notices closed once a later delivery succeeds.                                                                                                                                        | Notice counts per day.                                                                                                         |
| L8  | **Prime report-only delivery summary** in the `security` job. It lists migrations that need the apply step, data-only migrations without `@effect`, new secret names and their class, workflows needing credentials beyond the two Mission Control distributes, `App.tsx` route changes, and edits to the held or prime-only lists. It never fails a run. | Run against `6c508d10e` and `20270202090000`.                                                                                  |
| L9  | **Retired functions cleaned from clone repositories**: remove `street-view`'s `config.toml` and registry declarations, then regenerate the inventory, api surface and ratchet.                                                                                                                                                                            | Each clone's registry and inventory checks pass.                                                                               |
| L10 | **Capacity preflight on the wizard**, the agreement preflight plus email-domain headroom. The backend card is labelled from parity, which keeps its own column.                                                                                                                                                                                           | The wizard refuses a provision Resend would refuse.                                                                            |
| L11 | **Children wake when their parent merges**: `advanceClone` brings forward pending events that hold that clone's children.                                                                                                                                                                                                                                 | Parent merge → child pass ≤ 60 s.                                                                                              |

---

## 8. What a feature needs to reach a clone, today

This is the checklist W8 writes into the prime's rules. Every **M** (memory)
and **MC** (needs a Mission Control change) is what P2 turns into a
declaration the prime's CI enforces.

- **New edge function.**
  - Already enforced by the prime's CI:
    - `[functions.X]` with `verify_jwt`;
    - a registry entry;
    - the inventory, api surface and ratchet regenerated.
  - **M:**
    - read secrets with a written-out `Deno.env.get("X")`;
    - GoHighLevel-dependent functions go in both CRM-line lists.
  - **MC:**
    - a vendor secret needs a `prime_secret_forwards` row and a value here;
    - any other secret class needs a code change;
    - a prime-only function needs this repository's register.
  - Retiring a function:
    - **M:** delete it, and dispatch Decommission on the prime;
    - nobody cleans the clones.
- **New migration.**
  - Already enforced by the prime's CI: order, a unique version, no ledger
    writes, the object index and seed skeletons.
  - **M:**
    - **dispatch "Apply a migration" on the prime after merging.** Every clone
      waits on that step;
    - `@effect` on a data-only migration;
    - never read rows another migration seeded.
- **New workflow.**
  - Already enforced by the prime's CI: `environment: supabase-production`, a
    job kind, and `BACKEND_DEPLOYED_BY` wired.
  - **M/MC:** decide how it behaves on clones. Any CI secret beyond the
    database URL and service-role key needs a change here.
- **New route or identity file.**
  - **M:** an `App.tsx` route reaches mirrors through a three-way merge. A
    conflict needs a person.
  - **MC:** a new identity file needs an exclusion plus a migration here.

---

## 9. P2: the following weeks

Ordered so each step stands on the one before and can be stopped at any point
without loss.

1. **Delivery manifest, report-only.**
   - The generator and policy are added to the prime with a `--check` step that
     stands down on clones.
   - Completeness rules start from a frozen baseline: every function
     directory, unresolved secret reads, every scheduled workflow's clone
     policy, every file that names a project, every held, prime-only or
     withheld name, `@effect` on new data-only migrations.
2. **Mission Control in compare mode.**
   - It reads the manifest at the cascaded commit.
   - It records where the manifest and its own inference disagree, and acts on
     neither.
3. **Manifest authoritative, one area at a time.**
   - The order is secrets, then workflows and CI credentials, then held and
     retired functions, then identity files, then module ownership.
   - Each area deletes the register it replaces: `PRIME_ONLY_FEATURES`, the
     CRM-line lists, the secret regex and its default `vendor` class, the
     slug-based `verify_jwt` override, `GENERATED_ARTEFACTS`,
     `REPOSITORY_INVARIANTS` and the hard-coded credentials.
   - From here, a held function reaches clones only at the commit the prime's
     release deployed, and deletion travels.
4. **Per-clone desired state.**
   - One work row per clone with its own target, ledger, attempts and backoff.
     That replaces the fold, the carrier refresh, redelivery, the beacon, the
     requeue and event-level retirement.
   - The pass's decision is persisted under a key of read head, clone head,
     policy digest and engine build, so a resumed pass goes straight to the
     tree.
   - Import lists and reconciler outputs are cached by blob.
   - Variant verdicts are keyed by blob, with `MAX_VARIANT_MERGES` above the
     CRM's 37.
5. **Lineage converges.**
   - A child delivers what its parent actually carries, and is triggered by the
     parent advancing.
   - The children's merge count then equals the parent's.
6. **Migrations by effect.**
   - Probe the `creates` facts and `@effect` after applying, and open an
     `effect_missing` blockage on a miss.
   - Send each new version to one canary clone first.
   - Apply on merge behind environment approval (D6).
   - Classify the 202 legacy files as withdrawn, absorbed or owed (D9), so a
     new clone provisions with no holes.
7. **Functions by effect.**
   - Re-list after each pass and assert build identity, `ACTIVE` and
     `verify_jwt`.
   - Port the prime's CORS-contract check.
   - Send `request_timeout` if the API honours it.
   - Gate a bundle on its commit's migrations.
   - Keep one owner per secret, with a contract test that no name has two
     writers.
8. **Fleet view.**
   - A matrix on `/dashboard`, built from the Delivery reader, replaces "ai
     open". `/health`, `/drift` and the fleet manager point at it.
   - The served `buildId` is recorded and joined to the delivered commit.
   - Each stage gets a re-run button.
   - Blockages a person owns get a recorded operator decision, never for
     `ci_red`.
9. **Cheaper polling.** ETag requests for the beacon and the merge drain;
   GitHub does not count a 304.

---

## 10. Decisions only the owner can make

| ID  | Decision                                                                                                                                                                                                                             | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Which CRM line a clone from a signed agreement joins                                                                                                                                                                                 | Record it on the agreement and pass it through. Until then W1 keeps today's tree (the prime's, so GoHighLevel) as a mirror.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D2  | `aml-reliance`: the clones run a build the prime has not released                                                                                                                                                                    | Release it on the prime (the clones' build is the 19 Oct source), or accept the difference in writing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D3  | 16 authorised vendor secrets have no value in Mission Control                                                                                                                                                                        | Set the ones launch needs in Mission Control's environment (Maps, WeasyPrint, PDF parse, AML verification) and withdraw the rest. Do it after W2 ships, in one batch, because each write bumps every function. Resend is not one of them: each clone sends with its own domain-scoped key, written by its email identity, and Preflight's sent a recovery code on 28 Oct. Never set a prime or vendor key there (§15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D4  | 28 retired functions are live on clones (19 unauthenticated `builder-*`, and `street-view`)                                                                                                                                          | Done (#372): 85 deletions, read back on every clone on 27 Oct (Where it stands).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D5  | May a held function reach clones before the prime releases it?                                                                                                                                                                       | No. Mission Control should read `held-functions.txt` (P2 §9.3; sooner as a P1 patch if D2 recurs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D6  | Migrations applied on merge, or by hand dispatch                                                                                                                                                                                     | Alert at 2 h now (L4). Apply on merge, behind environment approval, in P2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D7  | Move the CRM to mirror semantics                                                                                                                                                                                                     | Yes, after the L6 rehearsal is clean; otherwise first thing after launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D8  | A throwaway end-to-end provisioning rehearsal before launch (a repository, a Supabase project, a Vercel project; deleted afterwards)                                                                                                 | Yes. The current path has never run in production, and launch is when it first will.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D9  | The 202 legacy migrations the prime never recorded (the CRM's 185 holes)                                                                                                                                                             | Classify each as withdrawn, absorbed or owed, from the CRM's drift report. Never stamp clone ledgers. The mirrors already carry `asserted` rows for all 185 (§13, G4), so a version found owed must have those rows re-tested against its `@effect` or the objects it creates, not trusted from the union of the ledgers. Delivered on 28 Oct (Where it stands): the owed files as prime #3401–#3404, the twelve withdrawn ones declared by #3405, the chart catalogue by #393 and #394.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D10 | Skipping the prime's merge-push run when the tree is identical (63 of 199 merge-run minutes)                                                                                                                                         | Pending from earlier: say yes or no.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D11 | Clear the stale unread backlog (4,649 `drift_high` and 917 bundle-identity), and purge the custodian's 200,242 duplicate refusals (115 MB)                                                                                           | Yes, once W4 and W5 have shipped, so nothing new refills it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D12 | `VITE_CLIENT_FACING` per line                                                                                                                                                                                                        | Set it explicitly per line. Only the dashboard pins it today, so a clone copied from the prime builds as the internal console.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D13 | The CRM's own `apply-migration.yml` applies migrations Mission Control is holding (§4.3)                                                                                                                                             | Shipped: all five copies of `apply-migration.yml` refuse a dispatch where `BACKEND_DEPLOYED_BY` says `mission-control` (prime #3397; dashboard #435, CRM #141, Preflight #269, NPC Test #267), and the CRM's next dispatch was refused at the guard (run 40589507167). Mission Control labels a canonical row that carries a body and has no legacy row `external`, because none of its own writers stores a body (`migrationProvenance.pure.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D14 | From 10 Oct to the clean-up, the CRM's `voice-agents/` sat in the dashboard's, NPC Test's and Preflight's repositories: ten live Make webhook URLs, the Vapi orgs' phone numbers and SIP URI, and credential ids (not their secrets) | Rotate the ten hooks unless the Make scenarios authenticate their callers. The clean-up pull requests remove the files; history keeps them. Parked by the owner on 28 Oct: nothing is rotated, even at the time set, until the owner is sure. The check-in that would have started it is disabled, and nothing in Make or Vapi has changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D15 | The independent CRM line is parented on the CRM, which is module-scoped, so a new independent clone would start with the CRM's 497 missing prime files and never receive them                                                        | Refuse a parent that is not a mirror in `judgeCrmParent` (`parent_not_mirror`), and keep the line closed to new clones until D7. Shipped on 28 Oct: the CRM is a mirror (#399, #401), `judgeCrmParent` refuses a head that is not, and a head's own `voice-agents/` stays off the clones created from it (#404).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D16 | NPC Test, Preflight and the CRM meter on plan `free` while Mission Control records `launch`/`scale`, and neither provisioning door sets the plan a clone gates on                                                                    | Shipped: provisioning creates or adopts a new clone's metering tenant on the plan it was sold, checked against billing_plans before any repository exists, and never overwrites a paid plan (#385). Credits start with the activation payment (owner, 28 Oct). NPC Test, Preflight and the CRM stay on `free` until launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D17 | Solicitor Portal is sold at $299 a month with a live Stripe price and gated by nothing, so every plan already has it                                                                                                                 | Gate it on the add-on in the prime's capability registry, or withdraw it from sale (`directSale` or `comingSoon`, the Stripe price deactivated). Shipped: gated on its add-on (prime #3408), with `legal-matters-admin` gated with it. Of its five follow-up questions, the staff transport's 403 was fixed on 28 Oct (prime #3413), and the owner took the recommendation for the other four on 29 Oct (prime #3417): `aml-reliance`'s solicitor door and a client's direct solicitor links are gated, the operator override no longer opens a page every staff door refuses, and the AML partner wizard offers the solicitor card only where the portal is open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D18 | Contract exclusions never reach a clone, and the core reconcile installs an excluded module before the exclusion is written                                                                                                          | Shipped: the prime refuses an excluded capability above its tier, add-ons and exemption, and keeps the last list stated (prime #3398; `20270203090000` reached all four clones at 06:00 on 28 Oct). Mission Control states the exclusions as price-list slugs on each balance call that reads the clone's row, stores them as slugs (`20261027140000`), and `provisionCloneCore` writes them before the first reconcile (#381). The list's write is an UPDATE, which finds no row on a clone no staff page has opened, so the gate records the plan before the list too (prime #3409).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D19 | The module catalogue was last detected on 31 Jul (61 of 430 functions belong to no module), and all 134 library entries are `pending`, so no pin can be used                                                                         | Decide whether pins stay; if they do, approve entries at publish and record a commit per entry. After D7, stop using module globs as a delivery scope and keep modules as entitlement vocabulary generated from the prime (§9.3). Half shipped: #388 refuses an approval without a commit. When to detect again is the owner's: now changes the CRM's delivery scope before D15, so the recommendation is after D15, since nothing is pinned today. Detect once, then approve and publish with no detection between, because a module whose backend a later detection found is refused at publish. The reset does exactly that, and from #405 it is safe to run on today's prime (Where it stands). Replayed at prime@122b761, it detects 143 modules, 121 of today's 135 among them. The 14 that went are no longer in the prime (eleven backend groups, `builder-portal`, `cloudflare-management` and `partner-agreements`), and their installs, 14 each on the Dashboard and the CRM, are reported rather than restored. Superseded on 29 Oct: the owner chose that the library follow the prime by itself, which needs no reset (#414, §16). |
| D20 | Enforcing table privileges on the clones. The sweep reports what a clone's browser roles hold and the prime's do not, and revokes nothing (answered 28 Oct: "Sweep tables, report first")                                            | After a week of reports, decide two things: the 66 relations (79 on the CRM) `20270205090000` leaves, which the prime grants less on, and whether the revoke is built behind `ENFORCE_TABLE_GRANTS` (§14). `finance_agent_contacts` is not among them: keeping `authenticated` there was this work's own mistake, and a prime file takes it back as on the prime. Reporting since 28 Oct (#387).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### The owner's answers (27 Oct 2026, evening)

The owner answered D9 and D13–D19 on 27 Oct, and C7 from §13. Each answer, as
given:

- **D9:** classify all 185 holes now, each as withdrawn, absorbed or owed, from
  the CRM's drift report. The owner approves the owed list before anything is
  applied, and clone ledgers are still never stamped.
- **D13:** a clone's `apply-migration.yml` refuses a dispatch wherever
  `BACKEND_DEPLOYED_BY` says `mission-control`, and Mission Control labels a
  ledger row it did not write `external`. The file is protected, so each clone
  keeps its own copy, and the guard goes into all five copies at once: the
  prime's and four byte-identical clone copies.
- **D14:** check each hook, rotate only those that take any caller, re-point the
  voice agents at the new URLs, and delete the old hooks. Of the ten, the six
  tool hooks and the unused launcher take any caller. The adapter, the notifier
  and the loader check a body secret, and its value is not in the copied files.
  The copied tree named 18 more hook URLs, and each is checked the same way
  before anything is rotated.
- **D15, and with it D7:** make the CRM a mirror now. A step-by-step plan and a
  dry-run preview come first, and nothing reaches the CRM until the preview is
  clean.
- **D16:** NPC Test, Preflight and the CRM stay on `free` until launch.
  Provisioning sets a new clone's metering plan from its agreement.
- **D17:** gate the Solicitor Portal on its add-on, once it is known who uses
  it. Only the prime does, with 2 firms, 4 users and 1 open matter. No clone
  holds a firm, a user or a matter, and none has bought it.
- **D18:** fix it now. The exclusions travel in the balance response, the
  prime's snapshot subtracts them, and provisioning passes them through.
- **D19:** pins stay, for clones that stay module-scoped. The catalogue is
  detected again, and each entry is approved at publish with the commit it was
  approved at.
- **C7:** both copies of `backendIsolation.spec.ts` stay, and the lateral lane
  stops holding the file for a person. Each copy names its own deployment's
  project, so it is that deployment's own file (`isLineOwnPath`).

The work runs in the order the owner set: the small fixes first (D13, C7, D18
and D16's provisioning), each its own pull request with a read-back in
production, then D14's rotation, then D17, D9 and D19, and D15 last.

### The owner's answers (28 Oct 2026)

- **D14:** "Don't touch D14 at all even at the set time." It stays parked until
  the owner says otherwise.
- **D18:** the read-back is by sign-in, with a rehearsal on NPC Test, and the gap
  it found (a list recorded nowhere on a clone with no cache row) is fixed now.
- **The activation gate's price:** a gate charges its plan's current price, not
  the price stamped when it was armed (§15).
- **Preflight's administrator:** its one account takes the owner's address in
  place of the dry-run address it was provisioned with (§15).
- **D15, step 0:** all four recommendations, taken after a replay of the switch
  with the cascade engine against the live records.
  - The prime's agent specs (`src/lib/agent/__tests__/**`) stay off the CRM
    line. 115 of them import `src/lib/agent/parityRegister.ts`, which the line
    removed, so delivered they would turn the cascade pull request red.
  - The line's own rules (`.claude/**`) stay its own.
  - `buildVersion.test.ts` and `planEntitlements.spec.ts` take the prime's
    copies, which pass there, and `clientImportRecords.spec.ts` stays the
    line's, because the prime's reads GoHighLevel code the line does not carry.
  - The CRM gets the three default rows it lacks: `.github/dependabot.yml`,
    `src/integrations/supabase/supabaseTarget.pure.ts` and
    `.github/workflows/vcr-prune.yml`.

  The preview is re-run at the day's heads and shown, and the switch is sent
  only when it is clean. The three kept trees are the engine's
  (`CRM_LINE_KEPT_PATTERNS`), held `protected` for a deletion as well as a
  write, and only against bytes from outside the line. The engine ships first
  and the switch after it is live, because the migration flips the scope the
  moment it applies: a cascade on the old engine would carry all three trees
  in.

- **D19:** the catalogue is detected again after D15.
- **A refusal that names the workspace's plan:** the staff transport no longer
  reads it as a failed sign-in, refreshes the session and sends again (prime
  #3413). At 17:42 NPC Test's unpaid workspace refused two modules four times
  while its owner was signed in, and each refusal drew a refresh and an
  identical resend.
- **The Template Builder's comments:** follow prime #3406's per-template rule,
  as the Builder's other tables do, and are seen through their template (prime
  #3414). `template_components` cannot: it is a shared library of blocks with
  no `template_id`, so there is no template to see it through, and its writes
  are already held to the `templates` module.

### The owner's answers (29 Oct 2026)

- **D17's four follow-ups:** the recommended answer for each, shipped in prime
  #3417. `aml-reliance`'s solicitor door and a client's direct solicitor links
  ask the add-on's gate, the operator override no longer opens the portal's
  page on a workspace without the add-on, and the AML partner wizard offers the
  solicitor card only where the portal is open.
- **The install that reached `cdn.sheetjs.com`:** the recommendation, a vendored
  tarball. `npm ci` and Lovable's frozen `bun install` fetched xlsx 0.20.3 from
  SheetJS's own host, so an install failed wherever that host was refused or
  down. The prime now installs it from `vendor/sheetjs/` (prime #3419), with
  the integrity both lockfiles already held.
- **D19:** "I want it to auto update whenever a change is made to the prime
  repo." The library follows the prime by itself instead of waiting for the
  reset, so a clone provisioned at any time is reconciled against the
  catalogue as the prime holds it (§16).

---

## 11. Risks, and how each change backs out

- **Every P0 change narrows or corrects. None widens what is delivered.**
  - W2 can skip only a copy the clone provably still runs from that ledger
    deploy.
  - W6 can only stop a pass earlier.
  - W5 and W4 touch reports and controls.
  - W1 changes only clones not yet created.
  - W7 makes a write atomic that was already meant to be.
- **The riskiest P0 changes are W2 and W6, because they sit on the delivery
  path.**
  - Both are verified on the next pass, by effect.
  - Both revert to today's behaviour with a single revert.
- **Order of release.** W2 and W1 first, because they avert the two costliest
  launch-day failures. Then W4, W5 and W3. Then W6 and W7, which touch the
  engine and the migration lane, with a full pass observed between them.
- **What is deliberately not done before launch.**
  - Making the manifest authoritative.
  - New CI rules on the prime that can fail a pull request.
  - Moving `primeOnlyFeatures.mjs`.
  - Changing `config.toml`'s shape or what `BACKEND_DEPLOYED_BY` means.
  - The desired-state rewrite.
  - Each of these is right, and each is a launch-week outage if it goes wrong.

---

## 12. When each phase is done

- **P0.**
  - Every W item is accepted by its own effect, as stated above.
  - Not one hand-carry into a clone repository is needed for a prime merge
    during the launch window.
- **P1.**
  - Each clone's Delivery panel reads green, or names who acts.
  - A rehearsal clone passes acceptance within five hours.
- **P2.**
  - A month of prime merges ships with no Mission Control change and no
    hand-carry.
  - `withheld` is 0 at rest.
  - The registers listed in §9.3 are deleted.

Every number here came from a SELECT against Mission Control's database, the
clones' own function lists and edge logs, or `git` over the prime and the
clone repositories, on 27 Oct 2026. Code references are to `7dcd33a`, and §13's
to `2e184ed`.

---

## 13. The second audit (27 Oct 2026, afternoon)

Once P0 had shipped, four read-only investigations went back over the cascade
engine, the migration ledger, the edge function deployer and the module
library. They measured production from 13:46 to 14:34 UTC, against Mission
Control at `2e184ed` and the prime at `d72032e1`. Every finding was checked
against the live data before anything changed, and every fix in #374 was
shown to fail on the old code.

Delivery itself was healthy. Every clone held what it was owed, cron was
healthy, and no event or row was stuck. Today's two prime merges reached all
four clones within 65 minutes. What the audit found were latent defects, one
live divergence (E1) and live residue in three repositories (C2).

### Cascade engine

| ID  | Finding                                                                                                                                                                                                                                                                                                                                          | Now                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The merge drain merged without naming the head whose checks it judged, while the engine refreshes open proposals in place: 39 of 134 dashboard cascade PRs since 27 Sep carried content newer than their branch.                                                                                                                                 | Fixed: both merges name the judged head, and a moved head waits.                                                                                                                                                                                                    |
| C2  | The lateral lane copied the CRM line's `voice-agents/` (142 files) into the dashboard on 10 Oct, and lineage carried them on to NPC Test and Preflight. Going the other way, every one of the 435 passes since 8 Oct decided to delete the line's own copies from the CRM, and only the CRM's module scope kept that deletion out of a proposal. | Fixed: a line's own roots and the other line's variants never cross, and each ledger row counts them as `lineOwn`. Clean-up pull requests follow the publish; rotation is D14.                                                                                      |
| C3  | A failed read at the start of a pass stranded its event as a live delivery, which refuses every later head. None existed.                                                                                                                                                                                                                        | Fixed: the claim is handed back, and an unreadable approval gate holds.                                                                                                                                                                                             |
| C4  | Every file was written as `100644`, and neither the engine's diff nor the auditor compares modes, so the prime's 34 executables arrive non-executable. Sixteen scripts were restored by hand on 23 Oct.                                                                                                                                          | Fixed: each file is written at the prime's mode, a mode-only difference is owed and delivered, and a symbolic link is held.                                                                                                                                         |
| C5  | "Retry N failed" left a claim neither reclaim rule could see.                                                                                                                                                                                                                                                                                    | Fixed: the reopen clears the claim, as the drain's revival does.                                                                                                                                                                                                    |
| C6  | The held-file drift sweep read the same 24 of the CRM's 109 held files every hour and reported the run clean.                                                                                                                                                                                                                                    | Fixed: it reads up to 160, only those the prime holds differently, and a capped run reads `partial`.                                                                                                                                                                |
| C7  | Three lateral paths waited "for a person", and no notice said so.                                                                                                                                                                                                                                                                                | Two are a line's own now (C2). `backendIsolation.spec.ts` names each deployment's own project, so it is that deployment's own file too, and nothing waits for a person (§10).                                                                                       |
| C8  | W5's ledger-hole rule shipped differently from its text.                                                                                                                                                                                                                                                                                         | W5 now says what shipped, and why.                                                                                                                                                                                                                                  |
| C9  | Smaller: `previous_sha` never written; a completion notice describes only the last pass; `checksUnreadable` reads Octokit's documentation link as a permission refusal; L11's second child waits a tick (111 s against 60 s); two dead exclusions.                                                                                               | `previous_sha` is written for every operator cascade. It is a prime commit, so the cascade page now diffs each delivery's own commit with its parent. The rest are recorded: each costs a sentence or a tick, and `checksUnreadable`'s hold is right in every case. |

### Migration ledger

| ID  | Finding                                                                                                                                | Now                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | The clone-ledger read failed open: a 2xx body it did not recognise read as an empty ledger, and so as a fresh replay at a live tenant. | Fixed: the replay refuses a ledger it did not read.                                                                                                                                                  |
| G2  | The CRM's own workflow applied versions Mission Control was holding, and §4.3 misreported it.                                          | §4.3 is corrected; D13.                                                                                                                                                                              |
| G3  | Which bodies W7 still sends in two requests is logged to the console only.                                                             | Not changed: that is decided by the file's own text (`migrationRecordRequest.pure.ts`), so it can be read from the tree at any time. Today it is 3 of the prime's files, and none of them needs two. |
| G4  | The mirrors carry `asserted` ledger rows for all 185 hole versions, so an "owed" verdict under D9 would never reach them.              | Added to D9.                                                                                                                                                                                         |
| G5  | The `@effect` of the 12 refresh-masters migrations is false by construction on the three clones that hold no templates.                | Recorded for §9.6: Mission Control does not read `@effect` yet, and a migration that has run is never edited.                                                                                        |
| G6  | The same as C8.                                                                                                                        | As C8.                                                                                                                                                                                               |
| G7  | `cron_delivery_health()` matches every lookup to response id 1, so it reports `delivered = null` for all 60 jobs.                      | Recorded: monitoring only, since delivery is proven by the `fleet.migrations_synced` rows. The fix is a migration in Mission Control's own database.                                                 |

### Edge function deployer

| ID  | Finding                                                                                                                                                                  | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | A function's own `deno.json` was dropped, so `mcp` and `builder-stock-marketplace` ran on every clone without the import map the prime deploys them with.                | Fixed: each bundle carries its own import map, as the CLI deploys it.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| E2  | The catch-up reported `planned: 4` every half hour and rewrote `BACKEND_DEPLOYED_BY` on all four repositories while queuing nothing (49 audit rows a day).               | Fixed: a clone counts as planned, and the deployer is declared, only where a run was inserted or widened. A sweep whose every answer is `no_backend_work` files no breadcrumb either: read back after #374's publish, the 18:20 sweep still wrote one, because the hook counted that answer as a refusal.                                                                                                                                                                                                                         |
| E3  | A run with nothing to deploy never records a functions revision.                                                                                                         | Not changed: an empty batch records none by a recorded rule (a wider diff, never a skip; `backendRevision.contract.test.ts`). Three runs ended that way between 16:48 and 17:40 on 27 Oct, each beside a run that recorded the revision their changes reached (`aa653c0b`), so the catch-up had nothing more to plan. A repeat needs a baseline behind a change and every run after it empty. Recording where the ledger proves every wanted bundle would close it, and changes that rule, so it is left for a change of its own. |
| E4  | A compressed bundle's copy cannot be proven after a secret write, so every whole-fleet run redeploys both by the slowest route.                                          | Recorded for P2: record the manifest's `ezbr_sha256` and accept a copy whose GET matches it.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| E5  | `parseFunctionConfig` cut a `[functions.x]` block at the first `[`, so a bracket in a comment would deploy that function with `verify_jwt=true` on every clone.          | Fixed: the file is read as TOML scopes it. At the prime's head (`aa653c0`) it agrees with `tomllib` on all 430 blocks; the old reading also found a function `X`, in a comment at line 1334.                                                                                                                                                                                                                                                                                                                                      |
| E6  | The clone-owned lane's limits: 20 functions (the CRM is at 14), and `voice-automation-settings` stayed the line's own only while the prime had no function of that name. | The second is fixed by C2, which names it a variant of the line. The cap stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Module library

| ID  | Finding                                                                                                                                                                                                          | Now                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | The independent CRM line is parented on the module-scoped CRM.                                                                                                                                                   | D15.                                                                                                                                       |
| M2  | Three clones meter on `free`.                                                                                                                                                                                    | D16.                                                                                                                                       |
| M3  | Solicitor Portal is sold and gated by nothing.                                                                                                                                                                   | D17.                                                                                                                                       |
| M4  | The catalogue was last detected on 31 Jul, and a new detection would not fix scope.                                                                                                                              | D19.                                                                                                                                       |
| M5  | Contract exclusions never reach a clone. And a new clone's picked modules were one unchecked insert, written after the plan's, so one module in both lost every pick.                                            | The picks are fixed: an upsert that leaves the plan's row, and a failure raises a notice. The exclusions are D18.                          |
| M6  | `approveAndDeploy`, the fleet manager's bulk apply and the bulk cascade card wrote their own events and never asked the second-operator gate; three module controls described a module-scoped clone on a mirror. | Fixed: every cascade a person starts asks the gate on the server (a contract test finds every insert), and each control says what it does. |
| M7  | No pin can be used, and a stale pin would have failed a mirror's whole delivery.                                                                                                                                 | Fixed for mirrors: a pin binds only a module-scoped clone. Whether pins stay is D19.                                                       |
| M8  | Stale records: 300 duplicate `orphan_file` alerts from 31 Jul, two tables with no reader, and artefacts describing the 31 Jul tree as current.                                                                   | Recorded with D11.                                                                                                                         |

### What #374's publish is read back by

#374 was published at 17:59 on 27 Oct and #376 at 18:37. Each line names its
read-back, then what the first read showed.

- The next lateral ledger row counts `lineOwn` and offers only paths neither
  line keeps as its own.
  - **19:10:** the first row, after the dashboard's clean-up moved its head,
    counted 280 paths as a line's own and offered 12.
  - It carried nothing in either direction, and it left one path for a person
    (`backendIsolation.spec.ts`, C7).
  - The clean-up pull requests take the voice stack out of the dashboard
    (`npc-client-dashboard#434`), NPC Test (`npc-test-76b3b3#266`) and
    Preflight (`preflight-property-group#268`). The CRM still holds its 148
    files.
- A half-hour catch-up that queues nothing writes no `backend_catchup_cron`
  row and declares nothing.
  - **18:50:** all four clones answered `no_backend_work`, and the sweep
    filed no row. The 18:20 sweep, before #376, filed one.
- The CRM's held-file drift sweep reads every held file the prime holds
  differently, and no run reads `capped` and `clean` together.
  - **18:17:** it read all 39 such files and capped none.
  - It filed 15 findings, and each is the independent line's own variant:
    GoHighLevel wiring the line does not carry, its native calendar's own
    booking checks, and a cleanup that calls no vendor.
- After its next deploy, each clone's listing shows `mcp` and
  `builder-stock-marketplace` with `import_map_path` ending in their own
  `deno.json`.
  - **NPC Test (18:16) and Preflight (18:42):** each run changed 2 bundles and
    proved 400. Both functions now list their own `deno.json` on both clones.
  - Three `mcp` handshakes each, at 19:15: 0.4–0.7 s on those two and on the
    prime, and 1.6–2.2 s on the dashboard and the CRM, which still run without
    the import map.
  - The dashboard and the CRM take theirs at their next whole-fleet run, which
    any change to `supabase/functions/_shared/` plans.
- A cascade an operator starts carries `previous_sha` on its rows, and its
  page's diff lists the files its row records.
  - **Live:** the page diffs each delivery's commit with its parent. No
    operator cascade has run since.
- The next lineage cascade writes the dashboard's three executable scripts at
  `100755` in NPC Test and Preflight (C4): `scripts/check-clone-invariants.sh`
  and the two `scripts/clone-backend/*.py`.
  - **Not read yet.** A child's cascade runs inside a prime cascade, and none
    has run since the publish.

## 14. The clones' open tables (28 Oct 2026)

Classifying the D9 holes meant reading each clone's table privileges. That read
found that a request carrying nothing but a clone's publishable key could read
tables the prime keeps private.

- **What was open.** On all four clones, `anon` held SELECT, INSERT, UPDATE and
  DELETE on 24 tables whose policies are written `TO public USING (true)`, so
  privileges were the only gate.
  - A count-only request read `client_address_history` (5 rows on
    npc-client-dashboard, 33 on the CRM), `client_income_sources` (5),
    `finance_agent_contacts` (1) and the 3.5M-row `api_usage_log`.
  - Every reference cache a report reads could be written.
- **Why only the clones.** The prime took these privileges back in July
  (`20260721140000` onward, F-07), and those versions are holes on every clone
  (D9). A clone is built from the prime's catalogue with Supabase's default
  privileges. Provisioning adds the grants a clone lacks but never takes one
  back.
- **What was done.** With the owner's approval, the privileges were taken back
  by hand on the four clones between 05:02 and 05:06 UTC, to the prime's state:
  - the browser roles get nothing on the private tables, except that
    `authenticated` keeps `finance_agent_contacts`, as on the prime;
  - nobody but the service role writes a reference cache.

  All 24 tables read back as intended, and the same count-only request now
  answers 401.

- **What it broke.** `authenticated` was kept on `finance_agent_contacts` for
  the Settings page's Finance Agent Contacts card, and that kept nothing for
  it. This app's browser client is anon, because the staff session is an
  HttpOnly cookie, so the card reads and writes as anon. It has been refused
  on the clones since 05:02, as it has been on the prime since July (a
  count-only read as anon answers 401 there). Prime #3400 moves the card onto
  `finance-portal-admin`, the function the Finance Portal admin pages use.

- **What else was checked.** No clone has a storage policy, so storage fails
  closed. The `net` schema is not served (`PGRST106`), `anon` cannot enter
  `aml`, and no role table has a write policy.
- **What makes it permanent.** Prime #3399 (`20270204090000`) states the same
  revokes. The prime recorded it at 06:48, and the 07:00 fleet pass applied it
  to all four clones. It was a no-op on each of the five.
- **Whether anyone used it.** Each clone's API logs were read for every
  request made without a secret key, over the project's whole retention: from
  19 Aug on npc-client-dashboard, 3 Sep on NPC Test and Preflight, and 19 Sep
  on the CRM.
  - No outside request read or wrote a private table, wrote a reference cache,
    or used `/graphql/v1`.
  - The only other private-table requests were our own count-only probes of
    28 Oct, and the Finance Agent Contacts card on npc-client-dashboard: four
    reads and one insert of `finance_agent_contacts`, on 6 and 16 Sep, from
    one Sydney address with the app's own referer.
  - Realtime channels are not in the logs, so a subscription to a private
    table could not be checked.
- **What it does not cover.** A clone built later is stamped past that version
  and would start with these tables open. The owner chose to extend the
  half-hourly privilege sweep (`/hooks/clone-privilege-reconcile`) to table
  grants: report-only for a week, then enforced.
- **What the sweep reports.** Each pass compares the table privileges of
  `anon` and `authenticated` on every `public` relation both sides hold with
  the prime's live ACL, and revokes nothing (`tablePrivileges.pure.ts`,
  `ENFORCE_TABLE_GRANTS` off). It reports under `tables` in the hook's answer,
  in its audit row, and in a `drift_medium` notice when a clone's surplus
  changes (THE_CLONING_ENGINE.md).
  - Measured with its own code over the live catalogues on 28 Oct, after the
    hand revokes and `20270204090000`: 2,598 surplus privileges on 190
    relations on npc-client-dashboard, NPC Test and Preflight each, and 2,805
    on 203 on the CRM.
  - `20270205090000` takes back 1,595 of them, on its 124 relations. That
    leaves 1,003 on 66 relations (1,210 on 79 on the CRM): 64 (77) relations
    neither migration names, `dashboard_modules`' REFERENCES and TRIGGER, and
    `finance_agent_contacts`.
  - `finance_agent_contacts` was kept for `authenticated` above "as on the
    prime", and the prime has not given `authenticated` anything there since
    `20260721141000`. Every clone gives it all eight, under a
    `TO public USING (true)` policy. Keeping it kept nothing for a screen,
    because the browser is anon, and sign-up is off on all four clones (read
    28 Oct), so only an existing account could use it. A prime file takes it
    back, as on the prime.

## 15. Found on 28 Oct, outside the plan

The owner signed in to NPC Test and Preflight on 28 Oct for D18's read-back,
and that turned up four things no part of this plan had measured.

- **The activation gate quoted September's prices.** All four gates were armed
  on 16 and 19 Sep, and `seat_plans` was repriced on 27 Sep (Launch $699 to
  $999, Scale $2,210 to $2,699). Nothing re-stamps a gate's `amount_due_cents`,
  so NPC Test's lock screen said $699, and the checkout held Stripe's $999 row
  to that quote and refused it as `price_mismatch`. The owner ruled that a gate
  charges today's price. `gateQuote` is now the one reading of it, for the
  verdict, the guard's 402 and the checkout's assertion (#395).
  - The checkout's refusals carried the bare pricing page, so the only way out
    after the failure named no workspace. Every refusal now carries the page
    scoped to the workspace's billing id (#395), and the clone's lock screen
    opens it as an attributed handoff, as the top-up CTA does (prime #3411).
  - Read back: $999 on NPC Test's lock screen, and `checkout_started` for
    `launch` from the clone's own button at 17:42:10.
- **Preflight's only account was registered to a dry-run address.** Username
  `admin`, address `preflight.dryrun@aurixasystems.com.au`, never signed in. A
  reset for any other address answers "if the account exists, a code has been
  sent", by design, and never reaches Resend. With the owner's approval the
  account's address was changed to the owner's at 17:24, and the next reset
  sent from `send.preflight-property-group.aurixasystems.com.au` at 17:43:51.
  Its `auth.users` row still carries the dry-run address; the staff login reads
  `custom_users`.
- **The secret ledger reads `missing` for keys that are there.** Preflight's
  `RESEND_API_KEY` and `RESEND_FROM_EMAIL` rows say `missing`, and the
  dashboard's say the same. Both were written by the clone's email identity
  (Preflight's on 3 Sep, the dashboard's on 30 Aug) and the rows were then
  rewritten by a provisioning pass (5 Sep and 4 Sep) before provisioning read
  the identity's writes as settled. Preflight's key is proven by its send. The
  dashboard's is proven by nothing, because it has never sent.
  - §4.2 counted these two among the forwards Mission Control has no value for.
    They are not forwards. Setting a prime or vendor key there would replace a
    working domain-scoped key with one Resend refuses for that sender.
  - The hourly email audit now asks each clone's project for its secret names
    and writes the two rows from that listing: `set` where the project has
    the name, `missing` with the remedy where it does not (#397,
    `identityLedgerFromListing`). It reports an absence and rotates nothing,
    because a rotation writes both secrets, and any secret write bumps every
    function's version (§4.2).
    Writing a key now stamps both rows, not only the key's, which is why every
    clone's `RESEND_FROM_EMAIL` row also read `missing`.
- **The gate's read stamp was lost.** The verdict route stamped
  `last_checked_at` without waiting, and the stamp stopped landing: NPC Test's
  verdict reads after 16:09 and Preflight's at 17:45 left nothing, and the
  console said a lock screen in use had never been read. The route now waits
  for it (#397).

---

## 16. The library follows the prime (29 Oct 2026)

The owner decided on 29 Oct that the module library updates itself whenever
the prime changes. Until then it changed only when an admin pressed Reset and
re-ingest, and nobody had: the catalogue was July's, and every one of its 134
entries was `pending` (D19).

Measured that morning, read only:

- `modules` held 135 rows, all `approved`. 134 named July's run, which recorded
  no commit, and `accountant-portal` named none.
- `module_library` held 134 entries, all `pending`, none recording a commit.
- `clone_modules` held 328 installs across the four clones.
- Detection replayed at prime@122b761 finds 143 modules: 121 of the 135 slugs,
  22 new, and 14 gone (D19's row in §10).

### How it runs

`/hooks/module-library-follow` (`library-follow.server.ts`) runs at 4, 19, 34
and 49 minutes past each hour, on the cron secret, with ten minutes' patience
(`20261029140000`). It reads the prime's head. While the catalogue is settled
at the head, that is all it does, and it records nothing. When the head has
moved, it detects the catalogue there in follow mode, then settles it at the
run's commit:

1. Every module the run finds is rewritten from the run, an approved one
   included. So each module names the run, and the one commit, that found its
   files and its backend. A name or description a person wrote is kept.
2. What the run proposed is approved by policy, with no approver.
3. A live module the run did not find is archived as the follow's
   (`modules.archived_by_follow_run_id`). A later run that finds it again
   brings it back. A module a person archived or rejected stays as they left
   it, and the report names it.
4. An entry is published, approved at the run's commit, for each module whose
   entry would differ from its latest, through the publication's own writer
   (`writeLibraryEntries`). A score is not a difference. A latest entry that is
   not approved at a commit, as every entry before the follow is, is replaced
   whatever it says.

The follow changes no clone: no clone row, install or pin. A reconcile
resolves a clone's plan from its metering tenant, and on 29 Oct all four clones
metered on `free` while Mission Control recorded `scale`, `scale`, `launch` and
`scale` (D16: they stay on `free` until launch). A reconcile from the follow
would have rewritten all four recorded plans to `free`, and plan-targeted
notices and the payment gate read that record. Every clone is a mirror, which
receives every file whatever its installs say, so the follow owes no clone
anything. A contract test holds the follow to it.

The run stays `running` until it is settled, so a reset or a detection a
person starts meets it and stops. The follow does the same in turn: it waits
for either before it writes a run row. One audit row,
`module_library.follow`, records each follow that did something or could
not.

A finished follow run prunes the diagnostics of every earlier finished run but
the one the catalogue is settled at: their import edges, backend artifacts and
drift alerts, not the runs' own rows. Each of July's three runs left 13,698 of
them (2,000 edges, 11,598 artifacts and 100 alerts). The Modules page reads a
module's artifacts across every run, and the drift metrics count alerts across
them, so a follow per prime merge would multiply both.

### Where it stops for a person

- **The breaker.** A run that finds no module, or would archive more than
  `max(10, a quarter of the live catalogue)`, is held before it writes a
  module. Nothing is rewritten, approved, archived or published.
  Every operator is told (`library_follow_held`), and the follow waits for the
  prime to move. The first follow archives 14 of 135, inside the 34 it may.
- **Three tries.** A follow that fails is tried again at the next tick, three
  times at one commit. A run that died still saying `running` is closed and
  counted as a try. The third failure tells the operators, and the follow then
  waits for the prime to move, so a failure that repeats does not spend a
  detection's GitHub calls every fifteen minutes.

### What a new clone receives

A new clone is created from its source's default branch, as a mirror unless
its line says otherwise, so its code is the prime's head when it is
provisioned. Its installs are reconciled against the catalogue, which the
follow keeps at the prime's head. The reconcile's audit row names the follow
run and commit the catalogue was settled at, or null where no follow has
settled it yet (`catalogueSettledAt`).

### How it is read back

The first tick after Mission Control is published detects at the prime's
head. Production is the first measurement of a detection on Mission Control's
own runtime: the replays ran on a copy of the prime, not on Cloudflare. It is
read back by effect:

- one follow run at the head's commit, `completed`;
- 143 modules naming that run, 14 archived as the follow's, and none `proposed`;
- one approved, latest entry per live module, at that commit, with no approver;
- a `module_library.follow` audit row whose lists match;
- July's runs' 41,094 diagnostic rows pruned, and only the follow run's left;
- every clone's row and installs as they were before.

A run that cannot finish on the runtime shows as three failed tries and one
notice, and nothing it wrote is published.
