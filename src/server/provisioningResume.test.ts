import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mapPool } from "./prime-backend.server";
import {
  BudgetPause,
  formatResumeMarker,
  isUpstreamRateLimit,
  parseResumeMarker,
  pastDeadline,
} from "./provisioningBudget";

/**
 * Provisioning must survive the invocation it runs in.
 *
 * The 30 Aug 2026 dry run measured what happens when it does not: the prime
 * snapshot fetched thousands of blobs one serial round trip at a time, no
 * drain invocation lived long enough to finish the first stage, every attempt
 * restarted from zero, and the job exhausted three attempts with nothing to
 * show — while a fresh clone drew a paid "High drift" model call every
 * fifteen minutes for not existing yet.
 *
 * Three mechanisms fix that, and these tests hold each to its job:
 *  1. the snapshot's blob walk is POOLED, not serial;
 *  2. the pipeline persists its project ref at creation, pauses at stage
 *     boundaries when the invocation budget is due, and resumes by asking the
 *     target what it already holds;
 *  3. the drift sweep does not score, model-analyze, or alarm on a clone that
 *     is still being provisioned.
 *
 * Route-adjacent pins live beside the worker-claim contract in
 * `src/routes/workerClaims.contract.test.ts`; these cover the server modules.
 */

const read = (p: string) => readFileSync(p, "utf8");
const primeBackend = () => read("src/server/prime-backend.server.ts");
const pipeline = () => read("src/server/backend-provisioning.server.ts");
const introspection = () => read("src/server/schema-introspection.server.ts");
const runner = () => read("src/lib/backend-provisioning.functions.ts");
const drift = () => read("src/server/fleet-drift.functions.ts");
const retryHook = () => read("src/routes/hooks.backend-provisioning-retry.tsx");

describe("mapPool", () => {
  it("preserves input order in its results", async () => {
    const out = await mapPool([30, 5, 20, 1], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 10;
    });
    expect(out).toEqual([300, 50, 200, 10]);
  });

  it("never runs more work than the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("rejects with the first failure, like Promise.all", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("the snapshot fetches blobs batched, never one round trip each", () => {
  it("function bundles travel by GraphQL batch; replay migrations stay pooled", () => {
    /* Per-request cost from this runtime is the binding constraint, not
       width: the invocation died mid-pool at 12-wide over ~2,000 blobs and
       again at 24-wide over ~1,050. ~Fourteen GraphQL queries fit; a
       thousand REST calls never did. */
    const src = primeBackend();
    const fn = src.slice(src.indexOf("export async function fetchPrimeBackendSnapshot"));
    expect(fn).toMatch(/await fetchBlobTextsBatched\(octokit, ref, neededEntries\)/);
    expect(fn).toMatch(/await mapPool\(migrationMetas/);
    /* The defect's exact shape: one awaited round trip per iteration of a
       bare for-loop. Neither loop may come back. */
    expect(fn).not.toMatch(/for \(const meta of migrationMetasFromBlobs/);
    expect(fn).not.toMatch(/files\.push\(\{ path: rel, contentBase64: await getContent/);
  });

  it("the batch fetch falls back to REST on GitHub's own fidelity verdicts", () => {
    /* GraphQL text is UTF-8 only and truncates past ~512KB; a mis-decoded
       byte in a deployed function is worse than a slow snapshot. The
       fallback keys on isBinary/isTruncated — never on filename. */
    const src = primeBackend();
    const fn = src.slice(src.indexOf("async function fetchBlobTextsBatched"));
    expect(fn).toMatch(/isBinary === false && blob\.isTruncated === false/);
    expect(fn).toMatch(/restFallback/);
    expect(fn).toMatch(/fetchBlobBase64\(octokit, ref, e\.sha\)/);
  });

  it("migration SQL bodies are fetched only for the strategy that reads them", () => {
    /* ~985 of the snapshot's ~2,000 round trips were SQL bodies the default
       introspection path never reads — the half that kept the walk over the
       invocation's lifetime even pooled. The runner asks for them exactly
       when the replay strategy will replay them. */
    expect(primeBackend()).toMatch(/includeMigrationSql\?:/);
    expect(runner()).toMatch(
      /includeMigrationSql:\s*\(input\.schemaStrategy \?\? "introspection"\) === "migration-replay"/,
    );
  });
});

describe("the pipeline is budgeted and resumable", () => {
  it("pastDeadline treats an absent deadline as no budget", () => {
    expect(pastDeadline(undefined)).toBe(false);
    expect(pastDeadline(null)).toBe(false);
    expect(pastDeadline(Date.now() - 1)).toBe(true);
    expect(pastDeadline(Date.now() + 60_000)).toBe(false);
  });

  it("BudgetPause names itself and carries the detail", () => {
    const p = new BudgetPause("deploying edge functions");
    expect(p.name).toBe("BudgetPause");
    expect(p.detail).toBe("deploying edge functions");
    expect(p.message).toContain("deploying edge functions");
  });

  it("persists the project ref the moment the project is created", () => {
    const src = pipeline();
    const created = src.indexOf("projectRef = project.id;");
    expect(created).toBeGreaterThan(-1);
    const after = src.slice(created, created + 600);
    expect(after).toContain("input.onProjectRef?.(projectRef)");
  });

  it("the runner wires onProjectRef to a clone_backends write", () => {
    expect(runner()).toMatch(/onProjectRef[\s\S]{0,300}supabase_project_ref: ref/);
  });

  it("deployEdgeFunctions checks the budget between deploys and pauses", () => {
    const src = pipeline();
    const fn = src.slice(src.indexOf("export async function deployEdgeFunctions"));
    expect(fn).toMatch(/pastDeadline\(deadlineAt\)/);
    expect(fn).toMatch(/throw new BudgetPause\(/);
  });

  it("a resume asks the project which functions it already holds", () => {
    const src = pipeline();
    const body = src.slice(src.indexOf("export async function provisionCloneBackend"));
    expect(body).toMatch(
      /if \(input\.existingProjectRef\)[\s\S]{0,300}listProjectEdgeFunctionSlugs/,
    );
    expect(body).toMatch(/skipped: true/);
  });

  it("introspection pauses between stages, and the first stage run never pauses", () => {
    /* Every stage now goes through one gate rather than carrying its own
       pause call — the rule is unchanged, its enforcement moved. Each stage
       in the sequence must be entered through it, or a stage becomes
       unpausable and unskippable at once. */
    const src = introspection();
    const body = src.slice(src.indexOf("export async function replicateSchemaByIntrospection"));
    const gated = body.match(/enterStage\("/g) ?? [];
    expect(gated.length).toBe(12);
    expect(body).toMatch(/if \(ranAStageThisPass\) pauseIfDue\(/);
  });

  it("the runner reports a pause as progressed and never writes failed for it", () => {
    const src = runner();
    const catchAt = src.indexOf("if (e instanceof BudgetPause)");
    const failedAt = src.indexOf('status: "failed" as const');
    expect(catchAt).toBeGreaterThan(-1);
    expect(failedAt).toBeGreaterThan(catchAt);
    const pauseBlock = src.slice(catchAt, failedAt);
    expect(pauseBlock).toMatch(/retryable: true, progressed: true/);
    expect(pauseBlock).not.toContain('"failed"');
  });
});

describe("the drift sweep leaves provisioning clones alone", () => {
  it("skips scoring, the model call and notifications while a clone is in flight", () => {
    const src = drift();
    const scan = src.slice(src.indexOf("export async function runFleetDriftScan"));
    const guard = scan.indexOf("inFlightBackends.has(c.id)");
    const model = scan.indexOf("analyzeClone(");
    expect(guard).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(guard);
    /* The guarded branch records the check ran and nothing else. */
    expect(scan.slice(guard, guard + 700)).toContain("last_drift_check_at");
    expect(scan.slice(guard, guard + 700)).toContain("continue");
  });

  it("a clone with no cascade yet is clocked from creation, not from 1970", () => {
    const src = drift();
    expect(src).toMatch(/c\.last_cascade_at \?\? c\.created_at/);
    /* The fabricated forty: null → 99999 minutes → drift 40. The fallback
       to 99999 may only remain for a row with NO usable clock at all. */
    expect(src).not.toMatch(/c\.last_cascade_at\s*\?\s*\(Date\.now/);
  });

  it("alarms fire on the transition into behind, not on every scan there", () => {
    const src = drift();
    expect(src).toMatch(/wasAlreadyBehind[\s\S]{0,200}\? \[\]/);
  });
});

describe("the retry hook is the operator's button, engine-callable", () => {
  it("is cron-auth guarded and re-queues only a failed backend", () => {
    const src = retryHook();
    expect(src).toContain("verifyCronAuth(request)");
    expect(src).toMatch(/status !== "failed"/);
  });

  it("goes through the one enqueue with a freshly minted password", () => {
    const src = retryHook();
    expect(src).toContain("enqueueCloneBackendProvisioning(");
    expect(src).toContain("generateSecurePassword()");
    /* Never a hand-rolled upsert: the enqueue IS the contract with the drain. */
    expect(src).not.toContain('from("clone_backends").upsert');
  });
});

describe("the snapshot materialises once per file, never once per bundle", () => {
  /* Every bundle carries the whole `_shared` tree by convention, so anything
     that walks bundles multiplies the shared tree by the function count. The
     prime has 423 bundles and a 6.3 MB shared tree: walking bundles to collect
     secret names decoded roughly 2.7 GB of strings into one array. It killed
     the worker outright (502) the moment the fetch got fast enough to reach
     it — every earlier build had died fetching, which is why a defect present
     from the start only surfaced last. */
  it("builds one file object per distinct path and shares it by reference", () => {
    const fn = primeBackend().slice(
      primeBackend().indexOf("export async function fetchPrimeBackendSnapshot"),
    );
    expect(fn).toMatch(/const fileByPath = new Map<string, PrimeFunctionFile>\(\)/);
    /*
      The property is that a bundle's files come OUT of `fileByPath` by
      reference, not that they come from any particular list — bundles are
      pruned to the paths their entrypoint reaches now, so the list is
      `prune.keep`. Pinning the array's name pinned the wrong half.
    */
    expect(fn).toMatch(/files: \w+(?:\.\w+)*\.map\(\(rel\) => fileByPath\.get\(rel\)!\)/);
    // And never a fresh object per bundle entry, which is the 2.7 GB shape.
    expect(fn).not.toMatch(/files: \w+\.map\(\([^)]*\) => \(\{\s*path:/);
  });

  it("scans distinct files for secret names, never the bundles", () => {
    const fn = primeBackend().slice(
      primeBackend().indexOf("export async function fetchPrimeBackendSnapshot"),
    );
    expect(fn).toMatch(/for \(const \[rel, f\] of fileByPath\)/);
    /* The shape that cost 2.7 GB. It must not come back. */
    expect(fn).not.toMatch(
      /for \(const fn of functions\)[\s\S]{0,120}for \(const f of fn\.files\)/,
    );
  });
});

describe("every stage can be interrupted at batch granularity", () => {
  /* A stage that cannot pause gets KILLED instead, and a kill costs a
     15-minute stall reclaim where a pause costs 60 seconds. The `functions`
     stage settled it: 624 definitions in batches of 15 over up to five
     convergence passes is not work any single invocation finishes. Batches
     commit individually, so between them is the finest honest interruption
     point — below it is one server-side transaction. */
  it("applyStatements checks the budget between batches, never before the first", () => {
    const src = introspection();
    const fn = src.slice(src.indexOf("export async function applyStatements"));
    expect(fn).toMatch(/pauseIfDue\?:\s*\(about: string, batchIndex\?: number\) => void/);
    /* Never before the first batch THIS invocation runs — which is `from` on a
       resumed stage, not a hard zero. */
    expect(fn).toMatch(/if \(i > from\) pauseIfDue\?\./);
  });

  it("the repeating loops pass the hook down", () => {
    const src = introspection();
    /* The two stages that re-apply a whole statement set until it converges. */
    expect(src).toMatch(/applyStatements\(cloneRef, "functions", fnStmts, 15, pauseIfDue\)/);
    expect(src).toMatch(/applyStatements\(cloneRef, "views", viewStmts, 30, pauseIfDue\)/);
  });

  it("a finished stage is skipped by asking the clone, not by keeping notes", () => {
    const src = introspection();
    expect(src).toMatch(/async function alreadyReconciled\(/);
    expect(src).toMatch(/already reconciled — skipped on resume/);
  });
});

describe("the schema build remembers where it paused", () => {
  /* Batch-level pausing (above) made overruns cheap, but every invocation
     still replayed the sequence from stage 1 — and on this prime the `tables`
     stage alone costs a whole slice. The run reached the same pause point on
     every pass and the stages after it were never given any budget: 155 of
     624 functions, unchanged across three consecutive passes, pausing
     correctly and progressing not at all. The marker is what turns a pause
     into progress. */
  const migration = () => read("supabase/migrations/20260831080000_clone_backend_resume_stage.sql");

  it("the stage order is declared once and shared", () => {
    const src = introspection();
    expect(src).toMatch(/export const STAGE_SEQUENCE: readonly StageName\[\]/);
    /* The marker is an index into this list, so a stage missing from it can
       never be resumed at. */
    for (const stage of [
      "enums",
      "sequences",
      "tables",
      "functions",
      "constraints",
      "indexes",
      "views",
      "matviews",
      "triggers",
      "rls",
      "policies",
      "grants",
    ]) {
      expect(src.slice(src.indexOf("STAGE_SEQUENCE"))).toContain(`"${stage}"`);
    }
  });

  it("a carried stage is skipped, and the first stage run never pauses", () => {
    const src = introspection();
    const gate = src.slice(src.indexOf("const enterStage ="));
    expect(gate).toMatch(/STAGE_SEQUENCE\.indexOf\(stage\) < startIndex\) return false/);
    /* Without this an invocation could pause before doing anything and
       recycle for ever without moving the job. */
    expect(gate).toMatch(/if \(ranAStageThisPass\) pauseIfDue\(/);
  });

  it("the pause carries the stage rather than the caller parsing the prose", () => {
    expect(read("src/server/provisioningBudget.ts")).toMatch(/readonly resumeStage\?: string/);
    /* The pause carries WHERE the build stopped — stage and, when it stopped
       inside one, the batch. One value, because they are one fact. */
    expect(introspection()).toMatch(
      /throw new BudgetPause\(about, formatResumeMarker\(reachedStage, batchIndex\)\)/,
    );
  });

  it("a resumed pass never claims the schema is complete", () => {
    /* It skipped stages, so it cannot pronounce on them. It reports `partial`,
       the marker is cleared, and one full pass verifies the lot — cheap now,
       because every finished stage answers alreadyReconciled with two COUNTs.
       This is also what closes the loop: `tables` cannot finish before the
       functions stage exists, and succeeds on the pass after it does. */
    const src = introspection();
    expect(src).toMatch(/const partial = startIndex > 0/);
    expect(src).toMatch(/ok: !partial && shortStages\.length === 0/);
    expect(pipeline()).toMatch(/if \(result\.partial\)[\s\S]{0,400}throw new BudgetPause\(/);
  });

  it("the runner stores the marker on a pause and clears it when done", () => {
    const src = runner();
    expect(src).toMatch(/select\("supabase_project_ref, resume_stage"\)/);
    expect(src).toMatch(/introspectionResumeStage: existingRow\?\.resume_stage/);
    /* Undefined means the pause had no stage to name (the health wait, the
       edge deploys) — leave the stored marker alone rather than guessing. */
    expect(src).toMatch(
      /e\.resumeStage === undefined \? \{\} : \{ resume_stage: e\.resumeStage \|\| null \}/,
    );
    /* Cleared on both terminal outcomes: a finished schema and a broken run
       both start from the first stage next time. */
    expect(src).toMatch(/status: "ready" as const,[\s\S]{0,160}resume_stage: null/);
    expect(src).toMatch(/status: "failed" as const,[\s\S]{0,240}resume_stage: null/);
  });

  it("the column exists in a migration, defaulting to start-from-the-top", () => {
    const sql = migration();
    expect(sql).toMatch(/alter table public\.clone_backends/);
    expect(sql).toMatch(/add column if not exists resume_stage text/);
    /* Nullable with no default: NULL is "start from the beginning", which is
       what every existing row already means. */
    expect(sql).not.toMatch(/not null/i);
  });
});

describe("a vendor's quota is not this job failing", () => {
  const drain = () => read("src/routes/hooks.backend-provisioning-drain.tsx");

  it("recognises the refusal that terminated the 31 Aug dry run", () => {
    /* Verbatim from clone_backends.error_message on the row that exhausted. */
    expect(
      isUpstreamRateLimit(
        new Error(
          "API rate limit exceeded for installation ID 157200201. If you reach out to " +
            "GitHub Support for help, please include the request ID 6C94:CFC00 and " +
            "timestamp 2026-08-31 07:42:01 UTC.",
        ),
      ),
    ).toBe(true);
  });

  it("recognises a secondary limit and a bare 429", () => {
    expect(
      isUpstreamRateLimit(
        new Error("You have exceeded a secondary rate limit. Please wait a few minutes."),
      ),
    ).toBe(true);
    expect(
      isUpstreamRateLimit(Object.assign(new Error("Too Many Requests"), { status: 429 })),
    ).toBe(true);
  });

  it("does NOT swallow a permission denial, which is also a 403", () => {
    /* Requeuing this for three hours would hide a real access fault behind a
       quota message. The message has to name the limit. */
    expect(
      isUpstreamRateLimit(
        Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
      ),
    ).toBe(false);
    expect(isUpstreamRateLimit(new Error("Not Found"))).toBe(false);
    expect(isUpstreamRateLimit(null)).toBe(false);
    expect(isUpstreamRateLimit("rate limit exceeded")).toBe(false);
  });

  it("the runner reports it instead of writing `failed`", () => {
    const src = runner();
    /* Classified BEFORE the failure write, or the row is already terminal. */
    const limitAt = src.indexOf("isUpstreamRateLimit(e)");
    const failAt = src.indexOf('status: "failed" as const');
    expect(limitAt).toBeGreaterThan(-1);
    expect(limitAt).toBeLessThan(failAt);
    expect(src).toMatch(/upstreamLimited: true/);
    /* The marker is untouched: the next invocation resumes where this one was
       refused rather than starting over. */
    const branch = src.slice(limitAt, failAt);
    expect(branch).not.toMatch(/resume_stage/);
    expect(branch).not.toMatch(/status: "failed"/);
  });

  it("the drain hands the attempt back rather than resetting it", () => {
    const src = drain();
    /* Not zero — a genuine failure earlier in this job's life still counts. */
    expect(src).toMatch(/attempts: Math\.max\(0, \(claimed\.attempts \?\? 0\) - 1\)/);
    /* And it can never be the thing that terminates the row. */
    expect(src).toMatch(/!budgetPaused && !upstreamLimited && claimed\.attempts >= MAX_ATTEMPTS/);
  });

  it("the invocation stops rather than proving the same wall twice", () => {
    expect(drain()).toMatch(/if \(r\.budgetPaused \|\| r\.upstreamLimited\) break;/);
  });

  it("the ceiling still bounds a job the quota never lets through", () => {
    /* Attempts no longer bound this, so the wall clock must — parked rows
       included, which is the branch that catches a permanently limited job. */
    const src = drain();
    expect(src).toMatch(/ceilingCutoff/);
    expect(src).toMatch(/\.in\("status", \["pending", \.\.\.IN_FLIGHT_STATUSES\]\)/);
  });
});

describe("a resumed pass does not buy what it cannot use", () => {
  it("the snapshot can decline the expensive half, and says it did", () => {
    const src = primeBackend();
    expect(src).toMatch(/includeFunctionSource\?: boolean/);
    /* The early return must sit BEFORE the bundle fetch, or declining costs
       exactly as much as not declining. */
    const guardAt = src.indexOf("if (!includeFunctionSource)");
    const fetchAt = src.indexOf("fetchBlobTextsBatched(octokit, ref, neededEntries)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fetchAt);
    /* An empty list must never be mistaken for a prime with no functions. */
    expect(src).toMatch(/functionSourceOmitted: true/);
    expect(src).toMatch(/functionSourceOmitted: false/);
  });

  it("the runner decides from the marker, and reads it before snapshotting", () => {
    const src = runner();
    const readAt = src.indexOf('.select("supabase_project_ref, resume_stage")');
    const snapAt = src.indexOf("await fetchPrimeBackendSnapshot(");
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(snapAt);
    expect(src).toMatch(/includeFunctionSource: !resumingSchema/);
    /* Read once. Two reads is how the second one drifts from the first. */
    expect(src.split('.select("supabase_project_ref, resume_stage")').length - 1).toBe(1);
    /* A failed read is not an absent row — it must not resolve to "not resuming",
       which would silently restore the expensive fetch on every pass. */
    expect(src).toMatch(/existingRowErr[\s\S]{0,220}throw new Error\(/);
  });

  it("deploying can never proceed on a snapshot that omitted the source", () => {
    const src = pipeline();
    const guardAt = src.indexOf("snapshot.functionSourceOmitted");
    const deployAt = src.indexOf("const deployedNow = await deployEdgeFunctions(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deployAt);
    /* It pauses with an EMPTY resume stage: the marker clears, so the pass
       after it takes a full snapshot rather than declining again for ever. */
    const branch = src.slice(guardAt, guardAt + 500);
    expect(branch).toMatch(/throw new BudgetPause\(/);
    expect(branch).toMatch(/"",/);
  });
});

describe("the functions stage asks the clone what it already holds", () => {
  it("applies only the outstanding definitions, not all of them", () => {
    const src = introspection();
    /* The diff must be computed INSIDE the convergence loop: each pass lands
       more functions, so the work has to shrink pass by pass. */
    const stageAt = src.indexOf('if (enterStage("functions"))');
    const loopAt = src.indexOf("while (shouldRunAnotherFunctionPass(history))", stageAt);
    const applyAt = src.indexOf('applyStatements(cloneRef, "functions"', loopAt);
    const heldAt = src.indexOf("const held = new Set(", loopAt);
    expect(heldAt).toBeGreaterThan(loopAt);
    expect(heldAt).toBeLessThan(applyAt);
    /* Read from the CLONE, with the same query the prime is read with — two
       spellings of "what is a function here" is how a diff lies. */
    const branch = src.slice(loopAt, applyAt);
    expect(branch).toMatch(/query\(cloneRef, Q\.functions\)/);
    expect(branch).toMatch(/allFnStmts\.filter\(\(stmt\) => !held\.has\(stmt\)\)/);
  });

  it("nothing outstanding ends the stage rather than applying an empty batch", () => {
    const src = introspection();
    const loopAt = src.indexOf("while (shouldRunAnotherFunctionPass(history))");
    const branch = src.slice(loopAt, loopAt + 1800);
    expect(branch).toMatch(/if \(fnStmts\.length === 0\)[\s\S]{0,80}break;/);
  });

  it("reconciliation still counts the catalogue, never the diff", () => {
    /* The stage's verdict must come from counting both databases. A diff that
       skipped everything would otherwise report a reconciled stage on a clone
       holding nothing. */
    const src = introspection();
    const stageAt = src.indexOf('if (enterStage("functions"))');
    const pushAt = src.indexOf('stage: "functions",', stageAt);
    const tail = src.slice(stageAt, pushAt + 400);
    expect(tail).toMatch(/countOn\(primeRef, "functions"\)/);
    expect(tail).toMatch(/countOn\(cloneRef, "functions"\)/);
    expect(tail).toMatch(/reconciled: reconcile\(fnPrime, fnClone\)/);
  });
});

describe("every stage asks whether it is already done", () => {
  /* `alreadyReconciled` was written for exactly this and wired into TWO of the
     twelve stages. The other ten re-applied their whole statement list on
     every pass — grants is ~10,385 statements, which is why that stage ran for
     three hours across a dozen invocations without ever completing, and why
     the pipeline could never reach the edge-function step behind it. */
  const STAGES_THAT_MUST_ASK = [
    "constraints",
    "indexes",
    "views",
    "matviews",
    "triggers",
    "rls",
    "policies",
    "grants",
  ];

  it("no stage re-applies a statement list the clone has already caught up on", () => {
    const src = introspection();
    for (const stage of STAGES_THAT_MUST_ASK) {
      const asks =
        src.includes(`stageOrSkip(\n        "${stage}"`) ||
        src.includes(`alreadyReconciled("${stage}"`);
      expect(asks, `${stage} applies unconditionally — it must ask first`).toBe(true);
    }
  });

  it("tables is the one deliberate exception, and says why", () => {
    /* Equal counts do NOT mean equal tables: `create table if not exists`
       skips an existing table, so column drift survives with counts matching.
       Skipping on the count would skip diffMissingColumns with it. */
    const src = introspection();
    expect(src).toMatch(/never asks `alreadyReconciled` first, and deliberately/);
    expect(src).toMatch(/COLUMN DRIFT survives with the/);
    /* And it is the only remaining direct application. */
    expect(src.split("await runStage(").length - 1).toBe(1);
  });

  it("a skipped stage costs two COUNTs and no prime read", () => {
    /* The statements are a thunk, so a skipped stage never even queries the
       prime's catalogue for DDL it is not going to apply. */
    const src = introspection();
    const helper = src.slice(
      src.indexOf("const stageOrSkip ="),
      src.indexOf("await ensureApplyHelper"),
    );
    expect(helper).toMatch(
      /statements: \(\) => Promise<readonly string\[\]> \| readonly string\[\]/,
    );
    expect(helper).toMatch(/const done = await alreadyReconciled\(stage, primeRef, cloneRef\)/);
    expect(helper).toMatch(/if \(done\) return done;/);
    expect(helper).toMatch(/await statements\(\)/);
  });
});

describe("the schema's own dependencies exist before the schema is built", () => {
  it("extensions are installed BEFORE the introspection build, not after", () => {
    /* The prime's schema depends on its extensions: `vector` supplies the type
       eight tables declare a column of. Installing them after the build is a
       deadlock the moment the build can pause — a build that never finishes
       never reaches what comes after it. Measured: 6 table failures on
       `type "vector" does not exist`, 337 column and 28 function failures
       behind them. */
    const src = pipeline();
    const extAt = src.indexOf("enforceRequiredExtensions(projectRef, input.primeBackendRef)");
    const buildAt = src.indexOf("replicateSchemaByIntrospection(projectRef, {");
    expect(extAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(extAt, "extensions must be enforced before the schema build").toBeLessThan(buildAt);
  });

  it("it is enforced exactly once, and mirrors the prime rather than a fixed list", () => {
    const src = pipeline();
    expect(src.split("await enforceRequiredExtensions(").length - 1).toBe(1);
    /* The prime ref is passed, or only the floor installs — and the floor has
       never been the list. */
    expect(src).toMatch(/enforceRequiredExtensions\(projectRef, input\.primeBackendRef\)/);
  });

  it("a failed extension is reported, never swallowed", () => {
    /* A clone missing pg_cron or pg_net has no background layer at all, and
       that is a silence this platform has already paid for. */
    const src = pipeline();
    expect(src).toMatch(/extension\(s\) failed to install/);
  });
});

describe("a stage larger than one budget can still finish", () => {
  /* A stage that is genuinely short cannot be skipped, so one whose statement
     list exceeds a single budget could never complete: it restarted at batch
     zero every pass and applied the same prefix for ever. Grants showed it
     first — 46 of 149 batches, a dozen passes, three hours — and constraints
     showed it again the moment grants became skippable. */
  it("the marker carries the batch as well as the stage, in one value", () => {
    expect(formatResumeMarker("constraints", 26)).toBe("constraints#26");
    expect(parseResumeMarker("constraints#26")).toEqual({ stage: "constraints", batch: 26 });
    /* A bare stage still means "start this stage from the beginning". */
    expect(formatResumeMarker("grants")).toBe("grants");
    expect(parseResumeMarker("grants")).toEqual({ stage: "grants", batch: 0 });
    expect(parseResumeMarker(null)).toEqual({ stage: null, batch: 0 });
  });

  it("batch zero is never encoded, so the marker stays comparable", () => {
    expect(formatResumeMarker("tables", 0)).toBe("tables");
    expect(formatResumeMarker("", 5)).toBe("");
  });

  it("an unreadable batch starts the stage over rather than guessing", () => {
    /* Re-applying a prefix is merely slow. Skipping one that was never applied
       is wrong, so every unparseable form resolves to 0. */
    expect(parseResumeMarker("constraints#").batch).toBe(0);
    expect(parseResumeMarker("constraints#abc").batch).toBe(0);
    expect(parseResumeMarker("constraints#-4").batch).toBe(0);
    expect(parseResumeMarker("#7").stage).toBe(null);
  });

  it("applyStatements resumes at the offset and clamps it to the list", () => {
    const fn = introspection();
    const body = fn.slice(fn.indexOf("export async function applyStatements"));
    expect(body).toMatch(/const from = Math\.min\(Math\.max\(0, startBatch\), batches\.length\)/);
    expect(body).toMatch(/for \(let i = from; i < batches\.length; i\+\+\)/);
  });

  it("the offset belongs to ONE stage and is spent when the pass moves on", () => {
    /* A batch index means nothing outside the statement list it was counted
       in, so carrying it into the next stage would skip real work. */
    const src = introspection();
    expect(src).toMatch(/stage === resumeMarker\.stage \? resumeBatch : 0/);
    expect(src).toMatch(/if \(stage !== resumeMarker\.stage\) resumeBatch = 0;/);
  });

  it("the stages that need it are handed it", () => {
    const src = introspection();
    /* stageOrSkip covers eight of them; tables calls runStage directly. */
    expect(src).toMatch(/takeResumeBatch\(stage\)/);
    expect(src).toMatch(/takeResumeBatch\("tables"\)/);
  });
});

describe("no bulk apply runs without a budget check", () => {
  /* An apply with no pause hook cannot stop: the invocation is KILLED rather
     than pausing, which costs a hard attempt instead of a free requeue. The
     1 Sep 2026 run went from attempts 1 to 3 inside the table re-apply, one
     short of terminating a job whose schema was otherwise nearly complete. */
  it("every applyStatements call site passes a pause hook", () => {
    const src = introspection();
    const calls = [...src.matchAll(/applyStatements\(([\s\S]{0,220}?)\);/g)].map((m) => m[1]);
    /* The definition itself is not a call site. */
    const callSites = calls.filter((c) => !c.includes("cloneRef: string"));
    expect(callSites.length).toBeGreaterThan(0);
    const unguarded = callSites.filter((c) => !/pause/i.test(c));
    expect(unguarded, `applies with no budget check: ${unguarded.join(" | ")}`).toEqual([]);
  });

  it("the table re-apply pauses against the TABLES stage, not the cursor", () => {
    /* Resuming at `functions` would skip the tables stage, leave tableStmts
       null, and guard the repair off entirely — so it would never run again. */
    const src = introspection();
    expect(src).toMatch(/formatResumeMarker\("tables", batchIndex\)/);
    expect(src).toMatch(/pauseInTableRetry,\s*\n\s*takeResumeBatch\("tables"\)/);
  });
});

describe("the edge-function fetch is budgeted like everything else", () => {
  /* 423 bundles over ~1,033 files does not fit one invocation's share of the
     installation's hourly quota. Measured 1 Sep 2026: every pass that needed
     the whole set was refused with "API rate limit exceeded", so the pipeline
     could REACH the edge-function stage and never get through it — the schema
     completed, the marker cleared, the full pass was refused, and the cycle
     repeated. `ready` was unreachable. */
  it("the snapshot skips slugs the target already holds", () => {
    const src = primeBackend();
    expect(src).toMatch(/skipFunctionSlugs\?: readonly string\[\]/);
    /* Skipped BEFORE the bundle paths are collected, or it costs the same. */
    const skipAt = src.indexOf("if (skip.has(slug)) continue;");
    const fetchAt = src.indexOf("fetchBlobTextsBatched(octokit, ref, neededEntries)");
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(fetchAt);
  });

  it("the cap takes a stable prefix and only the selected bundles are fetched", () => {
    const src = primeBackend();
    /* Sorted, so the same functions lead every pass and none is re-fetched. */
    expect(src).toMatch(
      /const selected = functionSourceTruncated \? deployable\.slice\(0, limit\)/,
    );
    expect(src).toMatch(/for \(const bundle of selected\)/);
    /* The blob walk must never iterate the unfiltered list again. */
    expect(src).not.toMatch(/for \(const bundle of deployable\)/);
  });

  it("the runner asks the target, then caps what remains", () => {
    const src = runner();
    const askAt = src.indexOf("listProjectEdgeFunctionSlugs(existingRow.supabase_project_ref)");
    const snapAt = src.indexOf("await fetchPrimeBackendSnapshot(");
    expect(askAt).toBeGreaterThan(-1);
    expect(askAt).toBeLessThan(snapAt);
    expect(src).toMatch(/skipFunctionSlugs: liveFunctionSlugs/);
    expect(src).toMatch(/functionLimit: EDGE_FUNCTION_FETCH_LIMIT/);
    /* A failed listing must not be read as "the clone holds everything" — it
       resolves to an empty skip list, which fetches more, never less. */
    expect(src).toMatch(/\.catch\(\(\) => \[\]\)/);
  });

  it("a truncated pass can never mark the clone ready", () => {
    /* Otherwise the pipeline runs to the end holding 60 of 423 functions: a
       workspace that looks finished and is missing most of its backend. */
    const src = pipeline();
    const guardAt = src.indexOf("snapshot.functionSourceTruncated");
    expect(guardAt).toBeGreaterThan(-1);
    const branch = src.slice(guardAt, guardAt + 420);
    expect(branch).toMatch(/throw new BudgetPause\(/);
    /* Empty marker: the next pass is a full one that re-asks the project. */
    expect(branch).toMatch(/"",/);
  });
});

describe("a schema that is already built costs almost nothing to verify", () => {
  /* The tables stage applied ~700 `create table if not exists` statements on
     EVERY pass, against a clone that already held all of them. That consumed
     most of each invocation, so a full pass never finished the schema, always
     ended `partial` — and a partial pass may not proceed to the edge
     functions. The engine could complete the schema and never get past it. */
  it("skips the creation when every table is present, and says so", () => {
    const src = introspection();
    expect(src).toMatch(
      /const tablesAlreadyPresent = reconcile\(tableCounts\[0\], tableCounts\[1\]\)/,
    );
    expect(src).toMatch(/every table present — creation skipped, drift still checked/);
  });

  it("but the column-drift repair still runs, which is the point of the stage", () => {
    /* Equal counts do not mean equal tables: `create table if not exists`
       skips an existing table, so drift survives with the counts matching.
       Skipping the whole stage would skip the repair; skipping only the
       APPLICATION does not. */
    const src = introspection();
    const stageAt = src.indexOf('if (enterStage("tables"))');
    const driftAt = src.indexOf("diffMissingColumns(primeInfo", stageAt);
    const skipAt = src.indexOf("tablesAlreadyPresent", stageAt);
    expect(skipAt).toBeGreaterThan(-1);
    expect(driftAt).toBeGreaterThan(skipAt);
    /* The drift read must not be inside the skip branch. */
    expect(src).toMatch(/const cloneCols = await query\(cloneRef, Q\.columns\)/);
  });
});

describe("the emptiness scan is a reading, not a gate", () => {
  // The 2 Sep 2026 dry run died here twice, fifteen minutes apart. The schema
  // build reconciled every stage, returned, and the very next line counted
  // rows in all 649 tables over seven Management-API round trips — with no
  // deadline check in front of it and none inside its loop. A pass arriving
  // with the budget already spent was KILLED rather than paused, which costs
  // a 15-minute stall reclaim AND an attempt, so three passes exhausted the
  // row and failed a clone whose schema was complete.
  //
  // Nothing branches on the result: it is recorded as `rowsOnClone` and
  // `nonEmptyTables` on the introspection summary and read by no decision.
  const introspection = readFileSync("src/server/schema-introspection.server.ts", "utf8");
  const provisioning = readFileSync("src/server/backend-provisioning.server.ts", "utf8");

  it("stops at the deadline instead of running the worker out", () => {
    const fn = introspection.slice(
      introspection.indexOf("export async function verifyCloneIsEmpty"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    expect(body).toMatch(/deadlineAt\?:\s*number/);
    // The check has to be INSIDE the per-batch loop. In front of the loop it
    // only declines to start, which is not the case that killed the worker.
    const loopAt = body.indexOf("for (const group of chunk(tables, 100))");
    expect(loopAt).toBeGreaterThan(-1);
    expect(body.indexOf("pastDeadline(options?.deadlineAt)")).toBeGreaterThan(loopAt);
  });

  it("never reports a partial scan as a row count", () => {
    // A count that stopped early is a floor. Read as a total it certifies the
    // clone empty on the strength of whichever tables were scanned first.
    const fn = introspection.slice(
      introspection.indexOf("export async function verifyCloneIsEmpty"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    expect(body).toMatch(/empty:\s*complete && totalRows <=/);
    expect(provisioning).toMatch(/rowsOnClone: emptiness\?\.complete \? emptiness\.totalRows : null/);
  });

  it("hands the scan the budget that is left, not a fresh one", () => {
    const call = provisioning.slice(
      provisioning.indexOf("await verifyCloneIsEmpty("),
      provisioning.indexOf("await verifyCloneIsEmpty(") + 260,
    );
    expect(call).toMatch(/deadlineAt: input\.deadlineAt/);
  });

  it("checks the budget before a stage builds its statements, not only between batches", () => {
    // `applyStatements` guards the apply. Building the list is work too — the
    // grants stage reads ~8,900 rows out of `information_schema` — and a
    // resumed pass rebuilds the whole list before applying its next slice.
    const fn = introspection.slice(introspection.indexOf("const stageOrSkip = async ("));
    const body = fn.slice(0, fn.indexOf("\n  };") + 4);
    const reconciledAt = body.indexOf("alreadyReconciled(stage");
    const pauseAt = body.indexOf("pauseIfDue(");
    const buildAt = body.indexOf("await statements()");
    expect(reconciledAt).toBeGreaterThan(-1);
    expect(pauseAt).toBeGreaterThan(reconciledAt);
    expect(buildAt).toBeGreaterThan(pauseAt);
  });

  it("takes the resume batch exactly once per stage", () => {
    // `takeResumeBatch` CONSUMES the marker. Called twice — once for the
    // pause, once for the apply — the second answers 0 and the pass restarts
    // a stage at batch zero that it had already worked most of the way
    // through.
    const fn = introspection.slice(introspection.indexOf("const stageOrSkip = async ("));
    const body = fn.slice(0, fn.indexOf("\n  };") + 4);
    expect(body.split("takeResumeBatch(").length - 1).toBe(1);
  });
});

describe("a pass that built nothing must not spend its budget re-proving it", () => {
  // Measured on 3 Sep 2026, with the schema already complete on both clones:
  // a pass took ~16s snapshotting, ~19s re-verifying all twelve stages (every
  // one of them answering `alreadyReconciled`), and ~18s on the emptiness scan
  // and the ledger stamp — then arrived at the edge-function deploy loop with
  // enough budget for exactly ONE of 423 functions:
  //
  //   "deployed 1/60 edge functions this pass — the rest resume next tick"
  //
  // The loop is correct (it always deploys one, then checks the clock). It was
  // being starved. At one a pass, 423 functions is ~423 passes.
  const introspection = readFileSync("src/server/schema-introspection.server.ts", "utf8");
  const provisioning = readFileSync("src/server/backend-provisioning.server.ts", "utf8");

  it("skips the emptiness scan on a pass where every stage was already reconciled", () => {
    // A pass that applied no DDL cannot have changed what the previous pass
    // counted, so the count is a repetition — and it is spending the tail of
    // the budget that the deployment below is the only remaining use for.
    expect(provisioning).toMatch(
      /const builtSomething = result\.stages\.some\(\(st\) => st\.applied > 0 \|\| !st\.reconciled\)/,
    );
    expect(provisioning).toMatch(/const emptiness = builtSomething\s*\?\s*await verifyCloneIsEmpty\(/);
  });

  it("keeps the reading on the pass that does build the schema", () => {
    // Dropping it everywhere would be removing a control. It is kept exactly
    // where it means something.
    const call = provisioning.slice(provisioning.indexOf("const builtSomething"));
    expect(call.slice(0, 400)).toContain("verifyCloneIsEmpty(");
    expect(call.slice(0, 400)).toContain(": null");
  });

  it("asks the clone's ledger before re-stamping it", () => {
    const fn = introspection.slice(
      introspection.indexOf("export async function stampMigrationLedgerFromPrime"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    const askAt = body.indexOf("count(*)::int as n from supabase_migrations.schema_migrations");
    const insertAt = body.indexOf("insert into supabase_migrations.schema_migrations");
    expect(askAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(askAt);
    expect(body).toMatch(/return \{ stamped: 0, reconciled: true \}/);
  });

  it("still refuses an EMPTY prime ledger, and still stamps a short clone one", () => {
    // The reconcile check is about repetition, never about skipping the work.
    // A clone that is behind still gets stamped, and a prime with no ledger at
    // all still throws — that guard is what keeps a clone syncable.
    const fn = introspection.slice(
      introspection.indexOf("export async function stampMigrationLedgerFromPrime"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
    const throwAt = body.indexOf("has no rows in supabase_migrations.schema_migrations");
    const reconcileAt = body.indexOf("if (reconcile(rows.length");
    expect(throwAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeGreaterThan(throwAt);
    expect(body).toMatch(/reconcile\(rows\.length, num\(cloneLedger\[0\]\?\.n\)\)/);
  });

  it("says the ledger was already stamped rather than reporting zero", () => {
    // "stamped 0 migration ID(s)" is the exact sentence this function's own
    // guard exists to stop being printed by a swallowed failure. A skip must
    // not borrow it.
    expect(provisioning).toMatch(/stamp\.reconciled/);
    expect(provisioning).toMatch(/migration ledger already stamped/);
  });
});

describe("the pg_cron schedule is budgeted and asks the clone first", () => {
  // This prime schedules 47 jobs and each is a separate Management-API round
  // trip: 40-70 seconds against a 50-second budget. The step could never
  // finish inside one pass and began at the first job every time, so both
  // clones provisioned on 3 Sep 2026 sat on "Replicating pg_cron schedule
  // from prime..." until the stall reclaim took them, repeatedly — the same
  // closed loop the tables stage had.
  const provisioning = readFileSync("src/server/backend-provisioning.server.ts", "utf8");
  const fn = provisioning.slice(provisioning.indexOf("export async function replicateCronJobs"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);

  it("stops between jobs, never mid-job", () => {
    // An unschedule that lands without its reschedule leaves the clone with
    // the job GONE, which is worse than leaving it stale.
    const checkAt = body.indexOf("pastDeadline(deadlineAt)");
    const unscheduleAt = body.indexOf("cron.unschedule");
    expect(checkAt).toBeGreaterThan(-1);
    expect(unscheduleAt).toBeGreaterThan(checkAt);
    expect(body).toMatch(/status: "deferred"/);
  });

  it("asks the clone what it already schedules, in one query", () => {
    expect(body).toMatch(/select jobname, schedule, command, active from cron\.job/);
    expect(body.split("from cron.job").length - 1).toBe(1);
  });

  it("still repairs a job whose schedule or command drifted", () => {
    // 22 of this prime's jobs carry an anon key inline that has to be
    // rewritten. Skipping every job that merely EXISTS would stop that repair.
    expect(body).toMatch(
      /already\.schedule === job\.schedule && already\.command === command && already\.active === job\.active/,
    );
  });

  it("puts every job back on the write path when the clone cannot be read", () => {
    const readBlock = body.slice(body.indexOf("const existing = new Map"), body.indexOf("const results"));
    expect(readBlock).toMatch(/catch \{/);
    expect(readBlock).not.toMatch(/throw/);
  });

  it("never lets a deferral hide a failure", () => {
    // The failure line and the pause both write `status_detail`, and the pause
    // is written last. On the Preflight clone that made two jobs which can
    // never replicate look exactly like two that merely ran out of time — on
    // every pass, for ever, while the count of "carried" jobs oscillated and
    // the clone's schedule stayed at 45 of 47.
    const callSite = provisioning.slice(
      provisioning.indexOf("const deferredCron = cronJobs.filter"),
    );
    const block = callSite.slice(0, 1400);
    expect(block).toMatch(/const failedCron = cronJobs\.filter\(\(c\) => c\.status === "failed"\)/);
    expect(block).toMatch(/failedCron\.length > 0/);
    // The names and the reasons, not just a count: "2 failed" sends nobody
    // anywhere.
    expect(block).toMatch(/c\.jobname/);
    expect(block).toMatch(/c\.error/);
  });

  it("pauses on a deferral OUTSIDE the catch that would swallow it", () => {
    // The cron block is wrapped in a try/catch that reports any throw as
    // "Cron replication skipped". A BudgetPause thrown inside it would be
    // reported as a decision not to do the work, and the pass would run on and
    // mark the clone ready holding a partial schedule.
    const callSite = provisioning.slice(provisioning.indexOf("Replicating pg_cron schedule from prime"));
    const catchAt = callSite.indexOf("Cron replication skipped");
    const deferredAt = callSite.indexOf("const deferredCron");
    expect(catchAt).toBeGreaterThan(-1);
    expect(deferredAt).toBeGreaterThan(catchAt);
    const block = callSite.slice(deferredAt, deferredAt + 900);
    // The guard itself, not merely a BudgetPause somewhere near it: a
    // short-circuited condition keeps both the `if` and the `throw` while
    // never pausing, and the clone is marked ready on a partial schedule.
    expect(block).toMatch(/if \(deferredCron\.length > 0\) \{/);
    expect(block).toMatch(/throw new BudgetPause/);
  });
});

describe("every per-item step in the tail is budgeted, not just guarded in front", () => {
  // The class, not the instance. Each step in the provisioning tail has a
  // `pauseIfDue` in FRONT of it, so a pass with no budget declines to start —
  // but a step whose per-item work exceeds one budget was killed rather than
  // paused, and began at its first item again on the next pass. A kill costs
  // a 15-minute stall reclaim AND an attempt; a pause costs 60 seconds.
  //
  // Measured on the Preflight clone, 3 Sep 2026: 47 cron jobs (~40-70s) and
  // 95 realtime tables (~75s), both against a 50-second budget, both dying on
  // the step, over and over.
  const provisioning = readFileSync("src/server/backend-provisioning.server.ts", "utf8");

  const loopBody = (fnName: string) => {
    const fn = provisioning.slice(provisioning.indexOf(`export async function ${fnName}`));
    return fn.slice(0, fn.indexOf("\n}\n") + 2);
  };

  it.each([
    ["deployEdgeFunctions", "deadlineAt"],
    ["replicateCronJobs", "deadlineAt"],
    ["replicateRealtimePublication", "deadlineAt"],
  ])("%s takes the invocation deadline and checks it in its loop", (fnName, param) => {
    const body = loopBody(fnName);
    expect(body).toContain(param);
    expect(body).toMatch(/pastDeadline\(deadlineAt\)/);
    const loopAt = body.search(/\n {2}for \(/);
    expect(loopAt).toBeGreaterThan(-1);
    expect(body.indexOf("pastDeadline(deadlineAt)")).toBeGreaterThan(loopAt);
  });

  it("the realtime step asks the clone what it already publishes", () => {
    const body = loopBody("replicateRealtimePublication");
    expect(body).toMatch(/fetchRealtimePublicationTables\(cloneRef\)/);
    expect(body).toMatch(/publishedOnClone\.has\(/);
  });

  it("a deferred realtime table is not reported as replicated", () => {
    // "replicated" on an incomplete publication marks a clone ready while
    // every channel subscribed to a missing table is silently dead.
    const body = loopBody("replicateRealtimePublication");
    expect(body).toMatch(/deferred\.length > 0\s*\?\s*"partial"/);
  });

  it.each([
    ["cron", "const deferredCron = cronJobs.filter", /failedCron\.length > 0/],
    ["realtime", "const rtFailures = realtimePublication.failures", /rtFailures\.length > 0/],
  ])("%s: a deferral never hides a failure", (_name, marker, guard) => {
    // Both deferrals are LATE writers to `status_detail` — the last thing a
    // pass does — so anything they overwrite is lost for the life of the
    // clone. Measured: cron held at 45 of 47 and the realtime publication at
    // 22 of 95, each with the reason overwritten by "carried to the next
    // pass". A step that can never complete must not read as a slow one.
    const at = provisioning.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const block = provisioning.slice(at, at + 1600);
    expect(block).toMatch(guard);
    expect(block).toMatch(/FAILED and will not/);
    expect(block).toMatch(/throw new BudgetPause/);
  });

  it("pauses on a realtime deferral outside the catch that records a failure", () => {
    const callSite = provisioning.slice(
      provisioning.indexOf("Replicating realtime publication from prime"),
    );
    const catchAt = callSite.indexOf('status: "failed"');
    const deferAt = callSite.indexOf("realtimePublication.deferred.length > 0");
    expect(catchAt).toBeGreaterThan(-1);
    expect(deferAt).toBeGreaterThan(catchAt);
    expect(callSite.slice(deferAt, deferAt + 1600)).toMatch(/throw new BudgetPause/);
  });
});

describe("a result that is computed must be recorded somewhere a person looks", () => {
  // `runBackendProvisioning` returns `cronJobs` and `realtimePublication` —
  // every job and every table, each failure carrying the error it gave — and
  // the caller that writes the row never read either. Edge functions and
  // secret shells have columns; these two had nothing, so a per-item failure
  // existed ONLY in a status line the next step overwrote.
  //
  // That is why two failing cron jobs and seventy failing publication adds
  // were undiagnosable on the Preflight clone rather than merely badly
  // worded: the words were the only copy.
  const fns = readFileSync("src/lib/backend-provisioning.functions.ts", "utf8");

  it("writes the cron and realtime results onto the row", () => {
    expect(fns).toMatch(/cron_jobs: result\.cronJobs/);
    expect(fns).toMatch(/realtime_publication: result\.realtimePublication/);
  });

  it("carries them with the parity report rather than replacing it", () => {
    // The diffs are what an operator opens the report FOR; the per-item
    // results are the reasons behind them. Losing either half is the defect.
    const at = fns.indexOf("parity_report: parity");
    expect(at).toBeGreaterThan(-1);
    const block = fns.slice(at, at + 500);
    expect(block).toMatch(/\.\.\.parity/);
    expect(block).toMatch(/replication:/);
  });

  it("still writes null when parity could not run", () => {
    // A replication result is not a parity report. Inventing one from the
    // half we happen to hold would make `parity_checked_at` a lie.
    const at = fns.indexOf("parity_report: parity");
    const block = fns.slice(at, at + 600);
    expect(block).toMatch(/:\s*null,/);
    expect(fns).toMatch(/parity_checked_at: parity \? new Date\(\)\.toISOString\(\) : null/);
  });
});
