import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_GRANTABLE_SCOPES,
  isWorkspaceGrantableScope,
  redactScopeOutcome,
  scopesAfter,
  workspaceRowRefusal,
} from "./buildersWorkspaceScope.pure";

const ORG = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const OTHER = "8b2d3f40-5c6e-4f70-9bac-1d2e3f4a5b6c";
const LIVE_ROW = {
  network_connection_id: "conn-1",
  state: "active",
  builder_organisation_id: ORG,
  scopes: [] as string[],
  identity_mismatch_since: null,
};

describe("isWorkspaceGrantableScope", () => {
  it("admits exactly the scopes a workspace discloses", () => {
    expect([...WORKSPACE_GRANTABLE_SCOPES].sort()).toEqual([
      "aml:reliance",
      "collaboration:messages",
    ]);
    expect(isWorkspaceGrantableScope("aml:reliance")).toBe(true);
  });

  it("refuses the builder's scopes and anything unknown", () => {
    for (const key of ["stock:publish", "documents:share", "aml:everything", ""]) {
      expect(isWorkspaceGrantableScope(key)).toBe(false);
    }
  });
});

describe("scopesAfter", () => {
  it("adds once and keeps the list sorted", () => {
    expect(scopesAfter(["stock:publish"], "aml:reliance", true)).toEqual([
      "aml:reliance",
      "stock:publish",
    ]);
    expect(scopesAfter(["aml:reliance"], "aml:reliance", true)).toEqual(["aml:reliance"]);
  });

  it("removes only the named scope and never returns null", () => {
    expect(scopesAfter(["aml:reliance", "stock:publish"], "aml:reliance", false)).toEqual([
      "stock:publish",
    ]);
    expect(scopesAfter(null, "aml:reliance", false)).toEqual([]);
  });
});

describe("workspaceRowRefusal", () => {
  it("passes a live row naming the connection's organisation", () => {
    expect(workspaceRowRefusal(LIVE_ROW, ORG)).toBeNull();
  });

  it("refuses an absent, inactive, unmapped or halted row", () => {
    expect(workspaceRowRefusal(null, ORG)).toMatch(/install the transport/i);
    expect(workspaceRowRefusal({ ...LIVE_ROW, state: "revoked" }, ORG)).toMatch(/not active/);
    expect(workspaceRowRefusal({ ...LIVE_ROW, builder_organisation_id: null }, ORG)).toMatch(
      /names no builder/,
    );
    expect(
      workspaceRowRefusal({ ...LIVE_ROW, identity_mismatch_since: "2026-10-05T00:00:00Z" }, ORG),
    ).toMatch(/halted/);
  });

  it("refuses a row naming a different organisation rather than granting across them", () => {
    expect(workspaceRowRefusal({ ...LIVE_ROW, builder_organisation_id: OTHER }, ORG)).toMatch(
      /different builder organisation/,
    );
  });
});

describe("redactScopeOutcome", () => {
  it("drops anything not on the declared shape", () => {
    const out = redactScopeOutcome({
      ok: true,
      networkConnectionId: "n",
      scopeKey: "aml:reliance",
      granted: true,
      scopes: ["aml:reliance"],
      service_role_key: "leaked",
    } as never);
    expect(JSON.stringify(out)).not.toContain("leaked");
  });
});

describe("setWorkspaceConnectionScope, at the source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./buildersWorkspaceScope.functions.ts", import.meta.url)),
    "utf8",
  );
  const handler = source.slice(source.indexOf(".handler("));

  it("refuses a scope the workspace does not disclose before reading anything", () => {
    expect(handler.indexOf("isWorkspaceGrantableScope(")).toBeLessThan(
      handler.indexOf("builders_network_connections_shadow"),
    );
  });

  it("reads the workspace row before writing either side", () => {
    const read = handler.indexOf("builder_network_connections?select=");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(handler.indexOf('callBuilderNetworkAdmin("grant_workspace_scope"'));
    expect(read).toBeLessThan(handler.indexOf('callBuilderNetworkAdmin("revoke_workspace_scope"'));
  });

  it("grants on the network first and records on the workspace second, on a matching row only", () => {
    const grant = handler.slice(handler.indexOf("if (data.grant) {"), handler.indexOf("} else {"));
    expect(grant.indexOf("workspaceRowRefusal(row, organisationId)")).toBeLessThan(
      grant.indexOf('callBuilderNetworkAdmin("grant_workspace_scope"'),
    );
    expect(grant.indexOf('callBuilderNetworkAdmin("grant_workspace_scope"')).toBeLessThan(
      grant.indexOf("writeWorkspaceScopes("),
    );
    expect(grant).toContain("builder_organisation_id=eq.");
  });

  it("withdraws on the workspace first, which alone stops every read", () => {
    const revoke = handler.slice(handler.indexOf("} else {"));
    expect(revoke.indexOf("writeWorkspaceScopes(")).toBeLessThan(
      revoke.indexOf('callBuilderNetworkAdmin("revoke_workspace_scope"'),
    );
  });

  it("returns every answer through the redactor", () => {
    const offenders = [...handler.matchAll(/\breturn\s+(\S+)/g)]
      .map((m) => m[1])
      .filter((what) => !what.startsWith("redactScopeOutcome("))
      // The helper's own boolean answers are not outcomes.
      .filter((what) => !/^(false|true|Array\.isArray)/.test(what));
    expect(offenders).toEqual([]);
  });

  it("records who acted, and never a credential", () => {
    const audit = handler.slice(handler.indexOf("writeAuditLog"));
    expect(audit).toContain("actorUserId: context.userId");
    expect(audit).not.toMatch(/cloneKey|service_role_key|hmac/i);
  });

  it("takes the workspace credential from the backends table, never from this environment", () => {
    expect(source).toContain('.from("clone_backends")');
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toContain("createClient(");
  });
});
