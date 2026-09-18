/**
 * The route-tree gate is only true where it is placed.
 *
 * `scripts/check-route-tree.mjs` asserts that the committed
 * `src/routeTree.gen.ts` is what a build produced — by comparing the working
 * tree against HEAD. That is a statement about the EFFECT of the build, which
 * is the only thing that cannot disagree with the build (driving the
 * generator from its own config was measured at 406 lines of divergence,
 * because the real configuration comes from `tanstackStart` and the vite
 * preset rather than the generator's defaults).
 *
 * The cost of asserting an effect is that ordering becomes load-bearing: run
 * before the build, nothing has written the file, the working tree equals
 * HEAD, and the gate passes on a tree that is stale — reporting success for
 * exactly the condition it exists to catch. So the ordering is pinned here
 * rather than left to whoever next edits the workflow.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function stepsOf(): Step[] {
  const workflow = loadYaml(read(".github/workflows/ci.yml")) as Workflow;
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

const indexOfRun = (steps: Step[], needle: string) =>
  steps.findIndex((s) => typeof s.run === "string" && s.run.includes(needle));

describe("the route-tree gate", () => {
  it("runs in CI at all", () => {
    expect(indexOfRun(stepsOf(), "check:route-tree")).toBeGreaterThanOrEqual(0);
  });

  it("runs AFTER the build that regenerates the file", () => {
    const steps = stepsOf();
    const build = indexOfRun(steps, "npm run build");
    const gate = indexOfRun(steps, "check:route-tree");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(build);
  });

  it("is reachable as an npm script", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["check:route-tree"]).toBe("node scripts/check-route-tree.mjs");
  });

  it("asserts the build's effect rather than generating a tree of its own", () => {
    // Reimplementing the build's configuration is how a gate starts failing
    // for reasons the build does not care about. The script may NAME the
    // generator — its header explains why that route was rejected and what it
    // measured — but it must never import one.
    const source = read("scripts/check-route-tree.mjs");
    const imports =
      source.match(
        /^\s*(?:import\s[^;]*from\s*|const\s[^=]*=\s*require\s*\()\s*["'][^"']+["']/gm,
      ) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/router-generator|router-plugin|vite/);
    // It compares against git, which is the build's effect.
    expect(source).toMatch(/execFileSync|execSync/);
    expect(source).toContain("routeTree.gen.ts");
  });
});

describe("the committed route tree", () => {
  it("is a generated file nothing hand-edits", () => {
    // If this stops being true the gate is wrong, not the file.
    const tree = read("src/routeTree.gen.ts");
    expect(tree.slice(0, 400)).toMatch(/generated|auto-?generated|do not edit/i);
  });
});
