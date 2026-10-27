/**
 * Every merge names the head whose checks it judged.
 *
 * ## What this is here to make impossible
 *
 * `pulls.merge` without `sha` merges whatever the branch holds when the call
 * lands, not the head that was read. The engine refreshes an open cascade
 * proposal in place with a force push (`git.updateRef(…, force)`), and since
 * 27 Sep 39 of 134 merged cascade pull requests on the dashboard and 21 of 51
 * on the CRM line carried content from a newer prime commit than their branch
 * was cut for. So a refresh landing between a check read and an unpinned
 * merge puts a tree no CI has built on a tenant's `main`, and every clone's
 * `main` reads `protected: false`, so GitHub checks nothing of its own. The
 * merge drain and the engine's inline merge were both unpinned until the
 * audit of 27 Oct 2026. The lateral lane always pinned.
 *
 * Structural, so asserted against the source: the call sites are DERIVED from
 * every server module, never listed, so a new merge is judged the day it is
 * written.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@/server/sourceComments.pure";

const ROOT = "src/server";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Each `pulls.merge({ … })` call's argument object, by file. */
function mergeCalls(): Array<{ file: string; args: string }> {
  const calls: Array<{ file: string; args: string }> = [];
  for (const file of sources(ROOT)) {
    const code = stripComments(readFileSync(file, "utf8"));
    let at = code.indexOf("pulls.merge(");
    while (at !== -1) {
      const open = code.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < code.length; end++) {
        if (code[end] === "{") depth++;
        else if (code[end] === "}" && --depth === 0) break;
      }
      calls.push({ file, args: code.slice(open, end + 1) });
      at = code.indexOf("pulls.merge(", end);
    }
  }
  return calls;
}

describe("a merge is pinned to the head it judged", () => {
  const calls = mergeCalls();

  it("finds the merges at all", () => {
    // The merge drain, the engine's inline merge and the lateral lane. Fewer
    // means the derivation broke and the assertion below proves nothing.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const files = new Set(calls.map((c) => c.file));
    expect(files).toContain(join(ROOT, "cascadeMergeDrain.server.ts"));
    expect(files).toContain(join(ROOT, "cascade-engine.server.ts"));
    expect(files).toContain(join(ROOT, "lateral-exchange.server.ts"));
  });

  for (const { file, args } of calls) {
    it(`${file} names the head it merges`, () => {
      expect(args).toMatch(/\bsha:\s*[A-Za-z_][\w.]*/);
    });
  }

  it("the drain names the head it read the checks on, and holds when GitHub refuses it", () => {
    const drain = stripComments(readFileSync(join(ROOT, "cascadeMergeDrain.server.ts"), "utf8"));
    expect(drain).toContain("ref: pr.head.sha,");
    expect(drain).toContain("sha: pr.head.sha,");
    // A moved head is the next pass's work, not a failure to report.
    const refusal = drain.slice(drain.indexOf("sha: pr.head.sha,"));
    expect(refusal).toMatch(/status === 409\)\s*\{[\s\S]*?reason: "head_moved"/);
  });

  it("the engine names the head it read the checks on", () => {
    const engine = stripComments(readFileSync(join(ROOT, "cascade-engine.server.ts"), "utf8"));
    expect(engine).toContain("ref: proposal.headSha,");
    expect(engine).toContain("sha: proposal.headSha,");
  });
});
