/**
 * Every hand-rolled GitHub request names itself.
 *
 * Octokit sets a User-Agent on every call it makes, so this only ever bites a
 * raw `fetch` — and a raw fetch is what took `npc-test-76b3b3` out of the
 * fleet for three days with a 403 whose body said, in GitHub's own words,
 * "Please make sure your request has a User-Agent header". See
 * `githubUserAgent.pure.ts`.
 *
 * The guard is a source scan rather than a runtime assertion because the
 * failure is not reachable from a test: it needs GitHub, a real installation
 * token and a blob big enough to take the streaming path. A second
 * hand-rolled call is, by contrast, trivially readable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_USER_AGENT } from "./githubUserAgent.pure";

const SRC = join(process.cwd(), "src");

/** How far past a `fetch(` to read for the call's own options object. */
const CALL_WINDOW = 1_400;

/**
 * Comments are removed before anything is judged.
 *
 * Found by planting the defect this file exists to catch: deleting the header
 * from `fetchBlobTextStream` left the comment ABOVE it in place, the comment
 * says the words "User-Agent", and the scan passed. A guard a comment can
 * satisfy is worse than no guard, because it reads as coverage.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The header must be SET, not merely mentioned. Matches the object key in any
 * of the three quotings TypeScript admits for it.
 */
const SETS_USER_AGENT = /(["'`])User-Agent\1\s*:/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Every `fetch(` whose call text names the GitHub API, with that text. */
function githubFetchCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("fetch(", from);
    if (at === -1) break;
    from = at + 6;
    const window = source.slice(at, at + CALL_WINDOW);
    if (window.includes("api.github.com")) calls.push(window);
  }
  return calls;
}

describe("every raw GitHub fetch carries a User-Agent", () => {
  const files = sourceFiles(SRC);

  it("finds source to judge at all", () => {
    // A scan over nothing passes vacuously, which is the one way this guard
    // could be worse than no guard.
    expect(files.length).toBeGreaterThan(100);
  });

  it("names a User-Agent on each one", () => {
    const offenders: string[] = [];
    let judged = 0;
    for (const file of files) {
      for (const call of githubFetchCalls(stripComments(readFileSync(file, "utf8")))) {
        judged += 1;
        if (!SETS_USER_AGENT.test(call)) offenders.push(file.replace(SRC, "src"));
      }
    }
    // The streaming blob read in prime-backend.server.ts is the one this
    // exists for; if it stops being found, the scan has stopped working.
    expect(judged).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("sends a non-empty identifier, since an empty header is the same refusal", () => {
    expect(GITHUB_USER_AGENT.trim().length).toBeGreaterThan(0);
  });
});
