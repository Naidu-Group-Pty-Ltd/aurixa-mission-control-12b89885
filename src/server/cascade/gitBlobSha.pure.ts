/**
 * The git blob id of a text, computed without asking git.
 *
 * A blob's id is `sha1("blob " + byteLength + "\0" + bytes)` and nothing
 * else — it depends on neither the repository nor the path
 * (`blobStreamCarry.pure.ts` relies on the same fact). So the question "does
 * this text change the clone's file?" has an exact answer from the clone's
 * tree listing alone: the file changes precisely when this id differs from the
 * blob sha the clone's tree already holds at that path.
 *
 * The cascade needs that answer for the one kind of write it composes itself.
 * A reconcile pump writes a MERGED file, and in its steady state the merge is
 * byte-for-byte the clone's own — a write that changes nothing. Telling the two
 * apart by comparing texts would need the clone's copy of every such file; the
 * tree listing already carries its id.
 *
 * The bytes are the UTF-8 encoding of the text, which is what the engine sends
 * to `createBlob` (`Buffer.from(text, "utf8")`), so the id computed here is the
 * id that blob would get.
 *
 * Pure: no I/O. Hashing is computation, not a read.
 */

import { createHash } from "node:crypto";

/** The id git would give a blob holding `text`, as 40 lowercase hex digits. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
