import { describe, expect, it } from "vitest";
import {
  appleAppSiteAssociation,
  assetLinks,
  normaliseCertFingerprints,
} from "./appAssociation.pure";
import { MOBILE_PORTALS } from "./portals.pure";

const HEX = "ab".repeat(32);

describe("app association files", () => {
  it("normalises a fingerprint however it was typed, and drops junk", () => {
    const out = normaliseCertFingerprints(`${HEX}, AB:${"AB:".repeat(30)}AB, nope`);
    expect(out).toEqual([`${"AB:".repeat(31)}AB`]);
  });

  it("lists nothing until a release certificate is recorded", () => {
    expect(assetLinks([])).toEqual([]);
    expect(appleAppSiteAssociation(undefined).applinks.details).toEqual([]);
    expect(appleAppSiteAssociation("short").applinks.details).toEqual([]);
  });

  it("names every portal's app, and claims only the access-link path", () => {
    const links = assetLinks(normaliseCertFingerprints(HEX));
    expect(links).toHaveLength(MOBILE_PORTALS.length);
    const aasa = appleAppSiteAssociation("ABCDE12345");
    expect(aasa.applinks.details[0].appIDs).toHaveLength(MOBILE_PORTALS.length);
    expect(aasa.applinks.details[0].components).toEqual([
      { "/": "/a/*", comment: "Aurixa access links" },
    ]);
  });
});
