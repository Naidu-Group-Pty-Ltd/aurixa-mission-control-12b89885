import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cloneConnectionRow,
  cloneInboundUrl,
  readTransportGrant,
  redactInstallOutcome,
  refuseBeforeSpending,
  spentSecretRemedy,
} from "./buildersTransportInstall.pure";

const READY = { supabase_url: "https://x.supabase.co", service_role_key: "enc", status: "ready" };
const ORG = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const LIVE = { clone_id: "clone-1", state: "invited", builder_org_ref: ORG };

describe("refuseBeforeSpending", () => {
  it("passes a live connection on a ready backend", () => {
    expect(refuseBeforeSpending({ connection: LIVE, backend: READY })).toBeNull();
  });

  it("refuses a connection the shadow ledger does not hold", () => {
    const r = refuseBeforeSpending({ connection: null, backend: READY });
    expect(r?.reason).toBe("unknown_connection");
  });

  it("refuses a revoked connection, because revocation is terminal", () => {
    const r = refuseBeforeSpending({
      connection: { clone_id: "clone-1", state: "revoked" },
      backend: READY,
    });
    expect(r?.reason).toBe("connection_revoked");
    expect(r?.message).toMatch(/new connection/i);
  });

  it("refuses when the ledger names no builder organisation, before anything is spent", () => {
    for (const builder_org_ref of [null, undefined, "", "acme-homes"]) {
      const r = refuseBeforeSpending({
        connection: { clone_id: "clone-1", state: "invited", builder_org_ref },
        backend: READY,
      });
      expect(r?.reason).toBe("connection_unmapped");
    }
  });

  it("refuses when the ledger names no workspace", () => {
    const r = refuseBeforeSpending({
      connection: { clone_id: null, state: "invited", builder_org_ref: ORG },
      backend: READY,
    });
    expect(r?.reason).toBe("no_clone_on_connection");
  });

  it("refuses when the workspace has no backend on record", () => {
    const r = refuseBeforeSpending({ connection: LIVE, backend: null });
    expect(r?.reason).toBe("clone_backend_missing");
  });

  it("refuses a backend that is not ready, and names the status it found", () => {
    const r = refuseBeforeSpending({
      connection: LIVE,
      backend: { ...READY, status: "provisioning" },
    });
    expect(r?.reason).toBe("clone_backend_not_ready");
    expect(r?.message).toContain("provisioning");
  });

  it("refuses an incomplete credential set", () => {
    expect(
      refuseBeforeSpending({ connection: LIVE, backend: { ...READY, service_role_key: null } })
        ?.reason,
    ).toBe("clone_credentials_incomplete");
    expect(
      refuseBeforeSpending({ connection: LIVE, backend: { ...READY, supabase_url: null } })?.reason,
    ).toBe("clone_credentials_incomplete");
  });

  /*
   * The point of the module. Every refusal above has to be reachable without
   * asking the network for anything, because the grant is one-shot and a
   * refusal discovered afterwards costs a rotation.
   */
  it("every refusal is decidable from state Mission Control already holds", () => {
    const inputs = [
      { connection: null, backend: READY },
      { connection: { clone_id: "c", state: "revoked" }, backend: READY },
      { connection: { clone_id: null, state: "invited", builder_org_ref: ORG }, backend: READY },
      { connection: { clone_id: "c", state: "invited", builder_org_ref: null }, backend: READY },
      { connection: LIVE, backend: null },
      { connection: LIVE, backend: { ...READY, status: "failed" } },
      { connection: LIVE, backend: { ...READY, service_role_key: null } },
    ];
    for (const input of inputs) {
      const r = refuseBeforeSpending(input);
      expect(r).not.toBeNull();
      expect(r!.message.length).toBeGreaterThan(20);
    }
  });
});

describe("readTransportGrant", () => {
  it("reads a well-formed grant", () => {
    const g = readTransportGrant({
      hmac_secret: "abc123",
      network_inbound_url: "https://n.example/functions/v1/builder-network-inbound",
    });
    expect(g).toEqual({
      ok: true,
      secret: "abc123",
      inboundUrl: "https://n.example/functions/v1/builder-network-inbound",
    });
  });

  it("refuses a grant carrying no credential", () => {
    const g = readTransportGrant({ network_inbound_url: "https://n.example/x" });
    expect(g.ok).toBe(false);
  });

  it("refuses an inbound URL that is not https", () => {
    const g = readTransportGrant({ hmac_secret: "abc", network_inbound_url: "http://n.example/x" });
    expect(g.ok).toBe(false);
  });

  it("refuses a blank credential rather than installing an empty one", () => {
    const g = readTransportGrant({
      hmac_secret: "   ",
      network_inbound_url: "https://n.example/x",
    });
    expect(g.ok).toBe(false);
  });
});

describe("cloneConnectionRow", () => {
  const row = cloneConnectionRow({
    networkConnectionId: "conn-1",
    hmacSecret: "s",
    networkInboundUrl: "https://n.example/x",
    builderOrgLabel: "Acme Homes",
    builderOrganisationId: ORG,
    scopes: ["stock:publish"],
    now: "2026-09-19T00:00:00.000Z",
  });

  it("names the builder organisation, which is the connection's identity on the workspace", () => {
    expect(row.builder_organisation_id).toBe(ORG);
  });

  it("is active, because the network accepted before it would provision", () => {
    expect(row.state).toBe("active");
    expect(row.accepted_at).toBe("2026-09-19T00:00:00.000Z");
  });

  it("carries the label and scopes the shadow ledger holds", () => {
    expect(row.builder_org_label).toBe("Acme Homes");
    expect(row.scopes).toEqual(["stock:publish"]);
  });

  it("defaults absent scopes to none rather than to null", () => {
    const r = cloneConnectionRow({
      networkConnectionId: "c",
      hmacSecret: "s",
      networkInboundUrl: "https://n/x",
      builderOrgLabel: null,
      builderOrganisationId: ORG,
      scopes: null,
      now: "2026-09-19T00:00:00.000Z",
    });
    expect(r.scopes).toEqual([]);
  });

  it("never invents a network_connection_id of its own", () => {
    expect(row.network_connection_id).toBe("conn-1");
  });
});

describe("cloneInboundUrl", () => {
  it("derives the workspace's inbound door from its backend origin", () => {
    expect(cloneInboundUrl("https://abc.supabase.co")).toBe(
      "https://abc.supabase.co/functions/v1/builder-network-inbound",
    );
    expect(cloneInboundUrl("https://abc.supabase.co///")).toBe(
      "https://abc.supabase.co/functions/v1/builder-network-inbound",
    );
  });

  it("refuses anything that is not a bare https origin", () => {
    for (const bad of ["http://abc.supabase.co", "https://abc.supabase.co/rest", "", "abc"]) {
      expect(cloneInboundUrl(bad)).toBeNull();
    }
  });
});

describe("spentSecretRemedy", () => {
  it("names rotation, and says a retry will be refused", () => {
    const m = spentSecretRemedy("HTTP 503");
    expect(m).toMatch(/rotate transport/i);
    expect(m).toMatch(/refused/i);
    expect(m).toContain("HTTP 503");
  });
});

describe("redactInstallOutcome", () => {
  it("passes a success through with no extra fields", () => {
    const out = redactInstallOutcome({
      ok: true,
      cloneId: "c",
      networkConnectionId: "n",
      rotated: false,
    });
    expect(Object.keys(out).sort()).toEqual(["cloneId", "networkConnectionId", "ok", "rotated"]);
  });

  it("drops anything not on the declared shape", () => {
    const out = redactInstallOutcome({
      ok: true,
      cloneId: "c",
      networkConnectionId: "n",
      rotated: false,
      // A field a later edit might add beside the outcome.
      hmac_secret: "leaked",
    } as never);
    expect(JSON.stringify(out)).not.toContain("leaked");
  });

  it("keeps a remedy on a failure and omits it when there is none", () => {
    expect(redactInstallOutcome({ ok: false, error: "e", remedy: "r" })).toEqual({
      ok: false,
      error: "e",
      remedy: "r",
    });
    expect(Object.keys(redactInstallOutcome({ ok: false, error: "e" }))).toEqual(["ok", "error"]);
  });
});

/**
 * The ordering rule is the whole design and it lives in the handler, so it is
 * asserted against the handler's source the way `signingPair.test.ts` asserts
 * the provisioning order.
 */
describe("installCloneNetworkTransport", () => {
  const source = () =>
    readFileSync(
      fileURLToPath(new URL("./buildersTransportInstall.functions.ts", import.meta.url)),
      "utf8",
    );

  const handler = () => {
    const s = source();
    const at = s.indexOf("export const installCloneNetworkTransport");
    expect(at).toBeGreaterThan(-1);
    return s.slice(at);
  };

  it("proves the workspace writable BEFORE it asks the network to provision", () => {
    const h = handler();
    const probe = h.indexOf("builder_network_connections?select=id&limit=0");
    const ask = h.indexOf("callBuilderNetworkAdmin");
    expect(probe).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(probe);
  });

  it("asks the free questions before the one-shot one: rivals, then the address, then the secret", () => {
    const h = handler();
    const probe = h.indexOf("builder_network_connections?select=id&limit=0");
    const rivals = h.indexOf("&builder_organisation_id=eq.");
    const address = h.indexOf('callBuilderNetworkAdmin("set_inbound_url"');
    const spend = h.indexOf("callBuilderNetworkAdmin(operation");
    expect(probe).toBeGreaterThan(-1);
    expect(rivals).toBeGreaterThan(probe);
    expect(address).toBeGreaterThan(rivals);
    expect(spend).toBeGreaterThan(address);
    // The address is derived from the backend, never typed.
    expect(h).toContain("cloneInboundUrl(cloneUrl)");
  });

  it("writes the organisation into the workspace row and the audit, with the acting operator", () => {
    const h = handler();
    expect(h).toMatch(/cloneConnectionRow\(\{[\s\S]*builderOrganisationId,/);
    const audit = h.slice(h.indexOf("writeAuditLog"));
    expect(audit).toContain("actorUserId: context.userId");
    expect(audit).toContain("builder_organisation_id: builderOrganisationId");
  });

  it("refuses on Mission Control's own state before either", () => {
    const h = handler();
    expect(h.indexOf("refuseBeforeSpending")).toBeLessThan(
      h.indexOf("builder_network_connections?select=id&limit=0"),
    );
  });

  it("returns every answer through the redactor", () => {
    const h = handler();
    /*
     * Every `return` that produces a value must be `redactInstallOutcome(…)`.
     * Matching on a word character would miss the one shape that matters most
     * — a bare `return { ok: true, … }` object literal — so this collects
     * whatever follows each `return` and checks it, literal braces included.
     */
    const body = h.slice(h.indexOf(".handler("));
    expect(body.length).toBeGreaterThan(0);
    const offenders = [...body.matchAll(/\breturn\s+(\S+)/g)]
      .map((m) => m[1])
      .filter((what) => !what.startsWith("redactInstallOutcome("));
    expect(offenders).toEqual([]);
  });

  it("never puts the grant in an answer or an audit record", () => {
    const h = handler();
    const audit = h.slice(h.indexOf("writeAuditLog"));
    expect(audit).not.toContain("grant.secret");
    expect(audit).not.toContain("hmac");
    expect(h).not.toMatch(/ok:\s*true[^}]*grant\.secret/);
  });

  it("installs the grant only into the workspace's own row", () => {
    const h = handler();
    expect(h).toContain("on_conflict=network_connection_id");
    expect(h).toContain("resolution=merge-duplicates");
  });

  it("does not enable the workspace's Builders Network flag", () => {
    expect(handler()).not.toContain("builder_network_enabled");
  });

  it("names rotation as the remedy for a grant that was spent and not installed", () => {
    const h = handler();
    expect(h).toContain("spentSecretRemedy");
    expect(h).toContain("rotate_transport");
  });

  /*
   * This act lives outside the console plane precisely so that plane's "no
   * service-key name, no client" rule (buildersNetworkAdmin.test.ts) stays as
   * strict as it was. These are the boundaries that replace it here.
   */
  it("reaches the network only through the asserted admin call", () => {
    const s = source();
    expect(s).toContain("callBuilderNetworkAdmin");
    // No second path to the network, and no client constructed to anything.
    expect(s).not.toContain("createClient(");
    expect(s).not.toMatch(/BUILDERS_NETWORK_ADMIN_URL/);
  });

  it("takes the workspace credential from the backends table, never from this environment", () => {
    const s = source();
    expect(s).toContain('.from("clone_backends")');
    expect(s).not.toMatch(/process\.env/);
  });

  it("keeps the console plane free of any service-key name", () => {
    const consolePlane = readFileSync(
      fileURLToPath(new URL("./builders-network.functions.ts", import.meta.url)),
      "utf8",
    );
    expect(consolePlane).not.toMatch(/SERVICE_ROLE/i);
    expect(consolePlane).not.toContain("installCloneNetworkTransport");
  });
});
