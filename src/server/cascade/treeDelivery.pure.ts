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
 * The vertical engine writes every file `100644`, as it always has. The
 * lateral lane carries the origin's own mode, because a script that crosses
 * without its executable bit is a script that no longer runs.
 */
export type DeliveryMode = "100644" | "100755";

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
