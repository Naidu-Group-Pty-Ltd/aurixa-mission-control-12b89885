# A prime merge re-owes only what it changed

**Status:** written 20 Oct 2026, on `claude/confidential-report-cleanup-at2jfw`.
Not merged. Migration `20261020090000_clone_function_deploys.sql` runs when it
merges (`apply-migrations.yml`).

Modules:

- `src/server/functionBundleDigest.pure.ts`: what a bundle is, as one value.
- `src/server/edgeBundleLedger.pure.ts`: when a clone's copy is provably the
  deploy this lane made.
- `src/server/projectFunctionCopies.pure.ts`: one reading of a clone's
  function list.
- `src/server/functionDeployLedger.server.ts`: the ledger's reads and writes.
- `src/server/anonymousFunctionSlugs.pure.ts`: the `verify_jwt` a clone is
  actually sent.
- `planSkip` in `fetchPrimeBackendSnapshot`, and the lane in
  `executeEdgeFunctionDeploy`.

Tests: `functionBundleDigest.test.ts`, `edgeBundleLedger.test.ts`,
`projectFunctionCopies.test.ts`, `anonymousFunctionSlugs.test.ts`,
`primeSnapshotPlanSkip.test.ts`, the ledger simulation at the end of
`edgeDeployBatch.test.ts`, and two describe blocks in
`edgeDeployResume.contract.test.ts`.

## What happened

No clone's backend received an edge function between 12–13 Oct and 20 Oct
2026 (F23 in [the 19 Oct hand-over](./HANDOFF_2026-10-19_CONTINUED.md)). Each
clone's whole-fleet `edge_function_deploy` run was parked
`awaiting_validation`, reading *"1 bundle(s) deployed over 30 passes and more
remain"*:

| Clone | Run | Parked (UTC) |
|---|---|---|
| npc-client-dashboard | `28ddbe05` | 12 Oct 16:20 |
| npc-crm-independent | `12cce521` | 12 Oct 16:34 |
| Preflight | `6b905563` | 12 Oct 15:48 |
| NPC Test | `10638fbc` | 13 Oct 16:24 |

The lane decided "already delivered" from the clone's own timestamps alone. A
copy newer than the run's generation was delivered, and anything older was
owed. A timestamp says a copy landed, never what it holds. So when the prime
moved, the lane could not tell a bundle that changed from one that did not.
`planDeployGeneration` restarted the generation, every bundle was owed again,
and `planEdgeDeployResume` charged the restart an attempt.

A pass landed about one bundle. The prime merged about twenty times a day.
So a run could never finish: it parked after thirty merges, the planner
retired three such chains itself, and the fourth waited for a person.

## How much a merge actually changes

Measured with the snapshot's own grouping, prune and digest
(`scripts/edge-deploy/measure-bundle-churn.ts <prime-checkout>`, which runs
the lane's modules over a local checkout) on the prime's 340 first-parent
commits between 12 Oct and 20 Oct:

| Bundles a commit changed | Commits |
|---|---|
| none | 71 |
| 1–5 | 228 |
| 6–50 | 36 |
| more than 50 | 4 |

Re-owing what each commit changed costs **1,383** bundle deploys over the
window. Re-owing every bundle on every commit costs **135,763**. The
first number is a deployment that finishes. The second, at one bundle a pass,
is one that never does.

## The rule

**A clone's copy is current only where both halves agree:**

1. **The bundle has not changed since this lane deployed it.** The ledger's
   digest equals the digest the prime's tree gives that bundle now.
2. **Nothing has been written over that deploy since.** The clone still lists
   the very function id at the very version the Management API answered the
   deploy call with.

Every deploy of a function increments its version. So a copy replaced since by
anything else is a later version, and is owed again however soon after this
lane's deploy it landed. That includes the clone's own CI, a Lovable publish,
or a person.

Every doubt resolves to **owed**. No ledger row, a digest the tree cannot give,
a clone that does not list the function, a copy that is not `ACTIVE`, an id or
version either side failed to report: each one redeploys. A redeploy costs one
call. A bundle wrongly believed current is a tenant running code nobody can
see is stale.

### Why the version and not the clock

The first draft compared the clone's `updated_at` with the window the deploy
call ran in, allowing five minutes for the two clocks to disagree. That window
is exactly where a second writer is most likely. A cascade merging into a
clone starts the clone's own function deploy for the same slugs the catch-up
asks this lane to deploy, minutes apart.

The version is the project's own count of writes, so it has no window at all.
Both fields are in the deploy call's documented answer (`DeployFunctionResponse`:
`id` and `version`, both required, read from the Management API's published
types in `supabase-management-js` 2.0.2). Both are in every row of the
function list, measured on npc-client-dashboard on 20 Oct: 427 functions, every
one with a uuid `id`, an integer `version` and `status: "ACTIVE"`.

### What the digest covers, and why exactly that

The digest covers exactly what `deployEdgeFunction` sends:

- the slug, the entrypoint and the import map;
- the `verify_jwt` actually sent;
- every file the bundle carries **after pruning**, each by its git blob id.

Two revisions whose digests agree send the Management API byte-identical
requests.

- **Pruned, not whole.** Every bundle carries the whole `_shared` tree before
  pruning, so a digest over the unpruned bundle would change on every shared
  edit, which is the restart this exists to stop. A bundle that declines to
  prune is deployed whole, and is digested whole.
- **The flag sent, not the prime's.** A webhook-style slug is deployed
  anonymous on every clone whatever the prime declares (Issue #15). Digested
  from the prime's flag, a change to that rule would leave every digest
  standing. So the rule now lives in one pure module that the deploy and the
  digest both read.

Both properties are pinned by mutation: digesting the unpruned bundle, or the
prime's flag, fails `primeSnapshotPlanSkip.test.ts`.

## Where the skip list is decided

**Inside the snapshot, at the commit it read** (`planSkip`). Both the
generation and the ledger's proof depend on which tree the pass deploys. The
generation depends on whether the prime moved since the last pass. The proof
depends on whether a bundle's digest changed, and a digest exists only for a
tree that has been read.

Decided before the read, against a HEAD resolved a moment earlier, they could
judge one commit and deploy another. The lane no longer resolves the prime's
HEAD separately, so the commit judged is the commit deployed.

That is also what lets an empty batch complete the run. When the prime moves,
the generation restarts before the skip list is taken. What is still skipped
is then only what the ledger proves is this tree's bundle. The old guard
(`batch.length === 0 && !generation.sourceMoved`) existed because the skip list
used to be computed against a superseded tree.

The snapshot already fetched every bundle's files for the secret scan, so
`planSkip` costs no fetch. It does prune every bundle, once each, through one
parse of each file (`memoisedSpecifiers`). Measured on the real tree:

- 2,320 files and 34.7 MB of text.
- Parsing every file once takes about 1.9 s.
- Pruning and digesting all 401 bundles from the parsed answers takes 95 ms.
- Across the 340 commits, the median was 1.4 s and the largest 2.7 s.

The old code parsed the shared files again for each of its sixty selected
bundles, so the CPU a pass spends is about what it was.

## What a merge costs the run now

`planEdgeDeployResume` still charges a restart an attempt. A restart re-owes
what the run had delivered, and the charge is what bounds a run that keeps
being overtaken. The lane passes `sourceMoved` as
`generation.sourceMoved && !ledgerCarries`. Here `ledgerCarries` means the
ledger was read **and** this pass's landings were written to it. Where both
hold, a merge re-owed only what it changed, so there is nothing for the charge
to bound.

The trade is stated in `planEdgeDeployResume`'s own comment. A run the prime
changes faster than passes land is no longer sent to a person. It keeps
deploying, stalest first, and finishes when the prime holds still long enough.
A pass that lands **nothing** is still charged, so a bundle that fails every
time still reaches a person.

The simulation at the end of `edgeDeployBatch.test.ts` uses the lane's own
decisions on a model clone of 395 bundles. It runs two deploys a pass, a merge
every nine passes, and three bundles changed per merge:

| Ledger | Outcome |
|---|---|
| read and written | completes at pass 215; 23 merges, none charged; 431 deploys |
| unreadable | parks at pass 279 after 31 charged restarts, as before |
| read, never written | parks at pass 279, as before |

## What the operator sees

Every result the lane writes now carries:

- `ledger`: either `{ proven, recorded }` plus any `write_error`, or
  `{ unavailable }`.
- `owed`: what the run still owes before this pass.
- `pass_ms`: where the pass spent its budget, as `clone`, `ledger`,
  `snapshot`, `deploy`, `record` and `total`.

Nothing recorded `pass_ms` before. The hand-over's remedy 2 (make a pass carry
more than one bundle) was blocked on exactly that measurement. The first live
passes will answer it.

## What it does not change

- **Progress is still read off the target.** `refreshedSince` is unchanged,
  and the ledger is consulted beside it, never instead of it. A pass that
  landed sixty bundles and lost its invocation still counts.
- **Within one generation, a copy written by something else still counts as
  delivered.** That is the timestamp rule, unchanged. The ledger catches it at
  the next merge or the next run: the copy's version no longer matches, so it
  is owed. A rule that also distrusted those copies would stop a run whose
  ledger writes fail from ever finishing. Only the move's attempt charge
  bounds that, and inside a generation there is no move.
- **No revision is recorded over an empty batch**, as before
  (`backendRevision.contract.test.ts`).
- **Remedy 1 is not done.** A cascade's named deploys are still folded into a
  parked whole-fleet run. With this change a run no longer parks for being
  overtaken, so the fold costs less, but a run parked for another reason
  still absorbs every later plan.

## The first run after this merges

Nothing on any clone has a ledger row, so the first run on each clone
redeploys every bundle once. That is the honest cost: nothing proves which
tree the current copies came from, and every clone's functions are about a
week stale anyway.

The four parked runs have to be **rejected** by an administrator first
(Step J in the hand-over). They stand at 31 of 30 attempts, so an approved run
parks again at its next charged pass.
