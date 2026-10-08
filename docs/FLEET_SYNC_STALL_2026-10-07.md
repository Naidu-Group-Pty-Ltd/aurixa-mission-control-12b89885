# The two parents that held the fleet for a day

On 8 October 2026 the report was that _"the cascade is failing on the two
parent clone branches"_. It was, and it had been since **03:17 UTC the
previous day**. For about 27 hours no clone delivered a prime commit, and every
component of the cascade reported normal operation.

The parents are the two clones that read prime directly:

- `npc-client-dashboard`
- `npc-crm-independent-6505dc`

`preflight-property-group` and `npc-test-76b3b3` read `npc-client-dashboard`,
so `cascade_follows_lineage` holds them until it carries the commit being
delivered. Two stuck parents are therefore four stuck clones, and that part is
the hold working as designed (see
[`FLEET_SYNC_STALL_2026-09-20.md`](./FLEET_SYNC_STALL_2026-09-20.md)).

There were five faults, and **each one alone was enough** to keep the parents
off prime. They are listed in the order they bit. Each is closed in code, and
each module's header carries its own measurement. This document puts them in
one place and names what they do not fix.

---

## What was observed

| when (UTC)        | what                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7 Oct 03:17–03:18 | Every job of `CI` on both parents' cascade heads fails one to three seconds after it is created, with no step run: run 37566131354 on `npc-client-dashboard` (head `bbf2f91`) and 37566080080 on the CRM line. The drain reads the head as `never_started` and holds. |
| 7 Oct 16:53       | Carrier `15d4574f` writes both parent rows `failed`, `npc-client-dashboard` (`e40b1d34`) and `npc-crm-independent` (`282695be`), with an **empty** `error_message`. Their pull requests, #315 and #81, stay open.                                                     |
| 7 Oct → 8 Oct     | Three more prime pushes fold into the carrier. It never settles, because its children are held by lineage and a held event goes back to `pending` every five minutes.                                                                                                 |
| 8 Oct 06:41       | A person re-runs the declined CI by hand.                                                                                                                                                                                                                             |
| 8 Oct 06:58       | A person re-arms the two parent rows by hand.                                                                                                                                                                                                                         |
| 8 Oct             | CRM #81 is now red on its own merits: `verify` fails twice and `security` fails on the edge-function inventory.                                                                                                                                                       |

---

## The five faults

### 1. Checks GitHub never started were never re-run

`decideCascadeMerge` already recognised the shape. When every failed check ended
within seconds of starting, that is how GitHub declines jobs on a private
repository once the organisation's Actions minutes or spending limit are spent.
The verdict named the remedy: _fix the limit, then re-run the checks_.

Nothing in the platform re-ran them. Fixing the limit starts no job that GitHub
has already declined. So the parents stayed held after billing recovered, until
a person found them 27 hours later.

**Closed by** [`neverStartedRerun.pure.ts`](../src/server/cascade/neverStartedRerun.pure.ts),
which the merge drain calls:

- **Only a `never_started` head is re-run.** One check that ran and failed makes
  the verdict `failing`, and that head is never re-run in the hope of a
  different answer.
- **The re-run is the probe.** Billing cannot be read with a repository-scoped
  App, and a re-run declined while the limit stands costs no minutes.
- **The windows grow:** 15 minutes, then 1 hour, 4 hours and 12 hours, each
  counted from the newest decline. A run still queued is therefore never re-run.
- **The count is GitHub's own, per head:** the runs of a declined check, less
  one, read with `filter: "all"`. Nothing is stored, and the next cascade push
  starts again.
- **Only failed jobs** of GitHub Actions runs are re-run
  (`reRunWorkflowFailedJobs`). The run is read from the check's `details_url`.

### 2. A failed row on a carrier that had not settled was visited by nothing

`executeCascade` reads only `queued` rows, so the event never visited a failed
row again. Two other paths could have revisited it, and neither did:

- `requeueDroppedClone` acts on a **settled** partial event.
- `planCarrierRefresh` refused every failed row.

A carrier whose children are held by lineage never settles, so the two parent
rows stayed failed. Every child stayed held behind them until a person re-armed
the rows.

**Closed in** [`carrierRefresh.pure.ts`](../src/server/cascade/carrierRefresh.pure.ts):

- A failed row on a mid-flight carrier is re-offered, **once per prime head**.
- Every place the engine writes a failed row composes its message through
  `stampFailedAgainst`, which leads it with `Failed against prime@<sha>`.
- A row that failed against the head about to be delivered is left alone. A
  deterministic failure therefore costs one attempt per prime commit, never one
  per five-minute tick.

The same patch (`settledRowPatch`) clears the note an earlier pass left on a
row that later delivers. On 8 Oct, 133 `succeeded` rows still read "Parent NPC
Client Dashboard carries prime@…", and 14 still read "Deferred until …".

### 3. A GitHub server error failed a row, with no words at all

Octokit builds a `RequestError`'s message from the response body:

- A 5xx served with an empty body becomes the empty string.
- One served as an HTML page becomes the whole page.

The engine kept `e.message` and nothing else. Both parent rows on `15d4574f`
therefore record a failure with no status, no route and no text. What GitHub
said that afternoon cannot be recovered now.

**Closed by** [`githubServerError.pure.ts`](../src/server/cascade/githubServerError.pure.ts):

- **Any failure names its status and its route.** The query string is never
  named, because it can carry a token. A 4xx that said something keeps its own
  words, because readers such as `isInvocationCut` match on them.
- **A 500, 502, 503 or 504 is retried** at 2, 8 and 30 minutes against the same
  prime head, and only then failed.
- **The count lives on the row.** The drain refunds a deferral's attempt, so
  nothing at the event level bounds the retries.
- **The prime read is counted against the branch on the event,** because it
  comes before any head is known.

### 4. The reconcile reason grew without bound

The strip in `prReconcile` found the end of the open reason at its first full
stop. `base_broken` and `never_started` are each three sentences long, so every
pass left two sentences behind as "detail" and put a new outcome in front of
them.

On 8 Oct, 162 merged rows carried 3.97 million characters between them. The
worst was 46,422 characters: the same remedy 279 times, in front of a one-file
summary.

**Closed in** [`prReconcile.pure.ts`](../src/server/cascade/prReconcile.pure.ts):

- `openSentence` writes the open reason as one sentence.
- `durableSummary` recognises this codebase's own trailing sentences, and strips
  to a fixed point. Each row that grew shrinks on its next pass.

The re-run clause from fault 1 rides on that sentence, so it is rewritten on
every pass rather than added to.

### 5. CRM #81 left behind what its own carry required

Once CI ran, `npc-crm-independent-6505dc` was red for three reasons. All three
are the class [the CRM line's CLAUDE.md](https://github.com/Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc/blob/main/CLAUDE.md)
records as "brings the half that makes a claim and leaves behind the half the
claim is about".

| what failed                                            | why it failed                                                                                                                                                                                                                              | how it is closed                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`: `step_up_invalid: expected false to be true` | `regulatedActs.test.ts` reaches `isElevationRefusal` as `import … from "@/lib/secureInvoke"`. That import has no extension, so no membrane rule read it. The spec crossed, and the module it asserts about was held as a CRM head variant. | [`specImportSubjects.pure.ts`](../src/server/cascade/specImportSubjects.pure.ts) makes a spec's `@/` and relative imports subjects of it. They are resolved with the import closure's own resolver. The lateral judge sees them too.                                                                                                                                               |
| `verify`: `mobile:tokens:check`                        | The clone is module-scoped, and `mobile/**` is inside none of its globs. Prime's `tokens.css` arrived, and the `design-tokens.json` generated from it did not.                                                                             | [`generatedArtefacts.pure.ts`](../src/server/cascade/generatedArtefacts.pure.ts): a generated file travels at prime's version **exactly** when every file it is generated from lands at prime's version, the generator script included. The carry loop cannot stop while one is owed. `api-surface.json` is deliberately excluded: `apiSurfaceReconcile` composes the clone's own. |
| `security`: the edge-function inventory                | The clone holds CRM functions prime does not, so the two call graphs differ for good. The baseline reconcile refused whenever they differed, on every pass.                                                                                | [`securityBaselineReconcile.pure.ts`](../src/server/cascade/securityBaselineReconcile.pure.ts) attributes the graph **caller by caller**. A directory entirely prime's gets prime's edges, one entirely the clone's gets the clone's, and a mixed one is carried only where both sides record the same edges. It refuses otherwise, and names the caller.                          |

---

## The rule

**A hold that names its remedy must either perform the remedy itself or be one
a person is told about.** Faults 1 and 2 each named an act: re-run the checks,
re-arm the row. Neither was done by anything, and neither raised anything that
a person would see. The platform now does both itself, within bounds. Each
bound is GitHub's own count or the prime head, never a counter this platform
invents.

**A failure that leaves no words is a failure that cannot be diagnosed.** Fault
3 is not fixed by retrying. It is fixed by recording what was asked and what
was answered, and the retry is a consequence of that record.

---

## The remedy for this incident, and why it does not last

The parents were unstuck by hand on 8 Oct. CRM #81's three reds were then fixed
by reconciling the cascade on the clone, in a pull request into #81's branch.

That fix is overwritten the moment prime moves again. The cascade re-proposes
#81 from scratch, and until this branch is merged and deployed it re-proposes it
with the same three gaps. **The durable fix for the CRM line is deploying the
five changes above.**

**Outcome.** This branch merged as Mission Control #315 and was deployed on
8 Oct. The reconcile into #81's branch (npc-crm-independent-6505dc#82, merged
there as `5b539fb`) took #81 green, and the drain merged it. The drain also
merged npc-client-dashboard#319, npc-test-76b3b3#198 and
preflight-property-group#196, and all four clones read `in_sync` at prime
`040e0ae`. Each later prime push tests the durable fix. The CRM line's pull
request should arrive mergeable with no hand reconcile, apart from a head
variant the push itself changes.

---

## What this does not fix

- **Whether the App may re-run.** `reRunWorkflowFailedJobs` needs the GitHub
  App's `Actions: Read and write` permission. Without it GitHub answers 403,
  `rerunForbidden` recognises it, and the hold says to grant the permission or
  re-run by hand. Whether the App holds the permission today was not verified.
- **Deeper reads that swallow a 5xx.** A few read paths, such as `readBlobShaAt`
  and the spec reads in the membrane, still treat a failed read as an answer.
  They were not changed here, and each should be audited against fault 3's
  rule.
- **`never_started` in the blockage taxonomy.** The drain re-runs these heads,
  but `blockageTaxonomy` does not classify the verdict. A fleet view therefore
  shows such a head as an ordinary red.
- **Stale rows already written.** The 133 stale notes and the oversized reasons
  are corrected on each row's next pass, not by a migration. Rows stranded in
  `pushing` by the outage were not swept.
- **Two Borrowing Capacity files the CRM line does not scope.**
  `SnapshotDownloadButton.tsx` and `live-document/SnapshotDocumentEditor.tsx`
  match no installed module, so a prime change to either never reaches the CRM
  line. They were left out of the scope change below until the owner decides.

---

## The CRM line's scope, decided on 8 Oct

Reconciling #81 found two gaps in the CRM line's module scope. Neither is a
fault in the cascade. A module-scoped clone carries only paths its installed
modules name (`clone_modules` → `modules.file_globs`), plus the repository
invariants and the import closure. A path outside every module is never a
candidate. Module scope lives only in the `modules` table, so both gaps were
closed there rather than in code.

- **`agent-speech`.** The owner decided that the CRM line carries it. The
  `agent` module owns `supabase/functions/agent-speech/**` in both
  `file_globs` and `backend_file_globs`. It also owns `src/lib/agent/useSpeech.ts`
  and `src/lib/agent/__tests__/aurixaVoice.spec.ts`. The function reached the
  CRM line with #81 at prime `040e0ae`.
- **The Borrowing Capacity and Portfolio Analysis Review pages.** These were
  outside every installed module:
  - the two pages;
  - their workspaces (`borrowing-capacity/workspace/**`,
    `clients/portfolio-review/**`);
  - the route helpers (`workspaceRoute.ts`, `portfolioReviewRoute.ts`,
    `invalidateClientQueries.ts`);
  - the page contracts and specs beside them.

  A prime change to any of them never reached the CRM line. The `client`
  module now owns all thirteen paths, taking it from 149 globs to 162. Each was
  identical to prime at `040e0ae` except
  `borrowing-capacity/workspace/__tests__/workspaceText.spec.ts`, which the
  CRM line never received. Its subject is in scope, so the next cascade
  carries the spec beside it. `useUnsavedChangesGuard.ts` was already owned by
  `template-builder` and was not added twice.

---

## What was asserted

- `neverStartedRerun.test.ts` covers four things:
  - the measured head itself is a `never_started` verdict;
  - the windows grow and are counted from the newest decline;
  - the count is exhausted after four re-runs;
  - a 403 for the missing permission is told apart from GitHub's other 403s.

  Source contracts pin the drain to re-run only a `never_started` head, only
  failed jobs, and only after counting with `filter: "all"`.

- `githubServerError.test.ts` covers:
  - an empty-bodied 502 names its status and route;
  - an HTML error page is not printed;
  - the query string never appears;
  - the retry count is per prime head.
- `carrierRefresh.test.ts` covers:
  - a failed row is re-offered once per head and never twice;
  - an unstamped legacy row is owed one attempt;
  - a delivered row's stale note is cleared.
- `prReconcile.test.ts` proves the reason reaches a fixed point when it is
  reconciled twice. It does the same with the re-run clause attached.
- `specImportSubjects`, `generatedArtefacts` and `securityBaselineReconcile`
  are each exercised on #81's own shapes:
  - the `secureInvoke` import;
  - `tokens.css` owing `design-tokens.json`, with a held source owing nothing;
  - the CRM call graph, with `_shared` mixed and equal.
