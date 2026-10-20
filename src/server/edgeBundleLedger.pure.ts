/**
 * What Mission Control itself put on a clone's project, bundle by bundle —
 * and when a copy on the clone is provably the one it put there.
 *
 * ## Why a ledger, when the lane already asks the target
 *
 * The deploy lane reads progress off the TARGET, never off a diary of its own
 * (`refreshedSince`): a pass that deployed sixty bundles and then lost its
 * invocation still counts, because the clone holds them. That rule stays. What
 * the target cannot say is WHICH TREE a copy came from, so "delivered" could
 * only mean "deployed since this generation began", and every prime merge
 * began a new generation that owed every bundle again. The lane could never
 * finish, and every clone's run parked on 12–13 Oct 2026 (F23).
 *
 * The ledger is the missing half, kept beside the target rather than instead
 * of it: for each slug, the digest of the bundle this lane deployed
 * (`functionBundleDigest.pure.ts`) and WHICH DEPLOY that was — the function's
 * id and the version the project answered the deploy call with.
 *
 * ## The rule
 *
 * **A clone's copy is current only where BOTH halves agree.** The ledger's
 * digest equals the digest the prime's tree gives that bundle now, AND the
 * clone still lists the very copy the ledger recorded: the same function id
 * at the same version. The first says the bundle has not changed since this
 * lane deployed it; the second says nothing has been written over that deploy
 * since. Every deploy of a function increments its version, so a copy
 * replaced by anything else — the clone's own CI, a publish, a person — is a
 * later version, and is owed again however soon after this lane's it landed.
 *
 * Every doubt resolves to OWED. No ledger row, a digest the tree cannot give,
 * a clone that does not list the function, a copy that is not ACTIVE, an id or
 * version that either side failed to report: each redeploys. A redeploy costs
 * one call; a bundle wrongly believed current is a tenant running code nobody
 * can see is stale.
 *
 * ## Why the version and not the clock
 *
 * The first draft of this module compared the clone's `updated_at` with the
 * window the deploy call ran in, allowing five minutes for the two clocks.
 * That window is exactly where a second writer is most likely: a cascade
 * merging into a clone starts the clone's own function deploy for the same
 * slugs the catch-up asks this lane to deploy, minutes apart. The version is
 * the project's own count of writes, so it has no window at all. Both fields
 * are in the deploy call's documented answer (`DeployFunctionResponse`: `id`,
 * `version`, required) and in every row of the function list, measured.
 */
import type { ProjectFunctionCopy } from "./projectFunctionCopies.pure";

/** One bundle this lane deployed. */
export type LedgerEntry = {
  /** `bundleDigest` of what was sent. */
  readonly digest: string;
  /** The function id the deploy call answered with, or null where it did not. */
  readonly functionId: string | null;
  /** The version the deploy call answered with, or null where it did not. */
  readonly functionVersion: number | null;
};

/** Whether the clone's copy of one bundle is the very deploy this entry records. */
export function isLedgeredCopy(entry: LedgerEntry, copy: ProjectFunctionCopy | undefined): boolean {
  if (!copy || !copy.active) return false;
  if (entry.functionId === null || entry.functionVersion === null) return false;
  if (copy.id === null || copy.version === null) return false;
  return copy.id === entry.functionId && copy.version === entry.functionVersion;
}

/**
 * The slugs whose copy on the clone is provably the prime's bundle AT THE
 * COMMIT THESE DIGESTS WERE TAKEN FROM. Sorted.
 *
 * Only slugs the tree gives a digest for can be current: a function the prime
 * no longer defines is nothing this lane owes or vouches for.
 */
export function ledgerCurrentSlugs(input: {
  readonly ledger: ReadonlyMap<string, LedgerEntry>;
  /** The prime's bundle digests at the commit this pass deploys from. */
  readonly digests: ReadonlyMap<string, string>;
  /** What the clone's project lists, from the pass's one reading of it. */
  readonly copies: ReadonlyMap<string, ProjectFunctionCopy>;
}): string[] {
  const out: string[] = [];
  for (const [slug, digest] of input.digests) {
    const entry = input.ledger.get(slug);
    if (!entry || entry.digest !== digest) continue;
    if (!isLedgeredCopy(entry, input.copies.get(slug))) continue;
    out.push(slug);
  }
  return out.sort();
}
