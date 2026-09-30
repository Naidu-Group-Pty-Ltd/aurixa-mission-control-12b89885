import { describe, expect, it } from "vitest";
import {
  BLOB_BODY_PREFIX,
  BLOB_BODY_SUFFIX,
  CASCADE_STREAM_MAX_FILE_BYTES,
  CarriedBlobMismatch,
  assertCarriedBlobMatches,
  base64Length,
  blobRequestBody,
  blobRequestContentLength,
  carryLaneFor,
  encodeBase64Stream,
} from "./blobStreamCarry.pure";
import { CASCADE_MAX_FILE_BYTES } from "./syncExclusions.pure";

/** Feed bytes through the transform in chunks of exactly `size`. */
async function encodeInChunks(bytes: Uint8Array, size: number): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(new Uint8Array(bytes.subarray(i, Math.min(i + size, bytes.length))));
      }
      controller.close();
    },
  });
  const out: number[] = [];
  const reader = source.pipeThrough(encodeBase64Stream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return String.fromCharCode(...out);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return String.fromCharCode(...out);
}

describe("the base64 transform", () => {
  it("agrees with Buffer on every length up to three whole groups", async () => {
    for (let n = 0; n <= 9; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const expected = Buffer.from(bytes).toString("base64");
      expect(await encodeInChunks(bytes, 1024)).toBe(expected);
    }
  });

  it("is the same answer at every chunk size, which is the whole point", async () => {
    /*
      Base64 is defined on 3-byte groups and a stream does not arrive in them.
      A per-chunk encoder pads at every boundary and produces a string that
      decodes to the wrong bytes while looking entirely well-formed — so this
      walks the boundary across the alignment classes deliberately.
    */
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xff);
    const expected = Buffer.from(bytes).toString("base64");
    for (const size of [1, 2, 3, 4, 5, 7, 64, 255, 256, 257, 1023, 4096, 8192]) {
      expect(await encodeInChunks(bytes, size), `chunk size ${size}`).toBe(expected);
    }
  });

  it("pads exactly once, at the end, however the bytes arrive", async () => {
    for (const length of [4094, 4095, 4096]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i & 0xff);
      const encoded = await encodeInChunks(bytes, 7);
      // Padding means END OF DOCUMENT. A per-chunk encoder pads at every
      // boundary and decodes to the wrong bytes while looking well-formed.
      expect(encoded.slice(0, -2), `length ${length}`).not.toContain("=");
      expect(encoded, `length ${length}`).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("carries bytes it does not own, so a reused source buffer cannot corrupt it", async () => {
    /*
      A `subarray` shares the chunk's buffer. A platform that reads the next
      chunk into the same buffer would rewrite the 1-2 bytes this transform
      still owes, and nothing downstream could see it — the string stays
      well-formed base64.

      Written against the transform's own writer rather than a piped source
      because only that is deterministic: `write()` resolves after the
      transformer's `transform()` has settled, so mutating the buffer on the
      next line is exactly the reuse being modelled. A `ReadableStream` that
      enqueues and then mutates proves nothing — the queue holds the view, and
      every byte is rewritten before the transform ever runs.
    */
    const ts = encodeBase64Stream();
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const out: number[] = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(...value);
      }
    })();

    const reusable = new Uint8Array([1, 2, 3, 4]); // 3 encoded, 1 carried
    await writer.write(reusable.subarray(0, 4));
    reusable.set([9, 9, 9, 9]); // the platform reuses the buffer for the next read
    await writer.write(new Uint8Array([5, 6]));
    await writer.close();
    await pump;

    expect(String.fromCharCode(...out)).toBe(
      Buffer.from(new Uint8Array([1, 2, 3, 4, 5, 6])).toString("base64"),
    );
  });

  it("carries bytes that are not text at all", async () => {
    const bytes = Uint8Array.from({ length: 1536 }, (_, i) => (i * 251) & 0xff);
    expect(await encodeInChunks(bytes, 13)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("the request body", () => {
  it("is the prefix, the content and the suffix, and nothing else", async () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const body = await drain(blobRequestBody(source));
    expect(body).toBe(
      `${BLOB_BODY_PREFIX}${Buffer.from(bytes).toString("base64")}${BLOB_BODY_SUFFIX}`,
    );
    expect(JSON.parse(body)).toEqual({
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
    });
  });

  it("produces a body of exactly the declared Content-Length", async () => {
    /*
      The header is computed before a byte moves — that is what keeps the
      request off chunked transfer-encoding. If the arithmetic and the encoder
      ever disagree the request fails on the wire, so they are compared here.
    */
    for (const length of [0, 1, 2, 3, 100, 999, 1000, 4097]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 17) & 0xff);
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 31) {
            c.enqueue(new Uint8Array(bytes.subarray(i, Math.min(i + 31, bytes.length))));
          }
          c.close();
        },
      });
      const body = await drain(blobRequestBody(source));
      expect(body.length, `length ${length}`).toBe(blobRequestContentLength(length));
    }
  });

  it("needs no JSON escaping, because base64 has no character JSON escapes", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    expect(JSON.stringify(alphabet)).toBe(`"${alphabet}"`);
  });
});

describe("base64Length", () => {
  it("is the closed form Buffer agrees with", () => {
    for (let n = 0; n <= 200; n += 1) {
      const bytes = new Uint8Array(n);
      expect(base64Length(n), `n=${n}`).toBe(Buffer.from(bytes).toString("base64").length);
    }
  });

  it("refuses a count that is not a whole number of bytes", () => {
    expect(() => base64Length(1.5)).toThrow(RangeError);
    expect(() => base64Length(-1)).toThrow(RangeError);
  });
});

describe("carryLaneFor", () => {
  it("leaves every file the read lane could hold exactly where it was", () => {
    expect(carryLaneFor(0, CASCADE_MAX_FILE_BYTES)).toBe("read");
    expect(carryLaneFor(CASCADE_MAX_FILE_BYTES, CASCADE_MAX_FILE_BYTES)).toBe("read");
  });

  it("streams what the isolate cannot hold and the API will still take", () => {
    expect(carryLaneFor(CASCADE_MAX_FILE_BYTES + 1, CASCADE_MAX_FILE_BYTES)).toBe("stream");
    // prime's largest tracked file, 22 Sep 2026.
    expect(carryLaneFor(41_780_944, CASCADE_MAX_FILE_BYTES)).toBe("stream");
    expect(carryLaneFor(CASCADE_STREAM_MAX_FILE_BYTES, CASCADE_MAX_FILE_BYTES)).toBe("stream");
  });

  it("refuses only what GitHub itself will not take", () => {
    expect(carryLaneFor(CASCADE_STREAM_MAX_FILE_BYTES + 1, CASCADE_MAX_FILE_BYTES)).toBe("refuse");
  });

  it("sits between the largest blob GitHub has taken and the smallest it has refused", () => {
    // Measured on npc-client-dashboard, 26 Sep 2026. v16 (41,780,944 bytes)
    // landed byte-identical; v20 (42,195,218) was refused with HTTP 422 on
    // every pass while the ceiling read 100 MB. Streaming a file the API will
    // refuse spends the pass's window on work that cannot land, and holding
    // one it would take sends a person to do the engine's job.
    expect(carryLaneFor(41_780_944, CASCADE_MAX_FILE_BYTES)).toBe("stream");
    expect(carryLaneFor(42_195_218, CASCADE_MAX_FILE_BYTES)).toBe("refuse");
    expect(carryLaneFor(42_246_310, CASCADE_MAX_FILE_BYTES)).toBe("refuse");
    expect(carryLaneFor(42_406_114, CASCADE_MAX_FILE_BYTES)).toBe("refuse");
  });

  it("keeps the stream ceiling above the hold ceiling, or the lane is unreachable", () => {
    expect(CASCADE_STREAM_MAX_FILE_BYTES).toBeGreaterThan(CASCADE_MAX_FILE_BYTES);
  });
});

describe("the copy proves itself", () => {
  it("accepts the sha prime holds", () => {
    expect(() => assertCarriedBlobMatches("a.sql", "abc123", "abc123")).not.toThrow();
  });

  it("refuses any other sha, and names the file rather than the sha", () => {
    expect(() => assertCarriedBlobMatches("a.sql", "abc123", "def456")).toThrow(
      CarriedBlobMismatch,
    );
    try {
      assertCarriedBlobMatches("supabase/migrations/seed.sql", "abc123", "def456");
    } catch (e) {
      expect((e as Error).message).toContain("supabase/migrations/seed.sql");
    }
  });
});
