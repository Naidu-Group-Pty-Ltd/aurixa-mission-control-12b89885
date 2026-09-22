/**
 * One oversized file no longer kills the whole pass — and no longer stops.
 *
 * Structural — where the ceiling is applied, and what a refusal becomes — so
 * asserted against the source. The behaviour of the hold itself is tested in
 * `syncExclusions.test.ts`, and the stream mechanics in
 * `blobStreamCarry.test.ts`.
 *
 * What this file asserted until 22 Sep 2026 was that a refusal becomes a
 * hold, verbatim and immediately. That was the whole remedy then and it is
 * half of one now: a file too large to READ is carried as a stream instead,
 * and the hold is what is left when even that cannot be done. The tests below
 * pin the property that survives both versions — **nothing is swallowed** —
 * and add the one the new lane needs, which is that every way it declines
 * still ends in a hold rather than in a throw that takes the pass with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const engine = stripComments(read("src/server/cascade-engine.server.ts"));
const github = stripComments(read("src/server/github-app.server.ts"));

// Anchored on the function that HOLDS the per-file judgement rather than on
// the call that drives it. The two were the same expression until the body
// was named so a stranded spec's subject could be put through it a second
// time; slicing from the call site then began one line after everything this
// file is about.
const prepareStart = engine.indexOf("const prepareOne = async (path: string)");
const prepareEnd = engine.indexOf("const deliveredSource");
const prepare = engine.slice(prepareStart, prepareEnd);

// The lane a refusal is handed to. Sliced separately because the two are
// asked different questions: the prepare step must route to it and swallow
// nothing else, and the lane itself must never throw.
const carryStart = engine.indexOf("const carryOversizeByStream = async");
const carry = engine.slice(carryStart, prepareStart);

const readStart = github.indexOf("export async function getFileContent");
const readEnd = github.indexOf("\nexport ", readStart + 10);
const fileRead = github.slice(readStart, readEnd === -1 ? undefined : readEnd);

describe("the slices this file reads exist", () => {
  it("finds the prepare step, the carry lane and the file read", () => {
    expect(prepareStart).toBeGreaterThan(-1);
    expect(prepareEnd).toBeGreaterThan(prepareStart);
    expect(carryStart).toBeGreaterThan(-1);
    expect(carry.length).toBeGreaterThan(400);
    expect(readStart).toBeGreaterThan(-1);
    expect(fileRead.length).toBeGreaterThan(200);
  });
});

describe("the prime read is given the ceiling", () => {
  it("and it is the shared constant, not a literal", () => {
    expect(prepare).toMatch(
      /getFileContent\(octokit, primeRef, path, \{\s*maxBytes: CASCADE_MAX_FILE_BYTES,?\s*\}\)/,
    );
  });

  it("a refusal is handed to the carry lane, and nothing else is swallowed", () => {
    expect(prepare).toMatch(
      /if \(e instanceof OversizeFileError\) \{\s*return await carryOversizeByStream\(e, path, fileStartedAt\);\s*\}/,
    );
    // A hold is for the one fault it names: a GitHub outage still fails the
    // pass rather than being reported as a file somebody has to bring across.
    expect(prepare).toMatch(/\}\s*throw e;/);
  });
});

describe("the carry lane declines by holding, never by throwing", () => {
  it("has no throw in it at all", () => {
    /*
      This is the property the ceiling was introduced for, moved one level
      down. A carry that failed must not take the forty-seven files beside it
      with it — and unlike the read, a carry has four ways to fail (prime
      refuses, the clone refuses, the body is the wrong length, the bytes are
      not the file), every one of them reaching this function as an exception.
    */
    expect(carry).not.toMatch(/\bthrow\b/);
    expect(carry).toContain("catch (carryError)");
  });

  it("names which decline it was, because they send an operator three ways", () => {
    // Past GitHub's ceiling: nothing retries it, and no approval releases it.
    expect(carry).toContain("CASCADE_STREAM_MAX_FILE_BYTES");
    // Allowance spent: not a failure, and the next pass continues by itself.
    expect(carry).toContain("CASCADE_STREAM_BYTES_PER_PASS");
    // A carry that failed: the message is carried through rather than lost.
    expect(carry).toMatch(/carryError instanceof Error \? carryError\.message/);
  });

  it("ledgers a streamed blob, so a seed is carried once per event", () => {
    /*
      Without this a 39 MB file is re-streamed on every tick of the same
      event. `resumableBlobs` matches on prime's sha, and a streamed blob's
      sha IS prime's sha — a git blob is a hash of its own bytes — so the
      reuse is exact rather than optimistic.
    */
    expect(carry).toMatch(/progress\.prepared\[path\] = \{ blob: blobSha, prime: primeSha \}/);
  });
});

describe("the size is judged before the bytes travel", () => {
  it("the refusal precedes the blob fetch, on the metadata the contents API reports", () => {
    const check = fileRead.indexOf(
      "throw new OversizeFileError(path, data.size, opts.maxBytes, data.sha)",
    );
    const blob = fileRead.indexOf("octokit.git.getBlob(");
    expect(check).toBeGreaterThan(-1);
    expect(blob).toBeGreaterThan(check);
  });

  it("the refusal names the blob, which is the only thing a carry needs", () => {
    /*
      A blob is content-addressed, so the sha IS the file: a copy made from it
      can be proved against it without anyone reading either. The refusal is
      thrown while holding it, so passing it costs nothing and not passing it
      would mean the carry lane going back to GitHub for something the failed
      read already had.
    */
    expect(fileRead).toContain("data.sha");
    expect(github).toMatch(/readonly sha\?: string,/);
  });

  it("a read with no ceiling is unchanged", () => {
    // Every other caller passes nothing and must keep reading whole files.
    expect(fileRead).toMatch(/typeof opts\?\.maxBytes === "number"/);
  });
});
