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
