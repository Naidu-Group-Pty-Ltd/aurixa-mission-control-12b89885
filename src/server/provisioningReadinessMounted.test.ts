/**
 * The readiness answer is mounted where the decision is made.
 *
 * `readiness.pure.ts` has carried the whole catalogue — Vercel, Cloudflare
 * (DNS *and* each clone's Turnstile widget), Resend, the GitHub App, the
 * Supabase management token — since it was written, and it was rendered in
 * exactly one place: `/health`. The New Clone wizard showed none of it, so an
 * operator picked Vercel, reserved a subdomain, provisioned, and found out
 * afterwards from a deployment row parked at `pending_platform` and a login
 * page whose CAPTCHA never appeared.
 *
 * An unused export typechecks, lints and builds. The sibling product repo has
 * already paid for exactly this — three components written, documented, merged
 * and deployed with zero call sites, and nothing in its gate could see it —
 * and answered with a mount guard. This is that guard.
 *
 * It reads source rather than rendering, because this repository's vitest runs
 * in a Node environment with no DOM and no testing-library. A mount assertion
 * that needs neither is worth more than a render test nobody can run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

/**
 * Source with its commentary removed.
 *
 * This repository documents its reasoning at length and in the negative —
 * the panel's own header explains why it says "no gaps" rather than
 * "healthy", and the wizard carries a comment naming the unfalsifiable line
 * it replaced. A test that scans raw source therefore fails on the
 * documentation of the very rule it is checking, which teaches the next
 * person to delete the comment. What these assertions are about is what the
 * component RENDERS, so that is what they read.
 */
function rendered(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ") // JSX comment expressions
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, JSDoc included
    .replace(/(^|[^:])\/\/.*$/gm, "$1 "); // line comments, sparing `https://`
}

const WIZARD_SOURCE = readFileSync(join(ROOT, "src", "routes", "clones.new.tsx"), "utf8");
const PANEL_SOURCE = readFileSync(
  join(ROOT, "src", "components", "provisioning-readiness-panel.tsx"),
  "utf8",
);
const WIZARD = rendered(WIZARD_SOURCE);
const PANEL = rendered(PANEL_SOURCE);

describe("the New Clone wizard renders the readiness answer", () => {
  it("mounts the panel", () => {
    expect(WIZARD).toContain("<ProvisioningReadinessPanel");
    expect(WIZARD).toContain("useProvisioningReadiness()");
  });

  /**
   * One read for the page. A `CapabilityNote` that fetched for itself would
   * fire a request per section, and the sections would be free to disagree
   * with the panel above them about the same capability.
   */
  it("reads readiness exactly once and passes it down", () => {
    expect(WIZARD.match(/useProvisioningReadiness\(\)/g) ?? []).toHaveLength(1);
    // Both consumers take the reading as a prop rather than calling for it.
    expect(PANEL).toContain("readiness: ProvisioningReadiness");
    expect(PANEL).toContain("readiness,");
  });

  /**
   * Each section that depends on a credential says so IN the section.
   *
   * These three are the ones an operator sets on this page and cannot
   * otherwise find out about: the hosting provider they pick, the subdomain
   * they reserve (which is also the clone's Turnstile widget), and the admin
   * account they create (which needs outbound mail to be reachable).
   */
  it.each(["hosting", "dns", "email"])("notes the %s capability beside its control", (key) => {
    expect(WIZARD).toContain(`capabilityKey="${key}"`);
  });

  /**
   * The copy these replaced warned that something MIGHT be true without ever
   * saying whether it was — "Dormant if no hosting token is configured",
   * "Dormant if Cloudflare isn't configured yet". A conditional hypothetical
   * beside a control an operator is about to use is not a disclosure.
   */
  it.each([
    "Dormant if no hosting token is configured",
    "Dormant if Cloudflare isn't configured yet",
  ])("no longer carries the unfalsifiable line %j", (phrase) => {
    expect(WIZARD).not.toContain(phrase);
  });

  /**
   * It discloses; `provisionClone` refuses. Two gates is how one of them
   * becomes wrong, and presence-only readiness is the wrong one to gate on —
   * a token that is set may still be revoked, and a token that is missing may
   * be about to land.
   */
  it("does not block the submit on readiness", () => {
    expect(WIZARD).not.toMatch(/disabled=\{[^}]*readiness[^}]*\}/);
    expect(WIZARD).not.toMatch(/if\s*\(\s*!?\s*readiness[^)]*\)\s*return/);
  });
});

describe("the panel keeps readiness honest", () => {
  it("scopes itself with the flag the report carries, not a local list", () => {
    expect(PANEL).toContain("onClonePath");
    // `CLONE_PATH` lives under `src/server/**`, which the import-protection
    // plugin denies to the client bundle. A component importing the VALUE
    // fails the build; one keeping its own copy drifts.
    expect(PANEL).not.toContain("CLONE_PATH");
  });

  it("renders the caveat off the report rather than writing its own", () => {
    expect(PANEL).toContain("report.caveat");
  });

  it("never calls a present credential working", () => {
    for (const word of ["healthy", "all good", "verified", "working"]) {
      expect(PANEL.toLowerCase()).not.toContain(word);
    }
  });

  /**
   * A failed read is a third answer. Collapsing it into "unconfigured" sends
   * an operator to fix something that is not broken.
   */
  it("keeps a failed read distinct from an unconfigured deployment", () => {
    expect(PANEL).toContain("Could not check");
    expect(PANEL).toContain("not the same as it being");
  });
});
