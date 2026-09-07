/**
 * A Mission Control key is delivered to the clone's ENVIRONMENT, and to
 * nowhere else. In particular it is never committed to the clone's repository.
 *
 * What this replaces: `cascadeApiKeyToRepo` wrote the key in plaintext to
 * `.aurixa/credentials.json` on the clone's default branch, at provisioning
 * and again on every rotation, refusing only a public repository. Nothing read
 * that file — not in the prime, not in a clone, not in a workflow — so the key
 * it delivered had no consumer at all: both keys ever minted that way show
 * `first_used_at` and `last_used_at` NULL, from 30 Aug and 1 Sep 2026.
 *
 * The permanence is the point. A later cascade overwrote the file, so it is
 * absent from `main` and present in history: commit 79d3a13 of
 * `preflight-property-group` still serves the full key in plaintext to anyone
 * with repository access, and only a history rewrite removes it. Both keys are
 * revoked; the writer is DELETED rather than left unused, because a dormant
 * helper that commits a live credential is one import away from committing
 * another and there is nothing left for it to deliver.
 *
 * Source-level assertions, for the reason `backendSync.contract.test.ts`
 * gives: a double that agrees with the code teaches nothing about the server.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLONE_API_SCOPES, DEFAULT_SCOPES } from "@/lib/clone-api-scopes";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** A comment quoting the deleted path is prose, not a write. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("nothing writes a credential into a clone's repository", () => {
  it("the writer is gone from the tree, not merely unused", () => {
    expect(existsSync(join(process.cwd(), "src/server/clone-credentials.server.ts"))).toBe(false);
  });

  it("no module calls it or names the path it wrote", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.endsWith("cloneCredentialDelivery.contract.test.ts")) continue;
      const code = stripComments(read(file));
      if (code.includes("cascadeApiKeyToRepo")) offenders.push(`${file}: cascadeApiKeyToRepo`);
      if (code.includes(".aurixa/credentials.json")) offenders.push(`${file}: credentials path`);
    }
    expect(offenders).toEqual([]);
  });

  it("provisioning mints no second key for a channel that no longer exists", () => {
    // The `auto-provisioned` label existed only to be committed. Without the
    // write it would be a live credential with no delivery channel at all —
    // freshly manufactured, per clone, for ever.
    const provisioning = stripComments(read("src/server/clone-provisioning.server.ts"));
    expect(provisioning).not.toContain('"auto-provisioned"');
    expect(provisioning).not.toContain("new_key_secret");
  });
});

describe("self-rotation is reachable by the key that is actually delivered", () => {
  it("the rotate scope is in the catalogue at all", () => {
    // It was required by `api.public.clones.rotate-key.ts` and absent here, so
    // no key an operator could issue — and no key the link delivers — could
    // ever satisfy it.
    expect(CLONE_API_SCOPES.map((s) => s.value)).toContain("clones:rotate");
  });

  it("and it is one of the defaults the link key is minted with", () => {
    expect(DEFAULT_SCOPES).toContain("clones:rotate");
  });

  it("the endpoint still demands it", () => {
    expect(read("src/routes/api.public.clones.rotate-key.ts")).toContain('"clones:rotate"');
  });
});
