/**
 * A release is a descriptor (v1) in `mobile_releases` and an artefact in the
 * portal's private bucket. This module decides everything about a release
 * that does not need the database: whether a descriptor is well formed, where
 * its artefact lives, which release an installation should be on, and whether
 * updating is required, offered or nothing.
 *
 * Four rules carry it.
 *
 * - **The path is derived, never supplied.** CI says what it built; the path
 *   `{environment}/{platform}/{version}+{build}/{sha256}/artifact` follows from
 *   that, so an upload cannot be written over another release's object.
 * - **A rollback is a higher build number.** Selection takes the highest
 *   promoted build an installation is in the cohort for; nothing ever moves a
 *   device to a LOWER build, because Android refuses to downgrade a signed app.
 * - **The cohort is a property of the installation and the release**, hashed
 *   deterministically, so a device is in or out of a rollout the same way on
 *   every check and widening the percentage only ever adds devices.
 * - **The manifest is canonical JSON**, keys sorted at every depth, so the bytes
 *   MC signs are the bytes every verifier re-serialises.
 */

import type {
  MobileChannel,
  MobileEnvironment,
  MobilePlatform,
  MobilePortal,
} from "./portals.pure";
import { isMobileChannel, isMobilePlatform, isMobilePortal, PORTAL_APPS } from "./portals.pure";

export const DESCRIPTOR_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{7,40}$/;

export type ReleaseDescriptorV1 = {
  descriptor_version: 1;
  portal: MobilePortal;
  platform: MobilePlatform;
  environment: MobileEnvironment;
  channel: MobileChannel;
  version: string;
  build_number: number;
  source_sha: string;
  content_sha256: string | null;
  signing_cert_sha256: string | null;
  size_bytes: number | null;
  min_os: string | null;
  min_supported_build: number | null;
  critical: boolean;
  release_notes: string | null;
  apple_custom_app_url: string | null;
};

export type DescriptorCheck =
  | { ok: true; descriptor: ReleaseDescriptorV1 }
  | { ok: false; errors: string[] };

const MAX_ARTEFACT_BYTES = 200 * 1024 * 1024;

export function validateDescriptor(input: unknown): DescriptorCheck {
  const errors: string[] = [];
  const d = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (d.descriptor_version !== DESCRIPTOR_VERSION) errors.push("descriptor_version must be 1");
  if (!isMobilePortal(d.portal)) errors.push("portal is not one of the six apps");
  if (!isMobilePlatform(d.platform)) errors.push("platform must be android or ios");
  const environment = d.environment ?? "production";
  if (environment !== "production" && environment !== "staging")
    errors.push("environment must be production or staging");
  if (!isMobileChannel(d.channel)) errors.push("channel must be stable, beta or internal");
  if (typeof d.version !== "string" || !SEMVER.test(d.version))
    errors.push("version must be MAJOR.MINOR.PATCH");
  if (!Number.isInteger(d.build_number) || (d.build_number as number) <= 0)
    errors.push("build_number must be a positive integer");
  if (typeof d.source_sha !== "string" || !SHA.test(d.source_sha))
    errors.push("source_sha must be a git sha");

  const contentSha = d.content_sha256 ?? null;
  const certSha = d.signing_cert_sha256 ?? null;
  const size = d.size_bytes ?? null;
  if (d.platform === "android") {
    if (typeof contentSha !== "string" || !HEX64.test(contentSha))
      errors.push("an Android release needs content_sha256");
    if (typeof certSha !== "string" || !HEX64.test(certSha))
      errors.push("an Android release needs signing_cert_sha256");
    if (!Number.isInteger(size) || (size as number) <= 0 || (size as number) > MAX_ARTEFACT_BYTES) {
      errors.push("size_bytes must be between 1 byte and 200 MB");
    }
  } else if (d.platform === "ios") {
    if (contentSha !== null)
      errors.push("an iOS release carries no artefact; Apple distributes it");
    if (
      typeof d.apple_custom_app_url !== "string" ||
      !/^https:\/\/apps\.apple\.com\//.test(d.apple_custom_app_url)
    ) {
      errors.push("an iOS release needs its Apple Business Manager custom-app link");
    }
  }
  const minSupported = d.min_supported_build ?? null;
  if (minSupported !== null && (!Number.isInteger(minSupported) || (minSupported as number) <= 0)) {
    errors.push("min_supported_build must be a positive integer");
  } else if (
    minSupported !== null &&
    Number.isInteger(d.build_number) &&
    (minSupported as number) > (d.build_number as number)
  ) {
    errors.push("min_supported_build cannot exceed the release's own build");
  }
  if (d.critical !== undefined && typeof d.critical !== "boolean")
    errors.push("critical must be a boolean");
  if (
    d.release_notes != null &&
    (typeof d.release_notes !== "string" || d.release_notes.length > 4000)
  ) {
    errors.push("release_notes must be text of at most 4000 characters");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    descriptor: {
      descriptor_version: 1,
      portal: d.portal as MobilePortal,
      platform: d.platform as MobilePlatform,
      environment: environment as MobileEnvironment,
      channel: d.channel as MobileChannel,
      version: d.version as string,
      build_number: d.build_number as number,
      source_sha: d.source_sha as string,
      content_sha256: (contentSha as string | null) ?? null,
      signing_cert_sha256: (certSha as string | null) ?? null,
      size_bytes: (size as number | null) ?? null,
      min_os: typeof d.min_os === "string" ? d.min_os : null,
      min_supported_build: (minSupported as number | null) ?? null,
      critical: d.critical === true,
      release_notes: (d.release_notes as string | null | undefined) ?? null,
      apple_custom_app_url: (d.apple_custom_app_url as string | null | undefined) ?? null,
    },
  };
}

/** Where the artefact lives: bucket + object path. Null for iOS. */
export function artefactLocation(d: ReleaseDescriptorV1): { bucket: string; path: string } | null {
  if (d.platform !== "android" || !d.content_sha256) return null;
  return {
    bucket: PORTAL_APPS[d.portal].bucket,
    path: `${d.environment}/${d.platform}/${d.version}+${d.build_number}/${d.content_sha256}/artifact`,
  };
}

/** Canonical JSON: sorted keys at every depth, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** FNV-1a, 32-bit — stable, dependency-free, good enough to spread a cohort. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 0–99, fixed for a (release, installation) pair. */
export function rolloutBucket(releaseId: string, installId: string): number {
  return fnv1a(`${releaseId}:${installId}`) % 100;
}

export function inRollout(
  releaseId: string,
  installId: string,
  percentage: number,
  paused: boolean,
): boolean {
  if (paused) return false;
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  return rolloutBucket(releaseId, installId) < percentage;
}

export type CandidateRelease = {
  id: string;
  portal: MobilePortal;
  platform: MobilePlatform;
  environment: MobileEnvironment;
  channel: MobileChannel;
  state: "candidate" | "approved" | "promoted" | "paused" | "withdrawn";
  build_number: number;
  min_supported_build: number | null;
  critical: boolean;
  rollout_percentage: number;
  rollout_paused: boolean;
};

/**
 * The release an installation should run. The floor (`min_supported`) is
 * taken from EVERY promoted release, not only the one the device is in the
 * cohort for — a security floor cannot be escaped by being outside a rollout.
 */
export function selectRelease(
  releases: readonly CandidateRelease[],
  scope: {
    portal: MobilePortal;
    platform: MobilePlatform;
    environment: MobileEnvironment;
    channel: MobileChannel;
  },
  installId: string,
): { target: CandidateRelease | null; minSupportedBuild: number | null } {
  const promoted = releases.filter(
    (r) =>
      r.state === "promoted" &&
      r.portal === scope.portal &&
      r.platform === scope.platform &&
      r.environment === scope.environment &&
      r.channel === scope.channel,
  );
  let minSupportedBuild: number | null = null;
  for (const r of promoted) {
    if (r.min_supported_build !== null) {
      minSupportedBuild = Math.max(minSupportedBuild ?? 0, r.min_supported_build);
    }
  }
  const byBuild = [...promoted].sort((a, b) => b.build_number - a.build_number);
  const inCohort =
    byBuild.find((r) => inRollout(r.id, installId, r.rollout_percentage, r.rollout_paused)) ?? null;
  return { target: inCohort, minSupportedBuild };
}

/**
 * A device below the floor is offered the newest unpaused release that clears
 * it even outside the cohort: a floor that blocks a device and offers it
 * nothing would strand it.
 */
export function selectReleaseForInstall(
  releases: readonly CandidateRelease[],
  scope: {
    portal: MobilePortal;
    platform: MobilePlatform;
    environment: MobileEnvironment;
    channel: MobileChannel;
  },
  installId: string,
  installedBuild: number,
): { target: CandidateRelease | null; minSupportedBuild: number | null } {
  const base = selectRelease(releases, scope, installId);
  const floor = base.minSupportedBuild;
  if (floor === null || installedBuild >= floor) return base;
  if (base.target && base.target.build_number >= floor) return base;
  const rescue =
    releases
      .filter(
        (r) =>
          r.state === "promoted" &&
          !r.rollout_paused &&
          r.portal === scope.portal &&
          r.platform === scope.platform &&
          r.environment === scope.environment &&
          r.channel === scope.channel &&
          r.build_number >= floor,
      )
      .sort((a, b) => b.build_number - a.build_number)[0] ?? null;
  return { target: rescue ?? base.target, minSupportedBuild: floor };
}

export type UpdateDecision = "required" | "available" | "none";

export function decideUpdate(
  installedBuild: number,
  selection: { target: CandidateRelease | null; minSupportedBuild: number | null },
): UpdateDecision {
  const { target, minSupportedBuild } = selection;
  const belowFloor = minSupportedBuild !== null && installedBuild < minSupportedBuild;
  if (!target || target.build_number <= installedBuild) {
    // Below the floor with nothing newer to offer this device is still
    // required: the app blocks and says an update is on its way.
    return belowFloor ? "required" : "none";
  }
  if (belowFloor || target.critical) return "required";
  return "available";
}
