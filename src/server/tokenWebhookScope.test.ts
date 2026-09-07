/**
 * The rule: a fleet-wide token-webhook endpoint may not be a tenant's own
 * host. See `tokenWebhookScope.pure.ts` for what it is defending against —
 * one row, active since 18 May 2026, subscribed to all four events, with no
 * clone scope, pointing at the PRIME's own site. It has never delivered
 * anything because the hostname is misspelt, which is the only thing that has
 * stood between every tenant's token events and one tenant's origin.
 */
import { describe, expect, it } from "vitest";
import {
  hostIsAt,
  hostOf,
  tenantHostsFrom,
  webhookEndpointRefusal,
  type TenantHost,
} from "./tokenWebhookScope.pure";

const HOSTS: TenantHost[] = [
  { cloneId: "c1", label: "Preflight Property Group", host: "preflight.aurixasystems.com.au" },
  { cloneId: "c1", label: "Preflight Property Group", host: "egrmsulhtmqnmhvuccxr.supabase.co" },
  { cloneId: null, label: "the prime", host: "dduzbchuswwbefdunfct.supabase.co" },
];

describe("a fleet-wide endpoint may not be a tenant's host", () => {
  it("refuses a clone's own domain on the fleet-wide scope", () => {
    const r = webhookEndpointRefusal("https://preflight.aurixasystems.com.au/hook", null, HOSTS);
    expect(r?.reason).toBe("fleet_wide_endpoint_is_a_tenant_host");
    expect(r?.message).toContain("Preflight Property Group");
  });

  it("refuses a subdomain of a tenant's host, not just an exact match", () => {
    const r = webhookEndpointRefusal(
      "https://api.preflight.aurixasystems.com.au/hook",
      null,
      HOSTS,
    );
    expect(r?.reason).toBe("fleet_wide_endpoint_is_a_tenant_host");
  });

  it("refuses the prime's own project host too — the prime is a tenant here", () => {
    // The prime holds a key and meters against it, so its events are the
    // unscoped ones. Handing it everyone else's is the same disclosure.
    const r = webhookEndpointRefusal(
      "https://dduzbchuswwbefdunfct.supabase.co/functions/v1/mission-control-webhook",
      null,
      HOSTS,
    );
    expect(r?.reason).toBe("fleet_wide_endpoint_is_a_tenant_host");
  });

  it("allows a fleet-wide endpoint that belongs to no tenant", () => {
    // Refusing on a hunch would break a legitimate aggregator. The rule fires
    // on a host that demonstrably belongs to a tenant, and on nothing else.
    expect(webhookEndpointRefusal("https://hooks.example.net/mc", null, HOSTS)).toBeNull();
  });

  it("leaves a SCOPED endpoint at its own clone's host alone", () => {
    // Which is the ordinary, correct arrangement, and what every clone has.
    expect(
      webhookEndpointRefusal("https://egrmsulhtmqnmhvuccxr.supabase.co/x", "c1", HOSTS),
    ).toBeNull();
  });

  it("a URL with no host is refused rather than delivered to", () => {
    expect(webhookEndpointRefusal("not a url", null, HOSTS)?.reason).toBe("unparseable_url");
  });
});

describe("host comparison is on label boundaries", () => {
  it("does not treat a suffix collision as ownership", () => {
    expect(hostIsAt("notexample.com", "example.com")).toBe(false);
    expect(hostIsAt("a.b.example.com", "example.com")).toBe(true);
    expect(hostIsAt("example.com", "example.com")).toBe(true);
  });

  it("normalises case, port and a trailing dot", () => {
    expect(hostOf("https://EXAMPLE.com.:8443/x")).toBe("example.com");
  });
});

describe("the tenant host list is read from what the fleet holds", () => {
  it("collects every host a clone answers on, and the prime's project", () => {
    const hosts = tenantHostsFrom({
      clones: [
        {
          id: "c1",
          name: "Preflight",
          deploy_url: "https://preflight.vercel.app",
          subdomain_fqdn: "preflight.aurixasystems.com.au",
        },
      ],
      deployments: [{ clone_id: "c1", domain: "preflight.com.au" }],
      backends: [{ clone_id: "c1", supabase_project_ref: "egrmsulhtmqnmhvuccxr" }],
      primeProjectRef: "dduzbchuswwbefdunfct",
    });
    expect(hosts.map((h) => h.host).sort()).toEqual([
      "dduzbchuswwbefdunfct.supabase.co",
      "egrmsulhtmqnmhvuccxr.supabase.co",
      "preflight.aurixasystems.com.au",
      "preflight.com.au",
      "preflight.vercel.app",
    ]);
  });

  it("names a clone rather than an id, because the refusal is read by a person", () => {
    const hosts = tenantHostsFrom({
      clones: [{ id: "c1", name: "Preflight", deploy_url: "https://p.example", subdomain_fqdn: null }],
      deployments: [],
      backends: [],
    });
    expect(hosts[0].label).toBe("Preflight");
  });
});

describe("both enforcement points share the one rule", () => {
  it("the delivery path and the write path import the same module", async () => {
    const { readFileSync } = await import("node:fs");
    const fire = readFileSync("src/server/token-webhooks.server.ts", "utf8");
    const write = readFileSync("src/server/tokenWebhookScope.server.ts", "utf8");
    expect(fire).toContain("webhookEndpointRefusal");
    expect(write).toContain("webhookEndpointRefusal");
    // Two copies of "which endpoints may exist" is how one of them becomes
    // wrong — the same reason `assessPepEvidence` is shared in the prime.
    expect(fire).toContain("tokenWebhookScope.pure");
    expect(write).toContain("tokenWebhookScope.pure");
  });
});
