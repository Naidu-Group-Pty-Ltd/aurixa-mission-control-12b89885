/**
 * The console's server plane, pinned (extraction plan §5, §10).
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { networkAdminUrl } from "./buildersNetworkAdmin.server";
import { builderOrgTenantRef } from "./builders-network.functions";
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ORIGINAL_URL = process.env.BUILDERS_NETWORK_ADMIN_URL;
afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.BUILDERS_NETWORK_ADMIN_URL;
  else process.env.BUILDERS_NETWORK_ADMIN_URL = ORIGINAL_URL;
});

describe("the network endpoint", () => {
  it("is https or nothing — never a guessed host", () => {
    delete process.env.BUILDERS_NETWORK_ADMIN_URL;
    expect(networkAdminUrl()).toBeNull();
    process.env.BUILDERS_NETWORK_ADMIN_URL = "http://insecure.example/fn";
    expect(networkAdminUrl()).toBeNull();
    process.env.BUILDERS_NETWORK_ADMIN_URL = "https://x.supabase.co/functions/v1/builder-network-admin/";
    expect(networkAdminUrl()).toBe("https://x.supabase.co/functions/v1/builder-network-admin");
  });
});

describe("the switch and the mint, at the source", () => {
  const server = stripComments(read("src/server/buildersNetworkAdmin.server.ts"));

  it("the switch is a live NULL-clone key carrying builders:operate", () => {
    expect(server).toContain('.is("clone_id", null)');
    expect(server).toContain('.is("revoked_at", null)');
    expect(server).toContain('.contains("scopes", [OPERATE_SCOPE])');
  });

  it("the assertion is bound to the network audience with exactly the operate scope", () => {
    expect(server).toContain("audience: BUILDERS_AUDIENCE");
    expect(server).toContain("claims: { scopes: [OPERATE_SCOPE] }");
  });

  it("MC never holds the network's service-role key", () => {
    // The call carries the assertion and nothing else; no Supabase client
    // to the network, no service key name anywhere on this plane.
    for (const file of [
      "src/server/buildersNetworkAdmin.server.ts",
      "src/server/builders-network.functions.ts",
    ]) {
      const source = stripComments(read(file));
      expect(source).not.toMatch(/SERVICE_ROLE/i);
      expect(source).not.toContain("createClient(");
    }
  });
});

describe("per-organisation metering (plan §10 decision)", () => {
  it("the tenant ref namespaces the organisation", () => {
    expect(builderOrgTenantRef("abc-123")).toBe("builders-network:abc-123");
  });

  it("approval ensures a NULL-clone tenant for the organisation", () => {
    const source = stripComments(read("src/server/builders-network.functions.ts"));
    expect(source).toMatch(/ensureTenant\(\s*null,\s*builderOrgTenantRef\(data\.organisationId\)/);
  });
});

describe("the console's address", () => {
  it("lives at /builders-network and never under /modules", () => {
    const route = read("src/routes/builders-network.tsx");
    expect(route).toContain('createFileRoute("/builders-network")');
    const nav = read("src/lib/nav.ts");
    expect(nav).toContain('to: "/builders-network"');
    expect(nav).not.toContain('"/modules/builders');
  });
});
