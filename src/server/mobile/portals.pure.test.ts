import { describe, expect, it } from "vitest";
import { licensedPortalsFor, MOBILE_PORTALS, PORTAL_APPS } from "./portals.pure";

describe("the six portal apps", () => {
  it("names exactly the six portals, in a fixed order", () => {
    expect(MOBILE_PORTALS).toEqual([
      "command-centre",
      "client",
      "finance",
      "solicitor",
      "builder",
      "accountant",
    ]);
  });

  it("gives every portal a distinct app id and its own private bucket", () => {
    const ids = MOBILE_PORTALS.map((p) => PORTAL_APPS[p].androidPackage);
    expect(new Set(ids).size).toBe(6);
    for (const p of MOBILE_PORTALS) {
      expect(PORTAL_APPS[p].portal).toBe(p);
      expect(PORTAL_APPS[p].bucket).toBe(`mobile-releases-${p}`);
      expect(PORTAL_APPS[p].androidPackage).toMatch(/^au\.com\.aurixasystems\.[a-z]+$/);
      expect(PORTAL_APPS[p].iosBundleId).toBe(PORTAL_APPS[p].androidPackage);
    }
  });

  it("states a blocker exactly where the native session is not ready", () => {
    for (const p of MOBILE_PORTALS) {
      expect(PORTAL_APPS[p].nativeSessionReady).toBe(PORTAL_APPS[p].blocker === null);
    }
  });
});

describe("licensedPortalsFor", () => {
  it("always licenses the Command Centre", () => {
    expect(licensedPortalsFor(null)).toEqual(["command-centre"]);
    expect(licensedPortalsFor([])).toEqual(["command-centre"]);
  });

  it("licenses a partner portal only where an entitlement names it", () => {
    expect(licensedPortalsFor(["Client_Portal", "portal:finance"])).toEqual([
      "command-centre",
      "client",
      "finance",
    ]);
  });

  it("never infers a licence from an unknown key", () => {
    expect(licensedPortalsFor(["aml_ctf", "client", "portal"])).toEqual(["command-centre"]);
  });
});
