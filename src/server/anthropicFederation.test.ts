/**
 * Reaching Anthropic with no key.
 *
 * The tests that carry weight here are the boundary ones. A clone's assertion
 * names one subject and a rule matches it exactly, so anything that widens
 * either — a wildcard, an accepted request for somebody else's workspace —
 * dissolves the separation between tenants while every call keeps succeeding.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ASSERTION_LIFETIME_SECONDS,
  BOOTSTRAP_ISSUER_PATH,
  BOOTSTRAP_SUBJECT,
  CLONE_ISSUER_PATH,
  CLONE_OAUTH_SCOPE,
  FEDERATED_STATUS,
  decideFederation,
  federationResourceName,
  federationRuleBody,
  federationSubject,
  identityClaims,
  identityRefusal,
  refuseWildcardSubject,
} from "./anthropicFederation.pure";

const CLONE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const RULE = "fdrl_01ABCDEFabcdef0123456789XY";
const SERVICE_ACCOUNT = "svac_01ABCDEFabcdef0123456789XY";

describe("a subject names one clone and nothing else", () => {
  it("is the clone's full id", () => {
    expect(federationSubject(CLONE)).toBe(`clone:${CLONE}`);
  });

  /*
   * Anthropic's own warning, enforced: "`subject_prefix` is an exact match
   * unless it ends in `*`." A wildcard here would let any clone's assertion
   * satisfy any clone's rule — the whole boundary, gone, with every call still
   * succeeding.
   */
  it("refuses a wildcard", () => {
    expect(refuseWildcardSubject(`clone:${CLONE}`)).toBeNull();
    expect(refuseWildcardSubject("clone:*")).toContain("wildcard");
    expect(refuseWildcardSubject(`clone:${CLONE}*`)).toContain("wildcard");
  });

  it("refuses anything that is not one clone exactly", () => {
    expect(refuseWildcardSubject("clone:")).not.toBeNull();
    expect(refuseWildcardSubject("mission-control:bootstrap")).not.toBeNull();
    expect(refuseWildcardSubject(`clone:${CLONE.slice(0, 10)}`)).not.toBeNull();
  });

  it("keeps the bootstrap subject out of the clone namespace", () => {
    expect(BOOTSTRAP_SUBJECT.startsWith("clone:")).toBe(false);
  });
});

describe("two issuers, and not for symmetry", () => {
  /*
   * Anthropic blocks an OAuth caller from updating an issuer that backs a rule
   * scoped above `workspace:developer`. One shared issuer would therefore
   * freeze every clone's rule behind the organisation-admin rule that
   * bootstraps all of this, and the only repair would be in the Console.
   */
  it("gives the bootstrap its own issuer path", () => {
    expect(BOOTSTRAP_ISSUER_PATH).not.toBe(CLONE_ISSUER_PATH);
  });

  it("keeps a clone's rule at workspace scope, which is all an OAuth caller may create", () => {
    expect(CLONE_OAUTH_SCOPE).toMatch(/^workspace:/);
  });
});

describe("decideFederation", () => {
  const base = {
    workspaceId: WORKSPACE,
    federationRuleId: null,
    anthropicKeyStatus: "inherited" as string | null,
    signingKeyPresent: true,
    bootstrapPresent: true,
  };

  it("federates a clone with a workspace and everything configured", () => {
    expect(decideFederation(base)).toEqual({ act: true });
  });

  /*
   * A tenant's own key belongs to their own Anthropic organisation. Federating
   * past it would move their calls onto Aurixa's account — the promise that
   * they are charged nothing, inverted.
   */
  it("stands down permanently on a tenant's own key, ahead of everything", () => {
    const verdict = decideFederation({
      ...base,
      anthropicKeyStatus: "set",
      workspaceId: null,
      signingKeyPresent: false,
      bootstrapPresent: false,
    });
    expect(verdict.act === false && verdict.reason).toBe("tenant_supplied");
    expect(verdict.act === false && verdict.actionable).toBe(false);
  });

  it("never federates a clone twice", () => {
    const verdict = decideFederation({ ...base, federationRuleId: RULE });
    expect(verdict.act === false && verdict.reason).toBe("already_federated");
  });

  /*
   * A rule is created IN a workspace. Without one there is nothing to bind to,
   * and a rule bound to the organisation's default would federate this clone
   * into exactly the undifferentiated line the workspace exists to leave
   * behind.
   */
  it("waits for the workspace rather than binding to the default", () => {
    const verdict = decideFederation({ ...base, workspaceId: null });
    expect(verdict.act === false && verdict.reason).toBe("no_workspace");
    expect(verdict.act === false && verdict.actionable).toBe(false);
  });

  it("names a missing signing key, and says what still works", () => {
    const verdict = decideFederation({ ...base, signingKeyPresent: false });
    expect(verdict.act === false && verdict.reason).toBe("no_signing_key");
    expect(verdict.act === false && verdict.message).toContain("exactly how it works today");
  });

  it("says the bootstrap is a person's job rather than a fault", () => {
    const verdict = decideFederation({ ...base, bootstrapPresent: false });
    expect(verdict.act === false && verdict.reason).toBe("no_bootstrap");
    expect(verdict.act === false && verdict.message).toContain("Nothing is broken");
  });
});

describe("identityRefusal", () => {
  const federated = {
    cloneWorkspaceId: WORKSPACE,
    federationRuleId: RULE,
    serviceAccountId: SERVICE_ACCOUNT,
  };

  it("answers a clone asking for its own workspace", () => {
    expect(identityRefusal({ ...federated, requestedWorkspaceId: WORKSPACE })).toBeNull();
  });

  it("answers a clone that names no workspace at all", () => {
    expect(identityRefusal({ ...federated, requestedWorkspaceId: undefined })).toBeNull();
  });

  /*
   * Refused rather than silently answered for the right workspace. A silent
   * correction makes a misconfiguration permanent and invisible, and an
   * authenticated clone asking for a workspace that is not its own is worth
   * telling either way.
   */
  it("refuses a clone naming somebody else's workspace", () => {
    const refusal = identityRefusal({ ...federated, requestedWorkspaceId: "wrkspc_someoneelse" });
    expect(refusal).toContain("only ask for its own");
  });

  it("refuses a deployment that does not federate, rather than inventing an identity", () => {
    expect(
      identityRefusal({
        requestedWorkspaceId: WORKSPACE,
        cloneWorkspaceId: WORKSPACE,
        federationRuleId: null,
        serviceAccountId: SERVICE_ACCOUNT,
      }),
    ).toContain("does not federate");
  });
});

describe("identityClaims", () => {
  const claims = identityClaims({
    issuer: "https://mc.example/api/public/anthropic",
    subject: `clone:${CLONE}`,
    audience: "https://api.anthropic.com/v1/oauth/token",
    nowSeconds: 1_000,
    jti: "one",
  });

  it("is short-lived", () => {
    expect(claims.exp - claims.iat).toBe(ASSERTION_LIFETIME_SECONDS);
    expect(ASSERTION_LIFETIME_SECONDS).toBeLessThanOrEqual(600);
  });

  /*
   * An assertion that names its audience cannot be replayed at a different
   * one, and `jti` makes Anthropic accept it exactly once. That single-use
   * rule is why the clone's own credential module runs one exchange at a time:
   * a fan-out exchanging per concurrent section would have everything after
   * the first refused `jti_reused`, reading like an outage.
   */
  it("binds an audience and carries a jti", () => {
    expect(claims.aud).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(claims.jti).toBe("one");
  });
});

describe("federationRuleBody", () => {
  const body = federationRuleBody({
    name: "aurixa-npc-test-rule",
    issuerId: "fdis_01ABCDEFabcdef0123456789XY",
    subject: `clone:${CLONE}`,
    serviceAccountId: SERVICE_ACCOUNT,
    workspaceId: WORKSPACE,
  });

  it("pins one subject, one service account and one workspace", () => {
    expect(body.match).toEqual({ subject_prefix: `clone:${CLONE}` });
    expect(body.target).toEqual({ type: "service_account", service_account_id: SERVICE_ACCOUNT });
    expect(body.workspace_id).toBe(WORKSPACE);
  });

  it("never sets applies_to_all_workspaces", () => {
    // Anthropic accepts it, and it would let one clone's token act anywhere
    // its service account is a member.
    expect("applies_to_all_workspaces" in body).toBe(false);
  });

  it("asks only for workspace scope", () => {
    expect(body.oauth_scope).toBe(CLONE_OAUTH_SCOPE);
  });
});

describe("federationResourceName", () => {
  it("matches Anthropic's own constraint", () => {
    // "Resource names must match ^[a-z0-9-]+$, be 1 to 255 characters, and be
    // unique within an organization for each resource type."
    for (const kind of ["sa", "rule"] as const) {
      const name = federationResourceName(kind, "aurixa-npc-test");
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(255);
    }
  });

  it("keeps a service account and a rule for one clone distinguishable", () => {
    expect(federationResourceName("sa", "aurixa-npc-test")).not.toBe(
      federationResourceName("rule", "aurixa-npc-test"),
    );
  });

  it("keeps two clones' resources distinct", () => {
    expect(federationResourceName("rule", "aurixa-a")).not.toBe(
      federationResourceName("rule", "aurixa-b"),
    );
  });
});

describe("the three coupled edits that fail silently apart", () => {
  const migration = readFileSync(
    "supabase/migrations/20260911070000_federated_anthropic_status.sql",
    "utf8",
  );
  const sweep = readFileSync("src/server/fleetSecretForward.server.ts", "utf8");

  it("adds the status to the CHECK constraint", () => {
    expect(migration).toContain(`'${FEDERATED_STATUS}'`);
    expect(migration).toContain("clone_backend_secrets_status_check");
  });

  /*
   * `resolve_api_key_billability` falls through to `ELSE 'no_key'`, which is
   * NOT billable. A status added to the constraint and not to the rating means
   * Aurixa pays the vendor and recharges nobody, silently, while every ledger
   * reading stays green.
   */
  it("rates it as billable", () => {
    expect(migration).toMatch(/WHEN 'federated'\s+THEN 'inherited'/);
  });

  it("does not rate it brokered — Mission Control makes no vendor call here", () => {
    expect(migration).not.toMatch(/WHEN 'federated'\s+THEN 'brokered'/);
  });

  /*
   * The third edit, in TypeScript. Left out, the fleet sweep forwards the
   * organisation key back onto the project within thirty minutes and the clone
   * silently stops federating — the prime prefers a key whenever one is
   * present, so nothing fails and attribution simply reverts.
   */
  it("makes the fleet sweep remove the name rather than forward it", () => {
    const code = sweep
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).toMatch(/NOT_ON_THE_PROJECT\s*=\s*new Set\(\[\s*WITHHELD,\s*FEDERATED/);
    expect(code).toContain("NOT_ON_THE_PROJECT.has(r.status");
  });

  it("keeps the federated status out of SETTLED, which would leave the key in place", () => {
    const settled = /const SETTLED = new Set\(\[([^\]]*)\]\)/.exec(sweep)?.[1] ?? "";
    expect(settled).not.toContain(FEDERATED_STATUS);
    expect(settled).not.toContain("withheld");
  });

  it("opens no transaction of its own", () => {
    expect(/^\s*begin\s*;/im.test(migration)).toBe(false);
  });
});
