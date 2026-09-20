/**
 * The strip two source contracts depend on.
 *
 * Both shapes below are taken verbatim from this codebase, and each broke a
 * previous version of it — producing FALSE findings, which is the failure
 * that gets a gate switched off rather than fixed.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { stripComments, stripCommentsAndStrings } from "./sourceComments.pure";

describe("stripComments", () => {
  it("removes prose and keeps the code around it", () => {
    const out = stripComments(
      ["/*", " * See buildPrimeLedgerReconciliation for why.", " */", "const x = 1;"].join("\n"),
    );
    expect(out).not.toContain("buildPrimeLedgerReconciliation");
    expect(out).toContain("const x = 1;");
  });

  it("removes a whole-line // comment", () => {
    const out = stripComments(
      ["// calls getAppOctokit two modules away", "const y = 2;"].join("\n"),
    );
    expect(out).not.toContain("getAppOctokit");
    expect(out).toContain("const y = 2;");
  });

  it("a `/*` inside a template literal opens nothing", () => {
    // `backend-provisioning.server.ts:1473`. A file-wide regex opened a
    // comment here and ran to the next closer, swallowing the declaration of
    // `applyAuthConfig` and the call site of `buildAuthConfigPatch` — which
    // then reported as an orphan.
    const out = stripComments(
      [
        "function a() {",
        "  redirectSet.add(`${site}/*`);",
        "}",
        "export function stillDeclared(): void {}",
        "const used = stillDeclared;",
      ].join("\n"),
    );
    expect(out).toContain("export function stillDeclared");
    expect(out).toContain("const used = stillDeclared;");
  });

  it("a comment that closes mid-line keeps what follows it", () => {
    // `/* @vite-ignore */ "path"` — the dynamic-import idiom used ~30 times
    // here. A tracker asking whether the line ENDS with the closer opened a
    // block and swallowed the rest of the module, reporting `retargetCloneRepo`
    // as uncalled while a line below calls it.
    const out = stripComments(
      [
        "const { retargetCloneRepo } = await import(",
        '  /* @vite-ignore */ "@/lib/_server-shims/clone-repo-retarget.server"',
        ");",
        "await retargetCloneRepo(a, b);",
      ].join("\n"),
    );
    expect(out).not.toContain("@vite-ignore");
    expect(out).toContain("await retargetCloneRepo(a, b);");
  });

  it("a MULTI-LINE block that closes with code after it keeps that code", () => {
    /*
      The symmetric case, and the one the fixtures missed: the opener branch
      and the closer branch each have to look for `*&#47;` anywhere on the
      line rather than only at its end. Found by planting the `endsWith`
      version back into the closer alone — every other test still passed,
      because they all close on the SAME line they open.
    */
    const out = stripComments(
      ["/*", " * calls getAppOctokit", " */ export function kept(): void {}"].join("\n"),
    );
    expect(out).not.toContain("getAppOctokit");
    expect(out).toContain("export function kept()");
  });

  it("removes a trailing comment, on a line where that is unambiguous", () => {
    const out = stripComments("const z = 3; // mentions getAppOctokit");
    expect(out).not.toContain("getAppOctokit");
    expect(out).toContain("const z = 3;");
  });

  it("removes a single-line block between code, so an import reads as one", () => {
    // `/* @vite-ignore */` sits inside the call it annotates. A tracker that
    // asked whether the line ENDED with the closer opened a block here and
    // swallowed the rest of the module.
    const out = stripComments('const { f } = await import(/* @vite-ignore */ "@/lib/x");');
    expect(out).not.toContain("@vite-ignore");
    expect(out).toContain('await import(');
    expect(out).toContain('"@/lib/x"');
  });

  it("DECLINES on a line carrying a bare slash, rather than guessing", () => {
    // A regex literal and a division are not separable without a tokeniser,
    // and a tokeniser that gets it wrong eats code. So such a line is
    // returned whole — keeping prose, which is the cost this module chooses.
    for (const line of [
      'src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ""); // trailing prose',
      "const ratio = width / height; // trailing prose",
    ]) {
      const out = stripComments(line);
      expect(out, `a bare slash must not truncate: ${line}`).toBe(line);
    }
  });

  it("a `/*` inside a plain string opens nothing, because globs spell one", () => {
    // Measured across `src/`: the commonest opener is not a comment at all,
    // it is a glob in a string — `"scripts/**"`, `"supabase/.temp/**"`.
    const out = stripComments(
      ['const rules = [{ pattern: "scripts/**" }];', "export function stillHere(): void {}"].join(
        "\n",
      ),
    );
    expect(out).toContain("stillHere");
  });

  it("tracks `${…}`, because the expression inside one is CODE", () => {
    // A template's `${…}` holds real code, which can hold a real comment. A
    // scanner that treats the whole literal as opaque text keeps that prose —
    // and prose is what every caller of this module is trying not to read.
    //
    // An earlier fixture here nested backticks in a ternary and could not tell
    // the two implementations apart: backticks TOGGLE, so a stackless scan
    // lands on the same parity and agrees by luck.
    const out = stripComments("const v = `${a /* mentions getAppOctokit */ + b}`;");
    expect(out).not.toContain("getAppOctokit");
    expect(out).toContain("+ b}`;");
  });

  it("preserves line count, so a reported line still points at the source", () => {
    // `^`-anchored patterns and any line number a contract test reports are
    // only true while this holds.
    for (const f of [
      "src/server/cascade-engine.server.ts",
      "src/server/backend-provisioning.server.ts",
      "src/server/sourceComments.pure.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(stripComments(src).split("\n").length, f).toBe(src.split("\n").length);
    }
  });

  it("loses no declaration anywhere in `src/`", () => {
    // THE GUARD ON THE STRIP, and the reason this module exists. Every defect
    // it was written for showed up as a scan quietly seeing less code, so the
    // thing that notices is counting declarations either side — over the whole
    // tree rather than one suffix of it.
    //
    // The oracle is the TypeScript compiler on BOTH sides, not a regex. A
    // regex cannot tell a declaration from the word "function" in a sentence,
    // and the first version of this test reported four such sentences as lost
    // code. Parsing removes the guess: prose is not in the AST to begin with.
    const declarationsIn = (source: string, file: string) => {
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isVariableDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          found.push(`${ts.SyntaxKind[node.kind]} ${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    };

    let total = 0;
    const lost: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
          continue;
        }
        if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
        const src = readFileSync(p, "utf8");
        const before = declarationsIn(src, p);
        const after = new Set(declarationsIn(stripComments(src), p));
        total += before.length;
        for (const d of before) if (!after.has(d)) lost.push(`${p}: ${d}`);
      }
    };
    walk("src");
    // Measured 20 Sep 2026: 24,273 declarations across 1,098 files, none lost.
    expect(total).toBeGreaterThan(20_000);
    expect(lost, "the strip is eating real code").toEqual([]);
  });

  it("removes prose the naive block regex could not reach", () => {
    // Non-vacuity for the guard above: it only means something if the strip
    // is doing work the thing it replaces could not. Both files are read by
    // live contract tests, and both were being truncated.
    // The expression this module replaces, spelled out. This is the one
    // place in `src/` that may still write it — a proof that something is
    // wrong has to be able to say what the wrong thing is — and the ratchet
    // in `oneCommentStripper.contract.test.ts` exempts exactly this file.
    const naive = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [file, code] of [
      ["src/server/cascade-engine.server.ts", "const partition = partitionCascadePaths("],
      ["src/server/backend-provisioning.server.ts", "redirectSet.add(`${site}/auth/callback`)"],
    ] as const) {
      const src = readFileSync(file, "utf8");
      expect(naive(src), `${file} is no longer a witness — pick another`).not.toContain(code);
      expect(stripComments(src), `${file}`).toContain(code);
    }
  });
});

describe("stripCommentsAndStrings", () => {
  it("empties a quoted string, because a name in one is not a call", () => {
    // `expect(src).toContain("someFunction")` is bookkeeping about that
    // function, the same way an orphan gate's own freeze list is.
    const out = stripCommentsAndStrings('expect(src).toContain("someFunction");');
    expect(out).not.toContain("someFunction");
    expect(out).toContain("toContain");
  });

  it("leaves a template literal alone, because `${…}` holds real code", () => {
    const out = stripCommentsAndStrings("const u = `${formatThing(y)}/path`;");
    expect(out).toContain("formatThing(y)");
  });
});
