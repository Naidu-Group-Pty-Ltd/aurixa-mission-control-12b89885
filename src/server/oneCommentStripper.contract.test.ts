/**
 * There is one way to remove prose from TypeScript here, and one for SQL.
 *
 * Forty-three modules used to carry a private `replace(/\/\*[\s\S]*?\*\//g, "")`.
 * That expression does not know what a string is, so anything that merely
 * SPELLS an opener starts a comment running to the next closer anywhere below.
 * Measured 20 Sep 2026, before this gate existed:
 *
 * - **16 false openers in 15 files** — up from the twelve in eleven recorded in
 *   August, so the population was growing.
 * - **1,056 lines of real code** destroyed across 66 files, the commonest
 *   opener being not a comment at all but a glob in a string (`"scripts/**"`).
 * - **10 of the 40** TypeScript strippers read a file it damaged: 123 lines out
 *   of `cascade-engine.server.ts` starting at `partitionCascadePaths(…)`, read
 *   by two contract tests, and 20 out of `backend-provisioning.server.ts`,
 *   read by seven.
 *
 * None of those tests failed. A scan that reads less code answers the same
 * shape of question with a confident wrong number, which is the failure that
 * gets a gate switched off rather than fixed — so the fix is worth nothing
 * without something that stops the expression coming back.
 *
 * ## What is forbidden, precisely
 *
 * A regex literal that spells BOTH `\/\*` and `\*\/` — an opener and a closer
 * — is a block-comment matcher, and that is the dangerous shape. A regex that
 * spells only the opener is a LINE filter (`/^\s*(\/\/|\/\*|\*)/`), which
 * cannot run past the line it tests and so cannot eat code; three modules use
 * one and are deliberately untouched.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The three modules that may still spell it, and why each must.
 *
 * Kept to exactly three: an exemption is a hole, and a hole nobody can name
 * the reason for is how the list grows back to forty-three.
 */
const MAY_SPELL_IT: Record<string, string> = {
  "src/server/sourceComments.pure.ts": "its header quotes the expression it replaces",
  "src/server/sourceComments.pure.test.ts":
    "the witness — a proof that something is wrong must be able to say what the wrong thing is",
  "src/server/sqlComments.pure.ts": "SQL's rule, which is a different rule and says so",
};

/** A regex literal spelling an opener AND a closer: a block-comment matcher. */
function spellsABlockCommentRegex(line: string): boolean {
  return line.includes("\\/\\*") && line.includes("\\*\\/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const FILES = walk("src");

/**
 * This gate quotes the expression it forbids, in its header and in the
 * fixtures that prove its predicate works, so it detects itself. The
 * exclusion is asserted rather than trusted below — an exclusion nothing
 * checks is how a gate comes to cover the thing it was written to catch.
 */
const THIS_FILE = "src/server/oneCommentStripper.contract.test.ts";

/**
 * Every offending line, given a corpus and a way to read it.
 *
 * Parameterised so the SKIP is testable, not only the predicate. A gate whose
 * exclusion list can be widened without any test noticing is a gate that can
 * be switched off in one line.
 */
function offendersIn(files: string[], read: (f: string) => string): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f === THIS_FILE || f in MAY_SPELL_IT) continue;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (spellsABlockCommentRegex(line)) out.push(`${f}:${i + 1}`);
      });
  }
  return out;
}

describe("one comment stripper", () => {
  it("nothing outside the three named modules matches a block comment by regex", () => {
    expect(
      offendersIn(FILES, (f) => readFileSync(f, "utf8")),
      "use `stripComments` from sourceComments.pure, or `stripSqlComments` from sqlComments.pure",
    ).toEqual([]);
  });

  it("catches it in a TEST file, which is where thirty-seven of forty lived", () => {
    // Non-vacuity for the SKIP, not just the predicate. Widening the
    // self-exclusion to `.test.ts` left the gate green on the real tree —
    // there was nothing to catch — while disarming it for the whole
    // population it was written for. The skip is exercised against a
    // synthetic corpus so that change fails here.
    const planted = String.raw`const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");`;
    expect(offendersIn(["src/server/invented.contract.test.ts"], () => planted)).toEqual([
      "src/server/invented.contract.test.ts:1",
    ]);
    expect(offendersIn(["src/server/invented.server.ts"], () => planted)).toEqual([
      "src/server/invented.server.ts:1",
    ]);
    // And the two kinds of allowance still hold on that same corpus.
    expect(offendersIn([THIS_FILE], () => planted)).toEqual([]);
    expect(offendersIn(["src/server/sqlComments.pure.ts"], () => planted)).toEqual([]);
  });

  it("the exemption list is minimal — every entry still needs its exemption", () => {
    // A stale exemption is a hole left open for a reason that has gone.
    for (const [f, why] of Object.entries(MAY_SPELL_IT)) {
      expect(existsSync(f), `${f} no longer exists — drop the exemption`).toBe(true);
      const hit = readFileSync(f, "utf8").split("\n").some(spellsABlockCommentRegex);
      expect(hit, `${f} no longer spells it (${why}) — drop the exemption`).toBe(true);
    }
  });

  it("excludes only itself, and only because it would really be caught", () => {
    expect(existsSync(THIS_FILE)).toBe(true);
    const caught = readFileSync(THIS_FILE, "utf8").split("\n").some(spellsABlockCommentRegex);
    expect(caught, "the self-exclusion covers nothing — remove it").toBe(true);
    expect(THIS_FILE in MAY_SPELL_IT, "it is an exclusion, not an exemption").toBe(false);
  });

  it("the predicate is not vacuous", () => {
    // Planted rather than argued: the shape that caused every defect above,
    // and the shape that is safe and must stay allowed.
    expect(spellsABlockCommentRegex(String.raw`s.replace(/\/\*[\s\S]*?\*\//g, "")`)).toBe(true);
    expect(spellsABlockCommentRegex(String.raw`s.replace(/\/\*.*?\*\//gs, " ")`)).toBe(true);
    expect(
      spellsABlockCommentRegex(String.raw`lines.filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))`),
    ).toBe(false);
    expect(spellsABlockCommentRegex(`const x = 1;`)).toBe(false);
  });

  it("only one module declares the TypeScript strip", () => {
    const declarers = FILES.filter((f) =>
      /^\s*export\s+function\s+stripComments\b/m.test(readFileSync(f, "utf8")),
    );
    expect(declarers).toEqual(["src/server/sourceComments.pure.ts"]);
  });

  it("the shared strippers are reached, so a silent revert shows up here", () => {
    // Measured 20 Sep 2026: 42 modules import the TypeScript strip and 4 the
    // SQL one. A floor rather than an equality — adding a caller is the point.
    const importers = (spec: string) =>
      FILES.filter((f) => new RegExp(`from "[^"]*${spec}"`).test(readFileSync(f, "utf8"))).length;
    expect(importers("sourceComments\\.pure")).toBeGreaterThanOrEqual(35);
    expect(importers("sqlComments\\.pure")).toBeGreaterThanOrEqual(4);
  });
});
