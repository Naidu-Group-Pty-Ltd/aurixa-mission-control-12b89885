/**
 * THE TWO BASELINES, RECONCILED RATHER THAN WITHHELD.
 *
 * `securityInventoryHold` and `functionCountRatchetHold` refuse the prime's
 * copies of the two files that state a repository's own edge-function set,
 * and refusing is correct: prime's numbers describe prime's tree. But a
 * refusal leaves the clone's numbers describing the tree it had BEFORE the
 * pass, and the pass changes that tree — so `security` and `verify` go red on
 * a file the cascade declined to write rather than on one it wrote wrong. The
 * hold's own note has always named the remedy (`npm run security:inventory`)
 * and nothing has ever run it, because the engine composes a git tree over the
 * GitHub API and cannot run npm.
 *
 * So the numbers are computed here, from what the pass already holds.
 *
 * ## Why this is not a second implementation of the generator
 *
 * `scripts/security/security-inventory.mjs` emits ten fields. Six are a
 * function of `config.toml`, `SECURITY_REGISTRY.json` and the set of function
 * directories — all three of which this pass has already reconciled, in
 * memory, by the time it gets here. Those six are computed.
 *
 * The other two — `functions_importing_shared_auth_modules` and
 * `statically_derivable_inter_function_graph` — are a function of the SOURCE
 * of every `.ts`/`.tsx`/`.js` file under `supabase/functions/`. Reproducing
 * them would mean reading ~555 files over the API on every pass, and a
 * reimplementation that agrees with the generator in practice but not in
 * principle is how code and test agree while only the server disagrees. They
 * are not recomputed. They are PARTITIONED:
 *
 *   the merged tree takes prime's content for a delivered path and the
 *   clone's for every other, so each path's contribution is whatever the
 *   corresponding inventory already attributes to it.
 *
 * Both inventories were written by the same generator over their own trees,
 * so this is the generator's own answer re-filed per path — not a second
 * opinion about what a file imports.
 *
 * ## Where the partition does not reach, and what happens there
 *
 * `functions_importing_shared_auth_modules` lists PATHS, so the partition is
 * exact. The inter-function graph does not: its entries are `caller->callee`,
 * attributed to a DIRECTORY rather than to a file, so a merged tree taking one
 * file from each side cannot be partitioned edge by edge.
 *
 * Given only the two inventories, it is carried only where prime's graph and
 * the clone's are IDENTICAL, which is the one case where the answer cannot
 * depend on the split. Measured 21 Sep 2026 against `npc-crm-independent`:
 * 69 edges each, no edge in one and not the other, while the imports differ
 * by exactly two pairs and both are for functions only the clone has. Where
 * they differ at all this refuses and the caller holds.
 *
 * ## Given both trees, the graph is attributed caller by caller
 *
 * That refusal stopped being the rare case. Measured 8 Oct 2026 on cascade
 * #81 to `npc-crm-independent-6505dc`: the clone holds CRM functions prime
 * does not, so the two graphs differ for good. Every pass refused, and the
 * clone's `security` job failed on counts this module had already computed
 * correctly.
 *
 * The generator names an edge's caller by the first directory under
 * `supabase/functions/`, so an edge is a fact about ONE directory. A
 * directory whose every walked file in the merged tree carries prime's
 * content, with exactly prime's set of files, produces exactly prime's edges
 * for that caller. The same holds for the clone. So where both trees are
 * passed, each caller is attributed alone:
 *
 *   - entirely prime's: prime's edges for it;
 *   - entirely the clone's: the clone's edges for it;
 *   - mixed, where both sides record the same edges for it: those edges.
 *     This is the identical-graph rule above, applied to one caller rather
 *     than to the whole graph, and it is what carries `_shared`. That
 *     directory is mixed on every clone that keeps a module of its own, and
 *     on `npc-crm-independent-6505dc` both sides record the same two edges
 *     for it. With neither side holding an edge, it is "none";
 *   - mixed otherwise: refused, naming the caller.
 *
 * A file whose blob is the same on both sides counts as either side's. This
 * is still the generator's own answer, re-filed per caller rather than per
 * path. Nothing is read or parsed that the generator did not already write.
 *
 * ## A mixed caller the sides disagree about is settled by its differing files
 *
 * "Mixed otherwise" stopped being rare too. Measured 26 Oct 2026 on cascade
 * #121 to `npc-crm-independent-6505dc`: the prime added
 * `_shared/cronMigrationFunctionUrls.test.ts`, whose fixtures name
 * `functions/v1/x`, so the prime recorded `_shared->x` and the clone did not.
 * The merged `_shared` walks 1,355 files. Of the files either tree walks
 * there, 31 differ: 23 only the line holds, 7 only the prime holds, and one
 * both hold in different copies. So the pass refused, kept the clone's
 * baseline, and the clone's `security` job failed on the three entries the
 * delivery added.
 *
 * Every walked file of a mixed caller carries the same content in the merged
 * tree as it does on one side or the other, or is a file a pump composed. So
 * a caller's merged edges are those of four sets:
 *
 *   - `same`: the blob is the prime's AND the clone's;
 *   - `fromPrime`: the prime's blob, not the clone's (a delivered file);
 *   - `fromClone`: the clone's blob, not the prime's (the clone's own, or one
 *     this pass does not deliver);
 *   - `composed`: neither (a merged line variant).
 *
 * The last three are what make the caller mixed, and they are few. Their text
 * is read and their edges taken by the generator's own rule (`edgesOfSource`,
 * transcribed below). `same` is never read: the prime's edges for the caller
 * are `same`'s plus those of the prime files whose content the merged tree
 * does not carry, and the clone's likewise, so an edge either side records
 * and none of its other files explains comes from `same`. A composed file's
 * prime original is one of those other files, so it is read from the prime;
 * the merge's text never stands in for it, or an edge the merge dropped would
 * be taken for one of `same`'s and kept. An edge both sides
 * record that their other files ALSO explain is the one thing this cannot
 * place, and it still refuses, naming the edge. Where a read file's edges are
 * not in that side's own baseline, the transcription or the baseline is
 * wrong, and it refuses rather than write either.
 * Run over cascade #81's real trees (prime@72da9a5 onto the clone's main),
 * it wrote the document the generator wrote on that branch, byte for byte.
 *
 * Nothing here guesses. Every refusal is named, and a named refusal costs a
 * pass the same red check it already had.
 *
 * ## What a clone does not hold is taken out of the graph first
 *
 * A clone without the prime-only features (`primeOnlyFeatures.pure.ts`) does
 * not hold their directories, and the generator attributes an edge to the
 * directory of its CALLER — so every edge a withheld function makes is one
 * the clone's tree cannot produce. Measured on prime@387feb03: three, all
 * from the GoHighLevel account migration
 * (`ghl-legacy-wipe-orchestrator->ghl-legacy-wipe-worker`,
 * `ghl-legacy-wipe-worker->ghl-legacy-wipe-worker`,
 * `migration-job-control->migration-dispatcher`). They are removed from BOTH
 * graphs before the two are compared, and the carried graph is prime's less
 * them. An edge INTO a withheld function from a function the clone keeps
 * stays: its caller is on disk and still names it. Nothing else is filtered,
 * so a withheld shared module that contributed an edge would make the two
 * graphs differ and the pass refuses, as it does today.
 */

import { withheldClause } from "../crmLineFeatures.pure";
import { baselineSourceWords } from "./securityInventoryHold.pure";

/** The file the generator writes and CI diffs. */
export const SECURITY_INVENTORY_PATH = "docs/security/SECURITY_INVENTORY.json";

/** The spec that ratchets the declaration count. */
export const FUNCTION_COUNT_RATCHET_PATH = "src/lib/security/auditRemediation.spec.ts";

/** Everything under here is an edge function or the shared library. */
const EDGE_FUNCTIONS_PREFIX = "supabase/functions/";

/** The one directory under it that is not a function. */
const SHARED_DIRECTORY = "_shared";

/** What the generator's walk keeps: source files. */
const SOURCE_FILE = /\.(?:ts|tsx|js)$/;

/**
 * A refusal carries its reason, because the caller renders it to a person.
 * One that could be settled by reading a few files says which, in `needs`
 * (see "A mixed caller the sides disagree about" in the header).
 */
export type BaselineReconcile<T> =
  | { ok: true; merged: T; count: number }
  | { ok: false; reason: string; needs?: CallerSourceNeeds };

/**
 * The most texts one pass reads to settle the mixed callers. Measured on
 * cascade #121 to `npc-crm-independent-6505dc`, replayed over its real trees:
 * 51 (19 of the prime's, 31 of the clone's, one merged variant), and the
 * baseline written from them was the generator's own output on the merged
 * tree, byte for byte. Reads are by blob id, eighty to a GraphQL query, so
 * this bounds a clone whose own shared library grows without bound rather
 * than the ordinary case.
 */
export const MAX_BASELINE_SOURCE_READS = 120;

/** The texts a mixed caller is settled from, by path. */
export type CallerSources = {
  /** The prime's text of a path. */
  readonly prime: ReadonlyMap<string, string>;
  /** The clone's text of a path, as its tree holds it before this pass. */
  readonly clone: ReadonlyMap<string, string>;
  /** The text this pass writes at a delivered path. */
  readonly merged: ReadonlyMap<string, string>;
};

/** The paths whose text settling the mixed callers still needs, by side. */
export type CallerSourceNeeds = {
  prime: string[];
  clone: string[];
  merged: string[];
};

/**
 * The function names `config.toml` declares, by the GENERATOR's own rule.
 *
 * Transcribed from `security-inventory.mjs`, which splits on a LINE-ANCHORED
 * `[functions.` and keys an object by name — so a block written twice counts
 * once, and a `[functions.x]` token inside prose is not a declaration at all.
 * That second property is the one that matters here: this repository's own
 * cascade marker used to carry a `[functions.X]` token, and the ratchet spec —
 * which counts with an UNANCHORED regex — read it as a declaration while the
 * generator did not. The two rules are deliberately kept apart: this one is
 * the inventory's, `extractRatchetRule` reads the spec's out of the spec.
 */
export function configDeclaredFunctionNames(toml: string): Set<string> {
  const names = new Set<string>();
  for (const section of toml.split(/(?=^\[functions\.)/m)) {
    const match = section.match(/^\[functions\.([A-Za-z0-9_-]+)\]/);
    if (match) names.add(match[1]);
  }
  return names;
}

/** The function directories a set of repository paths holds. */
export function functionDirsIn(paths: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(EDGE_FUNCTIONS_PREFIX)) continue;
    const rest = path.slice(EDGE_FUNCTIONS_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    if (name === SHARED_DIRECTORY) continue;
    names.add(name);
  }
  return names;
}

/**
 * Whether a path is one the generator's file walk would read.
 *
 * `walk` descends all of `supabase/functions/` — `_shared` INCLUDED, which is
 * why a shared module can contribute an import pair — and then drops
 * `/_shared/tests/` and anything that is not a source file.
 */
export function isWalkedSourceFile(path: string): boolean {
  if (!path.startsWith(EDGE_FUNCTIONS_PREFIX)) return false;
  if (path.includes("/_shared/tests/")) return false;
  return SOURCE_FILE.test(path);
}

/**
 * The generator's edge rule, transcribed from `security-inventory.mjs`:
 *
 *     for (const match of source.matchAll(/functions\/v1\/([A-Za-z0-9_-]+)/g))
 *       internalEdges.add(`${caller}->${match[1]}`);
 *
 * Every occurrence counts, in a comment or a test fixture as much as in a
 * call. Applied only to the files that make a caller mixed, and checked
 * against the baselines the generator itself wrote before anything it says is
 * used (`settleMixedCaller`).
 */
const INTER_FUNCTION_CALL = /functions\/v1\/([A-Za-z0-9_-]+)/g;

/** The edges the generator reads out of one walked file. */
export function edgesOfSource(path: string, source: string): string[] {
  const caller = fileCaller(path);
  const edges = new Set<string>();
  for (const match of source.matchAll(INTER_FUNCTION_CALL)) edges.add(`${caller}->${match[1]}`);
  return [...edges].sort();
}

/** The shape the generator emits, in the order it emits it. */
export type SecurityInventory = {
  schema_version: number;
  source: string;
  edge_function_count: number;
  config_declared_function_count: number;
  registry_function_count: number;
  verify_jwt_false_count: number;
  exposure_class_counts: Record<string, number>;
  needs_review_count: number;
  functions_importing_shared_auth_modules: Record<string, string[]>;
  statically_derivable_inter_function_graph: string[];
};

type RegistryEntry = { exposure_class?: unknown; verify_jwt?: unknown };

/**
 * One of this module's three JSON documents, or a refusal naming it.
 *
 * Every document read here — the two baselines and the reconciled registry —
 * is something the generator emitted as a JSON OBJECT, so that is the rule,
 * stated once for all three rather than per call site.
 *
 * It is stated here because `JSON.parse` succeeds on `null`, and `null` is
 * the one JSON value that throws on the next property access rather than
 * answering `undefined`. The shape checks below read `inv.schema_version`
 * and `root.functions` straight off the parsed value; a baseline holding
 * literal `null` reached them and threw out of the whole pass, when the
 * contract this module answers to is that an unusable input leaves the hold
 * standing and costs the pass exactly the red check it already had. An array
 * is refused by the same rule: it fails every shape check below anyway, and
 * naming it here is the difference between a reason and a symptom.
 */
function parseJson(
  text: string,
  what: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: `the ${what} is not readable as JSON` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `the ${what} is not a JSON object` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * The counts the registry decides, in the generator's own order.
 *
 * `exposure_class_counts` is sorted by `localeCompare` because the generator
 * sorts it that way and the check is a byte diff, not a semantic one.
 */
function registryCounts(functions: Record<string, RegistryEntry>): {
  registry_function_count: number;
  verify_jwt_false_count: number;
  exposure_class_counts: Record<string, number>;
  needs_review_count: number;
} {
  const entries = Object.values(functions);
  const tally: Record<string, number> = {};
  for (const entry of entries) {
    const cls = String(entry.exposure_class);
    tally[cls] = (tally[cls] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
  return {
    registry_function_count: Object.keys(functions).length,
    verify_jwt_false_count: entries.filter((e) => e.verify_jwt === false).length,
    exposure_class_counts: sorted,
    needs_review_count: tally["needs-review"] ?? 0,
  };
}

/**
 * Re-file one inventory's per-path import lists against the merged tree.
 *
 * For each module the generator tracks, a path is listed when the tree that
 * supplied that path's CONTENT listed it. Prime supplies a delivered path; the
 * clone supplies every other. The module keys and their order come from
 * prime's file, because the generator writes them from a fixed array and a key
 * order that drifts is a byte diff.
 */
function partitionImports(args: {
  prime: Record<string, string[]>;
  clone: Record<string, string[]>;
  mergedFiles: Set<string>;
  deliveredFiles: Set<string>;
}): Record<string, string[]> {
  const { prime, clone, mergedFiles, deliveredFiles } = args;
  const out: Record<string, string[]> = {};
  for (const module of Object.keys(prime)) {
    const fromPrime = new Set(prime[module] ?? []);
    const fromClone = new Set(clone[module] ?? []);
    const kept: string[] = [];
    for (const relative of mergedFiles) {
      const full = `${EDGE_FUNCTIONS_PREFIX}${relative}`;
      const listed = deliveredFiles.has(full) ? fromPrime.has(relative) : fromClone.has(relative);
      if (listed) kept.push(relative);
    }
    out[module] = kept.sort();
  }
  return out;
}

/** The generator's caller for an edge: the text before `->`. */
function edgeCaller(edge: string): string {
  const at = edge.indexOf("->");
  return at === -1 ? edge : edge.slice(0, at);
}

/**
 * The generator's caller for a walked file: the first segment under
 * `supabase/functions/`, `_shared` included.
 */
function fileCaller(path: string): string {
  return path.slice(EDGE_FUNCTIONS_PREFIX.length).split("/")[0];
}

type MixedCallerVerdict =
  | { act: "edges"; edges: string[] }
  | { act: "refuse"; reason: string }
  | { act: "read"; needs: CallerSourceNeeds };

/**
 * One mixed caller's merged edges, from the texts of the files that make it
 * mixed. See "A mixed caller the sides disagree about" in the header for the
 * four sets and why `same` is never read.
 */
function settleMixedCaller(args: {
  caller: string;
  merged: ReadonlySet<string>;
  primeFiles: ReadonlySet<string>;
  cloneFiles: ReadonlySet<string>;
  primeEdges: readonly string[];
  cloneEdges: readonly string[];
  primeTree: ReadonlyMap<string, string>;
  cloneTree: ReadonlyMap<string, string>;
  deliveredFiles: ReadonlySet<string>;
  rewritten: ReadonlySet<string>;
  sources: CallerSources;
}): MixedCallerVerdict {
  const { caller, primeTree, cloneTree, deliveredFiles, rewritten, sources } = args;
  const same = new Set<string>();
  const fromPrime: string[] = [];
  const fromClone: string[] = [];
  const composed: string[] = [];
  for (const path of args.merged) {
    const onPrime = primeTree.get(path);
    const onClone = cloneTree.get(path);
    if (deliveredFiles.has(path)) {
      if (rewritten.has(path)) composed.push(path);
      else if (onPrime === undefined) {
        return {
          act: "refuse",
          reason: `\`${path}\` is delivered from the prime but the prime's tree does not list it`,
        };
      } else if (onClone === onPrime) same.add(path);
      else fromPrime.push(path);
    } else if (onClone === undefined) {
      return {
        act: "refuse",
        reason: `\`${path}\` is in the merged tree, delivered by nobody and absent from the clone's`,
      };
    } else if (onClone === onPrime) same.add(path);
    else fromClone.push(path);
  }
  const fromPrimeSet = new Set(fromPrime);
  const fromCloneSet = new Set(fromClone);
  const primeRest = [...args.primeFiles].filter((p) => !same.has(p) && !fromPrimeSet.has(p));
  const cloneRest = [...args.cloneFiles].filter((p) => !same.has(p) && !fromCloneSet.has(p));

  // A file delivered unchanged is the prime's text, so what the pass writes
  // answers for it. A composed one is not: its prime original is read like
  // any other, never stood in for by the merge.
  const primeText = (path: string) =>
    sources.prime.get(path) ??
    (deliveredFiles.has(path) && !rewritten.has(path) ? sources.merged.get(path) : undefined);
  const needs: CallerSourceNeeds = {
    prime: [...fromPrime, ...primeRest].filter((p) => primeText(p) === undefined),
    clone: [...fromClone, ...cloneRest].filter((p) => !sources.clone.has(p)),
    merged: composed.filter((p) => !sources.merged.has(p)),
  };
  if (needs.prime.length + needs.clone.length + needs.merged.length > 0) {
    return { act: "read", needs };
  }

  const edgesOf = (paths: readonly string[], text: (p: string) => string | undefined) => {
    const out = new Set<string>();
    for (const path of paths)
      for (const edge of edgesOfSource(path, text(path) ?? "")) out.add(edge);
    return out;
  };
  const ePrime = edgesOf(fromPrime, primeText);
  const eClone = edgesOf(fromClone, (p) => sources.clone.get(p));
  const eComposed = edgesOf(composed, (p) => sources.merged.get(p));
  const ePrimeRest = edgesOf(primeRest, primeText);
  const eCloneRest = edgesOf(cloneRest, (p) => sources.clone.get(p));
  const primeSide = new Set(args.primeEdges);
  const cloneSide = new Set(args.cloneEdges);

  // What the files say must be what the side's own baseline says of them, or
  // either the transcription above or that baseline is wrong — and a merged
  // baseline built on a wrong one is the silent answer this module refuses.
  for (const [label, read, baseline] of [
    ["the prime's", new Set([...ePrime, ...ePrimeRest]), primeSide],
    ["this clone's", new Set([...eClone, ...eCloneRest]), cloneSide],
  ] as const) {
    const unexplained = [...read].filter((e) => !baseline.has(e)).sort();
    if (unexplained.length > 0) {
      return {
        act: "refuse",
        reason:
          `\`${caller}\`'s files name ${unexplained.join(", ")}, which ${label} baseline does ` +
          "not record, so that baseline does not describe the tree it was written from",
      };
    }
  }

  // An edge a side records that none of its OTHER files explains comes from `same`.
  const fromSame = new Set<string>();
  for (const e of primeSide) if (!ePrime.has(e) && !ePrimeRest.has(e)) fromSame.add(e);
  for (const e of cloneSide) if (!eClone.has(e) && !eCloneRest.has(e)) fromSame.add(e);
  const edges = new Set([...ePrime, ...eClone, ...eComposed, ...fromSame]);
  const unplaced = [...primeSide].filter((e) => cloneSide.has(e) && !edges.has(e)).sort();
  if (unplaced.length > 0) {
    return {
      act: "refuse",
      reason:
        `\`${caller}\` takes source files from both the prime and this clone, and both record ` +
        `${unplaced.join(", ")} from files the merged tree does not keep, so whether a kept ` +
        "file also names it cannot be told without reading every file",
    };
  }
  return { act: "edges", edges: [...edges].sort() };
}

/**
 * The merged graph, caller by caller, or a refusal naming the first caller
 * that cannot be attributed. See "Given both trees" in the header.
 *
 * Given `sources`, a mixed caller the sides disagree about is settled from the
 * files that make it mixed; any of their texts `sources` lacks are returned in
 * `needs`, for every such caller at once, so one round of reads answers all.
 */
export function attributeGraphByCaller(args: {
  primeGraph: readonly string[];
  cloneGraph: readonly string[];
  primeTree: ReadonlyMap<string, string>;
  cloneTree: ReadonlyMap<string, string>;
  /** Every path the clone holds once the pass lands. */
  mergedPaths: readonly string[];
  /** Walked source files this pass writes. */
  deliveredFiles: ReadonlySet<string>;
  /** Delivered paths whose content is neither side's. */
  rewritten: ReadonlySet<string>;
  sources?: CallerSources;
}): { ok: true; graph: string[] } | { ok: false; reason: string; needs?: CallerSourceNeeds } {
  const { primeTree, cloneTree, deliveredFiles, rewritten } = args;

  const filesBy = (paths: Iterable<string>) => {
    const by = new Map<string, Set<string>>();
    for (const path of paths) {
      if (!isWalkedSourceFile(path)) continue;
      const caller = fileCaller(path);
      const set = by.get(caller) ?? new Set<string>();
      set.add(path);
      by.set(caller, set);
    }
    return by;
  };
  const edgesBy = (graph: readonly string[]) => {
    const by = new Map<string, string[]>();
    for (const edge of graph) {
      const caller = edgeCaller(edge);
      by.set(caller, [...(by.get(caller) ?? []), edge]);
    }
    return by;
  };
  const primeFiles = filesBy(primeTree.keys());
  const cloneFiles = filesBy(cloneTree.keys());
  const mergedFiles = filesBy(args.mergedPaths);
  const primeEdges = edgesBy(args.primeGraph);
  const cloneEdges = edgesBy(args.cloneGraph);

  const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));
  const sameEdges = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
  const empty = new Set<string>();

  // Whose content a file in the merged tree carries. A delivered file is
  // prime's unless a pump composed it; an untouched one is the clone's. A
  // blob both sides hold identically is either side's.
  const carriesPrime = (path: string): boolean => {
    if (deliveredFiles.has(path)) return !rewritten.has(path);
    const onClone = cloneTree.get(path);
    return onClone !== undefined && onClone === primeTree.get(path);
  };
  const carriesClone = (path: string): boolean => {
    if (!deliveredFiles.has(path)) return true;
    if (rewritten.has(path)) return false;
    const onPrime = primeTree.get(path);
    return onPrime !== undefined && onPrime === cloneTree.get(path);
  };

  const callers = new Set<string>([
    ...primeFiles.keys(),
    ...cloneFiles.keys(),
    ...mergedFiles.keys(),
    ...primeEdges.keys(),
    ...cloneEdges.keys(),
  ]);
  const graph: string[] = [];
  const needs: CallerSourceNeeds = { prime: [], clone: [], merged: [] };
  let unread: string | null = null;
  for (const caller of [...callers].sort()) {
    const merged = mergedFiles.get(caller) ?? empty;
    const fromPrime = primeEdges.get(caller) ?? [];
    const fromClone = cloneEdges.get(caller) ?? [];
    if (sameSet(merged, primeFiles.get(caller) ?? empty) && [...merged].every(carriesPrime)) {
      graph.push(...fromPrime);
      continue;
    }
    if (sameSet(merged, cloneFiles.get(caller) ?? empty) && [...merged].every(carriesClone)) {
      graph.push(...fromClone);
      continue;
    }
    if (sameEdges(fromPrime, fromClone)) {
      graph.push(...fromPrime);
      continue;
    }
    const refusal =
      `\`${caller}\` takes source files from both the prime and this clone, and the ` +
      "inter-function call graph records it as one caller — so which side supplied each " +
      "file decides its edges and this pass cannot tell";
    if (!args.sources) return { ok: false, reason: refusal };
    const verdict = settleMixedCaller({
      caller,
      merged,
      primeFiles: primeFiles.get(caller) ?? empty,
      cloneFiles: cloneFiles.get(caller) ?? empty,
      primeEdges: fromPrime,
      cloneEdges: fromClone,
      primeTree,
      cloneTree,
      deliveredFiles,
      rewritten,
      sources: args.sources,
    });
    if (verdict.act === "refuse") return { ok: false, reason: verdict.reason };
    if (verdict.act === "read") {
      needs.prime.push(...verdict.needs.prime);
      needs.clone.push(...verdict.needs.clone);
      needs.merged.push(...verdict.needs.merged);
      unread ??= `${refusal}, and the texts of the files that would settle it were not read`;
      continue;
    }
    graph.push(...verdict.edges);
  }
  if (unread !== null) return { ok: false, reason: unread, needs };
  return { ok: true, graph };
}

/**
 * The regenerated baseline, or a named refusal.
 *
 * `mergedTreePaths` is every path the clone will hold AFTER this pass, and
 * `deliveredPaths` is the subset this pass writes — the two together are what
 * says which side supplied each file's content.
 */
export function reconcileSecurityInventory(args: {
  primeInventoryJson: string;
  cloneInventoryJson: string;
  mergedToml: string;
  mergedRegistryJson: string;
  mergedTreePaths: Iterable<string>;
  deliveredPaths: Iterable<string>;
  /**
   * Prime-only functions the merged tree does not hold. The edges they call
   * out of are removed from both graphs before the comparison, and from the
   * graph carried. Omitted or empty filters nothing.
   */
  withheld?: readonly string[];
  /**
   * Prime's and the clone's blob sha by path. Given both, the graph is
   * attributed caller by caller (see the header); omitted, it is carried
   * only where the two graphs are identical.
   */
  primeTree?: ReadonlyMap<string, string> | null;
  cloneTree?: ReadonlyMap<string, string> | null;
  /**
   * Delivered paths whose content is neither side's, because a pump
   * composed it. Such a file is never attributed to prime.
   */
  rewrittenPaths?: Iterable<string>;
  /**
   * The texts that settle a mixed caller the two graphs disagree about.
   * Omitted, such a caller refuses as it always has; given, any text it lacks
   * comes back in the refusal's `needs` for the caller to read and ask again.
   */
  sources?: CallerSources;
}): BaselineReconcile<string> {
  const primeParsed = parseJson(args.primeInventoryJson, "prime's security baseline");
  if (!primeParsed.ok) return primeParsed;
  const cloneParsed = parseJson(args.cloneInventoryJson, "this clone's security baseline");
  if (!cloneParsed.ok) return cloneParsed;
  const registryParsed = parseJson(args.mergedRegistryJson, "reconciled security registry");
  if (!registryParsed.ok) return registryParsed;

  const prime = primeParsed.value as Partial<SecurityInventory>;
  const clone = cloneParsed.value as Partial<SecurityInventory>;
  const registryRoot = registryParsed.value as { functions?: Record<string, RegistryEntry> };

  // `parseJson` has already refused a document that is not an object, so what
  // is left to ask is only whether this one carries the key.
  if (typeof registryRoot.functions !== "object" || registryRoot.functions === null) {
    return { ok: false, reason: "the reconciled security registry carries no `functions` object" };
  }
  for (const [label, inv] of [
    ["prime's", prime],
    ["this clone's", clone],
  ] as const) {
    if (
      typeof inv.schema_version !== "number" ||
      typeof inv.source !== "string" ||
      typeof inv.functions_importing_shared_auth_modules !== "object" ||
      inv.functions_importing_shared_auth_modules === null ||
      !Array.isArray(inv.statically_derivable_inter_function_graph)
    ) {
      return {
        ok: false,
        reason: `${label} security baseline is not the shape this generator emits`,
      };
    }
  }

  // The graph is attributed to a caller rather than to a file, so a merged
  // tree that takes one file from each side cannot be partitioned edge by
  // edge. See the header for what is carried, and where.
  const withheld = new Set(args.withheld ?? []);
  const callerHeld = (edge: string) => !withheld.has(edgeCaller(edge));
  const primeGraph = (prime.statically_derivable_inter_function_graph as string[]).filter(
    callerHeld,
  );
  const cloneGraph = (clone.statically_derivable_inter_function_graph as string[]).filter(
    callerHeld,
  );

  const mergedPaths = [...args.mergedTreePaths];
  const mergedFiles = new Set(
    mergedPaths.filter(isWalkedSourceFile).map((p) => p.slice(EDGE_FUNCTIONS_PREFIX.length)),
  );
  const deliveredFiles = new Set([...args.deliveredPaths].filter(isWalkedSourceFile));

  const sameGraph =
    primeGraph.length === cloneGraph.length &&
    [...primeGraph].sort().join("\u0000") === [...cloneGraph].sort().join("\u0000");
  let graph: string[];
  if (sameGraph) {
    graph = [...primeGraph];
  } else if (args.primeTree && args.cloneTree) {
    const attributed = attributeGraphByCaller({
      primeGraph,
      cloneGraph,
      primeTree: args.primeTree,
      cloneTree: args.cloneTree,
      mergedPaths,
      deliveredFiles,
      rewritten: new Set(args.rewrittenPaths ?? []),
      sources: args.sources,
    });
    if (!attributed.ok) return attributed;
    graph = attributed.graph;
  } else {
    return {
      ok: false,
      reason:
        "the prime's inter-function call graph and this clone's are not the same, and the graph " +
        "records a caller rather than a file — so which side supplied each source decides it and " +
        "this pass cannot tell",
    };
  }

  const counts = registryCounts(registryRoot.functions);
  const merged: SecurityInventory = {
    schema_version: prime.schema_version as number,
    source: prime.source as string,
    edge_function_count: functionDirsIn(mergedPaths).size,
    config_declared_function_count: configDeclaredFunctionNames(args.mergedToml).size,
    registry_function_count: counts.registry_function_count,
    verify_jwt_false_count: counts.verify_jwt_false_count,
    exposure_class_counts: counts.exposure_class_counts,
    needs_review_count: counts.needs_review_count,
    functions_importing_shared_auth_modules: partitionImports({
      prime: prime.functions_importing_shared_auth_modules as Record<string, string[]>,
      clone: clone.functions_importing_shared_auth_modules as Record<string, string[]>,
      mergedFiles,
      deliveredFiles,
    }),
    statically_derivable_inter_function_graph: graph.sort(),
  };

  // The generator's own serialisation, to the trailing newline: the check is
  // `git diff --exit-code`, so anything else is a red byte rather than a wrong
  // fact.
  return {
    ok: true,
    merged: `${JSON.stringify(merged, null, 2)}\n`,
    count: merged.config_declared_function_count,
  };
}

/**
 * The spec's counting rule, READ OUT OF THE SPEC THAT ENFORCES IT.
 *
 * Not transcribed. The spec counts with a regex whose exact shape decides the
 * number — unanchored, `[^[]*?` running through prose, which is what made a
 * comment countable once already — and a copy of it here would be a second
 * statement of one rule, which is how two statements come to disagree. Prime's
 * file is in hand on every pass, so the rule is taken from it and the standard
 * applied is the one the clone's own CI will apply.
 *
 * It refuses rather than guesses: exactly one `CONFIG.matchAll(` in the file,
 * a literal short enough to be a regex rather than a program, mentioning
 * `functions`, and compiling. A spec restructured past any of that answers
 * null and the caller holds, which is today's behaviour.
 */
export function extractRatchetRule(primeSpec: string): RegExp | null {
  const calls = [...primeSpec.matchAll(/CONFIG\.matchAll\(/g)];
  if (calls.length !== 1) return null;
  const match = primeSpec.match(/CONFIG\.matchAll\(\s*\/([\s\S]{1,200}?)\/([gimsuy]*)\s*\)/);
  if (!match) return null;
  const [, source, flags] = match;
  if (!source.includes("functions")) return null;
  try {
    return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

/** How many declarations that rule finds in a config. */
export function ratchetCount(toml: string, rule: RegExp): number {
  return [...toml.matchAll(new RegExp(rule.source, rule.flags))].length;
}

/** The assertion this rewrites, with the indentation of the line it sits on. */
const RATCHET_ASSERTION = /^([ \t]*)expect\(declared\.length\)\.toBe\((\d+)\);[ \t]*$/gm;

/**
 * The marker that opens a note this module wrote.
 *
 * Named once, because it is written by `ratchetNote` and recognised by
 * `stripPriorNote` — and a literal at each end is how two ends drift.
 */
const RECONCILED_MARKER = "// Reconciled by the cascade.";

/**
 * Drop a note a previous reconcile left, so the notes cannot stack.
 *
 * `before` is prime's file up to the assertion's own indentation, so it ends
 * on a newline. This walks back over the contiguous run of `//` lines above
 * that point and, if the run contains a marker this module wrote, drops from
 * the marker to the end of the run — leaving prime's own comment block above
 * it alone, because that is prime's history and true of the shared lineage.
 *
 * The engine hands this prime's file on every pass, so in the loop that
 * actually runs there is nothing to strip. That is exactly why it is here: a
 * function whose correctness rests on a caller never making an obvious mistake
 * will be called that way eventually, and a stacked note is silent — it
 * compiles, it passes, and it grows by four lines a pass for ever.
 */
function stripPriorNote(before: string): string {
  const lines = before.split("\n");
  const end = lines.length - 1;
  let start = end;
  while (start > 0 && lines[start - 1].trimStart().startsWith("//")) start -= 1;
  for (let i = start; i < end; i += 1) {
    if (lines[i].trimStart().startsWith(RECONCILED_MARKER)) {
      return [...lines.slice(0, i), ...lines.slice(end)].join("\n");
    }
  }
  return before;
}

/**
 * The lines written above the assertion, naming why the number is not prime's.
 *
 * `//` line comments only, and no `[functions.…]` token: the note goes into a
 * file whose own counting rule reads prose, and while that rule is pointed at
 * the CONFIG rather than at the spec, writing a countable token into either
 * one is the mistake this fleet has already made. `reconcileFunctionCountRatchet`
 * checks the composed result rather than trusting this template.
 *
 * Wrapped by width rather than one name a line, because the list is what
 * changes when a function is added and a per-name layout makes a one-function
 * change look like a rewrite in the diff.
 */
function ratchetNote(
  indent: string,
  owned: readonly string[],
  withheld: readonly string[],
  source?: string,
): string {
  const from = baselineSourceWords(source);
  const declares =
    owned.length > 0
      ? `declares ${owned.length} edge function(s) ${from.name} does not — ${owned.join(", ")} —`
      : "";
  const omits = withheld.length > 0 ? `does not declare ${withheldClause(withheld)},` : "";
  const difference = declares && omits ? `${declares} and ${omits}` : declares || omits;
  const sentence =
    `${RECONCILED_MARKER} This deployment ${difference} so ${from.possessive} number counts a ` +
    `different repository. The count below is this one's, taken from the config this same ` +
    `pass composed.`;

  const lines: string[] = [];
  let line = "";
  for (const word of sentence.split(" ")) {
    if (line === "") line = word;
    else if (`${indent}${line} ${word}`.length <= 88) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `${indent}${l.startsWith("//") ? l : `// ${l}`}\n`).join("");
}

/**
 * A row of a test table naming one function by itself: `'name',` on its own
 * line, which is how `it.each([...])` lists the functions a check applies to.
 */
const TABLE_ROW = /^[ \t]*(['"])([A-Za-z0-9_-]+)\1,?[ \t]*$/;

/**
 * Prime's spec with the table rows that name a function this clone does not
 * carry taken out.
 *
 * The spec asserts things ABOUT functions as well as counting them: F-02 lists
 * the operator backfills that must keep `verify_jwt = true`, and one of them
 * (`backfill-message-directions`) is a GoHighLevel function the independent
 * line withholds. Carried as prime wrote it, the check looks for a
 * `[functions.backfill-message-directions]` block the composed config
 * deliberately leaves out, and `verify` goes red on a function the clone is
 * right not to have. Measured on the cascade of prime@ff0f69c, 2 Oct 2026: the
 * count was reconciled to 370 and the row came back with it.
 *
 * Narrow on purpose. Only a row that is a bare quoted name on its own line,
 * inside a run of such rows opened by a line ending `[` and closed by a line
 * starting `]`, is touched. A name anywhere else is prose or a different kind
 * of assertion, which this cannot read and does not guess at. A table that
 * would be left with no rows refuses, because an empty `it.each` is a check
 * that silently stopped checking, and the caller then holds as before.
 */
export function dropWithheldTableRows(
  spec: string,
  withheld: readonly string[],
): { ok: true; text: string; dropped: string[] } | { ok: false; reason: string } {
  const names = new Set(withheld);
  if (names.size === 0) return { ok: true, text: spec, dropped: [] };
  const lines = spec.split("\n");
  const keep: string[] = [];
  const dropped: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const opens = i > 0 && lines[i - 1].trimEnd().endsWith("[") && TABLE_ROW.test(lines[i]);
    if (!opens) {
      keep.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && TABLE_ROW.test(lines[end])) end += 1;
    const closes = end < lines.length && lines[end].trimStart().startsWith("]");
    const run = lines.slice(i, end);
    if (!closes) {
      keep.push(...run);
      i = end;
      continue;
    }
    const survivors = run.filter((line) => !names.has((line.match(TABLE_ROW) ?? [])[2] ?? ""));
    if (survivors.length === 0) {
      return {
        ok: false,
        reason:
          "every row of a table in the prime's ratchet spec names a function this clone does " +
          "not carry, and an emptied table is a check that stopped checking",
      };
    }
    for (const line of run) {
      const name = (line.match(TABLE_ROW) ?? [])[2];
      if (name && names.has(name)) dropped.push(name);
    }
    keep.push(...survivors);
    i = end;
  }
  return { ok: true, text: keep.join("\n"), dropped };
}

/**
 * Prime's ratchet spec, carrying the count this repository actually declares.
 *
 * One number changes and everything else is prime's, which is the whole point
 * of reconciling rather than holding: the two copies differ by that integer
 * across 245 lines, and holding freezes 244 lines of shared assertions to
 * protect one of them.
 *
 * Where the clone declares nothing the prime does not and holds every function
 * the prime keeps for itself, the note is omitted and the count is prime's
 * own — so the result is prime's file byte for byte, and
 * "carry it unchanged" falls out of the general rule rather than being a
 * special case someone has to remember.
 */
export function reconcileFunctionCountRatchet(args: {
  primeSpec: string;
  mergedToml: string;
  cloneOwnedFunctions: readonly string[];
  /**
   * Functions this clone does not hold: named in the note, and taken out of
   * the spec's tables (`dropWithheldTableRows`).
   */
  withheld?: readonly string[];
  /**
   * The engine's `sourceLabel`: the repository `primeSpec` came from. The
   * note names it, because a clone routed by lineage receives its parent's
   * spec and a note naming the prime would be about a file the prime never
   * wrote. Left out, the note reads as it always has.
   */
  source?: string;
}): BaselineReconcile<string> {
  const withheld = [...new Set(args.withheld ?? [])].sort();
  const pruned = dropWithheldTableRows(args.primeSpec, withheld);
  if (!pruned.ok) return pruned;
  const primeSpec = pruned.text;

  const rule = extractRatchetRule(primeSpec);
  if (!rule) {
    return {
      ok: false,
      reason:
        "the prime's ratchet spec no longer states its counting rule as a single regular " +
        "expression literal over the config, so this pass cannot apply the clone's own standard",
    };
  }

  const assertions = [...primeSpec.matchAll(RATCHET_ASSERTION)];
  if (assertions.length !== 1) {
    return {
      ok: false,
      reason:
        `the prime's ratchet spec states ${assertions.length} declaration-count assertions on ` +
        "lines of their own, and this pass rewrites exactly one",
    };
  }

  const [assertion] = assertions;
  const indent = assertion[1];
  const count = ratchetCount(args.mergedToml, rule);
  const owned = [...new Set(args.cloneOwnedFunctions)].sort();

  const note =
    owned.length > 0 || withheld.length > 0
      ? ratchetNote(indent, owned, withheld, args.source)
      : "";
  const merged =
    stripPriorNote(primeSpec.slice(0, assertion.index)) +
    note +
    `${indent}expect(declared.length).toBe(${count});` +
    primeSpec.slice((assertion.index ?? 0) + assertion[0].length);

  // Asserted on the COMPOSED file, not about the template. The splice has to
  // have landed where it meant to and disturbed nothing else, so: the rule is
  // still extractable and unchanged, there is still exactly one assertion, and
  // it carries the new number.
  const composedRule = extractRatchetRule(merged);
  if (!composedRule || composedRule.source !== rule.source || composedRule.flags !== rule.flags) {
    return { ok: false, reason: "reconciling the ratchet spec disturbed its own counting rule" };
  }
  const composed = [...merged.matchAll(RATCHET_ASSERTION)];
  if (composed.length !== 1 || Number(composed[0][2]) !== count) {
    return {
      ok: false,
      reason:
        "the reconciled ratchet spec does not state the count this pass computed, exactly once",
    };
  }

  return { ok: true, merged, count };
}
