import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeStaleHeldReferences,
  exportedNamesOf,
  findStaleHeldReferences,
  namedImportsOf,
  resolveSpecifier,
} from "./heldFileStaleness.pure";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "src/server/cascade/__fixtures__", name), "utf8");

describe("the outage this exists for, from the real files", () => {
  // Verbatim: the import block from npc-client-dashboard's App.tsx at 69b2c2a
  // (the merge that broke production) and npc-property-dashbord's
  // AmlShellPages.tsx as the cascade delivered it.
  const heldApp = fixture("App.held.txt");
  const cascadedShell = fixture("AmlShellPages.after.txt");

  it("names AmlIntakeQueue, the symbol that failed the build", () => {
    const refs = findStaleHeldReferences({
      heldFiles: { "src/App.tsx": heldApp },
      cascadedFiles: { "src/pages/aml/AmlShellPages.tsx": cascadedShell },
    });
    expect(refs).toEqual([
      {
        heldPath: "src/App.tsx",
        cascadedPath: "src/pages/aml/AmlShellPages.tsx",
        missing: ["AmlIntakeQueue"],
      },
    ]);
  });

  it("does NOT flag the twelve symbols that are still exported", () => {
    // A check that fires on the whole import list is a check nobody keeps.
    const refs = findStaleHeldReferences({
      heldFiles: { "src/App.tsx": heldApp },
      cascadedFiles: { "src/pages/aml/AmlShellPages.tsx": cascadedShell },
    });
    expect(refs[0].missing).toHaveLength(1);
    for (const kept of ["AmlVerification", "AmlScreening", "AmlConfiguration"]) {
      expect(refs[0].missing).not.toContain(kept);
    }
  });

  it("is silent once the held file is repaired", () => {
    const repaired = heldApp.replace("AmlIntakeQueue, ", "");
    expect(
      findStaleHeldReferences({
        heldFiles: { "src/App.tsx": repaired },
        cascadedFiles: { "src/pages/aml/AmlShellPages.tsx": cascadedShell },
      }),
    ).toEqual([]);
  });

  it("says which two files disagree and about what", () => {
    const refs = findStaleHeldReferences({
      heldFiles: { "src/App.tsx": heldApp },
      cascadedFiles: { "src/pages/aml/AmlShellPages.tsx": cascadedShell },
    });
    const [line] = describeStaleHeldReferences(refs);
    expect(line).toContain("src/App.tsx");
    expect(line).toContain("AmlIntakeQueue");
    expect(line).toContain("src/pages/aml/AmlShellPages.tsx");
  });
});

describe("namedImportsOf", () => {
  it("reads a multi-line named import", () => {
    expect(namedImportsOf('import {\n  A,\n  B,\n} from "./m";')).toEqual([
      { specifier: "./m", names: ["A", "B"] },
    ]);
  });

  it("takes the SOURCE name of an aliased import, not the local one", () => {
    expect(namedImportsOf('import { A as Z } from "./m";')[0].names).toEqual(["A"]);
  });

  it("reads named imports that sit beside a default binding", () => {
    expect(namedImportsOf('import D, { A } from "./m";')[0].names).toEqual(["A"]);
  });

  it("reads a type-only import — a missing type still fails the typecheck", () => {
    expect(namedImportsOf('import type { T } from "./m";')[0].names).toEqual(["T"]);
  });

  it("ignores a default import — it cannot break this way", () => {
    expect(namedImportsOf('import D from "./m";')).toEqual([]);
  });

  it("ignores a namespace import — the symbol is resolved at use, not here", () => {
    expect(namedImportsOf('import * as NS from "./m";')).toEqual([]);
  });

  it("ignores an import inside a comment", () => {
    expect(namedImportsOf('// import { A } from "./m";')).toEqual([]);
    expect(namedImportsOf('/*\nimport { A } from "./m";\n*/')).toEqual([]);
  });
});

describe("exportedNamesOf", () => {
  it("reads a re-export with a default alias", () => {
    const e = exportedNamesOf('export { default as X } from "./X";');
    expect(e.names.has("X")).toBe(true);
    expect(e.exhaustive).toBe(true);
  });

  it("reads declaration exports of every kind", () => {
    const src = [
      "export const a = 1;",
      "export let b = 2;",
      "export function c() {}",
      "export async function d() {}",
      "export class E {}",
      "export type F = string;",
      "export interface G {}",
      "export enum H {}",
    ].join("\n");
    const e = exportedNamesOf(src);
    for (const n of ["a", "b", "c", "d", "E", "F", "G", "H"]) {
      expect(e.names.has(n)).toBe(true);
    }
  });

  it("takes the exported name from `X as Y`, not the local one", () => {
    const e = exportedNamesOf("export { internalName as publicName };");
    expect(e.names.has("publicName")).toBe(true);
    expect(e.names.has("internalName")).toBe(false);
  });

  it("marks a module carrying `export *` as not enumerable", () => {
    expect(exportedNamesOf('export * from "./other";').exhaustive).toBe(false);
  });
});

describe("resolveSpecifier", () => {
  it("resolves a relative specifier against the importing file", () => {
    expect(resolveSpecifier("src/App.tsx", "./pages/aml/AmlShellPages")).toContain(
      "src/pages/aml/AmlShellPages.tsx",
    );
  });

  it("resolves the @/ alias to src/", () => {
    expect(resolveSpecifier("src/App.tsx", "@/components/aml/AmlLayout")).toContain(
      "src/components/aml/AmlLayout.tsx",
    );
  });

  it("walks .. segments", () => {
    expect(resolveSpecifier("src/pages/aml/X.tsx", "../../lib/y")).toContain("src/lib/y.ts");
  });

  it("resolves a bare package specifier to nothing — node_modules is not cascaded", () => {
    expect(resolveSpecifier("src/App.tsx", "react")).toEqual([]);
  });
});

describe("what it refuses to claim", () => {
  // A false positive holds a cascade that was fine, so each of these is a
  // deliberate silence rather than an oversight.

  it("says nothing about a file this cascade is not delivering", () => {
    // The held file's other imports are somebody else's problem; this run
    // cannot have broken a file it did not touch.
    expect(
      findStaleHeldReferences({
        heldFiles: { "src/App.tsx": 'import { Gone } from "./elsewhere";' },
        cascadedFiles: { "src/pages/other.tsx": "export const Kept = 1;" },
      }),
    ).toEqual([]);
  });

  it("says nothing when the target re-exports a wildcard", () => {
    expect(
      findStaleHeldReferences({
        heldFiles: { "src/App.tsx": 'import { Maybe } from "./m";' },
        cascadedFiles: { "src/m.ts": 'export * from "./deeper";' },
      }),
    ).toEqual([]);
  });

  it("reports each missing symbol once, however many imports name it", () => {
    expect(
      findStaleHeldReferences({
        heldFiles: {
          "src/App.tsx": 'import { A } from "./m";\nimport type { A } from "./m";',
        },
        cascadedFiles: { "src/m.ts": "export const B = 1;" },
      }),
    ).toEqual([{ heldPath: "src/App.tsx", cascadedPath: "src/m.ts", missing: ["A"] }]);
  });

  it("finds a breakage through an index file", () => {
    expect(
      findStaleHeldReferences({
        heldFiles: { "src/App.tsx": 'import { Gone } from "./feature";' },
        cascadedFiles: { "src/feature/index.ts": "export const Kept = 1;" },
      }),
    ).toEqual([
      { heldPath: "src/App.tsx", cascadedPath: "src/feature/index.ts", missing: ["Gone"] },
    ]);
  });

  it("reports nothing when there are no held files at all", () => {
    expect(findStaleHeldReferences({ heldFiles: {}, cascadedFiles: { "src/m.ts": "" } })).toEqual(
      [],
    );
  });
});

describe("the engine actually runs this check", () => {
  // A detector nothing calls is the same as no detector, and this whole class
  // of defect is "the machinery existed and never ran".
  const src = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

  it("calls it with the delivered source and the clone's held files", () => {
    expect(src).toContain("findStaleHeldReferences({ heldFiles, cascadedFiles: deliveredSource })");
  });

  it("reads the HELD file from the clone, never from prime", () => {
    // Prime's copy is the one that agrees with the cascade by construction, so
    // checking it would find nothing, always.
    const block = src.slice(src.indexOf("let staleHeld"), src.indexOf("const staleSuffix"));
    expect(block).toContain("getFileContent(octokit, cloneRef, path)");
    expect(block).not.toContain("primeRef");
  });

  it("puts the breakage in the summary and at the TOP of the pull request body", () => {
    expect(src).toContain("${staleSuffix}");
    const bodyStart = src.indexOf("const cascadeBody =");
    const staleAt = src.indexOf("This cascade breaks a held file", bodyStart);
    const reconcileAt = src.indexOf("Needs a human", bodyStart);
    expect(staleAt).toBeGreaterThan(-1);
    // Above the ordinary held-path note: this one is a broken build, not the
    // routine divergence that section describes.
    expect(staleAt).toBeLessThan(reconcileAt);
  });

  it("only keeps delivered content for TypeScript sources", () => {
    // A cascade of images and lockfiles must not carry their bytes around.
    expect(src).toMatch(
      /content:\s*\/\\\.\[cm\]\?tsx\?\$\/\.test\(path\)\s*\?\s*primeFile\.content\s*:\s*null/,
    );
  });
});
