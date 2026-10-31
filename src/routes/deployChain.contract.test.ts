/**
 * A deployment that advances takes its next step in the same invocation, and
 * only inside a bounded window.
 *
 * The deployment drain advanced one state per tick, so seven states cost seven
 * minutes even where each took seconds (measured on
 * `tutorial-demo-orrimere-c158c7`, 30 Oct 2026). Structural, reading the
 * source: what matters is the order of a claim against a clock and the guard
 * on the claim, and a Supabase double would agree with wrong code on both.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@/server/sourceComments.pure";

const src = stripComments(
  readFileSync(join(process.cwd(), "src/routes/hooks.deployment-drain.tsx"), "utf8"),
);

const constant = (name: string): number => {
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(src);
  expect(m, `could not read ${name}`).not.toBeNull();
  return Number(m![1].replace(/_/g, ""));
};

const bodyOf = (fn: string): string => {
  const at = src.indexOf(`async function ${fn}(`);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 2);
};

describe("deployment step chaining", () => {
  it("chains only inside a window that leaves the request room to finish", () => {
    // The job's patience is 60 s; a step started at the edge of the window must
    // still finish, and the sweeps after the rows must still run.
    expect(constant("DEPLOY_CHAIN_WINDOW_MS")).toBeLessThanOrEqual(30_000);
    expect(constant("MAX_CHAINED_STEPS")).toBeGreaterThan(0);
    expect(constant("MAX_CHAINED_STEPS")).toBeLessThanOrEqual(6);
  });

  it("chains only a step that ADVANCED, and only within the window and the cap", () => {
    const drain = bodyOf("drain");
    expect(drain).toMatch(/const startedAt = Date\.now\(\);/);
    expect(drain).toMatch(
      /outcome\.kind === "advance" &&\s*chained < MAX_CHAINED_STEPS &&\s*Date\.now\(\) - startedAt < DEPLOY_CHAIN_WINDOW_MS\s*\?\s*await claimNextStep\(current\.clone_id\)\s*:\s*null/,
    );
    // Every step, chained or not, is finalized: the status is written in one place.
    const loopAt = drain.indexOf("while (current)");
    expect(loopAt).toBeGreaterThan(-1);
    expect(drain.slice(loopAt)).toMatch(/await finalize\(current, outcome\)/);
  });

  it("re-claims through the same guard as the claim, and says when it could not read", () => {
    const next = bodyOf("claimNextStep");
    expect(next).toMatch(/\.is\("worker_started_at", null\)/);
    expect(next).toMatch(/\.in\("status", CLAIMABLE\)/);
    expect(next).toMatch(/\.lte\("next_attempt_at", nowIso\)/);
    // A fault is not a lost race.
    expect(next).toMatch(/if \(claimError\)\s*\{\s*throw new Error\(/);
  });
});
