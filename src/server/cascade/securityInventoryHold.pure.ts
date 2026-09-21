/**
 * `docs/security/SECURITY_INVENTORY.json` is a repository invariant, and on
 * one kind of clone it must not be written anyway.
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
 */

import type { HeldPath } from "./syncExclusions.pure";

/** The one path this module has an opinion about. */
export const SECURITY_INVENTORY_PATH = "docs/security/SECURITY_INVENTORY.json";

/**
 * Whether prime's baseline may be written over this clone's.
 *
 * `cloneOwnedFunctions` is what the config.toml and registry reconciles
 * carried forward — the names the clone declares and prime has no opinion
 * about. Empty means a mirror, and a mirror takes prime's baseline as it
 * always has.
 */
export function securityInventoryHold(cloneOwnedFunctions: readonly string[]): HeldPath | null {
  const owned = [...new Set(cloneOwnedFunctions)].sort();
  if (owned.length === 0) return null;
  return {
    path: SECURITY_INVENTORY_PATH,
    pattern: "(content: describes a different function set)",
    reason: "manual_reconcile",
    note:
      `This clone owns ${owned.length} edge function(s) the prime does not (${owned.join(", ")}), ` +
      `so the prime's security baseline is a static analysis of a different repository. The ` +
      `clone's own copy is kept. Where it later goes stale, \`npm run security:inventory\` ` +
      `regenerates it from this repository.`,
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
