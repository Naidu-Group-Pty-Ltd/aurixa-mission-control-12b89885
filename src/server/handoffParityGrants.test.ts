/**
 * Parity compares every role either side grants on a table both hold.
 *
 * It walked the prime's grantees only, so a role the prime grants nothing was
 * never compared. Measured 31 Oct 2026 on `relacl`: on the tutorial demo
 * `anon` held every privilege on `client_fact_finds`, `mh_audit` and
 * `mh_messages`, where the prime grants it none, and parity's grants diff
 * said nothing of it while the privilege sweep counted it.
 */
import { describe, it, expect } from "vitest";
import { diffGrants } from "./handoff-parity.server";

type SnapshotLike = Parameters<typeof diffGrants>[0];

const ALL = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];

function snap(grants: Record<string, Record<string, string[]>>, tables?: string[]): SnapshotLike {
  const grantsByTable = new Map(
    Object.entries(grants).map(([table, roles]) => [
      table,
      new Map(Object.entries(roles).map(([role, privs]) => [role, new Set(privs)])),
    ]),
  );
  const columnsByTable = new Map(
    (tables ?? Object.keys(grants)).map((t) => [t, new Map([["id", {}]])]),
  );
  return { grantsByTable, columnsByTable } as unknown as SnapshotLike;
}

/** The prime, as its `relacl` read on 31 Oct 2026. */
const PRIME = snap(
  {
    client_fact_finds: { authenticated: ["SELECT"], service_role: ALL },
    mh_audit: { service_role: ["INSERT", "SELECT"] },
  },
  ["client_fact_finds", "mh_audit", "report_geography_cache"],
);

describe("diffGrants", () => {
  it("reports a role the prime grants nothing on a table both hold: the demo's reading", () => {
    const demo = snap({
      client_fact_finds: { anon: ALL, authenticated: ALL, service_role: ALL },
      mh_audit: { anon: ALL, authenticated: ALL, service_role: ALL },
    });

    const d = diffGrants(PRIME, demo);

    expect(d.missing_grantees).toEqual([]);
    expect(d.drift).toEqual([
      { table: "client_fact_finds", role: "anon", missing_privileges: [], extra_privileges: ALL },
      {
        table: "client_fact_finds",
        role: "authenticated",
        missing_privileges: [],
        extra_privileges: ["DELETE", "INSERT", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"],
      },
      { table: "mh_audit", role: "anon", missing_privileges: [], extra_privileges: ALL },
      { table: "mh_audit", role: "authenticated", missing_privileges: [], extra_privileges: ALL },
      {
        table: "mh_audit",
        role: "service_role",
        missing_privileges: [],
        extra_privileges: ["DELETE", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"],
      },
    ]);
  });

  it("reports a table the prime grants no role at all, where the clone grants one", () => {
    const d = diffGrants(PRIME, snap({ report_geography_cache: { anon: ["SELECT"] } }));
    expect(d.drift).toEqual([
      {
        table: "report_geography_cache",
        role: "anon",
        missing_privileges: [],
        extra_privileges: ["SELECT"],
      },
    ]);
  });

  it("leaves out a table only the clone holds: that is surplus, not a grant difference", () => {
    const d = diffGrants(PRIME, snap({ tenant_notes: { anon: ALL } }));
    expect(d.drift.filter((x) => x.table === "tenant_notes")).toEqual([]);
  });

  it("still calls a grantee the prime has and the clone lacks missing", () => {
    const d = diffGrants(PRIME, snap({ client_fact_finds: { service_role: ALL } }));
    expect(d.missing_grantees).toEqual([
      { table: "client_fact_finds", role: "authenticated" },
      { table: "mh_audit", role: "service_role" },
    ]);
  });

  it("matches a clone that grants what the prime grants", () => {
    const same = snap({
      client_fact_finds: { authenticated: ["SELECT"], service_role: ALL },
      mh_audit: { service_role: ["INSERT", "SELECT"] },
    });
    expect(diffGrants(PRIME, same)).toEqual({ drift: [], missing_grantees: [] });
  });
});
