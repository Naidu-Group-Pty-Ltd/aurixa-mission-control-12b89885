/**
 * Where the watch runs and what it may do are properties of the code's shape,
 * so they are read from the source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync("src/server/cloneCiWatch.server.ts", "utf8");
const hook = readFileSync("src/routes/hooks.clone-deployer-declaration-reconcile.tsx", "utf8");

describe("the clone CI watch", () => {
  it("rides the reconcile hook, after the passes it must never fail", () => {
    const credentials = hook.indexOf("reconcileCloneCiCredentials(");
    const watch = hook.indexOf("sweepCloneCi(");
    expect(credentials).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(credentials);
    // In a try of its own: a watch that throws must not cost the declaration
    // or the credential their response.
    const own = hook.slice(hook.lastIndexOf("try {", watch), watch);
    expect(own).not.toContain("reconcileCloneCiCredentials(");
  });

  it("yields the installation budget before it reads, and names its lane", () => {
    const watch = hook.indexOf("sweepCloneCi(");
    const before = hook.slice(hook.lastIndexOf("try {", watch), watch);
    expect(before).toContain('decideSpend({ role: "scan"');
    expect(before).toContain('beginGithubLane("clone-ci-watch")');
  });

  it("reports and never repairs: it makes no write to any repository", () => {
    for (const write of [
      "createOrUpdate",
      "createWorkflowDispatch",
      "reRunWorkflow",
      "enableWorkflow",
      "deleteFile",
      "createCommit",
      "updateRef",
      "createPullRequest",
      ".request(",
    ]) {
      expect(server, write).not.toContain(write);
    }
  });

  it("announces under its own kind, never drift_high's", () => {
    expect(server).toContain('kind: "clone_ci_attention"');
    expect(server).not.toContain("drift_high");
  });
});
