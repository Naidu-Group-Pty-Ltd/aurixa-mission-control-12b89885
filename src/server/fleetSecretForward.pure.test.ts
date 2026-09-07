import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideFleetForward,
  fleetNamesToWrite,
  fleetNamesWithoutValue,
  planFleetForwards,
  decideFleetWithdraw,
  planFleetWithdrawals,
  fleetNamesToWithdraw,
} from "./cloneSecretForward.pure";
import type { SecretClass } from "./prime-backend.server";

/**
 * Fleet policy applied to a clone that already exists.
 *
 * The defect these pin: `prime_secret_forwards` is read by
 * `runBackendProvisioning` and by nothing else, so a name added to it after a
 * clone was provisioned reached that clone never — while the per-clone
 * decision reported it as `already_fleet_wide`, which is a claim about
 * provisioning rather than about the clone.
 */

const classOf =
  (map: Record<string, SecretClass>) =>
  (name: string): SecretClass =>
    map[name] ?? "vendor";

describe("decideFleetForward", () => {
  it("forwards an inheritable name the clone does not yet hold", () => {
    expect(
      decideFleetForward({
        name: "DIDIT_API_KEY",
        secretClass: "vendor",
        inherit: true,
        presentInEnv: true,
        settledOnClone: false,
      }),
    ).toEqual({ act: "forward", name: "DIDIT_API_KEY" });
  });

  it("refuses on CLASS ahead of everything, however fleet policy is set", () => {
    for (const secretClass of ["identity", "tenant_scoped", "platform"] as SecretClass[]) {
      const out = decideFleetForward({
        name: "JWT_SECRET",
        secretClass,
        inherit: true,
        presentInEnv: true,
        settledOnClone: false,
      });
      expect(out.act).toBe("refuse");
    }
  });

  it("never forwards a name fleet policy declines", () => {
    const out = decideFleetForward({
      name: "SB_MGMT_API_TOKEN",
      secretClass: "vendor",
      inherit: false,
      presentInEnv: true,
      settledOnClone: false,
    });
    expect(out.act).toBe("not_inherited");
  });

  it("settles: a name the ledger records is not rewritten", () => {
    const out = decideFleetForward({
      name: "AIRTABLE_TOKEN",
      secretClass: "vendor",
      inherit: true,
      presentInEnv: true,
      settledOnClone: true,
    });
    expect(out.act).toBe("already_set");
  });

  it("asks the ledger BEFORE the environment, so a settled clone is never reported missing", () => {
    // Mission Control has since dropped the value; the clone still holds it.
    // Reporting `no_value` here would tell an operator a working clone is
    // broken, and a later pass would have nothing to fix.
    const out = decideFleetForward({
      name: "RESEND_API_KEY",
      secretClass: "vendor",
      inherit: true,
      presentInEnv: false,
      settledOnClone: true,
    });
    expect(out.act).toBe("already_set");
  });

  it("never writes an empty shell", () => {
    const out = decideFleetForward({
      name: "DIDIT_WEBHOOK_SECRET",
      secretClass: "vendor",
      inherit: true,
      presentInEnv: false,
      settledOnClone: false,
    });
    expect(out.act).toBe("no_value");
    expect(out.act === "no_value" && out.why).toMatch(/empty secret is not written/);
  });
});

describe("planFleetForwards — the case that made this exist", () => {
  const fleet = new Map<string, boolean>([
    ["DIDIT_API_KEY", true],
    ["DIDIT_LIVENESS_THRESHOLD", true],
    ["DIDIT_FACE_MATCH_THRESHOLD", true],
    ["DIDIT_WEBHOOK_SECRET", true],
    ["DIDIT_WORKFLOW_ID", true],
    ["SB_MGMT_API_TOKEN", false],
    ["JWT_SECRET", true],
  ]);

  it("delivers the five Didit names to a clone whose ledger has none of them", () => {
    const outcomes = planFleetForwards({
      fleet,
      classOf: classOf({ JWT_SECRET: "tenant_scoped" }),
      envHas: (n) => n.startsWith("DIDIT_") || n === "SB_MGMT_API_TOKEN" || n === "JWT_SECRET",
      settled: new Set<string>(),
    });

    expect(fleetNamesToWrite(outcomes)).toEqual([
      "DIDIT_API_KEY",
      "DIDIT_FACE_MATCH_THRESHOLD",
      "DIDIT_LIVENESS_THRESHOLD",
      "DIDIT_WEBHOOK_SECRET",
      "DIDIT_WORKFLOW_ID",
    ]);
  });

  it("carries neither the management token nor the signing key, whatever the fleet row says", () => {
    const outcomes = planFleetForwards({
      fleet,
      classOf: classOf({ JWT_SECRET: "tenant_scoped" }),
      envHas: () => true,
      settled: new Set<string>(),
    });
    const written = fleetNamesToWrite(outcomes);
    expect(written).not.toContain("SB_MGMT_API_TOKEN");
    // Marked `inherit: true` above deliberately: the class refusal has to win
    // even when fleet policy is wrong, because that is the security boundary.
    expect(written).not.toContain("JWT_SECRET");
  });

  it("reports a fleet name with nothing behind it rather than counting it settled", () => {
    const outcomes = planFleetForwards({
      fleet,
      classOf: classOf({ JWT_SECRET: "tenant_scoped" }),
      envHas: (n) => n !== "DIDIT_WORKFLOW_ID",
      settled: new Set<string>(),
    });
    expect(fleetNamesWithoutValue(outcomes)).toEqual(["DIDIT_WORKFLOW_ID"]);
    expect(fleetNamesToWrite(outcomes)).not.toContain("DIDIT_WORKFLOW_ID");
  });

  it("writes nothing once the clone holds fleet policy", () => {
    const outcomes = planFleetForwards({
      fleet,
      classOf: classOf({ JWT_SECRET: "tenant_scoped" }),
      envHas: () => true,
      settled: new Set([
        "DIDIT_API_KEY",
        "DIDIT_LIVENESS_THRESHOLD",
        "DIDIT_FACE_MATCH_THRESHOLD",
        "DIDIT_WEBHOOK_SECRET",
        "DIDIT_WORKFLOW_ID",
      ]),
    });
    expect(fleetNamesToWrite(outcomes)).toEqual([]);
  });
});

describe("the class boundary is one implementation", () => {
  it("the fleet decision and the per-clone decision share the refusal function", () => {
    const src = readFileSync(resolve(__dirname, "cloneSecretForward.pure.ts"), "utf8");
    // Two copies of the security boundary is invisible from outside: both
    // paths keep working and only one of them refuses a signing key.
    expect(src).toMatch(/export function classRefusalFor/);
    const uses = [...src.matchAll(/classRefusalFor\(/g)].length;
    expect(uses, "both decideForward and decideFleetForward must call it").toBeGreaterThanOrEqual(
      3,
    );
    expect(src.match(/CLASS_REFUSAL\[/g) ?? []).toHaveLength(1);
  });
});

describe("taking a forwarded credential back off the fleet", () => {
  it("withdraws a name the forward delivered that policy no longer authorises", () => {
    expect(
      decideFleetWithdraw({ name: "DIDIT_API_KEY", ledgerStatus: "inherited", inherit: false }),
    ).toEqual({ act: "withdraw", name: "DIDIT_API_KEY" });
  });

  it("treats a DELETED fleet row as withdrawal, not as silence", () => {
    // Removing the row is the obvious way to revoke a forward. If that were
    // the one spelling that left the credential in place, the lever would be
    // worse than useless.
    expect(
      decideFleetWithdraw({ name: "DIDIT_API_KEY", ledgerStatus: "inherited", inherit: undefined }).act,
    ).toBe("withdraw");
  });

  it("never touches a secret the clone OWNS", () => {
    /*
     * The rule that protects a tenant. A clone's peppers, push keys, signing
     * secret and CAPTCHA pair are `set`/`generated`/`skipped_*` — deleting one
     * would break the clone in a way no forward could have caused. The ledger
     * status is the whole guard and it is asked FIRST.
     */
    for (const status of [
      "set",
      "generated",
      "missing",
      "failed",
      "authorised_no_value",
      "skipped_platform",
      "skipped_deployment_config",
    ]) {
      const out = decideFleetWithdraw({ name: "RESET_TOKEN_PEPPER", ledgerStatus: status, inherit: false });
      expect(out.act, `${status} must not be withdrawable`).toBe("not_forwarded");
    }
  });

  it("leaves a name fleet policy still forwards", () => {
    // A lever that fights another lever makes a credential flap rather than
    // leave: the forward would put it straight back.
    expect(
      decideFleetWithdraw({ name: "OPENAI_API_KEY", ledgerStatus: "inherited", inherit: true }).act,
    ).toBe("still_authorised");
  });

  it("plans a whole clone and names only what it will delete", () => {
    const outcomes = planFleetWithdrawals({
      ledger: new Map([
        ["DIDIT_API_KEY", "inherited"],
        ["OPENAI_API_KEY", "inherited"],
        ["RESET_TOKEN_PEPPER", "generated"],
        ["TURNSTILE_SECRET_KEY", "set"],
        ["GONE_FROM_POLICY", "inherited"],
      ]),
      fleet: new Map([
        ["DIDIT_API_KEY", false],
        ["OPENAI_API_KEY", true],
        ["RESET_TOKEN_PEPPER", false],
      ]),
    });
    expect(fleetNamesToWithdraw(outcomes)).toEqual(["DIDIT_API_KEY", "GONE_FROM_POLICY"]);
    // Every other name is accounted for rather than dropped.
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.act !== "withdraw" || o.name.length > 0)).toBe(true);
  });

  it("the performer decides nothing — the policy module does", () => {
    const server = readFileSync("src/server/backend-provisioning.server.ts", "utf8");
    const fn = server.slice(
      server.indexOf("export async function deleteCloneSecretValues"),
      server.indexOf("// ─── Legacy bootstrap schema"),
    );
    expect(fn).toContain('method: "DELETE"');
    // No policy in the performer: it must not re-decide what may go.
    expect(fn).not.toContain("inherited");
    expect(fn).not.toContain("ledger");
    // An empty list is a no-op rather than a DELETE with no body.
    expect(fn).toContain("if (names.length === 0) return { ok: true }");
  });
});
