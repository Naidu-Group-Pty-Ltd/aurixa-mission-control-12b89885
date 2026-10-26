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

  it("is written into the production environment, never as a repository secret", () => {
    expect(pure).toContain('export const CI_ENVIRONMENT = "supabase-production"');
    expect(server).toContain("putEnvironmentSecret");
    expect(server).toContain("environment: CI_ENVIRONMENT");
    // A repository secret is readable by every job on every branch.
    expect(server).not.toContain("putRepoSecret");
  });

  it("hands over the stored service-role key only after judging it the clone's own", () => {
    const at = server.indexOf("name: CI_SERVICE_ROLE_SECRET");
    expect(at).toBeGreaterThan(-1);
    expect(server.lastIndexOf("judgeServiceRoleKey(", at)).toBeGreaterThan(-1);
    expect(server.slice(server.lastIndexOf("judgeServiceRoleKey(", at), at)).toContain("key.ok");
  });

  it("reaches a clone's project only through the guard that refuses the prime and itself", () => {
    expect(server).toContain("resolveCloneSecretTarget(supabase, clone.id)");
    // The password is set on the ref the guard returned, never the row's own.
    expect(server).toMatch(
      /setCloneDbPassword\(\{\s*supabase,\s*cloneId: clone\.id,\s*projectRef,/,
    );
  });

  it("sets a password only where the decision allows, and claims the row first", () => {
    const at = server.indexOf("await setCloneDbPassword(");
    expect(server.lastIndexOf("decidePasswordSet(", at)).toBeGreaterThan(-1);
    // The claim: marked pending, written only while the row holds nothing and
    // names this project, and BEFORE Supabase is told, so two overlapping
    // passes cannot both reset.
    const fn = server.slice(server.indexOf("async function setCloneDbPassword"));
    const claim = fn.indexOf('.is("db_pass", null)');
    expect(claim).toBeGreaterThan(-1);
    expect(fn.indexOf("claim = pendingPassword(encryptSecret(password))")).toBeLessThan(claim);
    expect(claim).toBeLessThan(fn.indexOf("/database/password"));
    // Confirmed only over this claim, and only after Supabase took it.
    const confirm = fn.indexOf(".update({ db_pass: encryptSecret(password) })");
    expect(confirm).toBeGreaterThan(fn.indexOf("/database/password"));
    expect(fn.indexOf('.eq("db_pass", claim)', confirm)).toBeGreaterThan(confirm);
    // A refused reset leaves the claim standing for the next pass to finish;
    // nothing releases it into a state a later pass could mistake.
    expect(fn).not.toContain("db_pass: null");
    // A password just set is written at once, not on the daily re-assertion.
    expect(server).toContain("password = { value: set.password, changed: true }");
  });

  it("pairs a clone's credentials only with the project it read them from", () => {
    // The row and the guarded target are two reads; a re-provision between
    // them must not pair one project's claim or key with another.
    expect(server).toContain("if (projectRef !== backend.supabase_project_ref)");
    const fn = server.slice(server.indexOf("async function setCloneDbPassword"));
    const reread = fn.indexOf('.eq("db_pass", claim);');
    expect(reread).toBeGreaterThan(-1);
    expect(reread).toBeLessThan(fn.indexOf("/database/password"));
  });

  it("never hands out a standing claim, and finishes it", () => {
    // A pending value is not a credential: the sweep holds nothing for it
    // until the claim is finished.
    expect(server).toContain("let password = standingClaim");
    expect(server).toContain("? ({ value: null } as HeldCredential)");
    expect(server).toContain("standingClaim,\n        });");
  });

  it("decides who operates the backend from the deploy token, never BACKEND_DEPLOYED_BY", () => {
    // The declaration sweep writes BACKEND_DEPLOYED_BY on every clone, a
    // tenant's included, so it cannot say who operates the backend.
    expect(pure).not.toMatch(/variables\.BACKEND_DEPLOYED_BY/);
    // The token's name comes from the module that writes it, never spelled here.
    expect(server).toContain(
      'const { ACCESS_TOKEN_SECRET } = await import("./cloneBackendDeploy.server")',
    );
    expect(server).toContain("listRepoSecretNames({ owner, repo })");
    expect(server).toContain(
      "listEnvironmentSecretNames({ owner, repo, environment: CI_ENVIRONMENT })",
    );
    expect(server).toContain(".includes(ACCESS_TOKEN_SECRET)");
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
