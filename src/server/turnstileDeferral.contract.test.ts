/**
 * "Not yet" must never be recorded as "failed".
 *
 * Measured on the clone `npc-crm-independent-6505dc` (19 Sep 2026): the
 * wizard armed its Turnstile widget ONE SECOND after the clone row was
 * written, while the Supabase project that must hold the secret was still
 * being created — the backend was replicating RLS policies ten minutes later.
 * `provisionTurnstileIdentity` created a Cloudflare widget, could not deliver
 * its secret, deleted the widget again, and stamped the row
 * `status: failed` with `last_error: "Refusing to write the clone's Turnstile
 * secret (backend_not_provisioned)…"`.
 *
 * Every part of that is a cost paid for nothing. The condition clears on its
 * own in minutes, and the ten-minute `turnstile-reconcile` sweep would have
 * armed the widget unattended. Worse, `decideTurnstileSweep` holds off for
 * `TURNSTILE_SWEEP_COOLDOWN_MS` (thirty minutes) whenever it sees a recent
 * `last_error` — so attempting too early made the clone wait LONGER than if
 * nothing had tried at all.
 *
 * These are source contracts rather than behavioural tests because each
 * fault is an ABSENCE: the function still returns a perfectly well-formed
 * failure with the guard deleted, and the damage only shows up thirty
 * minutes later in a different module.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = readFileSync(join(__dirname, "turnstile-identity.server.ts"), "utf8");
const WIZARD = readFileSync(join(__dirname, "..", "routes", "clones.new.tsx"), "utf8");

/** Source with commentary removed — these assertions are about CODE. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

const SRC = code(SERVER);

describe("a transient refusal defers rather than failing", () => {
  it("asks where the secret would go BEFORE minting one", () => {
    // Cloudflare returns the secret on create and never again, so a mint
    // whose delivery then fails must be thrown away. Asking first costs
    // nothing and is the whole saving.
    const mint = SRC.indexOf("createTurnstileWidget");
    const preflight = SRC.indexOf("resolveCloneSecretTarget");
    expect(preflight, "the target must be resolved somewhere").toBeGreaterThan(-1);
    expect(
      preflight,
      "the pre-flight must come before the Cloudflare create, or it saves nothing",
    ).toBeLessThan(mint);
  });

  it("classifies the refusal instead of collapsing it into a string", () => {
    expect(SRC).toContain("isTransientCloneSecretRefusal");
  });

  it("never writes last_error for a deferred delivery failure", () => {
    // The widget is still deleted — an orphan nobody holds the secret for is
    // litter. What must NOT happen is the row being stamped, because that is
    // what arms the thirty-minute cooling-off.
    const at = SRC.indexOf("deleteTurnstileWidget");
    expect(at).toBeGreaterThan(-1);
    const branch = SRC.slice(at, at + 420);
    expect(branch, "the deferred branch must be chosen explicitly").toContain("delivered.deferred");
    expect(branch).toContain("site_key: null");
  });

  it("keeps a permanent refusal loud", () => {
    // target_is_prime must never be quietly retried, so `failed`/`last_error`
    // has to survive for the non-deferred case.
    const at = SRC.indexOf("deleteTurnstileWidget");
    const branch = SRC.slice(at, at + 420);
    expect(branch).toContain('status: "failed"');
    expect(branch).toContain("last_error");
  });

  it("honours the rule on the outer catch too", () => {
    // The rule is about this module, not about the two paths that happen to
    // check it first.
    const at = SRC.lastIndexOf("CloneSecretTargetError");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 200)).toContain("isTransientCloneSecretRefusal");
  });
});

describe("the wizard tells an operator the truth", () => {
  it("distinguishes a deferral from a failure", () => {
    const src = code(WIZARD);
    expect(src).toContain("r.deferred");
  });

  it("does not call a deferral 'not minted'", () => {
    // A clone is seconds old on this screen and its backend takes minutes,
    // so this is the ORDINARY path, not the exceptional one.
    const src = code(WIZARD);
    const at = src.indexOf("r.deferred");
    expect(at).toBeGreaterThan(-1);
    // Exactly the deferred arm, not the `else` after it — that one says
    // "not minted" correctly, because a permanent refusal really is one.
    const end = src.indexOf("} else {", at);
    expect(end, "the deferred arm must be followed by a real failure arm").toBeGreaterThan(at);
    const branch = src.slice(at, end);
    // Only the one label that was actually wrong. A broader ban on the word
    // "failed" rejected the copy "Nothing was created and nothing failed",
    // which says the opposite of what it matches — this repo's own rule that
    // prose is never regex-scrubbed, met from the other side.
    expect(branch).not.toContain("not minted");
    expect(branch.toLowerCase()).toContain("automatically");
  });
});
