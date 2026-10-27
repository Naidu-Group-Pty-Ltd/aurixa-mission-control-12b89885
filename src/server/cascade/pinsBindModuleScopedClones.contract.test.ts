/**
 * A library pin binds only a clone it can change.
 *
 * A pin swaps one module's globs for a library entry's files
 * (`installedGlobs.server.ts`), and a mirror is delivered its whole tree
 * whatever it installed. The pass's pin pre-flight failed every delivery to a
 * clone holding a pin it judged stale, mirrors included, so one stale pin on a
 * mirror (the fleet manager's bulk-pin dialog offers mirrors) would have held
 * the whole tree back for a setting that changes nothing there. No pin existed
 * on 27 Oct 2026, and no library entry was approved to pin.
 *
 * Asserted on the source, comments stripped, as the engine's other contracts are.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

describe("a library pin binds only a module-scoped clone", () => {
  it("fails no mirror's delivery over a pin", () => {
    expect(engine).toContain(
      'const pinErrors = clone.sync_scope === "mirror" ? undefined : blockedClones.get(clone.id);',
    );
    expect(engine.match(/blockedClones\.get\(clone\.id\)/g)).toHaveLength(1);
  });

  it("because a mirror's candidates are its whole tree, read before any module glob", () => {
    const mirror = engine.slice(
      engine.indexOf("if (isMirror) {\n    const [primeTree, cloneTree]"),
      engine.indexOf('scopeLabel = "mirror";'),
    );
    expect(mirror.length).toBeGreaterThan(200);
    expect(mirror).toContain("for (const path of primeTree.entries.keys())");
    expect(mirror).not.toContain("installedGlobs");
  });
});
