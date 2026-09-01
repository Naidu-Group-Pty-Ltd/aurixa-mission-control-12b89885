/**
 * The properties that make it safe to place a token in a tenant's repository.
 *
 * Asserted against the source, because they are structural — what is written,
 * in what order, and what is deliberately absent. A Supabase double could
 * agree with wrong code here; the file cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const server = read("src/server/cloneBackendDeploy.server.ts");
const bare = stripComments(server);
const fns = stripComments(read("src/lib/clone-backend-deploy.functions.ts"));

describe("the token is judged before it is placed", () => {
  it("refuses a non-scoped token before any network call", () => {
    /*
      No answer a probe could give would make an account-wide token safe in a
      tenant's repository, so asking would only cost a round trip and put the
      value on the wire. The early return is the assertion.
    */
    const attach = bare.slice(bare.indexOf("export async function attachCloneDeployToken"));
    const refusal = attach.indexOf('if (tokenClass !== "scoped")');
    const firstProbe = attach.indexOf("probeVisibleProjects(token)");
    expect(refusal).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(firstProbe);
  });

  it("writes nothing at all when the verdict refuses", () => {
    // A refusal that had already sealed the secret would be the worst of both:
    // the credential placed and the operator told it was not.
    const attach = bare.slice(bare.indexOf("export async function attachCloneDeployToken"));
    const verdictGate = attach.indexOf("if (!verdict.ok) return");
    const firstWrite = attach.indexOf("putRepoSecret(");
    expect(verdictGate).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(-1);
    expect(verdictGate).toBeLessThan(firstWrite);
  });

  it("offers no override", () => {
    /*
      A force flag on a check like this is the only thing anybody ever reaches
      for. There is no safe use for a token that cannot be shown to be confined
      to one clone, so there is nothing for an override to unlock.
    */
    expect(bare).not.toMatch(/\bforce\b/);
    expect(fns).not.toMatch(/\bforce\b/);
    expect(bare).not.toMatch(/skipProbe|ignoreScope|allowClassic/);
  });
});

describe("what is recorded, and what is not", () => {
  it("the audit row carries the class and the checks, never the token", () => {
    const insert = bare.slice(
      bare.indexOf('action: TOKEN_ATTACHED_ACTION'),
      bare.indexOf("return { ok: true, verdict"),
    );
    expect(insert).toContain("token_class");
    expect(insert).toContain("checks");
    // The value itself must not reach the row under any spelling.
    expect(insert).not.toMatch(/\btoken\b\s*[,:]/);
    expect(insert).not.toContain("input.token");
  });

  it("nothing logs the token", () => {
    // A console line is a copy of a credential in whatever collects logs.
    for (const line of bare.split("\n")) {
      if (/console\.(log|error|warn|info)/.test(line)) {
        expect(line).not.toMatch(/\btoken\b/);
      }
    }
  });

  it("no table stores it either", () => {
    // The secret lives in GitHub, sealed against the repository's key, where
    // not even Mission Control can read it back. That is the property; a
    // column holding the plaintext would quietly remove it.
    const inserts = bare.match(/\.insert\(\{[\s\S]*?\}\)/g) ?? [];
    for (const ins of inserts) expect(ins).not.toContain("token:");
    expect(bare).not.toMatch(/\.update\(\{[^}]*token:/);
  });
});

describe("the prime's own credential never travels", () => {
  it("this module cannot reach it", () => {
    /*
      `SB_MGMT_API_TOKEN` is what Mission Control deploys clones WITH. The
      whole design rests on it staying here, so the module that writes into
      clone repositories must have no way to name it.
    */
    expect(bare).not.toMatch(/SB_MGMT_API_TOKEN/);
    expect(bare).not.toMatch(/getMgmtToken/);
    expect(bare).not.toMatch(/process\.env/);
  });
});

describe("handing the clone back leaves no gap", () => {
  it("declares the deployer before removing the secret", () => {
    /*
      Reversed, there is a window in which the repository holds neither a token
      nor a declaration — the one state whose deploy check fails. Short, but a
      push during it is a red check for something that was never wrong.
    */
    const detach = bare.slice(bare.indexOf("export async function detachCloneDeployToken"));
    const declare = detach.indexOf("BACKEND_DEPLOYER_MISSION_CONTROL");
    const remove = detach.indexOf("deleteRepoSecret(");
    expect(declare).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(declare).toBeLessThan(remove);
  });

  it("keeps the project ref, which is a fact and not a credential", () => {
    // Removing it would only mean typing it again next time, and the workflow
    // fails closed without it, so a half-configured repository is worse.
    const detach = bare.slice(bare.indexOf("export async function detachCloneDeployToken"));
    expect(detach).not.toContain("PROJECT_REF_VARIABLE");
  });
});

describe("placing a token replaces the claim it contradicts", () => {
  it("removes the Mission Control marker rather than leaving both", () => {
    // Two statements about who deploys is how a card comes to disagree with a
    // workflow. The workflow prefers the token, so a stale marker beside it
    // would mislead whoever reads the repository.
    const attach = bare.slice(
      bare.indexOf("export async function attachCloneDeployToken"),
      bare.indexOf("export async function detachCloneDeployToken"),
    );
    expect(attach).toContain("deleteRepoVariable(");
    expect(attach).toContain("BACKEND_DEPLOYER_VARIABLE");
  });
});

describe("every entry point is admin-only", () => {
  it("all three server functions require an admin", () => {
    const handlers = fns.match(/createServerFn\(/g) ?? [];
    const guards = fns.match(/\.middleware\(\[requireAdmin\]\)/g) ?? [];
    expect(handlers.length).toBe(3);
    expect(guards.length).toBe(handlers.length);
  });
});
