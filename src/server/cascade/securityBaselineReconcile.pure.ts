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
 * It is therefore carried only where prime's graph and the clone's are
 * IDENTICAL, which is the one case where the answer cannot depend on the
 * split. Measured 21 Sep 2026 against `npc-crm-independent`: 69 edges each,
 * no edge in one and not the other, while the imports differ by exactly two
 * pairs and both are for functions only the clone has. Where they differ at
 * all this refuses and the caller holds, which is today's behaviour exactly.
 *
 * Nothing here guesses. Every refusal is named, and a named refusal costs a
 * pass the same red check it already had.
 */

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

/** A refusal carries its reason, because the caller renders it to a person. */
export type BaselineReconcile<T> =
  | { ok: true; merged: T; count: number }
  | { ok: false; reason: string };

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

function parseJson(
  text: string,
  what: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: `the ${what} is not readable as JSON` };
  }
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

  if (
    !registryRoot ||
    typeof registryRoot.functions !== "object" ||
    registryRoot.functions === null
  ) {
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
  // tree that takes one file from each side cannot be partitioned. Carried
  // only where the split cannot matter — see the header.
  const primeGraph = prime.statically_derivable_inter_function_graph as string[];
  const cloneGraph = clone.statically_derivable_inter_function_graph as string[];
  const sameGraph =
    primeGraph.length === cloneGraph.length &&
    [...primeGraph].sort().join("\u0000") === [...cloneGraph].sort().join("\u0000");
  if (!sameGraph) {
    return {
      ok: false,
      reason:
        "the prime's inter-function call graph and this clone's are not the same, and the graph " +
        "records a caller rather than a file — so which side supplied each source decides it and " +
        "this pass cannot tell",
    };
  }

  const mergedPaths = [...args.mergedTreePaths];
  const mergedFiles = new Set(
    mergedPaths.filter(isWalkedSourceFile).map((p) => p.slice(EDGE_FUNCTIONS_PREFIX.length)),
  );
  const deliveredFiles = new Set([...args.deliveredPaths].filter(isWalkedSourceFile));

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
    statically_derivable_inter_function_graph: [...primeGraph].sort(),
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
function ratchetNote(indent: string, owned: readonly string[]): string {
  const sentence =
    `${RECONCILED_MARKER} This deployment declares ${owned.length} edge function(s) the ` +
    `prime does not — ${owned.join(", ")} — so the prime's number counts a different ` +
    `repository. The count below is this one's, taken from the config this same pass composed.`;

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
 * Prime's ratchet spec, carrying the count this repository actually declares.
 *
 * One number changes and everything else is prime's, which is the whole point
 * of reconciling rather than holding: the two copies differ by that integer
 * across 245 lines, and holding freezes 244 lines of shared assertions to
 * protect one of them.
 *
 * Where the clone declares nothing the prime does not, the note is omitted and
 * the count is prime's own — so the result is prime's file byte for byte, and
 * "carry it unchanged" falls out of the general rule rather than being a
 * special case someone has to remember.
 */
export function reconcileFunctionCountRatchet(args: {
  primeSpec: string;
  mergedToml: string;
  cloneOwnedFunctions: readonly string[];
}): BaselineReconcile<string> {
  const rule = extractRatchetRule(args.primeSpec);
  if (!rule) {
    return {
      ok: false,
      reason:
        "the prime's ratchet spec no longer states its counting rule as a single regular " +
        "expression literal over the config, so this pass cannot apply the clone's own standard",
    };
  }

  const assertions = [...args.primeSpec.matchAll(RATCHET_ASSERTION)];
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

  const note = owned.length > 0 ? ratchetNote(indent, owned) : "";
  const merged =
    stripPriorNote(args.primeSpec.slice(0, assertion.index)) +
    note +
    `${indent}expect(declared.length).toBe(${count});` +
    args.primeSpec.slice((assertion.index ?? 0) + assertion[0].length);

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
