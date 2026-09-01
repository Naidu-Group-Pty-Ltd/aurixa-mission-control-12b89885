import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const server = readFileSync(join(__dirname, "cloneAccessCredentials.server.ts"), "utf8");
const fns = readFileSync(join(__dirname, "..", "lib", "clone-access.functions.ts"), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("an issued credential is never written down", () => {
  it("the audit row records THAT it happened, never what was issued", () => {
    // The whole reason this issues rather than reveals is that no clone admin
    // password is stored anywhere. An audit row carrying the plaintext would
    // reintroduce exactly the standing credential store that decision avoids —
    // in the one table built to be read widely.
    const bare = stripComments(server);
    const start = bare.indexOf("writeAuditLog(");
    expect(start, "the issue must be audited").toBeGreaterThan(-1);
    // Scoped to the CALL, not a window past it: the response beside it
    // legitimately carries the password, and a slice that swallowed it would
    // fail for the wrong reason.
    const end = bare.indexOf("});", start);
    expect(end).toBeGreaterThan(start);
    const audit = bare.slice(start, end);
    expect(audit).toContain("ACCESS_ISSUED_ACTION");
    expect(audit).not.toMatch(/\bpassword\b/);
  });

  it("nothing inserts or updates the plaintext into any table", () => {
    const bare = stripComments(server);
    // Every write in this module goes through writeAuditLog or the shared seed.
    for (const m of bare.matchAll(/\.(insert|update|upsert)\(/g)) {
      throw new Error(`unexpected direct write "${m[0]}" in cloneAccessCredentials.server.ts`);
    }
    expect(bare).toContain("seedProductAdminIdentity");
  });

  it("an unverified credential is a failure, not something handed over", () => {
    // A password a client cannot sign in with is worse for a handoff than
    // being told it could not be set — and it must not be audited as issued.
    const bare = stripComments(server);
    const guard = bare.indexOf("seedIsUsable(report)");
    const auditAt = bare.indexOf("writeAuditLog(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard, "the usability check must precede the audit row").toBeLessThan(auditAt);
    expect(bare.slice(guard, auditAt)).toMatch(/return \{ ok: false/);
  });

  it("both entry points are admin-only", () => {
    // Issuing sets a live password on a tenant's administrator account.
    const bare = stripComments(fns);
    expect(bare.match(/requireAdmin/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(bare).not.toMatch(/requireSupabaseAuth\b(?![\s\S]*requireAdmin)/);
  });

  it("a failed history read is never reported as 'never issued'", () => {
    // That would drop the rotation warning, which is the one thing the
    // operator has to be told before a handoff.
    const bare = stripComments(server);
    const reader = bare.slice(bare.indexOf("async function readLastIssue("));
    expect(reader.slice(0, 700)).toMatch(/if \(error\) throw new Error/);
  });
});
