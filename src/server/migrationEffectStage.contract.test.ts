/**
 * A new clone gets the prime's approved privilege and policy files at build
 * (the owner's decision of 30 Oct 2026), through the stage the pipeline runs
 * once its schema is verified and its ledger stamped.
 *
 * Asserted on the source with comments stripped, as provisioning's other
 * contracts are. What the stage itself does is
 * `migrationEffectReplay.server.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

const pipeline = stripComments(readFileSync("src/server/backend-provisioning.server.ts", "utf8"));
const runner = stripComments(readFileSync("src/lib/backend-provisioning.functions.ts", "utf8"));
const route = stripComments(readFileSync("src/routes/hooks.clone-effect-replay.tsx", "utf8"));
const cron = readFileSync("scripts/check-cron-coverage.mjs", "utf8");

const fn = pipeline.slice(pipeline.indexOf("export async function provisionCloneBackend"));
const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("the pipeline runs the stage after the stamp and before the edge functions", () => {
  const stage = () => at(fn, "input.replayMigrationEffects(projectRef)");

  it("only after the schema is verified and the ledger stamped", () => {
    expect(stage()).toBeGreaterThan(at(fn, "stampMigrationLedgerFromPrime(projectRef, primeRef)"));
    expect(stage()).toBeGreaterThan(at(fn, "await input.onSchemaVerified?.()"));
    // On a pass that skipped introspection too: the stage sits after the
    // whole schema block, not inside the branch that builds it.
    expect(stage()).toBeGreaterThan(at(fn, "const replay = await applyPrimeMigrations("));
    expect(stage()).toBeLessThan(at(fn, 'pauseIfDue("deploying edge functions")'));
  });

  it("only for the introspected schema, and only when a caller supplied it", () => {
    const gate = fn.lastIndexOf("if (", stage());
    expect(fn.slice(gate, stage())).toMatch(
      /if \(strategy === "introspection" && input\.replayMigrationEffects\)/,
    );
  });

  it("pauses OUTSIDE its catch when the stage stopped at the budget, naming no resume stage", () => {
    const block = fn.slice(
      fn.lastIndexOf("if (", stage()),
      at(fn, 'pauseIfDue("deploying edge functions")'),
    );
    const caught = block.indexOf("} catch (err) {");
    const pause = block.indexOf("if (effects?.stoppedAtDeadline)");
    expect(caught).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(caught);
    // No resume stage: the stored marker is left alone, and the next pass asks the clone.
    // One argument: what it decided, or that it had not begun.
    expect(block.slice(pause)).toMatch(
      /throw new BudgetPause\(\s*effects\.ran\s*\?\s*`\$\{effects\.line\}[^`]*`\s*:\s*"replaying the prime's approved privilege and policy files",?\s*\)/,
    );
    // And no pause of its own in front of the stage: whether the stage is
    // owed is known only inside it, and a pass that does not owe it must not
    // pause in its name.
    expect(block).not.toMatch(/pauseIfDue\(/);
  });

  it("the engine checks the budget once it knows the stage is owed, before it reads anything", () => {
    const engine = stripComments(
      readFileSync("src/server/migrationEffectReplay.server.ts", "utf8"),
    );
    const stageFn = engine.slice(engine.indexOf("export async function runEffectReplayStage"));
    const owed = stageFn.indexOf("settledEarlier(records ?? []");
    const budget = stageFn.indexOf("if (pastDeadline(input.deadlineAt)) {");
    const resolve = stageFn.indexOf("resolveCloneSecretTarget(supabase, input.cloneId)");
    expect(owed).toBeGreaterThan(-1);
    expect(budget).toBeGreaterThan(owed);
    expect(resolve).toBeGreaterThan(budget);
    expect(stageFn.slice(budget, budget + 160)).toContain("stoppedAtDeadline: true");
  });

  it("says what it did in the status line, and a failure never fails the pass", () => {
    const block = fn.slice(stage() - 200, at(fn, 'pauseIfDue("deploying edge functions")'));
    expect(block).toContain('if (effects.ran) await onStatusUpdate?.("migrating", effects.line)');
    expect(block).toMatch(/Migration effect stage skipped:/);
  });
});

describe("the runner supplies the stage", () => {
  const supplied = () => runner.slice(at(runner, "replayMigrationEffects: async (ref: string) =>"));

  it("runs the engine against the project the pass is building, at the snapshot's commit", () => {
    const call = supplied().slice(0, 700);
    expect(call).toContain("runEffectReplayStage(supabase, {");
    expect(call).toContain("projectRef: ref,");
    expect(call).toContain("expectedSha: snapshot.sourceSha,");
    expect(call).toContain("deadlineAt: input.deadlineAt ?? null,");
  });

  it("answers to the stamp this pass records, or the one the row already holds", () => {
    expect(supplied().slice(0, 700)).toContain(
      "stampedAt: verifiedAtThisPass ?? existingRow?.schema_verified_at ?? null,",
    );
    const verified = runner.slice(at(runner, "onSchemaVerified: async () => {"));
    const set = verified.indexOf("verifiedAtThisPass = new Date().toISOString();");
    const write = verified.indexOf(".update({ schema_verified_at: verifiedAtThisPass })");
    expect(set).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(set);
  });
});

describe("/hooks/clone-effect-replay", () => {
  it("authenticates before it reads anything, and names its GitHub lane", () => {
    const auth = at(route, "const auth = verifyCronAuth(request);");
    expect(at(route, "if (!auth.ok) return auth.response;")).toBeGreaterThan(auth);
    expect(at(route, 'beginGithubLane("clone-effect-replay")')).toBeGreaterThan(auth);
    expect(at(route, "reconcileCloneEffectReplays(supabaseAdmin, {")).toBeGreaterThan(auth);
  });

  it("asks the installation's window first, as an actor, and stands down without touching a clone", () => {
    const spend = at(
      route,
      'decideSpend({ role: "actor", remaining: await readGitHubRemaining() })',
    );
    const standDown = at(route, "if (!spend.proceed) {");
    expect(standDown).toBeGreaterThan(spend);
    expect(at(route, "reconcileCloneEffectReplays(supabaseAdmin, {")).toBeGreaterThan(standDown);
  });

  it("takes a dry run and one clone, and refuses a malformed option before it runs", () => {
    // Driven through the real handler in `cloneEffectReplayRoute.test.ts`.
    expect(route).toContain("const dryRun = body.dryRun === true;");
    const refusal = at(route, 'return refuse("dryRun must be true or false");');
    expect(at(route, "reconcileCloneEffectReplays(supabaseAdmin, {")).toBeGreaterThan(refusal);
  });

  it("is declared unscheduled, with what drives the new clones' half of it", () => {
    const entry = cron.slice(cron.indexOf('"clone-effect-replay"'));
    expect(entry.slice(0, 700)).toContain("/hooks/backend-provisioning-drain");
  });
});
