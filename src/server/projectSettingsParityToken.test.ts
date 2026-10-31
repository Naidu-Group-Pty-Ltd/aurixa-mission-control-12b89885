/**
 * The project-settings parity reads the Management API token under the name
 * Mission Control actually holds it.
 *
 * It read `SUPABASE_ACCESS_TOKEN`, which Lovable reserves and this deployment
 * cannot set, so every clone's parity report said the prime's exposed schemas
 * and upload limit could not be read — while provisioning, on the same
 * deployment, created projects with `SB_MGMT_API_TOKEN`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { managementApiToken, managementApiUnavailable } from "./projectSettingsParity.server";

const saved = {
  SB_MGMT_API_TOKEN: process.env.SB_MGMT_API_TOKEN,
  SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("managementApiToken", () => {
  it("reads the name the rest of Mission Control reads", () => {
    expect(managementApiToken({ SB_MGMT_API_TOKEN: "sbp_x" })).toBe("sbp_x");
  });

  it("keeps the old name as a fallback, and prefers the real one", () => {
    expect(managementApiToken({ SUPABASE_ACCESS_TOKEN: "sbp_old" })).toBe("sbp_old");
    expect(
      managementApiToken({ SB_MGMT_API_TOKEN: "sbp_new", SUPABASE_ACCESS_TOKEN: "sbp_old" }),
    ).toBe("sbp_new");
  });

  it("blank is none", () => {
    expect(managementApiToken({ SB_MGMT_API_TOKEN: "  ", SUPABASE_ACCESS_TOKEN: "" })).toBe("");
    expect(managementApiToken({})).toBe("");
  });
});

describe("managementApiUnavailable", () => {
  it("says nothing is unavailable when SB_MGMT_API_TOKEN alone is set", () => {
    delete process.env.SUPABASE_ACCESS_TOKEN;
    process.env.SB_MGMT_API_TOKEN = "sbp_x";
    expect(managementApiUnavailable()).toBeNull();
  });

  it("names the missing token when neither is set", () => {
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SB_MGMT_API_TOKEN;
    expect(managementApiUnavailable()?.exposedSchemas).toMatchObject({ state: "unavailable" });
  });
});
