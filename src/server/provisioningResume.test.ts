import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mapPool } from "./prime-backend.server";
import { BudgetPause, pastDeadline } from "./provisioningBudget";

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

describe("the snapshot fetches blobs pooled, never serially", () => {
  it("migrations and function bundles both go through mapPool", () => {
    const src = primeBackend();
    const fn = src.slice(src.indexOf("export async function fetchPrimeBackendSnapshot"));
    expect(fn).toMatch(/await mapPool\(migrationMetas/);
    expect(fn).toMatch(/await mapPool\(neededRels/);
    /* The defect's exact shape: one awaited round trip per iteration of a
       bare for-loop. Neither loop may come back. */
    expect(fn).not.toMatch(/for \(const meta of migrationMetasFromBlobs/);
    expect(fn).not.toMatch(/files\.push\(\{ path: rel, contentBase64: await getContent/);
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

  it("introspection pauses between stages, and stage 1 never pauses", () => {
    const src = introspection();
    const body = src.slice(src.indexOf("export async function replicateSchemaByIntrospection"));
    const pauses = body.match(/pauseIfDue\(/g) ?? [];
    /* One definition plus one call per stage from sequences onward. */
    expect(pauses.length).toBeGreaterThanOrEqual(11);
    /* The first stage must run unconditionally, or a recycled invocation can
       spin without ever moving the job. */
    const enums = body.indexOf('await say("Introspecting prime: enum types...")');
    const firstPauseCall = body.indexOf("pauseIfDue(", body.indexOf("};") + 1);
    expect(enums).toBeGreaterThan(-1);
    expect(firstPauseCall).toBeGreaterThan(enums);
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
