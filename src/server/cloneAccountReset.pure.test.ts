/**
 * The account reset's rules (`cloneAccountReset.pure.ts`): who may be reset,
 * which passwords may be set, what the statement writes, and that the
 * password never leaves in an error.
 */
import { describe, it, expect } from "vitest";
import {
  accountIdentifierRefusal,
  accountResetMissLine,
  accountResetRefusal,
  buildAccountResetSql,
  dollarQuoteTag,
  readAccountResetOutcome,
  resetFailureLine,
  resetPasswordRefusal,
  scrubCredential,
} from "./cloneAccountReset.pure";
import { demoCloneRefusal } from "./demoClone.pure";
import { testPairRefusal } from "./cloneTurnstileIdentity.pure";

const DEMO = { billing_stripe_customer_id: null, entitled_plan_slug: null, tags: ["demo"] };

describe("who may be reset: a demo, by the same rule as the test pair", () => {
  it("a clone tagged demo, with no plan and no Stripe customer", () => {
    expect(demoCloneRefusal(DEMO)).toBeNull();
    expect(accountResetRefusal(DEMO)).toBeNull();
  });

  it("never a clone somebody pays for or is entitled to", () => {
    expect(accountResetRefusal({ ...DEMO, billing_stripe_customer_id: "cus_1" })).toMatch(/Stripe/);
    expect(accountResetRefusal({ ...DEMO, entitled_plan_slug: "growth" })).toMatch(/growth plan/);
  });

  it("never a clone its operator has not marked a demo", () => {
    expect(accountResetRefusal({ ...DEMO, tags: null })).toMatch(/tagged demo/);
    expect(accountResetRefusal({ ...DEMO, tags: ["internal"] })).toMatch(/tagged demo/);
  });

  it("refuses exactly where the test pair refuses, because both ask one rule", () => {
    const cases = [
      DEMO,
      { ...DEMO, billing_stripe_customer_id: "cus_1" },
      { ...DEMO, entitled_plan_slug: "launch" },
      { ...DEMO, tags: [] },
    ];
    for (const clone of cases) {
      expect(accountResetRefusal(clone) === null).toBe(testPairRefusal(clone) === null);
    }
  });
});

describe("which passwords may be set", () => {
  it("takes what the product takes: 12 or more, two classes", () => {
    expect(resetPasswordRefusal("abcdefgh1234")).toBeNull();
    expect(resetPasswordRefusal("N3w-pass'word-xyz")).toBeNull();
  });

  it("refuses what the product refuses", () => {
    expect(resetPasswordRefusal("Short-1")).toMatch(/at least 12/);
    expect(resetPasswordRefusal("alllowercaseletters")).toMatch(/two of/);
  });

  it("refuses what bcrypt would silently cut short", () => {
    expect(resetPasswordRefusal("a1".repeat(36))).toBeNull();
    expect(resetPasswordRefusal("a1".repeat(36) + "x")).toMatch(/72 bytes/);
    // Bytes, not characters: 24 three-byte characters are 72 bytes.
    expect(resetPasswordRefusal("€".repeat(24) + "a")).toMatch(/72 bytes/);
  });

  it("refuses what one SQL literal cannot carry", () => {
    expect(resetPasswordRefusal("abc\\defgh1234")).toMatch(/backslash/);
    expect(resetPasswordRefusal("abcdefgh1234\n")).toMatch(/line break/);
  });
});

describe("which accounts may be named", () => {
  it("a username or an email", () => {
    expect(accountIdentifierRefusal("alex.morgan")).toBeNull();
    expect(accountIdentifierRefusal("jamie.chen@orrimere.example")).toBeNull();
  });

  it("nothing else", () => {
    expect(accountIdentifierRefusal("  ")).toMatch(/Name the account/);
    expect(accountIdentifierRefusal("alex'; drop table x;--")).toMatch(/letters, digits/);
  });
});

describe("the statement", () => {
  const sql = (clearAuthenticator: boolean) =>
    buildAccountResetSql({
      account: "  Alex.Morgan ",
      password: "N3w-pass'word-xyz",
      clearAuthenticator,
    });

  it("writes what the product's own reset writes, to the one account named", () => {
    const s = sql(false);
    expect(s).toContain("lower(username) = 'alex.morgan' or lower(email) = 'alex.morgan'");
    expect(s).toContain("and deleted_at is null");
    expect(s).toContain(
      "set password_hash = extensions.crypt('N3w-pass''word-xyz', extensions.gen_salt('bf', 10))",
    );
    expect(s).toContain("failed_login_attempts = 0");
    expect(s).toContain("locked_until = null");
    expect(s).toContain("delete from public.user_sessions where user_id = v_id");
  });

  it("refuses an account that is not alone, or not active, before writing anything", () => {
    const s = sql(false);
    const write = s.indexOf("update public.custom_users");
    expect(s.indexOf("'ambiguous'")).toBeLessThan(write);
    expect(s.indexOf("'inactive'")).toBeLessThan(write);
    expect(s.indexOf("'no_account'")).toBeLessThan(write);
  });

  it("clears the authenticator only when asked", () => {
    expect(sql(false)).not.toContain("mfa_secret_encrypted");
    expect(sql(false)).not.toContain("user_webauthn_credentials");
    const s = sql(true);
    for (const column of ["mfa_enrolled_at", "mfa_secret_encrypted", "mfa_recovery_codes_hash"]) {
      expect(s).toContain(`'${column}'`);
    }
    expect(s).toContain("delete from public.mfa_totp_enrollment_challenges where user_id = v_id");
    expect(s).toContain("delete from public.user_webauthn_credentials where user_id = v_id");
  });

  it("checks the password it wrote, on the clone", () => {
    expect(sql(false)).toContain(
      "password_hash = extensions.crypt('N3w-pass''word-xyz', password_hash)",
    );
  });

  it("sets every setting before reading any, so an earlier run is never read as this one", () => {
    const s = sql(true);
    const firstRead = s.indexOf("current_setting(");
    for (const key of ["", "_verifies", "_authenticator_clear", "_sessions"]) {
      const first = s.indexOf(`set_config('aurixa.account_reset${key}'`);
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(firstRead);
    }
  });

  it("will not build a statement around a credential it cannot carry", () => {
    expect(() =>
      buildAccountResetSql({ account: "a", password: "bad\\one-1234", clearAuthenticator: false }),
    ).toThrow(/cannot be carried/);
  });
});

describe("what the clone says happened", () => {
  it("a reset, with what it found", () => {
    expect(
      readAccountResetOutcome([
        {
          outcome: "reset",
          password_verifies: "true",
          authenticator_clear: "true",
          sessions_ended: "2",
        },
      ]),
    ).toEqual({ done: true, passwordVerifies: true, authenticatorClear: true, sessionsEnded: 2 });
  });

  it("a refusal, by name", () => {
    for (const why of ["no_identity_store", "no_account", "ambiguous", "inactive"] as const) {
      expect(readAccountResetOutcome([{ outcome: why }])).toEqual({ done: false, why });
    }
  });

  it("anything else is unreadable, never nothing", () => {
    expect(readAccountResetOutcome([])).toEqual({ done: false, why: "unreadable" });
    expect(readAccountResetOutcome(null)).toEqual({ done: false, why: "unreadable" });
    expect(readAccountResetOutcome([{ outcome: "" }])).toEqual({ done: false, why: "unreadable" });
    expect(accountResetMissLine("unreadable", "alex.morgan")).toMatch(
      /may or may not have changed/,
    );
  });
});

describe("the block's quoting cannot be ended by what it carries", () => {
  it("uses $reset$ unless a value holds it, then the first tag none holds", () => {
    expect(dollarQuoteTag(["'alex'", "'Abcd-efgh-1234'"])).toBe("$reset$");
    expect(dollarQuoteTag(["'Abcd$reset$1234'"])).toBe("$reset1$");
    expect(dollarQuoteTag(["'a$reset$b$reset1$c'"])).toBe("$reset2$");
  });

  it("wraps a password holding $reset$ in a tag it does not hold", () => {
    const s = buildAccountResetSql({
      account: "alex.morgan",
      password: "Abcd$reset$1234",
      clearAuthenticator: false,
    });
    expect(s.startsWith("do $reset1$")).toBe(true);
    expect(s).toContain("end\n$reset1$;");
    expect(s).toContain("extensions.crypt('Abcd$reset$1234', extensions.gen_salt('bf', 10))");
  });
});

describe("the password never leaves in an error", () => {
  it("is withheld as typed and as quoted in the statement", () => {
    const password = "N3w-pass'word-xyz";
    const error =
      "SQL execution failed on ref: 400 — LINE 3: crypt('N3w-pass''word-xyz', ...) near N3w-pass'word-xyz";
    const out = scrubCredential(error, password);
    expect(out).not.toContain("N3w-pass");
    expect(out).toContain("[password withheld]");
  });

  it("is withheld as JSON escaped it, once and twice", () => {
    const password = 'Abcd"efgh\t1234';
    const once = JSON.stringify(password).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    const out = scrubCredential(`{"message":"near ${once}"} and ${twice}`, password);
    expect(out).not.toContain("efgh");
  });

  it("a failed statement is told by its status and SQLSTATE, never its body", () => {
    const body =
      'SQL execution failed on demoref: 400 — {"message":"Failed to run sql query: ERROR:  42601: ' +
      'syntax error at or near \\"x\\"\\nLINE 3: crypt(\'Abcd\\"efgh1234\', ...)"}';
    const line = resetFailureLine(body, 'Abcd"efgh1234');
    expect(line).toBe("the clone refused the statement (HTTP 400, SQLSTATE 42601).");
  });

  it("any other failure is passed on, scrubbed", () => {
    expect(resetFailureLine("fetch failed: Abcd-efgh-1234 timed out", "Abcd-efgh-1234")).toBe(
      "fetch failed: [password withheld] timed out",
    );
  });
});
