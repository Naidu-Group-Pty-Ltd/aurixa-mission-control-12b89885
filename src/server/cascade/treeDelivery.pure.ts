/**
 * Batched tree delivery — the spend fix for the 16 Sep 2026 window burns.
 *
 * The engine used to create one blob per delivered file: ~830 text files on
 * a backfill-scale cascade is ~830 `createBlob` calls PER CLONE against the
 * App installation's 5,000/hour window, so each clone's rebuild spent a
 * third of the window, the fleet did twenty minutes of work an hour and sat
 * "Deferred until…" for the other forty — which an operator reads as stuck.
 * Measured 16 Sep 2026, 12:24–13:25: one clone rebuilt and merged, one was
 * cut mid-push, and the third never started before the window emptied.
 *
 * GitHub's `createTree` accepts an entry's CONTENT inline — the server
 * creates the blob — so one call can carry a hundred text files. Delivery
 * therefore ships text through chunked `createTree` calls chained on
 * `base_tree`, and `createBlob` remains only for binary files (base64 has
 * no inline lane) and for the two singleton reconciled files (config,
 * deploy workflow). ~830 files fall from ~830 calls to ~8.
 *
 * Rules:
 * - **Exactly one of `sha` and `content` is set** on an entry, matching the
 *   API: `sha: string` reuses an uploaded blob, `sha: null` deletes the
 *   path, `content` inlines UTF-8 text. Binary bytes must never travel as
 *   `content` — that is the replacement-character corruption the engine
 *   already fixed once (`aurixa-emblem-240.png`, 86 partner `.docx`).
 * - **Order is preserved and chunks are never empty.** Paths are unique
 *   across a delivery, so layering chunks over `base_tree` composes to the
 *   same tree whatever the boundaries.
 * - **An oversize file rides alone.** The byte bound exists so a chunk's
 *   request body stays well under the API's limit; a single entry larger
 *   than the bound cannot be split, so it becomes its own chunk rather
 *   than being refused.
 */

/**
 * A regular file or an executable one — the two modes a delivery writes.
 *
 * Both lanes carry the source's own mode, because a script that arrives
 * without its executable bit is a script that no longer runs. The lateral lane
 * always did; the vertical engine wrote every file `100644` until
 * `deliveryModeFor`.
 */
export type DeliveryMode = "100644" | "100755";

/** The two listings a mode is read from: `path -> blob SHA` and `path -> git mode`. */
type ListedTree = {
  entries: ReadonlyMap<string, string>;
  modes: ReadonlyMap<string, string>;
};

const isDeliveryMode = (mode: string | undefined): mode is DeliveryMode =>
  mode === "100644" || mode === "100755";

/**
 * The mode a vertical delivery writes a file with: the prime's own.
 *
 * The engine wrote every file `100644`, which took the executable bit off a
 * script each time the prime changed it and delivered every new script
 * without one. Measured 27 Oct 2026: cascades into `npc-crm-independent-6505dc`
 * took it off `scripts/verify/report-journey/run-format.mjs` (27 Sep) and
 * `scripts/security/check-cron-caller-names.mjs` (28 Sep), and the three
 * mirrors each held 16 of the prime's executable scripts as plain files until
 * a hand sync on 23 Oct put the bits back.
 *
 * Where the prime's listing gives no mode a delivery writes — a file the
 * engine composes at a path the prime does not hold, or a listing that was not
 * read — the clone's own executable bit is kept rather than taken away, and
 * anything else is a regular file, as before. A symbolic link is never
 * delivered at all (`isSymbolicLink`).
 */
export function deliveryModeFor(
  path: string,
  primeModes: ReadonlyMap<string, string> | null,
  cloneModes: ReadonlyMap<string, string> | null,
): DeliveryMode {
  const prime = primeModes?.get(path);
  if (isDeliveryMode(prime)) return prime;
  return cloneModes?.get(path) === "100755" ? "100755" : "100644";
}

/**
 * Every written entry at its delivery mode, decided in one place.
 *
 * Applied where the delivery is cut into its tree chain, so no stage that
 * appends an entry can write a mode of its own. A deletion (`sha: null`) is
 * left as it is: its mode means nothing to the API.
 */
export function withDeliveryModes(
  entries: readonly DeliveryTreeEntry[],
  primeModes: ReadonlyMap<string, string> | null,
  cloneModes: ReadonlyMap<string, string> | null,
): DeliveryTreeEntry[] {
  return entries.map((entry) =>
    entry.sha === null
      ? entry
      : { ...entry, mode: deliveryModeFor(entry.path, primeModes, cloneModes) },
  );
}

/**
 * Whether the clone's copy of a prime file is not what a delivery would write:
 * its bytes differ, or its executable bit does.
 *
 * Blob SHAs alone cannot see the second. A prime commit that only makes a
 * script executable changes no blob, so it was never delivered, and a bit a
 * delivery once took away was never put back. A mode either listing does not
 * give is not drift: a missing answer is not a difference.
 */
export function differsFromPrime(path: string, prime: ListedTree, clone: ListedTree): boolean {
  if (clone.entries.get(path) !== prime.entries.get(path)) return true;
  return executableBitDiffers(path, prime.modes, clone.modes);
}

/** The mode half of `differsFromPrime`: both listings give a delivered mode, and they differ. */
export function executableBitDiffers(
  path: string,
  primeModes: ReadonlyMap<string, string> | null,
  cloneModes: ReadonlyMap<string, string> | null,
): boolean {
  const primeMode = primeModes?.get(path);
  const cloneMode = cloneModes?.get(path);
  return isDeliveryMode(primeMode) && isDeliveryMode(cloneMode) && primeMode !== cloneMode;
}

/**
 * Whether the prime holds this path as a symbolic link.
 *
 * Read as text and written as a blob, a link becomes a file holding its
 * target's path, and nothing downstream can tell. The fleet held none on
 * 27 Oct 2026; the engine holds one rather than write that file.
 */
export function isSymbolicLink(path: string, primeModes: ReadonlyMap<string, string> | null) {
  return primeModes?.get(path) === "120000";
}

export type DeliveryTreeEntry = {
  path: string;
  mode: DeliveryMode;
  type: "blob";
  /** An uploaded blob to reuse, or null to DELETE the path. Absent for inline text. */
  sha?: string | null;
  /** UTF-8 text the API turns into a blob server-side. Absent for sha entries. */
  content?: string;
};

export const TREE_CHUNK_MAX_ENTRIES = 120;
export const TREE_CHUNK_MAX_CONTENT_BYTES = 2_000_000;

/** Bytes `content` adds to a chunk's request body; sha/deletion entries are ~free. */
function contentBytes(entry: DeliveryTreeEntry): number {
  return entry.content ? Buffer.byteLength(entry.content, "utf8") : 0;
}

export function chunkTreeEntries(
  entries: readonly DeliveryTreeEntry[],
  maxEntries: number = TREE_CHUNK_MAX_ENTRIES,
  maxContentBytes: number = TREE_CHUNK_MAX_CONTENT_BYTES,
): DeliveryTreeEntry[][] {
  const chunks: DeliveryTreeEntry[][] = [];
  let current: DeliveryTreeEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const bytes = contentBytes(entry);
    const wouldOverflow =
      current.length > 0 &&
      (current.length + 1 > maxEntries || currentBytes + bytes > maxContentBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The delivery in the one order a chain is cut from: by path, compared as
 * code units so no locale decides it, and stable, so two entries for one
 * path keep the order they were written in.
 *
 * A kept chain is resumed only by a pass that cuts the SAME chunks
 * (`treeChainKey`), and the engine assembles its entries in stages, some of
 * which finish in whatever order GitHub answers concurrent reads. Measured
 * 20–21 Oct 2026 on the CRM line: two line-variant merges entered the
 * delivery in the order their stored blobs read back, so passes alternated
 * between two orders of one 1,417-file delivery, keys `0c13d2fa…` and
 * `b057bab4…`, and each restarted the other's chain at chunk 1. Its event
 * was retired after twelve hours with two of fifteen chunks written.
 *
 * Order does not change the tree: paths are unique across a delivery, so
 * layering the same entries over `base_tree` composes to the same tree
 * whatever the boundaries (the rule at the top of this file). Cutting from
 * this order makes the chain a function of what the tree will hold, not of
 * how the pass came to know it. Sorted, a removed file also comes before
 * anything written beneath its path.
 */
export function canonicalDeliveryOrder(entries: readonly DeliveryTreeEntry[]): DeliveryTreeEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The API-shaped entry: never both `sha` and `content`, and `sha` present
 * only when it means something (a reuse or a deletion).
 */
export function toGitTreeParam(entry: DeliveryTreeEntry):
  | { path: string; mode: DeliveryMode; type: "blob"; sha: string | null }
  | {
      path: string;
      mode: DeliveryMode;
      type: "blob";
      content: string;
    } {
  if (entry.content !== undefined) {
    return { path: entry.path, mode: entry.mode, type: entry.type, content: entry.content };
  }
  return { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha ?? null };
}
