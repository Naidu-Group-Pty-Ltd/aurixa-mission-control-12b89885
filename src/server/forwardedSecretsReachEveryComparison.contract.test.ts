/**
 * Every comparison with the prime is judged against the forward policy (PF-27).
 *
 * `diffSecrets` counts a missing credential only when the policy sends it,
 * but only where the caller passes the policy. A comparison that leaves it out
 * falls back to counting every prime credential, so the same clone would read
 * "does not match" on one page and match on another. Every caller passes it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readForwardedSecretNames } from "./handoff-parity.server";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("the forward policy reaches every comparison", () => {
  it("every call to computeParity passes forwardedSecretNames", () => {
    const calls: Array<{ file: string; args: string }> = [];
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("await computeParity(");
      while (at !== -1) {
        // The options object ends at the call's own close; nested IIFEs close `})()`.
        calls.push({ file, args: text.slice(at, text.indexOf("});", at)) });
        at = text.indexOf("await computeParity(", at + 1);
      }
    }
    // The finishing pass, the late catch-up, the handoff page and its refresh.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.args, call.file).toMatch(/forwardedSecretNames:/);
      expect(call.args, call.file).toMatch(/withheldSecretNames:/);
    }
  });

  it("reads an unreadable policy as null, never as nothing sent", async () => {
    const failing = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: "permission denied" } }),
        };
        return chain;
      },
    };
    const sent = await readForwardedSecretNames(failing as never, "clone-1");
    expect(sent).toBeNull();
  });

  it("reads the fleet and the clone's own rows into the policy's answer", async () => {
    const rows: Record<string, unknown> = {
      prime_secret_forwards: [
        { name: "RESEND_API_KEY", inherit: true },
        { name: "STRIPE_SECRET_KEY", inherit: false },
      ],
      clone_secret_forwards: [{ name: "DOCUSIGN_INTEGRATION_KEY" }],
      clones: { crm_mode: "independent" },
    };
    const fake = {
      from: (table: string) => {
        const answer = { data: rows[table], error: null };
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve(answer),
          then: (resolve: (v: unknown) => void) => resolve(answer),
        };
        return chain;
      },
    };
    const sent = await readForwardedSecretNames(fake as never, "clone-1");
    expect(sent).toEqual(["DOCUSIGN_INTEGRATION_KEY", "RESEND_API_KEY"]);
  });
});
