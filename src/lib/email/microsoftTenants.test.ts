// The rules for an added Microsoft tenant: what may be saved, what is shown in
// place of a credential, and what Microsoft's refusals mean.
import { describe, expect, it } from "vitest";
import {
  credentialHints,
  credentialsFrom,
  explainTokenRefusal,
  fingerprintSource,
  parseCredentials,
  sameTenant,
  secretExpiry,
  tenantChangeProblems,
  tenantErrorMessage,
  tenantInputProblems,
  tenantKey,
} from "./microsoftTenants.pure";

const GUID_A = "8F1C2D3E-4A5B-4C6D-8E7F-901234567890";
const GUID_B = "0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d";
const valid = {
  label: "NPC Services",
  directoryTenantId: GUID_A,
  clientId: GUID_B,
  clientSecret: "Abc8Q~sEcReTvAlUe.123",
};

describe("tenantInputProblems", () => {
  it("accepts a complete registration", () => {
    expect(tenantInputProblems(valid)).toEqual([]);
    expect(tenantInputProblems({ ...valid, directoryTenantId: "contoso.onmicrosoft.com" })).toEqual(
      [],
    );
  });

  it("names every missing field", () => {
    expect(tenantInputProblems({})).toEqual([
      "give the tenant a name",
      "enter the Directory (tenant) ID",
      "enter the Application (client) ID",
      "enter the client secret's Value",
    ]);
  });

  it("catches the secret's ID pasted in place of its Value", () => {
    expect(tenantInputProblems({ ...valid, clientSecret: GUID_A }).join()).toMatch(
      /secret's ID, not its Value/,
    );
  });

  it("refuses a client ID that is not a GUID, and a mailbox that is not an address", () => {
    const problems = tenantInputProblems({
      ...valid,
      clientId: "my-app",
      defaultMailbox: "sales",
    });
    expect(problems.join()).toMatch(/Application \(client\) ID is a GUID/);
    expect(problems.join()).toMatch(/default mailbox is not a valid email address/);
  });
});

describe("tenantChangeProblems", () => {
  it("lets blank credentials keep the stored ones", () => {
    expect(tenantChangeProblems({ label: "Renamed", clientSecret: "", clientId: "" })).toEqual([]);
  });

  it("checks only what was typed", () => {
    expect(tenantChangeProblems({ clientSecret: GUID_B }).join()).toMatch(/secret's ID/);
    expect(tenantChangeProblems({ directoryTenantId: "not a tenant" }).join()).toMatch(
      /Directory \(tenant\) ID/,
    );
    expect(tenantChangeProblems({ label: "" })).toEqual(["give the tenant a name"]);
  });
});

describe("credentials", () => {
  it("are stored trimmed with lower-cased IDs, and read back only when whole", () => {
    const stored = credentialsFrom({ ...valid, clientSecret: `  ${valid.clientSecret}  ` });
    expect(stored).toEqual({
      tenantId: GUID_A.toLowerCase(),
      clientId: GUID_B,
      clientSecret: valid.clientSecret,
    });
    expect(parseCredentials(JSON.stringify(stored))).toEqual(stored);
    expect(parseCredentials(JSON.stringify({ tenantId: "t", clientId: "c" }))).toBeNull();
    expect(parseCredentials("not json")).toBeNull();
    expect(parseCredentials(null)).toBeNull();
  });

  it("are shown as hints that never contain the secret", () => {
    const hints = credentialHints(credentialsFrom(valid));
    expect(hints).toEqual({ directory: "…7890", client: "…3c2d", secret: "Abc…" });
    expect(JSON.stringify(hints)).not.toContain("sEcReT");
  });

  it("fingerprint one app registration however it was typed", () => {
    expect(fingerprintSource({ tenantId: GUID_A, clientId: ` ${GUID_B.toUpperCase()} ` })).toBe(
      fingerprintSource(credentialsFrom(valid)),
    );
  });
});

describe("secretExpiry", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  it("warns within thirty days and after", () => {
    expect(secretExpiry(null, now)).toBeNull();
    expect(secretExpiry("2027-06-01", now)).toBe("ok");
    expect(secretExpiry("2026-11-01", now)).toBe("soon");
    expect(secretExpiry("2026-10-11", now)).toBe("expired");
    // The expiry day itself still works.
    expect(secretExpiry("2026-10-12", now)).toBe("soon");
  });
});

describe("tenant references", () => {
  it("treat null and undefined as the deployment's own tenant", () => {
    expect(tenantKey(null)).toBe("default");
    expect(tenantKey(undefined)).toBe("default");
    expect(tenantKey("abc")).toBe("tenant:abc");
    expect(sameTenant(null, undefined)).toBe(true);
    expect(sameTenant("abc", null)).toBe(false);
  });
});

describe("explaining refusals", () => {
  it("turns Microsoft's codes into what to fix", () => {
    expect(explainTokenRefusal([7000215])).toMatch(/client secret is wrong/);
    expect(explainTokenRefusal([7000222])).toMatch(/expired/);
    expect(explainTokenRefusal([700016])).toMatch(/no application with that Application/);
    expect(explainTokenRefusal([90002])).toMatch(/no Microsoft directory/);
    expect(explainTokenRefusal([12345])).toBeNull();
    expect(explainTokenRefusal(undefined)).toBeNull();
  });

  it("says what the database refused in words", () => {
    expect(tenantErrorMessage('violates "microsoft_tenants_label_live"')).toMatch(/name/);
    expect(tenantErrorMessage("microsoft_tenant_in_use")).toMatch(/running campaign/);
  });
});
