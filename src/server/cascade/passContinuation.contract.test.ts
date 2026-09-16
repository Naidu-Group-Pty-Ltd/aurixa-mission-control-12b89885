/**
 * A cascade pass that cannot finish is handed back, never lost.
 *
 * Two ways a fleet pass used to die, both measured on 2 Sep 2026 and both
 * reporting as something else:
 *
 *  - GitHub's rate limit (13:19:50, event 844df9e5): every clone `failed`,
 *    the event `failed`, and a failed event is never claimed again — so the
 *    prime commit it carried would have reached no clone without a person
 *    re-arming the row by hand. The limit is a window with a published reset.
 *
 *  - The 60-second window of the hook that drives the drain: a first
 *    module-scope cascade (353 files) beside a mirror clone outran it on every
 *    attempt, the isolate was cut with results at `pushing`, the reclaim
 *    requeued them ten minutes later, and the next claim spent an attempt on
 *    the same read. Three attempts and the event was dead.
 *
 * These read the source, because the property is in the SHAPE of the code —
 * which write happens before which return — and a behavioural test with a
 * fake Octokit would pass while a rearranged engine lost it again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260902134000_cascade_events_next_attempt_at.sql",
  "utf8",
);

function sliceFrom(src: string, anchor: string, length = 20_000): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  return src.slice(at, at + length);
}

describe("the column the pacing rests on", () => {
  it("is NOT NULL with a default, so the claim is one comparison", () => {
    // A nullable column needs `.or("next_attempt_at.is.null,…")`, which is a
    // filter composed as a string — the screening worker's defect.
    expect(migration).toMatch(
      /add column if not exists next_attempt_at timestamptz not null default now\(\)/,
    );
    expect(migration).toMatch(/^-- @asserts column:cascade_events\.next_attempt_at/m);
  });
});

describe("a rate limit on the prime read defers the event", () => {
  // The read that resolves the prime's head sits IN FRONT of the per-clone
  // loop, so it has its own catch and its own classification — the first of
  // the two in the file.
  const classifyAt = engine.indexOf("const failure = classifyGitHubFailure(e);");
  const catchAt = engine.lastIndexOf("} catch (e) {", classifyAt);
  const msgAt = engine.indexOf("const msg = `Cannot read prime", catchAt);
  const block = engine.slice(catchAt, msgAt);

  it("classifies before it composes the failure message", () => {
    expect(classifyAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(-1);
    expect(block).toContain("const failure = classifyGitHubFailure(e);");
  });

  it("hands the event back pending at the reset, and never fails it", () => {
    expect(block).toMatch(
      /status: "pending",\s*worker_started_at: null,\s*next_attempt_at: failure\.until/,
    );
    expect(block).not.toContain('status: "failed"');
    // Through the fenced helper, which throws on a refused write — a held
    // event whose write was refused must not read as held — and answers
    // false when the claim was superseded, in which case nothing more is
    // written and the deferral is not reported as this pass's doing.
    expect(block).toContain("const held = await updateEvent(");
    expect(block).toMatch(/if \(!held\) return \{ ok: false/);
    expect(block).toContain(
      '{ ok: true, status: "deferred", until: failure.until, done: 0, total: 0 }',
    );
  });

  it("still fails the event when the read failed for any other reason", () => {
    const after = engine.slice(msgAt, msgAt + 600);
    expect(after).toContain('status: "failed"');
  });
});

describe("a rate limit defers the event", () => {
  // The catch that owns the per-clone failure: the one that classifies. The
  // loop holds two nested catches before it (redeploy, backend sync), so the
  // anchor is the classification itself and the block is found backwards.
  // `lastIndexOf`, because the prime read above classifies the same way.
  const classifyAt = engine.lastIndexOf("const failure = classifyGitHubFailure(e);");
  const catchAt = engine.lastIndexOf("} catch (e) {", classifyAt);
  const catchBlock = engine.slice(catchAt, catchAt + 3_000);

  it("is classified BEFORE a failure is counted", () => {
    expect(classifyAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(-1);
    const untilClassify = engine.slice(catchAt, classifyAt);
    expect(untilClassify).not.toContain("failed++");
    expect(catchBlock.indexOf("failed++")).toBeGreaterThan(
      catchBlock.indexOf("classifyGitHubFailure(e)"),
    );
  });

  it("puts the clone back to queued with its start cleared, and stops the loop", () => {
    const deferral = catchBlock.slice(0, catchBlock.indexOf("failed++"));
    expect(deferral).toMatch(/status: "queued",\s*started_at: null/);
    expect(deferral).toContain("deferred = { until: failure.until, detail: failure.detail };");
    expect(deferral).toMatch(/deferred = \{[^}]*\};\s*break;/);
    // The requeue's error is checked: a clone left at `pushing` after a
    // deferral is the stall the reclaim exists for, and this must not create it.
    expect(deferral).toMatch(/if \(requeueError\)\s*\{\s*throw/);
  });

  it("never fails the event or the clone on a limit", () => {
    const deferral = catchBlock.slice(0, catchBlock.indexOf("failed++"));
    expect(deferral).not.toContain('status: "failed"');
    expect(deferral).not.toContain('sync_status: "failed"');
  });
});

describe("the invocation budget", () => {
  const loop = sliceFrom(engine, "let attempted = 0;", 4_000);

  it("is asked before each clone, with the slowest pass so far as the reserve", () => {
    expect(loop).toMatch(
      /for \(const r of queuedRows\) \{\s*if \(attempted > 0 && opts\?\.budget\?\.isPastDeadline\(slowestMs\)\) \{\s*stoppedEarly = true;\s*break;/,
    );
  });

  it("measures every clone it processes", () => {
    const tail = sliceFrom(engine, "attempted++;", 200);
    expect(tail).toMatch(
      /attempted\+\+;\s*slowestMs = Math\.max\(slowestMs, Date\.now\(\) - cloneStartedAt\);/,
    );
  });

  it("a first clone is always attempted", () => {
    // `attempted > 0` — a pass that refused its first clone would make no
    // progress on any tick and be retried for ever.
    expect(loop).toContain("attempted > 0 &&");
  });
});

describe("handing the event back", () => {
  const hold = sliceFrom(engine, "if (deferred || stoppedEarly) {", 2_500);

  it("is pending again with the moment it may be claimed, and the claim released", () => {
    expect(hold).toMatch(
      /status: "pending",\s*worker_started_at: null,\s*next_attempt_at: deferred \? deferred\.until : new Date\(\)\.toISOString\(\)/,
    );
  });

  it("is checked, because an event left `running` is the stall this replaces", () => {
    // The fenced helper throws on a refused write; a superseded claim writes
    // nothing more and says so in its result.
    expect(hold).toContain("const held = await updateEvent(");
    expect(hold).toMatch(/if \(!held\) return \{ ok: false/);
  });

  it("returns before the final tally is written", () => {
    // `summariseCascade` + `status: finalStatus` come AFTER this block: a
    // partial count must never be recorded as the whole fleet's outcome.
    const returnAt = hold.indexOf("return deferred");
    expect(returnAt).toBeGreaterThan(-1);
    const afterHold = engine.slice(engine.indexOf("if (deferred || stoppedEarly) {"));
    expect(afterHold.indexOf("summariseCascade({")).toBeGreaterThan(
      afterHold.indexOf("return deferred"),
    );
  });

  it("says what was done and why it stopped", () => {
    expect(hold).toContain(
      "describeDeferral({ until: deferred.until, detail: deferred.detail, done, total })",
    );
    expect(hold).toContain("describePause({ done, total })");
  });
});

describe("the drain", () => {
  it("claims only what may run now", () => {
    const claim = sliceFrom(drain, "async function claimOne", 2_500);
    expect(claim).toContain('.lte("next_attempt_at", nowIso)');
    // Still the claim it always was.
    expect(claim).toContain('.is("worker_started_at", null)');
    expect(claim).toContain('.lt("attempts", MAX_ATTEMPTS)');
  });

  it("passes a deadline the engine can ask, and stops claiming past it", () => {
    const route = sliceFrom(drain, "const deadlineAt = Date.now() + INVOCATION_BUDGET_MS;", 2_400);
    expect(route).toMatch(
      /isPastDeadline: \(reserveMs\) => Date\.now\(\) \+ reserveMs >= deadlineAt/,
    );
    expect(route).toMatch(
      /if \(Date\.now\(\) >= deadlineAt\) break;\s*const r = await drainOne\(budget, failedThisTick\);/,
    );
  });

  it("leaves headroom inside the 60-second window", () => {
    const m = /const INVOCATION_BUDGET_MS = ([\d_]+);/.exec(drain);
    expect(m).not.toBeNull();
    const budget = Number(m![1].replace(/_/g, ""));
    expect(budget).toBeGreaterThan(20_000);
    expect(budget).toBeLessThan(55_000);
  });

  it("refunds the attempt on a deferral and on a pause that landed something", () => {
    const one = sliceFrom(drain, "async function drainOne", 4_000);
    expect(one).toMatch(
      /const refund =\s*res\.status === "deferred" \|\| res\.done > 0 \|\| \(res\.status === "resuming" && res\.progressed\);/,
    );
    expect(one).toMatch(/attempts: Math\.max\(0, claimed\.attempts - 1\)/);
  });

  it("does not stamp a held event as finished", () => {
    const one = sliceFrom(drain, "async function drainOne", 4_000);
    const held = one.slice(
      one.indexOf('res.status === "deferred"'),
      one.indexOf("return { processed: true, ok: true, held: res.status };"),
    );
    expect(held).not.toMatch(/worker_finished_at: new Date\(\)\.toISOString\(\) \}\)/);
  });

  it("says so when a pause never lands anything and the attempts are gone", () => {
    // Left `pending` past MAX_ATTEMPTS the event is unclaimable and silent —
    // the shape `claimOne`'s `attempts < MAX_ATTEMPTS` filter would otherwise
    // produce.
    const one = sliceFrom(drain, "async function drainOne", 4_000);
    expect(one).toMatch(
      /else if \(claimed\.attempts >= MAX_ATTEMPTS\) \{[\s\S]{0,400}status: "failed"/,
    );
  });
});

describe("the module-scope pass reads the clone only when the tree could not say", () => {
  it("records the clone's blob SHAs when both listings were complete", () => {
    const mirror = sliceFrom(engine, "if (isMirror) {\n    const [primeTree, cloneTree]", 1_500);
    expect(mirror).toContain("cloneShaByPath = cloneTree.entries;");
    const module = sliceFrom(engine, "if (!primeTree.truncated && !cloneTree.truncated) {", 400);
    expect(module).toMatch(
      /candidatePaths = candidatePaths\.filter\([\s\S]*?\);\s*cloneShaByPath = cloneTree\.entries;/,
    );
  });

  it("skips the per-path clone read when the SHAs are known", () => {
    const prepare = sliceFrom(engine, "let cloneFileRead = false;", 1_500);
    expect(prepare).toMatch(
      /if \(cloneShaByPath !== null\) \{[\s\S]*?if \(cloneShaByPath\.get\(path\) === primeFile\.sha\) return null;\s*\} else if \(!isMirror\) \{\s*cloneFile = await getFileContent\(octokit, cloneRef, path\);/,
    );
  });

  it("still fetches the clone's content where the identity hold needs it", () => {
    const hold = sliceFrom(engine, "if (!cloneFileRead) {", 300);
    expect(hold).toContain("cloneFile = await getFileContent(octokit, cloneRef, path);");
  });
});

describe("a pass is finished when the engine says so", () => {
  const merge = readFileSync("src/server/cascadeMergeDrain.server.ts", "utf8");

  it("the merge drain's recount never writes over an event still being executed", () => {
    /* Measured 2 Sep 2026 14:10 on event 795d73d2: the cascade drain had
       claimed it and was pushing preflight-property-group when the recount
       rewrote it to `completed`; the invocation was cut at 60 s, the engine's
       own write never came, and the clone's row sat at `pushing` under a
       finished event where no reclaim rule looked. */
    const fn = sliceFrom(merge, "async function recountEvent", 2_500);
    expect(fn).toContain('.select("summary, status, worker_started_at, worker_finished_at")');
    expect(fn).toMatch(
      /if \(current\.data\?\.status === "running" \|\| current\.data\?\.status === "pending"\) return false;/,
    );
    expect(fn).toMatch(
      /if \(current\.data\?\.worker_started_at && !current\.data\?\.worker_finished_at\) return false;/,
    );
    // Both guards sit BEFORE the write.
    const write = fn.indexOf(".update({ summary, status })");
    expect(write).toBeGreaterThan(fn.indexOf('current.data?.status === "running"'));
  });

  it("requeues a pushing row by the row's own age, never the event's", () => {
    /* 14:24:02 on e3e2af73: the event was revived, its `started_at` sat a
       second inside the cutoff, the row stayed at `pushing`, and the next
       claim wrote `completed · (of 0)`. */
    const requeue = sliceFrom(drain, "// The results have to come back with them.", 1_600);
    expect(requeue).toMatch(
      /\.eq\("status", "pending"\)\s*\.is\("completed_at", null\)\s*\.is\("worker_started_at", null\)/,
    );
    expect(requeue).toMatch(/\.in\("status", \["pushing"\]\)\s*\.lt\("started_at", cutoff\)/);
    expect(requeue).not.toMatch(/\.is\("completed_at", null\)\s*\.lt\("started_at", cutoff\)/);
  });

  it("the reclaim revives a pushing row left under a finished event", () => {
    const reclaim = sliceFrom(drain, "const { data: orphanRows, error: orphanRowsErr }", 2_500);
    expect(reclaim).toMatch(/\.eq\("status", "pushing"\)\s*\.lt\("started_at", cutoff\)/);
    expect(reclaim).toContain('.in("status", ["completed", "partial", "failed"])');
    expect(reclaim).toMatch(
      /status: "pending",\s*worker_started_at: null,\s*worker_finished_at: null,\s*completed_at: null,\s*next_attempt_at: new Date\(\)\.toISOString\(\)/,
    );
    // Every step checked: a reclaim that half-happened is the state the
    // header of `reclaimStalled` says this worker cannot reason about.
    for (const err of ["orphanRowsErr", "finishedErr", "reviveErr", "requeueErr"]) {
      expect(reclaim).toMatch(new RegExp(`if \\(${err}\\) \\{\\s*throw new Error`));
    }
  });
});

describe("a pass resumes inside a clone", () => {
  /* Measured 2 Sep 2026 at 14:10 and 14:14 on preflight-property-group: a
     first module-scope pass of 353 files was still preparing blobs when the
     hook was abandoned at 60 s, twice; the invocation budget only stopped
     between clones. The list of prepared blobs now rides on the result row
     and the next pass starts from it. See cascade/passProgress.pure.ts. */
  const process = sliceFrom(engine, "export async function processClone(", 70_000);

  it("the reuse is consulted before any GitHub call for the path", () => {
    const worker = sliceFrom(process, "const reusable = known.get(path);", 1_200);
    expect(worker.indexOf("if (reusable !== undefined)")).toBeLessThan(
      worker.indexOf("getFileContent(octokit, primeRef, path"),
    );
  });

  it("reuses only on the real path, and only against prime's listing", () => {
    expect(process).toContain("const resume = dryRun ? undefined : args.resume;");
    expect(process).toContain(
      "const priorProgress = resume ? readProgress(resume.progress) : null;",
    );
    expect(process).toContain("resumableBlobs(priorProgress, primeShaByPath)");
  });

  it("opens the ledger before the deletion probes, and probes on the budget", () => {
    // The probes are the first paid question a pass asks; a ledger opened
    // after them remembers everything except the most expensive thing the
    // pass did. Measured on the September 2026 retirement: 442 approved
    // candidates ≈ ~1,300 calls a clone, re-paid on every resume until the
    // evidence rode the ledger.
    expect(process.indexOf("const priorProgress =")).toBeLessThan(
      process.indexOf("await probeDeletions({"),
    );
    expect(process).toContain("resumableDeletionEvidence(priorProgress, cloneShaByPath ?? null)");
    const probe = sliceFrom(process, "const probe = await probeDeletions({", 2_200);
    expect(probe).toContain("known: knownEvidence,");
    expect(probe).toMatch(
      /shouldStop: \(\) =>\s*resume\?\.budget !== undefined && resume\.budget\.isPastDeadline\(slowestChunkMs\)/,
    );
    // Settled answers ride the ledger chunk by chunk; unsettled never does.
    expect(probe).toContain('if (c.evidence.kind === "unsettled") continue;');
    expect(probe).toContain("await resume.onProgress(progress);");
  });

  it("a probe pause hands the clone back queued with its evidence, planning nothing", () => {
    const pause = sliceFrom(process, "if (probePaused && resume) {", 700);
    expect(pause).toContain("await resume.onProgress(progress);");
    expect(pause).toMatch(/status: "queued",\s*started_at: null,/);
    expect(pause).toContain("progress: progress as unknown as Json,");
    // An approved sweep planned from half its evidence is the window
    // pretending to be the retirement.
    expect(pause).not.toContain("planDeletions");
    expect(process.indexOf("if (probePaused && resume) {")).toBeLessThan(
      process.indexOf("planDeletions(deletionVerdicts"),
    );
  });

  it("evidence counts as progress, so a probe-only pause is refunded", () => {
    // A pass that spent its whole tick settling evidence prepared no blobs;
    // counting only `prepared` made it read as no progress, spend its
    // attempt, and die in three ticks inside a healthy convergence.
    const loop = sliceFrom(engine, "for (const r of queuedRows) {", 8_000);
    expect(loop).toMatch(
      /const ledgerSize = \(p: CascadeProgress \| null\) =>\s*Object\.keys\(p\?\.prepared \?\? \{\}\)\.length \+ Object\.keys\(p\?\.deletion_evidence \?\? \{\}\)\.length;/,
    );
    expect(loop).toContain("const priorPrepared = ledgerSize(readProgress(priorRecord));");
    expect(loop).toContain("preparedNow = ledgerSize(progress);");
  });

  it("asks the budget before each fresh file, never before the first", () => {
    expect(process).toMatch(
      /const shouldStop = \(\) =>\s*resume\?\.budget !== undefined &&\s*freshlyPrepared > 0 &&\s*resume\.budget\.isPastDeadline\(slowestFileMs\);/,
    );
    expect(process).toContain("await mapWithConcurrencyUntil<");
  });

  it("writes the list as it goes and hands the clone back queued with it", () => {
    expect(process).toMatch(
      /if \(freshlyPrepared % PROGRESS_FLUSH_EVERY === 0\) await resume\.onProgress\(progress\);/,
    );
    const pause = sliceFrom(process, "if (preparePaused && resume) {", 700);
    expect(pause).toContain("await resume.onProgress(progress);");
    expect(pause).toMatch(/status: "queued",\s*started_at: null,/);
    expect(pause).toContain("progress: progress as unknown as Json,");
    // Nothing is committed from a half-prepared list.
    expect(pause).not.toContain("createTree");
  });

  it("the engine supplies the writer, and only from the real pass", () => {
    const loop = sliceFrom(engine, "for (const r of queuedRows) {", 8_000);
    expect(loop).toContain("resume: {");
    expect(loop).toMatch(
      /onProgress: async \(progress\) => \{[\s\S]{0,400}\.update\(\{ progress: progress as unknown as Json \}\)/,
    );
    // A rehearsal passes no `resume` at all.
    const rehearsal = sliceFrom(engine, "export async function regenerateCloneProposal", 3_000);
    expect(rehearsal).not.toContain("resume:");
  });

  it("a paused clone stops the pass; a finished one KEEPS its list", () => {
    const loop = sliceFrom(engine, "for (const r of queuedRows) {", 8_000);
    expect(loop).toMatch(
      /if \(patch\.status === "queued"\) \{[\s\S]{0,600}stoppedEarly = true;\s*break;/,
    );
    /* The list used to be cleared on every finished status, which made each
       of prime's ~50 daily commits a full ~300-file re-preparation per clone
       — the treadmill that spent the App's hourly budget on work already
       done through the September 2026 freeze. An entry that goes stale
       invalidates itself against the next pass's own prime listing
       (`resumableBlobs`), so clearing bought no safety. */
    expect(loop).not.toContain(".update({ ...patch, progress: null })");
    expect(loop).toContain(".update(patch)");
  });

  it("a pass with no list of its own borrows the clone's newest one", () => {
    const loop = sliceFrom(engine, "for (const r of queuedRows) {", 8_000);
    expect(loop).toContain(
      "const priorRecord = ownRecord ?? (await borrowLatestProgress(supabase, clone.id, r.id));",
    );
    // Best-effort by design: an unreadable ledger is "nothing to reuse",
    // never a failed pass.
    const borrow = sliceFrom(engine, "async function borrowLatestProgress(", 1_400);
    expect(borrow).toContain("return null;");
    expect(borrow).not.toContain("throw");
  });

  it("a stale reused blob clears the list it came from, so the retry re-prepares", () => {
    expect(engine).toContain("...(isStaleObjectError(e) ? { progress: null } : {}),");
    const classifier = sliceFrom(engine, "function isStaleObjectError(", 900);
    expect(classifier).toContain("404");
    expect(classifier).toContain("422");
  });

  it("progress inside a clone is refunded like a finished clone", () => {
    const loop = sliceFrom(engine, "for (const r of queuedRows) {", 8_000);
    expect(loop).toContain("if (preparedNow > priorPrepared) progressed = true;");
    expect(engine).toContain('{ ok: true, status: "resuming", done, total, progressed }');
  });
});
