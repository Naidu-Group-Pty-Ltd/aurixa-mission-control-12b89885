/**
 * The strip two source contracts depend on.
 *
 * Both shapes below are taken verbatim from this codebase, and each broke a
 * previous version of it — producing FALSE findings, which is the failure
 * that gets a gate switched off rather than fixed.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

  it("is conservative about a trailing comment, which is the safe direction", () => {
    // A comment after code on the same line survives. Both callers would
    // rather read a stale reference than invent a finding: a missed orphan
    // costs a name a list does not carry, and a lane detected for a comment
    // is judged rather than skipped.
    const out = stripComments("const z = 3; // mentions getAppOctokit");
    expect(out).toContain("getAppOctokit");
  });

  it("loses no `export function` across the whole server tree", () => {
    // THE GUARD ON THE STRIP. Both failures above showed up as a scan quietly
    // seeing less code, so the cheapest thing that notices is counting
    // declarations either side. Measured 20 Sep 2026: 633, none lost.
    const decl = /^export\s+(?:async\s+)?function\s+[A-Za-z_]\w*/gm;
    let raw = 0;
    let stripped = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
        } else if (p.endsWith(".server.ts")) {
          const src = readFileSync(p, "utf8");
          raw += [...src.matchAll(decl)].length;
          stripped += [...stripComments(src).matchAll(decl)].length;
        }
      }
    };
    walk("src");
    expect(raw).toBeGreaterThan(400);
    expect(stripped, "the strip is eating real declarations").toBe(raw);
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
