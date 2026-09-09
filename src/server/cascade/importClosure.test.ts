import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  closeOverImports,
  importsOf,
  resolveSpecifier,
  stripComments,
  type TreeIndex,
} from "@/server/cascade/importClosure.pure";

/** A tree where each path's blob is its own name, so equality is legible. */
const tree = (...paths: string[]): TreeIndex => new Map(paths.map((p) => [p, `sha:${p}`]));

/** A clone tree where the named paths are STALE (present, different blob). */
const staleIn = (base: TreeIndex, ...stale: string[]): TreeIndex => {
  const m = new Map(base);
  for (const p of stale) m.set(p, "sha:OLD");
  return m;
};

const sources = (map: Record<string, string>) => (p: string) => map[p];

describe("importsOf — both specifier forms, or it is not a closure", () => {
  it("follows the @/ alias", () => {
    expect(importsOf(`import { a } from '@/lib/a';`)).toEqual(["@/lib/a"]);
  });

  it("follows relative specifiers", () => {
    /*
      The hand-written repair that preceded this module followed `@/` only. The
      build then got eight times further and failed on
      `Could not resolve "./platformBrand"`. A file reached by `./` leaves the
      payload exactly as easily as one reached by `@/`.
    */
    expect(importsOf(`import x from './platformBrand';`)).toEqual(["./platformBrand"]);
    expect(importsOf(`export * from '../shared/y';`)).toEqual(["../shared/y"]);
  });

  it("follows dynamic imports and require", () => {
    expect(importsOf(`const m = await import('@/lib/lazy');`)).toContain("@/lib/lazy");
    expect(importsOf(`const m = require('./cjs');`)).toContain("./cjs");
  });

  it("ignores bare package specifiers", () => {
    // Only the two relative forms can name a file in this repository.
    expect(importsOf(`import React from 'react';`)).toEqual([]);
  });

  it("does not follow a path named in a comment", () => {
    /*
      Every guard in this repository that skipped comment-stripping went on to
      report a contradiction about correct code.
    */
    expect(importsOf(`// see @/lib/notImported\nimport a from '@/lib/real';`)).toEqual([
      "@/lib/real",
    ]);
    expect(stripComments(`/* @/lib/x */ y`)).not.toContain("@/lib/x");
  });

  it("deduplicates", () => {
    expect(importsOf(`import a from '@/x';\nimport b from '@/x';`)).toEqual(["@/x"]);
  });
});

describe("resolveSpecifier", () => {
  const prime = tree("src/lib/a.ts", "src/lib/b.tsx", "src/lib/c/index.ts", "src/data/d.json");

  it("maps @/ onto src/ and tries extensions in order", () => {
    expect(resolveSpecifier("@/lib/a", "src/pages/P.tsx", prime)).toBe("src/lib/a.ts");
    expect(resolveSpecifier("@/lib/b", "src/pages/P.tsx", prime)).toBe("src/lib/b.tsx");
  });

  it("resolves a directory to its index", () => {
    expect(resolveSpecifier("@/lib/c", "src/pages/P.tsx", prime)).toBe("src/lib/c/index.ts");
  });

  it("resolves .json, because a data module that does not travel breaks the build too", () => {
    expect(resolveSpecifier("@/data/d", "src/pages/P.tsx", prime)).toBe("src/data/d.json");
  });

  it("resolves relative specifiers against the importer's directory", () => {
    expect(resolveSpecifier("./a", "src/lib/other.ts", prime)).toBe("src/lib/a.ts");
    expect(resolveSpecifier("../lib/a", "src/pages/P.tsx", prime)).toBe("src/lib/a.ts");
  });

  it("returns null for something prime does not have", () => {
    expect(resolveSpecifier("@/lib/nope", "src/pages/P.tsx", prime)).toBeNull();
  });
});

describe("closeOverImports", () => {
  it("adds a module the payload imports and the clone lacks", () => {
    /*
      The exact shape of the outage: Calendar.tsx travelled, the module it
      imports did not, and the deployment failed on the first unresolved
      import while the proposal itself was correct.
    */
    const prime = tree("src/pages/Calendar.tsx", "src/lib/calendar/bookingNotifications.pure.ts");
    const clone = tree("src/pages/Calendar.tsx");
    const r = closeOverImports({
      seed: ["src/pages/Calendar.tsx"],
      prime,
      clone,
      readPrime: sources({
        "src/pages/Calendar.tsx": `import { plan } from '@/lib/calendar/bookingNotifications.pure';`,
      }),
    });
    expect(r.added).toEqual(["src/lib/calendar/bookingNotifications.pure.ts"]);
    expect(r.truncated).toBe(false);
  });

  it("adds a file the clone HAS at the wrong version", () => {
    /*
      After the missing files were added the build failed on
      `"MAX_COMPARISON_PEERS" is not exported by comparisonCandidates.pure.ts`.
      The clone held that file, seeded and never updated because it sits
      outside every glob. Presence is not the question; the blob is.
    */
    const prime = tree("src/pages/P.tsx", "src/lib/peers.ts");
    const clone = staleIn(tree("src/pages/P.tsx", "src/lib/peers.ts"), "src/lib/peers.ts");
    const r = closeOverImports({
      seed: ["src/pages/P.tsx"],
      prime,
      clone,
      readPrime: sources({ "src/pages/P.tsx": `import { MAX } from '@/lib/peers';` }),
    });
    expect(r.added).toEqual(["src/lib/peers.ts"]);
  });

  it("does not add a file the clone already holds at prime's version", () => {
    const prime = tree("src/pages/P.tsx", "src/lib/same.ts");
    const r = closeOverImports({
      seed: ["src/pages/P.tsx"],
      prime,
      clone: tree("src/pages/P.tsx", "src/lib/same.ts"),
      readPrime: sources({ "src/pages/P.tsx": `import x from '@/lib/same';` }),
    });
    expect(r.added).toEqual([]);
  });

  it("is transitive", () => {
    const prime = tree("src/a.ts", "src/b.ts", "src/c.ts");
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime,
      clone: tree("src/a.ts"),
      readPrime: sources({
        "src/a.ts": `import b from './b';`,
        "src/b.ts": `import c from './c';`,
        "src/c.ts": `export default 1;`,
      }),
    });
    expect(r.added).toEqual(["src/b.ts", "src/c.ts"]);
    expect(r.rounds).toBeGreaterThanOrEqual(2);
  });

  it("terminates on a cycle", () => {
    const prime = tree("src/a.ts", "src/b.ts");
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime,
      clone: tree(),
      readPrime: sources({
        "src/a.ts": `import b from './b';`,
        "src/b.ts": `import a from './a';`,
      }),
    });
    expect(r.added).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("never adds a path prime does not have", () => {
    const prime = tree("src/a.ts");
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime,
      clone: tree(),
      readPrime: sources({ "src/a.ts": `import g from '@/lib/ghost';` }),
    });
    // The seed is already in the payload, so it is never "added"; only the
    // unresolvable specifier is reported.
    expect(r.added).toEqual([]);
    expect(r.unresolved).toEqual(["@/lib/ghost"]);
  });

  it("carries an unreadable file without walking it, rather than losing the whole closure", () => {
    const prime = tree("src/a.ts", "src/b.ts", "src/c.ts");
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime,
      clone: tree(),
      // b is added but its own imports are unknown; c is still found via a.
      readPrime: sources({ "src/a.ts": `import b from './b'; import c from './c';` }),
    });
    expect(r.added).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("stops at maxAdded and SAYS so rather than returning a whole repository", () => {
    /*
      A runaway closure turning a twenty-file proposal into the entire tree is
      the one way this could do harm. Truncation is reported, not thrown: a
      partial closure is still strictly better than none.
    */
    const paths = Array.from({ length: 50 }, (_, i) => `src/m${i}.ts`);
    const prime = tree("src/a.ts", ...paths);
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime,
      clone: tree(),
      readPrime: sources({
        "src/a.ts": paths.map((p) => `import x from '@/${p.slice(4, -3)}';`).join("\n"),
      }),
      maxAdded: 10,
    });
    expect(r.truncated).toBe(true);
    expect(r.added).toHaveLength(10);
  });

  it("only ever widens what is SENT — it yields paths, never deletions", () => {
    /*
      The same rule the repository invariants carry. A closure says "the clone
      needs prime's copy of this"; it says nothing about removing anything, and
      the deletion question stays on `installedGlobs` alone.
    */
    const r = closeOverImports({
      seed: ["src/a.ts"],
      prime: tree("src/a.ts"),
      clone: tree("src/a.ts", "src/cloneOnly.ts"),
      readPrime: sources({ "src/a.ts": `export default 1;` }),
    });
    expect(r.added).toEqual([]);
    expect(Object.keys(r)).not.toContain("removed");
  });
});

describe("the engine wires it, and wires it in the one position that is safe", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf-8");

  it("calls closeOverImports at all — a closure with no caller closes nothing", () => {
    expect(engine).toMatch(/closeOverImports\(/);
    expect(engine).toMatch(/@\/server\/cascade\/importClosure\.pure/);
  });

  it("runs BEFORE partitionCascadePaths, so exclusions filter what it proposes", () => {
    /*
      The whole safety argument. A hand repair of this same defect on 9 Sep
      compared blobs against prime without consulting the exclusions and
      overwrote `src/App.tsx` — a protected path pinning that deployment's
      client-facing mode.

      Feeding the closure's additions through the same partition every other
      candidate goes through makes that impossible: the closure may PROPOSE a
      protected path and the guard rail still removes it. Reverse these two and
      the engine can write a file the cascade exists to hold back.
    */
    const closure = engine.indexOf("closeOverImports(");
    const partition = engine.indexOf("partitionCascadePaths(candidatePaths, exclusions)");
    expect(closure).toBeGreaterThan(-1);
    expect(partition).toBeGreaterThan(-1);
    expect(closure).toBeLessThan(partition);
  });

  it("feeds its additions into candidatePaths rather than writing them itself", () => {
    // One write path. The closure widens the LIST; it never touches a tree.
    expect(engine).toMatch(
      /candidatePaths\s*=\s*\[\s*\.\.\.candidatePaths,\s*\.\.\.closureAdded\s*\]/,
    );
    expect(engine).not.toMatch(/closureAdded[\s\S]{0,200}createBlob/);
  });

  it("only runs when both trees were listed completely", () => {
    /*
      A truncated tree cannot say a file is absent — it may simply not have
      been listed — and a closure built on that would "add" files the clone
      already holds, or miss ones it does not. The same reason the deletion
      pass is skipped on a truncated read.
    */
    const at = engine.indexOf("closeOverImports(");
    const guard = engine.lastIndexOf("primeShaByPath !== null && cloneShaByPath !== null", at);
    expect(guard).toBeGreaterThan(-1);
  });
});
