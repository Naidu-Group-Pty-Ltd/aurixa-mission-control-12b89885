import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  REPOSITORY_INVARIANTS,
  globsForModuleScopedClone,
  repositoryInvariantGlobs,
} from "./repositoryInvariants.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";
import { validateModuleGlobs, globToRegex } from "@/lib/module-globs";

describe("the repository invariants", () => {
  it("every entry says which check reads it", () => {
    // A policy list nobody can read is a policy list nobody maintains. The
    // reason is what lets the next person decide whether an entry still
    // belongs, and it has to name the mechanism rather than assert the need.
    for (const inv of REPOSITORY_INVARIANTS) {
      expect(inv.reason.length, `${inv.pattern} has no reason`).toBeGreaterThan(60);
    }
  });

  it("every pattern survives the glob validator that the cascade will run it through", () => {
    // `listFilesMatchingGlobs` silently DROPS an unsafe glob with a console
    // warning. An invariant rejected there would look exactly like one that
    // matched nothing — which is the defect this list exists to close,
    // reintroduced one layer down.
    const { valid, invalid } = validateModuleGlobs(repositoryInvariantGlobs());
    expect(
      invalid,
      `rejected: ${invalid.map((i) => `${i.glob} (${i.reason})`).join(", ")}`,
    ).toEqual([]);
    expect(valid.length).toBe(REPOSITORY_INVARIANTS.length);
  });

  it("carries the three paths whose absence was measured red on a module-scoped clone", () => {
    // 8 Sep 2026, npc-test-76b3b3 PR #11, run 34232106283. Named as PATHS
    // matched by the patterns, not as patterns, so rewriting a glob keeps the
    // guarantee as long as the file is still covered.
    const matchers = validateModuleGlobs(repositoryInvariantGlobs()).valid.map(globToRegex);
    const covered = (path: string) => matchers.some((m) => m.test(path));

    // `verify`: integrationSecrets.ts is generated from this and drifted.
    expect(covered("src/lib/integrations/registry.ts")).toBe(true);
    // `supply-chain`: four fast-uri advisories against a lockfile frozen on
    // the clone's creation day.
    expect(covered("package-lock.json")).toBe(true);
    // `security`: the baseline CI regenerates and git-diffs.
    expect(covered("docs/security/SECURITY_INVENTORY.json")).toBe(true);
  });

  it("a generated artefact and its source are both covered, or neither is", () => {
    /*
      THE RULE THIS LIST IS FOR.

      `supabase/functions/_shared/integrationSecrets.ts` was byte-identical to
      prime's while `src/lib/integrations/registry.ts` — the file it is
      generated FROM — had never cascaded once. The check regenerates from the
      source and compares against the artefact, so a clone holding one from
      each revision fails for ever.

      Covering only the generated half would be worse than covering neither:
      it would keep overwriting a correct artefact with one the clone's own
      source cannot reproduce.
    */
    const matchers = validateModuleGlobs(repositoryInvariantGlobs()).valid.map(globToRegex);
    const covered = (path: string) => matchers.some((m) => m.test(path));
    const source = "src/lib/integrations/registry.ts";
    const generated = "supabase/functions/_shared/integrationSecrets.ts";
    // The source is covered here. The generated half rides with its module —
    // and that is fine BECAUSE the source now travels: the clone can
    // regenerate it. What must never happen is the reverse.
    expect(covered(source)).toBe(true);
    if (covered(generated)) {
      expect(covered(source), "the generated half travels without its source").toBe(true);
    }
  });

  it("never contradicts an exclusion", () => {
    // Exclusions are per-deployment IDENTITY — this repository's Supabase
    // project, this deployment's Turnstile allowlist, this clone's hosting
    // config. An invariant naming one of them exactly would be a policy
    // arguing with itself; the engine applies exclusions after this list, so
    // the exclusion would win silently and the entry would be a lie.
    const excluded = new Set(DEFAULT_MIRROR_EXCLUSIONS.map((e) => e.pattern));
    for (const inv of REPOSITORY_INVARIANTS) {
      expect(excluded.has(inv.pattern), `${inv.pattern} is also an exclusion`).toBe(false);
    }
  });

  it("the two fail-closed deploy workflows stay excluded even though workflows are invariant", () => {
    // `.github/workflows/**` is an invariant and those two files are inside
    // it. They carry a guard against deploying into the wrong Supabase
    // project, so the exclusion has to win — which it does, because the
    // engine applies exclusions to the candidate set after it is built.
    const matchers = validateModuleGlobs(repositoryInvariantGlobs()).valid.map(globToRegex);
    const covered = (p: string) => matchers.some((m) => m.test(p));
    const excluded = new Set(DEFAULT_MIRROR_EXCLUSIONS.map((e) => e.pattern));
    for (const guard of [
      ".github/workflows/deploy-supabase-functions.yml",
      ".github/workflows/apply-migration.yml",
    ]) {
      expect(covered(guard), "the workflow invariant should reach it").toBe(true);
      expect(excluded.has(guard), "and the exclusion must be there to win").toBe(true);
    }
  });

  it("widens an installed set without duplicating a glob a module already claims", () => {
    const widened = globsForModuleScopedClone(["src/lib/integrations/**", "src/components/aml/**"]);
    expect(widened.filter((g) => g === "src/lib/integrations/**")).toHaveLength(1);
    expect(widened).toContain("src/components/aml/**");
    expect(widened).toContain("package-lock.json");
  });

  it("adds nothing when the installed set is empty, because an empty set is refused upstream", () => {
    // `processClone` skips a module-scoped clone with no installed globs
    // before it ever asks for candidates. Widening an empty set here would
    // turn "nothing to cascade" into a whole-repository push.
    expect(globsForModuleScopedClone([])).toEqual(repositoryInvariantGlobs());
  });
});

describe("invariants widen what is SENT, never what is REMOVED", () => {
  const engine = () => readFileSync("src/server/cascade-engine.server.ts", "utf8");

  it("the deletion question is still asked against the installed globs alone", () => {
    /*
      A repository invariant says "the clone needs prime's copy of this". It
      says nothing about removing a file prime lacks — and `scripts/**` or
      `.github/workflows/**` inside the destructive half would put a clone's
      own tooling in scope for a pass that was only ever asked to add.

      Pinned as the RULE: the deletion matchers are built from
      `installedGlobs`, and `primeInScope` — the "prime still has this" guard —
      is narrowed back to the same set rather than taken from the widened
      candidate list.
    */
    const src = engine();
    expect(src).toMatch(/const \{ valid \} = validateModuleGlobs\(installedGlobs\);/);

    // From the module branch's own `primeInScope` forward to ITS deletion
    // push — the mirror branch has one of those too, earlier in the file.
    const after = src.slice(src.indexOf("const primeInScope"));
    const scoped = after.slice(0, after.indexOf("deletionCandidates.push"));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped).toContain("installedGlobs");
    expect(scoped).not.toMatch(/primeInScope\s*=\s*new Set\(candidatePaths\)/);
  });

  it("a mirror never has invariants added, because its candidates are already the whole tree", () => {
    const src = engine();
    const mirrorBranch = src.slice(
      src.indexOf("if (isMirror) {"),
      src.indexOf('scopeLabel = "mirror"'),
    );
    expect(mirrorBranch).not.toContain("globsForModuleScopedClone");
  });
});
