import { describe, expect, it } from "vitest";
import {
  billingIdHolders,
  checkCloneBillingId,
  resolveCloneBillingIdForProvisioning,
} from "./clone-billing-identity.server";

const CLONE = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const OTHER = "2242c67f-fc1d-4723-84fe-6a86898136d2";

type Row = Record<string, unknown> | null;

/**
 * A two-table double with the ONE behaviour that matters: an exact
 * `billing_user_id` lookup against each of `clones` and `tenants`, answering
 * at most one row because both columns carry a partial unique index.
 */
function db(opts: {
  clones?: Record<string, Row>;
  tenants?: Record<string, Row>;
  fail?: "clones" | "tenants";
}) {
  const calls: { table: string; id: string }[] = [];
  const updates: { table: string; patch: Record<string, unknown>; id: string }[] = [];
  const api = {
    calls,
    updates,
    from(table: string) {
      let column = "";
      let value = "";
      let patch: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        update(p: Record<string, unknown>) {
          patch = p;
          return chain;
        },
        eq(col: string, val: string) {
          column = col;
          value = val;
          if (patch) {
            updates.push({ table, patch, id: val });
            return Promise.resolve({ error: null });
          }
          return chain;
        },
        maybeSingle() {
          calls.push({ table, id: `${column}=${value}` });
          if (opts.fail === table) {
            return Promise.resolve({ data: null, error: { message: `${table} exploded` } });
          }
          const source = table === "clones" ? (opts.clones ?? {}) : (opts.tenants ?? {});
          return Promise.resolve({ data: source[value] ?? null, error: null });
        },
      };
      return chain;
    },
  };
  return api as unknown as Parameters<typeof billingIdHolders>[1] & typeof api;
}

describe("billingIdHolders", () => {
  it("reports a clone and a tenant carrying the same id", async () => {
    const holders = await billingIdHolders(
      "acme-corp",
      db({
        clones: {
          "acme-corp": { id: OTHER, name: "Preflight", slug: "p", billing_user_id: "acme-corp" },
        },
        tenants: {
          "acme-corp": {
            id: "t1",
            display_name: "Prime",
            external_ref: "prime:x",
            clone_id: null,
            billing_user_id: "acme-corp",
          },
        },
      }),
    );
    expect(holders.map((h) => h.kind)).toEqual(["clone", "tenant"]);
  });

  it("carries the id each row states, so the pure rule can match on it", async () => {
    const holders = await billingIdHolders(
      "x",
      db({ clones: { x: { id: OTHER, name: "P", slug: "p", billing_user_id: "x" } } }),
    );
    expect(holders[0].billingId).toBe("x");
  });

  // A read that FAILED is not an id nobody holds — and "nobody holds it" is
  // exactly the answer that lets a shadowing id be written.
  it("throws rather than reporting an empty set when a lookup fails", async () => {
    await expect(billingIdHolders("x", db({ fail: "tenants" }))).rejects.toThrow(/tenants/);
    await expect(billingIdHolders("x", db({ fail: "clones" }))).rejects.toThrow(/clones/);
  });
});

describe("checkCloneBillingId", () => {
  it("settles shape without a round trip", async () => {
    const d = db({});
    const v = await checkCloneBillingId("not a slug", CLONE, d);
    expect(v.ok).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it("settles the prime's own id without a round trip", async () => {
    const d = db({});
    const v = await checkCloneBillingId("npc-prime", CLONE, d);
    expect(v.ok === false && v.reason).toBe("reserved");
    expect(d.calls).toEqual([]);
  });

  it("refuses an id a foreign tenant holds", async () => {
    const v = await checkCloneBillingId(
      "acme-corp",
      CLONE,
      db({
        tenants: {
          "acme-corp": {
            id: "t1",
            display_name: "Somebody Else",
            external_ref: null,
            clone_id: OTHER,
            billing_user_id: "acme-corp",
          },
        },
      }),
    );
    expect(v.ok === false && v.reason).toBe("shadows_tenant");
  });

  it("accepts an id this clone's own tenant holds", async () => {
    const v = await checkCloneBillingId(
      "acme-corp",
      CLONE,
      db({
        tenants: {
          "acme-corp": {
            id: "t1",
            display_name: null,
            external_ref: null,
            clone_id: CLONE,
            billing_user_id: "acme-corp",
          },
        },
      }),
    );
    expect(v.ok).toBe(true);
  });
});

describe("resolveCloneBillingIdForProvisioning", () => {
  it("prefers what the operator asked for", async () => {
    const r = await resolveCloneBillingIdForProvisioning(
      {
        requested: "Acme-Corp",
        slug: "acme-corp-9f21aa",
      },
      db({}),
    );
    expect(r).toEqual({ billingId: "acme-corp", source: "operator", note: null });
  });

  it("derives from the slug when nobody named one", async () => {
    const r = await resolveCloneBillingIdForProvisioning(
      {
        slug: "npc-crm-independent-6505dc",
      },
      db({}),
    );
    expect(r.billingId).toBe("npc-crm-independent-6505dc");
    expect(r.source).toBe("derived");
  });

  it("falls back to the slug when the operator's choice is refused, and says so", async () => {
    const r = await resolveCloneBillingIdForProvisioning(
      {
        requested: "npc-prime",
        slug: "acme-corp",
      },
      db({}),
    );
    expect(r.billingId).toBe("acme-corp");
    expect(r.source).toBe("derived");
    expect(r.note).toContain("was not used");
  });

  // An unreadable control plane is not a free pass: the one refusal that
  // matters is exactly what the read would have found.
  it("records nothing when the operator's choice could not be checked", async () => {
    const r = await resolveCloneBillingIdForProvisioning(
      {
        requested: "acme-corp",
        slug: "acme-corp",
      },
      db({ fail: "tenants" }),
    );
    expect(r.billingId).toBeNull();
    expect(r.source).toBe("none");
    expect(r.note).toContain("could not be checked");
  });

  it("records nothing when the derivation collides too", async () => {
    const r = await resolveCloneBillingIdForProvisioning(
      { slug: "acme-corp" },
      db({
        clones: {
          "acme-corp": { id: OTHER, name: "Other", slug: "o", billing_user_id: "acme-corp" },
        },
      }),
    );
    expect(r.billingId).toBeNull();
    expect(r.note).toContain("was not used");
  });

  it("records nothing, and never throws, when the slug derives to nothing", async () => {
    const r = await resolveCloneBillingIdForProvisioning({ slug: "_" }, db({}));
    expect(r.billingId).toBeNull();
    expect(r.note).toContain("could be derived");
  });
});
