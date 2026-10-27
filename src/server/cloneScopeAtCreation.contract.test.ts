import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/*
  LINE COMMENTS ONLY, for the reason `cloneProvisioningIdempotency.contract.test.ts`
  gives: a commented-out line must not satisfy an assertion about code.
*/
const source = readFileSync(new URL("./clone-provisioning.server.ts", import.meta.url), "utf8");
const bare = source.replace(/\/\/[^\n]*/g, " ");

/**
 * Every clone `provisionCloneCore` creates is a MIRROR of the tree it was
 * created from.
 *
 * A clone created with no CRM line — the signed-agreement path, which records
 * none — used to keep the prime-sourced, module scope. Its repository was
 * created from the prime's whole tree, and module scope then let through only
 * the later changes inside its installed modules' globs, so everything else
 * was frozen at creation. Measured 27 Oct 2026 with the engine's own scope
 * functions: 3,624 app-code files and 285 edge functions a launch-tier
 * agreement clone would never have received.
 */
describe("a new clone is a mirror, whatever path created it", () => {
  const insertAt = bare.indexOf('.from("clones")\n    .insert({');

  it("anchors on the one insert the pipeline makes", () => {
    expect(insertAt).toBeGreaterThan(-1);
    expect(bare.indexOf('.from("clones")\n    .insert({', insertAt + 1)).toBe(-1);
  });

  it("writes the scope in the insert itself: the line's, else mirror", () => {
    const insert = bare.slice(insertAt, bare.indexOf(".select()", insertAt));
    expect(insert).toContain('sync_scope: lineage?.sync_scope ?? "mirror",');
    // The scope is written outside the lineage-only spread, so a clone with
    // no parent gets it too.
    const spread = insert.slice(insert.indexOf("...(lineage"));
    expect(spread).not.toContain("sync_scope");
  });

  it("never writes a module scope", () => {
    expect(bare).not.toMatch(/sync_scope:\s*["']modules["']/);
  });

  it("starts no module-glob provision cascade, since a mirror already holds every module's files", () => {
    expect(bare).not.toContain("clone_provision_modules");
  });

  it("and the column default agrees, so no other insert can make a module-scoped clone", () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .filter((sql) => /ALTER COLUMN sync_scope SET DEFAULT/i.test(sql))
      .at(-1);
    expect(latest).toMatch(/ALTER COLUMN sync_scope SET DEFAULT 'mirror'/);
  });
});
