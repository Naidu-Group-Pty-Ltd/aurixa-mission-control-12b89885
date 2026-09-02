/**
 * One oversized file no longer kills the whole pass.
 *
 * Structural — where the ceiling is applied, and what a refusal becomes — so
 * asserted against the source. The behaviour of the hold itself is tested in
 * `syncExclusions.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const engine = stripComments(read("src/server/cascade-engine.server.ts"));
const github = stripComments(read("src/server/github-app.server.ts"));

const prepareStart = engine.indexOf("const prepared = await mapWithConcurrency");
const prepareEnd = engine.indexOf("const deliveredSource");
const prepare = engine.slice(prepareStart, prepareEnd);

const readStart = github.indexOf("export async function getFileContent");
const readEnd = github.indexOf("\nexport ", readStart + 10);
const fileRead = github.slice(readStart, readEnd === -1 ? undefined : readEnd);

describe("the slices this file reads exist", () => {
  it("finds the prepare step and the file read", () => {
    expect(prepareStart).toBeGreaterThan(-1);
    expect(prepareEnd).toBeGreaterThan(prepareStart);
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

  it("a refusal becomes a held path with its size, and nothing else is swallowed", () => {
    expect(prepare).toMatch(
      /if \(e instanceof OversizeFileError\) \{\s*return \{ kind: "held", held: oversizeHold\(path, e\.bytes, e\.maxBytes\) \};/,
    );
    // A hold is for the one fault it names: a GitHub outage still fails the
    // pass rather than being reported as a file somebody has to bring across.
    expect(prepare).toMatch(/\}\s*throw e;/);
  });
});

describe("the size is judged before the bytes travel", () => {
  it("the refusal precedes the blob fetch, on the metadata the contents API reports", () => {
    const check = fileRead.indexOf("throw new OversizeFileError(path, data.size, opts.maxBytes)");
    const blob = fileRead.indexOf("octokit.git.getBlob(");
    expect(check).toBeGreaterThan(-1);
    expect(blob).toBeGreaterThan(check);
  });

  it("a read with no ceiling is unchanged", () => {
    // Every other caller passes nothing and must keep reading whole files.
    expect(fileRead).toMatch(/typeof opts\?\.maxBytes === "number"/);
  });
});
