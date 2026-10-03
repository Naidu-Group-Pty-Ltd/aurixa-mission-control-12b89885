import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  A clone's token client meters under `prime:<project ref>`, while provisioning
  creates the clone's tenant under the clone's id and stamps the clone's
  billing id on it. The billing id is unique across `tenants`, so the insert
  `ensureTenant` used to attempt for the `prime:` ref failed with 23505 on
  every reserve. Measured 3 Oct 2026 on three of the four clones.
*/

type Tenant = {
  id: string;
  clone_id: string | null;
  external_ref: string;
  billing_user_id: string | null;
};

const db = vi.hoisted(() => ({
  clones: [] as Array<{ id: string; billing_user_id: string | null }>,
  tenants: [] as Array<Record<string, unknown>>,
  inserts: 0,
  raceHolder: null as Record<string, unknown> | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const table = (name: string) => {
    const filters: Array<[string, unknown]> = [];
    let pendingInsert: Record<string, unknown> | null = null;
    const rows = () => {
      const src =
        name === "clones"
          ? (db.clones as Array<Record<string, unknown>>)
          : name === "tenants"
            ? db.tenants
            : [];
      return src.filter((r) => filters.every(([k, v]) => r[k] === v));
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      is: (k: string, v: unknown) => (filters.push([k, v]), b),
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => ((pendingInsert = row), b),
      maybeSingle: async () => {
        if (name === "billing_plans") return { data: null, error: null };
        return { data: rows()[0] ?? null, error: null };
      },
      single: async () => {
        db.inserts += 1;
        const row = pendingInsert ?? {};
        const clash = db.tenants.find(
          (t) => row.billing_user_id && t.billing_user_id === row.billing_user_id,
        );
        if (clash || db.raceHolder) {
          if (db.raceHolder) db.tenants.push(db.raceHolder);
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const created = { id: `new-${db.inserts}`, ...row };
        db.tenants.push(created);
        return { data: { id: created.id }, error: null };
      },
    };
    return b;
  };
  return { supabaseAdmin: { from: (n: string) => table(n), rpc: async () => ({}) } };
});

import { ensureTenant } from "./clone-api-keys.server";

const CLONE = "e97f18ab-a3e3-4350-a0c9-d3f8584d6243";
const OTHER = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const provisioned: Tenant = {
  id: "9a8547bd",
  clone_id: CLONE,
  external_ref: CLONE,
  billing_user_id: "npc-crm-independent-6505dc",
};

beforeEach(() => {
  db.clones = [{ id: CLONE, billing_user_id: "npc-crm-independent-6505dc" }];
  db.tenants = [{ ...provisioned }];
  db.inserts = 0;
  db.raceHolder = null;
});

describe("ensureTenant for a clone that meters under prime:<ref>", () => {
  it("adopts the clone's own tenant holding its billing id instead of a 23505", async () => {
    const r = await ensureTenant(CLONE, "prime:qvuwrvwzjyigptmnijyb", "Prime");
    expect(r).toEqual({
      ok: true,
      tenantId: provisioned.id,
      billingUserId: "npc-crm-independent-6505dc",
    });
    expect(db.inserts).toBe(0);
    expect(db.tenants).toHaveLength(1);
  });

  it("still finds an existing prime: tenant by its ref first", async () => {
    db.tenants.push({
      id: "metering",
      clone_id: CLONE,
      external_ref: "prime:qvuwrvwzjyigptmnijyb",
      billing_user_id: null,
    });
    const r = await ensureTenant(CLONE, "prime:qvuwrvwzjyigptmnijyb");
    expect(r.ok && r.tenantId).toBe("metering");
  });

  it("refuses a billing id another clone's tenant holds, rather than crediting it", async () => {
    db.tenants = [{ ...provisioned, clone_id: OTHER }];
    const r = await ensureTenant(CLONE, "prime:qvuwrvwzjyigptmnijyb");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("another clone");
    expect(db.inserts).toBe(0);
  });

  it("provisions a tenant for a clone that has none", async () => {
    db.tenants = [];
    const r = await ensureTenant(CLONE, "prime:qvuwrvwzjyigptmnijyb");
    expect(r.ok).toBe(true);
    expect(db.inserts).toBe(1);
  });

  it("adopts the holder a concurrent request created between lookup and insert", async () => {
    db.tenants = [];
    db.raceHolder = { ...provisioned };
    const r = await ensureTenant(CLONE, "prime:qvuwrvwzjyigptmnijyb");
    expect(r.ok && r.tenantId).toBe(provisioned.id);
  });

  it("leaves a tenant with no clone (a builder organisation) on the insert path", async () => {
    db.clones = [];
    db.tenants = [];
    const r = await ensureTenant(null, "builder-org:abc");
    expect(r.ok).toBe(true);
    expect(db.inserts).toBe(1);
  });
});
