import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";

/**
 * A dry run has exactly one job: describe what the cascade WOULD do, without
 * doing any of it. Both halves of that are source-level properties, and both
 * are worth pinning — the engine is one function and a flag, so the way this
 * goes wrong is a write that slips above the boundary or a second walk growing
 * back beside it.
 */
const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
const code = stripNonCode(engine);
/* Comments stripped: the module's header QUOTES the comparison it stopped
   making, and a test that trips over its own explanation is a test that gets
   weakened rather than a rule that gets kept. */
const dryrun = stripNonCode(readFileSync("src/server/cascade-dryrun.server.ts", "utf8"));

/** Everything in `processClone` that changes something on GitHub. */
const WRITES = [
  "octokit.git.createTree(",
  "octokit.git.createCommit(",
  "octokit.git.createRef(",
  "octokit.git.updateRef(",
  "octokit.pulls.create(",
  "octokit.pulls.update(",
  "octokit.pulls.merge(",
];

describe("the dry run stops before the write boundary", () => {
  const boundary = code.indexOf("if (dryRun) {");

  it("returns before anything is created", () => {
    expect(boundary).toBeGreaterThan(-1);
    for (const write of WRITES) {
      const at = code.indexOf(write);
      expect(at, `${write} must sit AFTER the dry-run return`).toBeGreaterThan(boundary);
    }
  });

  it("uploads no blob — the one write that happens per file, before the boundary", () => {
    /* `createBlob` runs inside the prepare loop, which a dry run still needs
       for the content holds and the held-file guards. It is the one write that
       cannot be handled by returning early, so it is guarded at the call. */
    expect(code).toContain("const blobSha = dryRun");
    expect(code.indexOf("octokit.git.createBlob(")).toBeLessThan(boundary);
  });

  it("opens no drift issue in notify mode", () => {
    expect(code).toContain('if (mode === "notify" && !dryRun)');
  });

  it("writes to the database on no path at all", () => {
    /* The dry run relies on this rather than on a second flag: if
       `processClone` ever gained a write, a rehearsal would start mutating
       Mission Control's own record of a cascade that never happened. */
    const fn = code.slice(code.indexOf("export async function processClone("));
    for (const write of [".insert(", ".upsert(", ".delete("]) {
      expect(fn.includes(`supabase${write}`)).toBe(false);
    }
    expect(/supabase\s*\n?\s*\.from\([^)]*\)\s*\n?\s*\.update\(/.test(fn)).toBe(false);
  });

  it("defaults to writing — a flag that defaults to safe would silently do nothing", () => {
    expect(code).toContain("const dryRun = args.dryRun === true;");
  });
});

describe("the dry run is the engine, not a second walk", () => {
  it("calls processClone rather than enumerating files itself", () => {
    expect(dryrun).toContain("processClone({");
    expect(dryrun).toContain("dryRun: true");
  });

  it("no longer compares decoded strings", () => {
    /* Two different binaries decode to the same run of replacement characters,
       so this comparison reported a changed image as unchanged. The engine
       stopped doing it; this had kept doing it. */
    expect(dryrun).not.toContain("cf.content !== pf.content");
  });

  it("no longer probes a fixed slice of the files and calls it the blast radius", () => {
    expect(dryrun).not.toContain("MAX_FILES_TO_PROBE_PER_CLONE");
  });

  it("reads the clone's sync scope, so a mirror is not asked for module globs", () => {
    expect(dryrun).toContain("sync_scope");
  });

  it("reports a refusal as a result rather than losing the clone", () => {
    /* `requireExclusions` and `assertMirrorPolicy` both throw, and both are
       exactly what an operator needs to see before firing rather than during. */
    expect(dryrun).toContain("Cascade would refuse:");
  });
});
