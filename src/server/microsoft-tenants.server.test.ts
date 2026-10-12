// Changing a tenant writes twice — its credentials into the Vault, then its
// row — and the two must never be left disagreeing. Driven through the real
// `updateTenant` against an in-memory table and Vault that behave like the
// migration's: the put function bumps `credentials_version`, and the live-name
// unique index refuses a clash.
//
//   - a name another tenant has is refused before anything is stored;
//   - a row that cannot be saved puts the previous credentials back;
//   - when even that fails, the admin is told to save again, not that
//     nothing changed;
//   - a change that goes through stores both, and audits no value.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tenants: [] as Record<string, unknown>[],
  vault: new Map<string, string>(),
  /** Every update of a tenant row fails with this, while set. */
  failUpdate: null as string | null,
  /** Credential writes beyond this many fail. */
  putsAllowed: Infinity,
  puts: 0,
  audits: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Row = Record<string, unknown>;
  const sameName = (a: unknown, b: unknown) =>
    String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  class Query implements PromiseLike<unknown> {
    private filters: ((row: Row) => boolean)[] = [];
    private patch: Row | null = null;
    private one = false;

    constructor(private readonly table: string) {
      if (table !== "microsoft_tenants") throw new Error(`fake: no table ${table}`);
    }
    select() {
      return this;
    }
    update(patch: Row) {
      this.patch = patch;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    neq(column: string, value: unknown) {
      this.filters.push((row) => row[column] !== value);
      return this;
    }
    is(column: string, value: null) {
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    maybeSingle() {
      this.one = true;
      return this;
    }
    private run() {
      const matching = db.tenants.filter((row) => this.filters.every((test) => test(row)));
      if (this.patch) {
        const label = this.patch.label;
        if (
          label !== undefined &&
          db.tenants.some(
            (other) =>
              !other.removed_at && !matching.includes(other) && sameName(other.label, label),
          )
        ) {
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint "microsoft_tenants_label_live"',
            },
          };
        }
        if (db.failUpdate) return { data: null, error: { message: db.failUpdate } };
        for (const row of matching) Object.assign(row, this.patch);
        return { data: null, error: null };
      }
      const copies = matching.map((row) => ({ ...row }));
      return { data: this.one ? (copies[0] ?? null) : copies, error: null };
    }
    then<T1, T2>(
      resolve?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
      reject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve()
        .then(() => this.run())
        .then(resolve, reject);
    }
  }

  return {
    supabaseAdmin: {
      from: (table: string) => new Query(table),
      rpc: async (name: string, args: { p_tenant: string; p_credentials?: string }) => {
        if (name === "microsoft_tenant_credentials") {
          return { data: db.vault.get(args.p_tenant) ?? null, error: null };
        }
        if (name === "microsoft_tenant_credentials_put") {
          db.puts += 1;
          if (db.puts > db.putsAllowed) {
            return { data: null, error: { message: "could not write to the vault" } };
          }
          const row = db.tenants.find(
            (tenant) => tenant.id === args.p_tenant && !tenant.removed_at,
          );
          if (!row) return { data: null, error: { message: "microsoft_tenant_not_found" } };
          db.vault.set(args.p_tenant, args.p_credentials!);
          row.vault_secret_id ??= `secret-${args.p_tenant}`;
          row.credentials_version = Number(row.credentials_version) + 1;
          return { data: null, error: null };
        }
        throw new Error(`fake: no rpc ${name}`);
      },
    },
  };
});

vi.mock("@/server/audit.server", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    db.audits.push(entry);
  },
}));

vi.mock("@/server/graph-client", () => {
  class GraphError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code: string | null,
    ) {
      super(message);
    }
  }
  const claims = Buffer.from(JSON.stringify({ roles: ["Mail.Send"] })).toString("base64url");
  return {
    GraphError,
    defaultGraphConfig: () => null,
    accessToken: async () => `e30.${claims}.signature`,
    forgetToken: () => undefined,
    probeMailboxes: async (addresses: string[]) =>
      addresses.map((address) => ({ address, status: 200, code: null })),
  };
});

const { updateTenant, graphConfigFor, forgetTenantConfig } =
  await import("./microsoft-tenants.server");

const ACTOR = "99999999-9999-4999-8999-999999999999";
const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const GAMMA = "33333333-3333-4333-8333-333333333333";

const OLD = {
  tenantId: "5f1c7a4e-2b3d-4c8e-9f60-1a2b3c4d5e6f",
  clientId: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  clientSecret: "old~Q8.secret_value-1",
};
const NEW_SECRET = "new~Q8.secret_value-2";

function tenant(id: string, label: string, over: Row = {}): Row {
  return {
    id,
    label,
    default_mailbox: null,
    directory_hint: "…5e6f",
    client_hint: "…7c6d",
    secret_hint: "old…",
    secret_expires_on: null,
    fingerprint: id.replace(/-/g, "").padEnd(64, "0"),
    vault_secret_id: `secret-${id}`,
    credentials_version: 1,
    granted_roles: null,
    verified_at: null,
    verify_error: null,
    removed_at: null,
    ...over,
  };
}

const row = (id: string) => db.tenants.find((tenant) => tenant.id === id)!;
const stored = (id: string) => JSON.parse(db.vault.get(id)!) as typeof OLD;

beforeEach(() => {
  db.tenants = [
    tenant(ACME, "Acme"),
    tenant(BETA, "Beta"),
    tenant(GAMMA, "Gamma", { removed_at: "2026-10-01T00:00:00Z", vault_secret_id: null }),
  ];
  db.vault = new Map([
    [ACME, JSON.stringify({ ...OLD, clientId: "6c5d4e3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f" })],
    [BETA, JSON.stringify(OLD)],
  ]);
  db.failUpdate = null;
  db.putsAllowed = Infinity;
  db.puts = 0;
  db.audits = [];
  forgetTenantConfig();
});

describe("changing a tenant's credentials and details together", () => {
  it("refuses a name another tenant has before storing anything", async () => {
    await expect(
      updateTenant(BETA, { label: " acme ", clientSecret: NEW_SECRET }, ACTOR),
    ).rejects.toThrow("another tenant already has that name");

    expect(db.puts).toBe(0);
    expect(stored(BETA)).toEqual(OLD);
    expect(row(BETA)).toMatchObject({ label: "Beta", secret_hint: "old…", credentials_version: 1 });
    expect(db.audits).toEqual([]);
  });

  it("puts the previous credentials back when the row cannot be saved", async () => {
    db.failUpdate = "fetch failed";

    await expect(updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow(
      "fetch failed",
    );

    expect(stored(BETA)).toEqual(OLD);
    expect(row(BETA).secret_hint).toBe("old…");
    // Both writes bumped the version, so no token minted with the refused
    // secret is ever picked up again.
    const config = await graphConfigFor(BETA);
    expect(config).toMatchObject({ clientSecret: OLD.clientSecret, key: `tenant:${BETA}:v3` });
    expect(db.audits).toEqual([]);
  });

  it("puts back what the Vault holds, not this isolate's cached copy", async () => {
    await graphConfigFor(BETA); // cached: the secret as it was
    const rotated = { ...OLD, clientSecret: "mid~Q8.rotated_elsewhere" };
    db.vault.set(BETA, JSON.stringify(rotated)); // another isolate rotated it since
    db.failUpdate = "fetch failed";

    await expect(updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow();

    expect(stored(BETA)).toEqual(rotated);
  });

  it("says the change half-happened when the old credentials cannot be put back", async () => {
    db.failUpdate = "fetch failed";
    db.putsAllowed = 1; // the new credentials store; restoring the old ones fails

    await expect(updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow(
      /the new credentials were stored .*could not be put back — save the tenant again/,
    );
    expect(stored(BETA).clientSecret).toBe(NEW_SECRET);
  });

  it("stores both when nothing is in the way, and audits no value", async () => {
    await updateTenant(BETA, { label: "Beta EU", clientSecret: NEW_SECRET }, ACTOR);

    expect(stored(BETA)).toEqual({ ...OLD, clientSecret: NEW_SECRET });
    expect(row(BETA)).toMatchObject({
      label: "Beta EU",
      secret_hint: "new…",
      credentials_version: 2,
      granted_roles: ["Mail.Send"],
      verify_error: null,
    });
    expect((await graphConfigFor(BETA))?.clientSecret).toBe(NEW_SECRET);
    expect(db.audits).toEqual([
      expect.objectContaining({
        action: "microsoft_tenant_updated",
        metadata: expect.objectContaining({ fields: ["label", "clientSecret"] }),
      }),
    ]);
    expect(JSON.stringify(db.audits)).not.toContain(NEW_SECRET);
  });

  it("lets a tenant take a removed tenant's name, or its own in another case", async () => {
    await updateTenant(BETA, { label: "GAMMA" }, ACTOR);
    await updateTenant(ACME, { label: "ACME" }, ACTOR);

    expect(row(BETA).label).toBe("GAMMA");
    expect(row(ACME).label).toBe("ACME");
    expect(db.puts).toBe(0);
  });
});
