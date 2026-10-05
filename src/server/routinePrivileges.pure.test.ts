import { describe, expect, it } from "vitest";
import {
  CONVERGED_GRANTEES,
  REVOCABLE_GRANTEES,
  isRenderedSignature,
  isRenderedViewName,
  parseGrantees,
  parseViewOptions,
  planRoutineAclConvergence,
  planViewOptionConvergence,
  referencedFunctionNames,
  renderGrantee,
  variantReferenceTexts,
  viewWithClause,
  type RoutineAcl,
} from "./routinePrivileges.pure";

const fn = (signature: string, grantees: string[], securityDefiner = true): RoutineAcl => ({
  signature,
  name: signature.split(".")[1].split("(")[0].replace(/"/g, "").toLowerCase(),
  securityDefiner,
  grantees,
});

// The shape every engine-built clone had on 3 Oct 2026: the prime revoked
// everything but service_role, and the clone carried Postgres's default.
const CRON_HEADERS = "public.cron_service_role_headers(extra jsonb)";
const primeCron = fn(CRON_HEADERS, ["service_role"]);
const cloneCron = fn(CRON_HEADERS, ["PUBLIC", "anon", "authenticated", "service_role"]);

describe("parseGrantees", () => {
  it("reads the catalogue's comma list, arrays and nothing", () => {
    expect(parseGrantees("PUBLIC,anon")).toEqual(["PUBLIC", "anon"]);
    expect(parseGrantees(["authenticated", "service_role"])).toEqual([
      "authenticated",
      "service_role",
    ]);
    expect(parseGrantees(null)).toEqual([]);
    expect(parseGrantees(undefined)).toEqual([]);
  });

  it("normalises PUBLIC and drops every role it does not converge", () => {
    expect(parseGrantees("public,postgres,supabase_admin,anon")).toEqual(["PUBLIC", "anon"]);
    expect(parseGrantees(['"anon"', " authenticated "])).toEqual(["anon", "authenticated"]);
  });
});

describe("renderGrantee", () => {
  it("renders PUBLIC as the keyword and quotes only what needs it", () => {
    expect(renderGrantee("PUBLIC")).toBe("public");
    expect(renderGrantee("anon")).toBe("anon");
    expect(renderGrantee("Weird Role")).toBe('"Weird Role"');
  });

  it("never revokes service_role", () => {
    expect(REVOCABLE_GRANTEES).not.toContain("service_role");
    expect(CONVERGED_GRANTEES).toContain("service_role");
  });
});

describe("referencedFunctionNames", () => {
  it("finds a schema-qualified call — the shape every policy uses", () => {
    const names = referencedFunctionNames(["(public.has_role(auth.uid(), 'admin'::app_role))"]);
    expect(names.has("has_role")).toBe(true);
    expect(names.has("uid")).toBe(true);
  });

  it("finds quoted, unqualified and spaced calls", () => {
    const names = referencedFunctionNames([
      `"is_member" (x)`,
      "current_tenant()",
      null,
      undefined,
      "select coalesce(a, b)",
    ]);
    expect([...names].sort()).toEqual(["coalesce", "current_tenant", "is_member"]);
  });

  it("does not take a column for a call", () => {
    expect(referencedFunctionNames(["owner_id = auth_user_id"]).size).toBe(0);
  });
});

describe("isRenderedSignature", () => {
  it("accepts what the catalogue renders", () => {
    expect(isRenderedSignature("public.has_role(_user_id uuid, _role app_role)")).toBe(true);
    expect(isRenderedSignature('aml."Odd Name"()')).toBe(true);
    expect(isRenderedSignature("public.f()")).toBe(true);
  });

  it("refuses anything that could carry a second statement", () => {
    expect(isRenderedSignature("f()")).toBe(false);
    expect(isRenderedSignature("public.f(); drop table x; --()")).toBe(false);
    expect(isRenderedSignature("public.f(a int) /* x */")).toBe(false);
    expect(isRenderedSignature("public.f(a int) -- ()")).toBe(false);
  });
});

describe("planRoutineAclConvergence", () => {
  it("closes the exposure the clone path left on every clone", () => {
    const plan = planRoutineAclConvergence({ prime: [primeCron], clone: [cloneCron] });
    expect(plan.grants).toEqual([]);
    expect(plan.revokes).toEqual([
      `revoke execute on routine ${CRON_HEADERS} from public, anon, authenticated`,
    ]);
    expect(plan.closedDefinerExposures).toBe(1);
  });

  it("grants service_role explicitly where the clone held it only through PUBLIC", () => {
    // Revoking PUBLIC removes what service_role held through it, so the grant
    // has to land first or the backend loses a function the prime gives it.
    const plan = planRoutineAclConvergence({
      prime: [primeCron],
      clone: [fn(CRON_HEADERS, ["PUBLIC"])],
    });
    expect(plan.grants).toEqual([`grant execute on routine ${CRON_HEADERS} to service_role`]);
    expect(plan.revokes).toEqual([`revoke execute on routine ${CRON_HEADERS} from public`]);
  });

  it("grants what the prime gives and the clone lacks", () => {
    const sig = "public.get_my_profile()";
    const plan = planRoutineAclConvergence({
      prime: [fn(sig, ["authenticated", "service_role"])],
      clone: [fn(sig, ["service_role"])],
    });
    expect(plan.grants).toEqual([`grant execute on routine ${sig} to authenticated`]);
    expect(plan.revokes).toEqual([]);
  });

  it("never revokes service_role, even where the prime does not hold it", () => {
    const sig = "public.public_stats()";
    const plan = planRoutineAclConvergence({
      prime: [fn(sig, ["anon"], false)],
      clone: [fn(sig, ["anon", "service_role"], false)],
    });
    expect(plan.revokes).toEqual([]);
    expect(plan.grants).toEqual([]);
  });

  it("is a no-op once the clone matches", () => {
    const plan = planRoutineAclConvergence({ prime: [primeCron], clone: [primeCron] });
    expect(plan.grants).toEqual([]);
    expect(plan.revokes).toEqual([]);
    expect(plan.closedDefinerExposures).toBe(0);
  });

  it("leaves a clone-only function alone and reports an exposed definer", () => {
    const plan = planRoutineAclConvergence({
      prime: [],
      clone: [
        fn("public.crm_variant_only(x int)", ["PUBLIC", "service_role"]),
        fn("public.crm_invoker_only()", ["PUBLIC"], false),
        fn("public.crm_private()", ["service_role"]),
      ],
    });
    expect(plan.grants).toEqual([]);
    expect(plan.revokes).toEqual([]);
    expect(plan.cloneOnly).toBe(3);
    expect(plan.cloneOnlyExposedDefiners).toEqual(["public.crm_variant_only(x int)"]);
  });

  it("holds back a revoke on a function the clone's own policies call", () => {
    const sig = "public.has_role(_user_id uuid, _role app_role)";
    const plan = planRoutineAclConvergence({
      prime: [fn(sig, ["service_role"])],
      clone: [fn(sig, ["PUBLIC", "authenticated", "service_role"])],
      referencedOnClone: referencedFunctionNames(["(public.has_role(auth.uid(), 'admin'))"]),
    });
    expect(plan.revokes).toEqual([]);
    expect(plan.heldForReference).toEqual([
      { signature: sig, grantees: ["PUBLIC", "authenticated"] },
    ]);
    expect(plan.closedDefinerExposures).toBe(0);
  });

  it("still grants a referenced function what the prime gives it", () => {
    const sig = "public.is_staff()";
    const plan = planRoutineAclConvergence({
      prime: [fn(sig, ["authenticated", "service_role"])],
      clone: [fn(sig, ["PUBLIC"])],
      referencedOnClone: new Set(["is_staff"]),
    });
    expect(plan.grants).toEqual([`grant execute on routine ${sig} to authenticated, service_role`]);
    expect(plan.revokes).toEqual([]);
    expect(plan.heldForReference).toHaveLength(1);
  });

  it("skips a signature that does not look rendered rather than interpolating it", () => {
    const sig = "public.f(); drop table clients; --()";
    const plan = planRoutineAclConvergence({
      prime: [fn(sig, ["service_role"])],
      clone: [fn(sig, ["PUBLIC"])],
    });
    expect(plan.grants).toEqual([]);
    expect(plan.revokes).toEqual([]);
  });

  it("orders by signature so a pass is reproducible", () => {
    const a = "public.a_fn()";
    const b = "public.b_fn()";
    const plan = planRoutineAclConvergence({
      prime: [fn(a, ["service_role"]), fn(b, ["service_role"])],
      clone: [fn(b, ["PUBLIC", "service_role"]), fn(a, ["PUBLIC", "service_role"])],
    });
    expect(plan.revokes).toEqual([
      `revoke execute on routine ${a} from public`,
      `revoke execute on routine ${b} from public`,
    ]);
  });
});

describe("parseViewOptions / viewWithClause", () => {
  it("reads reloptions in the catalogue's spellings", () => {
    expect([...parseViewOptions("{security_invoker=true}")]).toEqual([
      ["security_invoker", "true"],
    ]);
    expect([...parseViewOptions(["security_invoker=on", "check_option=local"])]).toEqual([
      ["security_invoker", "true"],
      ["check_option", "local"],
    ]);
    expect(parseViewOptions("{}").size).toBe(0);
    expect(parseViewOptions(null).size).toBe(0);
  });

  it("drops what it does not manage and anything that is not a word", () => {
    expect(parseViewOptions("{fillfactor=70,security_barrier=maybe}").size).toBe(0);
    expect(parseViewOptions(["check_option=local);drop"]).size).toBe(0);
  });

  it("renders a WITH clause, or nothing", () => {
    expect(viewWithClause("{security_invoker=true}")).toBe(" with (security_invoker=true)");
    expect(viewWithClause("{check_option=cascaded,security_invoker=on}")).toBe(
      " with (security_invoker=true, check_option=cascaded)",
    );
    expect(viewWithClause("{}")).toBe("");
    expect(viewWithClause(undefined)).toBe("");
  });
});

describe("planViewOptionConvergence", () => {
  const view = "public.client_overview";

  it("restores security_invoker the clone path stripped", () => {
    const plan = planViewOptionConvergence({
      prime: [{ view, options: "{security_invoker=true}" }],
      clone: [{ view, options: null }],
    });
    expect(plan.statements).toEqual([`alter view ${view} set (security_invoker=true)`]);
    expect(plan.invokerRestored).toBe(1);
  });

  it("resets an option the prime does not carry", () => {
    const plan = planViewOptionConvergence({
      prime: [{ view, options: "{security_invoker=true}" }],
      clone: [{ view, options: "{security_invoker=true,security_barrier=true}" }],
    });
    expect(plan.statements).toEqual([`alter view ${view} reset (security_barrier)`]);
    expect(plan.invokerRestored).toBe(0);
  });

  it("leaves a matching view, a clone-only view and an unrendered name alone", () => {
    const plan = planViewOptionConvergence({
      prime: [
        { view, options: "{security_invoker=on}" },
        { view: "public.x; drop", options: "{security_invoker=true}" },
      ],
      clone: [
        { view, options: "{security_invoker=true}" },
        { view: "public.crm_only_view", options: null },
        { view: "public.x; drop", options: null },
      ],
    });
    expect(plan.statements).toEqual([]);
  });

  it("only accepts a rendered view name", () => {
    expect(isRenderedViewName("public.v")).toBe(true);
    expect(isRenderedViewName('aml."Case Overview"')).toBe(true);
    expect(isRenderedViewName("v")).toBe(false);
    expect(isRenderedViewName("public.v; drop table t")).toBe(false);
  });
});

describe("variantReferenceTexts", () => {
  it("keeps only what the clone holds and the prime does not", () => {
    const policy = "(public.has_role(auth.uid(), 'admin'::app_role))";
    const variant = "(public.crm_can_see(owner_id))";
    expect(variantReferenceTexts([policy], [policy, variant, null])).toEqual([variant]);
  });

  it("does not mistake a re-rendered definition for a variant's", () => {
    expect(
      variantReferenceTexts(["SELECT  public.f(x)\n FROM t"], ["SELECT public.f(x) FROM t"]),
    ).toEqual([]);
  });

  it("lets a shared policy's function be revoked while a variant's is held", () => {
    const shared = "(public.has_role(auth.uid(), 'admin'))";
    const variantPolicy = "(public.crm_is_member(auth.uid()))";
    const referenced = referencedFunctionNames(
      variantReferenceTexts([shared], [shared, variantPolicy]),
    );
    const plan = planRoutineAclConvergence({
      prime: [
        fn("public.has_role(_user_id uuid, _role text)", ["authenticated", "service_role"]),
        fn("public.crm_is_member(_user_id uuid)", ["service_role"]),
      ],
      clone: [
        fn("public.has_role(_user_id uuid, _role text)", [
          "PUBLIC",
          "authenticated",
          "service_role",
        ]),
        fn("public.crm_is_member(_user_id uuid)", ["PUBLIC", "service_role"]),
      ],
      referencedOnClone: referenced,
    });
    expect(plan.revokes).toEqual([
      "revoke execute on routine public.has_role(_user_id uuid, _role text) from public",
    ]);
    expect(plan.heldForReference.map((h) => h.signature)).toEqual([
      "public.crm_is_member(_user_id uuid)",
    ]);
  });
});
