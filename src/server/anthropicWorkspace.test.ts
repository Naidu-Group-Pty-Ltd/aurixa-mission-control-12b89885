/**
 * Per-clone Anthropic attribution.
 *
 * The tests that matter here are the two that prevent a SILENT wrong answer:
 * the workspace id never travelling from the prime, and a credential bound to
 * one workspace being caught when it ignores the header we sent. Both of those
 * failures leave every reading in this product green.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ANTHROPIC_ADMIN_ENV,
  ANTHROPIC_WORKSPACE_CAP,
  ANTHROPIC_WORKSPACE_ID,
  ANTHROPIC_WORKSPACE_SECRET,
  decideWorkspaceProvision,
  readWorkspaceId,
  workspaceCapWarning,
  workspaceMismatch,
  workspaceNameFor,
} from "./anthropicWorkspace.pure";
import { classifySecret } from "./prime-backend.server";

const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";

describe("the workspace id never travels from the prime", () => {
  /*
   * The single most consequential line in this change. Classified `vendor` —
   * the default for any unlisted name — the fleet sweep forwards Mission
   * Control's own `ANTHROPIC_WORKSPACE_ID` to every clone, and the whole
   * fleet's model spend lands on one workspace. Every call still succeeds,
   * every status stays green, and the per-tenant figure this exists to produce
   * is the prime's own, repeated once per clone.
   */
  it("classifies ANTHROPIC_WORKSPACE_ID as identity, not vendor", () => {
    expect(classifySecret(ANTHROPIC_WORKSPACE_SECRET)).toBe("identity");
  });

  it("keeps the admin credential distinct from the key a clone spends", () => {
    // An Admin key manages the organisation and cannot make a model call; the
    // organisation key can make model calls and cannot manage the
    // organisation. One name for both invites setting the wrong one.
    expect(ANTHROPIC_ADMIN_ENV).not.toBe("ANTHROPIC_API_KEY");
    expect(ANTHROPIC_ADMIN_ENV).toBe("ANTHROPIC_ADMIN_KEY");
  });
});

describe("decideWorkspaceProvision", () => {
  const base = {
    existingWorkspaceId: null,
    anthropicKeyStatus: null,
    credentialPresent: true,
    backendProvisioned: true,
  };

  it("provisions a clone that has everything and no workspace", () => {
    expect(decideWorkspaceProvision(base)).toEqual({ act: true });
  });

  it("never creates a second workspace for a clone that has one", () => {
    const verdict = decideWorkspaceProvision({ ...base, existingWorkspaceId: WORKSPACE });
    expect(verdict.act).toBe(false);
    expect(verdict.act === false && verdict.reason).toBe("already_provisioned");
    expect(verdict.act === false && verdict.actionable).toBe(false);
  });

  /*
   * A tenant's own key belongs to THEIR Anthropic organisation, where a
   * workspace created in ours does not exist — so naming it would turn every
   * one of their calls into a 404 for a workspace their credential has never
   * heard of. This refusal outranks everything, exactly as it does in
   * `decideLlmKeyMint`.
   */
  it("stands down permanently where the tenant supplied its own key", () => {
    const verdict = decideWorkspaceProvision({ ...base, anthropicKeyStatus: "set" });
    expect(verdict.act).toBe(false);
    expect(verdict.act === false && verdict.reason).toBe("tenant_supplied");
    expect(verdict.act === false && verdict.actionable).toBe(false);
  });

  it("does not put back what somebody deliberately withheld", () => {
    const verdict = decideWorkspaceProvision({ ...base, anthropicKeyStatus: "withheld" });
    expect(verdict.act === false && verdict.reason).toBe("withheld");
  });

  it("orders tenant supersession ahead of a missing credential", () => {
    // Otherwise a deployment with no admin key would report "set
    // ANTHROPIC_ADMIN_KEY" about a clone that must never get a workspace.
    const verdict = decideWorkspaceProvision({
      ...base,
      anthropicKeyStatus: "set",
      credentialPresent: false,
    });
    expect(verdict.act === false && verdict.reason).toBe("tenant_supplied");
  });

  it("names the missing credential as actionable, and says what still works", () => {
    const verdict = decideWorkspaceProvision({ ...base, credentialPresent: false });
    expect(verdict.act === false && verdict.reason).toBe("no_credential");
    expect(verdict.act === false && verdict.actionable).toBe(true);
    expect(verdict.act === false && verdict.message).toContain("exactly as they are today");
  });

  it("refuses a clone with no project as nothing to act on", () => {
    const verdict = decideWorkspaceProvision({ ...base, backendProvisioned: false });
    expect(verdict.act === false && verdict.reason).toBe("not_provisioned");
    expect(verdict.act === false && verdict.actionable).toBe(false);
  });

  it("treats a forwarded fleet key as ordinary — it is what a workspace attributes", () => {
    expect(decideWorkspaceProvision({ ...base, anthropicKeyStatus: "inherited" })).toEqual({
      act: true,
    });
  });
});

describe("workspaceNameFor", () => {
  it("leads with the clone so a person reading the console can tell whose spend it is", () => {
    expect(workspaceNameFor("NPC Test")).toBe("aurixa-npc-test");
  });

  it("produces a slug that is safe as a federation resource name too", () => {
    // Anthropic constrains federation resource names to ^[a-z0-9-]+$; using
    // one slug across every object keeps one clone recognisably one clone.
    expect(workspaceNameFor("Naidu Group (Pty) Ltd!")).toMatch(/^[a-z0-9-]+$/);
  });

  /*
   * A name that slugs away must not collapse onto a shared literal: the
   * provisioner matches an existing workspace BY NAME, so two such clones
   * would be handed one workspace and their spend would merge.
   */
  it("falls back to the clone id rather than a name two clones could share", () => {
    const a = workspaceNameFor("!!!", "11111111-2222-3333-4444-555555555555");
    const b = workspaceNameFor("???", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(b).toMatch(/^[a-z0-9-]+$/);
  });

  it("never returns a bare separator when it has nothing at all to work with", () => {
    expect(workspaceNameFor("!!!")).toBe("aurixa-clone");
  });

  it("truncates without leaving a trailing separator", () => {
    expect(workspaceNameFor("a".repeat(400))).not.toMatch(/-$/);
  });
});

describe("readWorkspaceId", () => {
  it("accepts a real id", () => {
    expect(readWorkspaceId(WORKSPACE)).toBe(WORKSPACE);
    expect(ANTHROPIC_WORKSPACE_ID.test(WORKSPACE)).toBe(true);
  });

  it("refuses anything that is not one rather than storing it", () => {
    expect(readWorkspaceId("Default")).toBeNull();
    expect(readWorkspaceId("wrkspc_")).toBeNull();
    expect(readWorkspaceId(null)).toBeNull();
    expect(readWorkspaceId(42)).toBeNull();
  });
});

describe("workspaceCapWarning", () => {
  it("says nothing while there is room", () => {
    expect(workspaceCapWarning(10)).toBeNull();
  });

  it("warns before the limit rather than after", () => {
    const warning = workspaceCapWarning(ANTHROPIC_WORKSPACE_CAP - 3);
    expect(warning).toContain("3 more clones");
    expect(warning).toContain("raise the limit");
  });

  it("reads correctly at one remaining", () => {
    expect(workspaceCapWarning(ANTHROPIC_WORKSPACE_CAP - 1)).toContain("1 more clone can");
  });

  it("says what happens once the limit is reached, rather than only that it is", () => {
    const warning = workspaceCapWarning(ANTHROPIC_WORKSPACE_CAP);
    expect(warning).toContain("default workspace");
    expect(warning).toContain("no per-tenant figure");
  });
});

describe("workspaceMismatch", () => {
  it("is silent when the call ran where we asked", () => {
    expect(workspaceMismatch({ expected: WORKSPACE, resolved: WORKSPACE })).toBeNull();
  });

  /*
   * The failure this catches: a credential bound to a single workspace ignores
   * the header entirely. The call succeeds, the answer is correct, and the
   * spend lands on somebody else's line — so nothing but reading the response
   * header back would ever notice.
   */
  it("names a call that landed on another workspace", () => {
    const problem = workspaceMismatch({ expected: WORKSPACE, resolved: "wrkspc_other" });
    expect(problem).toContain("wrkspc_other");
    expect(problem).toContain("bound to a single workspace");
  });

  it("separates 'could not confirm' from 'confirmed wrong'", () => {
    const problem = workspaceMismatch({ expected: WORKSPACE, resolved: null });
    expect(problem).toContain("could not be confirmed");
    expect(problem).toContain("call itself succeeded");
  });
});

describe("the migration declares what the code reads", () => {
  const sql = readFileSync(
    "supabase/migrations/20260911060000_clone_anthropic_identity.sql",
    "utf8",
  );

  it("creates the table the server module writes to", () => {
    expect(sql).toContain("create table if not exists public.clone_anthropic_identity");
  });

  /*
   * Two clones sharing a workspace would merge their spend back into one line —
   * the exact state this table exists to leave behind, and it would happen
   * silently.
   */
  it("makes one workspace belong to one clone", () => {
    expect(sql).toContain("create unique index if not exists clone_anthropic_identity_workspace_key");
  });

  it("carries the federation columns, so the second half needs no second migration", () => {
    for (const column of ["service_account_id", "federation_rule_id", "federation_issuer_id"]) {
      expect(sql).toContain(column);
    }
  });

  // The drain already runs each file in a transaction; a migration that opens
  // its own is refused by `migrationQueueCorpus`.
  it("opens no transaction of its own", () => {
    expect(/^\s*begin\s*;/im.test(sql)).toBe(false);
  });
});
