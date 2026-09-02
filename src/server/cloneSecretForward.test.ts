/**
 * What may be forwarded to one clone, and — much more importantly — what may
 * not be, however the rows are set.
 *
 * Two of these are security properties rather than correctness ones: a
 * per-clone escape hatch that could reach a project signing key, or quietly
 * beat a fleet-wide "do not forward", is a cross-tenant hole with a friendly
 * button on it.
 */
import { describe, expect, it } from "vitest";
import {
  decideForward,
  namesToWrite,
  planCloneForwards,
  pushChangedSomething,
  type ForwardFacts,
} from "./cloneSecretForward.pure";
import { classifySecret } from "./prime-backend.server";

const facts = (over: Partial<ForwardFacts> = {}): ForwardFacts => ({
  name: "GOHIGHLEVEL_API_KEY",
  secretClass: "vendor",
  fleetInherit: null,
  presentInEnv: true,
  ...over,
});

describe("a vendor credential authorised for one clone", () => {
  it("is forwarded when this deployment holds a value", () => {
    expect(decideForward(facts())).toEqual({ act: "forward", name: "GOHIGHLEVEL_API_KEY" });
  });

  it("is never written when the value is absent", () => {
    /*
      Mission Control never reads the prime's secret VALUES from its Supabase
      project — the snapshot carries schema and code only, and names are
      scraped out of source. So a name can be authorised, correct, and have
      nothing behind it, and writing the empty string then is worse than
      leaving it unset: an unset name is a function that fails at boot with a
      recognisable message, while "" fails at the vendor with a stranger one.
    */
    const out = decideForward(facts({ presentInEnv: false }));
    expect(out.act).toBe("no_value");
    expect(namesToWrite([out])).toEqual([]);
  });
});

describe("a class refusal outranks every row", () => {
  it.each([
    ["platform", "SUPABASE_URL"],
    ["identity", "an identity secret"],
    ["tenant_scoped", "JWT_SECRET"],
  ] as const)("refuses a %s name even with a value and no fleet objection", (secretClass, name) => {
    const out = decideForward(facts({ name, secretClass, presentInEnv: true, fleetInherit: null }));
    expect(out.act).toBe("refuse");
  });

  it("cannot be reached by marking the name fleet-inheritable either", () => {
    // The order is the guarantee. If fleet policy were consulted first, a row
    // saying `inherit = true` for JWT_SECRET would answer `already_fleet_wide`
    // and read as benign.
    const out = decideForward(
      facts({ name: "JWT_SECRET", secretClass: "tenant_scoped", fleetInherit: true }),
    );
    expect(out.act).toBe("refuse");
  });

  it("JWT_SECRET and TURNSTILE_SECRET_KEY really are in that class", () => {
    /*
      The test above is only worth anything if these names classify as it
      assumes. Handing a clone the prime's signing key would let that clone
      mint tokens the PRIME's database accepts, for any subject and any role.
    */
    expect(classifySecret("JWT_SECRET")).toBe("tenant_scoped");
    expect(classifySecret("TURNSTILE_SECRET_KEY")).toBe("tenant_scoped");
    for (const name of ["JWT_SECRET", "TURNSTILE_SECRET_KEY"]) {
      expect(
        decideForward({
          name,
          secretClass: classifySecret(name),
          fleetInherit: null,
          presentInEnv: true,
        }).act,
      ).toBe("refuse");
    }
  });
});

describe("a deliberate fleet refusal is not overridden per clone", () => {
  it("refuses a name fleet policy marks as not forwarded", () => {
    /*
      `inherit = false` is recorded prose — "Prime-only Supabase management
      token — do not forward", "Payment processor key — set per-tenant". A
      per-clone row quietly winning over it is how a token that reaches every
      project in the organisation ends up on a tenant's project.
    */
    const out = decideForward(facts({ name: "SB_MGMT_API_TOKEN", fleetInherit: false }));
    expect(out.act).toBe("refuse");
    expect(out.act === "refuse" && out.why).toMatch(/fleet/i);
  });

  it("says the override is a change to the fleet row, not a thing to retry here", () => {
    const out = decideForward(facts({ name: "STRIPE_SECRET_KEY", fleetInherit: false }));
    expect(out.act === "refuse" && out.why).toMatch(/prime forwarding list/i);
  });
});

describe("a name fleet policy already forwards", () => {
  it("is reported as fleet-wide rather than credited to this row", () => {
    const out = decideForward(facts({ name: "OPENAI_API_KEY", fleetInherit: true }));
    expect(out.act).toBe("already_fleet_wide");
  });

  it("is not written again by this push", () => {
    const out = decideForward(facts({ name: "OPENAI_API_KEY", fleetInherit: true }));
    expect(namesToWrite([out])).toEqual([]);
  });
});

describe("the push reports what it actually did", () => {
  it("a push that wrote nothing did not change anything", () => {
    /*
      The shape of every silent-success defect this platform has paid for. A
      clone whose authorised names are all fleet-wide or all valueless reaches
      here legitimately — and must not be told the forward worked.
    */
    const outcomes = [
      decideForward(facts({ name: "OPENAI_API_KEY", fleetInherit: true })),
      decideForward(facts({ name: "GOHIGHLEVEL_API_KEY", presentInEnv: false })),
      decideForward(facts({ name: "SB_MGMT_API_TOKEN", fleetInherit: false })),
    ];
    expect(namesToWrite(outcomes)).toEqual([]);
    expect(pushChangedSomething(outcomes)).toBe(false);
  });

  it("one forwardable name among refusals still counts as a change", () => {
    const outcomes = [
      decideForward(facts({ name: "SB_MGMT_API_TOKEN", fleetInherit: false })),
      decideForward(facts({ name: "GOHIGHLEVEL_LOCATION_ID" })),
    ];
    expect(namesToWrite(outcomes)).toEqual(["GOHIGHLEVEL_LOCATION_ID"]);
    expect(pushChangedSomething(outcomes)).toBe(true);
  });

  it("names are written in the order they were authorised", () => {
    // The pair a GHL call needs travels in one Management API request; the
    // order is what makes a diff of two pushes readable.
    const outcomes = [
      decideForward(facts({ name: "GOHIGHLEVEL_API_KEY" })),
      decideForward(facts({ name: "GOHIGHLEVEL_LOCATION_ID" })),
    ];
    expect(namesToWrite(outcomes)).toEqual(["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID"]);
  });
});

describe("the GoHighLevel case this was built for", () => {
  it("forwards the legacy pair, which is the branch a clone with no config takes", () => {
    /*
      `getGhlCredentials` defaults to 'legacy' and `ghl_account_config` holds
      no row on this clone, so the resolver reads GOHIGHLEVEL_API_KEY and
      GOHIGHLEVEL_LOCATION_ID — not the `_NEW` pair. Forwarding the wrong two
      leaves 36 functions throwing "Missing GHL legacy API key" against a
      clone that looks fully configured.
    */
    for (const name of ["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID"]) {
      expect(classifySecret(name)).toBe("vendor");
      expect(decideForward(facts({ name })).act).toBe("forward");
    }
  });
});

describe("planCloneForwards — one decision for both callers", () => {
  const plan = (
    authorised: string[],
    fleet: [string, boolean][] = [],
    present = new Set(authorised),
  ) =>
    planCloneForwards({
      authorised,
      fleet: new Map(fleet),
      classOf: classifySecret,
      envHas: (n) => present.has(n),
    });

  it("gives provisioning exactly what the push would write", () => {
    /*
      The property that matters, and the reason this is one function rather
      than two loops. A re-provision that dropped a clone's own forwards would
      bring it back holding every fleet key and none of its own — a healthy
      provision at every surface, failing only at the vendor.
    */
    const outcomes = plan(["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID"]);
    expect(namesToWrite(outcomes)).toEqual(["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID"]);
  });

  it("carries the class refusal into the provisioning path too", () => {
    // The boundary must not be reachable in one path and not the other.
    expect(namesToWrite(plan(["JWT_SECRET", "GOHIGHLEVEL_API_KEY"]))).toEqual([
      "GOHIGHLEVEL_API_KEY",
    ]);
  });

  it("respects a fleet refusal it is handed", () => {
    const outcomes = plan(["SB_MGMT_API_TOKEN"], [["SB_MGMT_API_TOKEN", false]]);
    expect(namesToWrite(outcomes)).toEqual([]);
  });

  it("writes nothing for a name this deployment has no value for", () => {
    expect(namesToWrite(plan(["GOHIGHLEVEL_API_KEY"], [], new Set()))).toEqual([]);
  });

  it("an empty authorisation list plans nothing", () => {
    expect(plan([])).toEqual([]);
  });
});
