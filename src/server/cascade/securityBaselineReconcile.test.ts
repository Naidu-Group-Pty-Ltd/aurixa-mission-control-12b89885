import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributeGraphByCaller,
  FUNCTION_COUNT_RATCHET_PATH,
  SECURITY_INVENTORY_PATH,
  configDeclaredFunctionNames,
  extractRatchetRule,
  functionDirsIn,
  isWalkedSourceFile,
  ratchetCount,
  reconcileFunctionCountRatchet,
  dropWithheldTableRows,
  reconcileSecurityInventory,
} from "./securityBaselineReconcile.pure";
import { PRIME_ONLY_FEATURES } from "../primeOnlyFeatures.pure";

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

  it("refuses a document that parses but is not an object, rather than throwing", () => {
    // `JSON.parse("null")` succeeds, and `null` is the one JSON value whose
    // next property access throws instead of answering `undefined`. The shape
    // checks read `inv.schema_version` and `root.functions` straight off the
    // parsed value, so a baseline holding literal `null` used to throw out of
    // the whole clone's pass — where the contract is that an unusable input
    // leaves the hold standing and costs the pass the red check it had.
    //
    // `.not.toThrow()` is the assertion that matters: it is what the previous
    // implementation failed, on each of these three inputs.
    for (const over of [
      { primeInventoryJson: "null" },
      { cloneInventoryJson: "null" },
      { mergedRegistryJson: "null" },
      { primeInventoryJson: "[]" },
      { cloneInventoryJson: "[]" },
      { mergedRegistryJson: "[]" },
      { primeInventoryJson: "3" },
      { cloneInventoryJson: '"a string"' },
    ]) {
      expect(() => reconcile(over)).not.toThrow();
      const out = reconcile(over);
      expect(out.ok).toBe(false);
      expect((out as { reason: string }).reason).toMatch(/is not a JSON object|not the shape/);
    }
  });

  it("names which of the three documents it refused", () => {
    // A reason that does not say whose file it is sends an operator to read
    // the wrong repository.
    expect((reconcile({ primeInventoryJson: "null" }) as { reason: string }).reason).toContain(
      "prime",
    );
    expect((reconcile({ cloneInventoryJson: "null" }) as { reason: string }).reason).toContain(
      "clone",
    );
    expect((reconcile({ mergedRegistryJson: "null" }) as { reason: string }).reason).toContain(
      "registry",
    );
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

  it("reconciles nothing on a notify pass, and says nothing about it", () => {
    // Notify writes nothing, so it reads nothing: the holds stand as they did
    // before any of this existed. A rehearsal that spends three API reads to
    // reach a foregone hold — and then blames inputs nobody tried to read —
    // is three reads and a misleading sentence.
    const at = engine.indexOf('if ((inventoryHold || ratchetHold) && mode === "notify")');
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 700);
    expect(block).toContain("partition.held.push(held);");
    expect(block).not.toContain("getFileContent");
    expect(block).not.toContain("Not reconciled here:");
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

/*
  A clone that does NOT hold what the prime keeps for itself
  (`primeOnlyFeatures.pure.ts`). The generator attributes an edge to the
  directory of its caller, so an edge a withheld function makes is one the
  clone's tree cannot produce — and prime's baseline carries them.
*/
describe("a clone without the prime's own functions", () => {
  const PRIME_ONLY = ["migration-dispatcher", "migration-job-control"];
  const primeWithMigration = JSON.stringify(
    {
      ...JSON.parse(PRIME_INVENTORY),
      functions_importing_shared_auth_modules: {
        "auth.ts": ["alpha/index.ts", "migration-job-control/index.ts"],
        "authz.ts": ["beta/index.ts"],
      },
      statically_derivable_inter_function_graph: [
        "alpha->beta",
        "migration-job-control->migration-dispatcher",
        "migration-dispatcher->migration-dispatcher",
      ],
    },
    null,
    2,
  );
  /** The clone's own baseline, generated after its removal pull request. */
  const cloneAfterRemoval = JSON.stringify(
    { ...JSON.parse(CLONE_INVENTORY), statically_derivable_inter_function_graph: ["alpha->beta"] },
    null,
    2,
  );

  it("compares the graphs without the edges only a withheld function makes", () => {
    const out = reconcile({
      primeInventoryJson: primeWithMigration,
      cloneInventoryJson: cloneAfterRemoval,
      withheld: PRIME_ONLY,
    });
    expect(out.ok, out.ok ? "" : out.reason).toBe(true);
    const merged = JSON.parse((out as { merged: string }).merged);
    expect(merged.statically_derivable_inter_function_graph).toEqual(["alpha->beta"]);
  });

  it("refuses the same pair where nothing is withheld, as it always has", () => {
    // The filter is the whole difference: prime's three edges against the
    // clone's one is exactly the disagreement the graph rule refuses.
    const out = reconcile({
      primeInventoryJson: primeWithMigration,
      cloneInventoryJson: cloneAfterRemoval,
    });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("call graph");
  });

  it("also settles a clone whose stored baseline still lists them", () => {
    // Every clone's committed baseline predates its removal, so both inputs
    // carry the edges on the first pass after the removal lands.
    const out = reconcile({
      primeInventoryJson: primeWithMigration,
      cloneInventoryJson: primeWithMigration,
      withheld: PRIME_ONLY,
    });
    expect(out.ok, out.ok ? "" : out.reason).toBe(true);
    const merged = JSON.parse((out as { merged: string }).merged);
    expect(merged.statically_derivable_inter_function_graph).toEqual(["alpha->beta"]);
  });

  it("keeps an edge INTO a withheld function from a function the clone still holds", () => {
    // Its caller is on disk and still names the function, so the clone's own
    // generator finds it. Only the caller decides.
    const withIncoming = (inv: string) =>
      JSON.stringify({
        ...JSON.parse(inv),
        statically_derivable_inter_function_graph: [
          ...JSON.parse(inv).statically_derivable_inter_function_graph,
          "beta->migration-dispatcher",
        ],
      });
    const out = reconcile({
      primeInventoryJson: withIncoming(primeWithMigration),
      cloneInventoryJson: withIncoming(cloneAfterRemoval),
      withheld: PRIME_ONLY,
    });
    expect(out.ok, out.ok ? "" : out.reason).toBe(true);
    const merged = JSON.parse((out as { merged: string }).merged);
    expect(merged.statically_derivable_inter_function_graph).toEqual([
      "alpha->beta",
      "beta->migration-dispatcher",
    ]);
  });

  it("drops their files from the import map, because the merged tree does not hold them", () => {
    const out = reconcile({
      primeInventoryJson: primeWithMigration,
      cloneInventoryJson: cloneAfterRemoval,
      withheld: PRIME_ONLY,
    });
    const merged = JSON.parse((out as { merged: string }).merged);
    expect(merged.functions_importing_shared_auth_modules["auth.ts"]).not.toContain(
      "migration-job-control/index.ts",
    );
  });
});

describe("the ratchet note, for a clone that holds less than the prime", () => {
  const SPEC = [
    "describe('the config', () => {",
    "  it('every function still declares verify_jwt explicitly', () => {",
    "    const declared = [...CONFIG.matchAll(",
    "      /\\[functions\\.([A-Za-z0-9_-]+)\\][^[]*?verify_jwt\\s*=\\s*(true|false)/gs)];",
    "    expect(declared.length).toBe(2);",
    "  });",
    "});",
    "",
  ].join("\n");
  const ALL_28 = PRIME_ONLY_FEATURES.find((f) => f.key === "ghl-account-migration")!.functions;
  const note = (merged: string) =>
    merged
      .split("\n")
      .filter((l) => l.trimStart().startsWith("//"))
      .map((l) => l.trim().replace(/^\/\/ ?/, ""))
      .join(" ");

  it("writes the count this repository declares, and says why in a sentence", () => {
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: PRIME_TOML,
      cloneOwnedFunctions: [],
      withheld: ALL_28,
    });
    expect(out.ok).toBe(true);
    const merged = (out as { merged: string }).merged;
    expect(merged).toContain("expect(declared.length).toBe(2);");
    expect(note(merged)).toBe(
      "Reconciled by the cascade. This deployment does not declare the GoHighLevel account " +
        "migration (all 28 functions), which the prime keeps for itself, so the prime's number " +
        "counts a different repository. The count below is this one's, taken from the config " +
        "this same pass composed.",
    );
  });

  it("names both differences where a clone has both", () => {
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message"],
      withheld: ALL_28,
    });
    const text = note((out as { merged: string }).merged);
    expect(text).toContain("declares 1 edge function(s) the prime does not — crm-send-message —");
    expect(text).toContain("and does not declare the GoHighLevel account migration");
  });

  it("writes exactly the sentence it always has for a clone that only owns more", () => {
    // Every CRM pass has written this note; a withheld set of zero must not
    // re-word it, or the clone's spec changes on a pass that changed nothing.
    const owned = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message"],
    }) as { merged: string };
    const withEmpty = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message"],
      withheld: [],
    }) as { merged: string };
    expect(withEmpty.merged).toBe(owned.merged);
    expect(note(owned.merged)).toBe(
      "Reconciled by the cascade. This deployment declares 1 edge function(s) the prime does " +
        "not — crm-send-message — so the prime's number counts a different repository. The count " +
        "below is this one's, taken from the config this same pass composed.",
    );
  });

  it("writes a note the spec's own rule cannot count, and stays a fixed point", () => {
    const once = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: PRIME_TOML,
      cloneOwnedFunctions: [],
      withheld: ALL_28,
    }) as { merged: string };
    expect(ratchetCount(once.merged, extractRatchetRule(SPEC)!)).toBe(0);
    const twice = reconcileFunctionCountRatchet({
      primeSpec: once.merged,
      mergedToml: PRIME_TOML,
      cloneOwnedFunctions: [],
      withheld: ALL_28,
    }) as { merged: string };
    expect(twice.merged).toBe(once.merged);
  });
});

describe("the engine hands the withheld set to both baselines", () => {
  const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

  it("passes it to the inventory and to the ratchet", () => {
    const inv = engine.indexOf("reconcileSecurityInventory({");
    expect(engine.slice(inv, engine.indexOf("})", inv))).toContain("withheld: withheldFunctions");
    const rat = engine.indexOf("reconcileFunctionCountRatchet({");
    expect(engine.slice(rat, engine.indexOf("})", rat))).toContain("withheld: withheldFunctions");
  });

  it("counts the inventory only over a tree it could read", () => {
    // Without the clone's tree the "merged tree" is the delivery alone, and a
    // baseline counted over it describes a repository that does not exist.
    const at = engine.indexOf("reconcileSecurityInventory({");
    expect(engine.slice(Math.max(0, at - 300), at)).toContain("cloneShaByPath !== null");
  });

  it("recounts once over the finished delivery, after the removals are final", () => {
    const narrowed = engine.indexOf(
      "if (deletesCrossing.size > 0 && deletionPlan.refusal === null) {",
    );
    const recount = engine.indexOf(
      "if (inventoryRecount !== null && reconciledPaths.has(SECURITY_INVENTORY_PATH)) {",
    );
    const typeBaseline = engine.indexOf("let edgeBaselineNote: string | null = null;");
    expect(narrowed).toBeGreaterThan(-1);
    expect(recount).toBeGreaterThan(narrowed);
    expect(typeBaseline).toBeGreaterThan(recount);
    const block = engine.slice(recount, typeBaseline);
    expect(block).toContain("for (const removed of deletesCrossing) finalTree.delete(removed);");
    expect(block).toContain("withheld: withheldFunctions");
    expect(block).not.toContain("pendingDeletes");
  });
});

describe("the ratchet spec's tables, on a clone that withholds functions", () => {
  // The shape of F-02 in `auditRemediation.spec.ts`: a table of functions a
  // check applies to, one of which the independent CRM line does not carry.
  const SPEC = [
    "describe('F-02', () => {",
    "  it.each([",
    "    'email-body-backfill',",
    "    'backfill-message-directions',",
    "    'backfill-investment-scores',",
    "  ])('%s is verify_jwt = true', (fn) => {",
    "    expect(fn).toBeTruthy();",
    "  });",
    "});",
    "describe('the config', () => {",
    "  it('every function still declares verify_jwt explicitly', () => {",
    "    const declared = [...CONFIG.matchAll(",
    "      /\\[functions\\.([A-Za-z0-9_-]+)\\][^[]*?verify_jwt\\s*=\\s*(true|false)/gs)];",
    "    expect(declared.length).toBe(2);",
    "  });",
    "});",
    "",
  ].join("\n");

  it("takes out the row naming a withheld function, and only that row", () => {
    const out = reconcileFunctionCountRatchet({
      primeSpec: SPEC,
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message"],
      withheld: ["backfill-message-directions"],
    });
    expect(out.ok).toBe(true);
    const merged = (out as { merged: string }).merged;
    expect(merged).not.toContain("'backfill-message-directions'");
    expect(merged).toContain("    'email-body-backfill',\n    'backfill-investment-scores',\n  ])");
    expect(merged).toContain("expect(declared.length).toBe(3);");
  });

  it("leaves the table alone where nothing in it is withheld", () => {
    const out = dropWithheldTableRows(SPEC, ["ghl-calendar"]);
    expect(out).toEqual({ ok: true, text: SPEC, dropped: [] });
  });

  it("does not touch a name outside a table", () => {
    // Prose or another kind of assertion is not something this can read.
    const prose = "// 'backfill-message-directions',\nconst x = ['backfill-message-directions'];\n";
    const out = dropWithheldTableRows(prose, ["backfill-message-directions"]);
    expect(out).toEqual({ ok: true, text: prose, dropped: [] });
  });

  it("refuses to empty a table, because an empty table stopped checking", () => {
    const only = "it.each([\n  'backfill-message-directions',\n])('%s', () => {});\n";
    expect(dropWithheldTableRows(only, ["backfill-message-directions"]).ok).toBe(false);
    expect(
      reconcileFunctionCountRatchet({
        primeSpec: only + SPEC,
        mergedToml: CLONE_TOML,
        cloneOwnedFunctions: [],
        withheld: ["backfill-message-directions"],
      }).ok,
    ).toBe(false);
  });

  it("is a fixed point with the rows taken out", () => {
    const args = {
      mergedToml: CLONE_TOML,
      cloneOwnedFunctions: ["crm-send-message"],
      withheld: ["backfill-message-directions"],
    };
    const once = reconcileFunctionCountRatchet({ primeSpec: SPEC, ...args }) as { merged: string };
    const twice = reconcileFunctionCountRatchet({ primeSpec: once.merged, ...args }) as {
      merged: string;
    };
    expect(twice.merged).toBe(once.merged);
  });
});

describe("given both trees, the graph is attributed caller by caller", () => {
  const F = (p: string) => `supabase/functions/${p}`;
  /** Prime's tree: its two functions and one shared module. */
  const PRIME_TREE = new Map([
    [F("alpha/index.ts"), "alpha-prime"],
    [F("beta/index.ts"), "beta-prime"],
    [F("_shared/auth.ts"), "auth-shared"],
    ["src/main.tsx", "main-prime"],
  ]);
  /** The clone's tree: older copies of those, and a function of its own. */
  const CLONE_TREE = new Map([
    [F("alpha/index.ts"), "alpha-old"],
    [F("beta/index.ts"), "beta-old"],
    [F("crm-send-message/index.ts"), "crm-clone"],
    [F("_shared/auth.ts"), "auth-shared"],
    ["src/main.tsx", "main-clone"],
  ]);
  const withGraph = (inventory: string, graph: string[]) =>
    JSON.stringify(
      { ...JSON.parse(inventory), statically_derivable_inter_function_graph: graph },
      null,
      2,
    );
  const graphOf = (out: ReturnType<typeof reconcileSecurityInventory>) => {
    expect(out.ok, out.ok ? "" : out.reason).toBe(true);
    return JSON.parse((out as { merged: string }).merged)
      .statically_derivable_inter_function_graph as string[];
  };
  const withTrees = (over: Partial<Parameters<typeof reconcileSecurityInventory>[0]> = {}) =>
    reconcile({ primeTree: PRIME_TREE, cloneTree: CLONE_TREE, ...over });

  it("carries the edge of a function only the clone holds (cascade #81)", () => {
    // The clone's CRM function calls one of prime's. The two graphs differ
    // for good, and the identical-graph rule refused every pass for it.
    const clone = withGraph(CLONE_INVENTORY, ["alpha->beta", "crm-send-message->alpha"]);
    expect(reconcile({ cloneInventoryJson: clone }).ok).toBe(false);
    expect(graphOf(withTrees({ cloneInventoryJson: clone }))).toEqual([
      "alpha->beta",
      "crm-send-message->alpha",
    ]);
  });

  it("takes prime's edges for a caller this pass writes entirely at prime's version", () => {
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta", "alpha->crm-send-message"]);
    expect(graphOf(withTrees({ primeInventoryJson: prime }))).toEqual([
      "alpha->beta",
      "alpha->crm-send-message",
    ]);
  });

  it("takes the clone's edges for a caller this pass leaves alone", () => {
    // beta is not delivered: the clone keeps its own copy, and its edge.
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta"]);
    const clone = withGraph(CLONE_INVENTORY, ["alpha->beta", "beta->crm-send-message"]);
    expect(
      graphOf(
        withTrees({
          primeInventoryJson: prime,
          cloneInventoryJson: clone,
          deliveredPaths: [F("alpha/index.ts")],
        }),
      ),
    ).toEqual(["alpha->beta", "beta->crm-send-message"]);
  });

  it("never credits prime with a file a pump rewrote", () => {
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta", "alpha->crm-send-message"]);
    const out = withTrees({ primeInventoryJson: prime, rewrittenPaths: [F("alpha/index.ts")] });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("`alpha`");
  });

  it("counts a blob both sides hold identically as either side's", () => {
    // alpha is not delivered, but the clone already holds prime's copy, so
    // prime's edge stands even where the clone's stored baseline lacks it.
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta", "alpha->crm-send-message"]);
    const out = withTrees({
      primeInventoryJson: prime,
      cloneTree: new Map([...CLONE_TREE, [F("alpha/index.ts"), "alpha-prime"]]),
      deliveredPaths: [F("beta/index.ts")],
    });
    expect(graphOf(out)).toEqual(["alpha->beta", "alpha->crm-send-message"]);
  });

  it("carries a mixed caller where both sides record the same edges for it", () => {
    // `_shared` takes a module from each side on every clone that keeps one
    // of its own. Both record the same edge, so the split cannot matter.
    const both = ["_shared->beta", "alpha->beta"];
    const out = withTrees({
      primeInventoryJson: withGraph(PRIME_INVENTORY, both),
      cloneInventoryJson: withGraph(CLONE_INVENTORY, [...both, "crm-send-message->alpha"]),
      primeTree: new Map([...PRIME_TREE, [F("_shared/new.ts"), "new-prime"]]),
      cloneTree: new Map([...CLONE_TREE, [F("_shared/crm.ts"), "crm-shared"]]),
      mergedTreePaths: [...MERGED_TREE, F("_shared/new.ts"), F("_shared/crm.ts")],
      deliveredPaths: [...DELIVERED, F("_shared/new.ts")],
    });
    expect(graphOf(out)).toEqual(["_shared->beta", "alpha->beta", "crm-send-message->alpha"]);
  });

  it("refuses a mixed caller the two sides disagree about, naming it", () => {
    const out = withTrees({
      primeInventoryJson: withGraph(PRIME_INVENTORY, ["_shared->beta", "alpha->beta"]),
      cloneInventoryJson: withGraph(CLONE_INVENTORY, ["alpha->beta"]),
      primeTree: new Map([...PRIME_TREE, [F("_shared/new.ts"), "new-prime"]]),
      cloneTree: new Map([...CLONE_TREE, [F("_shared/crm.ts"), "crm-shared"]]),
      mergedTreePaths: [...MERGED_TREE, F("_shared/new.ts"), F("_shared/crm.ts")],
      deliveredPaths: [...DELIVERED, F("_shared/new.ts")],
    });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("`_shared`");
    expect((out as { reason: string }).reason).toContain("both the prime and this clone");
  });

  it("carries nothing for a function the clone does not hold and this pass does not deliver", () => {
    // Prime's `gamma` is outside this clone's scope: its edge describes a
    // file the merged tree does not have.
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta", "gamma->alpha"]);
    const out = withTrees({
      primeInventoryJson: prime,
      primeTree: new Map([...PRIME_TREE, [F("gamma/index.ts"), "gamma-prime"]]),
    });
    expect(graphOf(out)).toEqual(["alpha->beta"]);
  });

  it("drops a withheld function's edges whether or not its files are still on the clone", () => {
    const prime = withGraph(PRIME_INVENTORY, ["alpha->beta", "migration-dispatcher->alpha"]);
    const withDispatcher = new Map([...PRIME_TREE, [F("migration-dispatcher/index.ts"), "md"]]);
    const out = withTrees({
      primeInventoryJson: prime,
      primeTree: withDispatcher,
      withheld: ["migration-dispatcher"],
    });
    expect(graphOf(out)).toEqual(["alpha->beta"]);
  });

  it("still refuses differing graphs given only one of the trees", () => {
    const clone = withGraph(CLONE_INVENTORY, ["alpha->beta", "crm-send-message->alpha"]);
    for (const over of [{ primeTree: PRIME_TREE }, { cloneTree: CLONE_TREE }]) {
      const out = reconcile({ cloneInventoryJson: clone, ...over });
      expect(out.ok).toBe(false);
      expect((out as { reason: string }).reason).toContain("call graph");
    }
  });

  it("is the generator's answer re-filed, so the output stays sorted", () => {
    const out = attributeGraphByCaller({
      primeGraph: ["beta->alpha"],
      cloneGraph: ["crm-send-message->alpha", "alpha->beta"],
      primeTree: PRIME_TREE,
      cloneTree: CLONE_TREE,
      mergedPaths: MERGED_TREE,
      deliveredFiles: new Set([F("beta/index.ts")]),
      rewritten: new Set(),
    });
    expect(out).toEqual({
      ok: true,
      graph: ["alpha->beta", "beta->alpha", "crm-send-message->alpha"],
    });
  });

  it("is reached from both engine call sites with both trees and the rewritten paths", () => {
    const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");
    const calls = engine
      .split("reconcileSecurityInventory({")
      .slice(1)
      .map((c) => c.slice(0, c.indexOf("})")));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(/primeTree: /);
      expect(call).toMatch(/cloneTree: /);
      expect(call).toContain("rewrittenPaths: reconciledPaths");
    }
  });
});
