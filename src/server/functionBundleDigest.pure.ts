/**
 * What a deployed function bundle IS, as one value.
 *
 * ## Why the deploy lane needs this
 *
 * The lane decided "already delivered" from the clone's own timestamps alone:
 * a copy newer than the run's generation was delivered, anything older was
 * owed. A timestamp says a copy landed, never what it holds, so the moment the
 * prime moved the lane could no longer tell a bundle that changed from one
 * that did not. It answered by restarting the generation and owing every
 * bundle again (`planDeployGeneration`), on every prime merge.
 *
 * Measured 20 Oct 2026 over the prime's 340 first-parent commits since 12 Oct
 * (`scripts/edge-deploy/measure-bundle-churn.ts`, which runs this module): 71
 * changed no function bundle at all and 228 changed one to five. Re-owing what
 * each actually changed costs 1,383 bundle deploys over the window; re-owing
 * every bundle on every commit costs 135,763. The lane lands about one bundle a
 * pass, so the second number is not a slow deployment but one that never
 * completes: every clone's run parked between 12 and 13 Oct and no clone has
 * received a function since (F23 in the 19 Oct hand-over).
 *
 * ## What the digest covers, and why exactly that
 *
 * Exactly what `deployEdgeFunction` sends: the slug, the entrypoint, the
 * import map, the `verify_jwt` flag, and every file the bundle carries AFTER
 * pruning, each by its git blob id. Two revisions whose digests agree send the
 * Management API byte-identical requests, so redeploying is pointless; two
 * that differ in anything sent differ here.
 *
 * The flag is the one SENT, which is not always the prime's: a webhook-style
 * slug is deployed anonymous on every clone (`anonymousFunctionSlugs.pure.ts`).
 * Digested from the prime's flag, a change to that rule would leave every
 * digest standing and the ledger vouching for copies deployed under the old
 * answer — so the caller passes `deployedVerifyJwt(...).verifyJwt`.
 *
 * Pruned, not whole. Every bundle includes the whole `_shared` tree by
 * convention, so a digest over the unpruned bundle changes for every function
 * whenever any shared file changes — which is most commits, and is the
 * restart this exists to stop. The pruned set is what is deployed
 * (`functionBundlePrune.pure.ts`), and a bundle that declines to prune carries
 * the whole tree and is digested whole, which is the safe direction: any
 * shared change then re-owes it.
 *
 * The order of the files is not part of it. The entrypoint is named in the
 * deploy's metadata, so the order is not what decides what runs, and an
 * unrelated file appearing earlier in the tree must not re-owe a bundle.
 *
 * Pure: no I/O. Hashing is computation, not a read.
 */

import { createHash } from "node:crypto";

/** Bumped whenever what the digest covers changes, so old ledgers stop matching. */
export const BUNDLE_DIGEST_VERSION = "bundle-digest/1";

export type BundleDigestInput = {
  readonly slug: string;
  readonly entrypointPath: string;
  readonly importMapPath: string | null;
  /** The flag the deploy SENDS (`deployedVerifyJwt`), not the prime's. */
  readonly verifyJwt: boolean;
  /** Every file the deploy sends, with its git blob id. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha: string }>;
};

/** One bundle's digest, as 40 lowercase hex digits. */
export function bundleDigest(input: BundleDigestInput): string {
  const files = input.files
    .map((f) => [f.path, f.sha] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = JSON.stringify([
    BUNDLE_DIGEST_VERSION,
    input.slug,
    input.entrypointPath,
    input.importMapPath,
    input.verifyJwt,
    files,
  ]);
  return createHash("sha1").update(canonical, "utf8").digest("hex");
}

/**
 * The slugs whose digest differs between two readings — added, removed or
 * changed. Sorted, so a caller can record it and a test can compare it.
 */
export function changedBundles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const [slug, digest] of after) if (before.get(slug) !== digest) out.add(slug);
  for (const slug of before.keys()) if (!after.has(slug)) out.add(slug);
  return [...out].sort();
}
