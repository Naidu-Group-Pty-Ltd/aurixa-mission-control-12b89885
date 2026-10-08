import { describe, expect, it } from "vitest";
import { MOBILE_PORTALS } from "./portals.pure";
import { planCloneMobileGateway, planIsNoop, principalRefForEmail } from "./gatewayPlan.pure";

const allSubs = (licensed: string[]) =>
  MOBILE_PORTALS.map((portal) => ({ portal, enabled: licensed.includes(portal) }));

const converged = {
  status: "active" as const,
  delivered_project_ref: "abc",
  delivered_env_at: "2026-10-08T00:00:00Z",
  licensed_portals: ["command-centre"],
};

describe("planCloneMobileGateway", () => {
  it("births a gateway: row, credential, six subscriptions, superadmin grant", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: null,
      subscriptions: [],
      licensedPortals: ["command-centre"],
      hasLiveSuperadminGrant: false,
      adminEmail: "owner@example.com",
    });
    expect(p.createRow).toBe(true);
    expect(p.mintCredential).toBe(true);
    expect(p.insertSubscriptions).toHaveLength(6);
    expect(p.insertSubscriptions.filter((s) => s.enabled).map((s) => s.portal)).toEqual([
      "command-centre",
    ]);
    expect(p.createSuperadminGrant).toBe(true);
  });

  it("is a no-op on a converged clone (T66: a second run writes nothing)", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: converged,
      subscriptions: allSubs(["command-centre"]),
      licensedPortals: ["command-centre"],
      hasLiveSuperadminGrant: true,
      adminEmail: "owner@example.com",
    });
    expect(planIsNoop(p)).toBe(true);
    expect(p.why).toEqual(["already converged"]);
  });

  it("re-mints when the credential went to another project", () => {
    const p = planCloneMobileGateway({
      projectRef: "new",
      gateway: converged,
      subscriptions: allSubs(["command-centre"]),
      licensedPortals: ["command-centre"],
      hasLiveSuperadminGrant: true,
      adminEmail: null,
    });
    expect(p.mintCredential).toBe(true);
  });

  it("re-mints a credential never stamped delivered", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: { ...converged, delivered_env_at: null },
      subscriptions: allSubs(["command-centre"]),
      licensedPortals: ["command-centre"],
      hasLiveSuperadminGrant: true,
      adminEmail: null,
    });
    expect(p.mintCredential).toBe(true);
  });

  it("never touches a revoked gateway", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: { ...converged, status: "revoked" },
      subscriptions: [],
      licensedPortals: ["command-centre", "client"],
      hasLiveSuperadminGrant: false,
      adminEmail: "owner@example.com",
    });
    expect(p.frozen).toBe(true);
    expect(planIsNoop(p)).toBe(true);
  });

  it("enables a newly licensed portal without re-creating its row", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: converged,
      subscriptions: allSubs(["command-centre"]),
      licensedPortals: ["command-centre", "client"],
      hasLiveSuperadminGrant: true,
      adminEmail: null,
    });
    expect(p.updateLicences).toBe(true);
    expect(p.insertSubscriptions).toEqual([]);
    expect(p.updateSubscriptions).toEqual([{ portal: "client", enabled: true }]);
  });

  it("waits for an admin email rather than inventing a principal", () => {
    const p = planCloneMobileGateway({
      projectRef: "abc",
      gateway: converged,
      subscriptions: allSubs(["command-centre"]),
      licensedPortals: ["command-centre"],
      hasLiveSuperadminGrant: false,
      adminEmail: null,
    });
    expect(p.createSuperadminGrant).toBe(false);
    expect(p.why).toContain("no admin email recorded — superadmin grant waits");
  });

  it("keys a principal by its normalised email", () => {
    expect(principalRefForEmail("  Owner@Example.COM ")).toBe("email:owner@example.com");
  });
});
