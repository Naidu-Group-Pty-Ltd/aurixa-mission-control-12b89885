/**
 * `supabase/functions-registry/edge-typecheck-baseline.json` counts the Deno
 * type errors in each edge-function file, frozen so that a file which GAINS
 * one fails CI. It is a statement about the files in one tree, file by file.
 *
 * ## Why prime's copy cannot simply travel to a module-scoped clone
 *
 * `supabase/functions-registry/**` is a repository invariant, so prime's
 * baseline reaches every clone. On a mirror that is right: every counted file
 * crosses with it. A module-scoped clone keeps its own version of every file
 * outside its installed globs, so for those files prime's count describes a
 * file the clone does not hold.
 *
 * Measured on cascade #23 to `npc-crm-independent-6505dc` (prime@2e9eab9):
 * prime fixed `manage-ci-assessments/index.ts`, and its baseline dropped that
 * file's entry of 4. The clone's copy of the function is outside its scope and
 * was not delivered, so it still carries its four errors. The gate read the
 * unchanged file as `0 → 4` and failed `security` over a file nobody touched.
 * It will fail the same way on every later cascade, because the invariant
 * delivers prime's baseline every time.
 *
 * ## The rule
 *
 * A count describes a file, so it follows the file. Where the clone keeps its
 * own version of a counted file — it holds that file, the file differs from
 * prime's, and this delivery does not write it — the clone's count for it
 * stands. Every other entry is prime's: the file crosses, or it is the same
 * on both sides, or the clone does not hold it.
 *
 * When nothing is kept from the clone, prime's file is returned unchanged.
 * That is every mirror and every clone whose kept files have the same counts,
 * so this changes nothing anywhere the old behaviour was right.
 *
 * ## The file is only rewritten in the shape its generator writes
 *
 * `check-edge-functions.mjs --update` writes
 * `JSON.stringify({ $comment, generated_total, files }, null, 2)` plus a
 * newline, with `files` sorted by path. Each input must re-serialise to
 * itself byte for byte before anything is merged. A duplicate key or
 * hand-formatting fails that, and the reconcile declines rather than
 * silently rewrite a file it would not reproduce. `generated_total` is
 * recomputed as the sum, which is how the generator defines it.
 *
 * Client-safe: pure, no imports.
 */

/** The one path this module has an opinion about. */
export const EDGE_TYPECHECK_BASELINE_PATH =
  "supabase/functions-registry/edge-typecheck-baseline.json";

/** A count taken from the clone because the clone keeps its own file. */
export type KeptCount = {
  path: string;
  /** The clone's count for its own version. 0 where it has no entry. */
  count: number;
  /** Prime's count for prime's version. 0 where it has no entry. */
  primeCount: number;
};

export type EdgeTypecheckBaselineReconcile =
  | {
      ok: true;
      /** The baseline this delivery should leave on the clone. */
      merged: string;
      /**
       * Files whose count was taken from the clone rather than prime, sorted
       * by path. Empty means `merged` is prime's file, byte for byte.
       */
      keptFromClone: KeptCount[];
    }
  | { ok: false; reason: string };

type Baseline = {
  $comment?: string;
  generated_total?: number;
  files: Record<string, number>;
};

/** The generator's own serialisation: two spaces, a trailing newline. */
function serialise(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function parse(text: string, side: "prime" | "clone"): Baseline | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `${side}'s baseline is not JSON`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${side}'s baseline is not an object`;
  }
  const files = (value as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return `${side}'s baseline has no \`files\` map`;
  }
  for (const [path, count] of Object.entries(files)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return `${side}'s baseline counts ${path} as ${JSON.stringify(count)}, not a whole number`;
    }
  }
  // Fidelity: re-serialised, the input must be itself. A duplicated key is
  // discarded by `JSON.parse`, so a file carrying one fails here instead of
  // being quietly rewritten without it.
  if (serialise(value as Baseline) !== text) {
    return `${side}'s baseline is not in the shape its generator writes, so it is not rewritten here`;
  }
  return value as Baseline;
}

/**
 * The baseline a delivery should leave on the clone.
 *
 * `primeSha` and `cloneSha` are blob shas by path, the clone's as it stands
 * BEFORE this delivery. `crossing` is every path the delivery writes.
 */
export function reconcileEdgeTypecheckBaseline(args: {
  primeJson: string;
  cloneJson: string;
  primeSha: ReadonlyMap<string, string>;
  cloneSha: ReadonlyMap<string, string>;
  crossing: ReadonlySet<string>;
}): EdgeTypecheckBaselineReconcile {
  const prime = parse(args.primeJson, "prime");
  if (typeof prime === "string") return { ok: false, reason: prime };
  const clone = parse(args.cloneJson, "clone");
  if (typeof clone === "string") return { ok: false, reason: clone };

  /** Whether the clone keeps its OWN version of this file after the delivery. */
  const keepsOwn = (path: string): boolean => {
    if (args.crossing.has(path)) return false;
    const onClone = args.cloneSha.get(path);
    if (onClone === undefined) return false;
    return args.primeSha.get(path) !== onClone;
  };

  const paths = new Set([...Object.keys(prime.files), ...Object.keys(clone.files)]);
  const files: Record<string, number> = {};
  const keptFromClone: KeptCount[] = [];
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const own = keepsOwn(path);
    const count = own ? clone.files[path] : prime.files[path];
    // Only a count that differs from prime's is worth naming: a kept file
    // whose count agrees changes nothing a reader needs to know about.
    if (own && count !== prime.files[path]) {
      keptFromClone.push({ path, count: count ?? 0, primeCount: prime.files[path] ?? 0 });
    }
    if (count !== undefined) files[path] = count;
  }

  if (keptFromClone.length === 0) return { ok: true, merged: args.primeJson, keptFromClone };

  const total = Object.values(files).reduce((sum, n) => sum + n, 0);
  const merged = serialise({
    ...(prime.$comment !== undefined ? { $comment: prime.$comment } : {}),
    generated_total: total,
    files,
  });
  return { ok: true, merged, keptFromClone };
}

/**
 * One line for the pull request body: which counts were kept, and what
 * prime's file counts instead. A number a machine rewrote in a file a person
 * is reviewing has to say that it did.
 */
export function describeKeptCounts(kept: readonly KeptCount[]): string {
  const each = kept.map((k) => `\`${k.path}\` ${k.count} (prime's version: ${k.primeCount})`);
  return (
    `kept this clone's count for ${kept.length} file(s) it keeps its own version of: ` +
    each.join(", ")
  );
}
