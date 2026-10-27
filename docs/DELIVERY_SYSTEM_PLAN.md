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
  - On 26 Oct both Mission Control and the CRM's own workflow applied
    `20270202090000`, eleven minutes apart. The workflow runs without
    `--single-transaction`.
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
  - **`prime_ledger_hole`** is raised only where something is held behind the
    hole. The two rollback holes read "never to be run".
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

| ID  | Decision                                                                                                                                   | Recommendation                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which CRM line a clone from a signed agreement joins                                                                                       | Record it on the agreement and pass it through. Until then W1 keeps today's tree (the prime's, so GoHighLevel) as a mirror.                                                                                                                               |
| D2  | `aml-reliance`: the clones run a build the prime has not released                                                                          | Release it on the prime (the clones' build is the 19 Oct source), or accept the difference in writing.                                                                                                                                                    |
| D3  | 16 authorised vendor secrets have no value in Mission Control                                                                              | Set the ones launch needs in Mission Control's environment (Resend for Client Dashboard and Preflight, Maps, WeasyPrint, PDF parse, AML verification) and withdraw the rest. Do it after W2 ships, in one batch, because each write bumps every function. |
| D4  | 28 retired functions are live on clones (19 unauthenticated `builder-*`, and `street-view`)                                                | Delete them from the clone projects before launch: an unauthenticated login and password reset for a retired portal is attack surface with no owner.                                                                                                      |
| D5  | May a held function reach clones before the prime releases it?                                                                             | No. Mission Control should read `held-functions.txt` (P2 §9.3; sooner as a P1 patch if D2 recurs).                                                                                                                                                        |
| D6  | Migrations applied on merge, or by hand dispatch                                                                                           | Alert at 2 h now (L4). Apply on merge, behind environment approval, in P2.                                                                                                                                                                                |
| D7  | Move the CRM to mirror semantics                                                                                                           | Yes, after the L6 rehearsal is clean; otherwise first thing after launch.                                                                                                                                                                                 |
| D8  | A throwaway end-to-end provisioning rehearsal before launch (a repository, a Supabase project, a Vercel project; deleted afterwards)       | Yes. The current path has never run in production, and launch is when it first will.                                                                                                                                                                      |
| D9  | The 202 legacy migrations the prime never recorded (the CRM's 185 holes)                                                                   | Classify each as withdrawn, absorbed or owed, from the CRM's drift report. Never stamp clone ledgers.                                                                                                                                                     |
| D10 | Skipping the prime's merge-push run when the tree is identical (63 of 199 merge-run minutes)                                               | Pending from earlier: say yes or no.                                                                                                                                                                                                                      |
| D11 | Clear the stale unread backlog (4,649 `drift_high` and 917 bundle-identity), and purge the custodian's 200,242 duplicate refusals (115 MB) | Yes, once W4 and W5 have shipped, so nothing new refills it.                                                                                                                                                                                              |
| D12 | `VITE_CLIENT_FACING` per line                                                                                                              | Set it explicitly per line. Only the dashboard pins it today, so a clone copied from the prime builds as the internal console.                                                                                                                            |

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
clone repositories, on 27 Oct 2026. Code references are to `7dcd33a`.
