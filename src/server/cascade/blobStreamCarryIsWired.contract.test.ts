/**
 * The streaming carry has ONE implementation, and something reaches it.
 *
 * Two source contracts, for the two ways this class of work has gone wrong in
 * this repository before.
 *
 * **Nothing renders it.** `DimensionRail`, `TitleBlock` and `bd-chip` were
 * written, documented, merged and deployed in the builder portal with zero
 * call sites, and nothing in the gate could see it: an unused export
 * typechecks, lints and builds. A carry lane nothing calls is the same
 * shape — the fifteen files would stay held and every reading would look
 * exactly as it does now.
 *
 * **Two copies of one rule.** `riskRegisterInstruction()` had zero production
 * call sites because both registries carried a verbatim copy of its output,
 * and the three had diverged by four paragraphs before anyone noticed. The
 * base64 transform and the content length are one rule each, and a second
 * copy of either would be a body that disagrees with its own header — which
 * presents as an opaque transfer failure, not as a wrong answer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "@/server/sourceComments.pure";

const github = stripComments(readFileSync("src/server/github-app.server.ts", "utf8"));
const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
const pure = stripComments(readFileSync("src/server/cascade/blobStreamCarry.pure.ts", "utf8"));

const carry = github.slice(
  github.indexOf("export async function copyBlobByStream"),
  github.indexOf("async function describeFailureBody"),
);

describe("something reaches the lane", () => {
  it("the engine routes an oversize refusal into it", () => {
    expect(engine).toContain("carryOversizeByStream");
    expect(engine).toContain("copyBlobByStream(octokit, primeRef, cloneRef, path, primeSha,");
  });

  it("the slice this file reads is the real function", () => {
    expect(carry.length).toBeGreaterThan(500);
    expect(carry).toContain("git/blobs");
  });
});

describe("the mechanics live in one module", () => {
  it("the server half composes rather than reimplements", () => {
    for (const piece of [
      "blobRequestBody",
      "blobRequestContentLength",
      "assertCarriedBlobMatches",
    ]) {
      expect(carry, `${piece} must come from blobStreamCarry.pure`).toContain(piece);
    }
    // The alphabet appears exactly once in the codebase's cascade lane, in
    // the module that owns it. A second copy is a second encoder.
    expect(carry).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
    expect(pure).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  });

  it("never decodes, and never holds the file", () => {
    /*
      The whole argument for this lane is that the bytes do not enter the
      isolate. `arrayBuffer()`, `text()` and `Buffer.from` on the response
      would each undo it silently — the code would still work, on files small
      enough to test with, and die on the ones it exists for.
    */
    expect(carry).not.toMatch(/\.arrayBuffer\(\)/);
    expect(carry).not.toMatch(/read\.text\(\)/);
    expect(carry).not.toMatch(/Buffer\.from/);
    expect(carry).toContain("read.body");
  });

  it("declares the length it will send, so the request never goes out chunked", () => {
    expect(carry).toContain('"Content-Length": String(declared)');
    // And checks it was told the truth. A size the contents API reported that
    // is not the blob's length would otherwise fail on the wire with nothing
    // saying which number was wrong.
    expect(carry).toMatch(/if \(sent !== declared\)/);
  });

  it("proves the copy against prime's own sha", () => {
    /*
      A streamed file is the one thing in a cascade whose bytes no part of
      this process ever looked at. A git blob sha is a hash of its own bytes
      and of nothing else, so equality is byte identity — there is no cheaper
      check and no better one.
    */
    expect(carry).toContain("assertCarriedBlobMatches(path, sha,");
  });

  it("counts both requests, because they are the most expensive pair made", () => {
    // Raw fetches sit outside `getAppOctokit`'s counting hook. Leaving them
    // out would understate exactly the lane most likely to exhaust a window.
    expect(carry.match(/countGithubCall\(\)/g) ?? []).toHaveLength(2);
  });
});
