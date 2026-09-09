import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEPLOY_WORKFLOW_PATH,
  reconcileDeployWorkflow,
  readsDeployerDeclaration,
} from "./deployWorkflowReconcile.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";

const PRIME_REF = "dduzbchuswwbefdunfct";
const CLONE_REF = "umrtusxohxjxzodxorim";

/**
 * The shape of the current file: a `project` step that resolves the target
 * from the repository's own config.toml, consumers that read that step, and
 * exactly one project ref — the one pairing a built-in CORS origin to the
 * deployment it belongs to.
 */
const CURRENT = `name: Deploy Supabase functions
on:
  push:
    branches: [main]
jobs:
  deploy:
    steps:
      - name: Check for a deploy credential
        id: gate
        env:
          DEPLOYER: \${{ vars.BACKEND_DEPLOYED_BY }}
        run: |
          echo 'ready=false' >> "$GITHUB_OUTPUT"

      - name: Resolve this deployment's project
        id: project
        env:
          PROJECT_REF_VAR: \${{ vars.SUPABASE_PROJECT_REF }}
        run: |
          ref="\${PROJECT_REF_VAR:-}"
          if [ -z "$ref" ]; then
            ref=$(sed -n 's/project_id/\\1/p' supabase/config.toml)
          fi
          echo "ref=$ref" >> "$GITHUB_OUTPUT"

      - name: Deploy
        env:
          PROJECT_REF: \${{ steps.project.outputs.ref }}
        run: |
          supabase functions deploy x --project-ref "$PROJECT_REF"

      - name: Verify the deployed CORS contract
        env:
          PROJECT_REF: \${{ steps.project.outputs.ref }}
          BUILTIN_ORIGIN: https://command-centre.npcservices.com.au
          BUILTIN_ORIGIN_PROJECT: ${PRIME_REF}
        run: |
          echo verify
`;

/** What the two 100%-failing clones were actually running. */
const FROZEN_CLONE = CURRENT.replace(
  "      - name: Resolve this deployment's project\n",
  "      - name: NOT PRESENT\n",
)
  .replace(
    "${{ steps.project.outputs.ref }}",
    `\${{ vars.SUPABASE_PROJECT_REF || '${PRIME_REF}' }}`,
  )
  .replace("DEPLOYER: ${{ vars.BACKEND_DEPLOYED_BY }}", "DEPLOYER: ''");

describe("carrying the deploy workflow to a clone", () => {
  it("carries prime's file whole, because there is nothing per-deployment left in it", () => {
    const r = reconcileDeployWorkflow({
      primeYaml: CURRENT,
      cloneYaml: FROZEN_CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.merged).toBe(CURRENT);
    expect(r.changed).toBe(true);
  });

  it("says when the copy it replaced could have deployed somewhere else", () => {
    // Worth stating on the pull request. The frozen copy defaults its target
    // to another deployment's project, which is a hazard rather than a
    // staleness — and an operator reading "workflow updated" would not know.
    const r = reconcileDeployWorkflow({
      primeYaml: CURRENT,
      cloneYaml: FROZEN_CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cloneWasHazardous).toBe(true);
  });

  it("reports no change when the clone already holds prime's copy", () => {
    // Or every cascade would commit an identical file for ever.
    const r = reconcileDeployWorkflow({
      primeYaml: CURRENT,
      cloneYaml: CURRENT,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.cloneWasHazardous).toBe(false);
  });

  it("proceeds where no backend is registered, because null is not a disagreement", () => {
    const r = reconcileDeployWorkflow({ primeYaml: CURRENT, cloneYaml: "", ownRef: null });
    expect(r.ok).toBe(true);
  });

  it("names the stand-down the clone is gaining", () => {
    // The whole reason the two clones failed every push, stated as an
    // assertion: the frozen copy has no line that reads BACKEND_DEPLOYED_BY,
    // and Mission Control had been setting that variable on both of them
    // since 2 Sep. The carry is what gives the file a reader for it.
    expect(readsDeployerDeclaration(FROZEN_CLONE)).toBe(false);
    expect(readsDeployerDeclaration(CURRENT)).toBe(true);
    expect(readsDeployerDeclaration("name: something else\n")).toBe(false);
  });
});

describe("what it refuses", () => {
  const refuse = (primeYaml: string) =>
    reconcileDeployWorkflow({ primeYaml, cloneYaml: FROZEN_CLONE, ownRef: CLONE_REF });

  it("refuses a prime file that defaults a project ref", () => {
    // The exact shape that made a clone deploy into the prime's production.
    // Refused wherever it appears, not only on the lines it appeared on last
    // time, because the next one will be somewhere else.
    const r = refuse(
      CURRENT.replace(
        "PROJECT_REF: ${{ steps.project.outputs.ref }}",
        `PROJECT_REF: \${{ vars.SUPABASE_PROJECT_REF || '${PRIME_REF}' }}`,
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("default is not a fallback");
  });

  it("does NOT refuse an ordinary default that stands in for no identity", () => {
    // The first version of this rule refused any `${{ vars.X || '…' }}`, which
    // flagged `CORS_VERIFY_ORIGIN` on npc-client-dashboard — a repository whose
    // file names no project ref anywhere and has no project hazard at all. A
    // guard that cannot tell a harmless default from an identity one produces
    // refusals nobody can act on.
    const r = refuse(
      CURRENT.replace(
        "          BUILTIN_ORIGIN: https://command-centre.npcservices.com.au\n",
        "          ORIGIN: ${{ vars.CORS_VERIFY_ORIGIN || 'https://example.test' }}\n",
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a default on SUPABASE_PROJECT_REF whatever its value", () => {
    const r = refuse(
      CURRENT.replace(
        "PROJECT_REF_VAR: ${{ vars.SUPABASE_PROJECT_REF }}",
        "PROJECT_REF_VAR: ${{ vars.SUPABASE_PROJECT_REF || 'anything-at-all' }}",
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("defaults a project identity");
  });

  it("refuses a project ref anywhere but the paired-origin line", () => {
    const r = refuse(CURRENT.replace("          echo verify\n", `          echo ${PRIME_REF}\n`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("BUILTIN_ORIGIN_PROJECT");
    expect(r.reason).toContain(PRIME_REF);
  });

  it("allows the paired-origin line, because reading it cannot send anything anywhere", () => {
    // It decides whether a DEFAULT ORIGIN may be used, never where code goes.
    // The same pairing rule the Turnstile site key follows.
    expect(
      reconcileDeployWorkflow({
        primeYaml: CURRENT,
        cloneYaml: "",
        ownRef: CLONE_REF,
      }).ok,
    ).toBe(true);
  });

  it("allows a ref quoted in a comment, which sends nothing anywhere", () => {
    // This file's own header tells the story of the hazard and has to be able
    // to name it. A rule that could not tell a comment from a value would
    // make the explanation unwritable.
    const r = refuse(
      CURRENT.replace(
        "jobs:\n",
        `# It used to default to ${PRIME_REF}, which was the whole bug.\njobs:\n`,
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a prime file that no longer resolves its own project", () => {
    const r = refuse(CURRENT.replace(/^\s*id: project\s*$/m, "        id: something-else"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("no way to tell what a clone running it would deploy to");
  });

  it("refuses when the file grows a project URL or an anon key", () => {
    // The second, independent check. `backendRefsIn` reads a project URL and a
    // JWT `ref` claim — shapes a bare YAML scalar does not have — so it is
    // blind to the rule above and catches what that one cannot.
    const r = refuse(
      CURRENT.replace(
        "          echo verify\n",
        `          curl https://${PRIME_REF}.supabase.co/health\n`,
      ),
    );
    expect(r.ok).toBe(false);
    // Either rule may catch it first; both are refusals and both name the ref.
    if (r.ok) return;
    expect(r.reason).toContain(PRIME_REF);
  });
});

describe("how it sits beside the exclusion it does not remove", () => {
  it("the path is still a protected exclusion, and stays one", () => {
    // This module does not lift the exclusion. The path is still withheld from
    // the ordinary write path, and this is a separate single-file act with its
    // own assertions and its own read-back — the same architecture as
    // `configTomlReconcile`. If the exclusion went, a future edit that
    // reintroduced a hard-coded target would travel by the plain route and
    // none of the guards above would run.
    const entry = DEFAULT_MIRROR_EXCLUSIONS.find((e) => e.pattern === DEPLOY_WORKFLOW_PATH);
    expect(entry, `${DEPLOY_WORKFLOW_PATH} must remain in DEFAULT_MIRROR_EXCLUSIONS`).toBeDefined();
    expect(entry!.reason).toBe("protected");
  });

  it("the engine performs the reconcile", () => {
    // A pure module nothing calls is a rule that does not exist.
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    expect(engine).toContain("reconcileDeployWorkflow");
    expect(engine).toContain("DEPLOY_WORKFLOW_PATH");
  });

  it("it runs beside the config.toml reconcile, not inside the write path", () => {
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    const cfg = engine.indexOf("reconcileConfigToml({");
    const wf = engine.indexOf("reconcileDeployWorkflow({");
    expect(cfg).toBeGreaterThan(-1);
    expect(wf).toBeGreaterThan(cfg);
    // Both sit after the loop that writes ordinary entries, which is the one
    // place neither of these files may ever be carried by.
    expect(engine.indexOf("for (const entry of prepared)")).toBeLessThan(cfg);
  });
});
