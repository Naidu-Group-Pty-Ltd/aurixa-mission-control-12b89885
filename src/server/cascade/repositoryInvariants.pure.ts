/**
 * Paths that belong to the REPOSITORY rather than to any module, and therefore
 * travel to every clone whatever its `sync_scope`.
 *
 * ## The rule
 *
 * **A clone runs the prime's CI, which judges the whole repository — so
 * anything that CI reads and no module owns must travel, or the clone is
 * judged against a tree it was never sent.**
 *
 * ## What went wrong
 *
 * A `mirror` clone diffs the two git TREES, so it receives every path whose
 * blob differs. A `modules` clone receives `listFilesMatchingGlobs(prime,
 * installedGlobs)` — the globs of what it installed, and nothing else. That is
 * correct for product code and wrong for everything the build and the checks
 * need, because a module's globs are drawn around a FEATURE and CI is drawn
 * around the REPOSITORY.
 *
 * Measured 8 Sep 2026 on `npc-test-76b3b3` (`sync_scope: modules`, 22
 * modules), PR #11, run 34232106283 — three checks red, all three for this one
 * reason, none of them caused by the cascade's own twenty files:
 *
 *  - `verify`: `integrationSecrets.ts is out of date (143 integrations, 246
 *    secrets in the registry)`. The GENERATED file
 *    `supabase/functions/_shared/integrationSecrets.ts` is byte-identical to
 *    prime's (blob `56f70afa…`) — it is inside an installed module's globs and
 *    cascaded on 8 Sep. Its SOURCE, `src/lib/integrations/registry.ts`, is
 *    outside every glob: 81,894 bytes against prime's 82,744, and its only
 *    commit in the clone's whole history is "Initial commit" on 1 September.
 *    The clone regenerates from its own stale source and correctly reports a
 *    mismatch — for ever, on every pull request, with nothing the cascade can
 *    ever send to fix it.
 *
 *  - `security`: the `docs/security/SECURITY_INVENTORY.json` baseline, which
 *    CI regenerates and `git diff --exit-code`s. Its INPUTS are the edge
 *    functions, many of which are inside module globs and did cascade; the
 *    baseline itself is in `docs/` and never does.
 *
 *  - `supply-chain`: four `fast-uri` advisories at `high`. Prime's
 *    `package-lock.json` pins `fast-uri 3.1.7` and prime's CI is green;
 *    `package-lock.json` is inside no module's globs, so the clone has never
 *    received a lockfile update since it was created.
 *
 * The same three checks are green on `npc-client-dashboard`, which is a
 * mirror. That is the whole difference.
 *
 * ## Why a list rather than a rule the code derives
 *
 * "Everything the prime's CI reads" is not something any program here can
 * compute — CI is a shell script calling other shell scripts. So the set is
 * enumerated, each entry carries the check that needs it, and a test asserts
 * every entry has a reason. That is the same shape as
 * `DEFAULT_MIRROR_EXCLUSIONS`, and for the same reason: a policy nobody can
 * read is a policy nobody maintains.
 *
 * ## Exclusions still win
 *
 * A per-deployment file is per-deployment however repository-shaped it looks.
 * `vite.config.ts`, `vercel.json`, `.gitignore`, `.gitleaks.toml`,
 * `.env.example` and the two fail-closed deploy workflows are all in
 * `DEFAULT_MIRROR_EXCLUSIONS` and stay there; this list is applied BEFORE
 * exclusions are, never instead of them.
 *
 * That is what lets an entry be a DIRECTORY rather than a list of paths.
 * `.github/workflows/**` is an invariant and five files below it are
 * exclusions; `docs/**` is an invariant and `docs/CLIENT_FACING_MODE.md` is an
 * exclusion, because it describes the clone and not prime. Widening the
 * invariant never widens what is written — it widens what is OFFERED, and the
 * exclusion still wins.
 *
 * ## Why a directory is safe here and would not be for source
 *
 * A document imports nothing and executes nothing, so offering a clone every
 * document offers it no code it did not install. A spec does import, which is
 * why `src/lib/openLocation/**` is named as one directory and there is no
 * entry for specs in general: a spec for a module the clone never installed
 * would arrive importing code the clone does not have, and turn `verify` red
 * for the opposite reason. The measurement that justified the one directory
 * named here is that all eleven of its files are already present on every
 * clone, so nothing new is imported by carrying it.
 */

export type RepositoryInvariant = {
  /** A glob, in the same syntax `module.file_globs` uses. */
  pattern: string;
  /** The check or build step that reads it, and why a module cannot own it. */
  reason: string;
};

export const REPOSITORY_INVARIANTS: readonly RepositoryInvariant[] = [
  // ── The dependency graph ──────────────────────────────────────────────────
  {
    pattern: "package.json",
    reason:
      "Every CI job begins `npm ci`, and every check is an npm script. A clone whose package.json " +
      "predates a script the prime's workflow calls fails that step with 'missing script'.",
  },
  {
    pattern: "package-lock.json",
    reason:
      "`npm ci` installs exactly this file, and the supply-chain gate audits exactly what it " +
      "installed. A clone frozen at its creation-day lockfile accumulates every advisory published " +
      "since — measured 8 Sep 2026: four `fast-uri` advisories at `high` failing a clone while " +
      "prime, pinned at 3.1.7, was green.",
  },

  // ── The checks themselves ─────────────────────────────────────────────────
  {
    pattern: "scripts/**",
    reason:
      "Every gate CI runs lives here, along with the baselines and allowlists they read. A clone " +
      "running the prime's workflow against its own older scripts is being judged by two different " +
      "standards at once.",
  },
  {
    pattern: ".github/workflows/**",
    reason:
      "The workflow file IS the definition of what the clone must pass, so a clone running a copy " +
      "the prime has since fixed is judged by a standard nobody maintains. Two rules narrow it " +
      "afterwards and both win: the fail-closed deploy workflows are per-deployment and stay in " +
      "DEFAULT_MIRROR_EXCLUSIONS, and a workflow that runs on `pull_request` or `push` is a " +
      "verdict on the whole tree, which a module-scoped clone does not hold — see " +
      "judgingWorkflow.pure.ts.",
  },

  // ── Toolchain configuration the build resolves against ────────────────────
  {
    pattern: "tsconfig*.json",
    reason: "`npx tsc --noEmit` in `verify` compiles against these paths and aliases.",
  },
  {
    pattern: "eslint.config.*",
    reason: "`npm run lint` is judged by this file; an older copy enforces an older standard.",
  },
  {
    pattern: "components.json",
    reason:
      "The shadcn path aliases every `src/` import resolves through. A clone whose copy predates " +
      "an alias the cascaded code imports fails `tsc --noEmit` on a module it was just sent.",
  },
  {
    pattern: "tailwind.config.ts",
    reason: "The token set `audit:style` checks against and the build compiles.",
  },
  {
    pattern: "postcss.config.js",
    reason:
      "The PostCSS pipeline `vite build` runs Tailwind through. It travels with tailwind.config.ts " +
      "because a plugin list and the config it loads are one setting in two files.",
  },

  // ── Generated artefacts and baselines CI diffs ────────────────────────────
  {
    pattern: "src/lib/integrations/**",
    reason:
      "The integrations registry generates `supabase/functions/_shared/integrationSecrets.ts`, and " +
      "`integrations:secrets:check` regenerates from the registry and compares. The generated half " +
      "is inside module globs and the source half is not, so the two arrive from different " +
      "revisions and the check is permanently red — the defect this whole list exists for. A " +
      "generated file and its source are one artefact and must travel together.",
  },
  {
    pattern: "supabase/functions-registry/**",
    reason:
      "The security registry the same checks read, on the same terms as SECURITY_INVENTORY.json.",
  },

  // ── What a check reads beside what the modules cascade ────────────────────
  {
    pattern: "docs/**",
    reason:
      "Three separate checks read a document out of docs/ and diff it against something the " +
      "modules cascade: `security:inventory` regenerates docs/security/SECURITY_INVENTORY.json " +
      "from the edge functions and CI `git diff --exit-code`s it; `sectionOwnershipMatrix.spec.ts` " +
      "runs its generator over the section registries and asserts the committed document did not " +
      "change; `scoringMethodology.spec.ts` asserts docs/reports/SCORING_V2_METHODOLOGY.md states " +
      "the version constants the engine exports. In every case the inputs are inside module globs " +
      "and cascade, and the document is in docs/ and did not — so the clone regenerates from " +
      "fresh inputs, compares against a stale document, and is red for ever. This is a directory " +
      "rather than three paths because enumerating it is what failed: the matrix was added on " +
      "20 Sep 2026 and the methodology was not, and on 21 Sep 2026 (npc-crm-independent PR #13, " +
      "run 35601703085) `verify` failed on exactly the document nobody had thought to name. " +
      "Measured the same day: of the 13 documents prime changed in its last 40 commits, 12 had " +
      "never reached that clone — 6 stale and 6 absent. A document imports nothing and executes " +
      "nothing, which is what makes the whole directory safe to carry where a whole source " +
      "directory would not be.",
  },
  {
    pattern: "src/lib/openLocation/**",
    reason:
      "`openLocationWiring.spec.ts` asserts that supabase/functions/location-intelligence-service/" +
      "index.ts calls measureCommuteThroughChain with named arguments. The edge function is " +
      "inside a module glob and cascades; the spec is not and does not, so prime renaming an " +
      "argument ships the new subject beside the old assertion — measured 21 Sep 2026, " +
      "npc-crm-independent run 35601703085, `expected … to contain 'measureCommuteThroughChain" +
      "(coordinates, cbdCoordinates, apiKey, db)'` against a function that now says `destination`. " +
      "A spec and its subject are one artefact, the same rule the integrations registry entry " +
      "above records for a generated file and its source. Scoped to this directory rather than to " +
      "specs in general because a spec for a module the clone did not install imports code it " +
      "does not have; all eleven files here are already present on every clone.",
  },
];

/** The globs, for a caller that only needs the patterns. */
export function repositoryInvariantGlobs(): string[] {
  return REPOSITORY_INVARIANTS.map((r) => r.pattern);
}

/**
 * The globs a module-scoped clone should be offered: what it installed, plus
 * what the repository needs regardless.
 *
 * Duplicates are removed because a module may legitimately claim one of these
 * (an "integrations" module owning `src/lib/integrations/**`), and offering a
 * path twice would read as two candidates for one file.
 *
 * A MIRROR never calls this: its candidate set is already the whole tree, so
 * adding these would be a no-op that implied otherwise.
 */
export function globsForModuleScopedClone(installedGlobs: readonly string[]): string[] {
  return [...new Set([...installedGlobs, ...repositoryInvariantGlobs()])];
}
