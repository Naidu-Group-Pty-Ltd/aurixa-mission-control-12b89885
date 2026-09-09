/**
 * A payload must contain what it imports.
 *
 * ## The rule
 *
 * **Every prime file transitively imported by a file the clone holds must
 * travel, at prime's version.** A module's globs are drawn around a FEATURE;
 * an import crosses whatever boundary it needs to. So a payload built from
 * globs alone is not import-closed, and the first unresolved import fails the
 * whole build.
 *
 * This is `repositoryInvariants.pure.ts` one layer down. That module names the
 * paths the REPOSITORY needs whatever is installed — a fixed list, because CI's
 * inputs are knowable in advance. An import graph is not knowable in advance,
 * so this one is computed.
 *
 * ## What went wrong
 *
 * Measured 9 Sep 2026. `npc-test-76b3b3` PR #11 and `preflight-property-group`
 * PR #12 had both been open since 8 September, both `mergeable: true`, and
 * neither could ever merge: the auto-merge drain correctly refuses a proposal
 * whose deployment is red, and the deployment was red on
 *
 *     [vite:load-fallback] Could not load src/lib/calendar/bookingNotifications.pure
 *       (imported by src/pages/Calendar.tsx)
 *
 * The cascade had sent `Calendar.tsx` and had never sent the module it imports.
 * The clones were out of sync for a day and a half with correct content in the
 * proposal and nothing in any log naming the reason — the build reports only
 * the FIRST unresolved import, so the true size is invisible until you close
 * the graph. It was 19 files on one clone and 34 on the other.
 *
 * ## Three things this gets right that a hand repair got wrong
 *
 * **It follows BOTH specifier forms.** The first hand-written closure followed
 * `@/` only. The build then got eight times further and failed on
 * `Could not resolve "./platformBrand"` — a file reached by `./` leaves the
 * payload exactly as easily as one reached by `@/`. A closure over one form is
 * not a closure.
 *
 * **A file present at the wrong VERSION is as broken as one absent.** The next
 * failure after the missing files were added was
 * `"MAX_COMPARISON_PEERS" is not exported by comparisonCandidates.pure.ts` —
 * the clone had that file, seeded and never updated, because it sits outside
 * every glob. So membership is decided on the blob SHA, never on presence.
 *
 * **It adds no feature.** Every path it yields is already imported by code the
 * clone holds. Completing what a clone's own code references is not the same
 * as widening what it is entitled to, and this must never be used to do the
 * latter.
 *
 * Like an invariant, a closure **widens what is SENT and never what is
 * REMOVED**: the deletion question stays on `installedGlobs` alone.
 */

/** path → blob SHA, as `listTreeEntries` returns. */
export type TreeIndex = ReadonlyMap<string, string>;

/**
 * Extensions tried when a specifier omits one, in resolution order.
 *
 * `.json` is included because Vite resolves it and a data module that fails to
 * travel breaks the build exactly like a source one. The bare entry comes first
 * so an explicit `./x.ts` resolves to itself rather than to `./x.ts.ts`.
 */
const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
] as const;

/** Only these are parsed for imports; anything else is carried, not walked. */
const WALKABLE = /\.(?:ts|tsx|js|jsx|mjs)$/;

/**
 * Static and dynamic imports, and re-exports, in both specifier forms.
 *
 * Deliberately a regex rather than a parser. The cost of missing an edge case
 * is a file that does not travel — the situation today — and the cost of a
 * false positive is one extra file in the payload, so the asymmetry favours
 * matching broadly. It is anchored on the keyword so a specifier inside a
 * string literal or a comment is not mistaken for an import; `stripComments`
 * below removes the commonest source of those.
 */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+|@\/[^'"]+)['"]/g;

/** Remove line and block comments so prose naming a path is never followed. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every `@/` or relative specifier in a source file, in order, deduplicated. */
export function importsOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of stripComments(source).matchAll(SPECIFIER)) out.add(m[1]);
  return [...out];
}

/** Normalise a POSIX path, resolving `.` and `..` without touching the disk. */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Resolve one specifier to a real prime path, or null.
 *
 * `@/x` is the project alias for `src/x`; `./x` and `../x` resolve against the
 * importing file's directory. A specifier that names nothing in prime returns
 * null — a bare package import never reaches here, because the pattern only
 * matches the two relative forms.
 */
export function resolveSpecifier(
  specifier: string,
  importer: string,
  prime: TreeIndex,
): string | null {
  const base = specifier.startsWith("@/")
    ? `src/${specifier.slice(2)}`
    : normalise(`${importer.split("/").slice(0, -1).join("/")}/${specifier}`);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (prime.has(candidate)) return candidate;
  }
  return null;
}

export type ClosureInput = {
  /** Paths already in the payload, plus the paths the clone already holds. */
  readonly seed: readonly string[];
  /** Prime's whole tree. A path absent from it can never be added. */
  readonly prime: TreeIndex;
  /** The clone's whole tree, for deciding missing-or-stale. */
  readonly clone: TreeIndex;
  /** Prime's content for a path, or undefined if it could not be read. */
  readonly readPrime: (path: string) => string | undefined;
  /**
   * Ceiling on how many paths a single pass may add.
   *
   * A runaway closure would turn a twenty-file proposal into the whole
   * repository, which is the one way this could do harm. Reaching it is
   * reported rather than thrown: a partial closure is still strictly better
   * than none, and the pass says so.
   */
  readonly maxAdded?: number;
};

export type ClosureResult = {
  /** Paths to add to the payload, sorted, each missing or stale on the clone. */
  readonly added: string[];
  /** How many widening rounds ran. */
  readonly rounds: number;
  /** True when `maxAdded` stopped the walk before it converged. */
  readonly truncated: boolean;
  /** Specifiers that resolved to nothing in prime, for reporting. */
  readonly unresolved: string[];
};

const DEFAULT_MAX_ADDED = 2000;

/**
 * Walk the import graph from `seed` and return what the payload is missing.
 *
 * A path is added when prime has it AND the clone's blob differs — which
 * covers absent (no blob) and stale (a different blob) in one comparison,
 * because those are the same failure to a bundler and only the message differs.
 *
 * A file whose content cannot be read is carried but not walked: refusing the
 * whole closure over one unreadable blob would throw away every other path it
 * found, and the unread file's own imports are the only thing lost.
 */
export function closeOverImports(input: ClosureInput): ClosureResult {
  const { seed, prime, clone, readPrime } = input;
  const maxAdded = input.maxAdded ?? DEFAULT_MAX_ADDED;

  const added = new Set<string>();
  const unresolved = new Set<string>();
  const walked = new Set<string>();
  let frontier = [...new Set(seed)].filter((p) => prime.has(p));
  let rounds = 0;
  let truncated = false;

  while (frontier.length > 0 && !truncated) {
    rounds += 1;
    const next: string[] = [];
    for (const importer of frontier) {
      if (walked.has(importer) || !WALKABLE.test(importer)) continue;
      walked.add(importer);
      const source = readPrime(importer);
      if (source === undefined) continue;
      for (const specifier of importsOf(source)) {
        const target = resolveSpecifier(specifier, importer, prime);
        if (target === null) {
          unresolved.add(specifier);
          continue;
        }
        // Missing OR stale — the same comparison answers both.
        if (clone.get(target) === prime.get(target)) continue;
        if (added.has(target)) continue;
        if (added.size >= maxAdded) {
          truncated = true;
          break;
        }
        added.add(target);
        next.push(target);
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return {
    added: [...added].sort(),
    rounds,
    truncated,
    unresolved: [...unresolved].sort(),
  };
}
