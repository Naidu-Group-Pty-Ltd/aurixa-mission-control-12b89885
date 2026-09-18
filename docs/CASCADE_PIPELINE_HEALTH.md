# The cascade stays healthy by construction, not by incident

Read this before adding another guard to the cascade engine.

[`CASCADE_ON_MERGE.md`](./CASCADE_ON_MERGE.md) records roughly forty defects
and the rule each one bought. Every one of them is correct. Every one of them
was written *after* a freeze, from the freeze's own evidence, and closes the
route that freeze took. That is the strategy this document replaces — not
because it was wrong, but because it has a ceiling: **a guard can only be
written about a path somebody has already walked**, and the fleet's next
freeze will take a path nobody has.

This document is the preemptive half. It asks what every stall has in common
rather than what each one was, and it proposes three mechanisms that make the
class unreachable instead of the instances rare.

It does not relax a single refusal. Nothing here merges a red tree, lifts a
`protected` path, grants its own approval or widens a cap. The whole design
turns on a distinction the engine does not currently draw: **a blockage caused
by the machinery, and a blockage caused by the code.** The first must never
persist. The second must never be papered over. Today they are the same
silence.

---

## 1 · What is actually wrong, measured

Taken from the live Mission Control database on 18 Sep 2026, with all three
clones reading `in_sync`, `commits_behind = 0`, and all 50 pg_cron jobs
`active` and `succeeded`. The fleet is healthy at this instant. Every
condition below is also true at this instant.

### 1.1 The escalation channel is dead, and the fleet killed it

```
2,459 unread notifications
  1,253  drift_high            (51%)
    693  cascade_completed     (28%)
    250  deployment_live       (10%)
    104  cascade_failed         (4%)
```

**Seventy-nine per cent of the channel is either a success or a normal
operating state.** Volume runs 130–270 a day. `cascade_blocked` — the signal
`blockedEscalation.pure.ts` exists to raise, the one that says *this will fail
for ever until a person acts* — arrives into that.

The owner's report behind the conflict work was *"whenever there are merge
conflicts it never closes"*, with the note that the notification had already
been learned and filtered. This is why. The mechanism was built; the channel
it speaks into was already saturated.

### 1.2 `drift_high` fires during ordinary operation

The three most recent `drift_high` rows, and what the clones did next:

| fired | notification | clone converged |
|---|---|---|
| 08:45:06 | *High drift on NPC Client Dashboard — "Trigger Manual Sync PR"* | 09:00:46 |
| 08:45:09 | *High drift on Preflight — "Manual Cascade Sync Required"* | 09:00:45 |
| 09:00:13 | *High drift on NPC Client Dashboard — "Investigate Stalled Cascade Pipeline"* | already done |

Nothing was stalled. Prime pushed, the fleet was mid-delivery, and the scan
that runs every fifteen minutes read a non-zero `commits_behind` and called it
urgent. Delivery takes about seventeen minutes of CI plus drain latency, so
**the alert fires on the normal state of a working pipeline**, several times
per prime commit, on every clone.

That is the whole of the 1,253. The alarm is keyed on a *level* when the fault
is a *derivative*: drift is not a fault, drift that has stopped shrinking is.

### 1.3 A dead health surface

`clone_health_snapshots` holds **three rows, last written 1 September 2026** —
seventeen days ago. Nothing writes it. The repo's own rule from the builder
portal applies exactly: *a component is not shipped until something renders
it*, and its converse — a health table nobody writes is worse than no table,
because its name promises a reading somebody may believe.

### 1.4 Forty-three rows that can never reconcile, reported nowhere

```
43 cascade_results  status = 'pr_opened'   created 26–28 Aug 2026
12 distinct pull requests
   https://github.com/lavan96/npc-client-dashboard/pull/27 … /44
```

The clone's `repo_full_name` is `Naidu-Group-Pty-Ltd/npc-client-dashboard`.
**The repository moved owners** — `clone-repo-retarget.server.ts` exists for
exactly that — and the historical rows kept the old URL. `pulls.get` against
`lavan96/…` cannot succeed under the current installation, the drain classes
it `foreignRepo` and skips, and it has skipped on every run, every five
minutes, for three weeks.

This is the species in its purest form: **permanent, silent, and nothing to do
with anybody's code.** No surface anywhere says "43 rows have been
unreconciled for 21 days". The drain is working exactly as designed.

### 1.5 Failure is counted per event, never per clone

```
cascade_events   57 failed (commit) · 8 failed (manual) · 15 partial
cascade_results  42 failed  —  Preflight 22 · NPC Client 15 · NPC Test 5
```

`partial` is terminal: some clones landed, some failed, and the event settles.
The clones that failed are carried only by the *next* cascade happening to
succeed. Nothing counts consecutive failures per clone, so **a clone that
fails every cascade for a month looks, event by event, exactly like a clone
that failed once.** Preflight carries 22 failed results; nothing anywhere
reads that as a standing condition.

### 1.6 Green pg_cron is still the wrong question

All 50 jobs `active`, all `succeeded`. `CASCADE_ON_MERGE.md` already records
why that is not evidence — pg_cron reports on the SQL that queued the HTTP
call. Underneath it, in the last 24 hours: **32 `net._http_response` rows with
a NULL status code**, clustered 09:02–10:36. Those are invocations that
returned nothing. pg_cron called every one of them a success.

---

## 2 · The reframing

Every reading the platform has of "is this clone in sync" is derived from the
ledger the actor wrote:

- `sync_status` comes from `commits_behind`
- `commits_behind` is measured **from `last_synced_sha`**
- `last_synced_sha` is written by the merge drain
- the merge drain reads `cascade_results`, written by the engine

So when the actor is wrong, the reading is wrong **in the same direction**.
That is not a hypothetical: the 84-commit lie of 16 September was precisely
this, and its fix — `choosePointerAdvance` — made the pointer honest without
changing the fact that the pointer is still the only thing anybody reads.

> **The rule this document adds: sync is a property of two trees, and it is
> measured by comparing them. Never by reading the ledger.**

And the second, which follows from §1.2:

> **Divergence is the normal state of a working pipeline. The fault is
> divergence that has stopped shrinking.**

Everything below is those two sentences, built.

---

## 3 · Mechanism one — the Convergence Auditor

`cascade/convergence.pure.ts` + `hooks/cascade-audit`, every fifteen minutes.

For each clone:

1. read prime's tree at head — one recursive `git/trees` call
2. read the clone's tree at its default branch head — one call
3. partition both through **`partitionCascadePaths`**, the engine's own
   function, against the clone's own `clone_sync_exclusions`
4. `owed` = paths the cascade *would write* whose blob SHA differs
5. verdict: `converged` (owed is empty) · `delivering` · `stalled` · `unknown`

Two calls per clone. Six for the fleet. Twenty-four an hour against a
5,000/hour installation window, and it asks `decideSpend` at the `SCAN_FLOOR`
first, so it yields to the cascade exactly as the other scans do.

### Why this reading is different from every reading that exists

`commits_behind` is non-zero the instant prime pushes, whatever the clone
holds. `owed` is zero both when nothing has changed *and* when a cascade has
landed — it is the same number the engine would compute if you asked it to
cascade right now, which is the only number that answers the question an
operator is actually asking.

It is also the only reading that sees divergence **no event ever created**: a
force-push, a revert of a cascade merge, an exclusion that grew too broad, a
Lovable edit on the clone. None of those make a `cascade_event`, so none of
the existing machinery looks. The auditor compares trees; it sees all of them.

### The derivative, which is what replaces `drift_high`

`owed` alone is a level and must never raise anything. What is stored is the
**fingerprint of the owed path set** and the time it was first seen:

| state | meaning | notify |
|---|---|---|
| `owed = ∅` | converged | never |
| `owed` changed since last pass | delivery is moving | never |
| `owed` unchanged, younger than the SLO | in flight | never |
| `owed` unchanged, older than the SLO | **stalled** | once, with the blockage |

`CONVERGENCE_SLO_MINUTES` lives in `prime_config`, not as a literal — CI is
~17 minutes, the merge drain is 5, a conflict repair adds a cycle, so 90
minutes is the starting value and it is a number an operator can defend and
change. §1.2's 1,253 notifications become zero without losing one real signal,
because every one of them was inside the window.

### Four rules

**It never writes to `cascade_events` or `cascade_results`.** It cannot
corrupt what it measures. Same rule that keeps `processClone` write-free for
the rehearsal's sake, and asserted the same way — by source position.

**It reads through the engine's own partition.** Two implementations of "what
the cascade owes" is how they come to disagree; that is the `globToRegex`
lesson and it applies here with more force, because this one is the
*authority* on whether the other one worked.

**A failed read is `unknown`, never `converged`.** The most-repeated rule in
this repository. An unreadable tree is not an empty diff, and a truncated tree
refuses the whole reading rather than reporting the part it got.

**It measures; it never repairs.** Everything it finds goes to §4.

---

## 4 · Mechanism two — the Blockage Ledger

`clone_sync_blockages` — one open row per (clone, class, fingerprint), with
`first_seen_at`, `last_seen_at`, `cleared_at`, `owner`, `escalated_at`.

> **Every reason a clone is not converging has a class, an owner and a clock.
> A blockage may be silent, or it may be permanent. It may never be both.**

That sentence is the whole contract, and it is what lets the taxonomy below be
useful rather than merely long.

### 4.1 The taxonomy

Derived by walking the pipeline — prime moves, signal, event, claim, pass,
propose, verify, merge, reconcile, deploy — and asking what can stop at each
stage. **`owner` is who can actually clear it**, which is the column that
decides whether the custodian may touch it at all.

#### No signal — the work was never asked for

| class | owner | self-heals | today |
|---|---|---|---|
| `webhook_silent` — App unsubscribed, endpoint auto-disabled after 5xx, secret rotated | machinery | yes | partially, `driftBeacon` |
| `no_clones_registered` / `no_installed_modules` | person | no | counted as `webhook.skipped`, 1,553 times |
| `event_never_created` — prime moved, control plane was down | machinery | yes, beacon | yes |
| `rows_never_armed` — creation race | machinery | yes | yes, `armGrace` |

#### The event exists and never runs

| class | owner | self-heals | today |
|---|---|---|---|
| `attempts_exhausted` | machinery | **yes, conditionally** — §5 | **no**, terminal for ever (39 rows) |
| `rate_limited` | machinery | yes | yes, `rateLimitDeferral` |
| `budget_starved` | machinery | yes | yes, `githubBudget` |
| `deferral_clock_wrong` — `next_attempt_at` far future | machinery | yes | capped at 65 min, never re-checked |
| `stuck_running` past reclaim | machinery | yes | yes, stall reclaim |
| `approval_pending` — gate unapproved, nobody notified | **person** | no | notification only |
| `partial_clone_dropped` — event settled, one clone failed | machinery | **yes** — §5 | **no** (15 events) |

#### The pass runs and cannot finish

| class | owner | self-heals | today |
|---|---|---|---|
| `invocation_cut` — pass larger than one tick | machinery | yes | yes, pass ledger |
| `policy_unseeded` — mirror with no exclusions | machinery | **yes — seed it** | refuses, correctly, for ever |
| `tree_truncated` | machinery | yes | refuses |
| `oversize_file` | **person** | no | held + named |
| `backend_identity_hold` | **person** | no | held + named |
| `bulk_deletion_over_cap` | **person** | no | held, `cascade_path_approvals` |

#### A proposal exists and never merges

| class | owner | self-heals | today |
|---|---|---|---|
| **`ci_red`** | **prime author** | **NEVER** | gate refuses — correct |
| `ci_never_started` — Actions minutes | account owner | no | yes, `never_started` verdict |
| `conflict` | machinery | yes | repair, then resolve |
| `conflict_cap_spent` | machinery → person | partially | stops at `MAX_REPAIRS` |
| `held_file_reconcile` | **person** | no | named in PR |
| `proposal_closed_by_human` | person | no | `skipped`, correct |
| `drain_starvation` | machinery | yes | yes, rotation cursor |

#### Merged, and not recorded or not running

| class | owner | self-heals | today |
|---|---|---|---|
| `pointer_not_advanced` | machinery | yes | yes, `choosePointerAdvance` |
| **`repo_retargeted`** — rows name the old owner | machinery | **yes** | **no — §1.4, 43 rows, 21 days** |
| `clone_repo_unreachable` — App removed, repo deleted | **person** | no | `foreignRepo`, silent |
| `redeploy_not_requested` | machinery | yes | yes, on `succeeded` |
| `mission_control_unpublished` | **person** | no | prose only |

#### And the one that matters most

| class | owner | self-heals | today |
|---|---|---|---|
| `unclassified` | **person** | **no** | — |

**An unrecognised failure is a blockage owned by a person.** It is not
`unknown`, not silent, and never self-healed. That is what makes the table
above safe to be incomplete: the next freeze takes a path nobody has walked,
lands in `unclassified`, and is loud on the SLO like everything else. The
taxonomy does not have to be exhaustive to be sound — it has to fail in the
right direction.

### 4.2 The escalation rule that revives the channel

- **Success never notifies.** `cascade_completed` (693 unread) and
  `deployment_live` (250) become rows on a card. A notification is for
  something that needs a person; if it needs nobody, it is a log.
- **A blockage notifies once**, at the SLO, per fingerprint — not when it
  occurs. A machinery fault that clears inside its window was never news.
- **A clearance is recorded and not announced** — `decideDriftReport`'s rule,
  generalised, which is what keeps a gap that came *back* audible.
- **`drift_high` is retired** and replaced by `stalled` from §3.

Projected: 130–270 a day → under five. Every one of them a thing a person can
do something about.

---

## 5 · Mechanism three — the Custodian

`hooks/cascade-custodian`, every fifteen minutes, after the auditor.

> **The custodian may re-run work. It may never change a verdict.**

That single line is what reconciles "perpetually in sync" with "must not
compromise on genuine breakages", and every permission below is a
consequence of it.

### What it may do — machinery classes only

| act | bound |
|---|---|
| revive an `attempts_exhausted` event whose cause is demonstrably gone (window reset, budget restored, the fixing deploy propagated) | per-SHA revival counter, max 3/day/clone, audit row per act |
| re-queue a `partial` event's failed clones | as a **new** scoped event, never by reviving a terminal row |
| seed a missing exclusion policy | `seedSyncExclusions`, idempotent, additive, never overwrites |
| retarget stale `pr_url` rows after a repo move | from `clones.repo_full_name`, read back before writing |
| request a redeploy for a merged-but-unbuilt clone | once per merged SHA |
| re-arm a deferral whose `next_attempt_at` is past and whose event nothing claimed | once per event per hour |
| re-drain `pr_opened` rows older than the SLO | the existing reconciler, aimed at the backlog rather than the head |

### What it may never do

- merge anything the gate refused, for any reason, including `ci_red`
- lift, narrow or ignore a `protected` exclusion
- grant an `overwrite` or `bulk_deletion` approval, or read one it wrote
- widen `MAX_DELETIONS_PER_CASCADE`, `MAX_REPAIRS`, `CASCADE_MAX_FILE_BYTES`
  or any cap
- write a `delete` verdict without prime's own history vouching for the blob
- touch a branch carrying a commit the engine did not author
- clear a blockage owned by a **person**

A test asserts the permission list by class, so a future act added to the
custodian must declare which side of the line it is on.

### The revival condition, stated precisely

An `attempts_exhausted` event is revived only when **all** hold:

1. its failure class is machinery (never `ci_red`, never a held file, never an
   approval)
2. the condition it failed on is observably gone — the rate-limit window has
   reset, the budget is above the floor, or a deploy has landed *and
   propagated* since the last attempt (fifteen minutes past `deploy_project`,
   per the change-window rule, because the 10:45 revival of 16 September ran
   the old build and failed three times on the error its own fix removed)
3. fewer than three revivals for this prime SHA and clone today
4. the auditor still reports the clone `stalled` — a revival for work that is
   no longer owed is a cascade nobody asked for

An act that cannot satisfy (2) does not guess. It writes the blockage and lets
the SLO speak.

---

## 6 · What must never be healed

The tension the owner named — *"this must not compromise on genuine
breakages"* — is resolved by where the line is drawn, so it is worth stating
the line from the other side.

**`ci_red` is the load-bearing case.** A cascade proposal going red because
prime shipped a broken test is the system working. The clone's CI is the
gate — that is the stated reason `pr` mode exists. The custodian does not
retry it, does not rebuild the branch hoping for a different answer, and does
not merge it. What changes is only this: today a red proposal and a proposal
waiting on a runner produce the same silence, and after this a red proposal
crossing the SLO raises one blockage owned by the author of the prime commit,
naming the check and the head it failed on.

**Louder, not looser.** Every mechanism here either makes a refusal *visible*
or re-runs something that was never a decision. None of them relaxes a
refusal. If the fleet is stuck because the code is broken, this design makes
that fact arrive within ninety minutes with a name on it — which is the
opposite of papering over it, and is the actual remedy for the September
freeze, where *every individual signal was correct and none of them was loud*.

---

## 7 · The four live faults this closes

Each is open right now, each is silent, and none is anybody's code:

1. **43 rows naming `lavan96/npc-client-dashboard`** — 21 days unreconcilable.
   Closed by `repo_retargeted` + the custodian's retarget.
2. **1,253 `drift_high` on a working pipeline.** Closed by the derivative in
   §3 — the alert is deleted, not tuned.
3. **`clone_health_snapshots`, 3 rows, dead since 1 Sep.** Either the
   auditor's table or it goes; a health surface nobody writes is a promise of
   a reading that does not exist.
4. **22 failed results on Preflight that nothing accumulates.** Closed by the
   per-clone ledger — consecutive failure becomes a standing condition rather
   than a sequence of independent events.

---

## 8 · Implementation order

The order is the safety property, as it was for seed-then-scope.

| # | ships | why here |
|---|---|---|
| 1 · **shipped** | `convergence.pure.ts` + the audit hook, **writing only** | a reading nobody acts on yet, so a wrong reading costs nothing. Run it beside the existing signals for a week and compare. |
| 2 | `clone_sync_blockages` + classification, **no notifications** | populate the ledger from real passes; verify the taxonomy catches what actually happens before it is allowed to speak |
| 3 | retire `drift_high`; `stalled` becomes the only sync alert | only once §1 has proved itself, or the fleet trades a false alarm for a missing one |
| 4 | success notifications become card rows | independent of the rest; recovers 943 of the 2,459 immediately |
| 5 | custodian, **read-only `dryRun` first**, reporting what it would heal | the dry-run boundary rule, applied to the healer |
| 6 | custodian writes, one act at a time, retarget first | retarget is the safest — it repairs a URL, touches no repository |
| 7 | `CONVERGENCE_SLO_MINUTES` into `prime_config`; the health card reads the auditor | the surface last, because a card is a claim that the reading under it is true |

Steps 1, 2 and 5 write nothing anyone acts on, which is what makes this
shippable against a live fleet without a window.

---

### Step 1, measured before it ran

The auditor was run against the two live trees — `git ls-tree` on prime's and
each clone's `origin/main`, through the shipped module — before it had ever
run in production. It found a defect in itself:

```
compared 8,463 · owed 2 · held 17
  supabase/migrations/…_seed_template_library_v13_cash_flow_foots.sql   41,671,969 B
  supabase/migrations/…_seed_template_library_v14_tier_separation.sql   41,678,125 B
```

Both are about **41.7 MB against `CASCADE_MAX_FILE_BYTES`'s 8 MB.** The engine
holds them on every pass, for ever, and correctly — a cascade carries a file
whole and the invocation that does it has a limit the file does not. Reported
as owed they would have read `delivering` for ninety minutes and then escalated
as `stalled`, permanently, on a fleet behaving exactly as designed.

That is `drift_high` in a new costume, and it would have discredited this
reading the same way. **The rule it bought generalises past the constant: the
auditor must refuse exactly what the engine refuses, or it reports debt on
files that will never be delivered.** The ceiling is imported rather than
restated, `listTreeEntries` now carries every blob's size (the tree response
already had it, at no extra call), and an absent size reads as deliverable —
reporting a real gap is recoverable, concealing one is the failure this exists
to stop.

The corrected reading, against all three clones:

| clone | compared | owed | held | oversize | deletion candidates | state |
|---|---|---|---|---|---|---|
| NPC Client Dashboard | 8,463 | **0** | 17 | 2 | 14 | `converged` |
| NPC Test | 8,463 | **0** | 7 | 2 | 2 | `converged` |
| Preflight Property Group | 8,463 | **0** | 7 | 2 | 2 | `converged` |

It agrees with `sync_status: in_sync` — and now for a reason derived from the
repositories rather than inherited from the ledger that was being checked.

**One class is still open.** `backendIdentityHold` refuses on CONTENT, which a
tree read cannot settle, so a path it holds would read as owed. There is no
live instance today, and the escalation that would act on one has not shipped;
the cheap answer when it does is for the engine to record its content holds
where the auditor can read them, rather than for the auditor to fetch blobs.

## 9 · What this does not address

Named rather than implied, because a gap somebody has written down is a
different thing from one nobody has.

- **Mission Control's own publish** stays a human act with no mechanism. The
  auditor measures clones, not the control plane, and an unpublished Mission
  Control is still a deployment serving an older environment with a green
  `/api/health`. It is the one remaining place where "merged" and "running"
  can differ silently.
- **The clone's own commits** are legitimately its own. The auditor reports
  divergence on paths the cascade would write; it says nothing about a clone's
  private work, and it must not.
- **A module-scoped clone is not measured.** Its section of prime is resolved
  by the engine from `clone_modules`, the module library's `file_globs`, any
  version pin overriding them, and the repository invariants added on top.
  Re-deriving that inside the auditor would be a second implementation of
  "what this clone's section is" — which is precisely the disagreement the
  auditor exists to detect, reintroduced inside the auditor. So it reads
  `unknown` with that reason, visibly, and the tick body counts it. Every
  clone on this fleet is a mirror as of `20260909110000`; when one needs
  measuring, the move is to extract the engine's resolver into a shared
  function, not to approximate it here.
- **A `protected` path drifting** is invisible here by design — it is excluded
  from the partition, which is the point of it. `held-file-drift` covers the
  `manual_reconcile` half; `protected` is deliberately nobody's to reconcile.
