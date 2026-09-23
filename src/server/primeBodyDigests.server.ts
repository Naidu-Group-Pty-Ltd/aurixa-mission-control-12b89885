import { createHash } from "node:crypto";
import { migrationBodyForms } from "./migrationBodyIdentity.pure";
import {
  dependencyFactsOf,
  type MigrationDependencyFacts,
} from "./migrationDependencyFacts.pure";
import { mentionedVersionsOf } from "./migrationVersionMentions.pure";
import { fetchBlobTextsBatched, decodeBase64Utf8 } from "./prime-backend.server";
import type { RepoRef } from "./github-app.server";
import type { Octokit } from "@octokit/rest";
import type { PrimeMigrationCorpus } from "./prime-backend.server";

/**
 * Digests of the prime corpus's migration bodies, so `scopeCorpusToPrime` can
 * ask whether the prime has run these BYTES rather than this version string.
 *
 * ## What this costs, measured
 *
 * The corpus is 536 MB and that number is not the cost. 531 MB of it is 14
 * files — successive generations of `seed_template_library` — and every one
 * of them is already cleared by its version, so none needs a body read to be
 * runnable. Measured 22 Sep 2026: **986 of 1,002 files are under 256 KB and
 * come to 4.17 MB in total**, and all 16 over that ceiling are version-matched.
 *
 * So the ceiling costs nothing today and bounds the pass for ever: a future
 * 40 MB seed nobody has stamped is withheld exactly as it is now, and says
 * `body_unread` rather than being silently fetched.
 *
 * ## Why it is keyed on the commit
 *
 * A migration's bytes at a given commit never change — that is what a commit
 * is — so the cache has no staleness to manage and no TTL to pick. It is
 * dropped whole when the prime's head moves. A tick that finds the cache warm
 * costs nothing at all, which is what a five-minute cadence has to cost.
 *
 * ## A failure here is never a wider corpus
 *
 * Every read is best-effort and a file whose body could not be fetched gets
 * an EMPTY digest list, which `scopeCorpusToPrime` reads as `body_unread` and
 * withholds. There is no path through this module that makes a migration
 * runnable it could not read, and no path that makes the whole pass fail: a
 * GitHub outage degrades the fleet sync to exactly the behaviour it had
 * before bodies were read, which is the version match alone.
 */

/**
 * Bodies past this are not read for a digest.
 *
 * 256 KB rather than `MAX_MIGRATION_BYTES` (8 MB): this pass touches ~986
 * files at once where `loadSql` touches the handful actually being sent, and
 * an accidental 8 MB × 900 would be a different program. Measured against the
 * real corpus the two ceilings withhold the same set — nothing.
 */
export const MAX_DIGEST_BYTES = 256 * 1024;

/** How many bodies one call will read. A guard on the unforeseen, not a budget. */
export const MAX_DIGEST_FILES = 1500;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digests of every form of one body, most literal first. */
export function bodyDigests(sql: string): string[] {
  return migrationBodyForms(sql).map(sha256Hex);
}

type CacheEntry = {
  sourceSha: string;
  digests: Map<string, string[]>;
  /**
   * Only for bodies actually decoded. A path ABSENT here is a body nobody
   * read, which is a different fact from a body that names nothing — and the
   * one the barrier must not narrow on.
   */
  facts: Map<string, MigrationDependencyFacts>;
  /** The versions each decoded body names. Same keys as {@link facts}, same rule. */
  mentions: Map<string, string[]>;
};
let cache: CacheEntry | null = null;

// No reset hook. The cache is keyed on the commit and a different commit
// replaces it whole, so there is no staleness for anything to clear — and an
// exported function with nothing to do is what `serverExportsHaveCallers`
// exists to catch. A test that wants a cold cache hands it a different
// `sourceSha`, which is what production does.

export type PrimeBodyDigestPass = {
  /**
   * Repo path → digests. An EMPTY array means asked and unreadable, never
   * "no match".
   *
   * Keyed by PATH and not by migration id, because ids collide: 77 files in
   * this corpus share a version with another, and a digest filed under the
   * version would be one sibling's bytes standing in for the other's. A path
   * is unique by construction.
   */
  byPath: Map<string, string[]>;
  /** Bodies read from GitHub this call (the rest came from the cache). */
  fetched: number;
  /** Paths whose body was past {@link MAX_DIGEST_BYTES} or would not fetch. */
  unread: string[];
  /**
   * Repo path → what that migration creates and requires, for the bodies this
   * pass decoded.
   *
   * A path MISSING from this map is one nobody read. That is deliberate and
   * load-bearing: `partitionByDependency` narrows the barrier only where both
   * sides' facts are present, so an absent entry keeps the blanket rule for
   * that file rather than declaring it to create and need nothing.
   *
   * Free to compute — the decoded text is already in hand for the digest, and
   * the extraction is one pass of regexes over it.
   */
  factsByPath: Map<string, MigrationDependencyFacts>;
  /**
   * Repo path → the migration versions that body names in executable SQL, for
   * the bodies this pass decoded — the edge by which a refresh waits for the
   * seed it reads. See `migrationVersionMentions.pure.ts`.
   *
   * Keyed exactly as {@link factsByPath} and filled from the same decoded
   * text, so a path is in both or in neither: `partitionByDependency` narrows
   * a candidate only where both were read, and a body read for one and not
   * the other would put it back on the blanket rule for no reason.
   */
  mentionsByPath: Map<string, string[]>;
};

/**
 * Digest the bodies of `ids`, reusing anything already digested at this commit.
 *
 * Bodies go out through `fetchBlobTextsBatched` — eighty blobs a GraphQL
 * query — rather than `loadSql` one at a time. Measured on the real corpus
 * that is ~800 files in about ten requests instead of 800, which is the
 * difference between a page render and a rate-limit incident.
 */
export async function digestPrimeBodies(
  corpus: PrimeMigrationCorpus,
  paths: readonly string[],
  octokit: Octokit,
  ref: RepoRef,
  opts?: { maxBytes?: number },
): Promise<PrimeBodyDigestPass> {
  const maxBytes = opts?.maxBytes ?? MAX_DIGEST_BYTES;

  if (!cache || cache.sourceSha !== corpus.sourceSha) {
    cache = {
      sourceSha: corpus.sourceSha,
      digests: new Map(),
      facts: new Map(),
      mentions: new Map(),
    };
  }
  const warm = cache.digests;
  const warmFacts = cache.facts;
  const warmMentions = cache.mentions;
  const byPathMeta = new Map(corpus.files.map((f) => [f.path, f]));

  const wanted = [...new Set(paths)].slice(0, MAX_DIGEST_FILES);
  const todo: Array<{ rel: string; sha: string }> = [];
  for (const path of wanted) {
    if (warm.has(path)) continue;
    const file = byPathMeta.get(path);
    // An UNKNOWN size is not a small one — the rule `loadSql` applies one file
    // at a time, and it matters more here because these go out eighty to a
    // request. A 40 MB seed in such a batch is a different program.
    if (!file || file.size === null || file.size > maxBytes) {
      warm.set(path, []);
      continue;
    }
    todo.push({ rel: path, sha: file.sha });
  }

  let fetched = 0;
  if (todo.length > 0) {
    try {
      const bodies = await fetchBlobTextsBatched(octokit, ref, todo);
      for (const [path, b64] of bodies) {
        const sql = decodeBase64Utf8(b64);
        warm.set(path, bodyDigests(sql));
        // The text is decoded either way; the facts are the cheap half.
        warmFacts.set(path, dependencyFactsOf(sql));
        warmMentions.set(path, mentionedVersionsOf(sql));
        fetched += 1;
      }
    } catch {
      // Transient or permanent, it is the same answer to the caller: these
      // bodies were not read. Deliberately NOT cached as [] — a GitHub blip
      // must not poison every later tick at this commit.
    }
  }

  const byPath = new Map<string, string[]>();
  const factsByPath = new Map<string, MigrationDependencyFacts>();
  const mentionsByPath = new Map<string, string[]>();
  const unread: string[] = [];
  for (const path of wanted) {
    const d = warm.get(path) ?? [];
    byPath.set(path, d);
    if (d.length === 0) unread.push(path);
    const f = warmFacts.get(path);
    if (f !== undefined) factsByPath.set(path, f);
    const named = warmMentions.get(path);
    if (named !== undefined) mentionsByPath.set(path, named);
  }
  return { byPath, fetched, unread, factsByPath, mentionsByPath };
}
