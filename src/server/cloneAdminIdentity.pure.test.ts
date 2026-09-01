import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE_PREFERENCE,
  chooseRoleLabel,
  describeSeed,
  seedIsUsable,
  sqlCredentialLiteral,
  type AdminSeedReport,
} from "./cloneAdminIdentity.pure";

const report = (over: Partial<AdminSeedReport> = {}): AdminSeedReport => ({
  product_identity: false,
  password_verifies: false,
  role_label: null,
  auth_user: false,
  notes: [],
  ...over,
});

describe("chooseRoleLabel — the COLUMN decides the spelling", () => {
  it("takes the prime's own enum spelling", () => {
    // The live prime spells it `superadmin`. `super_admin` — what the seed used
    // to insert — is not a member, so the insert was 22P02 and the surrounding
    // EXCEPTION block turned that into a warning nobody read.
    expect(chooseRoleLabel(["superadmin", "admin", "user"])).toBe("superadmin");
  });

  it("prefers the more privileged label when both spellings exist", () => {
    expect(chooseRoleLabel(["user", "admin", "super_admin"])).toBe("super_admin");
  });

  it("REFUSES rather than falling back when no label names an administrator", () => {
    // Falling back to the first preference would write a label the column
    // rejects — the original defect — and falling back to whatever IS present
    // could grant the wrong authority. Neither is safe, so this returns null
    // and the caller writes no role row.
    expect(chooseRoleLabel(["viewer", "editor"])).toBeNull();
    expect(chooseRoleLabel([])).toBeNull();
  });

  it("ignores blank and padded labels", () => {
    expect(chooseRoleLabel([" admin ", "", "  "])).toBe("admin");
  });

  it("prefers in the declared order", () => {
    expect([...ADMIN_ROLE_PREFERENCE]).toEqual(["super_admin", "superadmin", "owner", "admin"]);
  });
});

describe("sqlCredentialLiteral", () => {
  it("doubles quotes", () => {
    expect(sqlCredentialLiteral("a'b")).toBe("'a''b'");
  });

  it("carries every character generateSecurePassword can emit", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    expect(() => sqlCredentialLiteral(alphabet)).not.toThrow();
    expect(sqlCredentialLiteral(alphabet)).toBe(`'${alphabet}'`);
  });

  it("REFUSES what it cannot carry rather than escaping by guesswork", () => {
    // A mis-escaped credential is a syntax error at best and a login nobody
    // can perform at worst.
    for (const bad of ["a\\b", "a\nb", "a\rb", "a\0b"]) {
      expect(() => sqlCredentialLiteral(bad)).toThrow(/cannot be carried/);
    }
  });
});

describe("seedIsUsable — an auth user is not an admin", () => {
  it("is false for the exact shape the broken seed produced", () => {
    // A Supabase Auth user and nothing in the store the login path reads.
    expect(seedIsUsable(report({ auth_user: true }))).toBe(false);
  });

  it("is false when the row exists but the credential does not verify", () => {
    expect(seedIsUsable(report({ product_identity: true }))).toBe(false);
  });

  it("is true only when somebody can actually sign in", () => {
    expect(seedIsUsable(report({ product_identity: true, password_verifies: true }))).toBe(true);
  });

  it("does not require a role row", () => {
    // A prime may model authority inside its identity table alone.
    expect(
      seedIsUsable(report({ product_identity: true, password_verifies: true, role_label: null })),
    ).toBe(true);
  });
});

describe("describeSeed says which of the failures it was", () => {
  it("names the role on success", () => {
    expect(
      describeSeed(
        report({ product_identity: true, password_verifies: true, role_label: "superadmin" }),
        "admin@example.com",
      ),
    ).toMatch(/Seeded admin@example\.com as superadmin; the stored credential verifies\./);
  });

  it("calls out the auth-user-only case explicitly", () => {
    const said = describeSeed(report({ auth_user: true }), "admin@example.com");
    expect(said).toMatch(/authenticates against its own identity table/);
    expect(said).toMatch(/nobody can sign in/);
  });

  it("never reports a clone nobody can enter as seeded", () => {
    for (const r of [report(), report({ auth_user: true }), report({ product_identity: true })]) {
      expect(describeSeed(r, "a@b.c")).not.toMatch(/^Seeded /);
    }
  });
});
