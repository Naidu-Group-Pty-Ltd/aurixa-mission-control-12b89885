/**
 * A PROTECTED FILE IS DERIVED WHERE IT CAN BE, AND NAMED WHERE PRIME CHANGED IT.
 *
 * 30 Oct 2026: prime changed `.gitleaks.toml` with the script whose planted key
 * it allows. The script crossed, the allowance was a protected exclusion and
 * did not, `security` went red on five clones' proposals, and none of them
 * said why. Two rules came of it, both the owner's decision:
 * `gitleaksReconcile.pure.ts` writes the file the way `config.toml` is
 * written, and `protectedChanges.pure.ts` names every protected file prime
 * changed in the range a proposal delivers. Both rules live in the modules;
 * what keeps them is the wiring in `processClone`, so it is asserted as
 * source, like `carryGate.contract.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";
import { GITLEAKS_CONFIG_PATH } from "./gitleaksReconcile.pure";
import { PUMPED_PATHS } from "./pumpedPaths.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

function between(from: string, to: string): string {
  const a = engine.indexOf(from);
  const b = engine.indexOf(to, a);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return engine.slice(a, b);
}

describe("the secret scan's config is derived, not copied", () => {
  const block = () => between("reconcileGitleaksToml({", 'markPhase("survivors")');

  it("keeps the exclusion row, so the write path never carries prime's copy", () => {
    expect(DEFAULT_MIRROR_EXCLUSIONS).toContainEqual(
      expect.objectContaining({ pattern: GITLEAKS_CONFIG_PATH, reason: "protected" }),
    );
    expect(PUMPED_PATHS.has(GITLEAKS_CONFIG_PATH)).toBe(true);
  });

  it("reads whose deployment each side is from its own config.toml, as the config reconcile read it", () => {
    expect(engine).toContain(
      "if (primeCfg && !primeCfg.binary) sourceConfigText = primeCfg.content;",
    );
    expect(engine).toContain(
      "if (cloneCfg && !cloneCfg.binary) cloneConfigText = cloneCfg.content;",
    );
    expect(engine.indexOf("sourceConfigText = primeCfg.content")).toBeLessThan(
      engine.indexOf("reconcileGitleaksToml({"),
    );
    expect(block()).toContain(
      "ownRef: cloneConfigText === null ? null : projectIdOf(cloneConfigText)",
    );
    expect(block()).toContain("registeredRef: ownProjectRef");
  });

  it("takes a parent's own key out only where the bytes come from the parent", () => {
    expect(block()).toMatch(
      /source:\s*args\.provenance === undefined\s*\?\s*\{ kind: "prime" \}\s*:\s*\{\s*kind: "deployment",\s*ownRef: sourceConfigText === null \? null : projectIdOf\(sourceConfigText\),\s*\}/,
    );
  });

  it("holds a refusal for a person, and writes a derivation the way a pump does", () => {
    const b = block();
    expect(b).toMatch(/reason: "manual_reconcile" as const,[\s\S]*needsReconcile\.push\(held\);/);
    expect(b).toContain("reconcileWrites.add(GITLEAKS_CONFIG_PATH);");
    expect(b).toContain("if (dryRun) rehearsedWrites.add(GITLEAKS_CONFIG_PATH);");
    expect(b).toContain("deliveredSource[GITLEAKS_CONFIG_PATH] = verdict.merged;");
  });

  it("says what it did in the proposal", () => {
    expect(engine).toMatch(
      /\(gitleaksReconcileNote\s*\?\s*`\\n\\n### The secret scan's config was derived, not copied/,
    );
  });
});

describe("a protected file prime changed is named, not counted", () => {
  const block = () => between("const ownCopies = protectedOwnCopies(", "const cascadeBody =");

  it("asks once every hold is known: after the last path is named for a person", () => {
    expect(engine.indexOf("const ownCopies = protectedOwnCopies(")).toBeGreaterThan(
      engine.lastIndexOf("needsReconcile.push("),
    );
    expect(block()).toMatch(
      /protectedOwnCopies\(\s*partition\.held,\s*reconciledPaths,\s*new Set\(needsReconcile\.map\(\(h\) => h\.path\)\),\s*\)/,
    );
  });

  it("asks PRIME's history, for the range this proposal delivers", () => {
    const b = block();
    expect(b).toMatch(
      /const primeRepo =\s*args\.provenance === undefined \? primeRef : \(args\.provenance\.primeRepo \?\? null\);/,
    );
    expect(b).toContain("basehead: `${lastSynced}...${deliveredSha}`");
    expect(b).toContain("const lastSynced = clone.last_synced_sha ?? null;");
  });

  it("never reads a question it could not ask as an answer", () => {
    const b = block();
    expect(b).toContain("truncated: listed.length >= COMPARE_FILE_CEILING");
    expect(b).toMatch(/\} catch \(e\) \{\s*protectedChanges = notAsked\(/);
    expect(b).toMatch(/\} catch \{\s*unknown\.push\(h\);\s*\}/);
  });

  it("lets a lineage child ask it, by carrying the prime's repository on its provenance", () => {
    expect(engine).toContain(
      "provenance = { label: sourceDecision.label, deliveredSha: sourceSha, primeRepo: primeRef };",
    );
    expect(engine).toContain(
      "provenance: { label: decision.label, deliveredSha: primeSha, primeRepo },",
    );
  });

  it("has its own section, and what it names is not counted as withheld without comment", () => {
    expect(engine).toContain("### Prime changed files this clone keeps as its own");
    expect(engine).toMatch(
      /const withheldUncommented =\s*partition\.held\.length - needsReconcile\.length - keptStaying\.length - protectedNamed;/,
    );
  });
});
