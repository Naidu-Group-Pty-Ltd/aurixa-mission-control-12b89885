/**
 * The two files that let an OS hand `https://mobile.aurixasystems.com.au/a/*`
 * straight to an installed app instead of a browser.
 *
 * - Android reads `/.well-known/assetlinks.json` and trusts an app whose
 *   package name AND signing-certificate SHA-256 are listed. The certificate
 *   is the release keystore's, recorded by a person in
 *   `MOBILE_ANDROID_CERT_SHA256` (comma-separated, for a rotation); with none
 *   recorded the file lists nothing and links open in the browser, which is
 *   the link page — degraded, never broken.
 * - iOS reads `/.well-known/apple-app-site-association` and trusts
 *   `<TeamID>.<bundle id>`. With no `APPLE_TEAM_ID` it lists nothing.
 *
 * Only the `/a/*` path is claimed, so no other page on the host is ever
 * captured by an app.
 */
import { MOBILE_PORTALS, PORTAL_APPS } from "./portals.pure";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** `AB:CD:…` (32 pairs), whatever separators or case a person typed. */
export function normaliseCertFingerprints(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.replace(/[^0-9a-f]/gi, "").toUpperCase())
    .filter((hex) => hex.length === 64)
    .map((hex) => hex.match(/.{2}/g)!.join(":"))
    .filter((v, i, all) => FINGERPRINT.test(v) && all.indexOf(v) === i);
}

export function assetLinks(fingerprints: string[]) {
  if (fingerprints.length === 0) return [];
  return MOBILE_PORTALS.map((p) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: PORTAL_APPS[p].androidPackage,
      sha256_cert_fingerprints: fingerprints,
    },
  }));
}

export function appleAppSiteAssociation(teamId: string | undefined) {
  const team = (teamId ?? "").trim();
  if (!/^[A-Z0-9]{10}$/.test(team)) return { applinks: { details: [] } };
  return {
    applinks: {
      details: [
        {
          appIDs: MOBILE_PORTALS.map((p) => `${team}.${PORTAL_APPS[p].iosBundleId}`),
          components: [{ "/": "/a/*", comment: "Aurixa access links" }],
        },
      ],
    },
  };
}
