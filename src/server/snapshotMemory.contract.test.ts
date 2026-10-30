import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractSecretNames } from "./prime-backend.server";
import { stripComments } from "./sourceComments.pure";

/**
 * A prime snapshot must fit the worker that takes it.
 *
 * The runtime kills an invocation that outgrows its isolate, with a bare HTTP
 * 502 and no record — a hard death the provisioning drain can only count, and
 * three of them in a row fail the job. Measured 29 Oct 2026 on the prime's own
 * tree (402 bundles, 2,395 files, 44 MB of base64 held by the blob cache), the
 * snapshot held two more copies on top of that cache at once:
 *
 *  - the deploy prune, through `textOf` alone, kept 855 decoded files live
 *    (43.5 MB);
 *  - the secret scan decoded every file into one array before scanning it
 *    (79.3 MB).
 *
 * That killed three edge-function passes in a row on
 * `tutorial-demo-orrimere-c158c7` (22:13, 22:28, 22:44 UTC) and failed the
 * clone. Both now hold one file at a time: the same tree peaks at 23.0 MB above
 * the cache, the 402 bundles prune to identical keep lists, and the scan names
 * the same 169 secrets.
 */
const snapshotSource = () => {
  const src = stripComments(readFileSync("src/server/prime-backend.server.ts", "utf8"));
  const start = src.indexOf("export async function fetchPrimeBackendSnapshot(");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
};

describe("the prime snapshot holds one decoded file at a time", () => {
  it("prunes the bundles it deploys through the specifier memo, not through kept texts", () => {
    const body = snapshotSource();
    const memoAt = body.indexOf("const specifiersOf = memoisedSpecifiers(decodedText);");
    const planAt = body.indexOf("if (opts?.planSkip)");
    // Declared once, outside the planner's block, so both prunes share it.
    expect(memoAt).toBeGreaterThan(-1);
    expect(memoAt).toBeLessThan(planAt);
    const deploy = body.slice(body.indexOf("const functions: PrimeEdgeFunction[] = selected.map("));
    const prune = deploy.slice(deploy.indexOf("pruneBundleToReachable({"), deploy.indexOf("});"));
    expect(prune).toMatch(/\bspecifiersOf\b/);
  });

  it("scans for secret names file by file, never through an array of every decoded file", () => {
    const body = snapshotSource();
    expect(body).not.toMatch(/textSources/);
    expect(body).toMatch(/extractSecretNames\(\[decodeBase64Utf8\(f\.contentBase64\)\]\)/);
  });

  it("names exactly what one scan over every file names", () => {
    const files = [
      `const a = Deno.env.get("OPENAI_API_KEY");`,
      `Deno.env.get('RESEND_API_KEY'); Deno.env.get("OPENAI_API_KEY")`,
      "// nothing here",
      "const s = Deno.env.get(`STRIPE_SECRET_KEY`); Deno.env.get('SUPABASE_URL');",
    ];
    const union = new Set<string>();
    for (const file of files) for (const name of extractSecretNames([file])) union.add(name);
    expect(Array.from(union).sort()).toEqual(extractSecretNames(files));
  });
});
