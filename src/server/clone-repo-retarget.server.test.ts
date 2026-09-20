import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { REPOSITORY_INVARIANTS } from "./cascade/repositoryInvariants.pure";
import {
  DEPENDABOT_CONFIG_PATH,
  rewriteConfigTomlProjectId,
  configTomlNamesForeignProject,
  stripWorkflowProjectRefDefault,
  workflowHasProjectRefDefault,
} from "./clone-repo-retarget.server";

const PRIME = "dduzbchuswwbefdunfct";
const CLONE = "plisdzywzleljorrphxv";

describe("rewriteConfigTomlProjectId", () => {
  it("points project_id at the clone", () => {
    const out = rewriteConfigTomlProjectId(`project_id = "${PRIME}"\n`, CLONE);
    expect(out).toBe(`project_id = "${CLONE}"\n`);
  });

  it("leaves the [functions.*] blocks alone", () => {
    // config.toml carries one block per edge function — 423 on this prime.
    // A blanket replace of the ref would corrupt every one of them.
    const toml = [
      `project_id = "${PRIME}"`,
      "",
      "[functions.aml-cases]",
      "verify_jwt = false",
      "",
      "[functions.custom-auth-login]",
      "verify_jwt = false",
      "",
    ].join("\n");
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out).toContain("[functions.aml-cases]");
    expect(out).toContain("[functions.custom-auth-login]");
    expect(out.match(/verify_jwt = false/g)).toHaveLength(2);
    expect(out).toContain(`project_id = "${CLONE}"`);
    expect(out).not.toContain(PRIME);
  });

  it("rewrites only the first assignment", () => {
    const toml = `project_id = "${PRIME}"\n# project_id = "${PRIME}"\n`;
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out.match(new RegExp(CLONE, "g"))).toHaveLength(1);
  });

  it("tolerates leading whitespace", () => {
    expect(rewriteConfigTomlProjectId(`  project_id = "${PRIME}"`, CLONE)).toContain(CLONE);
  });
});

describe("configTomlNamesForeignProject", () => {
  it("is true while the file names another project", () => {
    expect(configTomlNamesForeignProject(`project_id = "${PRIME}"`, CLONE)).toBe(true);
  });

  it("is false once it names our own", () => {
    expect(configTomlNamesForeignProject(`project_id = "${CLONE}"`, CLONE)).toBe(false);
  });

  it("is false when there is no project_id to disagree with", () => {
    expect(configTomlNamesForeignProject("[functions.x]\nverify_jwt = false\n", CLONE)).toBe(false);
  });
});

describe("stripWorkflowProjectRefDefault", () => {
  const withDefault = `          PROJECT_REF: \${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}\n`;

  it("removes the hard-coded fallback", () => {
    expect(stripWorkflowProjectRefDefault(withDefault)).toBe(
      "          PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n",
    );
  });

  it("does NOT substitute the clone's ref", () => {
    // The ref belongs in a repository variable, where it changes without a
    // commit. A second hard-coded default is the same bug with a new value.
    const out = stripWorkflowProjectRefDefault(withDefault);
    expect(out).not.toContain(CLONE);
    expect(out).not.toContain(PRIME);
  });

  it("removes every occurrence — the deploy workflow has two", () => {
    const twice = withDefault + "\n" + withDefault;
    expect(workflowHasProjectRefDefault(stripWorkflowProjectRefDefault(twice))).toBe(false);
  });

  it("leaves an already-fixed workflow untouched", () => {
    const clean = "PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n";
    expect(stripWorkflowProjectRefDefault(clean)).toBe(clean);
  });

  it("tolerates spacing variants", () => {
    const spaced = "${{vars.SUPABASE_PROJECT_REF||'abc'}}";
    expect(stripWorkflowProjectRefDefault(spaced)).toBe("${{ vars.SUPABASE_PROJECT_REF }}");
  });
});

describe("workflowHasProjectRefDefault", () => {
  it("detects the shape that made a clone able to deploy into the prime", () => {
    expect(workflowHasProjectRefDefault(`\${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}`)).toBe(
      true,
    );
  });

  it("is false once the job fails closed", () => {
    expect(workflowHasProjectRefDefault("${{ vars.SUPABASE_PROJECT_REF }}")).toBe(false);
  });
});

/**
 * Step 5 — the prime's Dependabot config.
 *
 * Read through the source rather than by driving Octokit, which is how the
 * other imperative steps here are already unverified: they are not unit-tested
 * at all. What is asserted is the shape (delete, never rewrite; non-fatal like
 * every other step) and — more importantly — the PREMISE, because the
 * justification for deleting somebody's config file is entirely borrowed.
 */
describe("dropping the prime's Dependabot config from a clone", () => {
  const source = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
  const step = source.slice(source.indexOf("// 5. The prime's Dependabot config"));

  it("deletes the file rather than rewriting it", () => {
    // A rewritten config still says somebody decided what it should contain.
    // The decision here is that the repository has no say in its dependencies,
    // and the only honest spelling of that is absence.
    expect(step).toContain("octokit.repos.deleteFile(");
    expect(step).toContain("path: DEPENDABOT_CONFIG_PATH");
    expect(step).not.toContain("createOrUpdateFileContents");
  });

  it("is non-fatal and reports an absent file as absent, like every other step", () => {
    // "a repository that lacks one of these files is not broken, and a partial
    // result is more useful than an abort" — this module's own header.
    expect(step).toMatch(/if \(!f\) \{\s*actions\.push\(\{ target: DEPENDABOT_CONFIG_PATH, status: "absent" \}\)/);
    expect(step).toMatch(/\}\s*catch\s*\(e\)\s*\{[\s\S]*status: "failed"/);
  });

  it("names the one path, and names it once", () => {
    expect(DEPENDABOT_CONFIG_PATH).toBe(".github/dependabot.yml");
    // A literal at each end is how two ends drift; the constant is exported so
    // the deletion and anything that later asserts it read the same string.
    expect(step).not.toContain('".github/dependabot.yml"');
  });

  it("THE PREMISE: the dependency graph really is cascaded, so a clone cannot own it", () => {
    /*
      Everything above rests on a fact about a different module. If
      package.json and package-lock.json stop being repository invariants, a
      clone owns its own dependencies, a Dependabot PR there can land, and
      deleting the config becomes removal of a working control rather than of
      dead machinery.

      Asserted rather than trusted, for the same reason `cloneStatusRecovery`
      asserts that the migration lane never writes `clone_backends.status`:
      the reasoning is only as good as the premise, and the premise lives
      somewhere this file does not.
    */
    const patterns = REPOSITORY_INVARIANTS.map((i) => i.pattern);
    expect(patterns).toContain("package.json");
    expect(patterns).toContain("package-lock.json");
  });
});
