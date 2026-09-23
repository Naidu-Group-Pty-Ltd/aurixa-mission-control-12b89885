/**
 * The dependency facts reach `partitionByDependency`, on every path.
 *
 * Structural — it reads the server sources — because the defect it catches
 * cannot be seen from a unit test or from the types.
 *
 * `partitionByDependency` narrows its barrier only where BOTH sides' facts are
 * present: `requires` on the candidate, `creates` on the hole. Absent, it falls
 * back to the blanket rule, which is correct as a default and catastrophic as
 * the everyday case — the first hole orphans every runnable behind it, and on
 * the CRM clone the first hole is at corpus ordinal 1, so it sent nothing from
 * the day it was provisioned. Measured 22 Sep 2026 over that clone's real
 * ledger: blanket sends 0 of 35, per-dependency sends 34.
 *
 * `openScopedPrimeCorpus` returns two arrays over the same sequence. Only
 * `metas` carries the facts; `corpus.metas` is the raw listing. They are
 * interchangeable to the compiler — `CorpusMeta`'s fact fields are optional,
 * which is what lets an unread body mean "nobody asked" — so passing the raw
 * one typechecks, lints, builds, and silently restores the blanket barrier.
 *
 * That is why this is a source scan rather than a list of the three call sites
 * that exist today: a hand-list cannot see the call it does not mention, and
 * the next caller is the one this is for.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

/** Comments removed — a comment quoting code is not code. */
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), "src/server", p), "utf8"));

/**
 * Every file that names the partition or hands a replay a scope. Derived from
 * the tree rather than typed, so a new module cannot join the fleet unseen.
 */
const SOURCES = [
  "fleet-migration.server.ts",
  "self-healing.server.ts",
  "migration-sync.functions.ts",
  "backend-provisioning.server.ts",
] as const;

describe("nothing hands the raw corpus listing to the barrier", () => {
  it("no production call passes `corpus.metas` to partitionByDependency", () => {
    for (const f of SOURCES) {
      const src = read(f);
      const calls = [...src.matchAll(/partitionByDependency\(\s*([A-Za-z_$][\w$.]*)\s*,/g)];
      for (const c of calls) {
        expect(
          c[1],
          `${f} partitions on \`${c[1]}\`, which carries no dependency facts`,
        ).not.toBe("corpus.metas");
      }
    }
  });

  it("no production call hands `corpus.metas` to a replay as the scope", () => {
    for (const f of SOURCES) {
      const src = read(f);
      const scopes = [
        ...src.matchAll(/\{\s*corpus:\s*([A-Za-z_$][\w$.]*)\s*,\s*runnableIds/g),
      ];
      for (const c of scopes) {
        expect(
          c[1],
          `${f} scopes the replay on \`${c[1]}\`, which carries no dependency facts`,
        ).not.toBe("corpus.metas");
      }
    }
  });

  it("the scan is not vacuous — it found the calls it judges", () => {
    // A regex that matches nothing passes every assertion above, which is the
    // trap this suite's siblings were caught by.
    const all = SOURCES.map(read).join("\n");
    expect([...all.matchAll(/partitionByDependency\(\s*[A-Za-z_$][\w$.]*\s*,/g)].length)
      .toBeGreaterThanOrEqual(2);
    expect([...all.matchAll(/\{\s*corpus:\s*[A-Za-z_$][\w$.]*\s*,\s*runnableIds/g)].length)
      .toBeGreaterThanOrEqual(3);
  });
});

describe("the facts are read, and read for the whole corpus", () => {
  const scoping = read("fleet-migration.server.ts");

  it("`openScopedPrimeCorpus` asks for every corpus path, not only the unmatched ones", () => {
    // A candidate's `requires` lives in a file the VERSION test already
    // cleared. Reading only what the version test did not clear leaves every
    // candidate factless and the barrier blanket — the read has to be wider
    // than the digest set even though only the digest set is attached.
    expect(scoping).toMatch(/digestPrimeBodies\(\s*corpus,\s*corpus\.metas\.map\(/);
  });

  it("it returns the enriched array under its own name", () => {
    expect(scoping).toMatch(/const metas = corpus\.metas\.map\(/);
    expect(scoping).toMatch(/return \{\s*ok: true,\s*corpus,\s*metas,/);
  });

  it("the versions a body names travel beside its facts, from the same pass", () => {
    // `partitionByDependency` narrows a candidate only where its `requires`
    // AND its `mentions` were read, because a candidate whose names nobody
    // read might name anything the barrier holds. Facts attached without the
    // names therefore put every candidate back on the blanket barrier —
    // fail-closed, and exactly as total a stall as reading nothing. See
    // `migrationVersionMentions.pure.ts`.
    expect(scoping).toMatch(/mentions = pass\.mentionsByPath;/);
    expect(scoping).toMatch(/const named = mentions\.get\(m\.path\);/);
    expect(scoping).toMatch(/\.\.\.\(named === undefined \? \{\} : \{ mentions: named \}\)/);
  });

  it("a digest is still attached only where a version did not already clear it", () => {
    // Widening the READ must not widen what is DIGESTED: a version-matched
    // file never reaches the digest branch of `scopeCorpusToPrime`, but it
    // does reach `claimants`, so attaching one would change an
    // operator-visible `sharedWith` on the strength of an unrelated widening.
    expect(scoping).toMatch(/const needBody = new Set\(/);
    expect(scoping).toMatch(/needBody\.has\(m\.path\) \? digested\.get\(m\.path\) : undefined/);
  });
});
