# The carrier that absorbed nine prime commits and could deliver none of them

On 21 September 2026 the fleet was reported stuck: *"all clones are stuck in
cascading. None are syncing."* It was, and it had been since **18:00 UTC the
previous evening** — nine prime commits and a little over nine hours, with
every component of the cascade reporting normal operation.

This is what it was. The judgement that closes it is
[`carrierRefresh.pure.ts`](../src/server/cascade/carrierRefresh.pure.ts); this
document is the evidence and the two things it does not fix.

---

## What was observed

Measured from GitHub on 21 Sep 2026 (Mission Control's own database sits on
Lovable Cloud and is not reachable from a Supabase management token, so every
figure below is read off the repositories rather than the ledger):

| clone | receives from | cascade proposal | state |
|---|---|---|---|
| `npc-client-dashboard` | prime | **#228**, opened 18:00:26Z | open, `security` red |
| `npc-crm-independent-6505dc` | prime | **#13**, updated 18:03:23Z | open, `security` + `verify` red |
| `preflight-property-group` | npc-client-dashboard | **none** | — |
| `npc-test-76b3b3` | npc-client-dashboard | **none** | — |

`npc-client-dashboard`'s `main` had merged four cascades that day on a roughly
hourly cadence — `prime@f207ca8` at 09:24, `prime@98c068a` at 10:55,
`prime@7f20e31` at 13:44, `prime@3e6d0f0` at 14:37 — and then nothing. PR #228
carries **exactly one commit**, `chore(aurixa): cascade 74 file(s) from
prime@c4ceeeb`, authored 18:00:26Z. Prime pushed nine further commits and not
one of them touched it.

---

## The three faults, each of which reported as normal operation

### 1. A prime commit whose own CI never went green was cascaded

`c4ceeeb` merged at 17:59:22Z. **Its CI run on prime was `cancelled`**, not
successful — superseded 84 seconds later by the next push. The commit carried
a real defect: `urban-centre-register-ingest/index.ts` ended its catch block
with `return internalError(message, cors)`, which composes a body where a
`Response` is required and passes CORS headers where a log context is
expected. Prime found it immediately and fixed it in `62f42c3`, confirmed
green at `7f9ffc3` at 18:10:43Z.

The cascade had already left at 18:00:26Z. PR #228's `security` job reported
it faithfully:

```
Edge Function type-check: 414 entry points, 327 errors (baseline 334).
Edge Function type-check FAILED — new type errors:
 - supabase/functions/urban-centre-register-ingest/index.ts: 0 → 2
```

So the clone's proposal was red on a defect the prime had repaired ninety
seconds later, and stayed red on it for nine hours.

### 2. Lineage turned one red proposal into a fleet-wide hold — by design

`prime_config.cascade_follows_lineage` was thrown on 20 Sep 2026, and it
works: `preflight-property-group` had already taken a cascade from its
parent's branch (`aurixa/cascade-5e80f26-…`, cut from npc-client-dashboard's
own merge commit at 14:37:01Z).

`resolveCascadeSource` holds a child until its parent's `last_synced_sha`
equals the commit the pass is delivering, and a held event goes back to
`pending` with *"Waiting on lineage until …"*, re-claimed every five minutes.
In `pr` mode that wait is a person's merge, which is exactly what the hold is
for.

Nothing here is wrong. What it means is that the parent's red pull request
became the whole subtree's ceiling — which is the designed reading, and which
the prime's own `CLONE_PROVISIONING_GAPS.md` states in as many words.

### 3. The carrier absorbed every later push and could deliver none of them

This is the defect.

`createCascadeForAllClones` stands a push down whenever an unclaimed pending
commit event already exists, and `eventFold`'s header gives the reason
exactly: *"that event will deliver this push's content anyway, because it
reads prime's head when it runs"*. The new push creates nothing and returns
the carrier's id with `cloneCount: 0`.

That promise covers only clones whose result row is still `queued`.
`executeCascade` reads its work with `.eq("status", "queued")`, so **a clone
the carrier has already finished is never visited by that event again.**

While a carrier always ran to completion the gap could not show: the event
settled, the next push created a fresh one, and a fresh event queues every
clone. Fault 2 gave carriers a reason never to settle, and fault 1 made sure
this one never would.

So from 18:00:26Z:

- the carrier's rows for `npc-client-dashboard` and `npc-crm-independent` were
  terminal, at `prime@c4ceeeb`;
- its rows for the two children stayed `queued` and held, every five minutes,
  for ever;
- and each of prime's nine subsequent commits — including the two that fix the
  very errors making #228 red — stood down into it and reached nobody.

A deadlock, assembled out of three mechanisms that were each behaving as
written.

---

## The rule

**A carrier may only stand a push down if it can still deliver it.**

At claim time, after prime's head is resolved and after the claim fence, a
pending commit carrier re-queues every clone it finished against a head that
is no longer the head it is about to deliver. A clone already finished against
the current head is left untouched.

Three things bound it.

**It fires on prime MOVING, never on the claim.** A pass costs roughly 300
blob reads per clone against the App's hourly budget and a held carrier is
claimed every five minutes, so a refresh keyed on the claim would be precisely
the multiplication `eventFold` was written to stop. Keyed on the head it costs
one pass per prime commit — what the fleet paid before carriers could hold —
and the pass that answers a refresh disarms the next one.

**It never touches a settled event.** `completed_at` means the tally, the
notification and the audit row were written; those rows are history, and
`requeueDroppedClone` already owns re-offering a dropped clone by minting a
new delivery rather than reviving a record. This acts only on a carrier still
in flight, whose rows the engine already expects later passes to re-stamp.

**It never touches a `failed` row, a live row, or a row that delivered
nothing.** A failure is the drain's attempt accounting; a `queued` or
`pushing` row is already this pass's work; and a skip with no `delivered_sha`
decided about no content at all — a clone that was not found, a pin that
failed validation — so re-offering one re-runs a refusal.

A read or a write that fails refreshes nothing and says so. The pass then
behaves exactly as it does today and the next claim asks again; failing the
event instead would retire a carrier over a transient fault and strand every
clone behind it, which is the outage this closes.

---

## The remedy that needs no deploy

The stand-down in `createCascadeForAllClones` is inside
`if (trigger === "commit" && sourceSha)`, and `decideEventFold` never folds a
`manual` event — *"an operator's explicit act — a re-run after fixing an
exclusion"*. So **firing a manual cascade from Mission Control breaks the
deadlock today**, on the code that is deployed: it creates a fresh event with
a `queued` row for every clone, the pass reads prime's current head, and both
standing proposals are updated in place from it.

That is the operator's lever, and it existed throughout. What it was missing
is anything saying it was needed — which is the half of this incident that
nobody could see from a screen.

---

## What this does not fix

**`npc-crm-independent-6505dc` is red on its own `main`, and was before the
cascade arrived.** CI run 47 on `c2e76a01` — the base PR #13 was cut from —
failed at 16:54Z, and run 43 failed before it. The failure is
`scoringMethodology.spec.ts` asserting that
`docs/reports/SCORING_V2_METHODOLOGY.md` states the version its modules
declare; the clone holds the spec and the modules, and the document is not in
its scope (*"installed modules + 13 repository invariant(s)"*, 57 files). That
is the class this clone's own `CLAUDE.md` already names — **a spec and its
subject travel together or neither does** — and it needs a person to decide
whether the document joins that clone's scope or the orphaned spec leaves it.
Until then `auto_merge` will correctly refuse to land anything there. It
blocks no other clone: `npc-crm-independent` has no children.

Its `security` failure is separate and is the cascade's:
`docs/security/SECURITY_INVENTORY.json` travelled onto a clone whose function
set differs from prime's. `securityInventoryHold` was written for exactly that
and merged on 20 Sep at 12:32Z; whether it took effect on the 18:00 pass is
not established here, and the next re-cut proposal is the measurement.

**Strict-equality lineage converges only in prime's quiet windows.** A child
is released when its parent's `last_synced_sha` equals the head the pass
delivers, and the parent's pointer only advances when its proposal MERGES. So
a child is held whenever its parent has an open proposal, and catches up in
the gap between a parent's merge and prime's next commit. Those gaps are
routine — prime's own cadence on 20 Sep ran one to three hours between
pushes — but they are not guaranteed, and a sustained burst can starve a
grandchild.

The honest alternative is to deliver what the parent actually carries and
stamp the row with THAT sha rather than the event's head: `delivered_sha` is
per-row precisely so a row can say what it delivered, so the ledger would not
lie and a child would converge one commit behind its parent instead of
waiting. That is a second behavioural change to the same subsystem, and
shipping it beside this one would make it impossible to tell which repaired
the fleet. It is recorded here rather than guessed at.

---

## What was asserted

`carrierRefresh.test.ts` (15) and `carrierRefresh.server.test.ts` (6) cover
the judgement and its two database faults, with the 20 September carrier
itself as a fixture. `carrierRefreshIsWired.contract.test.ts` (9) pins the
wiring as source: that the engine calls it with `sourceSha` and not the
event's provenance, that it acts on the answer, that both summary writers
carry the re-offer, that no downstream reader still reads the pre-refresh set,
and that the call sits after prime's head is read, after the claim fence and
before the pass reads its work. Each of those was proven non-vacuous by
planting the defect it describes and watching it fail.
