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
  decideCloneWithhold,
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
        withheldOnClone: false,
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
        withheldOnClone: false,
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
      withheldOnClone: false,
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
      withheldOnClone: false,
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
      withheldOnClone: false,
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
      withheldOnClone: false,
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
      decideFleetWithdraw({ name: "DIDIT_API_KEY", ledgerStatus: "inherited", inherit: undefined })
        .act,
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
      const out = decideFleetWithdraw({
        name: "RESET_TOKEN_PEPPER",
        ledgerStatus: status,
        inherit: false,
      });
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

describe("withholding one forwarded credential from ONE clone", () => {
  const REASON = "reaches Didit through the Mission Control broker instead";

  it("withholds a name the forward delivered, with a reason", () => {
    expect(
      decideCloneWithhold({ name: "DIDIT_API_KEY", ledgerStatus: "inherited", reason: REASON }),
    ).toEqual({ act: "withhold", name: "DIDIT_API_KEY", reason: REASON });
  });

  it("refuses without a real reason, whatever the ledger says", () => {
    for (const reason of ["", "   ", "no", "cleanup"]) {
      const out = decideCloneWithhold({
        name: "DIDIT_API_KEY",
        ledgerStatus: "inherited",
        reason,
      });
      expect(out.act, JSON.stringify(reason)).toBe("refuse");
    }
  });

  it("never touches a secret the forward did not deliver", () => {
    // A clone's OWN peppers, push keys, signing secret and CAPTCHA pair are
    // `set` or `generated`. Deleting one breaks the clone in a way no forward
    // could have caused, so the ledger status is the guard.
    for (const status of ["set", "generated", "missing", "failed", "authorised_no_value", null]) {
      const out = decideCloneWithhold({
        name: "TURNSTILE_SECRET_KEY",
        ledgerStatus: status,
        reason: REASON,
      });
      expect(out.act, String(status)).toBe("refuse");
    }
  });

  it("is idempotent — withholding twice is not an error", () => {
    const out = decideCloneWithhold({
      name: "DIDIT_API_KEY",
      ledgerStatus: "withheld",
      reason: REASON,
    });
    expect(out.act).toBe("already_withheld");
  });
});

describe("a withheld name survives the thirty-minute sweep", () => {
  it("is not forwarded back, though fleet policy still says inherit", () => {
    // The whole point: two tenants keep the key and one must not have it, so
    // fleet policy is UNCHANGED and the exclusion has to hold against it.
    const out = decideFleetForward({
      name: "DIDIT_API_KEY",
      secretClass: "vendor",
      inherit: true,
      presentInEnv: true,
      settledOnClone: false,
      withheldOnClone: true,
    });
    expect(out.act).toBe("withheld");
  });

  it("reads as withheld, never as delivered", () => {
    // Silencing the sweep by calling it settled would make the operator's
    // secret list show a credential the project does not hold.
    const outcomes = planFleetForwards({
      fleet: new Map([["DIDIT_API_KEY", true]]),
      classOf: () => "vendor",
      envHas: () => true,
      settled: new Set<string>(),
      withheld: new Set(["DIDIT_API_KEY"]),
    });
    expect(fleetNamesToWrite(outcomes)).toEqual([]);
    expect(outcomes.map((o) => o.act)).toEqual(["withheld"]);
  });

  it("still forwards every OTHER fleet name to that clone", () => {
    const outcomes = planFleetForwards({
      fleet: new Map([
        ["DIDIT_API_KEY", true],
        ["OPENAI_API_KEY", true],
      ]),
      classOf: () => "vendor",
      envHas: () => true,
      settled: new Set<string>(),
      withheld: new Set(["DIDIT_API_KEY"]),
    });
    expect(fleetNamesToWrite(outcomes)).toEqual(["OPENAI_API_KEY"]);
  });

  it("the sweep reads the withheld set from the ledger, not from nowhere", () => {
    const server = readFileSync(new URL("./fleetSecretForward.server.ts", import.meta.url), "utf8");
    // The RULE, not the expression: the set comes from this clone's ledger
    // rows whose status is WITHHELD. It was asserted as one particular
    // spelling and moved to a named binding the moment it had a second use.
    expect(server).toContain('(r.status ?? "") === WITHHELD');
    expect(server).toContain("withheld: withheldNames");
    // `withheld` must never join SETTLED — that would silence the sweep by
    // claiming the clone holds the value.
    //
    // Asserted as the RULE rather than the literal, for the same reason the
    // two lines above are. SETTLED legitimately grows: `minted` joined it when
    // model keys began being minted per clone, because a minted key IS held by
    // the clone and the fleet key must not be written over it. Pinning the
    // whole expression made that ordinary addition look like a regression
    // while saying nothing about the thing actually at stake.
    const settled = server.match(/const SETTLED = new Set\(\[([^\]]*)\]\)/);
    expect(settled, "SETTLED must be a literal set this test can read").not.toBeNull();
    expect(settled![1]).not.toContain("withheld");
  });

  it("the column accepts the status, or every write is refused by Postgres", () => {
    // A CHECK-constrained column rejects an unknown value while looking, from
    // the function that tried to write it, exactly like a write nobody
    // attempted — the defect this platform paid for on `reminder_type`.
    const sql = readFileSync(
      new URL(
        "../../supabase/migrations/20260907160000_clone_secret_withheld_status.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("clone_backend_secrets_status_check");
    expect(sql).toMatch(/CHECK \(status IN \([^)]*'withheld'[^)]*\)\)/);
    for (const kept of ["missing", "set", "failed", "inherited", "authorised_no_value"]) {
      expect(sql, `must not drop ${kept}`).toContain(`'${kept}'`);
    }
  });
});

describe("a withheld name is taken OFF the project, not merely left unwritten", () => {
  const server = () =>
    readFileSync(new URL("./fleetSecretForward.server.ts", import.meta.url), "utf8");

  /*
   * Withholding has two jobs and only one was ever done.
   *
   * Not writing a withheld name keeps the sweep from putting it back.
   * REMOVING one that predates the decision is what makes the decision true.
   *
   * `withholdCloneSecret` does that and IS reachable, at
   * `/hooks/clone-secret-withhold` — deliberately unscheduled, one credential
   * on one clone. What nothing covered is a name withheld by POLICY: the
   * `brokered` class marks one for the whole fleet, writes the ledger row and
   * removes nothing. The audit log has `clone_secret_withheld` three times,
   * all DIDIT_API_KEY, never the Airtable pair.
   *
   * Measured 8 Sep 2026: AIRTABLE_TOKEN and AIRTABLE_BASE_ID read `withheld`
   * on all three clones with `last_set_at: null`, while one clone went on
   * reading Airtable directly with a pair it had been given before the policy
   * existed — so the broker was never reached and its Listings page stayed
   * empty for five hours.
   */
  it("the sweep enforces the withheld set as well as respecting it", () => {
    expect(server()).toContain("enforceWithheld(");
    expect(server()).toContain("deleteCloneSecretValues");
  });

  it("removes only names the project is OBSERVED to hold", () => {
    // `listProjectSecretNames` answers [] for a transport failure exactly as
    // for a project holding none, so an empty answer must remove nothing.
    expect(server()).toContain("listProjectSecretNames");
    expect(server()).toMatch(/present\.filter\(\(name\) => withheldNames\.has\(name\)\)/);
    expect(server()).toContain("if (stale.length === 0) return []");
  });

  it("stamps the removal, because a null last_set_at is what never-enforced looked like", () => {
    expect(server()).toMatch(/status: WITHHELD,\s*\n\s*last_set_at: now/);
  });

  it("never takes the sweep down over one clone's stale name", () => {
    // Throwing here would stop every OTHER clone settling.
    expect(server()).not.toMatch(/enforceWithheld[\s\S]{0,1200}throw new Error/);
  });

  it("a removal is reported separately from a write", () => {
    // The opposite act. A sweep that removes a credential must never be
    // reported as one that changed nothing.
    expect(server()).toContain("removed: Array<{ clone_id: string; names: string[] }>");
    expect(server()).toContain("out.removed.push(");
  });
});
