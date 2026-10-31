/**
 * A backend marked `ready` stays ready while its module migrations run.
 *
 * The module block runs after the ready write, and it was handed the runner's
 * `updateStatus`, which writes `status`. `applyModuleMigrations` reports each
 * module as `migrating`, so a finished backend went back to `migrating` and
 * nothing wrote `ready` again — the drain had already stamped it finished,
 * the fleet lane read `migrating` as in flight and withheld every later prime
 * migration, and repair required `ready`. Structural: what is asserted is
 * which callback reaches the call and what that callback may write.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const runner = stripComments(
  readFileSync(join(process.cwd(), "src/lib/backend-provisioning.functions.ts"), "utf8"),
);

describe("module migrations after the ready write", () => {
  const blockAt = runner.indexOf("const moduleIds = input.moduleIds ?? [];");
  const block = runner.slice(blockAt, runner.indexOf("const failedModules", blockAt));

  it("are handed a callback that writes the detail, never the status", () => {
    expect(blockAt).toBeGreaterThan(-1);
    expect(block).toMatch(/applyModuleMigrations\(result\.projectRef, inputs, moduleProgress\)/);
    expect(block).not.toMatch(/applyModuleMigrations\([^)]*updateStatus/);
    const cb = block.slice(block.indexOf("const moduleProgress"), block.indexOf("try {"));
    expect(cb).toMatch(/\.update\(\{ status_detail: detail \}\)/);
    // No `status` key in anything it writes (its own `_status` parameter is unused).
    expect(cb).not.toMatch(/[{,]\s*status:/);
  });

  it("a module that cannot run is a module result, never a failed backend", () => {
    expect(block).toMatch(/try \{\s*moduleApplyResults = await applyModuleMigrations\(/);
    expect(block).toMatch(/\} catch \(moduleErr\) \{/);
  });

  it("run only after the backend has been written ready", () => {
    const readyAt = runner.indexOf('status: "ready" as const');
    expect(readyAt).toBeGreaterThan(-1);
    expect(blockAt).toBeGreaterThan(readyAt);
  });
});
