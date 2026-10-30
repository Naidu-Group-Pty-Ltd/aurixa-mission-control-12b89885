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
/** A comment quoting the deleted path is prose, not a write. */
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");


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

/**
 * A clone that rotates its own link key receives it (key audit S5). The clone's
 * function cannot store a project secret (that needs a management token, and a
 * clone never holds one), so Mission Control delivers the key itself, before
 * the old one's life is ended.
 */
describe("a self-rotated key is delivered by Mission Control, before the old one is retired", () => {
  const route = read("src/routes/api.public.clones.rotate-key.ts");
  const link = read("src/server/rotatedLinkKey.server.ts");

  it("delivers the new key before it schedules the old key's revocation", () => {
    const deliver = route.indexOf("await deliverRotatedLinkKey(supabaseAdmin, current.clone_id, newId, raw)");
    const supersede = route.indexOf(".update({ rotated_to: newId, revoke_at: revokeAt })");
    expect(deliver).toBeGreaterThan(0);
    expect(supersede).toBeGreaterThan(deliver);
  });

  it("revokes the new key, and leaves the old one, when delivery fails", () => {
    const failed = route.slice(route.indexOf("if (!delivered.ok) {"), route.indexOf("const revokeAt ="));
    expect(failed).toContain('.update({ revoked_at: new Date().toISOString() })');
    expect(failed).toContain('.eq("id", newId)');
    expect(failed).toContain('error: "delivery_failed"');
    expect(failed).not.toContain("revoke_at");
  });

  it("never hands the plaintext back: the response names where it went", () => {
    const ok = route.slice(route.lastIndexOf("return jsonResponse({"));
    expect(ok).toContain('delivered_to: "function_environment"');
    expect(ok).not.toMatch(/\bkey: raw\b/);
  });

  it("keeps a rotated link key a link key, so the link pass manages its scopes", () => {
    expect(route).toContain("current.label === MISSION_CONTROL_LINK_KEY_LABEL");
  });

  it("writes through the link pass's writer and target rule, and stamps the delivery", () => {
    const fn = link.slice(link.indexOf("export async function deliverRotatedLinkKey"));
    expect(fn).toContain("await resolveCloneSecretTarget(supabase, cloneId)");
    expect(fn).toContain("setCloneSecretValues(target.projectRef, [");
    expect(fn).toContain("{ name: ENV_MISSION_CONTROL_CLONE_API_KEY, value: raw }");
    expect(fn).toContain("delivered_env_at: nowIso, delivered_project_ref: target.projectRef");
    expect(fn).toContain("recordSecretLedger(");
  });
});
