import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FUNCTION_COUNT_RATCHET_PATH,
  SECURITY_INVENTORY_PATH,
  configDeclaredFunctionNames,
  extractRatchetRule,
  functionDirsIn,
  isWalkedSourceFile,
  ratchetCount,
  reconcileFunctionCountRatchet,
  reconcileSecurityInventory,
} from "./securityBaselineReconcile.pure";

/**
 * A repository whose shape is the one the two real ones have: prime holds two
 * functions, the clone holds those two and one of its own.
 */
const PRIME_TOML = `project_id = "primeprimeprimeprime"

[functions.alpha]
verify_jwt = true

[functions.beta]
verify_jwt = false
`;

const CLONE_TOML = `project_id = "cloneclonecloneclone"

[functions.alpha]
verify_jwt = true

[functions.beta]
verify_jwt = false

[functions.crm-send-message]
verify_jwt = false
`;

const MERGED_REGISTRY = JSON.stringify({
  functions: {
    alpha: { exposure_class: "human-authenticated", verify_jwt: true },
    beta: { exposure_class: "cron-worker", verify_jwt: false },
    "crm-send-message": { exposure_class: "internal-service", verify_jwt: false },
  },
});

const PRIME_INVENTORY = JSON.stringify(
  {
    schema_version: 1,
    source: "repository-static-analysis",
    edge_function_count: 2,
    config_declared_function_count: 2,
    registry_function_count: 2,
    verify_jwt_false_count: 1,
    exposure_class_counts: { "cron-worker": 1, "human-authenticated": 1 },
    needs_review_count: 0,
    functions_importing_shared_auth_modules: {
      "auth.ts": ["alpha/index.ts"],
      "authz.ts": ["beta/index.ts"],
    },
    statically_derivable_inter_function_graph: ["alpha->beta"],
  },
  null,
  2,
);

const CLONE_INVENTORY = JSON.stringify(
  {
    schema_version: 1,
    source: "repository-static-analysis",
    edge_function_count: 3,
    config_declared_function_count: 3,
    registry_function_count: 3,
    verify_jwt_false_count: 2,
    exposure_class_counts: {
      "cron-worker": 1,
      "human-authenticated": 1,
      "internal-service": 1,
    },
    needs_review_count: 0,
    functions_importing_shared_auth_modules: {
      "auth.ts": ["alpha/index.ts", "crm-send-message/index.ts"],
    },
    statically_derivable_inter_function_graph: ["alpha->beta"],
  },
  null,
  2,
);

const MERGED_TREE = [
  "supabase/functions/alpha/index.ts",
  "supabase/functions/beta/index.ts",
  "supabase/functions/crm-send-message/index.ts",
  "supabase/functions/_shared/auth.ts",
  "src/main.tsx",
];

/** What a full pass writes: prime's copy of everything the two share. */
const DELIVERED = ["supabase/functions/alpha/index.ts", "supabase/functions/beta/index.ts"];

const reconcile = (over: Partial<Parameters<typeof reconcileSecurityInventory>[0]> = {}) =>
  reconcileSecurityInventory({
    primeInventoryJson: PRIME_INVENTORY,
    cloneInventoryJson: CLONE_INVENTORY,
    mergedToml: CLONE_TOML,
    mergedRegistryJson: MERGED_REGISTRY,
    mergedTreePaths: MERGED_TREE,
    deliveredPaths: DELIVERED,
    ...over,
  });

describe("the counting rules are the generator's and the spec's, kept apart", () => {
  it("reads a declaration only where a line opens with one", () => {
    // The rule the generator applies. A `[functions.X]` token inside prose is
    // not a declaration to it — which is exactly the half the ratchet spec
    // disagreed about, and the disagreement shipped once.
    const withProse = `${PRIME_TOML}\n# An omitted [functions.X] block is read as verify_jwt = true.\n`;
    expect([...configDeclaredFunctionNames(withProse)].sort()).toEqual(["alpha", "beta"]);
  });

  it("counts a block written twice once", () => {
    expect(
      configDeclaredFunctionNames(`${PRIME_TOML}\n[functions.alpha]\nverify_jwt = true\n`).size,
    ).toBe(2);
  });

  it("reads the spec's rule out of the spec rather than restating it", () => {
    const spec = `const declared = [...CONFIG.matchAll(\n  /\\[functions\\.([A-Za-z0-9_-]+)\\][^[]*?verify_jwt\\s*=\\s*(true|false)/gs)];`;
    const rule = extractRatchetRule(spec);
    expect(rule).not.toBeNull();
    expect(ratchetCount(CLONE_TOML, rule!)).toBe(3);
  });

  it("refuses a spec that reads the config in more than one place", () => {
    // Taking the first of two would apply a rule that is not the one the
    // assertion counts with, and the number would be wrong while looking
    // derived. A restructured spec is held instead.
    const spec =
      `const a = [...CONFIG.matchAll(/\\[functions\\.(x)\\]/g)];\n` +
      `const declared = [...CONFIG.matchAll(/\\[functions\\.([A-Za-z0-9_-]+)\\][^[]*?verify_jwt\\s*=\\s*(true|false)/gs)];`;
    expect(extractRatchetRule(spec)).toBeNull();
  });

  it("refuses a rule that says nothing about functions", () => {
    expect(extractRatchetRule(`[...CONFIG.matchAll(/project_id\\s*=\\s*"(\\w+)"/g)]`)).toBeNull();
  });
});

describe("what the generator's walk reads", () => {
  it("keeps a shared module, because one can contribute an import pair", () => {
    expect(isWalkedSourceFile("supabase/functions/_shared/auth.ts")).toBe(true);
  });

  it("drops the shared test tree, which the generator's walk also drops", () => {
    expect(isWalkedSourceFile("supabase/functions/_shared/tests/auth.test.ts")).toBe(false);
  });

  it("drops anything that is not source, and anything outside the functions tree", () => {
    expect(isWalkedSourceFile("supabase/functions/alpha/README.md")).toBe(false);
    expect(isWalkedSourceFile("src/main.tsx")).toBe(false);
  });

  it("counts function directories and never the shared one", () => {
    expect([...functionDirsIn(MERGED_TREE)].sort()).toEqual(["alpha", "beta", "crm-send-message"]);
  });
});

describe("the security baseline, computed from what the pass holds", () => {
  it("states the merged tree's counts rather than either side's", () => {
    const out = reconcile();
    expect(out.ok).toBe(true);
    const merged = JSON.parse((out as { merged: string }).merged);
    expect(merged.edge_function_count).toBe(3);
    expect(merged.config_declared_function_count).toBe(3);
    expect(merged.registry_function_count).toBe(3);
    expect(merged.verify_jwt_false_count).toBe(2);
    expect(merged.exposure_class_counts).toEqual({
      "cron-worker": 1,
      "human-authenticated": 1,
      "internal-service": 1,
    });
  });

  it("re-files each path's imports against the side that supplied its content", () => {
    // `crm-send-message` is the clone's, so the clone's reading of it stands;
    // `alpha` is delivered, so prime's does. Neither list is copied whole.
    const merged = JSON.parse((reconcile() as { merged: string }).merged);
    expect(merged.functions_importing_shared_auth_modules["auth.ts"]).toEqual([
      "alpha/index.ts",
      "crm-send-message/index.ts",
    ]);
  });

  it("drops a path the merged tree no longer holds", () => {
    // The partition is over the MERGED tree, so an entry either inventory
    // still lists for a file that is gone does not survive into the answer.
    const merged = JSON.parse(
      (
        reconcile({
          mergedTreePaths: MERGED_TREE.filter((p) => !p.includes("crm-send-message")),
        }) as { merged: string }
      ).merged,
    );
    expect(merged.functions_importing_shared_auth_modules["auth.ts"]).toEqual(["alpha/index.ts"]);
    expect(merged.edge_function_count).toBe(2);
  });

  it("takes prime's reading of a delivered path even where the clone's differs", () => {
    // The delivered file IS prime's, so what prime's generator said about it
    // is the fact about the file that lands. A clone reading that survived
    // here would describe a file the pass just replaced.
    const cloneSaysAlphaDoesNot = JSON.stringify({
      ...JSON.parse(CLONE_INVENTORY),
      functions_importing_shared_auth_modules: { "auth.ts": ["crm-send-message/index.ts"] },
    });
    const merged = JSON.parse(
      (reconcile({ cloneInventoryJson: cloneSaysAlphaDoesNot }) as { merged: string }).merged,
    );
    expect(merged.functions_importing_shared_auth_modules["auth.ts"]).toContain("alpha/index.ts");
  });

  it("refuses where the two call graphs differ, because an edge names no file", () => {
    const divergent = JSON.stringify({
      ...JSON.parse(CLONE_INVENTORY),
      statically_derivable_inter_function_graph: ["alpha->beta", "crm-send-message->alpha"],
    });
    const out = reconcile({ cloneInventoryJson: divergent });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("call graph");
  });

  it("refuses rather than half-writes when an input is not readable", () => {
    expect(reconcile({ mergedRegistryJson: "{" }).ok).toBe(false);
    expect(reconcile({ primeInventoryJson: "{" }).ok).toBe(false);
    expect(reconcile({ cloneInventoryJson: '{"schema_version":1}' }).ok).toBe(false);
  });

  it("serialises the way the generator does, to the trailing newline", () => {
    // The check on the clone is `git diff --exit-code`, so a byte decides it.
    const out = reconcile() as { merged: string };
    expect(out.merged.endsWith("\n")).toBe(true);
    expect(out.merged.endsWith("}\n")).toBe(true);
    expect(out.merged).toBe(`${JSON.stringify(JSON.parse(out.merged), null, 2)}\n`);
  });

  it("emits the fields in the generator's own order", () => {
    // An object whose keys are the same and whose ORDER is not is a byte diff
    // that says nothing to a reader and fails the check all the same.
    const out = reconcile() as { merged: string };
    expect(Object.keys(JSON.parse(out.merged))).toEqual(Object.keys(JSON.parse(PRIME_INVENTORY)));
  });

  it("tracks the modules prime tracks, not the ones this clone's file predates", () => {
    // `authz.ts` is a module prime has and the clone's stored baseline was
    // written before. Keying the answer off the clone drops it silently, and
    // the generator on the clone would have emitted it — so the byte check
    // goes red on a key nobody can see was missing.
    const merged = JSON.parse((reconcile() as { merged: string }).merged);
    expect(Object.keys(merged.functions_importing_shared_auth_modules)).toEqual([
      "auth.ts",
      "authz.ts",
    ]);
    expect(merged.functions_importing_shared_auth_modules["authz.ts"]).toEqual(["beta/index.ts"]);
  });
});

describe("the ratchet spec, carrying this repository's own count", () => {
  const SPEC = [
    "describe('the config', () => {",
    "  it('every function still declares verify_jwt explicitly', () => {",
    "    const declared = [...CONFIG.matchAll(",
    "      /\\[functions\\.([A-Za-z0-9_-]+)\\][^[]*?verify_jwt\\s*=\\s*(true|false)/gs)];",
    "    // 2 since beta was declared.",
    "    expect(declared.length).toBe(2);",
    "  });",
    "});",
    "",
  ].join("\n");

  const owned = ["crm-send-message"];

  it("changes the number and nothing else", () => {
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: owned,
    });
    expect(out.ok).toBe(true);
    const merged = (out as { merged: string }).merged;
    expect(merged).toContain("expect(declared.length).toBe(3);");
    // Prime's own provenance comment is its history and survives untouched.
    expect(merged).toContain("// 2 since beta was declared.");
    // Every line of prime's that is not the assertion is still there.
    for (const line of SPEC.split("\n")) {
      if (line.includes("toBe(2)")) continue;
      expect(merged).toContain(line);
    }
  });

  it("keeps the assertion's own indentation", () => {
    const merged = (
      reconcileFunctionCountRatchet({
        primeSpec: SPEC,
        mergedToml: CLONE_TOML,
        cloneOwnedFunctions: owned,
      }) as { merged: string }
    ).merged;
    // Doubled or lost indentation is what a splice that reads `before` as
    // ending at the assertion's first character produces, and prettier on the
    // receiving clone then reports it as a diff nobody wrote.
    for (const line of merged.split("\n")) {
      if (line.includes("expect(declared.length)"))
        expect(line).toBe("    expect(declared.length).toBe(3);");
      if (line.includes("Reconciled by the cascade")) expect(line.startsWith("    // ")).toBe(true);
    }
  });

  it("writes a note the spec's own counting rule cannot read", () => {
    // The rule runs `[^[]*?` through prose, and this repository has already
    // shipped a comment it counted. Driven over the composed file rather than
    // asserted about the template.
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: owned,
    }) as { merged: string };
    const rule = extractRatchetRule(SPEC)!;
    expect(ratchetCount(out.merged, rule)).toBe(0);
    expect(out.merged).not.toContain("[functions.");
  });

  it("names the functions the number is owed to", () => {
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message", "crm-calendar"],
    }) as { merged: string };
    expect(out.merged).toContain("crm-calendar, crm-send-message");
  });

  it("is a fixed point: reconciling its own output changes nothing", () => {
    // The engine hands it prime's file every pass, so this cannot happen in
    // the loop that runs — which is why it is asserted rather than assumed. A
    // stacked note is silent: it compiles, it passes, and it grows.
    const once = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: owned,
    }) as { merged: string };
    const twice = reconcileFunctionCountRatchet({
      primeSpec: once.merged,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: owned,
    }) as { merged: string };
    expect(twice.merged).toBe(once.merged);
  });

  it("hands back prime's file byte for byte where the clone owns nothing", () => {
    // "Carry it unchanged" falls out of the general rule rather than being a
    // special case somebody has to remember.
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: PRIME_TOML,
      cloneOwnedFunctions: [],
    });
    expect((out as { merged: string }).merged).toBe(SPEC);
  });

  it("refuses a spec whose assertion it cannot find exactly once", () => {
    expect(
      reconcileFunctionCountRatchet({
        primeSpec: SPEC.replace("expect(declared.length).toBe(2);", "// none"),
        mergedToml: CLONE_TOML,
        cloneOwnedFunctions: owned,
      }).ok,
    ).toBe(false);
    expect(
      reconcileFunctionCountRatchet({
        primeSpec: `${SPEC}\n    expect(declared.length).toBe(9);\n`,
        mergedToml: CLONE_TOML,
        cloneOwnedFunctions: owned,
      }).ok,
    ).toBe(false);
  });
});

describe("the reconcilers are the engine's, and the engine uses them", () => {
  const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

  it("is reached from the cascade engine", () => {
    expect(engine).toContain("reconcileSecurityInventory");
    expect(engine).toContain("reconcileFunctionCountRatchet");
  });

  it("counts from the document the pass will land, never from either side's", () => {
    // A count taken from prime's config or from the clone's stale one is a
    // number about a repository this proposal does not create. The engine
    // hoists what the reconciles produced and passes that.
    expect(engine).toContain("mergedToml = verdict.ok ? verdict.merged : cloneCfg.content;");
    expect(engine).toContain(
      "mergedRegistryJson = verdict.ok ? verdict.merged : cloneReg.content;",
    );
  });

  it("leaves every settled path either in the tree or held, on both runs", () => {
    // `dropFromTree` runs first, so a path that is neither written back nor
    // held is one the subject carry below reads as STRANDED and re-delivers
    // prime's raw copy of — undoing the reconcile inside the same pass. That
    // is a confirmed defect in the registry reconcile beside this one, which
    // drops its path and pushes nothing when its verdict is `ok` but
    // unchanged. `settleBaseline` has no such branch: it writes a blob, or an
    // inline entry on a dry run, or pushes the hold.
    const at = engine.indexOf("const settleBaseline = async (");
    const body = engine.slice(at, at + 1800);
    expect(body.indexOf("dropFromTree(held.path)")).toBeGreaterThan(-1);
    // Every path out of the function after the drop puts it back or holds it.
    expect(body).toContain("needsReconcile.push({ ...held");
    expect(body).toContain("content: outcome.merged");
    expect(body).toContain(
      'treeEntries.push({ path: held.path, mode: "100644", type: "blob", sha: blob.sha })',
    );
  });

  it("still holds both paths where a baseline cannot be computed", () => {
    // The hold is the fallback, not the removed thing. Each path is named in
    // exactly one module and reached through the constant, so a spelling in
    // the engine cannot drift from the one the reconciler writes.
    expect(SECURITY_INVENTORY_PATH).toBe("docs/security/SECURITY_INVENTORY.json");
    expect(FUNCTION_COUNT_RATCHET_PATH).toBe("src/lib/security/auditRemediation.spec.ts");
    expect(engine).not.toContain(`"${SECURITY_INVENTORY_PATH}"`);
    expect(engine).not.toContain(`"${FUNCTION_COUNT_RATCHET_PATH}"`);
    expect(engine).toContain("Not reconciled here:");
  });
});
