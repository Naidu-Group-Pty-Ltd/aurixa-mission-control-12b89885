/**
 * Every provisioning route arms a clone's own credentials — not only the one
 * that ends in a Vercel build.
 *
 * ## What was wrong
 *
 * Both per-clone credentials were minted by the deployment drain at
 * `syncing_env`. That case opens:
 *
 *     if (!row.project_id) return { kind: "error", error: "no project_id", ... }
 *
 * and `provisionCloneCore` writes the deployment row as `not_requested` for
 * `manual` and for `none`, and `pending_platform` when no Vercel token is
 * configured. A deployment in any of those three states never advances, so the
 * drain never reached either credential. `MODULES_TO_CLONES.md` records that
 * every clone in this fleet is served manually.
 *
 * The two fleet-wide repairs that should have caught it did not:
 *
 *   - `reconcileTurnstileIdentities` refused any clone with no `project_id`,
 *     naming `no_hosting_project` and justifying it as "the drain will mint its
 *     widget when it reaches `syncing_env`" — a step that was never coming.
 *   - `sweepEmailIdentities` selects FROM `clone_email_identities`, so a clone
 *     with no row is invisible to it for ever. Its own decision says so:
 *     "Nothing has been registered for this clone … not ours to start."
 *
 * So a clone provisioned by the agreement path, or by the wizard with anything
 * other than Vercel, had no CAPTCHA of its own — meaning a token farmed from
 * any tenant's login page satisfied its check — and could not send a password
 * reset. Both failures are silent: the clone deploys perfectly.
 *
 * ## Why these are source contracts
 *
 * The same reason `cloneCredentialArming.contract.test.ts` gives for its own:
 * the fault is an ABSENCE. Every one of these jobs keeps working correctly with
 * the call deleted — it simply stops reaching a population nobody is counting.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const EMAIL_DRAIN = read("src", "routes", "hooks.email-identity-drain.tsx");
const EMAIL_SERVER = read("src", "server", "email-identity.server.ts");
const TURNSTILE_PURE = read("src", "server", "cloneTurnstileIdentity.pure.ts");

describe("the email identity drain starts as well as advances", () => {
  it("calls the fleet-wide start", () => {
    expect(
      EMAIL_DRAIN,
      "the sweep cannot see a clone with no identity row — something has to begin one",
    ).toContain("reconcileEmailIdentities");
  });

  it("starts before it advances, so a new identity moves on the next pass", () => {
    const start = EMAIL_DRAIN.indexOf("reconcileEmailIdentities(supabaseAdmin)");
    const sweep = EMAIL_DRAIN.indexOf("sweepEmailIdentities(supabaseAdmin)");
    expect(start).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(-1);
    expect(start).toBeLessThan(sweep);
  });

  /**
   * In the drain that is already scheduled, not behind a cron entry of its
   * own. `THE_CLONING_ENGINE.md` records six pg_cron jobs that were never
   * scheduled at all — silently, each recorded as applied by a migration that
   * declined to schedule it. A new job is the likeliest way for this repair
   * never to run.
   */
  it("needs no new cron job", () => {
    expect(EMAIL_DRAIN).toContain("/hooks/email-identity-drain");
  });

  it("registers a domain rather than polling for one", () => {
    // `refresh` mints nothing. A starter that used it would leave every clone
    // with no identity while looking wired up.
    const fn = EMAIL_SERVER.slice(
      EMAIL_SERVER.indexOf("export async function reconcileEmailIdentities"),
    );
    expect(fn.slice(0, 5000)).toContain('mode: "provision"');
  });

  it("gates on a backend and not on a hosting project", () => {
    const fn = EMAIL_SERVER.slice(
      EMAIL_SERVER.indexOf("export async function reconcileEmailIdentities"),
    ).slice(0, 5000);
    expect(fn).toContain("supabase_project_ref");
    expect(fn, "requiring a hosting project is the bug this closes").not.toContain("project_id");
  });
});

describe("the turnstile sweep mints without a hosting project", () => {
  it("no longer refuses the whole act for want of one", () => {
    expect(
      TURNSTILE_PURE,
      'the blanket "no_hosting_project" refusal is what left manual clones with no widget',
    ).not.toMatch(/reason:\s*"no_hosting_project"\s*\}/);
  });

  it("holds only the site-key publish for a project", () => {
    expect(TURNSTILE_PURE).toContain("no_hosting_project_to_publish_to");
  });

  /**
   * And it WAITS there rather than retrying: a manual clone would otherwise
   * re-attempt an impossible publish on every pass and bury the identities
   * that can still be advanced.
   */
  it("does not act on a publish it cannot perform", () => {
    const branch = TURNSTILE_PURE.slice(TURNSTILE_PURE.indexOf("if (!id.site_key_published_at)"));
    const guard = branch.slice(0, branch.indexOf("return { act: true"));
    expect(guard).toContain("no_hosting_project_to_publish_to");
  });
});
