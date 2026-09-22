/**
 * Carry a file too large to HOLD, by never holding it.
 *
 * ## What the ceiling was, and what it was about
 *
 * `CASCADE_MAX_FILE_BYTES` is 8 MB, and its reasoning is exactly right for
 * the lane it describes: `getFileContent` reads a blob whole, base64 in a
 * JSON envelope, decodes it to a JS string and hands back both. A 40 MB file
 * is a 53 MB response, a 40 MB buffer and a string beside it, inside a
 * Worker isolate with 128 MB. The 2 Sep 2026 cascade to
 * `npc-client-dashboard` died on one such file on every attempt until the
 * event ran out of claims, and holding it was the fix.
 *
 * But that number describes **what an invocation can hold**, and it has been
 * read ever since as **what a cascade can carry** — which is a different
 * question with a different answer. Measured at prime@cc530dfa, 22 Sep 2026:
 * fifteen tracked files are over the ceiling, fourteen template-library seeds
 * from 35.6 MB to 39.8 MB and one 8.8 MB Airtable record fixture under
 * `docs/**`. None is over 40 MB. Every one of them has had to be moved into
 * every clone by hand, and the note on the hold says so in as many words —
 * "No approval can release a ceiling — bring the file across by hand."
 *
 * Seven of those fourteen seeds were added in five days. A remedy whose cost
 * grows with the fleet AND with the release cadence is not a remedy.
 *
 * ## The lane this opens
 *
 * The bytes never have to enter the isolate. The blob endpoint serves raw
 * bytes under `application/vnd.github.raw+json` — `fetchBlobTextStream`
 * already reads prime that way — and the create-blob endpoint takes base64
 * inside a JSON body, which a request may stream. So a copy is:
 *
 *   prime raw bytes → base64 transform → `{"encoding":"base64","content":"…"}`
 *   → clone's `POST /git/blobs`
 *
 * and the most this module ever holds is one chunk plus at most two carried
 * bytes. The file's size stops being a memory question altogether.
 *
 * Three properties make it safe to do at all:
 *
 * 1. **Base64 needs no JSON escaping.** The alphabet is `A–Z a–z 0–9 + / =`,
 *    and not one of those is a character JSON escapes — so the body is a
 *    literal prefix, the encoder's own output, and a literal suffix, with
 *    nothing in between that has to be inspected.
 *
 * 2. **The length is arithmetic, not measurement.** base64 of `n` bytes is
 *    `4 × ceil(n / 3)` characters, all single-byte, so `Content-Length` is
 *    known before a byte moves. A streamed body would otherwise go out
 *    chunked, and a chunked POST is a thing GitHub might refuse for reasons
 *    that would read as a transfer failure.
 *
 * 3. **A git blob is content-addressed, so the copy PROVES itself.** The sha
 *    is `sha1("blob " + length + "\0" + bytes)` and nothing else — it does
 *    not depend on the repository. So the sha the clone returns must equal
 *    the sha prime holds, and where it does not the bytes differ. That is an
 *    exact check of a transfer nothing in this process ever saw, and it costs
 *    nothing: `assertCarriedBlobMatches` is the whole of it.
 *
 * ## What this is NOT
 *
 * It does not raise what an invocation may hold; `CASCADE_MAX_FILE_BYTES`
 * still governs every read that produces a string, and every judgement made
 * on a file's text — the spec membrane, the import closure, the stale-export
 * sweep — still runs on files under it. A streamed file crosses as BYTES and
 * is judged on nothing, which is correct for the shapes that reach this lane
 * (a seed, a fixture, an image) and is why the lane is not the default.
 *
 * And it cannot make a cascade worse than it is today. The lane is reached
 * only from the refusal that already held the file, and every way it can fail
 * — a refusal from either endpoint, a short read, a sha that disagrees —
 * returns to that same hold. The floor is the behaviour this replaces.
 */

/**
 * The most a cascade will carry in one file, now that carrying it does not
 * mean holding it.
 *
 * This is GitHub's number rather than ours: the create-blob endpoint is
 * documented to 100 MB, and past it there is no request to make. Saying so is
 * the point — a file over this is refused by the API, not by a budget an
 * operator could argue with, and the hold should send them to the only remedy
 * that exists (make the file smaller, or keep it out of the tree) rather than
 * to a knob.
 *
 * Prime's largest tracked file is 39.8 MB, so nothing in the fleet is near
 * it. The headroom is deliberate: the number is a statement about the
 * transport, and pinning it to today's corpus would mean re-deciding it every
 * time a seed grows.
 */
export const CASCADE_STREAM_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * How much a single pass will carry as a stream before it leaves the rest for
 * the next one.
 *
 * `shouldStop` already paces a pass on the slowest file it has seen, and a
 * 40 MB carry makes itself the slowest file — so after the first one the
 * ordinary budget takes over and this is never reached. It exists for the
 * FIRST one: a pass that has read nothing yet has no measurement to reserve
 * against, and a fresh pass that opened on four seeds would spend its whole
 * invocation on them before the budget had a number to work with.
 *
 * Counted in BYTES rather than files, because that is what costs the
 * invocation: prime holds a 39.8 MB seed and an 8.8 MB fixture and they are
 * not the same work. 128 MB carries three of the largest files prime has,
 * which drains its fourteen-seed backlog in five passes per clone while
 * leaving room for the ordinary files travelling beside them.
 */
export const CASCADE_STREAM_BYTES_PER_PASS = 128 * 1024 * 1024;

/** What a cascade should do with a file of this size. */
export type CarryLane = "read" | "stream" | "refuse";

/**
 * Which lane a file takes, from its size alone.
 *
 * `read` is every file today and is unchanged: read it whole, judge its text,
 * inline it or blob it. `stream` is a file past what an invocation can hold
 * and within what the API will take. `refuse` is past both, and is the only
 * one that still ends in a hold.
 */
export function carryLaneFor(bytes: number, holdBytes: number): CarryLane {
  if (bytes <= holdBytes) return "read";
  if (bytes <= CASCADE_STREAM_MAX_FILE_BYTES) return "stream";
  return "refuse";
}

/**
 * base64 characters for `n` bytes, padding included.
 *
 * Every character is one byte on the wire, so this is also the content's
 * byte length. Written as arithmetic because it is asked BEFORE the bytes
 * exist — that is the whole reason a `Content-Length` can be set at all.
 */
export function base64Length(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new RangeError(`base64Length needs a whole count of bytes, got ${bytes}`);
  }
  return 4 * Math.ceil(bytes / 3);
}

/** The JSON before the content. Chosen so the content is the body's tail but one. */
export const BLOB_BODY_PREFIX = '{"encoding":"base64","content":"';
/** The JSON after it. */
export const BLOB_BODY_SUFFIX = '"}';

/**
 * The exact `Content-Length` of the create-blob request for a file this size.
 *
 * Exact, not an estimate: the prefix and suffix are ASCII literals, the
 * content is base64 (ASCII, and never escaped), and `base64Length` is closed
 * form. A body that disagrees with this header is a request that fails
 * loudly, which is the right way for an arithmetic error here to present.
 */
export function blobRequestContentLength(bytes: number): number {
  return BLOB_BODY_PREFIX.length + base64Length(bytes) + BLOB_BODY_SUFFIX.length;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = 61; // '='

/** Encode a length that is a whole number of 3-byte groups. No padding is produced. */
function encodeTriples(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array((bytes.length / 3) * 4);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o] = B64_ALPHABET.charCodeAt((n >>> 18) & 63);
    out[o + 1] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
    out[o + 2] = B64_ALPHABET.charCodeAt((n >>> 6) & 63);
    out[o + 3] = B64_ALPHABET.charCodeAt(n & 63);
    o += 4;
  }
  return out;
}

/** Encode the final 1 or 2 bytes, with the padding that ends the document. */
function encodeTail(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4);
  if (bytes.length === 1) {
    const n = bytes[0] << 16;
    out[0] = B64_ALPHABET.charCodeAt((n >>> 18) & 63);
    out[1] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
    out[2] = PAD;
    out[3] = PAD;
    return out;
  }
  const n = (bytes[0] << 16) | (bytes[1] << 8);
  out[0] = B64_ALPHABET.charCodeAt((n >>> 18) & 63);
  out[1] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
  out[2] = B64_ALPHABET.charCodeAt((n >>> 6) & 63);
  out[3] = PAD;
  return out;
}

/**
 * Bytes in, base64 bytes out, across arbitrary chunk boundaries.
 *
 * The only thing that makes this harder than a `map` is that base64 is
 * defined on 3-byte groups and a stream does not arrive in them. So each
 * chunk encodes the largest 3-byte-aligned prefix it can make with whatever
 * was carried over, and 0–2 bytes wait for the next one. Padding is produced
 * exactly once, in `flush`, because padding means END OF DOCUMENT — emitting
 * it at a chunk boundary would write a valid-looking base64 string that
 * decodes to the wrong bytes, which is the failure a per-chunk encoder makes
 * and which nothing downstream could detect. (Nothing except the sha, which
 * is why the sha is checked.)
 *
 * The carry is COPIED out of the incoming chunk rather than kept as a view:
 * a `subarray` shares the chunk's buffer, and a platform that reuses that
 * buffer for the next read would rewrite bytes this transform still owed.
 */
export function encodeBase64Stream(): TransformStream<Uint8Array, Uint8Array> {
  let carry = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let joined: Uint8Array;
      if (carry.length === 0) {
        joined = chunk;
      } else {
        joined = new Uint8Array(carry.length + chunk.length);
        joined.set(carry, 0);
        joined.set(chunk, carry.length);
      }
      const aligned = joined.length - (joined.length % 3);
      if (aligned > 0) controller.enqueue(encodeTriples(joined.subarray(0, aligned)));
      carry =
        joined.length > aligned ? new Uint8Array(joined.subarray(aligned)) : new Uint8Array(0);
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(encodeTail(carry));
      carry = new Uint8Array(0);
    },
  });
}

/**
 * The create-blob request body, as a stream, from prime's raw bytes.
 *
 * Three sources concatenated — the JSON prefix, the encoded content, the JSON
 * suffix — so that the only part that is ever large is the part that is never
 * held.
 */
export function blobRequestBody(raw: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const encoded = raw.pipeThrough(encodeBase64Stream());
  const reader = encoded.getReader();
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(ascii(BLOB_BODY_PREFIX));
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(ascii(BLOB_BODY_SUFFIX));
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export class CarriedBlobMismatch extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      `${path} streamed to a blob ${received}, where prime holds ${expected} — ` +
        `a git blob sha is a hash of its own bytes, so the copy is not the file`,
    );
    this.name = "CarriedBlobMismatch";
  }
}

/**
 * The copy proved itself, or it did not.
 *
 * A streamed file is the one thing in a cascade whose bytes no part of this
 * process ever looked at. This is what stands in for having looked: the sha
 * GitHub computes on the clone is over the bytes it received, and a git blob
 * sha depends on nothing but those bytes, so equality with prime's sha is
 * byte identity and inequality is a corrupt transfer. There is no tolerance
 * and no second opinion.
 */
export function assertCarriedBlobMatches(path: string, expected: string, received: string): void {
  if (expected !== received) throw new CarriedBlobMismatch(path, expected, received);
}
