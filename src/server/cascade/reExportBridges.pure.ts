/**
 * A BRIDGE TRAVELS WITH THE SHARED MODULE IT RE-EXPORTS.
 *
 * ## The pattern
 *
 * Edge Functions cannot import from `src/`, so a module both halves need is
 * written ONCE under `supabase/functions/_shared/` and the frontend reaches it
 * through a bridge: a file in `src/` that does nothing but re-export it. Prime
 * holds 311 of them, and one of its own specs enforces the pairing for the
 * report design system — `designSystemSourceOfTruth.spec.ts` fails unless
 * `src/lib/reportDesign/` holds exactly one bridge per module in
 * `_shared/reportDesign/`.
 *
 * ## What went missing
 *
 * `_shared/**` crosses on every clone, whatever is installed, so a new shared
 * module always arrives. Its bridge arrives only where an installed module's
 * globs name it, or where something the delivery carries imports it — and a
 * bridge that exists for the frontend's convenience, or for a parity check, is
 * imported by nothing yet. Measured on cascade PR #29 to
 * `npc-crm-independent-6505dc` (prime@cdff4f2): five new modules crossed into
 * `_shared/reportDesign/`; the import closure brought two of their bridges,
 * because a delivered file imports them, and left the other three —
 * `cssUnits`, `templateDesignCss` and `templateDesignCatalogue.generated` —
 * behind. `verify` failed on the pairing.
 *
 * ## The rule
 *
 * A file prime holds and the clone lacks travels when:
 *
 *   - it is under `src/`, is source, and is at most `MAX_BRIDGE_BYTES` —
 *     every one of prime's 311 bridges is (the largest is 3,945 bytes, most
 *     carry a comment header and one line);
 *   - it does NOTHING but re-export (`reExportSpecifiers`, the same reading
 *     the kept-spec channel uses to look through a shim), so it adds no
 *     behaviour of its own;
 *   - every module it re-exports resolves in prime's tree to a file under
 *     `supabase/functions/_shared/` — the layer that crosses everywhere —
 *     and that file will be PRIME'S OWN on the clone once this delivery lands:
 *     written by it, or already byte-identical there. A bridge onto a module
 *     the delivery held back is not owed, because it would re-export a file
 *     the clone does not have; and
 *   - the clone already holds a file in the bridge's directory, so this
 *     completes a part of the frontend the clone carries and never plants a
 *     directory it does not.
 *
 * It is judged over the FINISHED delivery, beside the spec channel's carry,
 * and carried the same way: through `planSubjectCarry`, the exclusions and
 * `prepareOne`, on identical terms with every other carried file. Reading the
 * candidates costs one batched read: on the independent at prime@cdff4f2, 92
 * source files prime holds and the clone lacks sit in directories the clone
 * holds, 18 of them are small enough to be a bridge, and exactly five are —
 * the five `reportDesign` bridges.
 *
 * Pure: no I/O. The engine lists the trees and reads the texts.
 */

import { importsOf, resolveSpecifier, type TreeIndex } from "./importClosure.pure";
import { reExportSpecifiers } from "./specsLeftBehind.pure";

/**
 * The largest file read as a possible bridge. Prime's largest bridge onto
 * `_shared` is 3,945 bytes (measured over all 311 at prime@cdff4f2; the 95th
 * percentile is 675), so this admits every one and reads almost nothing else.
 */
export const MAX_BRIDGE_BYTES = 4096;

/** The layer every clone receives whatever it installs. */
const SHARED = "supabase/functions/_shared/";

const SOURCE = /\.[cm]?[jt]sx?$/;

function directoryOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * The files that COULD be a bridge this clone is missing, by path and size
 * alone: prime holds them, the clone does not, they are small source files
 * under `src/`, and the clone holds a file beside each. Sorted. Only these
 * are read.
 */
export function bridgeCandidates(args: {
  prime: TreeIndex;
  primeSizes: ReadonlyMap<string, number>;
  clone: TreeIndex;
}): string[] {
  const cloneDirectories = new Set<string>();
  for (const path of args.clone.keys()) cloneDirectories.add(directoryOf(path));
  const out: string[] = [];
  for (const path of args.prime.keys()) {
    if (!path.startsWith("src/") || !SOURCE.test(path) || args.clone.has(path)) continue;
    const size = args.primeSizes.get(path);
    if (size === undefined || size > MAX_BRIDGE_BYTES) continue;
    if (!cloneDirectories.has(directoryOf(path))) continue;
    out.push(path);
  }
  return out.sort();
}

/** A bridge the delivery owes the clone, and the shared modules it re-exports. */
export type OwedBridge = { path: string; targets: string[] };

/**
 * The candidates that ARE bridges owed by this delivery, as it stands. Sorted.
 *
 * `delivered` is every path the delivery writes. A candidate whose text was
 * not read is not owed: nothing is carried on a guess, and the next pass asks
 * again.
 */
export function bridgesOwed(args: {
  candidates: readonly string[];
  readPrime: (path: string) => string | undefined;
  prime: TreeIndex;
  clone: TreeIndex;
  delivered: ReadonlySet<string>;
}): OwedBridge[] {
  const { prime, clone, delivered } = args;
  const out: OwedBridge[] = [];
  for (const path of args.candidates) {
    if (delivered.has(path) || clone.has(path)) continue;
    const text = args.readPrime(path);
    if (text === undefined) continue;
    const specifiers = reExportSpecifiers(text);
    if (specifiers === null) continue;
    // Every re-export must be one `importsOf` reads (relative or `@/`) — a
    // bridge onto a package is not a bridge onto the shared layer.
    const readable = new Set(importsOf(text));
    const targets: string[] = [];
    let owed = true;
    for (const specifier of specifiers) {
      const target = readable.has(specifier) ? resolveSpecifier(specifier, path, prime) : null;
      if (target === null || !target.startsWith(SHARED)) {
        owed = false;
        break;
      }
      const lands = delivered.has(target) || clone.get(target) === prime.get(target);
      if (!lands) {
        owed = false;
        break;
      }
      targets.push(target);
    }
    if (owed) out.push({ path, targets: [...new Set(targets)].sort() });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The pull request body's section on bridges carried. Empty when none. */
export function describeBridges(carried: readonly OwedBridge[]): string {
  return carried
    .map((b) => `- \`${b.path}\` re-exports ${b.targets.map((t) => `\`${t}\``).join(", ")}`)
    .join("\n");
}

/** The one phrase a result summary uses for bridges carried. */
export function bridgeSuffixFor(carried: readonly OwedBridge[]): string {
  return carried.length > 0 ? ` · ${carried.length} re-export bridge(s) carried` : "";
}
