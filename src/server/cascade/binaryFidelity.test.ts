import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The cascade must deliver a file's BYTES, not a reading of them.
 *
 * `getFileContent` used to return only the UTF-8 decoding, and the engine wrote
 * it back with `Buffer.from(content, "utf8")`. For text that is a faithful
 * round trip. For anything else it is destruction.
 *
 * Measured on 30 Aug 2026: `public/brand/aurixa-emblem-240.png` is 78,450 bytes
 * of valid PNG in prime and 142,140 bytes on the clone — 1.81x, and no longer a
 * PNG. It had been re-delivered and re-corrupted by every cascade carrying it.
 * 144 binary files were exposed, including 86 `.docx` partner agreement
 * templates that both portals hand to partners as byte-identical files.
 */
describe("what a UTF-8 round trip does to bytes", () => {
  // A PNG header plus bytes that are not valid UTF-8 — the shape of every
  // image, font, PDF and .docx in the tree.
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xc3, 0x28, 0xa0, 0x80, 0xfe, 0xff,
  ]);

  it("destroys them, and inflates the file doing it", () => {
    const throughUtf8 = Buffer.from(png.toString("utf8"), "utf8");
    expect(throughUtf8.equals(png)).toBe(false);
    // Bigger, not smaller: an invalid byte becomes U+FFFD, three bytes where
    // there was one. That is the 1.81x seen in production.
    expect(throughUtf8.length).toBeGreaterThan(png.length);
  });

  it("leaves the bytes exactly as they were when carried as base64", () => {
    // What the engine does now: prime's base64, passed through untouched.
    const carried = Buffer.from(png.toString("base64"), "base64");
    expect(carried.equals(png)).toBe(true);
  });

  it("is lossless for text, which is why this went unnoticed", () => {
    const text = Buffer.from('export const A = 1; // héllo · ünïcode\n', "utf8");
    expect(Buffer.from(text.toString("utf8"), "utf8").equals(text)).toBe(true);
  });

  it("detects binary by round-tripping rather than by extension", () => {
    // An extension list goes stale and cannot know about a text file with an
    // image extension, or the reverse. The round trip IS the property.
    const isBinary = (b: Buffer) => !Buffer.from(b.toString("utf8"), "utf8").equals(b);
    expect(isBinary(png)).toBe(true);
    expect(isBinary(Buffer.from("plain text", "utf8"))).toBe(false);
    expect(isBinary(Buffer.from("", "utf8"))).toBe(false);
  });
});

describe("the engine writes bytes, not readings", () => {
  const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");
  const github = readFileSync(join(process.cwd(), "src/server/github-app.server.ts"), "utf8");

  it("never re-encodes a UTF-8 reading into a blob", () => {
    // Comments stripped first: the engine's own header quotes the expression
    // that corrupted production, so a whole-file scan would flag the
    // explanation of the fix as the fix's absence.
    const code = engine
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/Buffer\.from\(\s*primeFile\.content\s*,\s*["']utf8["']\s*\)/);
  });

  it("passes prime's own base64 straight into createBlob", () => {
    const at = engine.indexOf("createBlob({");
    expect(at).toBeGreaterThan(-1);
    const call = engine.slice(at, at + 300);
    expect(call).toContain("primeFile.base64");
    expect(call).toContain('encoding: "base64"');
  });

  it("compares files by blob SHA, never by their decoded text", () => {
    // Two different binaries decode to the same string of replacement
    // characters, so comparing readings reports a changed image as unchanged
    // and never delivers it.
    expect(engine).not.toContain("cloneFile.content === primeFile.content");
    expect(engine).toContain("cloneFile.sha === primeFile.sha");
  });

  it("keeps the reader honest about which half is lossy", () => {
    expect(github).toContain("binary: !Buffer.from(content, \"utf8\").equals(raw)");
  });

  it("refetches past the contents API's 1 MB ceiling instead of writing nothing", () => {
    // Over 1 MB, `repos.getContent` answers with an empty body and
    // `encoding: "none"`, which the old code read as an empty file — so a
    // large file would have landed on the clone as ZERO bytes. Prime carries a
    // 3.4 MB font archive and a 1.6 MB PDF.
    const at = github.indexOf("getFileContent");
    const fn = github.slice(at, at + 3000);
    expect(fn).toContain("git.getBlob");
    expect(fn).toContain('data.encoding !== "base64"');
  });
});
