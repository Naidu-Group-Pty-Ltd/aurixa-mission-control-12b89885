// Adding and changing a tenant: what the server asks the database to store,
// and what it does with the answer. Driven through the real `addTenant`,
// `updateTenant` and `verifyTenant` against an in-memory table and Vault whose
// two write functions keep the rules of the migration's
// (20261012150000_microsoft_tenant_atomic_writes.sql), which were themselves
// checked against a real Postgres: one call stores the credentials and the row
// together or nothing at all, only the allowed columns can be given, new
// credentials need their hints and the version they replace, and the live
// name and app registration are unique.
//
//   - one call per save, and never the old two-write path;
//   - a refused save leaves the tenant exactly as it was;
//   - credentials someone else stored meanwhile are never overwritten;
//   - fields left blank keep what the Vault holds now, not a cached copy;
//   - a verification overtaken by new credentials is not recorded over theirs.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tenants: [] as Record<string, unknown>[],
  vault: new Map<string, string>(),
  /** Every save fails with this before anything is stored, while set. */
  failSave: null as string | null,
  /** Runs once, just after the Vault is next read. */
  afterVaultRead: null as null | (() => void),
  /** Runs once, while Microsoft is next asked for a token. */
  whileVerifying: null as null | (() => void),
  calls: [] as { name: string; args: Record<string, unknown> }[],
  audits: [] as Record<string, unknown>[],
  seq: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Row = Record<string, unknown>;
  type Answer = { data: unknown; error: { message: string } | null };
  const COLUMNS = [
    "label",
    "default_mailbox",
    "secret_expires_on",
    "directory_hint",
    "client_hint",
    "secret_hint",
    "fingerprint",
    "granted_roles",
    "verified_at",
    "verify_error",
  ];
  const HINTS = ["directory_hint", "client_hint", "secret_hint", "fingerprint"];
  const refuse = (message: string): Answer => ({ data: null, error: { message } });
  const name = (value: unknown) => String(value).trim().toLowerCase();

  /** The live-tenant unique indexes, as a would-be row would meet them. */
  function clash(candidate: Row, exceptId: unknown): Answer | null {
    const others = db.tenants.filter((other) => !other.removed_at && other.id !== exceptId);
    if (others.some((other) => name(other.label) === name(candidate.label))) {
      return refuse(
        'duplicate key value violates unique constraint "microsoft_tenants_label_live"',
      );
    }
    if (others.some((other) => other.fingerprint === candidate.fingerprint)) {
      return refuse(
        'duplicate key value violates unique constraint "microsoft_tenants_fingerprint_live"',
      );
    }
    return null;
  }
  function store(row: Row, credentials: string) {
    db.vault.set(String(row.id), credentials);
    row.vault_secret_id ??= `secret-${String(row.id)}`;
    row.credentials_version = Number(row.credentials_version) + 1;
  }

  function update(args: Row): Answer {
    if (db.failSave) return refuse(db.failSave);
    const patch = (args.p_patch ?? {}) as Row;
    const unknown = Object.keys(patch).find((key) => !COLUMNS.includes(key));
    if (unknown) return refuse(`microsoft_tenant_patch_invalid: ${unknown} cannot be changed`);
    const credentials = args.p_credentials as string | undefined;
    if (credentials != null) {
      if (!HINTS.every((key) => key in patch)) {
        return refuse("microsoft_tenant_patch_invalid: new credentials need their hints");
      }
      if (args.p_expected_version == null) {
        return refuse("microsoft_tenant_patch_invalid: new credentials need a version");
      }
    }
    const row = db.tenants.find((tenant) => tenant.id === args.p_tenant && !tenant.removed_at);
    if (!row) return refuse("microsoft_tenant_not_found");
    if (credentials != null && row.credentials_version !== args.p_expected_version) {
      return refuse("microsoft_tenant_changed");
    }
    const problem = clash({ ...row, ...patch }, row.id);
    if (problem) return problem;
    if (credentials != null) store(row, credentials);
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    return { data: row.credentials_version, error: null };
  }

  function add(args: Row): Answer {
    if (db.failSave) return refuse(db.failSave);
    const details = (args.p_details ?? {}) as Row;
    const unknown = Object.keys(details).find(
      (key) => !COLUMNS.includes(key) && key !== "created_by",
    );
    if (unknown) return refuse(`microsoft_tenant_patch_invalid: ${unknown} cannot be set`);
    if (!args.p_credentials) return refuse("microsoft_tenant_credentials_empty");
    const problem = clash(details, null);
    if (problem) return problem;
    const row: Row = {
      id: `00000000-0000-4000-8000-${String(++db.seq).padStart(12, "0")}`,
      ...details,
      credentials_version: 0,
      vault_secret_id: null,
      removed_at: null,
    };
    db.tenants.push(row);
    store(row, String(args.p_credentials));
    return { data: row.id, error: null };
  }

  class Query implements PromiseLike<unknown> {
    private filters: ((row: Row) => boolean)[] = [];
    private patch: Row | null = null;
    private one = false;

    constructor(table: string) {
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
    private run(): Answer {
      const matching = db.tenants.filter((row) => this.filters.every((test) => test(row)));
      if (this.patch) {
        const patch = Object.fromEntries(
          Object.entries(this.patch).filter(([, value]) => value !== undefined),
        );
        for (const row of matching) Object.assign(row, patch);
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
      rpc: async (fn: string, args: Row): Promise<Answer> => {
        db.calls.push({ name: fn, args });
        if (fn === "microsoft_tenant_credentials") {
          const value = db.vault.get(String(args.p_tenant)) ?? null;
          const after = db.afterVaultRead;
          db.afterVaultRead = null;
          after?.();
          return { data: value, error: null };
        }
        if (fn === "microsoft_tenant_update") return update(args);
        if (fn === "microsoft_tenant_add") return add(args);
        throw new Error(`fake: no rpc ${fn}`);
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
    accessToken: async () => {
      const during = db.whileVerifying;
      db.whileVerifying = null;
      during?.();
      return `e30.${claims}.signature`;
    },
    forgetToken: () => undefined,
    probeMailboxes: async (addresses: string[]) =>
      addresses.map((address) => ({ address, status: 200, code: null })),
  };
});

const { addTenant, updateTenant, verifyTenant, graphConfigFor, forgetTenantConfig } =
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
const saves = () => db.calls.filter((call) => call.name !== "microsoft_tenant_credentials");

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
  db.failSave = null;
  db.afterVaultRead = null;
  db.whileVerifying = null;
  db.calls = [];
  db.audits = [];
  db.seq = 0;
  forgetTenantConfig();
});

describe("changing a tenant", () => {
  it("stores new credentials and details in one call, against the version it read", async () => {
    await updateTenant(BETA, { label: "Beta EU", clientSecret: NEW_SECRET }, ACTOR);

    expect(saves()).toHaveLength(1);
    const [save] = saves();
    expect(save.name).toBe("microsoft_tenant_update");
    expect(save.args).toMatchObject({
      p_tenant: BETA,
      p_expected_version: 1,
      p_patch: {
        label: "Beta EU",
        directory_hint: "…5e6f",
        client_hint: "…7c6d",
        secret_hint: "new…",
        granted_roles: ["Mail.Send"],
        verify_error: null,
      },
    });
    expect(JSON.parse(String(save.args.p_credentials))).toEqual({
      ...OLD,
      clientSecret: NEW_SECRET,
    });

    expect(stored(BETA)).toEqual({ ...OLD, clientSecret: NEW_SECRET });
    expect(row(BETA)).toMatchObject({
      label: "Beta EU",
      secret_hint: "new…",
      credentials_version: 2,
    });
    expect(await graphConfigFor(BETA)).toMatchObject({
      clientSecret: NEW_SECRET,
      key: `tenant:${BETA}:v2`,
    });
    expect(db.audits).toEqual([
      expect.objectContaining({
        action: "microsoft_tenant_updated",
        metadata: expect.objectContaining({ fields: ["label", "clientSecret"] }),
      }),
    ]);
    expect(JSON.stringify(db.audits)).not.toContain(NEW_SECRET);
  });

  it("changes details alone without credentials or a version", async () => {
    await updateTenant(
      BETA,
      { label: "Renamed", defaultMailbox: "OPS@beta.example", secretExpiresOn: "2027-03-31" },
      ACTOR,
    );

    const [save] = saves();
    expect(save.args).toEqual({
      p_tenant: BETA,
      p_patch: {
        label: "Renamed",
        default_mailbox: "ops@beta.example",
        secret_expires_on: "2027-03-31",
      },
      p_credentials: undefined,
      p_expected_version: undefined,
    });
    expect(row(BETA)).toMatchObject({ label: "Renamed", credentials_version: 1 });
    expect(stored(BETA)).toEqual(OLD);
  });

  it("leaves the tenant exactly as it was when the save is refused, and says why", async () => {
    const before = { ...row(BETA) };

    await expect(
      updateTenant(BETA, { label: " acme ", clientSecret: NEW_SECRET }, ACTOR),
    ).rejects.toThrow("another tenant already has that name");

    expect(row(BETA)).toEqual(before);
    expect(stored(BETA)).toEqual(OLD);
    expect(db.audits).toEqual([]);
    expect(saves().map((call) => call.name)).toEqual(["microsoft_tenant_update"]);
  });

  it("leaves the tenant as it was when the save fails outright", async () => {
    const before = { ...row(BETA) };
    db.failSave = "fetch failed";

    await expect(updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow(
      "fetch failed",
    );

    expect(row(BETA)).toEqual(before);
    expect(stored(BETA)).toEqual(OLD);
    expect(db.audits).toEqual([]);
  });

  it("never overwrites credentials someone else stored after this edit began", async () => {
    const theirs = { ...OLD, clientSecret: "their~Q8.rotation" };
    // Another admin's save lands after this edit has read the Vault to merge.
    db.afterVaultRead = () => {
      db.vault.set(BETA, JSON.stringify(theirs));
      row(BETA).credentials_version = 2;
      row(BETA).secret_hint = "the…";
    };

    await expect(updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow(
      /someone else saved new credentials for this tenant/,
    );

    expect(stored(BETA)).toEqual(theirs);
    expect(row(BETA)).toMatchObject({ secret_hint: "the…", credentials_version: 2 });
    expect(saves()[0].args.p_expected_version).toBe(1);
    expect(db.audits).toEqual([]);
  });

  it("keeps blank fields at what the Vault holds now, not this isolate's cached copy", async () => {
    await graphConfigFor(BETA); // cached here: the credentials as they were
    // Another isolate stores a new client ID and secret.
    const elsewhere = {
      ...OLD,
      clientId: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
      clientSecret: "else~Q8.where",
    };
    db.vault.set(BETA, JSON.stringify(elsewhere));
    row(BETA).credentials_version = 2;

    await updateTenant(BETA, { clientSecret: NEW_SECRET }, ACTOR);

    // The client ID the other isolate stored is kept, not the cached one.
    expect(stored(BETA)).toEqual({ ...elsewhere, clientSecret: NEW_SECRET });
    expect(saves()[0].args.p_expected_version).toBe(2);
  });

  it("refuses a tenant that was removed, before asking Microsoft anything", async () => {
    await expect(updateTenant(GAMMA, { clientSecret: NEW_SECRET }, ACTOR)).rejects.toThrow(
      "that tenant does not exist or was removed",
    );
    expect(saves()).toEqual([]);
  });
});

describe("adding a tenant", () => {
  const input = {
    label: "Delta",
    directoryTenantId: "7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
    clientId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
    clientSecret: "delta~Q8.secret",
    defaultMailbox: "Hello@Delta.example",
    secretExpiresOn: "2027-06-30",
  };

  it("stores the row and its credentials in one call", async () => {
    const { id, verification } = await addTenant(input, ACTOR);

    expect(verification.ok).toBe(true);
    expect(saves()).toHaveLength(1);
    const [save] = saves();
    expect(save.name).toBe("microsoft_tenant_add");
    expect(save.args.p_details).toMatchObject({
      label: "Delta",
      default_mailbox: "hello@delta.example",
      secret_expires_on: "2027-06-30",
      directory_hint: "…3c2d",
      client_hint: "…5e6f",
      secret_hint: "del…",
      granted_roles: ["Mail.Send"],
      created_by: ACTOR,
    });
    expect(row(id)).toMatchObject({ label: "Delta", credentials_version: 1 });
    expect(await graphConfigFor(id)).toMatchObject({
      tenantId: input.directoryTenantId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      mailbox: "hello@delta.example",
    });
    expect(db.audits).toEqual([expect.objectContaining({ action: "microsoft_tenant_added" })]);
    expect(JSON.stringify(db.audits)).not.toContain(input.clientSecret);
  });

  it("leaves neither a row nor a secret when the add is refused", async () => {
    const tenants = db.tenants.length;
    const secrets = db.vault.size;

    await expect(addTenant({ ...input, label: "BETA" }, ACTOR)).rejects.toThrow(
      "another tenant already has that name",
    );

    expect(db.tenants).toHaveLength(tenants);
    expect(db.vault.size).toBe(secrets);
    expect(db.audits).toEqual([]);
  });
});

describe("verifying a tenant", () => {
  it("records the answer against the credentials it checked", async () => {
    const verification = await verifyTenant(BETA);

    expect(verification.ok).toBe(true);
    expect(row(BETA)).toMatchObject({ granted_roles: ["Mail.Send"], verify_error: null });
    expect(row(BETA).verified_at).toEqual(expect.any(String));
  });

  it("does not record an answer about credentials replaced while it was asking", async () => {
    // New credentials are saved, with their own verification, mid-check.
    db.whileVerifying = () => {
      Object.assign(row(BETA), {
        credentials_version: 2,
        verified_at: "2026-10-12T15:00:00.000Z",
        granted_roles: ["Mail.Send", "Mail.ReadWrite"],
        verify_error: null,
      });
    };

    await verifyTenant(BETA);

    expect(row(BETA)).toMatchObject({
      credentials_version: 2,
      verified_at: "2026-10-12T15:00:00.000Z",
      granted_roles: ["Mail.Send", "Mail.ReadWrite"],
    });
  });
});
