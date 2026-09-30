/**
 * Prime's text, read once per pass and a batch at a time.
 *
 * A cascade pass reads prime's copy of every file it is about to deliver, and
 * it used to do that one contents request at a time — twice for every source
 * file. The import closure reads each candidate module to learn what it
 * imports, and the prepare loop then reads the same file again to write it.
 * Replayed at prime@ded5d92 against `npc-crm-independent-6505dc`, the pass
 * made 884 GitHub calls, 836 of them per-file reads: 351 by the closure
 * before a single file was prepared, and 408 by the prepare loop after it.
 *
 * In production that pass never finished. Every tick of the 26 Sep 2026
 * events paused with no file prepared (0 of 390 at prime@c19ab0a, 0 of 399 at
 * prime@0e89502): the reads before the prepare loop spent the invocation's
 * whole budget, so the loop stopped before its first file. And a text file
 * travels INLINE in the tree write, so nothing a tick read was ever ledgered.
 * Each tick started from nothing, re-read the same files, paused at nothing,
 * and after three the drain retired the event at its attempt ceiling.
 *
 * `prime-backend.server.ts` measured the same limit for function snapshots:
 * the drain invocation died mid-pool at 12-wide over ~2,000 blobs and at
 * 24-wide over ~1,050. Its conclusion was "a thousand of them do not fit
 * inside the invocation; ~fourteen do", and it moved to GraphQL batches of 80
 * (`fetchBlobTextsBatched`). This is that remedy for the cascade: every blob
 * is read by its id from the tree listing the pass already holds, eighty to a
 * query, and the closure and the prepare loop share one reading of it.
 *
 * Three rules keep it from delivering a wrong byte.
 *
 *  - **Byte-exact or not at all.** GraphQL serves a blob as UTF-8 `text`, and
 *    a file that is not valid UTF-8 comes back altered. So a text is kept only
 *    where its git blob id (`gitBlobSha`) equals the id the tree listing
 *    holds for the path. A git blob id is a hash of the bytes and nothing
 *    else, so that equality is exact proof the text is the file. Anything
 *    that fails it is read the old way, per file.
 *  - **Only what the listing vouches for.** An entry is asked by the listing's
 *    own blob id and bounded by the listing's own size. A path with no size,
 *    or larger than GraphQL serves whole, is never batched; it takes the old
 *    road, where the oversize ceiling and the stream lane already live.
 *  - **A failed batch costs its round trip and nothing else.** A thrown query,
 *    a body with no `repository` or a missing alias leaves those entries
 *    unanswered, and the caller reads them per file exactly as before. An
 *    answer GraphQL returns beside an error is still used, because every
 *    text in it is id-checked anyway.
 *
 * Why not `fetchBlobTextsBatched` itself, which the spec channel already uses
 * to READ kept specs: it keeps any text GraphQL calls non-binary and untruncated
 * and re-reads everything else whole by REST. That is right for judging what a
 * file says. It is not right for writing the file into a clone. GitHub's
 * binary test is a heuristic about NUL bytes, so a Latin-1 or UTF-16 text file
 * is "not binary" and comes back as altered UTF-8. And a whole-blob re-read
 * would skip the oversize ceiling that sends a large file to the stream lane.
 *
 * Pure: plans batches, builds the query, judges the answer. The request lives
 * in `github-app.server.ts` (`readBlobTextsBatched`).
 */
import { gitBlobSha } from "./gitBlobSha.pure";

/** One blob the pass wants the text of, as its tree listing describes it. */
export type TextWant = {
  path: string;
  /** Prime's blob id at this path, from the tree listing. */
  sha: string;
  /** Prime's blob size in bytes, from the tree listing. */
  size: number | undefined;
};

/** Blobs per query: the batch `prime-backend.server.ts` measured and runs. */
export const PRIME_TEXT_BATCH_ENTRIES = 80;

/**
 * Text per query, from the listing's sizes. `prime-backend.server.ts` found
 * ~80 function files came to about 1 MB. A cascade's candidates include long
 * documents and migrations, so the bound is stated in bytes as well as in
 * blobs, and a batch closes at whichever it reaches first.
 */
export const PRIME_TEXT_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * The largest file asked for by batch. GraphQL truncates `Blob.text` at about
 * 512 KB and says so with `isTruncated`. A truncated answer would fail the id
 * check anyway, but asking for it would spend a query's worth of response on
 * a file that has to be read again. The margin keeps well clear of the
 * truncation point.
 */
export const PRIME_TEXT_MAX_BYTES = 384 * 1024;

/**
 * How many batch queries a pass keeps in flight. Nothing else in the pass is
 * in flight while a prefetch runs (the closure awaits its own, and each pool
 * starts only once its prefetch is in), and a Worker holds at most six
 * connections open, so five fills the room without queueing behind itself.
 * At three, the independent's closure took two rounds of GraphQL where one
 * would do.
 */
export const PRIME_TEXT_BATCH_CONCURRENCY = 5;

const SHA = /^[0-9a-f]{40}$/;

/**
 * Whether a tree entry's mode is a regular file, the only kind asked by batch.
 *
 * A symbolic link is a blob too (`120000`), holding its target's path, and the
 * contents API answers a link to a file with the TARGET's content. Reading the
 * link's own blob by id would hand the prepare step a different file from the
 * one it has always read, so a link takes the old road, unchanged. So does an
 * entry whose mode the listing did not give.
 */
export function isBatchableTextMode(mode: string | undefined): boolean {
  return mode === "100644" || mode === "100755";
}

/**
 * The batches for a set of wants, in the order given.
 *
 * Drops a want the batch road cannot serve exactly: a size the listing did
 * not give, a file larger than `PRIME_TEXT_MAX_BYTES`, or an id that is not
 * a 40-digit hex blob id. The last also keeps the query string inert,
 * because an id is interpolated into it. A path asked twice is asked once.
 * Every dropped want is simply unanswered, and the caller reads it per file.
 */
export function planTextBatches(wants: readonly TextWant[]): TextWant[][] {
  const batches: TextWant[][] = [];
  const seen = new Set<string>();
  let current: TextWant[] = [];
  let currentBytes = 0;
  for (const want of wants) {
    if (seen.has(want.path)) continue;
    seen.add(want.path);
    if (typeof want.size !== "number" || !Number.isFinite(want.size) || want.size < 0) continue;
    if (want.size > PRIME_TEXT_MAX_BYTES) continue;
    if (!SHA.test(want.sha)) continue;
    if (
      current.length >= PRIME_TEXT_BATCH_ENTRIES ||
      (current.length > 0 && currentBytes + want.size > PRIME_TEXT_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(want);
    currentBytes += want.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The GraphQL query for one batch: each blob aliased `b<index>`, asked by id.
 *
 * Ids are validated by `planTextBatches`, so nothing user-shaped reaches the
 * string. The repository travels as variables.
 */
export function textBatchQuery(batch: readonly TextWant[]): string {
  const fields = batch
    .map((want, j) => {
      if (!SHA.test(want.sha)) throw new Error(`Not a blob id: ${want.sha}`);
      return `b${j}: object(oid: "${want.sha}") { ... on Blob { text isBinary isTruncated } }`;
    })
    .join("\n");
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`;
}

/** What GraphQL answers for one aliased blob. */
export type BlobTextAnswer =
  | {
      text?: string | null;
      isBinary?: boolean | null;
      isTruncated?: boolean | null;
    }
  | null
  | undefined;

/**
 * The texts in a batch's answer that are exactly the files they claim to be.
 *
 * A text is kept only where GraphQL says it is whole text (`isBinary` false,
 * `isTruncated` false) AND its blob id is the one the listing holds. The first
 * two only save a hash; the id check is the one that decides. `repository`
 * absent means the batch told us nothing, and nothing is kept.
 */
export function acceptTextAnswers(
  batch: readonly TextWant[],
  repository: Readonly<Record<string, BlobTextAnswer>> | null | undefined,
): Map<string, string> {
  const texts = new Map<string, string>();
  if (!repository || typeof repository !== "object") return texts;
  batch.forEach((want, j) => {
    const answer = repository[`b${j}`];
    if (!answer || typeof answer !== "object") return;
    if (typeof answer.text !== "string") return;
    if (answer.isBinary !== false || answer.isTruncated !== false) return;
    if (gitBlobSha(answer.text) !== want.sha) return;
    texts.set(want.path, answer.text);
  });
  return texts;
}
