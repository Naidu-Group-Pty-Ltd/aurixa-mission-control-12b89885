/**
 * One authority for "is this clone attributed?", and the guard that keeps it
 * the only one.
 *
 * Six review rounds on this branch found the same defect in five different
 * modules, because the concept had no home: readiness counted rows, then
 * counted deliveries; the clone card blocked federation on delivery, called a
 * half-finished federation done, and told an operator a cleared stamp meant
 * "never written". Each was fixed where it was found, which is why there were
 * five.
 *
 * These tests pin the RULES. The source scan at the end pins the thing no
 * behavioural test can: that no surface has quietly grown its own copy.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type AnthropicIdentityFacts,
  FEDERATED_STATUS,
  TENANT_SUPPLIED_STATUS,
  WITHHELD_STATUS,
  attributionOf,
  delivered,
  deliveryPending,
  federationComplete,
  isAttributed,
  standsDown,
  workspaceRecorded,
} from "./anthropicAttribution.pure";

const WORKSPACE = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
const RULE = "rule_01JwQvzr7rXLA5AGx3HKfFUJ";
const WHEN = "2026-09-11T00:00:00.000Z";

const facts = (over: Partial<AnthropicIdentityFacts> = {}): AnthropicIdentityFacts => ({
  workspaceId: null,
  deliveredAt: null,
  federationRuleId: null,
  anthropicKeyStatus: null,
  ...over,
});

describe("the two routes to attribution", () => {
  /*
   * Delivery: the id is on the project and the prime sends it as a header.
   */
  it("counts a delivered workspace", () => {
    const f = facts({ workspaceId: WORKSPACE, deliveredAt: WHEN });
    expect(delivered(f)).toBe(true);
    expect(isAttributed(f)).toBe(true);
    expect(attributionOf(f)).toBe("delivered");
  });

  /*
   * Federation: `ensureRule` binds the token to the workspace AT THE VENDOR,
   * so no header is needed and no delivery is owed. Requiring delivery here
   * reported a working clone as uncovered for ever wherever the secret write
   * had failed.
   */
  it("counts a completed federation with no delivery at all", () => {
    const f = facts({
      workspaceId: WORKSPACE,
      deliveredAt: null,
      federationRuleId: RULE,
      anthropicKeyStatus: FEDERATED_STATUS,
    });
    expect(delivered(f)).toBe(false);
    expect(isAttributed(f)).toBe(true);
    expect(attributionOf(f)).toBe("federated");
  });

  /*
   * And a recorded workspace is neither. It is its own state rather than a
   * kind of absence: the workspace exists, this clone is the only thing
   * attributed to it, and one idempotent write settles it.
   */
  it("does not count a workspace that is only recorded", () => {
    const f = facts({ workspaceId: WORKSPACE });
    expect(workspaceRecorded(f)).toBe(true);
    expect(isAttributed(f)).toBe(false);
    expect(attributionOf(f)).toBe("recorded");
    expect(deliveryPending(f)).toBe(true);
  });

  it("says nothing where there is no workspace at all", () => {
    expect(attributionOf(facts())).toBe("none");
    expect(deliveryPending(facts())).toBe(false);
  });
});

describe("federation is FINISHED, not started", () => {
  /*
   * `federateClone` stamps `federated_at` and `federation_rule_id` and THEN
   * calls `withdrawAnthropicKey`, which writes the status. A clone stopped
   * between those two carries a rule, an issuer, a service account and a
   * timestamp — everything except the fact — and is still holding the
   * organisation key.
   */
  it("refuses a rule with no ledger status", () => {
    const f = facts({ workspaceId: WORKSPACE, federationRuleId: RULE });
    expect(federationComplete(f)).toBe(false);
    expect(isAttributed(f)).toBe(false);
  });

  it("refuses a ledger status with no rule", () => {
    const f = facts({ workspaceId: WORKSPACE, anthropicKeyStatus: FEDERATED_STATUS });
    expect(federationComplete(f)).toBe(false);
  });

  it("takes both together", () => {
    expect(
      federationComplete(
        facts({
          workspaceId: WORKSPACE,
          federationRuleId: RULE,
          anthropicKeyStatus: FEDERATED_STATUS,
        }),
      ),
    ).toBe(true);
  });
});

describe("who leaves the denominator", () => {
  /*
   * A tenant's own key is bound to THEIR organisation, where a workspace we
   * created does not exist; a withheld key is somebody's recorded decision.
   * Counting either makes the coverage check permanently false on a healthy
   * fleet — nine managed clones beside one tenant-owned key reading "9 of 10"
   * and blocked for ever.
   */
  it("stands down a tenant key and a withheld one, and nothing else", () => {
    expect(standsDown(facts({ anthropicKeyStatus: TENANT_SUPPLIED_STATUS }))).toBe(true);
    expect(standsDown(facts({ anthropicKeyStatus: WITHHELD_STATUS }))).toBe(true);
    for (const status of [null, "inherited", "missing", "failed", FEDERATED_STATUS]) {
      expect(standsDown(facts({ anthropicKeyStatus: status })), String(status)).toBe(false);
    }
  });

  /*
   * `federated` in particular: a clone that federated is the SUCCESS case of
   * this whole programme, and standing it down would drop it out of the
   * denominator it is supposed to satisfy.
   */
  it("never stands down a federated clone", () => {
    expect(standsDown(facts({ anthropicKeyStatus: FEDERATED_STATUS }))).toBe(false);
  });
});

/*
 * The guard that makes the module an AUTHORITY rather than a convenience.
 *
 * A behavioural test cannot see a component that stopped asking. This can: it
 * reads every source file and fails on any private spelling of the two
 * predicates that have already gone wrong five times.
 */
describe("no surface re-spells the judgement", () => {
  const roots = ["src/components", "src/lib", "src/routes", "src/server"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) files.push(full);
    }
  };
  for (const r of roots) walk(r);

  /** The module itself is where the predicates are allowed to be written. */
  const AUTHORITY = join("src", "lib", "anthropicAttribution.pure.ts");

  it("nobody else compares a key status to the federated literal beside a rule", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === AUTHORITY) continue;
      const src = readFileSync(file, "utf8");
      // `federation_rule_id` (or a camelCase read of it) in the same
      // expression as a federated-status comparison is the predicate that
      // belongs to `federationComplete`.
      const line = src
        .split(/\r?\n/)
        .find(
          (l) =>
            /federation_?[rR]ule_?[iI]d/.test(l) &&
            /FEDERATED_STATUS|["'`]federated["'`]/.test(l) &&
            !l.trimStart().startsWith("*") &&
            !l.trimStart().startsWith("//"),
        );
      if (line) offenders.push(`${file}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("nobody else derives delivery from a workspace id and a null stamp", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === AUTHORITY) continue;
      const src = readFileSync(file, "utf8");
      const line = src
        .split(/\r?\n/)
        .find(
          (l) =>
            /!\s*\w*\.?\w*\??\.?delivered_at|!\s*deliveredAt/.test(l) &&
            !l.trimStart().startsWith("*") &&
            !l.trimStart().startsWith("//"),
        );
      if (line) offenders.push(`${file}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  /*
   * And the surfaces that answer the question must be asking it. Named one by
   * one, because "imports the module" is the only evidence available that a
   * file did not go back to deciding for itself.
   */
  it("every surface that judges attribution imports the authority", () => {
    const askers = [
      "src/lib/readiness.functions.ts",
      "src/components/clone-anthropic-card.tsx",
      "src/server/anthropicFederation.pure.ts",
      "src/server/anthropicWorkspace.pure.ts",
      "src/server/anthropicWorkspace.server.ts",
    ];
    for (const file of askers) {
      expect(readFileSync(file, "utf8"), file).toContain("anthropicAttribution.pure");
    }
  });
});
