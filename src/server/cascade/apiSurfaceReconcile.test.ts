import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  API_SURFACE_PATH,
  reconcileApiSurface,
  surfaceVerifyJwt,
} from "./apiSurfaceReconcile.pure";
import { CLONE_OWNED_MARKER, reconcileConfigToml } from "./configTomlReconcile.pure";
import {
  reconcileSecurityRegistry,
  serialiseSecurityRegistry,
} from "./securityRegistryReconcile.pure";
import { stripComments } from "../sourceComments.pure";

/**
 * THE GENERATOR, as the oracle these fixtures are made with.
 *
 * `scripts/mobile/export-api-surface.mjs` at prime@387feb03, its `build()`
 * transcribed with nothing changed but the file reads — `localeCompare`
 * included. It lives here and nowhere in the module under test: the module
 * reads the class-to-scope map out of prime's committed file and proves its
 * composition against that file on every pass, so this copy only makes the
 * fixtures and never decides anything in production.
 */
const SCOPE_BY_CLASS = new Map([
  ["portal-authenticated", "portal"],
  ["public", "public"],
  ["public-auth", "public"],
  ["human-authenticated", "staff"],
  ["authenticated-staff", "staff"],
  ["module-gated", "staff"],
  ["superadmin-only", "staff"],
  ["authenticated-or-service", "staff"],
  ["webhook", "server-only"],
  ["webhook-secret", "server-only"],
  ["webhook-clientstate", "server-only"],
  ["cron-worker", "server-only"],
  ["internal-service", "server-only"],
]);

function generate(registryJson: string, toml: string): string {
  const registry = JSON.parse(registryJson).functions as Record<string, { exposure_class: string }>;
  const declared = new Map<string, boolean>();
  const re = /\[functions\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml))) {
    const v = /verify_jwt\s*=\s*(true|false)/.exec(m[2]);
    declared.set(m[1], v ? v[1] === "true" : true);
  }
  const functions = Object.entries(registry)
    .map(([name, entry]) => ({
      name,
      exposure_class: entry.exposure_class,
      mobileScope: SCOPE_BY_CLASS.get(entry.exposure_class) ?? "unmapped",
      verify_jwt: declared.has(name) ? declared.get(name) : true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts: Record<string, number> = {};
  for (const f of functions) counts[f.mobileScope] = (counts[f.mobileScope] ?? 0) + 1;
  return `${JSON.stringify(
    {
      $comment:
        "GENERATED — do not edit. npm run mobile:api regenerates from the " +
        "security registry + config.toml. mobileScope: portal/public = v1 app " +
        "surface, staff = phase 2 (Command Centre), server-only = never " +
        "client-called. See mobile/plan.md.",
      sources: ["supabase/functions-registry/SECURITY_REGISTRY.json", "supabase/config.toml"],
      counts,
      functions,
    },
    null,
    2,
  )}\n`;
}

const PRIME_REF = "dduzbchuswwbefdunfct";
const CLONE_REF = "umrtusxohxjxzodxorim";

const entry = (exposure_class: string) => ({ exposure_class, owner: "x", reviewed: true });

/*
  Shaped like the prime's inputs. The registry is written OUT of name order,
  because the generator sorts and the reconcile must too. Sorted, the scopes
  first appear as staff, public, server-only, portal — which is not their
  alphabetical order, so a `counts` object built any other way than the
  generator's shows up here. `portal-documents` is declared nowhere, and the
  generator reads that as `verify_jwt = true`.
*/
const PRIME_REGISTRY = serialiseSecurityRegistry({
  $comment: "Edge Function security registry (EDGE-001).",
  functions: {
    "portal-documents": entry("portal-authenticated"),
    "aml-cases": entry("human-authenticated"),
    "migration-job-control": entry("human-authenticated"),
    "client-portal-login": entry("public-auth"),
    "didit-webhook": entry("webhook"),
    "migration-dispatcher": entry("internal-service"),
  },
});

const toml = (ref: string, blocks: string) => `project_id = "${ref}"

[api]
enabled = true
${blocks}`;

const PRIME_BLOCKS = `
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false

[functions.migration-dispatcher]
verify_jwt = false

[functions.migration-job-control]
verify_jwt = true

[functions.client-portal-login]
verify_jwt = false
`;

const PRIME_TOML = toml(PRIME_REF, PRIME_BLOCKS);
const PRIME_SURFACE = generate(PRIME_REGISTRY, PRIME_TOML);
const PRIME_ONLY = ["migration-dispatcher", "migration-job-control"];

/** The registry and config pumps' own output for a clone, as the engine chains them. */
function pumped(args: { cloneRegistry: string; cloneToml: string; withheld: string[] }) {
  const registry = reconcileSecurityRegistry({
    primeJson: PRIME_REGISTRY,
    cloneJson: args.cloneRegistry,
    withheld: args.withheld,
  });
  const config = reconcileConfigToml({
    primeToml: PRIME_TOML,
    cloneToml: args.cloneToml,
    ownRef: CLONE_REF,
    withheld: args.withheld,
  });
  if (!registry.ok || !config.ok) throw new Error("fixture pumps refused");
  return { mergedRegistryJson: registry.merged, mergedToml: config.merged };
}

const reconcile = (merged: { mergedRegistryJson: string; mergedToml: string }) =>
  reconcileApiSurface({
    primeSurfaceJson: PRIME_SURFACE,
    primeRegistryJson: PRIME_REGISTRY,
    primeToml: PRIME_TOML,
    ...merged,
  });

describe("the mobile surface a clone's own registry and config generate", () => {
  it("is the generator's output for a clone that does not hold the prime's own functions", () => {
    const merged = pumped({
      cloneRegistry: PRIME_REGISTRY,
      cloneToml: toml(CLONE_REF, PRIME_BLOCKS),
      withheld: PRIME_ONLY,
    });
    const v = reconcile(merged);
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    // The standard is the generator run on the same two files, which is what
    // the clone's own `mobile:api:check` does.
    expect(v.merged).toBe(generate(merged.mergedRegistryJson, merged.mergedToml));
    expect(v.merged).not.toContain("migration-");
    expect(v.count).toBe(4);
    expect(v.leftOut).toEqual(PRIME_ONLY);
    expect(v.added).toEqual([]);
  });

  it("keeps what a clone owns, at the scope and gate its own files give it", () => {
    const cloneRegistry = serialiseSecurityRegistry({
      $comment: "Edge Function security registry (EDGE-001).",
      functions: { ...JSON.parse(PRIME_REGISTRY).functions, "crm-send-message": entry("webhook") },
    });
    const merged = pumped({
      cloneRegistry,
      cloneToml: toml(
        CLONE_REF,
        `${PRIME_BLOCKS}\n[functions.crm-send-message]\nverify_jwt = false\n`,
      ),
      withheld: PRIME_ONLY,
    });
    // The config pump writes its marker above the carried block, and the
    // marker's `<name>` placeholder is outside the generator's name class.
    expect(merged.mergedToml).toContain(CLONE_OWNED_MARKER);
    const v = reconcile(merged);
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toBe(generate(merged.mergedRegistryJson, merged.mergedToml));
    expect(v.added).toEqual(["crm-send-message"]);
    const crm = JSON.parse(v.merged).functions.find(
      (f: { name: string }) => f.name === "crm-send-message",
    );
    expect(crm).toEqual({
      name: "crm-send-message",
      exposure_class: "webhook",
      mobileScope: "server-only",
      verify_jwt: false,
    });
  });

  it("is the prime's own file, byte for byte, for a clone whose set is the prime's", () => {
    const v = reconcile({ mergedRegistryJson: PRIME_REGISTRY, mergedToml: PRIME_TOML });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toBe(PRIME_SURFACE);
    expect(v.leftOut).toEqual([]);
    expect(v.added).toEqual([]);
  });

  it("counts scopes in the order they first appear, as the generator does", () => {
    expect(Object.keys(JSON.parse(PRIME_SURFACE).counts)).toEqual([
      "staff",
      "public",
      "server-only",
      "portal",
    ]);
    const v = reconcile({ mergedRegistryJson: PRIME_REGISTRY, mergedToml: PRIME_TOML });
    expect(v.ok && Object.keys(JSON.parse(v.merged).counts)).toEqual([
      "staff",
      "public",
      "server-only",
      "portal",
    ]);
  });

  it("orders names the way the generator's localeCompare does, over the names it accepts", () => {
    // The claim the module rests on: over `a-z`, `0-9` and `-`, code-point
    // order and collation agree. Checked here against the runtime's own
    // localeCompare, on the names where they could first disagree.
    const names = ["ab", "a-b", "a1", "a-1", "a", "ab-c", "b", "a10", "a2"];
    const registry = serialiseSecurityRegistry({
      functions: Object.fromEntries(names.map((n) => [n, entry("webhook")])),
    });
    const surface = generate(registry, PRIME_TOML);
    const v = reconcileApiSurface({
      primeSurfaceJson: surface,
      primeRegistryJson: registry,
      primeToml: PRIME_TOML,
      mergedRegistryJson: registry,
      mergedToml: PRIME_TOML,
    });
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toBe(surface);
  });
});

describe("reading verify_jwt the way the generator reads it", () => {
  it("defaults an undeclared function to true", () => {
    const declared = surfaceVerifyJwt(PRIME_TOML);
    expect(declared.has("portal-documents")).toBe(false);
    const v = reconcile({ mergedRegistryJson: PRIME_REGISTRY, mergedToml: PRIME_TOML });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const portal = JSON.parse(v.merged).functions.find(
      (f: { name: string }) => f.name === "portal-documents",
    );
    expect(portal.verify_jwt).toBe(true);
  });

  it("reads a block that declares nothing as true", () => {
    expect(surfaceVerifyJwt("[functions.a]\n# nothing here\n").get("a")).toBe(true);
  });

  it("lets the last block of a name win", () => {
    expect(
      surfaceVerifyJwt(
        "[functions.a]\nverify_jwt = false\n\n[functions.a]\nverify_jwt = true\n",
      ).get("a"),
    ).toBe(true);
  });

  it("ends a block at the next line that opens a section, of any kind", () => {
    expect(surfaceVerifyJwt("[functions.a]\n\n[edge_runtime]\nverify_jwt = false\n").get("a")).toBe(
      true,
    );
  });
});

describe("what it refuses", () => {
  const withOverrides = (over: Partial<Parameters<typeof reconcileApiSurface>[0]>) =>
    reconcileApiSurface({
      primeSurfaceJson: PRIME_SURFACE,
      primeRegistryJson: PRIME_REGISTRY,
      primeToml: PRIME_TOML,
      mergedRegistryJson: PRIME_REGISTRY,
      mergedToml: PRIME_TOML,
      ...over,
    });

  it("refuses when it cannot reproduce the prime's own file from the prime's own inputs", () => {
    // The transcription answers for itself on every pass. A prime whose own
    // surface is stale, or a generator that changed shape, stops here rather
    // than being written into a clone as a plausible file.
    const stale = PRIME_SURFACE.replace('"verify_jwt": false', '"verify_jwt": true');
    expect(stale).not.toBe(PRIME_SURFACE);
    const v = withOverrides({ primeSurfaceJson: stale });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("does not reproduce the prime's committed mobile surface");
  });

  it("refuses a prime whose registry has moved on without its surface", () => {
    const moved = serialiseSecurityRegistry({
      ...JSON.parse(PRIME_REGISTRY),
      functions: { ...JSON.parse(PRIME_REGISTRY).functions, "new-fn": entry("webhook") },
    });
    const v = withOverrides({ primeRegistryJson: moved });
    expect(v.ok).toBe(false);
  });

  it("refuses a class the prime's surface never maps, rather than guessing its scope", () => {
    const registry = serialiseSecurityRegistry({
      functions: { ...JSON.parse(PRIME_REGISTRY).functions, "crm-hook": entry("webhook-secret") },
    });
    const v = withOverrides({ mergedRegistryJson: registry });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("crm-hook (webhook-secret)");
    expect(v.reason).toContain("never maps");
  });

  it("refuses a name whose order would depend on somebody's locale", () => {
    const registry = serialiseSecurityRegistry({
      functions: { ...JSON.parse(PRIME_REGISTRY).functions, Crm_Send: entry("webhook") },
    });
    const v = withOverrides({ mergedRegistryJson: registry });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("Crm_Send");
  });

  it("refuses a prime surface that maps one class to two scopes", () => {
    const surface = JSON.parse(PRIME_SURFACE);
    surface.functions[0] = { ...surface.functions[0], mobileScope: "portal" };
    const v = withOverrides({ primeSurfaceJson: `${JSON.stringify(surface, null, 2)}\n` });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("maps the class human-authenticated to both");
  });

  it("refuses what is not the generator's document, and says whose", () => {
    const notJson = withOverrides({ primeSurfaceJson: "{" });
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toContain("not valid JSON");

    const wrongShape = withOverrides({ primeSurfaceJson: '{"functions": []}' });
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.reason).toContain("not the shape its generator emits");

    const noFunctions = withOverrides({ mergedRegistryJson: '{"$comment": "x"}' });
    expect(noFunctions.ok).toBe(false);
    if (!noFunctions.ok) expect(noFunctions.reason).toContain("the reconciled's security registry");

    const nullRegistry = withOverrides({ mergedRegistryJson: "null" });
    expect(nullRegistry.ok).toBe(false);
  });
});

describe("how the engine uses it", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
  const at = engine.indexOf("reconcileApiSurface({");
  /** The pump, from its gate to the next section's opening. */
  const pump = () => {
    const from = engine.lastIndexOf("let apiSurfaceNote: string | null = null;", at);
    const to = engine.indexOf("\n  }\n", at);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(at);
    return engine.slice(from, to);
  };

  it("runs after the registry and config pumps, and before the carry reads what they decided", () => {
    expect(at).toBeGreaterThan(engine.indexOf("reconcileSecurityRegistry({"));
    expect(at).toBeGreaterThan(engine.indexOf("reconcileConfigToml({"));
    expect(engine.indexOf("const changedOnClone = () =>")).toBeGreaterThan(at);
  });

  it("composes from the documents this pass lands, never from either side's file", () => {
    const block = pump();
    expect(block).toMatch(/mergedRegistryJson,\s*mergedToml,/);
  });

  it("acts only where the two function sets differ and prime's copy is being delivered", () => {
    const block = pump();
    expect(block).toContain('mode !== "notify"');
    expect(block).toContain("(withheldFunctions.length > 0 || cloneOwnedFunctions.length > 0)");
    expect(block).toMatch(
      /treeEntries\.some\(\(t\) => t\.path === API_SURFACE_PATH && t\.sha !== null\)/,
    );
  });

  it("drops prime's copy either way, and holds a refusal for a person", () => {
    const block = pump();
    const drop = block.indexOf("dropFromTree(API_SURFACE_PATH)");
    const refused = block.indexOf("if (!verdict.ok) {", drop);
    expect(drop).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(drop);
    expect(block).toContain('reason: "manual_reconcile" as const');
    expect(block).toContain("needsReconcile.push(held)");
  });

  it("records a decided path, so the carry does not re-deliver prime's raw copy", () => {
    const block = pump();
    expect(block).toContain("reconciledPaths.add(API_SURFACE_PATH)");
    expect(block).toContain("if (dryRun) rehearsedWrites.add(API_SURFACE_PATH)");
  });

  it("never fails the pass", () => {
    const block = pump();
    expect(block.indexOf("try {")).toBeLessThan(block.indexOf("getFileContent("));
    expect(block).toContain("} catch (e) {");
  });

  it("names the path in one place", () => {
    expect(API_SURFACE_PATH).toBe("mobile/api-surface.json");
    expect(engine).not.toContain('"mobile/api-surface.json"');
  });
});
