/**
 * The credential distribution reads the source, because the properties that
 * matter are in the SHAPE of the code: which credential is chosen, and what a
 * failure is allowed to cost.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pure = readFileSync("src/server/cloneCiCredential.pure.ts", "utf8");
const server = readFileSync("src/server/cloneCiCredential.server.ts", "utf8");
const hook = readFileSync("src/routes/hooks.clone-deployer-declaration-reconcile.tsx", "utf8");

describe("what is distributed", () => {
  it("is a database URL and never a Supabase access token", () => {
    expect(pure).toContain('export const CI_DB_URL_SECRET = "SUPABASE_DB_URL"');
    // The one that would be catastrophic in a tenant repository.
    expect(server).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(pure).not.toContain('"SUPABASE_ACCESS_TOKEN"');
  });

  it("is composed for the session port and nothing else", () => {
    expect(pure).toContain("export const SESSION_POOLER_PORT = 5432");
    expect(pure).toMatch(/@\$\{host\}:\$\{SESSION_POOLER_PORT\}\/postgres\?sslmode=require/);
  });

  it("refuses a pooler user that is not this project's", () => {
    expect(pure).toContain("if (!user.endsWith(`.${ref}`))");
    expect(pure).toContain("refusing to hand a clone another database");
  });
});

describe("the sweep", () => {
  it("never lets the credential phase fail the declaration phase", () => {
    const at = hook.indexOf("reconcileCloneCiCredentials");
    expect(at).toBeGreaterThan(-1);
    // The declaration is written first, and the credential runs inside its own
    // try/catch afterwards.
    expect(hook.indexOf("reconcileCloneDeployerDeclarations")).toBeLessThan(at);
    // Declared outside, so a thrown credential pass still returns a body; and
    // wrapped in its own try, so it cannot escape into the handler's catch and
    // turn a written declaration into a 500.
    const declaredAt = hook.indexOf("let credentials: unknown = null;");
    expect(declaredAt).toBeGreaterThan(-1);
    expect(declaredAt).toBeLessThan(at);
    expect(hook.lastIndexOf("try {", at)).toBeGreaterThan(declaredAt);
    expect(hook.slice(at, at + 1400)).toContain("catch (e)");
  });

  it("reads the pooler rather than guessing a host", () => {
    expect(server).toContain("/config/database/pooler");
    // A failed read is not a project without a pooler.
    expect(server).toContain("return null;");
    expect(server).toContain("Supabase would not report the pooler for");
  });
});
