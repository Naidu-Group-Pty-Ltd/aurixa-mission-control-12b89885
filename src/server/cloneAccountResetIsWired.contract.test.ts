/**
 * The account reset is reachable, gated and silent about the password.
 *
 * Shipped means used: the panel is on the clone page, beside the other demo
 * sign-in lever. Both server functions are admin-only, as every other clone
 * credential write is. And the audit row, the one record that outlives the
 * request, names the account and never carries the password.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FUNCTIONS = readFileSync("src/lib/clone-account-reset.functions.ts", "utf8");
const PAGE = readFileSync("src/routes/clones.$cloneId.tsx", "utf8");
const CARD = readFileSync("src/components/clone-account-reset-card.tsx", "utf8");

describe("the account reset", () => {
  it("is on the clone page, after the CAPTCHA card", () => {
    const captcha = PAGE.indexOf("<CloneTurnstileCard cloneId={cloneId} />");
    const reset = PAGE.indexOf("<CloneAccountResetCard cloneId={cloneId} />");
    expect(captcha).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(captcha);
  });

  it("is admin-only, both to read and to reset", () => {
    for (const name of ["getCloneAccountResetEligibility", "resetCloneDemoAccountFn"]) {
      const at = FUNCTIONS.indexOf(`export const ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      expect(FUNCTIONS.slice(at, at + 200), name).toContain(".middleware([requireAdmin])");
    }
  });

  it("audits the account and what happened, never the password", () => {
    const at = FUNCTIONS.indexOf('action: "clone_account.reset"');
    expect(at).toBeGreaterThan(-1);
    const insert = FUNCTIONS.slice(at, FUNCTIONS.indexOf("});", at));
    expect(insert).toContain("account:");
    expect(insert).not.toMatch(/password/i);
  });

  it("offers the form only where the server says the clone is a demo", () => {
    expect(CARD).toMatch(/!eligibility\?\.eligible \?/);
    expect(CARD).toContain("eligibility?.reason");
  });
});
