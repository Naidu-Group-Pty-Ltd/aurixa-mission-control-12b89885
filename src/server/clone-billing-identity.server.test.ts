import { describe, expect, it } from "vitest";
import {
  billingIdHolders,
  checkCloneBillingId,
  ensureCloneBillingIdForDeployment,
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

/**
 * A control plane with rows in it, for the worker's heal: the heal WRITES,
 * conditionally, and reads back — so the double has to hold state and answer
 * `.is("billing_user_id", null)` the way Postgres does, or a test of "an
 * operator who wrote first wins" is a test of the double.
 */
type CloneRow = { id: string; slug: string; name?: string; billing_user_id: string | null };
type TenantRow = {
  id: string;
  display_name?: string | null;
  external_ref?: string | null;
  clone_id: string | null;
  billing_user_id: string | null;
};

function controlPlane(opts: {
  clones: CloneRow[];
  tenants?: TenantRow[];
  /** Make the conditional write fail with this message. */
  failWrite?: string;
  /** Make a holder lookup against this table fail. */
  failLookup?: "clones" | "tenants";
  /** An operator writes this between the heal's read and its write. */
  operatorWritesFirst?: string;
}) {
  const writes: { id: string; to: unknown }[] = [];
  const api = {
    writes,
    from(table: string) {
      const rows: Record<string, unknown>[] =
        table === "clones" ? opts.clones : ((opts.tenants ?? []) as Record<string, unknown>[]);
      const filters: [string, unknown][] = [];
      let patch: Record<string, unknown> | null = null;
      const matching = () => rows.filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
      const chain = {
        select: () => chain,
        update(p: Record<string, unknown>) {
          patch = p;
          return chain;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return chain;
        },
        is(col: string, val: unknown) {
          filters.push([col, val]);
          return chain;
        },
        async maybeSingle() {
          if (patch) {
            if (opts.failWrite) return { data: null, error: { message: opts.failWrite } };
            if (opts.operatorWritesFirst) {
              const id = filters.find(([c]) => c === "id")?.[1];
              for (const r of rows) if (r.id === id) r.billing_user_id = opts.operatorWritesFirst;
            }
            const target = matching();
            for (const r of target) {
              Object.assign(r, patch);
              writes.push({ id: String(r.id), to: patch.billing_user_id });
            }
            return {
              data: target[0] ? { billing_user_id: target[0].billing_user_id } : null,
              error: null,
            };
          }
          if (opts.failLookup === table) {
            return { data: null, error: { message: `${table} exploded` } };
          }
          return { data: matching()[0] ?? null, error: null };
        },
      };
      return chain;
    },
  };
  return api as unknown as Parameters<typeof ensureCloneBillingIdForDeployment>[1] & typeof api;
}

describe("ensureCloneBillingIdForDeployment — the worker heals before it publishes", () => {
  it("returns an identity the clone already holds, and reads and writes nothing", async () => {
    const cp = controlPlane({
      clones: [{ id: CLONE, slug: "acme-corp", billing_user_id: "chosen-by-operator" }],
    });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: "chosen-by-operator" },
      cp,
    );
    expect(r).toEqual({ billingId: "chosen-by-operator", healed: false, note: null });
    expect(cp.writes).toEqual([]);
  });

  it("gives a clone with none the identity the rule derives, and records it first", async () => {
    const clones: CloneRow[] = [{ id: CLONE, slug: "acme-corp", billing_user_id: null }];
    const cp = controlPlane({ clones });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    expect(r.billingId).toBe("acme-corp");
    expect(r.healed).toBe(true);
    // Written to the column before anything is published, so the bundle and
    // every server-side resolution cannot name different workspaces.
    expect(cp.writes).toEqual([{ id: CLONE, to: "acme-corp" }]);
    expect(clones[0].billing_user_id).toBe("acme-corp");
  });

  it("heals where this clone's OWN tenant already carries the slug", async () => {
    const cp = controlPlane({
      clones: [{ id: CLONE, slug: "acme-corp", billing_user_id: null }],
      tenants: [{ id: "t1", clone_id: CLONE, billing_user_id: "acme-corp" }],
    });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    expect(r.billingId).toBe("acme-corp");
    expect(r.healed).toBe(true);
  });

  it("refuses what the rule refuses — a foreign tenant's id is never taken", async () => {
    const cp = controlPlane({
      clones: [{ id: CLONE, slug: "acme-corp", billing_user_id: null }],
      tenants: [
        { id: "t9", display_name: "Somebody Else", clone_id: OTHER, billing_user_id: "acme-corp" },
      ],
    });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    expect(r.billingId).toBeNull();
    expect(r.healed).toBe(false);
    expect(r.note).toMatch(/shadow/);
    expect(cp.writes).toEqual([]);
  });

  it("never gives a clone the prime's own identity", async () => {
    const cp = controlPlane({ clones: [{ id: CLONE, slug: "npc-prime", billing_user_id: null }] });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "npc-prime", current: null },
      cp,
    );
    expect(r.billingId).toBeNull();
    expect(cp.writes).toEqual([]);
  });

  it("publishes the operator's choice when they recorded one while it ran", async () => {
    const clones: CloneRow[] = [{ id: CLONE, slug: "acme-corp", billing_user_id: null }];
    const cp = controlPlane({ clones, operatorWritesFirst: "their-choice" });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    expect(r.billingId, "theirs, read back — not the derivation").toBe("their-choice");
    expect(r.healed).toBe(false);
    expect(clones[0].billing_user_id, "and the conditional write did not overwrite it").toBe(
      "their-choice",
    );
  });

  it("publishes nothing, and never throws, when the identity cannot be recorded", async () => {
    const cp = controlPlane({
      clones: [{ id: CLONE, slug: "acme-corp", billing_user_id: null }],
      failWrite: "permission denied",
    });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    // An id the column does not hold, published into the bundle, is the one
    // outcome worse than publishing none.
    expect(r.billingId).toBeNull();
    expect(r.note).toMatch(/could not be recorded/);
  });

  it("publishes nothing when the control plane cannot be read — it is not a free pass", async () => {
    const cp = controlPlane({
      clones: [{ id: CLONE, slug: "acme-corp", billing_user_id: null }],
      failLookup: "tenants",
    });
    const r = await ensureCloneBillingIdForDeployment(
      { cloneId: CLONE, slug: "acme-corp", current: null },
      cp,
    );
    expect(r.billingId).toBeNull();
    expect(cp.writes).toEqual([]);
    expect(r.note).toMatch(/could not be checked/);
  });
});
