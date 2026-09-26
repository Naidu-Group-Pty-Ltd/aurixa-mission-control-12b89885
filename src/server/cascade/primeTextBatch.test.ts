import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./gitBlobSha.pure";
import {
  acceptTextAnswers,
  isBatchableTextMode,
  planTextBatches,
  PRIME_TEXT_BATCH_BYTES,
  PRIME_TEXT_BATCH_ENTRIES,
  PRIME_TEXT_MAX_BYTES,
  textBatchQuery,
  type TextWant,
} from "./primeTextBatch.pure";

/** A want for `text`, with the id and size its tree listing would give. */
const wantFor = (path: string, text: string): TextWant => ({
  path,
  sha: gitBlobSha(text),
  size: Buffer.byteLength(text, "utf8"),
});

/**
 * The id git gives a blob holding exactly these bytes. `gitBlobSha` takes a
 * text and hashes its UTF-8 encoding, so it cannot describe a file that is
 * not UTF-8, which is what one test below needs.
 */
function blobIdOfBytes(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** A syntactically valid blob id that no text in these tests hashes to. */
const fakeSha = (n: number) => n.toString(16).padStart(40, "0");

describe("planTextBatches", () => {
  it("asks each path once, in the order given", () => {
    const a = wantFor("src/a.ts", "export const a = 1;\n");
    const b = wantFor("src/b.ts", "export const b = 2;\n");
    const batches = planTextBatches([a, b, a]);
    expect(batches).toEqual([[a, b]]);
  });

  it("asks nothing for nothing", () => {
    expect(planTextBatches([])).toEqual([]);
  });

  it("closes a batch at the entry bound", () => {
    const wants = Array.from({ length: PRIME_TEXT_BATCH_ENTRIES * 2 + 1 }, (_, i) =>
      wantFor(`src/f${i}.ts`, `export const x${i} = ${i};\n`),
    );
    const batches = planTextBatches(wants);
    expect(batches.map((b) => b.length)).toEqual([
      PRIME_TEXT_BATCH_ENTRIES,
      PRIME_TEXT_BATCH_ENTRIES,
      1,
    ]);
    // Nothing lost and nothing reordered across the cut.
    expect(batches.flat()).toEqual(wants);
  });

  it("closes a batch before the byte bound would be passed, never after", () => {
    // Each file is a quarter of the per-file ceiling, so the byte bound — not
    // the entry bound — decides where the batches close.
    const size = PRIME_TEXT_MAX_BYTES / 4;
    const wants = Array.from({ length: 40 }, (_, i) => ({
      path: `docs/d${i}.md`,
      sha: fakeSha(i + 1),
      size,
    }));
    const batches = planTextBatches(wants);
    const perBatch = Math.floor(PRIME_TEXT_BATCH_BYTES / size);
    expect(batches[0]).toHaveLength(perBatch);
    for (const batch of batches) {
      expect(batch.reduce((n, w) => n + (w.size ?? 0), 0)).toBeLessThanOrEqual(
        PRIME_TEXT_BATCH_BYTES,
      );
    }
    expect(batches.flat()).toEqual(wants);
  });

  it("fills a batch to the byte bound exactly, and one byte more starts the next", () => {
    const eighth = PRIME_TEXT_BATCH_BYTES / 8;
    expect(eighth).toBeLessThanOrEqual(PRIME_TEXT_MAX_BYTES);
    const exact = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}`,
      sha: fakeSha(i + 10),
      size: eighth,
    }));
    expect(planTextBatches(exact)).toEqual([exact]);
    const oneMore = { path: "g", sha: fakeSha(99), size: 1 };
    expect(planTextBatches([...exact, oneMore])).toEqual([exact, [oneMore]]);
  });

  it("never asks for a file it cannot be sure to receive whole", () => {
    // Each of these is read per file instead, where the oversize ceiling and
    // the stream lane already live.
    const ok = wantFor("src/ok.ts", "ok\n");
    const refused: TextWant[] = [
      { path: "no-size", sha: fakeSha(1), size: undefined },
      { path: "nan", sha: fakeSha(2), size: Number.NaN },
      { path: "infinite", sha: fakeSha(3), size: Number.POSITIVE_INFINITY },
      { path: "negative", sha: fakeSha(4), size: -1 },
      { path: "too-large", sha: fakeSha(5), size: PRIME_TEXT_MAX_BYTES + 1 },
    ];
    expect(planTextBatches([...refused, ok])).toEqual([[ok]]);
    // The ceiling itself is still asked.
    const atCeiling = { path: "at", sha: fakeSha(6), size: PRIME_TEXT_MAX_BYTES };
    expect(planTextBatches([atCeiling])).toEqual([[atCeiling]]);
  });

  it("never interpolates anything but a blob id into a query", () => {
    const hostile: TextWant[] = [
      { path: "upper", sha: fakeSha(1).toUpperCase().replace(/0/g, "A"), size: 1 },
      { path: "short", sha: "abc123", size: 1 },
      { path: "long", sha: `${fakeSha(1)}0`, size: 1 },
      { path: "inject", sha: `${"0".repeat(38)}"}`, size: 1 },
      { path: "empty", sha: "", size: 1 },
    ];
    expect(planTextBatches(hostile)).toEqual([]);
  });

  it("keeps the per-file ceiling well clear of where GraphQL truncates", () => {
    // `Blob.text` is cut at about 512 KB. A truncated answer fails the id
    // check anyway, but asking for one spends a response on a re-read.
    expect(PRIME_TEXT_MAX_BYTES).toBeLessThan(512 * 1024);
    expect(PRIME_TEXT_MAX_BYTES).toBeLessThanOrEqual(PRIME_TEXT_BATCH_BYTES);
  });
});

describe("textBatchQuery", () => {
  it("asks each blob by id under its batch index, with the repository as variables", () => {
    const a = wantFor("src/a.ts", "a\n");
    const b = wantFor("src/b.ts", "b\n");
    const query = textBatchQuery([a, b]);
    expect(query).toContain(
      `b0: object(oid: "${a.sha}") { ... on Blob { text isBinary isTruncated } }`,
    );
    expect(query).toContain(
      `b1: object(oid: "${b.sha}") { ... on Blob { text isBinary isTruncated } }`,
    );
    expect(query).toMatch(/^query\(\$owner: String!, \$repo: String!\)/);
    expect(query).toContain("repository(owner: $owner, name: $repo)");
    // The path is never in the query: it is ours, and the id is enough.
    expect(query).not.toContain("src/a.ts");
  });

  it("refuses to build a query around anything that is not a blob id", () => {
    expect(() => textBatchQuery([{ path: "x", sha: 'deadbeef") { x }', size: 1 }])).toThrow(
      /Not a blob id/,
    );
  });
});

describe("acceptTextAnswers", () => {
  const text = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
  const want = wantFor("src/add.ts", text);
  const whole = { text, isBinary: false, isTruncated: false };

  it("keeps a text whose blob id is the one the listing holds", () => {
    expect(acceptTextAnswers([want], { b0: whole })).toEqual(new Map([["src/add.ts", text]]));
  });

  it("drops a text that is not byte for byte the file", () => {
    // What GraphQL does to a file that is not UTF-8: a Latin-1 "é" (one byte,
    // 0xE9) comes back as U+FFFD. GitHub calls the file text, because its
    // binary test is about NUL bytes, so `isBinary` is false — and the id check
    // is the only thing that catches it.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const realSha = blobIdOfBytes(latin1);
    const latinWant: TextWant = { path: "docs/cafe.txt", sha: realSha, size: latin1.byteLength };
    const altered = { text: latin1.toString("utf8"), isBinary: false, isTruncated: false };
    expect(altered.text).toContain("�");
    expect(acceptTextAnswers([latinWant], { b0: altered }).size).toBe(0);
  });

  it("keeps a byte-order mark and CRLF exactly as the file holds them", () => {
    const crlf = "﻿line one\r\nline two\r\n";
    const crlfWant = wantFor("docs/crlf.txt", crlf);
    const got = acceptTextAnswers([crlfWant], {
      b0: { text: crlf, isBinary: false, isTruncated: false },
    });
    expect(got.get("docs/crlf.txt")).toBe(crlf);
  });

  it("drops an answer GitHub itself does not vouch for as whole text", () => {
    for (const answer of [
      { text, isBinary: true, isTruncated: false },
      { text, isBinary: false, isTruncated: true },
      { text, isBinary: null, isTruncated: false },
      { text, isBinary: false, isTruncated: null },
      { text: null, isBinary: false, isTruncated: false },
      null,
      undefined,
    ]) {
      expect(acceptTextAnswers([want], { b0: answer }).size).toBe(0);
    }
  });

  it("keeps what a partial answer carries and leaves the rest unanswered", () => {
    // A batch that failed half-way — a missing alias, a null object — says
    // nothing about those entries, and the caller reads them per file.
    const other = wantFor("src/other.ts", "export const other = true;\n");
    const got = acceptTextAnswers([want, other], {
      b1: { ...whole, text: "export const other = true;\n" },
    });
    expect([...got.keys()]).toEqual(["src/other.ts"]);
  });

  it("keeps nothing from a batch that told us nothing", () => {
    expect(acceptTextAnswers([want], null).size).toBe(0);
    expect(acceptTextAnswers([want], undefined).size).toBe(0);
    expect(
      acceptTextAnswers(
        [want],
        "not an object" as unknown as Parameters<typeof acceptTextAnswers>[1],
      ).size,
    ).toBe(0);
  });

  it("matches answers to wants by position, never by trusting the text", () => {
    // Swapped answers: each text is a real file, but not the one asked at that
    // index, so neither may be kept under the other's path.
    const other = "export const b = 2;\n";
    const otherWant = wantFor("src/b.ts", other);
    const got = acceptTextAnswers([want, otherWant], {
      b0: { text: other, isBinary: false, isTruncated: false },
      b1: whole,
    });
    expect(got.size).toBe(0);
  });
});

describe("isBatchableTextMode", () => {
  it("asks regular files, executable or not", () => {
    expect(isBatchableTextMode("100644")).toBe(true);
    expect(isBatchableTextMode("100755")).toBe(true);
  });

  it("leaves a link, a submodule and an unknown mode on the old road", () => {
    // The contents API answers a link to a file with the TARGET's content;
    // the link's own blob is its target's path. Asking by id would change
    // which bytes the prepare step receives.
    expect(isBatchableTextMode("120000")).toBe(false);
    expect(isBatchableTextMode("160000")).toBe(false);
    expect(isBatchableTextMode(undefined)).toBe(false);
    expect(isBatchableTextMode("")).toBe(false);
  });
});
