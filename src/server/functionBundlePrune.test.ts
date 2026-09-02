/**
 * Pruning a bundle to what it imports — and, far more importantly, refusing to
 * prune whenever the import graph cannot be read in full.
 */
import { describe, expect, it } from "vitest";
import {
  pruneBundleToReachable,
  readSpecifiers,
  resolveRelative,
} from "./functionBundlePrune.pure";

const bundle = (sources: Record<string, string | null>, entry = "fn/index.ts") =>
  pruneBundleToReachable({
    entrypointPath: entry,
    files: Object.keys(sources).map((path) => ({ path })),
    importMapPath: null,
    textOf: (p) => sources[p] ?? null,
  });

describe("resolveRelative", () => {
  it("resolves a sibling and a parent hop", () => {
    expect(resolveRelative("fn/index.ts", "./util.ts")).toBe("fn/util.ts");
    expect(resolveRelative("fn/index.ts", "../_shared/a.ts")).toBe("_shared/a.ts");
    expect(resolveRelative("a/b/c.ts", "../../_shared/x/y.ts")).toBe("_shared/x/y.ts");
  });

  it("is null for anything not relative", () => {
    expect(resolveRelative("fn/index.ts", "npm:zod")).toBeNull();
    expect(resolveRelative("fn/index.ts", "@/lib/x")).toBeNull();
  });
});

describe("readSpecifiers", () => {
  it("finds import, export-from and bare imports", () => {
    const r = readSpecifiers(
      `import a from "./a.ts";\nexport { b } from "./b.ts";\nimport "./c.ts";`,
    );
    expect([...r.specifiers].sort()).toEqual(["./a.ts", "./b.ts", "./c.ts"]);
    expect(r.opaque).toBe(false);
  });

  it("follows a dynamic import with a literal argument", () => {
    const r = readSpecifiers(`const m = await import("./lazy.ts");`);
    expect(r.specifiers).toContain("./lazy.ts");
    expect(r.opaque).toBe(false);
  });

  it("reports a computed dynamic import as opaque", () => {
    // This platform uses `await import(...)` constantly; a computed one means
    // the graph cannot be walked, and pruning on a partial graph loses files.
    expect(readSpecifiers("const m = await import(path);").opaque).toBe(true);
    expect(readSpecifiers("await import(`./${name}.ts`);").opaque).toBe(true);
  });

  it('does not read `from "…"` inside an ordinary string as an import', () => {
    /*
      The anchoring rule. A loose /from\s*["']…["']/ over the whole source
      picks specifiers out of SQL and prose — measured against the prime it
      invented things like `", "` and `"${heading}"`, and 21 of 425 bundles
      fell back to carrying the whole 6.42 MB tree because of it.
    */
    const r = readSpecifiers(
      [
        `const note = 'loaded from "./ghost.ts" at boot';`,
        'const sql = `select * from "users"`;',
        `import a from "./real.ts";`,
      ].join("\n"),
    );
    expect(r.specifiers).toEqual(["./real.ts"]);
  });

  it("ignores a specifier that only appears in a comment", () => {
    const r = readSpecifiers(`// import x from "./ghost.ts"\nimport a from "./a.ts";`);
    expect(r.specifiers).toEqual(["./a.ts"]);
  });
});

describe("pruning keeps exactly what is reached", () => {
  it("drops shared files nothing imports", () => {
    const out = bundle({
      "fn/index.ts": `import { used } from "../_shared/used.ts";`,
      "_shared/used.ts": "export const used = 1;",
      "_shared/unused.ts": "export const unused = 1;",
      "_shared/also-unused.ts": "export const x = 1;",
    });
    expect(out.pruned).toBe(true);
    expect(out.keep).toEqual(["fn/index.ts", "_shared/used.ts"]);
  });

  it("follows the graph transitively", () => {
    const out = bundle({
      "fn/index.ts": `import "../_shared/a.ts";`,
      "_shared/a.ts": `import "./b.ts";`,
      "_shared/b.ts": `import "./c.ts";`,
      "_shared/c.ts": "export const c = 1;",
      "_shared/orphan.ts": "export const o = 1;",
    });
    expect(out.keep).not.toContain("_shared/orphan.ts");
    expect(out.keep).toContain("_shared/c.ts");
  });

  it("survives an import cycle", () => {
    const out = bundle({
      "fn/index.ts": `import "../_shared/a.ts";`,
      "_shared/a.ts": `import "./b.ts";`,
      "_shared/b.ts": `import "./a.ts";`,
    });
    expect(out.pruned).toBe(true);
    expect(out.keep).toHaveLength(3);
  });

  it("ignores external specifiers rather than failing on them", () => {
    const out = bundle({
      "fn/index.ts": `import { z } from "npm:zod";\nimport "https://deno.land/x/a.ts";\nimport "node:path";`,
    });
    expect(out.pruned).toBe(true);
    expect(out.keep).toEqual(["fn/index.ts"]);
  });

  it("keeps a reached non-text file without walking it", () => {
    const out = bundle({
      "fn/index.ts": `import data from "./data.json";`,
      "fn/data.json": null,
    });
    expect(out.keep).toContain("fn/data.json");
  });

  it("preserves the bundle's original file order", () => {
    const out = bundle({
      "_shared/a.ts": "export const a = 1;",
      "fn/index.ts": `import "../_shared/a.ts";`,
    });
    expect(out.keep).toEqual(["_shared/a.ts", "fn/index.ts"]);
  });
});

describe("it refuses to prune whenever the graph is incomplete", () => {
  it("carries everything when a dynamic import is computed", () => {
    /*
      The rule that matters. A bundle that deploys too large fails loudly at
      the API; one missing a transitively-imported file fails at RUNTIME on the
      tenant's clone, which is worse and much harder to attribute.
    */
    const out = bundle({
      "fn/index.ts": `const m = await import(somePath);`,
      "_shared/unused.ts": "export const u = 1;",
    });
    expect(out.pruned).toBe(false);
    expect(out.keep).toHaveLength(2);
    expect(out.reason).toMatch(/computed specifier/);
  });

  it("carries everything when a relative import is missing from the bundle", () => {
    const out = bundle({
      "fn/index.ts": `import "../_shared/absent.ts";`,
      "_shared/present.ts": "export const p = 1;",
    });
    expect(out.pruned).toBe(false);
    expect(out.reason).toMatch(/does not hold/);
  });

  it("carries everything for a bare specifier WHEN an import map could alias it", () => {
    const out = pruneBundleToReachable({
      entrypointPath: "fn/index.ts",
      files: [{ path: "fn/index.ts" }, { path: "import_map.json" }, { path: "_shared/util.ts" }],
      importMapPath: "import_map.json",
      textOf: (p) => (p === "fn/index.ts" ? `import "shared/util.ts";` : null),
    });
    expect(out.pruned).toBe(false);
    expect(out.reason).toMatch(/cannot resolve/);
  });

  it("ignores an unresolvable bare specifier when there is NO import map", () => {
    /*
      Deno rejects a bare specifier no map resolves, so a working function
      cannot contain one — it is a scanner artefact, not a dependency.
      Measured against the prime, five bundles fell back on invented
      specifiers like `", "` picked out of ordinary strings.
    */
    const out = bundle({
      "fn/index.ts": `export const s = ["a", "b"].join(", ");`,
      "_shared/unused.ts": "export const u = 1;",
    });
    expect(out.pruned).toBe(true);
    expect(out.keep).toEqual(["fn/index.ts"]);
  });

  it("carries everything when the entrypoint is not in the bundle", () => {
    const out = pruneBundleToReachable({
      entrypointPath: "fn/missing.ts",
      files: [{ path: "fn/index.ts" }],
      importMapPath: null,
      textOf: () => "",
    });
    expect(out.pruned).toBe(false);
    expect(out.keep).toEqual(["fn/index.ts"]);
  });

  it("a deep file's computed import still stops the whole prune", () => {
    // Incompleteness anywhere in the graph is incompleteness of the graph.
    const out = bundle({
      "fn/index.ts": `import "../_shared/a.ts";`,
      "_shared/a.ts": `await import(name);`,
      "_shared/unused.ts": "export const u = 1;",
    });
    expect(out.pruned).toBe(false);
    expect(out.keep).toHaveLength(3);
  });
});

describe("the import map travels whatever the graph says", () => {
  it("is kept even though nothing imports it", () => {
    // The runtime reads it, not the module graph.
    const out = pruneBundleToReachable({
      entrypointPath: "fn/index.ts",
      files: [{ path: "fn/index.ts" }, { path: "import_map.json" }, { path: "_shared/u.ts" }],
      importMapPath: "import_map.json",
      textOf: (p) => (p === "fn/index.ts" ? "" : null),
    });
    expect(out.keep).toContain("import_map.json");
    expect(out.keep).not.toContain("_shared/u.ts");
  });
});
