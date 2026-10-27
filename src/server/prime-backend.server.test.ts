import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";
import {
  migrationIdFromFilename,
  groupFunctionPaths,
  importMapFor,
  planFunctionBundles,
  pickEntrypoint,
  parseFunctionConfig,
  extractSecretNames,
  isExcludedFunctionFile,
  isTextFile,
} from "./prime-backend.server";
import { selectProjectKeys } from "./backend-provisioning.server";

describe("migrationIdFromFilename", () => {
  it("extracts the leading timestamp", () => {
    expect(migrationIdFromFilename("20260419215311_091021d2.sql")).toBe("20260419215311");
    expect(migrationIdFromFilename("20260710150000_prime_backend_replication.sql")).toBe(
      "20260710150000",
    );
  });

  it("accepts bare timestamp filenames", () => {
    expect(migrationIdFromFilename("20260419215311.sql")).toBe("20260419215311");
  });

  it("rejects non-migration filenames", () => {
    expect(migrationIdFromFilename("README.md")).toBeNull();
    expect(migrationIdFromFilename("seed.sql")).toBeNull();
    expect(migrationIdFromFilename("_helpers.sql")).toBeNull();
  });
});

describe("groupFunctionPaths", () => {
  it("groups files by function slug and separates _shared", () => {
    const { slugs, sharedFiles, importMapPath } = groupFunctionPaths([
      "push-fanout/index.ts",
      "push-fanout/lib/vapid.ts",
      "billing-webhook/index.ts",
      "_shared/cors.ts",
      "import_map.json",
    ]);
    expect(Array.from(slugs.keys()).sort()).toEqual(["billing-webhook", "push-fanout"]);
    expect(slugs.get("push-fanout")).toEqual(["push-fanout/index.ts", "push-fanout/lib/vapid.ts"]);
    expect(sharedFiles.sort()).toEqual(["_shared/cors.ts", "import_map.json"]);
    expect(importMapPath).toBe("import_map.json");
  });

  it("drops env files and other excluded artifacts", () => {
    const { slugs, sharedFiles } = groupFunctionPaths([
      "fn/index.ts",
      "fn/.env",
      "fn/.env.local",
      "_shared/.DS_Store",
      ".env",
    ]);
    expect(slugs.get("fn")).toEqual(["fn/index.ts"]);
    expect(sharedFiles).toEqual([]);
  });

  it("ignores stray root files that are not import maps", () => {
    const { slugs, sharedFiles } = groupFunctionPaths(["README.md", "deno.json", "fn/index.ts"]);
    expect(sharedFiles).toEqual(["deno.json"]);
    expect(Array.from(slugs.keys())).toEqual(["fn"]);
  });
});

describe("a function deploys with its own import map, as the CLI deploys it", () => {
  // The prime's CI deploys `mcp` and `builder-stock-marketplace` with their own
  // `deno.json` as `import_map_path`. Every clone took the root map alone, so
  // NPC Test's `mcp` was live from `index.ts` alone (27 Oct 2026).
  const grouped = groupFunctionPaths([
    "mcp/index.ts",
    "mcp/deno.json",
    "typed/index.ts",
    "typed/deno.jsonc",
    "both/index.ts",
    "both/deno.jsonc",
    "both/deno.json",
    "plain/index.ts",
    "plain/lib/deno.json",
    "_shared/cors.ts",
    "import_map.json",
  ]);

  it("is the function's own deno.json, preferred over deno.jsonc, else the tree's root map", () => {
    expect(importMapFor("mcp", grouped)).toBe("mcp/deno.json");
    expect(importMapFor("typed", grouped)).toBe("typed/deno.jsonc");
    expect(importMapFor("both", grouped)).toBe("both/deno.json");
    // Only the file beside the entrypoint is the function's config.
    expect(importMapFor("plain", grouped)).toBe("import_map.json");
    expect(importMapFor("mcp", groupFunctionPaths(["mcp/index.ts"]))).toBeNull();
  });

  it("is what a planned bundle carries, and the file travels in it", () => {
    const sha = (n: number) => String(n).padStart(40, "0");
    const files = ["mcp/index.ts", "mcp/deno.json", "plain/index.ts", "_shared/cors.ts"].map(
      (rel, i) => ({ rel, sha: sha(i) }),
    );
    const plans = planFunctionBundles(
      {
        sourceRepo: "o/prime",
        sourceRef: "main",
        sourceSha: sha(9),
        files,
        configToml: null,
        declaredFunctionSlugs: ["mcp", "plain"],
      },
      ["mcp", "plain"],
    );
    const mcp = plans.find((p) => p.slug === "mcp")!;
    expect(mcp.importMapPath).toBe("mcp/deno.json");
    expect(mcp.files.map((f) => f.rel)).toContain("mcp/deno.json");
    expect(plans.find((p) => p.slug === "plain")!.importMapPath).toBeNull();
  });

  it("is chosen the same way where the prime's snapshot assembles every bundle", () => {
    const code = stripComments(readFileSync("src/server/prime-backend.server.ts", "utf8"));
    // Both planners ask one rule, and nothing hands every bundle the root map.
    expect(code.match(/importMapPath: importMapFor\(slug, grouped\)/g)).toHaveLength(2);
    expect(code).not.toContain("importMapPath: grouped.importMapPath");
    expect(code).not.toContain("const { slugs, sharedFiles, importMapPath } = groupFunctionPaths(");
  });
});

describe("pickEntrypoint", () => {
  it("prefers index.ts", () => {
    expect(pickEntrypoint("fn", ["fn/util.ts", "fn/index.ts", "_shared/cors.ts"])).toBe(
      "fn/index.ts",
    );
  });

  it("falls back to a top-level source file in the function dir", () => {
    expect(pickEntrypoint("fn", ["fn/handler.ts", "_shared/cors.ts"])).toBe("fn/handler.ts");
  });

  it("never picks nested or shared files as entrypoint fallback", () => {
    expect(pickEntrypoint("fn", ["fn/lib/deep.ts", "_shared/cors.ts"])).toBeNull();
  });
});

describe("parseFunctionConfig", () => {
  it("reads per-function verify_jwt flags", () => {
    const toml = `
project_id = "abc"

[functions.public-hook]
verify_jwt = false

[functions.secure-fn]
verify_jwt = true
`;
    const cfg = parseFunctionConfig(toml);
    expect(cfg.get("public-hook")?.verifyJwt).toBe(false);
    expect(cfg.get("secure-fn")?.verifyJwt).toBe(true);
  });

  it("handles quoted slugs and missing config", () => {
    const cfg = parseFunctionConfig(`[functions."my-fn"]\nverify_jwt = false\n`);
    expect(cfg.get("my-fn")?.verifyJwt).toBe(false);
    expect(parseFunctionConfig(null).size).toBe(0);
  });

  it("defaults verify_jwt to true when a section omits it", () => {
    const cfg = parseFunctionConfig(`[functions.fn]\nimport_map = "./import_map.json"\n`);
    expect(cfg.get("fn")?.verifyJwt).toBe(true);
  });

  it("reads the flag after an array value, which once cut the section short", () => {
    // The body used to end at the first `[`, so this read as true and the
    // function deployed checking a JWT its callers never send.
    const cfg = parseFunctionConfig(
      `[functions.hook]\nstatic_files = ["./functions/hook/*.html"]\nverify_jwt = false\n` +
        `[functions.multi]\nstatic_files = [\n  "./a.html",\n  "./b.html",\n]\nverify_jwt = false # public\n`,
    );
    expect(cfg.get("hook")?.verifyJwt).toBe(false);
    expect(cfg.get("multi")?.verifyJwt).toBe(false);
  });

  it("reads no section out of a comment, and no flag out of a sub-table", () => {
    const cfg = parseFunctionConfig(
      `# An omitted \`[functions.X]\` block asserts the gateway checks a JWT.\n` +
        `# [functions.retired]\n# verify_jwt = false\n` +
        `[functions.fn]\nverify_jwt = true\n` +
        `[functions.fn.env]\nverify_jwt = false\n` +
        `[[functions.fn.hooks]]\nverify_jwt = false\n`,
    );
    expect([...cfg.keys()]).toEqual(["fn"]);
    expect(cfg.get("fn")?.verifyJwt).toBe(true);
  });

  it("reads a flag written as a dotted key in the functions table", () => {
    const cfg = parseFunctionConfig(
      `[functions]\nhook.verify_jwt = false\n"q-fn".verify_jwt = false\n`,
    );
    expect(cfg.get("hook")?.verifyJwt).toBe(false);
    expect(cfg.get("q-fn")?.verifyJwt).toBe(false);
  });
});

describe("extractSecretNames", () => {
  it("finds Deno.env.get references across quote styles", () => {
    const names = extractSecretNames([
      `const a = Deno.env.get("STRIPE_SECRET_KEY");`,
      `const b = Deno.env.get('RESEND_API_KEY') ?? "";`,
      "const c = Deno.env.get(`VAPID_PRIVATE_KEY`);",
    ]);
    expect(names).toEqual(["RESEND_API_KEY", "STRIPE_SECRET_KEY", "VAPID_PRIVATE_KEY"]);
  });

  it("excludes platform-injected SUPABASE_* names", () => {
    const names = extractSecretNames([
      `Deno.env.get("SUPABASE_URL"); Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
       Deno.env.get("SUPABASE_CUSTOM"); Deno.env.get("MY_SECRET");`,
    ]);
    // SUPABASE_ prefix is reserved by the secrets API — none of them survive
    expect(names).toEqual(["MY_SECRET"]);
  });

  it("dedupes and sorts", () => {
    const names = extractSecretNames([
      `Deno.env.get("B_KEY"); Deno.env.get("A_KEY"); Deno.env.get("B_KEY");`,
    ]);
    expect(names).toEqual(["A_KEY", "B_KEY"]);
  });
});

describe("file classification", () => {
  it("excludes env and OS artifacts anywhere in the tree", () => {
    expect(isExcludedFunctionFile("fn/.env")).toBe(true);
    expect(isExcludedFunctionFile("fn/.env.production")).toBe(true);
    expect(isExcludedFunctionFile("fn/sub/.DS_Store")).toBe(true);
    expect(isExcludedFunctionFile("fn/envelope.ts")).toBe(false);
  });

  it("detects text files for secret scanning", () => {
    expect(isTextFile("fn/index.ts")).toBe(true);
    expect(isTextFile("fn/deno.json")).toBe(true);
    expect(isTextFile("fn/logo.png")).toBe(false);
  });
});

describe("selectProjectKeys", () => {
  it("prefers legacy anon/service_role names", () => {
    const keys = selectProjectKeys([
      { name: "anon", api_key: "anon-key" },
      { name: "service_role", api_key: "sr-key" },
    ]);
    // `gatewayKey` is the form the runtime injects: the sb_secret_ key where the
    // project has one, the legacy JWT only when it does not — here, the JWT.
    expect(keys).toEqual({ anonKey: "anon-key", serviceRoleKey: "sr-key", gatewayKey: "sr-key" });
  });

  it("falls back to publishable/secret key types", () => {
    const keys = selectProjectKeys([
      { name: "default", api_key: "sb_publishable_abc" },
      { name: "default", api_key: "sb_secret_def" },
    ] as never);
    expect(keys).toEqual({
      anonKey: "sb_publishable_abc",
      serviceRoleKey: "sb_secret_def",
      gatewayKey: "sb_secret_def",
    });
  });

  it("returns nulls when nothing matches", () => {
    expect(selectProjectKeys([])).toEqual({
      anonKey: null,
      serviceRoleKey: null,
      gatewayKey: null,
    });
  });
});
