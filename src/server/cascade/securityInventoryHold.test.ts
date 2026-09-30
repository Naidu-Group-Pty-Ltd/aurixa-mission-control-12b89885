import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FUNCTION_COUNT_RATCHET_PATH,
  SECURITY_INVENTORY_PATH,
  cloneOnlyEdgeFunctions,
  describeFunctionSetDifference,
  edgeFunctionNames,
  functionCountRatchetHold,
  securityInventoryHold,
} from "./securityInventoryHold.pure";
import { REPOSITORY_INVARIANTS, repositoryInvariantGlobs } from "./repositoryInvariants.pure";
import { approvableHeld, reportableHeld } from "./syncExclusions.pure";
import { stripComments } from "../sourceComments.pure";
import { PRIME_ONLY_FEATURES } from "../primeOnlyFeatures.pure";
import { globToRegex, validateModuleGlobs } from "@/lib/module-globs";

/**
 * Whether the invariant list offers a PATH, which is the guarantee these two
 * tests exist for. They used to compare `i.pattern` to the path, which is a
 * statement about a glob's spelling rather than about what it reaches — so
 * widening `docs/reports/SECTION_OWNERSHIP_MATRIX.md` to `docs/**` broke them
 * while strengthening the thing they protect. Matched the same way
 * repositoryInvariants.test.ts matches, and for the same stated reason:
 * rewriting a glob keeps the guarantee as long as the file is still covered.
 */
const invariantCovers = (path: string): boolean =>
  validateModuleGlobs(repositoryInvariantGlobs())
    .valid.map(globToRegex)
    .some((m) => m.test(path));

describe("whether prime's security baseline may be written over a clone's", () => {
  it("lets it travel to a mirror, exactly as it does today", () => {
    // The invariant carries it for a reason that stays: without the baseline
    // beside the functions it describes, a clone that receives a new function
    // goes red on a file the cascade itself wrote.
    expect(securityInventoryHold([])).toBeNull();
  });

  it("withholds it from a clone that owns functions prime has never analysed", () => {
    const held = securityInventoryHold(["crm-send-message", "crm-calendar"]);
    expect(held).not.toBeNull();
    expect(held?.path).toBe(SECURITY_INVENTORY_PATH);
  });

  it("names the functions, and the one command that settles it", () => {
    // A hold an operator cannot act on is the "Needs a human" section saying
    // a human is needed and not what for.
    const held = securityInventoryHold(["crm-send-message", "crm-calendar"]);
    expect(held?.note).toContain("crm-calendar, crm-send-message");
    expect(held?.note).toContain("npm run security:inventory");
  });

  it("counts each function once and reports them in a stable order", () => {
    const a = securityInventoryHold(["b", "a", "b"]);
    const b = securityInventoryHold(["a", "b"]);
    expect(a?.note).toBe(b?.note);
    expect(a?.note).toContain("owns 2 edge function(s)");
  });

  it("is a decision a person can take, so it is reported and approvable", () => {
    // `protected` would be silent — `reportableHeld` filters it out — and a
    // baseline that quietly stopped arriving is the failure mode this hold is
    // meant to make visible.
    const held = securityInventoryHold(["crm-calendar"]);
    expect(held).not.toBeNull();
    expect(reportableHeld([held!])).toHaveLength(1);
    expect(approvableHeld([held!])).toHaveLength(1);
  });

  it("holds the path the invariant list carries, so the two cannot drift", () => {
    expect(invariantCovers(SECURITY_INVENTORY_PATH)).toBe(true);
  });
});

describe("how the engine uses it", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("decides it AFTER both reconciles, because they are the evidence", () => {
    // Asked before them, `cloneOwnedFunctions` is empty and the hold never
    // fires — a control that is present, reachable and always answers no.
    const config = engine.indexOf("reconcileConfigToml({");
    const registry = engine.indexOf("reconcileSecurityRegistry({");
    const hold = engine.indexOf("securityInventoryHold(cloneOwnedFunctions, withheldFunctions)");
    expect(config).toBeGreaterThan(-1);
    expect(registry).toBeGreaterThan(config);
    expect(hold).toBeGreaterThan(registry);
  });

  it("removes prime's copy from the tree whatever happens next", () => {
    // Both baselines now go through `settleBaseline`, which either writes a
    // computed one or leaves the hold standing. Asserted on that function's
    // own body rather than on a window of characters after the hold call:
    // the property is that prime's copy never survives, and a test that
    // matched the old spelling would pass on a settle that dropped the path
    // in only one of its two branches.
    const at = engine.indexOf("const settleBaseline = async (");
    expect(at).toBeGreaterThan(-1);
    const body = engine.slice(at, at + 1400);
    const drop = body.indexOf("dropFromTree(held.path)");
    const branch = body.indexOf("if (!outcome || !outcome.ok)");
    expect(drop).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(drop);
    expect(body).toContain("partition.held.push({ ...held");
    expect(body).toContain("needsReconcile.push({ ...held");
  });

  it("offers the hold to both baselines, and to nothing else", () => {
    // Bounded by the next pump rather than by a count of characters: the
    // block grew once already, and a window that silently stops short of the
    // second settle fails for a reason that has nothing to do with it.
    const at = engine.indexOf("securityInventoryHold(cloneOwnedFunctions, withheldFunctions)");
    const end = engine.indexOf("reconcileApiSurface({", at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = engine.slice(at, end);
    expect(block).toMatch(/await settleBaseline\(\s*inventoryHold,/);
    expect(block).toMatch(/await settleBaseline\(\s*ratchetHold,/);
  });

  it("names the path in one place", () => {
    expect(SECURITY_INVENTORY_PATH).toBe("docs/security/SECURITY_INVENTORY.json");
    expect(engine).not.toContain('"docs/security/SECURITY_INVENTORY.json"');
  });
});

describe("the generated matrix travels with the registry that generates it", () => {
  it("is a repository invariant", () => {
    // Its inputs are the section registries, which are inside module globs.
    // They cascade and the document does not, so the clone's committed copy
    // describes routing the cascaded code no longer performs and
    // `sectionOwnershipMatrix.spec.ts` fails on the difference.
    const path = "docs/reports/SECTION_OWNERSHIP_MATRIX.md";
    expect(invariantCovers(path)).toBe(true);
    // And the entry that reaches it still says which check reads it, so the
    // widening did not cost the reason — it is now one of three the docs
    // entry names.
    const entry = REPOSITORY_INVARIANTS.find((i) =>
      globToRegex(validateModuleGlobs([i.pattern]).valid[0] ?? "\u0000").test(path),
    );
    expect(entry?.reason).toContain("sectionOwnershipMatrix.spec.ts");
  });
});

describe("what the clone owns is read off the tree, not off its declarations", () => {
  // Measured on npc-crm-independent, 21 Sep 2026. The clone holds three
  // function directories prime does not and declares NONE of them, so every
  // declaration-derived answer here is the empty set.
  const CLONE_ONLY = ["crm-calendar", "crm-inbound-message", "crm-send-message"];

  const primePaths = [
    "supabase/functions/_shared/auth_v2.ts",
    "supabase/functions/generate-investment-report/index.ts",
    "supabase/functions/urban-centre-register-ingest/index.ts",
    "supabase/functions/voice-to-text/index.ts",
    "src/App.tsx",
  ];
  const clonePaths = [
    "supabase/functions/_shared/auth_v2.ts",
    "supabase/functions/generate-investment-report/index.ts",
    "supabase/functions/voice-to-text/index.ts",
    ...CLONE_ONLY.map((n) => `supabase/functions/${n}/index.ts`),
    "src/App.tsx",
  ];

  it("counts a directory, because that is what the generator counts", () => {
    // scripts/security/security-inventory.mjs:
    //   readdirSync(functionsDir).filter((n) => n !== '_shared' && …isDirectory())
    // A rule of "a directory with an index.ts" is merely reasonable, and would
    // have missed crm-inbound-message — one of the three that caused this.
    expect([...edgeFunctionNames(["supabase/functions/crm-inbound-message/lib/send.ts"])]).toEqual([
      "crm-inbound-message",
    ]);
  });

  it("is not fooled by the shared library or by a loose file", () => {
    expect(
      [
        ...edgeFunctionNames([
          "supabase/functions/_shared/auth_v2.ts",
          "supabase/functions/_shared/tests/auth.test.ts",
          "supabase/functions/deno.json",
          "supabase/functions/README.md",
          "supabase/migrations/0001.sql",
        ]),
      ].sort(),
    ).toEqual([]);
  });

  it("finds the three functions that made this clone go red", () => {
    expect(cloneOnlyEdgeFunctions({ primePaths, clonePaths })).toEqual(CLONE_ONLY);
  });

  it("holds the baseline for that clone, which the declarations never did", () => {
    const owned = cloneOnlyEdgeFunctions({ primePaths, clonePaths });
    expect(owned).not.toBeNull();
    const held = securityInventoryHold(owned!);
    expect(held?.path).toBe(SECURITY_INVENTORY_PATH);
    expect(held?.note).toContain("crm-calendar, crm-inbound-message, crm-send-message");
  });

  it("says nothing about a mirror, so its baseline still travels", () => {
    expect(cloneOnlyEdgeFunctions({ primePaths, clonePaths: primePaths })).toEqual([]);
    expect(securityInventoryHold([])).toBeNull();
  });

  it("does not hold a function prime has that the clone merely lacks", () => {
    // `urban-centre-register-ingest` is prime-only here. That is a real
    // problem for the baseline too, but it is NOT this hold's question and
    // answering it from this direction would hold the file on every
    // module-scoped clone in the fleet.
    const primeOnly = cloneOnlyEdgeFunctions({ primePaths, clonePaths: primePaths.slice(1) });
    expect(primeOnly).toEqual([]);
  });

  it("answers null when a tree could not be listed, never an empty set", () => {
    // An empty set means "mirror — let it travel". Saying that because
    // nothing could be measured writes prime's baseline on no evidence.
    expect(cloneOnlyEdgeFunctions({ primePaths, clonePaths: null })).toBeNull();
    expect(cloneOnlyEdgeFunctions({ primePaths: null, clonePaths })).toBeNull();
    expect(cloneOnlyEdgeFunctions({ primePaths: undefined, clonePaths: undefined })).toBeNull();
  });

  it("takes a Map's keys, which is what the engine holds", () => {
    const prime = new Map(primePaths.map((p) => [p, "sha"]));
    const clone = new Map(clonePaths.map((p) => [p, "sha"]));
    expect(cloneOnlyEdgeFunctions({ primePaths: prime.keys(), clonePaths: clone.keys() })).toEqual(
      CLONE_ONLY,
    );
  });
});

describe("the engine reads the tree before it decides", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("derives the owned set from the two tree listings", () => {
    expect(engine).toContain("cloneOnlyEdgeFunctions({");
    expect(engine).toContain("primePaths: primeShaByPath?.keys()");
    expect(engine).toContain("clonePaths: cloneShaByPath?.keys()");
  });

  it("unions it into the declarations rather than replacing them", () => {
    // The declarations are still the only evidence where a tree could not be
    // listed, and dropping them would make this newly blind in that case.
    const at = engine.indexOf("const ownedByTree = cloneOnlyEdgeFunctions({");
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 400);
    expect(block).toContain("ownedByTree !== null");
    expect(block).toContain("[...new Set([...cloneOwnedFunctions, ...ownedByTree])]");
  });

  it("does it after both reconciles and before the hold", () => {
    const registry = engine.indexOf("reconcileSecurityRegistry({");
    const tree = engine.indexOf("const ownedByTree = cloneOnlyEdgeFunctions({");
    const hold = engine.indexOf("securityInventoryHold(cloneOwnedFunctions, withheldFunctions)");
    expect(tree).toBeGreaterThan(registry);
    expect(hold).toBeGreaterThan(tree);
  });
});

describe("the baseline's sibling — the function-count ratchet", () => {
  it("lets it travel to a mirror, exactly as the baseline does", () => {
    // A mirror declares what prime declares, so prime's number is this
    // repository's number and withholding it would freeze the spec for no
    // reason. Same conditional, same evidence, same default.
    expect(functionCountRatchetHold([])).toBeNull();
  });

  it("withholds it from a clone that declares functions prime has never had", () => {
    const held = functionCountRatchetHold(["crm-send-message", "crm-calendar"]);
    expect(held).not.toBeNull();
    expect(held?.path).toBe(FUNCTION_COUNT_RATCHET_PATH);
    expect(held?.reason).toBe("manual_reconcile");
  });

  it("names the functions that make the two counts differ", () => {
    const held = functionCountRatchetHold(["crm-send-message", "crm-calendar"]);
    expect(held?.note).toContain("crm-calendar, crm-send-message");
    expect(held?.note).toContain("supabase/config.toml");
  });

  it("fires on exactly the evidence the baseline fires on", () => {
    // Not a restatement: the whole point is that one file was guarded and its
    // sibling was not, so a future change that narrows one must narrow both
    // or be seen to.
    for (const owned of [[], ["a"], ["a", "b"], ["crm-calendar"]]) {
      expect(functionCountRatchetHold(owned) === null).toBe(securityInventoryHold(owned) === null);
    }
  });

  it("is a different file from the baseline, or it guards nothing new", () => {
    expect(FUNCTION_COUNT_RATCHET_PATH).not.toBe(SECURITY_INVENTORY_PATH);
  });

  it("does not claim to make the proposal green", () => {
    // The merged config adds prime's new declarations to this clone's own, so
    // a held number is one apart rather than in agreement. Saying otherwise in
    // the note would send an operator to look for a passing check.
    const held = functionCountRatchetHold(["crm-calendar"]);
    expect(held?.note).not.toMatch(/\bgreen\b|will pass|now matches/i);
    expect(held?.note).toContain("the number to update");
  });

  it("counts each function once and reports them in a stable order", () => {
    const a = functionCountRatchetHold(["b", "a", "b"]);
    const b = functionCountRatchetHold(["a", "b"]);
    expect(a?.note).toBe(b?.note);
  });
});

describe("how the engine uses the ratchet hold", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("decides it from the same reconciled evidence, after both reconciles", () => {
    const registry = engine.indexOf("reconcileSecurityRegistry({");
    const hold = engine.indexOf("functionCountRatchetHold(cloneOwnedFunctions, withheldFunctions)");
    expect(registry).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(registry);
  });

  it("is settled rather than only reported", () => {
    // Reporting alone is what the cascade did for a fortnight: the file was
    // listed as `modified` and the count was replaced anyway. It is settled
    // through the same `settleBaseline` the inventory is, which drops prime's
    // copy before it decides anything else.
    const at = engine.indexOf("functionCountRatchetHold(cloneOwnedFunctions, withheldFunctions)");
    expect(at).toBeGreaterThan(-1);
    expect(engine.slice(at)).toMatch(/await settleBaseline\(\s*ratchetHold,/);
  });

  it("is computed from the config this same pass will land", () => {
    // A count taken from prime's config or from the clone's stale one is a
    // number about a repository this proposal does not create.
    const at = engine.indexOf("reconcileFunctionCountRatchet({");
    expect(at).toBeGreaterThan(-1);
    const call = engine.slice(at, at + 200);
    expect(call).toContain("primeSpec: primeRatchetSpec");
    expect(call).toContain("mergedToml,");
    expect(call).toContain("cloneOwnedFunctions,");
  });

  it("reaches an operator, because a silent hold is the defect it replaces", () => {
    const held = functionCountRatchetHold(["crm-calendar"]);
    expect(held).not.toBeNull();
    expect(reportableHeld([held!])).toHaveLength(1);
    expect(approvableHeld([held!])).toHaveLength(1);
  });
});

/*
  A clone can differ from the prime by holding LESS. The prime keeps the
  GoHighLevel account migration for itself (`primeOnlyFeatures.pure.ts`), and
  a clone without it is prime's function set less twenty-eight — so prime's
  two numbers count functions its tree does not have.
*/
describe("a clone that does not hold what the prime keeps for itself", () => {
  const WITHHELD = ["migration-job-status", "migration-dispatcher"];

  it("holds both baselines on the withheld set alone", () => {
    expect(securityInventoryHold([], WITHHELD)?.path).toBe(SECURITY_INVENTORY_PATH);
    expect(functionCountRatchetHold([], WITHHELD)?.path).toBe(FUNCTION_COUNT_RATCHET_PATH);
  });

  it("still lets both travel where neither set has anything in it", () => {
    expect(securityInventoryHold([], [])).toBeNull();
    expect(functionCountRatchetHold([], [])).toBeNull();
  });

  it("says what the clone lacks, and still names the command that settles it", () => {
    const inv = securityInventoryHold([], WITHHELD);
    expect(inv?.note).toContain(
      "does not carry the GoHighLevel account migration (2 of 28 functions: " +
        "migration-dispatcher, migration-job-status), which the prime keeps for itself",
    );
    expect(inv?.note).toContain("npm run security:inventory");
    expect(inv?.note).not.toContain("owns 0");
    const ratchet = functionCountRatchetHold([], WITHHELD);
    expect(ratchet?.note).toContain("omits the declarations of the GoHighLevel account migration");
    expect(ratchet?.note).toContain("the number to update");
    expect(ratchet?.note).not.toContain("declares 0");
  });

  it("names both differences where a clone has both", () => {
    const inv = securityInventoryHold(["crm-send-message"], WITHHELD);
    expect(inv?.note).toContain("owns 1 edge function(s) the prime does not (crm-send-message)");
    expect(inv?.note).toContain(" and does not carry the GoHighLevel account migration");
    const ratchet = functionCountRatchetHold(["crm-send-message"], WITHHELD);
    expect(ratchet?.note).toContain("declares 1 the prime does not (crm-send-message) and omits");
  });

  it("writes the sentence it always has where nothing is withheld", () => {
    // Every CRM pass has shown an operator this wording; a second argument of
    // nothing must not re-word it.
    expect(securityInventoryHold(["crm-calendar"], [])?.note).toBe(
      securityInventoryHold(["crm-calendar"])?.note,
    );
    expect(securityInventoryHold(["crm-calendar"])?.note).toContain(
      "This clone owns 1 edge function(s) the prime does not (crm-calendar), so the prime's",
    );
  });
});

describe("the one clause that describes the difference", () => {
  it("is the owned-only wording when nothing is withheld", () => {
    expect(describeFunctionSetDifference(["b", "a", "a"], [])).toBe(
      "owns 2 edge function(s) the prime does not (a, b)",
    );
  });

  it("names the feature, not twenty-eight functions, when the whole of it is missing", () => {
    const migration = PRIME_ONLY_FEATURES.find((f) => f.key === "ghl-account-migration")!;
    const text = describeFunctionSetDifference([], migration.functions);
    expect(text).toBe(
      "does not carry the GoHighLevel account migration (all 28 functions), which the prime " +
        "keeps for itself",
    );
  });

  it("joins the two halves with 'and', owned first", () => {
    expect(describeFunctionSetDifference(["crm-calendar"], ["migration-dispatcher"])).toBe(
      "owns 1 edge function(s) the prime does not (crm-calendar) and does not carry the " +
        "GoHighLevel account migration (1 of 28 functions: migration-dispatcher), which the " +
        "prime keeps for itself",
    );
  });

  it("is what the pull request body says, so the three cannot drift", () => {
    const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
    expect(engine).toContain(
      "describeFunctionSetDifference(cloneOwnedFunctions, withheldFunctions)",
    );
  });
});
