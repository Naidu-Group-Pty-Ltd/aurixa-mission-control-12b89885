/**
 * What a cut cascade pass leaves behind, and what the next one may reuse.
 *
 * A first module-scope cascade to `preflight-property-group` is 353 files —
 * a content read and a blob create each, after two tree listings and the
 * deletion probes, before the tree, the commit and the pull request. The
 * hook that runs it is abandoned at 60 seconds. Measured 2 Sep 2026 at 14:10
 * and again at 14:14: the pass was still preparing blobs when it was cut,
 * the reclaim requeued it ten minutes later, and the next attempt did the
 * same 353 reads and creates again. Three attempts and the event was dead,
 * with nothing delivered.
 *
 * The blobs a cut pass created are not lost. They exist in the clone's
 * repository, addressed by SHA, whether or not a tree ever referenced them.
 * What was lost was the list. `CascadeProgress` is that list: for every path
 * prepared, the blob SHA the clone now holds and the prime blob SHA it was
 * made from, keyed by the prime commit the pass was for.
 *
 * Two rules. **An entry is reused only while the prime blob it was made from
 * is still the one prime holds** — a path that changed upstream between
 * passes is read again, never delivered stale from a list. And **progress is
 * for one prime commit**: a record made for another source SHA is not
 * consulted at all, because a different commit is a different diff.
 */

export type PreparedBlob = {
  /** The blob SHA the clone's repository now holds for this path. */
  blob: string;
  /** The prime blob SHA it was made from. */
  prime: string;
};

export type CascadeProgress = {
  version: 1;
  /** The prime commit this pass was delivering. */
  source_sha: string;
  /** Path → what was prepared. */
  prepared: Record<string, PreparedBlob>;
  /** Files the pass had to prepare in total, for the sentence. */
  total: number;
};

/** How many freshly prepared blobs between writes of the list. */
export const PROGRESS_FLUSH_EVERY = 25;

const SHA = /^[0-9a-f]{40}$/;

/**
 * Read a stored record, or nothing.
 *
 * Nothing rather than a guess on any doubt: a record for another commit, a
 * malformed entry, a SHA that is not one. A wrong reuse delivers the wrong
 * bytes to a clone; a missed reuse costs one read.
 */
export function readProgress(raw: unknown, sourceSha: string): CascadeProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CascadeProgress>;
  if (r.version !== 1) return null;
  if (r.source_sha !== sourceSha) return null;
  if (!r.prepared || typeof r.prepared !== "object" || Array.isArray(r.prepared)) return null;
  const prepared: Record<string, PreparedBlob> = {};
  for (const [path, entry] of Object.entries(r.prepared as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return null;
    const { blob, prime } = entry as Partial<PreparedBlob>;
    if (typeof blob !== "string" || typeof prime !== "string") return null;
    if (!SHA.test(blob) || !SHA.test(prime)) return null;
    prepared[path] = { blob, prime };
  }
  const total = typeof r.total === "number" && Number.isFinite(r.total) ? r.total : 0;
  return { version: 1, source_sha: sourceSha, prepared, total };
}

/**
 * The blobs a new pass may reuse: those whose prime SHA is still what prime
 * holds for the path. `primeShaByPath` is the prime tree listing; without it
 * (a truncated listing) nothing is reused, because nothing can be checked.
 */
export function resumableBlobs(
  progress: CascadeProgress | null,
  primeShaByPath: ReadonlyMap<string, string> | null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!progress || !primeShaByPath) return out;
  for (const [path, entry] of Object.entries(progress.prepared)) {
    if (primeShaByPath.get(path) === entry.prime) out.set(path, entry.blob);
  }
  return out;
}

/** The one sentence a clone's row carries while its pass is paused. */
export function describePreparePause(input: { prepared: number; total: number }): string {
  return (
    `Paused at the invocation budget — ${input.prepared} of ${input.total} file(s) prepared; ` +
    "the rest resume next tick"
  );
}
