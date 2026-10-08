/**
 * A GENERATED file travels with the files it is generated from.
 *
 * Some committed files are not written by anyone. A script derives them from
 * other files, and CI regenerates them and fails on any byte of difference.
 * `mobile/design-tokens.json` is the case this module was written for:
 * `npm run mobile:tokens` derives it from `src/styles/tokens.css` and
 * `src/styles/finance-portal.css`, and `mobile:tokens:check` is a step of
 * `verify`.
 *
 * ## What went wrong
 *
 * Measured 8 Oct 2026, cascade #81 on `npc-crm-independent-6505dc`. That
 * clone is module-scoped, and `mobile/**` lies inside none of its installed
 * globs. The cascade delivered prime's new `tokens.css`, which is inside them,
 * and left `design-tokens.json` at the clone's older version. `verify` failed
 * on `mobile:tokens:check` for a file the cascade never touched. The
 * regenerated file was byte-identical to prime's committed one, because both
 * of its sources had landed at prime's version. Prime's copy was correct, and
 * scope was all that kept it out.
 *
 * ## The rule
 *
 * **A generated file is carried at prime's version exactly when every file it
 * is generated from lands at prime's version.** That includes the generator
 * script. A source "lands" when this delivery writes prime's copy of it, or
 * when the clone already holds prime's copy and this delivery does not
 * remove it.
 *
 * Any weaker rule is wrong, and the failure is easy to see. A clone that
 * keeps its own palette holds its own `tokens.css`, so prime's
 * `design-tokens.json` describes somebody else's palette there, and carrying
 * it turns the same check red the other way round. So a source the delivery
 * holds back, reconciles into a clone-specific version, or never had a
 * prime copy of, means nothing is carried. The artefact stays as the clone
 * has it, and a person regenerates it.
 *
 * This is why it is not a repository invariant. An invariant carries prime's
 * copy everywhere, whatever the clone holds.
 *
 * ## What it is not
 *
 * - **Not the mobile API surface.** `mobile/api-surface.json` is generated
 *   from the security registry and `config.toml`, and both are reconciled
 *   into clone-specific versions. So prime's surface is almost never right
 *   for a clone. `apiSurfaceReconcile.pure.ts` composes the clone's own
 *   surface instead, and this table must not name that file. A test asserts
 *   it.
 * - **Not a widening of scope.** It carries only a file the clone already
 *   holds, which `planSubjectCarry` assumes of every path it is handed. A
 *   clone without the artefact does not run its check.
 * - **Not an override.** What it returns goes through `planSubjectCarry` and
 *   `partitionCascadePaths` like any stranded subject, so a held or excluded
 *   artefact stays held.
 */

export type GeneratedArtefact = {
  /** The committed, generated file. */
  readonly artefact: string;
  /**
   * Every file its generator reads, the generator script included. All of
   * them must land at prime's version before prime's artefact may travel.
   */
  readonly sources: readonly string[];
  /** The command that regenerates it, for anybody reading the rule. */
  readonly regenerate: string;
};

export const GENERATED_ARTEFACTS: readonly GeneratedArtefact[] = [
  {
    artefact: "mobile/design-tokens.json",
    // `SOURCES` in the generator, plus the generator itself.
    sources: [
      "src/styles/tokens.css",
      "src/styles/finance-portal.css",
      "scripts/mobile/export-design-tokens.mjs",
    ],
    regenerate: "npm run mobile:tokens",
  },
];

/**
 * The generated files this delivery owes, sorted.
 *
 * An artefact is owed when:
 * - the clone holds it, prime holds it, and the two differ;
 * - this delivery is not already writing it, and no rule holds it; and
 * - every one of its sources lands at prime's version.
 *
 * `deliveredAtPrime` must hold only writes of prime's own content. A file a
 * pump reconciled into a clone-specific version is not prime's version, and
 * passing it here would carry an artefact that describes the wrong source.
 */
export function generatedArtefactsOwed(args: {
  /** Prime's blob sha by path. */
  prime: ReadonlyMap<string, string>;
  /** The clone's blob sha by path. */
  clone: ReadonlyMap<string, string>;
  /** Paths this delivery writes with prime's own content. */
  deliveredAtPrime: ReadonlySet<string>;
  /** Paths this delivery removes from the clone. */
  removed: ReadonlySet<string>;
  /** Paths a rule of this cascade holds. */
  held: ReadonlySet<string>;
  /** The table, injectable so the rule is tested apart from the data. */
  table?: readonly GeneratedArtefact[];
}): string[] {
  const { prime, clone, deliveredAtPrime, removed, held } = args;
  const table = args.table ?? GENERATED_ARTEFACTS;

  const lands = (path: string): boolean => {
    const onPrime = prime.get(path);
    // Prime states nothing about a file it does not hold, so nothing can be
    // concluded about an artefact generated from it.
    if (onPrime === undefined) return false;
    if (removed.has(path) || held.has(path)) return false;
    if (deliveredAtPrime.has(path)) return true;
    return clone.get(path) === onPrime;
  };

  const owed: string[] = [];
  for (const entry of table) {
    const { artefact } = entry;
    const onPrime = prime.get(artefact);
    const onClone = clone.get(artefact);
    if (onPrime === undefined || onClone === undefined) continue;
    if (onPrime === onClone) continue;
    if (deliveredAtPrime.has(artefact) || removed.has(artefact) || held.has(artefact)) continue;
    if (entry.sources.length === 0) continue;
    if (!entry.sources.every(lands)) continue;
    owed.push(artefact);
  }
  return owed.sort();
}
