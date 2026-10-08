/**
 * The six native apps, named once.
 *
 * No Aurixa app is listed on any public marketplace (the owner, 8 Oct 2026).
 * There is ONE signed binary per portal, shared by every clone and bound to a
 * clone at activation, so a portal's identity here is the app's identity
 * everywhere: the Android application id the APK is signed under, the iOS
 * bundle id Apple Business Manager distributes, the private bucket its
 * packages live in, and the App Link path that opens it.
 *
 * The literals are mirrored in npc-property-dashbord `mobile/apps/*` (each
 * app's applicationId / PRODUCT_BUNDLE_IDENTIFIER) and in
 * `mobile/packages/npc_gateway`. A rename here without a rename there produces
 * an app the gateway cannot open — which is why `portals.pure.test.ts` pins the
 * list rather than trusting it.
 */

export const MOBILE_PORTALS = [
  "command-centre",
  "client",
  "finance",
  "solicitor",
  "builder",
  "accountant",
] as const;

export type MobilePortal = (typeof MOBILE_PORTALS)[number];

export const MOBILE_PLATFORMS = ["android", "ios"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

export const MOBILE_CHANNELS = ["stable", "beta", "internal"] as const;
export type MobileChannel = (typeof MOBILE_CHANNELS)[number];

export const MOBILE_ENVIRONMENTS = ["production", "staging"] as const;
export type MobileEnvironment = (typeof MOBILE_ENVIRONMENTS)[number];

/** The one host the gateway lives on. Reserved as a slug by 20261008100000. */
export const MOBILE_GATEWAY_HOST = "mobile.aurixasystems.com.au";
export const MOBILE_GATEWAY_ORIGIN = `https://${MOBILE_GATEWAY_HOST}`;

export type PortalApp = {
  portal: MobilePortal;
  label: string;
  /** Android applicationId of the production flavour. */
  androidPackage: string;
  /** iOS bundle identifier of the Custom App. */
  iosBundleId: string;
  /** The private Mission Control Storage bucket holding its packages. */
  bucket: string;
  /**
   * Whether the clone-side native exchange exists for this portal today.
   * Every portal is WIRED from birth (subscription row, bucket, app id); a
   * portal whose web transport is cookie-only cannot mint a native session
   * yet, and the gateway says so rather than handing out a link that fails.
   */
  nativeSessionReady: boolean;
  /** Why it is not ready, in an operator's words. Null when ready. */
  blocker: string | null;
};

export const PORTAL_APPS: Readonly<Record<MobilePortal, PortalApp>> = {
  "command-centre": {
    portal: "command-centre",
    label: "Command Centre",
    androidPackage: "au.com.aurixasystems.commandcentre",
    iosBundleId: "au.com.aurixasystems.commandcentre",
    bucket: "mobile-releases-command-centre",
    nativeSessionReady: true,
    blocker: null,
  },
  client: {
    portal: "client",
    label: "Client Portal",
    androidPackage: "au.com.aurixasystems.client",
    iosBundleId: "au.com.aurixasystems.client",
    bucket: "mobile-releases-client",
    nativeSessionReady: true,
    blocker: null,
  },
  finance: {
    portal: "finance",
    label: "Finance Portal",
    androidPackage: "au.com.aurixasystems.finance",
    iosBundleId: "au.com.aurixasystems.finance",
    bucket: "mobile-releases-finance",
    nativeSessionReady: true,
    blocker: null,
  },
  solicitor: {
    portal: "solicitor",
    label: "Solicitor Portal",
    androidPackage: "au.com.aurixasystems.solicitor",
    iosBundleId: "au.com.aurixasystems.solicitor",
    bucket: "mobile-releases-solicitor",
    nativeSessionReady: false,
    blocker:
      "The solicitor portal's session travels only as an HttpOnly cookie; a bearer " +
      "variant of its transport is needed before an app can hold a session.",
  },
  builder: {
    portal: "builder",
    label: "Builder & Developer Portal",
    androidPackage: "au.com.aurixasystems.builder",
    iosBundleId: "au.com.aurixasystems.builder",
    bucket: "mobile-releases-builder",
    nativeSessionReady: false,
    blocker:
      "The builder portal is moving to the Builders Network and its session is " +
      "cookie-only; its native exchange will live in aurixa-builders.",
  },
  accountant: {
    portal: "accountant",
    label: "Accountant Portal",
    androidPackage: "au.com.aurixasystems.accountant",
    iosBundleId: "au.com.aurixasystems.accountant",
    bucket: "mobile-releases-accountant",
    nativeSessionReady: false,
    blocker:
      "The accountant portal's session is cookie-only; a bearer variant of its " +
      "transport is needed before an app can hold a session.",
  },
};

export function isMobilePortal(value: unknown): value is MobilePortal {
  return typeof value === "string" && (MOBILE_PORTALS as readonly string[]).includes(value);
}

export function isMobilePlatform(value: unknown): value is MobilePlatform {
  return typeof value === "string" && (MOBILE_PLATFORMS as readonly string[]).includes(value);
}

export function isMobileChannel(value: unknown): value is MobileChannel {
  return typeof value === "string" && (MOBILE_CHANNELS as readonly string[]).includes(value);
}

/**
 * The portals a clone holds at birth.
 *
 * Every clone has the Command Centre; a partner portal is licensed only where
 * the clone's own entitlements name it. An unknown entitlement key licenses
 * nothing — a licence is never inferred.
 */
export function licensedPortalsFor(
  entitlementKeys: readonly string[] | null | undefined,
): MobilePortal[] {
  const keys = new Set((entitlementKeys ?? []).map((k) => k.trim().toLowerCase()));
  const licensed: MobilePortal[] = ["command-centre"];
  const named: Array<[MobilePortal, string[]]> = [
    ["client", ["client_portal", "portal:client", "client-portal"]],
    ["finance", ["finance_portal", "portal:finance", "finance-portal"]],
    ["solicitor", ["solicitor_portal", "portal:solicitor", "solicitor-portal"]],
    ["builder", ["builder_portal", "portal:builder", "builder-portal"]],
    ["accountant", ["accountant_portal", "portal:accountant", "accountant-portal"]],
  ];
  for (const [portal, aliases] of named) {
    if (aliases.some((a) => keys.has(a))) licensed.push(portal);
  }
  return licensed;
}
