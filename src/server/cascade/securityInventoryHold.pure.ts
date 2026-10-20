/**
 * TWO FILES STATE THIS REPOSITORY'S OWN EDGE-FUNCTION SET, and on one kind of
 * clone neither may be written from the prime's copy.
 *
 * `docs/security/SECURITY_INVENTORY.json` is a repository invariant, and
 * `src/lib/security/auditRemediation.spec.ts` asserts how many functions
 * `config.toml` declares. They are the same species — a static count of the
 * repository they sit in — and the second was missed when the first was
 * guarded, which is how a person's restoration came to be reverted by the
 * very next pass. The reasoning below is written about the baseline and holds
 * for both; `functionCountRatchetHold` is the sibling it earned.
 *
 * ## Why it travels at all
 *
 * `REPOSITORY_INVARIANTS` carries it for a reason that is correct and stays:
 * `security:inventory` regenerates the file from the edge functions and CI
 * `git diff --exit-code`s the result, so a clone that receives a new function
 * without the matching baseline goes red on a file the cascade itself wrote.
 *
 * ## Why that reasoning has an edge
 *
 * It holds while prime's function set is a SUPERSET of the clone's. Where the
 * clone owns functions prime has never had, prime's baseline cannot describe
 * the clone's repository — it is a static analysis of a different tree — and
 * writing it guarantees the diff it was carried across to prevent.
 *
 * Measured on the open cascade proposal for `npc-crm-independent`, 20 Sep
 * 2026: prime's baseline counts 413 functions, the clone's repository holds
 * 416, and the clone's own generator reproduces the clone's own committed
 * baseline BYTE FOR BYTE once the declarations and the registry are
 * reconciled. So the correct file was already in place and the cascade was
 * about to overwrite it with a wrong one.
 *
 * ## Why this is a hold and not an exclusion
 *
 * An exclusion would be the same mistake pointing the other way: prime adds a
 * function, the cascade delivers it, the baseline never travels, and the
 * clone's `security` job goes red with nothing saying why. The hold is
 * conditional on the clone actually owning something prime does not, so a
 * mirror keeps today's behaviour exactly, and the note names the one command
 * that settles it.
 *
 * ## The evidence is the TREE, not the declarations
 *
 * This hold shipped reading `carriedForward` from the config.toml and registry
 * reconciles — the names the clone DECLARES and prime has no opinion about —
 * and on the one clone it was written for it never fired. Measured on
 * `npc-crm-independent`, 21 Sep 2026: the clone holds three function
 * directories prime does not (`crm-calendar`, `crm-inbound-message`,
 * `crm-send-message`) and declares NONE of them, in either file. So both
 * reconciles carried nothing forward, `cloneOwnedFunctions` was empty, prime's
 * baseline was written over the clone's, and its `security` job went red on a
 * file the cascade itself had just written.
 *
 * The two questions are not the same question, and the generator settles which
 * one matters. `scripts/security/security-inventory.mjs` enumerates:
 *
 *     readdirSync(functionsDir).filter((name) => name !== '_shared' && …isDirectory())
 *
 * — every DIRECTORY under `supabase/functions/`, whatever config.toml or the
 * registry say about it. A clone can own a function it never declared, and
 * this one owns three. `cloneOnlyEdgeFunctions` therefore asks the generator's
 * own question of the two trees the engine has already listed, and the
 * declarations stay as the fallback for the case where a tree could not be
 * read at all — because a read that FAILED is not a set that is EMPTY, and
 * falling back to today's behaviour is the one answer that cannot be newly
 * wrong.
 *
 * ## A clone can differ from the prime by holding LESS, too
 *
 * The prime keeps features no clone receives (`primeOnlyFeatures.pure.ts`) —
 * the GoHighLevel account migration's twenty-eight functions, the owner's
 * decision of 27 Sep 2026. A clone that does not hold them is the mirror of
 * the case above: prime's baseline counts twenty-eight directories and three
 * call edges the clone's tree does not have, and prime's ratchet counts
 * twenty-eight declarations its merged config no longer carries. So the same
 * two holds fire on `withheld` — the prime-only functions the clone's tree
 * does not hold — and the same reconciles settle them. A clone still holding
 * the feature passes nothing and keeps today's behaviour exactly.
 *
 * ## "Withheld" is measured against the SOURCE, not the prime
 *
 * A clone routed by lineage copies its PARENT's tree, and the baseline that
 * travels is the parent's. Read off the child's tree alone, `withheld` named
 * the twenty-eight prime-only functions however the parent stood. So on
 * 20 Oct 2026 NPC Test #228 and Preflight #227, children of
 * npc-client-dashboard, each kept its own baseline while the pass delivered
 * 1,042 and 1,109 files of the tree that baseline analyses, and both went red
 * on `security` (F22 in the 19 Oct hand-over). The parent lacks the same
 * twenty-eight, and its committed baseline is what the generator writes on
 * each child's head, byte for byte: there was no difference to hold for.
 *
 * So the holds ask `withheldBySource`: which of those functions the tree this
 * pass copies FROM actually holds. From the prime that is every one of them,
 * and nothing changes. From a parent that withholds the same functions it is
 * none, and the child takes its parent's baseline as a mirror takes the
 * prime's. Removing DECLARATIONS still uses the clone's own reading, because
 * a clone must never declare a function its tree does not hold, whoever it
 * copies from.
 */

import { withheldClause } from "../crmLineFeatures.pure";
import type { HeldPath } from "./syncExclusions.pure";

/** The generated baseline: a static analysis of one repository's edge functions. */
export const SECURITY_INVENTORY_PATH = "docs/security/SECURITY_INVENTORY.json";

/**
 * The spec that asserts how many functions `config.toml` declares.
 *
 * The same species as the baseline above, found the same way and missed for
 * the same reason. Measured on `npc-crm-independent`, 21 Sep 2026: prime's
 * copy and this clone's differ by ONE INTEGER across 245 lines —
 * `expect(declared.length).toBe(413)` against `toBe(416)` — and the cascade
 * lists the file as `modified`, so every pass replaces a count of THIS
 * repository's functions with a count of prime's.
 *
 * That is what the restoration in PR #15 was undone by once already, under a
 * commit named "The cascade brought what asserts and left behind what is
 * asserted". `securityInventoryHold` guards one of the two files that state
 * this clone's own function set; this guards the other.
 */
export const FUNCTION_COUNT_RATCHET_PATH = "src/lib/security/auditRemediation.spec.ts";

/**
 * How a note names the tree the baseline travels FROM.
 *
 * "The label travels with the bytes" (`cloneCascadeSource.pure.ts`): a clone
 * routed by lineage receives its PARENT's tree, so its baseline is the
 * parent's, and a note that names the prime over a file the prime never wrote
 * sends an operator to the wrong repository. `source` is the engine's own
 * `sourceLabel`. Left out, or the engine's `"prime"`, every note reads exactly
 * as it always has: an operator has read these sentences on every CRM pass.
 */
export function baselineSourceWords(source?: string): {
  /** "the prime", or the parent's label. */
  readonly name: string;
  /** "the prime's", or the label's. */
  readonly possessive: string;
  /** The possessive where it opens a sentence. */
  readonly possessiveOpening: string;
} {
  const label = source?.trim() ?? "";
  if (label === "" || label === "prime") {
    return { name: "the prime", possessive: "the prime's", possessiveOpening: "The prime's" };
  }
  return { name: label, possessive: `${label}'s`, possessiveOpening: `${label}'s` };
}

/**
 * How this clone's function set differs from the prime's, as one clause.
 *
 * Written once — for both holds and for the pull request body — so the three
 * cannot describe the same difference in three ways. The owned-only wording is
 * exactly what the holds said before the withheld half existed, because an
 * operator has read it on every CRM pass. Both lists are de-duplicated and
 * sorted here, so a caller cannot make the sentence depend on its order.
 */
export function describeFunctionSetDifference(
  cloneOwnedFunctions: readonly string[],
  withheld: readonly string[],
  source?: string,
): string {
  const owned = [...new Set(cloneOwnedFunctions)].sort();
  const lacks = [...new Set(withheld)].sort();
  const from = baselineSourceWords(source);
  const owns = `owns ${owned.length} edge function(s) ${from.name} does not (${owned.join(", ")})`;
  const without = `does not carry ${withheldClause(lacks)}`;
  if (lacks.length === 0) return owns;
  if (owned.length === 0) return without;
  return `${owns} and ${without}`;
}

/**
 * Whether prime's baseline may be written over this clone's.
 *
 * `cloneOwnedFunctions` is what the config.toml and registry reconciles
 * carried forward — the names the clone declares and prime has no opinion
 * about. `withheld` is the prime-only functions this clone's tree does not
 * hold. Both empty means a mirror, and a mirror takes prime's baseline as it
 * always has.
 */
export function securityInventoryHold(
  cloneOwnedFunctions: readonly string[],
  withheld: readonly string[] = [],
  source?: string,
): HeldPath | null {
  const owned = [...new Set(cloneOwnedFunctions)].sort();
  const lacks = [...new Set(withheld)].sort();
  if (owned.length === 0 && lacks.length === 0) return null;
  const from = baselineSourceWords(source);
  return {
    path: SECURITY_INVENTORY_PATH,
    pattern: "(content: describes a different function set)",
    reason: "manual_reconcile",
    note:
      `This clone ${describeFunctionSetDifference(owned, lacks, source)}, ` +
      `so ${from.possessive} security baseline is a static analysis of a different repository. The ` +
      `clone's own copy is kept. Where it later goes stale, \`npm run security:inventory\` ` +
      `regenerates it from this repository.`,
  };
}

/**
 * Whether prime's function-count ratchet may be written over this clone's.
 *
 * The same evidence, deliberately: a clone owning functions prime has never
 * had declares more of them, so prime's number is a statement about a
 * different repository. A mirror carries nothing forward and keeps today's
 * behaviour exactly, which is what makes this safe to add to every edge at
 * once.
 *
 * ## What this does NOT do, stated because it would otherwise be assumed
 *
 * It does not make the proposal green. The count the spec asserts has to
 * match what the MERGED `config.toml` declares, and the merge adds prime's
 * new declarations to this clone's own — so holding leaves the clone's 416
 * against a merged 417 and `verify` stays red, one apart instead of four.
 * What it buys is that the number still describes this repository and a
 * person's correction is not silently reverted; `reconcileFunctionCountRatchet`
 * is what closes the remaining gap.
 */
export function functionCountRatchetHold(
  cloneOwnedFunctions: readonly string[],
  withheld: readonly string[] = [],
  source?: string,
): HeldPath | null {
  const owned = [...new Set(cloneOwnedFunctions)].sort();
  const lacks = [...new Set(withheld)].sort();
  if (owned.length === 0 && lacks.length === 0) return null;
  const from = baselineSourceWords(source);
  const declares = `declares ${owned.length} ${from.name} does not (${owned.join(", ")})`;
  const omits = `omits the declarations of ${withheldClause(lacks)}`;
  const difference =
    lacks.length === 0 ? declares : owned.length === 0 ? omits : `${declares} and ${omits}`;
  return {
    path: FUNCTION_COUNT_RATCHET_PATH,
    pattern: "(content: a count of this repository's own functions)",
    reason: "manual_reconcile",
    note:
      `This spec asserts how many functions \`supabase/config.toml\` declares, and this clone ` +
      `${difference}. ${from.possessiveOpening} copy ` +
      `states ${from.possessive} count, so it is not brought across — the two differ by that one ` +
      `number and nothing else. Where the merged config later declares more, the assertion ` +
      `is the number to update.`,
  };
}

/** Everything under here is an edge function or the shared library. */
export const EDGE_FUNCTIONS_PREFIX = "supabase/functions/";

/** The one directory under it that is not a function. */
export const SHARED_DIRECTORY = "_shared";

/**
 * The edge functions a set of repository paths holds.
 *
 * Deliberately the generator's own rule — a DIRECTORY under
 * `supabase/functions/` that is not `_shared` — rather than "a directory with
 * an `index.ts`", because the generator counts directories and the count is
 * what its `git diff --exit-code` compares. A rule that is merely reasonable
 * here reproduces the defect it is meant to close.
 *
 * A file sitting directly under `supabase/functions/` (a `deno.json`, a
 * README) has no directory segment and is not a function.
 */
export function edgeFunctionNames(paths: Iterable<string>): Set<string> {
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
 * The functions this clone holds and prime does not, read off the two trees.
 *
 * `null` where either tree is unavailable — a truncated listing, or a scope
 * that never read one. That is NOT an empty set: an empty set says "this is a
 * mirror, let the baseline travel", and saying that because nothing could be
 * measured is how a silent wrong answer gets written to a clone. The caller
 * keeps the declaration-derived evidence in that case, which is exactly what
 * every cascade before this one used.
 */
export function cloneOnlyEdgeFunctions(args: {
  primePaths: Iterable<string> | null | undefined;
  clonePaths: Iterable<string> | null | undefined;
}): string[] | null {
  if (!args.primePaths || !args.clonePaths) return null;
  const prime = edgeFunctionNames(args.primePaths);
  const clone = edgeFunctionNames(args.clonePaths);
  return [...clone].filter((name) => !prime.has(name)).sort();
}

/**
 * The withheld functions this delivery's SOURCE actually holds.
 *
 * `withheld` is read off the clone's tree: the functions a register says the
 * clone does not carry, which its tree indeed lacks. The two baselines need a
 * narrower question, because the baseline that travels is the SOURCE's: a
 * function the source lacks too is not a difference between the two trees,
 * and holding for it holds a baseline that already describes this clone.
 *
 * `null` source paths — a truncated listing, or a scope that never read the
 * source — answer `withheld` unchanged. That is today's behaviour, and the one
 * answer that cannot be newly wrong: an unread source is not a source that
 * lacks everything.
 */
export function withheldBySource(args: {
  readonly withheld: readonly string[];
  readonly sourcePaths: Iterable<string> | null | undefined;
}): string[] {
  const withheld = [...new Set(args.withheld)].sort();
  if (!args.sourcePaths) return withheld;
  const source = edgeFunctionNames(args.sourcePaths);
  return withheld.filter((name) => source.has(name));
}
