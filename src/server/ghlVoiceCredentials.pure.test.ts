import { describe, expect, it } from "vitest";
import {
  ghlCfgFields,
  ghlLocationRequest,
  grantMatchesLocation,
  judgeGhlVerification,
  validateGhlInput,
} from "./ghlVoiceCredentials.pure";

const PIT = "pit-1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5a6b";
const LOC = "H7NNnJKSofGaRJHTkAd3";

describe("the GoHighLevel input", () => {
  it("accepts a private-integration token or a location JWT, and a location id", () => {
    expect(validateGhlInput({ apiKey: PIT, locationId: LOC })).toMatchObject({ ok: true });
    expect(
      validateGhlInput({ apiKey: "eyJhbGciOi.eyJsb2NhdGlvbiI.c2lnbmF0dXJl", locationId: LOC }),
    ).toMatchObject({ ok: true });
  });
  it("refuses anything else, naming what is wrong", () => {
    const r = validateGhlInput({ apiKey: "not-a-ghl-token", locationId: "x" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});

describe("verification against GoHighLevel", () => {
  it("reads the named location with the v2 version header", () => {
    expect(ghlLocationRequest(LOC)).toEqual({
      url: `https://services.leadconnectorhq.com/locations/${LOC}`,
      headers: { Version: "2021-07-28", Accept: "application/json" },
    });
  });
  it("accepts only the location named, and says which failure it was", () => {
    expect(judgeGhlVerification(200, { location: { id: LOC, name: "Acme Realty" } }, LOC)).toEqual({
      ok: true,
      locationName: "Acme Realty",
    });
    expect(judgeGhlVerification(200, { location: { id: "other", name: "X" } }, LOC)).toMatchObject({
      reason: "wrong_location",
    });
    expect(judgeGhlVerification(401, null, LOC)).toMatchObject({ reason: "key_refused" });
    expect(judgeGhlVerification(404, null, LOC)).toMatchObject({ reason: "location_not_found" });
    expect(judgeGhlVerification(503, null, LOC)).toMatchObject({ reason: "unavailable" });
  });
});

describe("the OAuth grant for Make's GoHighLevel modules", () => {
  it("is accepted only for the location the key reads", () => {
    expect(grantMatchesLocation("Location: Acme  Realty", "acme realty")).toBe(true);
    expect(
      grantMatchesLocation("Location: Naidu Property Consulting Services", "Acme Realty"),
    ).toBe(false);
    expect(grantMatchesLocation(null, "Acme Realty")).toBe(false);
  });
});

describe("the CFG fields", () => {
  it("are written only where the template names them", () => {
    expect(ghlCfgFields(null, { apiKey: PIT, locationId: LOC })).toBeNull();
    expect(
      ghlCfgFields(
        { apiKey: "ghl_pit_token", locationId: "ghl_location_id" },
        { apiKey: PIT, locationId: LOC },
      ),
    ).toEqual({
      ghl_pit_token: PIT,
      ghl_location_id: LOC,
    });
  });
});
