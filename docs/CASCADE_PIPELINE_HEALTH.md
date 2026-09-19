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

### 1.3 A thirty-day SLO computed from one sample

This was first written up as a dead surface — *"three rows, last written
1 September, nothing writes it"* — and that was wrong. The correction is worth
more than the original claim.

`clone_health_snapshots` is alive. `warm-clone-health-snapshots` runs every
five minutes and last wrote at **14:30:31 on 18 Sep 2026**. Its three rows are
three clones, because `clone_health_snapshots_clone_id_key` is UNIQUE on
`clone_id`: it is a **five-minute cache holding exactly one row per clone**.
The "last written 1 September" was its `created_at`, which an upsert does not
move — a misreading of the wrong column, which is this platform's most
frequent defect committed by the person cataloguing it.

**What is wrong is what reads it.** `computeFleetSlo` takes a `windowDays`
(1–90, default 30), selects every snapshot inside that window, and computes
`up / total` per clone. With one row per clone `total` is always 1, so the
window parameter changes nothing at all: a one-day and a ninety-day SLO return
the same number.

`CloneHealthTimeline` is the same shape: its own header calls it a *"30-day
uptime/probe sparkline"*, and a UNIQUE constraint means it can never hold more
than one bucket.

**And the second correction is worth more than the first.** This was written
up as "0% or 100% from a single probe", and building step 8 found that it can
only ever be **0%**. Both readers resolve a clone's status as
`payload.status ?? payload.health`, and `CloneHealth` has carried **neither
key since the day it was written** — the status is at `payload.uptime.status`.
Measured against production on 18 Sep 2026:

| clone | real status | what the reader sees | counted |
|---|---|---|---|
| NPC Client Dashboard | `up` · HTTP 200 · 43 ms | `unknown` | miss |
| NPC Test | `up` · HTTP 200 · 41 ms | `unknown` | miss |
| Preflight Property Group | `up` · HTTP 200 · 50 ms | `unknown` | miss |

So the page draws **0.00% fleet uptime, in destructive red, on a fleet where
every clone is answering in under fifty milliseconds** — and has done since the
surface shipped. That is §1.2's defect exactly: an alarm that fires on the
normal operating state of a working system, in a place nobody had looked.

A third one sits behind it. `unknown` went into the denominator, so a clone
with **no deployment to ping** — which the health card beside it correctly
draws grey, because *"a red pip is worse than a grey one"* — reads 0% uptime
rather than "not measured". That is `rentalEvidence`'s rule, which this fleet
has now paid for on rents, on Places lookups and on builder rankings:
**absent is never zero**, and it leaves BOTH sides of the fraction.

The remedy is not to delete anything. **A cache and a history are different
tables, and an SLO needs the second one** — and **an SLO reads a column, never
a payload.**

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
3. **A thirty-day SLO computed from one sample.** `computeFleetSlo` and
   `CloneHealthTimeline` both read a table with a UNIQUE constraint on
   `clone_id`, so the window they ask for cannot change their answer. Not
   closed by anything here: a cache and a history are different tables, and
   it is named in §8 as its own step.
4. **22 failed results on Preflight that nothing accumulates.** Closed by the
   per-clone ledger — consecutive failure becomes a standing condition rather
   than a sequence of independent events.

---

## 8 · Implementation order

The order is the safety property, as it was for seed-then-scope.

| # | ships | why here |
|---|---|---|
| 1 · **shipped** | `convergence.pure.ts` + the audit hook, **writing only** | a reading nobody acts on yet, so a wrong reading costs nothing. Run it beside the existing signals for a week and compare. |
| 2 · **shipped** | `clone_sync_blockages` + classification, **no notifications** | populate the ledger from real passes; verify the taxonomy catches what actually happens before it is allowed to speak |
| 3 | retire `drift_high`; `stalled` becomes the only sync alert | only once §1 has proved itself, or the fleet trades a false alarm for a missing one |
| 4 · **shipped** | the inbox carries only what needs a person | independent of the rest; takes 983 of the 2,459 out of the count with no row stamped or deleted |
| 5 · **shipped** | custodian, the whole catalogue **reporting** and one act switched on | the dry-run boundary rule, applied to the healer |
| 6 · **shipped** | custodian writes, one act at a time, retarget first | retarget is the safest — it repairs a URL, touches no repository |
| 7 · **shipped** | the health card reads the auditor | the surface last, because a card is a claim that the reading under it is true. `CONVERGENCE_SLO_MINUTES` shipped with step 1 |
| 8 · **shipped** | give `clone_health_snapshots` a history beside its cache, so `computeFleetSlo` measures the window it is asked for | independent of everything above; §1.3 |

Steps 1, 2 and 5 write nothing anyone acts on, which is what makes this
shippable against a live fleet without a window. Steps 5 and 6 shipped
together as one deployment (see below), so the custodian's one enabled act is
live; every other act reports and writes nothing.

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

### Step 2, measured against the live ledger

The classifier was run against the fleet's real facts — the clone records, the
exclusion counts, every `pr_opened` row and the auditor's own verdict — as they
stood on 18 Sep 2026:

```
NPC Client Dashboard   repo_retargeted · machinery · self-heals · since 2026-08-26
                       "43 proposal record(s) name lavan96/npc-client-dashboard,
                        which is not this clone's repository. No reconcile can
                        reach them, so they stay open for ever."
NPC Test               (nothing)
Preflight Property Group (nothing)
```

**One finding across the whole fleet**, dated to the day the condition actually
began rather than the day it was noticed, against a notification channel
carrying 2,459 unread rows. That ratio is the design's whole claim.

It also settled a rule that was not obvious in the abstract. Most classes
describe a DELIVERY that went wrong, and a commit cascade delivers prime's head
at run time — so a later pass supersedes a failed one entirely, and a retired
event is history the moment the auditor reports `converged`. Preflight carries
22 failed rows in the last 45 days and is owed nothing; reporting those would
have filled the ledger with exactly the kind of noise this replaces. So
`conditionedOnDivergence` is a field on the policy table, and the three classes
that are **not** conditioned are the standing faults — `policy_unseeded`,
`repo_retargeted`, `unreconciled_proposal` — which are wrong right now whatever
today's convergence says, and will be wrong for the next cascade too.

The other rule worth stating: a proposal recorded against the wrong repository
reports as `repo_retargeted` and **not** additionally as `unreconciled_proposal`.
One row, one blockage, the specific one — the remedies differ, and two findings
about one row is how a list of open problems doubles in length without gaining
information.

### Step 4, and the trap it had to avoid

The design said *"success notifications become card rows"*. The card already
exists: `CloneActivityHistory` **reads the `notifications` table** as a clone's
activity feed. So suppressing the write would have deleted the history along
with the noise — *removing a notice must never remove a control*, found by
looking before cutting rather than after.

So nothing stopped being written and nothing was deleted. **The split is at the
reader**: the record keeps everything, the inbox carries only what needs a
person. Measured on the live database:

| | rows |
|---|---|
| unread before | 2,459 |
| now filed as record (still written, still on the activity feed) | **983** |
| remaining in the inbox | 1,476 |
| of which `drift_high`, which step 3 retires | 1,253 |
| inbox after steps 3 and 4 together | **≈223** |

That also means the existing backlog stops being counted the moment this lands
— no bulk `read_at` stamp, no migration touching a single row, because the
filter is keyed on kind.

Three rules. **Unknown means inbox** — `isInboxKind` asks whether a kind is on
the RECORD list, so a kind added next year appears in the inbox until somebody
deliberately decides otherwise; under-notifying is the worse error. **The query
is a negation, and that is the point** — `Constants` is generated by hand and
goes stale, so an `IN` filter over an enumerated inbox list would silently drop
a newly added kind OUT of the inbox, which is this module's own failure mode
arriving through the query; `NOT IN` cannot do that. And **disposition is not a
preference** — `notification_preferences` is a per-person mute over toasts,
while this is a product decision about what the inbox is for, and one
implementing the other is how a product decision comes to look like somebody's
setting.

Two things the diff review caught. An explicitly chosen kind outranks the
scope, because an operator who picks "Cascade completed" has asked for records
and an empty list would read as a broken page. And the default scope **counts
as a filter**, because the bulk-mark confirmation promises "matching the
current filters" — a default that did not count would have made that promise
false on the one control on that page that writes.

### Steps 5 and 6, and the second-order consequence they had to clear

The custodian ships with **every class in the catalogue and one act switched
on**. `enabled` is deliberately a different field from `permitted`: five acts
are entirely within its authority and report `would_perform` without writing,
because an act nobody has watched run is not one to trust. That is step 5 and
step 6 in one shape rather than two deployments.

The catalogue has **three** states, not two, and the third is the one worth
recording. A machinery blockage is not automatically the custodian's:
`event_stuck_running` belongs to the drain's stall reclaim and `invocation_cut`
to the pass ledger, both of which already run. Building a second actor for
either is how two things repairing one condition come to disagree, so they are
`owned_elsewhere`, naming who. `consecutive_failures` is a third kind —
a symptom, never a cause — and acting on it would be acting on the thermometer.

**The enabled act is the retarget**, and it was chosen because it is the
safest write this design can make: it rewrites one column from a value already
in the clone's own record, touches no repository, and **settles nothing** — it
hands the rows back to the merge drain's reconciler rather than deciding their
outcome itself.

Measured before it runs. The repository was **transferred** — same name, new
owner — which GitHub performs without renumbering: pull request 27 under
`Naidu-Group-Pty-Ltd/npc-client-dashboard` is still the cascade this platform
opened, merged 26 August, and 42 is the single proposal that 31 of the 43 rows
all track. All 43 repoint across 12 distinct proposals, and #27, #40, #42 and
#44 were each confirmed present under the new owner.

The rule that keeps it a repair rather than a guess: **only the OWNER may
differ.** A transfer keeps the name and the numbering; a rename does not, and
neither does an unrelated repository in the same account — so a differing name
refuses, because pointing a record at a number inside a different repository
would replace a wrong record with a more convincing one. The number itself is
never touched, because a pull request number is the identity of a proposal.

**The second-order consequence, checked rather than assumed.** Repairing those
43 rows hands them to the reconciler, which will settle them `succeeded` —
and `advanceClone` derives `last_synced_sha` from succeeded rows. Settling 43
*August* rows could in principle walk the fleet's sync pointer three weeks
backwards. It cannot: `choosePointerAdvance` sorts newest-event-first and takes
one, and its first branch reads only rows carrying a `delivered_sha` — a column
that did not exist until 16 September, so every August row falls to the legacy
branch that only runs when no row has one. Verified by reading the rule, not by
hoping.

Three more rules carry the writes. **The permission is asked before anything is
read**, so a `ci_red` costs nothing and can never be halfway acted on. **It
reads back before it writes** — one `pulls.get` per distinct proposal, and a
number that does not answer is left exactly as it was, because a wrong record
is better than a confidently wrong one. And **it never clears its own
blockage**: the ledger's next pass observes whether the condition is gone,
because a custodian that closed what it had just repaired would make a repair
that did not work look exactly like one that did.

Every act it takes, would take or refuses lands in `clone_custodial_acts` with
`reversal` — the rows it changed and the value each held before — so undoing it
is reading a row rather than reconstructing an intention.

### Step 7, and the layering rule the build taught it

The reading goes **inside the sync card**, directly under the pointer, and that
placement is the whole argument. `CloneSyncStatusCard` draws
`sync_status`/`commits_behind` — the answer the ENGINE wrote, at the end of the
chain this document opens by distrusting. The measurement goes in the same
card because a separate one would let an operator read the green pill and never
scroll to the reading that contradicts it, and **the contradiction is the
finding**: it is the shape the 84-commit lie took.

Only the DIRECTION is compared. `commits_behind` counts commits and `owed`
counts paths; one commit can touch two hundred files and two hundred commits
can touch one. Comparing magnitudes would manufacture a contradiction out of
two correct readings, so `compareToLedger` answers `ledger_optimistic` (the
pointer says level, the trees do not — the one that matters),
`ledger_pessimistic` (ordinary and benign: a delivery has landed and the
pointer has not caught up) or `agree`, and never a number.

Four things the card will not do. **It never draws an absent reading as a
converged one** — `never_measured` is its own state, and every clone reads it
until the audit's first pass. **It never draws a failed read as an absent
one**: the panel reads through a server function precisely because RLS FILTERS
rather than erroring, so a browser read would return `[]` with HTTP 200 and be
indistinguishable from a table with nothing in it — the trap three surfaces in
this fleet have now hit. **It never alarms on `unknown`**, because "we could
not check" is not "you have a problem". And **a stale reading keeps its state
rather than being withheld**: `READING_STALE_AFTER_MINUTES` is three of the
audit's own cadence, read out of the cron in its own migration by a test, and
an old reading is labelled as old rather than hidden — hiding it would leave
the card silent at the exact moment the audit has stopped running.

A `stalled` badge with nothing under it is a dead end, so the panel also lists
the clone's open blockages in the taxonomy's own prose, with `owner` rendered
as *what it means* ("clears itself", "needs a change in prime") rather than as
the enum. A blockage read that FAILED lists nothing and says so, because
"nothing is blocking this clone" is a claim a read that did not happen cannot
make.

**And the build refused the first version**, which is the lesson worth keeping.
`src/server/**` is denied to the client environment: a component that may
import a server module may import its dependencies, which is how a database
client ends up in a browser bundle. The label tables therefore live in
`src/lib/convergenceLabels.ts` and the judgement stays beside the audit, with
two type-only shims (`*.types.ts`) as the one specifier a client may name. A
contract test now states the rule directly — a client component may name a
server TYPE and may call a `createServerFn`, and may import no other server
value — because a bundler noticing at the end of a build is not the same as a
rule anybody can read.

### Step 8, and the reading that could only ever be zero

§1.3 above carries the measurement. Three defects, each sufficient on its own,
all live on a healthy fleet:

1. **Both readers resolved a status from a key no payload has ever had.** The
   SLO page drew **0.00% in destructive red** while every clone answered HTTP
   200 in under fifty milliseconds.
2. **There was no series to compute a window over.** `windowDays` spans 1–90
   and could not change the answer.
3. **`unknown` was counted as down**, so a clone with no deployment to ping
   read 0% rather than "not measured".

The remedy keeps the cache exactly as it is — it is a correct five-minute
cache and `readCachedCloneHealth` depends on its one-row-per-clone key — and
adds `clone_health_history` beside it, append-only, one row per probe, with the
reading in **columns**. That is the load-bearing part: **an SLO reads a column,
never a payload**, so the only module that can misread the payload's shape is
the one that defines its type. A contract test asserts no source file anywhere
resolves a status out of a payload again, and that exactly one module performs
the extraction.

The aggregate is the **database's**. Three clones probed every five minutes is
78,000 rows over the widest window this page offers and 1.3 million at fifty
clones; counting those in a function is a mistake that only surfaces once the
fleet has grown. `clone_health_daily` is a regular view rather than a
materialized one, deliberately — a materialized view needs a refresh, a
refresh needs a schedule, and this platform's own record is six pg_cron jobs
that were never scheduled at all, silently. `security_invoker = on` is
load-bearing for the same reason a view is not a way around RLS.

**The series is the scheduled cadence and nothing else**, which a review of
the diff found rather than the design. Three callers of `getCloneHealth` probe
on demand — the health card's Refresh, the `/health` dashboard, a forced fleet
walk — and those are taken at moments a PERSON chose, which in practice means
when somebody already suspected a problem. Folding them in would make "99.9%
over thirty days" depend on how worried people were that month, and there is
no way to read such a number back out afterwards. So `recordSample` defaults
to false, exactly one caller sets it, and `clone_health_history` grants SELECT
and no INSERT — the only writer is the service role, which makes the cadence
an access control rather than a convention.

Three more rules. **A window asked for is not a window measured** — the
history starts empty, so for its first weeks a "30-day uptime" is a few hours
of probes wearing a thirty-day label; coverage travels with the answer and the
page states the span it actually saw. **A day that measured nothing draws a
gap, not a floor** (`connectNulls={false}`), and a clone nothing measured sorts
BELOW every real reading, because an absence is not the worst clone in the
fleet. And **the prune rides a job already proven to run** — the five-minute
health pass — rather than becoming a seventh unscheduled cron.

Two things were closed in passing, both of the same family this document is
about. `getCloneHealthHistory` had **zero call sites** and could not have been
useful if it had one: it read sixty rows deep from a table holding one row per
clone. It has a caller now — `CloneHealthTimeline`, which used to query that
cache **from the browser** and `return null` on an empty result, drawing the
identical nothing for a clone with no probes, a clone whose read RLS had
filtered, and a clone the card was never meant to draw for. And
`getFleetMetrics` fetched 500 health rows on every dashboard load, destructured
them and read them nowhere.

---

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
