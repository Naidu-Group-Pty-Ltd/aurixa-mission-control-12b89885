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
    pattern: "supabase/migrations/**",
    reason:
      "The migration directory is read as a CORPUS by things that already travel, and it was the " +
      "only one of them that did not. `src/lib/testSupport/migrationCorpus.ts` enumerates the " +
      "whole directory; `check-applied-body-digests.mjs` and `check-migration-version-collisions." +
      "mjs` are in scripts/**; `supabase/migration-object-index.json` describes prime's entire " +
      "corpus and cascades as part of a module. So a module-scoped clone receives every reader of " +
      "the directory and never the directory — the same shape as src/lib/integrations/**, one " +
      "level up. Measured 22 Sep 2026 on npc-crm-independent, the fleet's only `modules` clone: " +
      "1,000 migration paths against prime's 1,026, the 36 missing being 9 collision renames " +
      "prime had already made, 5 seed files over the per-file ceiling, and 22 that were simply " +
      "new. That gap only ever grows, because nothing in the module globs can reach the " +
      "directory. PR #16 failed `verify` on it in the same pass that delivered the spec: " +
      "`ENOENT … 20261213000000_market_building_approvals.sql`, 4,870 bytes, in no glob. It is " +
      "the whole directory rather than named files for `docs/**`'s reason — a migration file " +
      "imports nothing and executes nothing in CI, so carrying all of it is safe where a whole " +
      "source directory would not be. And it applies nothing: no clone runs migrations from its " +
      "repository (npc-crm-independent's own apply-migration.yml opens by explaining why it is " +
      "not `db push`), so this changes which files a clone HOLDS and never which SQL has run " +
      "against it. The per-file ceiling still binds afterwards, which is correct — an oversized " +
      "seed then reaches the held-back list and is named, instead of being invisible.",
  },
  {
    pattern: "supabase/migration-object-index.json",
    reason:
      "Generated from supabase/migrations/ by scripts/build-migration-object-index.mjs, and it " +
      "travels for the reason src/lib/integrations/** does: a generated file and its source are " +
      "one artefact. It is not under the directory, so the glob above does not reach it. On a " +
      "clone the index is CARRIED rather than authored — `indexIsCarriedNotAuthored` says so and " +
      "both the spec and the CI check read that one implementation, so a clone is never asked to " +
      "regenerate it — which makes prime's copy the only correct copy and a stale one purely " +
      "wrong. It matters because a consumer reads a name the index does not carry as \"never " +
      "ours\", which is the reading that lets one of this repository's own leftovers pass as a " +
      "tenant's data. Measured 22 Sep 2026: npc-crm-independent held a copy predating its fork " +
      "while receiving neither the directory nor the index.",
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
  // ── Three more specs whose subjects cascade without them ──────────────────
  //
  // The same defect as `openLocation` above, found by measuring rather than by
  // widening: on `npc-crm-independent-6505dc` — the fleet's only clone whose
  // `sync_scope` is `modules` — each of these three is RUN by that clone's CI,
  // asserts about a subject that IS inside a module glob and cascades, and was
  // already behind prime's copy when this was measured (22 Sep 2026, against
  // prime@2cda273). Prime edits the subject, the clone receives it beside the
  // old assertion, and `verify` goes red with nothing the cascade can send.
  //
  // Named as exact paths rather than as `src/lib/reportTemplate/__tests__/**`
  // for the reason the test below pins: a directory would also carry the specs
  // in it whose subjects are NOT present, which is the opposite failure. Every
  // import and every `readFileSync` target of these three was checked present
  // on that clone, so carrying them imports nothing new.
  {
    pattern: "src/lib/reportTemplate/__tests__/printFontPolicy.spec.ts",
    reason:
      "Asserts the font and network-boundary rules implemented in " +
      "supabase/functions/_shared/reportDesign/printFontPolicy.pure.ts and " +
      "renderResourcePolicy.pure.ts. Both are inside module globs and cascade; this spec is " +
      "inside none and does not, so a change to either ships the new subject beside the old " +
      "assertion. The clone runs it — `npx vitest run src/lib/reportTemplate` in its own ci.yml.",
  },
  {
    pattern: "src/lib/reportDesign/__tests__/fieldAccentFloor.spec.ts",
    reason:
      "Asserts the contrast floor over supabase/functions/_shared/templateColourways.generated.ts " +
      "and templateColourways.pure.ts, both of which cascade inside module globs. The generated " +
      "colourways are regenerated from the design source, so a palette change reaches the clone " +
      "while the assertion about it does not. The clone runs it — `npx vitest run " +
      "src/lib/reportDesign`.",
  },
  {
    pattern: "src/lib/reportTemplate/__tests__/unassessedRiskColour.spec.ts",
    reason:
      "Asserts how an unassessed risk row is coloured, over " +
      "supabase/functions/_shared/reports/investment/riskRegister.pure.ts, which cascades inside " +
      "a module glob. `An absence may not be rated` is a rule the prime keeps tightening, so the " +
      "subject moves often and the assertion about it never follows. The clone runs it — " +
      "`npx vitest run src/lib/reportTemplate`.",
  },

  // The next two were found the way this file prefers: by a cascade doing it,
  // not by a sweep predicting it. Proposal #16 on that same clone
  // (prime@05808a3, 22 Sep 2026) delivered
  // `supabase/functions/_shared/reportDesign/tokens.pure.ts` with
  // `CONTRAST_FLOOR.body` and `.micro` corrected from 4.5 to the 7
  // `REPORT_RULES.md` §2 has always specified. The resolver then darkens the
  // semantic four and the muted ink for the stock they print on — `#D31212`
  // becomes `#9B0D0D` — and prime RENEGOTIATED both specs in the same commit,
  // saying so in their own headers: *"the bytes move while the guarantee does
  // not"*. The subject arrived byte-identical and the renegotiation did not, so
  // `verify` failed four assertions the clone could do nothing about.
  //
  // The precondition this file sets was measured on that branch rather than
  // assumed. All five modules the two specs reach — `tokens`, `brandResolve`,
  // `roles`, `charts`, `color` — are byte-identical to prime's there, and the
  // four symbols prime's newer copies newly import (`mixHex`,
  // `heatmapAlphaCeiling`, `HEATMAP_ALPHA_FLOOR`, `tileWithItsFigure`) are all
  // exported by the clone's own tree already. Both specs RAN on that CI — they
  // failed on a value, never on an import — which is the same fact from the
  // wire instead of from a glob table.
  {
    pattern: "src/lib/reportDesign/__tests__/printContrast.spec.ts",
    reason:
      "Asserts the print contrast floors over " +
      "supabase/functions/_shared/reportDesign/tokens.pure.ts, brandResolve.pure.ts and " +
      "roles.pure.ts, all three inside module globs. It is the file that decides what a " +
      "correction to a floor is ALLOWED to move — lightness and not hue — so a floor that " +
      "cascades without it leaves the clone asserting the pre-correction colours. The clone " +
      "runs it — `npx vitest run src/lib/reportDesign` in its own ci.yml.",
  },
  {
    pattern: "src/lib/reportDesign/__tests__/reportCharts.spec.ts",
    reason:
      "Asserts that a chart takes its ink from the resolved palette and can never be the place " +
      "risk becomes green, over supabase/functions/_shared/reportDesign/charts.pure.ts and the " +
      "same tokens module. It reads the semantic inks back out of the rendered SVG, so it moves " +
      "in the same commit as printContrast and fails for the same reason. The clone runs it — " +
      "`npx vitest run src/lib/reportDesign`.",
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
