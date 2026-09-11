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

import { parseAssertions } from "./migrationAssertions.pure";

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

/*
 * What the first version of this module got wrong.
 *
 * Every one of these was found by a reviewer AFTER the code merged, and each
 * is the same shape: a guard written for the case that was imagined rather
 * than for the hazard the comment beside it described.
 */
describe("the review found these, and they are all one mistake", () => {
  const CLONE_A = "11111111-2222-3333-4444-555555555555";
  const CLONE_B = "99999999-8888-7777-6666-555555555555";

  /*
   * The provisioner finds a workspace BY NAME. Two clones whose names
   * normalise the same way were handed one workspace and their spend merged —
   * which is the exact state this module exists to leave behind, and which its
   * own comment described while guarding only the empty-slug case.
   */
  it("never gives two clones the same workspace name", () => {
    expect(workspaceNameFor("Foo!", CLONE_A)).not.toBe(workspaceNameFor("foo", CLONE_B));
    expect(workspaceNameFor("NPC Test", CLONE_A)).not.toBe(workspaceNameFor("NPC Test", CLONE_B));
    expect(workspaceNameFor("", CLONE_A)).not.toBe(workspaceNameFor("!!!", CLONE_B));
  });

  it("keeps one clone's name stable, so a re-run adopts rather than duplicates", () => {
    expect(workspaceNameFor("NPC Test", CLONE_A)).toBe(workspaceNameFor("NPC Test", CLONE_A));
  });

  /*
   * Truncation takes from the front of the slug, because cutting from the back
   * removes precisely the part that makes the name unique — two long names
   * sharing a prefix would collide again at the cap.
   */
  it("keeps the clone id when the name has to be cut to the cap", () => {
    const long = "a".repeat(400);
    const a = workspaceNameFor(long, CLONE_A);
    const b = workspaceNameFor(long, CLONE_B);
    expect(a.length).toBeLessThanOrEqual(255);
    expect(b.length).toBeLessThanOrEqual(255);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });

  /*
   * A workspace created at the vendor and never written to the project is
   * HALF done. Reading it as complete left the clone on the organisation's
   * default line for ever, while the failure's own message promised that a
   * retry would write the same workspace.
   */
  it("retries delivery of a workspace that was recorded but never written", () => {
    const base = {
      existingWorkspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
      anthropicKeyStatus: "inherited" as string | null,
      credentialPresent: true,
      backendProvisioned: true,
    };
    expect(decideWorkspaceProvision({ ...base, deliveryPending: true })).toEqual({ act: true });
    const settled = decideWorkspaceProvision({ ...base, deliveryPending: false });
    expect(settled.act === false && settled.reason).toBe("already_provisioned");
  });

  /*
   * The admin credential gates CREATING a workspace, never DELIVERING one that
   * already exists.
   *
   * The delivery branch reuses the recorded id by construction and writes one
   * project secret with the Supabase management token — it asks Anthropic
   * nothing. Refusing it for a missing `ANTHROPIC_ADMIN_KEY` is a trap rather
   * than a deferral: `20260911090000` clears every presumed `delivered_at`, so
   * on a deployment that has not set that key yet EVERY identity row becomes
   * pending and nothing can settle it — including the rows whose delivery
   * genuinely succeeded.
   *
   * The two halves of the rule are pinned together, because a gate that lets
   * everything through is not a gate.
   */
  it("delivers a recorded workspace without the admin key, and creates none", () => {
    const noKey = {
      anthropicKeyStatus: "inherited" as string | null,
      credentialPresent: false,
      backendProvisioned: true,
      deliveryPending: true,
    };
    const pending = decideWorkspaceProvision({ ...noKey, existingWorkspaceId: WORKSPACE });
    expect(pending).toEqual({ act: true });

    // Nothing recorded means there is a workspace to CREATE, which does need it.
    const nothingRecorded = decideWorkspaceProvision({ ...noKey, existingWorkspaceId: null });
    expect(nothingRecorded.act === false && nothingRecorded.reason).toBe("no_credential");
  });

  /*
   * And the refusals that come BEFORE it still come before it. This is the
   * reorder that would turn the exemption above into a hole, so it is pinned
   * rather than trusted.
   */
  it("keeps every earlier stand-down ahead of the delivery exemption", () => {
    const pendingNoKey = {
      existingWorkspaceId: WORKSPACE,
      deliveryPending: true,
      anthropicKeyStatus: "inherited" as string | null,
      credentialPresent: false,
      backendProvisioned: true,
    };
    for (const [input, reason] of [
      [{ ...pendingNoKey, anthropicKeyStatus: "set" }, "tenant_supplied"],
      [{ ...pendingNoKey, anthropicKeyStatus: "withheld" }, "withheld"],
      [{ ...pendingNoKey, backendProvisioned: false }, "not_provisioned"],
    ] as const) {
      const verdict = decideWorkspaceProvision(input);
      expect(verdict.act === false && verdict.reason).toBe(reason);
    }
  });

  /*
   * A tenant's own key still outranks a pending delivery: writing a workspace
   * id for Aurixa's organisation onto a project using THEIR credential makes
   * every call a 404 for a workspace that credential has never heard of.
   */
  it("still stands down on a tenant's own key while delivery is pending", () => {
    const verdict = decideWorkspaceProvision({
      existingWorkspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
      deliveryPending: true,
      anthropicKeyStatus: "set",
      credentialPresent: true,
      backendProvisioned: true,
    });
    expect(verdict.act === false && verdict.reason).toBe("tenant_supplied");
  });
});

/*
 * Delivery is recorded in a column nothing else owns.
 *
 * The first repair recognised a pending delivery by a phrase in `last_error`.
 * That column has four writers — the reachability probe clears it on a pass
 * and notes it on a failure, the attempt recorder overwrites it, and
 * federation clears it when it records resources — and every one of them runs
 * in the SAME sweep as workspace provisioning. The marker was routinely erased
 * before the pass that needed it, after which the recorded workspace read as
 * already provisioned for ever.
 */
describe("pending delivery survives the other writers", () => {
  const server = readFileSync("src/server/anthropicWorkspace.server.ts", "utf8");

  it("reads delivery from its own column", () => {
    expect(server).toMatch(/const deliveryPending\s*=[\s\S]{0,160}delivered_at/);
  });

  it("no longer infers it from last_error", () => {
    expect(server).not.toMatch(/deliveryPending[\s\S]{0,120}last_error/);
    expect(server).not.toContain("WRITE_FAILURE_MARKER");
  });

  /*
   * Stamped only by a run that got past the Management API write, so
   * "recorded" and "the project knows" can never be confused again.
   */
  it("stamps delivery only on the path that wrote the secret", () => {
    const stamps = server.match(/delivered_at: now/g) ?? [];
    expect(stamps).toHaveLength(1);
    const writeFailure = server.indexOf("if (!write.ok)");
    const successRecord = server.indexOf("recordIdentity(supabase, cloneId, workspace, null, true)");
    expect(successRecord).toBeGreaterThan(writeFailure);
  });
});

/*
 * No row ends up assumed delivered — across BOTH migrations.
 *
 * The first pass at this deleted the backfill from the published file, which
 * repairs nothing: `apply-migrations.yml` selects `--diff-filter=A` and warns
 * that a modified migration is never re-applied, so every database that had
 * already run it would keep the wrong stamps while the repository looked
 * correct. The published file stays exactly as it ran and a new one corrects
 * the effect — which is why this asserts the END STATE rather than the
 * contents of one file.
 */
describe("no existing row is assumed delivered", () => {
  const added = readFileSync(
    "supabase/migrations/20260911080000_anthropic_workspace_delivered_at.sql",
    "utf8",
  );
  const corrected = readFileSync(
    "supabase/migrations/20260911090000_clear_presumed_anthropic_delivery.sql",
    "utf8",
  );

  it("adds the column", () => {
    expect(added).toContain("add column if not exists delivered_at");
  });

  /*
   * The published migration is HISTORY. Editing it is the mistake the apply
   * workflow exists to warn about, so this pins that its backfill is still
   * there rather than quietly removed.
   */
  it("leaves the published migration exactly as it ran", () => {
    expect(added).toMatch(/update\s+public\.clone_anthropic_identity/i);
    expect(added).toMatch(/last_error is null/i);
  });

  /*
   * And the correction clears every stamp, because a backfilled one and an
   * earned one are indistinguishable — both set `delivered_at` beside
   * `updated_at`. Clearing costs one idempotent re-write of the same workspace
   * id; a false "delivered" is never revisited at all.
   */
  it("clears every presumed stamp in a later migration", () => {
    expect(corrected).toMatch(/set delivered_at = null/i);
    expect(corrected).toMatch(/where delivered_at is not null/i);
    // Never reintroduces the inference it is undoing.
    expect(corrected).not.toMatch(/set\s+delivered_at\s*=\s*coalesce/i);
  });

  /*
   * The correction creates NO object, so it may claim none.
   *
   * It first claimed `column:clone_anthropic_identity.delivered_at` — a column
   * `20260911080000` had already added. A `column:` claim is answered by
   * probing the catalog, so it reads SATISFIED on a database that never
   * applied this file at all: the drift card would show the cleanup green
   * having measured its predecessor. That is the "ran and achieved nothing"
   * shape the assertion grammar exists to catch, pointed the other way.
   *
   * There is no honest structural claim to put in its place — "no row carries
   * `delivered_at`" stops being true at the next real delivery — so this pins
   * the RULE: a migration that creates nothing claims `none`, with a reason.
   */
  it("claims none rather than a column its predecessor created", () => {
    const parsed = parseAssertions(corrected);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // One claim, not six. Every `@asserts` line is a separate claim and each is
    // a separate ROW in the drift card, labelled `none:<reason>` and truncated —
    // so a reason wrapped over several lines renders as several fragments of a
    // broken sentence. The reasoning goes in prose; the claim is one line.
    expect(parsed.assertions).toHaveLength(1);
    expect(parsed.assertions[0].kind).toBe("none");
    // Whatever the wording, it must not become a claim about an object again.
    expect(corrected).not.toMatch(/@asserts\s+(table|column|rpc|cron|rows|enum|check):/i);
  });

  it("opens no transaction of its own", () => {
    for (const sql of [added, corrected]) {
      expect(/^\s*begin\s*;/im.test(sql)).toBe(false);
    }
  });
});
