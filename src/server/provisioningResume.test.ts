import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mapPool } from "./prime-backend.server";
import { BudgetPause, isUpstreamRateLimit, pastDeadline } from "./provisioningBudget";

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
    expect(fn).toMatch(/files: bundlePaths\.map\(\(rel\) => fileByPath\.get\(rel\)!\)/);
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
    expect(fn).toMatch(/pauseIfDue\?:\s*\(about: string\) => void/);
    expect(fn).toMatch(/if \(i > 0\) pauseIfDue\?\./);
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
    expect(introspection()).toMatch(/throw new BudgetPause\(about, reachedStage\)/);
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
    expect(isUpstreamRateLimit(Object.assign(new Error("Too Many Requests"), { status: 429 }))).toBe(
      true,
    );
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
    expect(src).toMatch(
      /upstreamLimited \? \{ attempts: Math\.max\(0, \(claimed\.attempts \?\? 0\) - 1\) \} : \{\}/,
    );
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
    const helper = src.slice(src.indexOf("const stageOrSkip ="), src.indexOf("await ensureApplyHelper"));
    expect(helper).toMatch(/statements: \(\) => Promise<readonly string\[\]> \| readonly string\[\]/);
    expect(helper).toMatch(/const done = await alreadyReconciled\(stage, primeRef, cloneRef\)/);
    expect(helper).toMatch(/if \(done\) return done;/);
    expect(helper).toMatch(/await statements\(\)/);
  });
});
