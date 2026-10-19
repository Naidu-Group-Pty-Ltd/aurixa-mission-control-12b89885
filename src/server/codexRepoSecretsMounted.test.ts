// The Codex secret sync is one implementation, reached from every door it
// was given: the Settings buttons, the on-demand hook, the nightly run
// (before the scan) and clone provisioning. Each door works with the call
// deleted — it just stops keeping the secrets where they belong — so the
// calls themselves are asserted, against code rather than comments.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

const code = (path: string) => stripComments(readFileSync(path, "utf8"));

describe("the nightly run", () => {
  const nightly = code("src/routes/hooks.codex-nightly.tsx");

  it("syncs the secrets before it dispatches the scan that reads them", () => {
    const sync = nightly.indexOf("reconcileCodexRepoSecrets(");
    const scan = nightly.indexOf("runNightlyScans()");
    expect(sync).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(sync);
  });

  it("records only what changed, and never fails the night over it", () => {
    const call = nightly.slice(nightly.indexOf("reconcileCodexRepoSecrets("));
    expect(call).toMatch(
      /^reconcileCodexRepoSecrets\(\{\s*triggerSource: "nightly",\s*recordClean: false,?\s*\}\)\.catch\(/,
    );
  });
});

describe("the on-demand hook", () => {
  const hook = code("src/routes/hooks.codex-repo-secrets.tsx");

  it("is cron-authenticated and runs both halves, recording every target", () => {
    expect(hook).toContain("verifyCronAuth(request)");
    expect(hook).toMatch(
      /reconcileCodexRepoSecrets\(\{\s*triggerSource: "mission-control",\s*recordClean: true,?\s*\}\)/,
    );
  });
});

describe("clone provisioning", () => {
  const provisioning = code("src/server/clone-provisioning.server.ts");

  it("checks a repository it created, and only one it created", () => {
    const at = provisioning.indexOf("removeCodexSecretsFromClones(");
    expect(at).toBeGreaterThan(-1);
    const before = provisioning.slice(0, at);
    expect(before.slice(before.lastIndexOf("if ("))).toMatch(/^if \(githubUrl\)/);
    expect(provisioning.slice(at)).toMatch(
      /^removeCodexSecretsFromClones\(\{\s*cloneIds: \[inserted\.id\],\s*triggerSource: "provisioning",/,
    );
  });

  it("never lets the check fail provisioning", () => {
    const at = provisioning.indexOf("removeCodexSecretsFromClones(");
    const call = provisioning.slice(at, provisioning.indexOf("\n  }\n", at));
    expect(call).toContain(".catch(");
    expect(call).not.toMatch(/return \{ ok: false/);
  });
});

describe("the Settings buttons", () => {
  const functions = code("src/lib/github-secrets.functions.ts");

  it("share the one implementation rather than keeping a second", () => {
    // Reading the history is the listing's job; writing it, and syncing, is not.
    expect(functions).not.toMatch(/syncRepoSecrets\(/);
    expect(functions).not.toMatch(/from\("github_secret_syncs"\)\s*\.insert/);
    expect(functions).toContain("syncPrimeCodexSecrets(");
    expect(functions.match(/removeCodexSecretsFromClones\(/g)).toHaveLength(2);
  });
});
