/**
 * The mobile release registry: Mission Control is the app store.
 *
 * No Aurixa app is listed on a public marketplace, so this module is what a
 * store would otherwise be. A release is a row in `mobile_releases`; its
 * Android package is an object in the portal's private bucket at a path DERIVED
 * from the descriptor (`artefactLocation`), never supplied by the uploader. CI
 * registers a candidate and uploads through a signed upload URL; only an
 * operator approves and promotes it.
 *
 * Every device learns about releases through its own clone (`mobile-release`
 * on the clone calls `currentReleaseForClone` with the clone's `mmc_`
 * credential). The answer is a manifest signed with the organisation's
 * Ed25519 key, which the app checks against the root compiled into it before
 * it trusts a single field — then it checks the package's SHA-256 and its
 * signing certificate before installing anything.
 *
 * Three rules carry it.
 *
 * - **A download is a ticket, never a URL to the bucket.** A ticket lives ten
 *   minutes and its first use is stamped; redeeming it answers with a
 *   60-second signed storage URL. Nothing about a package is public.
 * - **A paused rollout hands out nothing new.** `selectReleaseForInstall` reads
 *   only promoted, unpaused releases into a cohort, and the ticket mint
 *   re-checks the release's state at the moment it mints.
 * - **A rollback is a higher build.** Android refuses a downgrade of a signed
 *   app; withdrawing a bad build and promoting a fixed one with a higher build
 *   number is the only way back, and `moveRelease` has no "demote".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { writeAuditLog } from "../audit.server";
import { timingSafeEqualStr } from "../cron-auth.server";
import { checkPublicRateLimit } from "../token-rate-limit.server";
import type { CloneMobileCaller, GatewayRefusal } from "./gateway.server";
import { isInstallId } from "./activationAssertion.pure";
import {
  isMobilePlatform,
  isMobilePortal,
  MOBILE_GATEWAY_ORIGIN,
  type MobileChannel,
  type MobilePlatform,
  type MobilePortal,
} from "./portals.pure";
import {
  artefactLocation,
  decideUpdate,
  selectReleaseForInstall,
  validateDescriptor,
  type CandidateRelease,
} from "./releaseDescriptor.pure";
import { moveRelease, type ReleaseAction, type ReleaseState } from "./releaseStates.pure";
import { releaseSigningKeyPresent, signManifest } from "./signing.server";
import {
  DOWNLOAD_TICKET_LIFETIME_MS,
  isActivationTicket,
  isDownloadTicket,
  isGrantRef,
  newDownloadTicket,
  sha256Hex,
  ticketState,
} from "./tickets.pure";

type Db = SupabaseClient<Database>;
type ReleaseRow = Database["public"]["Tables"]["mobile_releases"]["Row"];

export const RELEASE_CI_TOKEN_ENV = "MC_RELEASE_CI_TOKEN";

function refuse(status: number, code: string, message: string): GatewayRefusal {
  return { ok: false, status, code, message };
}

// ── CI authentication ───────────────────────────────────────────────────────

/**
 * The release workflow's bearer token. Unset means CI cannot register
 * anything, which is a configuration answer (503), not an auth failure.
 */
export function authenticateReleaseCi(authorization: string | null): { ok: true } | GatewayRefusal {
  const expected = (process.env[RELEASE_CI_TOKEN_ENV] ?? "").trim();
  if (!expected) return refuse(503, "UNAVAILABLE", `${RELEASE_CI_TOKEN_ENV} is not configured.`);
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m || !timingSafeEqualStr(m[1], expected))
    return refuse(401, "AUTH_REQUIRED", "Not authorised.");
  return { ok: true };
}

// ── CI: register a candidate and hand back an upload URL ────────────────────

export type RegisteredCandidate = {
  ok: true;
  release_id: string;
  existed: boolean;
  /** Android only: a one-use signed URL the package is PUT to. */
  upload: { bucket: string; path: string; signed_url: string; token: string } | null;
};

export async function registerRelease(
  supabase: Db,
  input: unknown,
): Promise<RegisteredCandidate | GatewayRefusal> {
  const check = validateDescriptor(input);
  if (!check.ok) return refuse(400, "INVALID_REQUEST", check.errors.join("; "));
  const d = check.descriptor;
  const where = artefactLocation(d);

  const existing = await supabase
    .from("mobile_releases")
    .select("id, state, content_sha256, uploaded_at")
    .eq("portal", d.portal)
    .eq("platform", d.platform)
    .eq("environment", d.environment)
    .eq("channel", d.channel)
    .eq("build_number", d.build_number)
    .maybeSingle();
  if (existing.error) return refuse(503, "UNAVAILABLE", "The release registry could not be read.");

  let releaseId: string;
  let existed = false;
  if (existing.data) {
    // A build number is spent once. Re-registering the SAME package (a CI
    // retry) is answered with the same row; a different package under the
    // same build is refused, because the app trusts the number.
    if (existing.data.content_sha256 !== d.content_sha256) {
      return refuse(
        409,
        "CONFLICT",
        `Build ${d.build_number} is already registered with a different package.`,
      );
    }
    if (existing.data.state !== "candidate") {
      return refuse(409, "CONFLICT", `Build ${d.build_number} is already ${existing.data.state}.`);
    }
    releaseId = existing.data.id;
    existed = true;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("mobile_releases")
      .insert({
        portal: d.portal,
        platform: d.platform,
        environment: d.environment,
        channel: d.channel,
        version: d.version,
        build_number: d.build_number,
        source_sha: d.source_sha,
        content_sha256: d.content_sha256,
        signing_cert_sha256: d.signing_cert_sha256,
        size_bytes: d.size_bytes,
        min_os: d.min_os,
        min_supported_build: d.min_supported_build,
        critical: d.critical,
        release_notes: d.release_notes,
        apple_custom_app_url: d.apple_custom_app_url,
        storage_bucket: where?.bucket ?? null,
        storage_path: where?.path ?? null,
        state: "candidate",
      })
      .select("id")
      .single();
    if (insertError)
      return refuse(503, "UNAVAILABLE", "The release registry could not complete that request.");
    releaseId = inserted.id;
    await writeAuditLog({
      action: "mobile_release.registered",
      entityType: "mobile_release",
      entityId: releaseId,
      actorUserId: null,
      metadata: {
        portal: d.portal,
        platform: d.platform,
        version: d.version,
        build: d.build_number,
      },
    });
  }

  if (!where) return { ok: true, release_id: releaseId, existed, upload: null };
  const up = await supabase.storage
    .from(where.bucket)
    .createSignedUploadUrl(where.path, { upsert: true });
  if (up.error || !up.data) return refuse(503, "UNAVAILABLE", "The upload URL could not be made.");
  return {
    ok: true,
    release_id: releaseId,
    existed,
    upload: {
      bucket: where.bucket,
      path: where.path,
      signed_url: up.data.signedUrl,
      token: up.data.token,
    },
  };
}

/**
 * CI says the upload finished. Believed only by effect: the object must be
 * listed in the bucket at the derived path, at the declared size.
 */
export async function markUploaded(
  supabase: Db,
  releaseId: string,
): Promise<{ ok: true; uploaded_at: string } | GatewayRefusal> {
  const { data: rel, error } = await supabase
    .from("mobile_releases")
    .select("id, platform, storage_bucket, storage_path, size_bytes, state")
    .eq("id", releaseId)
    .maybeSingle();
  if (error) return refuse(503, "UNAVAILABLE", "The release could not be read.");
  if (!rel) return refuse(404, "NOT_FOUND", "No release has that id.");
  if (rel.platform !== "android" || !rel.storage_bucket || !rel.storage_path)
    return refuse(409, "CONFLICT", "Only an Android release carries a package.");
  const dir = rel.storage_path.slice(0, rel.storage_path.lastIndexOf("/"));
  const listed = await supabase.storage.from(rel.storage_bucket).list(dir, { limit: 10 });
  if (listed.error) return refuse(503, "UNAVAILABLE", "The uploaded package could not be found.");
  const obj = (listed.data ?? []).find((o) => o.name === "artifact");
  if (!obj) return refuse(409, "CONFLICT", "The package is not in storage yet.");
  const size = Number((obj.metadata as { size?: number } | null)?.size ?? NaN);
  if (rel.size_bytes && Number.isFinite(size) && size !== rel.size_bytes) {
    return refuse(
      409,
      "CONFLICT",
      `The stored package is ${size} bytes, not the declared ${rel.size_bytes}.`,
    );
  }
  const at = new Date().toISOString();
  const { error: stampError } = await supabase
    .from("mobile_releases")
    .update({ uploaded_at: at })
    .eq("id", rel.id);
  if (stampError)
    return refuse(503, "UNAVAILABLE", "The release registry could not complete that request.");
  return { ok: true, uploaded_at: at };
}

// ── Operator: approve, promote, pause, resume, withdraw ─────────────────────

export async function moveReleaseState(
  supabase: Db,
  input: {
    releaseId: string;
    action: ReleaseAction;
    percentage?: number;
    reason?: string;
    actorUserId: string;
  },
): Promise<{ ok: true; state: ReleaseState } | GatewayRefusal> {
  const { data: rel, error } = await supabase
    .from("mobile_releases")
    .select("*")
    .eq("id", input.releaseId)
    .maybeSingle();
  if (error) return refuse(503, "UNAVAILABLE", "The release could not be read.");
  if (!rel) return refuse(404, "NOT_FOUND", "No release has that id.");
  const from = rel.state as ReleaseState;
  const move = moveRelease(from, input.action, {
    platform: rel.platform,
    uploaded: rel.uploaded_at !== null,
    percentage: input.percentage,
  });
  if (!move.ok) return refuse(409, "CONFLICT", move.reason);
  if (input.action === "pause" && (input.reason ?? "").trim().length < 10)
    return refuse(
      400,
      "INVALID_REQUEST",
      "Say why the rollout is paused, in at least ten characters.",
    );

  const now = new Date().toISOString();
  const patch: Database["public"]["Tables"]["mobile_releases"]["Update"] = { state: move.to };
  if (input.action === "approve")
    Object.assign(patch, { approved_by: input.actorUserId, approved_at: now });
  if (input.action === "promote" && from === "approved") patch.promoted_at = now;
  if (input.action === "withdraw") patch.withdrawn_at = now;

  const { data: moved, error: moveError } = await supabase
    .from("mobile_releases")
    .update(patch)
    .eq("id", rel.id)
    .eq("state", from)
    .select("id")
    .maybeSingle();
  if (moveError)
    return refuse(503, "UNAVAILABLE", "The release registry could not complete that request.");
  if (!moved) return refuse(409, "CONFLICT", "The release changed while it was being moved.");

  if (input.action === "promote") {
    const r = await supabase.from("mobile_release_rollouts").upsert(
      {
        release_id: rel.id,
        percentage: input.percentage as number,
        paused_at: null,
        pause_reason: null,
        started_by: input.actorUserId,
      },
      { onConflict: "release_id" },
    );
    if (r.error) return refuse(503, "UNAVAILABLE", "The release could not be moved.");
  } else if (input.action === "pause") {
    // A pause is a safety act: the state moved, and the rollout row is what
    // stops new download tickets, so a failure here is reported, never hidden.
    const { error: pauseError } = await supabase
      .from("mobile_release_rollouts")
      .update({ paused_at: now, pause_reason: (input.reason ?? "").trim() })
      .eq("release_id", rel.id);
    if (pauseError)
      return refuse(503, "UNAVAILABLE", "The release registry could not complete that request.");
  } else if (input.action === "resume") {
    const { error: resumeError } = await supabase
      .from("mobile_release_rollouts")
      .update({ paused_at: null, pause_reason: null })
      .eq("release_id", rel.id);
    if (resumeError)
      return refuse(503, "UNAVAILABLE", "The release registry could not complete that request.");
  }
  await writeAuditLog({
    action: `mobile_release.${input.action}`,
    entityType: "mobile_release",
    entityId: rel.id,
    actorUserId: input.actorUserId,
    metadata: {
      portal: rel.portal,
      platform: rel.platform,
      build: rel.build_number,
      from,
      to: move.to,
      percentage: input.percentage ?? null,
      reason: input.reason ?? null,
    },
  });
  return { ok: true, state: move.to };
}

export type ReleaseListing = ReleaseRow & {
  rollout: { percentage: number; paused_at: string | null; pause_reason: string | null } | null;
  installs: number;
};

export async function listReleases(
  supabase: Db,
  portal?: MobilePortal,
): Promise<{ ok: true; releases: ReleaseListing[] } | GatewayRefusal> {
  let q = supabase
    .from("mobile_releases")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (portal) q = q.eq("portal", portal);
  const { data, error } = await q;
  if (error) return refuse(503, "UNAVAILABLE", "The releases could not be listed.");
  const ids = (data ?? []).map((r) => r.id);
  const [rollouts, reports] = await Promise.all([
    ids.length
      ? supabase
          .from("mobile_release_rollouts")
          .select("release_id, percentage, paused_at, pause_reason")
          .in("release_id", ids)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? supabase
          .from("mobile_install_reports")
          .select("release_id, install_id")
          .in("release_id", ids)
          .eq("outcome", "installed")
      : Promise.resolve({ data: [], error: null }),
  ]);
  const rolloutBy = new Map((rollouts.data ?? []).map((r) => [r.release_id, r]));
  const installsBy = new Map<string, Set<string>>();
  for (const r of reports.data ?? []) {
    if (!r.release_id) continue;
    const set = installsBy.get(r.release_id) ?? new Set<string>();
    set.add(r.install_id);
    installsBy.set(r.release_id, set);
  }
  return {
    ok: true,
    releases: (data ?? []).map((r) => {
      const ro = rolloutBy.get(r.id);
      return {
        ...r,
        rollout: ro
          ? { percentage: ro.percentage, paused_at: ro.paused_at, pause_reason: ro.pause_reason }
          : null,
        installs: installsBy.get(r.id)?.size ?? 0,
      };
    }),
  };
}

// ── Selection ───────────────────────────────────────────────────────────────

async function loadCandidates(
  supabase: Db,
  scope: { portal: MobilePortal; platform: MobilePlatform; channel: MobileChannel },
): Promise<
  { ok: true; candidates: CandidateRelease[]; rows: Map<string, ReleaseRow> } | { ok: false }
> {
  const { data, error } = await supabase
    .from("mobile_releases")
    .select("*")
    .eq("portal", scope.portal)
    .eq("platform", scope.platform)
    .eq("environment", "production")
    .eq("channel", scope.channel)
    .eq("state", "promoted");
  if (error) return { ok: false };
  const ids = (data ?? []).map((r) => r.id);
  const ro = ids.length
    ? await supabase
        .from("mobile_release_rollouts")
        .select("release_id, percentage, paused_at")
        .in("release_id", ids)
    : { data: [], error: null };
  if (ro.error) return { ok: false };
  type RolloutBit = { release_id: string; percentage: number; paused_at: string | null };
  const by = new Map<string, RolloutBit>(
    ((ro.data ?? []) as RolloutBit[]).map((r) => [r.release_id, r] as const),
  );
  const rows = new Map((data ?? []).map((r) => [r.id, r]));
  const candidates: CandidateRelease[] = (data ?? []).map((r) => ({
    id: r.id,
    portal: r.portal as MobilePortal,
    platform: r.platform as MobilePlatform,
    environment: "production",
    channel: r.channel as MobileChannel,
    state: r.state as CandidateRelease["state"],
    build_number: r.build_number,
    min_supported_build: r.min_supported_build,
    critical: r.critical,
    rollout_percentage: by.get(r.id)?.percentage ?? 0,
    rollout_paused: by.get(r.id)?.paused_at != null,
  }));
  return { ok: true, candidates, rows };
}

async function mintDownloadTicket(
  supabase: Db,
  input: { releaseId: string; cloneId: string; grantId: string | null; installId: string | null },
): Promise<{ ticket: string; expires_at: string } | null> {
  const ticket = newDownloadTicket();
  const expires = new Date(Date.now() + DOWNLOAD_TICKET_LIFETIME_MS).toISOString();
  const { error } = await supabase.from("mobile_download_tickets").insert({
    release_id: input.releaseId,
    clone_id: input.cloneId,
    grant_id: input.grantId,
    install_id: input.installId,
    ticket_hash: await sha256Hex(ticket),
    expires_at: expires,
  });
  return error ? null : { ticket, expires_at: expires };
}

function downloadUrl(
  ticket: string,
  origin = process.env.MOBILE_GATEWAY_ORIGIN?.trim() || MOBILE_GATEWAY_ORIGIN,
): string {
  return `${origin.replace(/\/$/, "")}/api/public/mobile/download/${ticket}`;
}

// ── The clone asks: what should this installation run? ──────────────────────

export type ReleaseCheckAnswer = {
  ok: true;
  /** The signed manifest; the app trusts nothing outside `payload`. */
  signed: Awaited<ReturnType<typeof signManifest>>;
};

export async function currentReleaseForClone(
  supabase: Db,
  caller: CloneMobileCaller,
  input: { portal: unknown; platform: unknown; install_id: unknown; installed_build: unknown },
): Promise<ReleaseCheckAnswer | GatewayRefusal> {
  if (
    !isMobilePortal(input.portal) ||
    !isMobilePlatform(input.platform) ||
    !isInstallId(input.install_id)
  ) {
    return refuse(400, "INVALID_REQUEST", "portal, platform and install_id are required.");
  }
  const installed = Number(input.installed_build);
  if (!Number.isInteger(installed) || installed < 0)
    return refuse(400, "INVALID_REQUEST", "installed_build must be a whole number.");
  if (caller.status !== "active")
    return refuse(403, "SESSION_REVOKED", "This workspace's apps are suspended.");
  if (!releaseSigningKeyPresent())
    return refuse(503, "UNAVAILABLE", "Release signing is not configured yet.");

  const sub = await supabase
    .from("clone_mobile_release_subscriptions")
    .select("enabled, channel")
    .eq("clone_id", caller.cloneId)
    .eq("portal", input.portal)
    .maybeSingle();
  if (sub.error) return refuse(503, "UNAVAILABLE", "The subscription could not be read.");
  if (!sub.data)
    return refuse(409, "CONFLICT", "This workspace has no release subscription for that app.");
  if (!sub.data.enabled)
    return refuse(403, "PORTAL_NOT_LICENSED", "This workspace is not licensed for that app.");

  const loaded = await loadCandidates(supabase, {
    portal: input.portal,
    platform: input.platform,
    channel: sub.data.channel as MobileChannel,
  });
  if (!loaded.ok) return refuse(503, "UNAVAILABLE", "Releases could not be read.");
  const selection = selectReleaseForInstall(
    loaded.candidates,
    {
      portal: input.portal,
      platform: input.platform,
      environment: "production",
      channel: sub.data.channel as MobileChannel,
    },
    input.install_id,
    installed,
  );
  const decision = decideUpdate(installed, selection);
  const target = selection.target ? (loaded.rows.get(selection.target.id) ?? null) : null;

  let download: { url: string; expires_at: string } | null = null;
  if (
    decision !== "none" &&
    target &&
    input.platform === "android" &&
    !selection.target?.rollout_paused
  ) {
    const t = await mintDownloadTicket(supabase, {
      releaseId: target.id,
      cloneId: caller.cloneId,
      grantId: null,
      installId: input.install_id,
    });
    if (t) download = { url: downloadUrl(t.ticket), expires_at: t.expires_at };
  }

  const signed = await signManifest({
    v: 1,
    kind: "release_manifest",
    clone_id: caller.cloneId,
    portal: input.portal,
    platform: input.platform,
    install_id: input.install_id,
    installed_build: installed,
    decision,
    min_supported_build: selection.minSupportedBuild,
    release: target
      ? {
          id: target.id,
          version: target.version,
          build_number: target.build_number,
          critical: target.critical,
          content_sha256: target.content_sha256,
          signing_cert_sha256: target.signing_cert_sha256,
          size_bytes: target.size_bytes,
          min_os: target.min_os,
          release_notes: target.release_notes,
          apple_custom_app_url: target.apple_custom_app_url,
        }
      : null,
    download,
    issued_at: new Date().toISOString(),
  });
  return { ok: true, signed };
}

export async function recordInstallReport(
  supabase: Db,
  caller: CloneMobileCaller,
  input: {
    portal: unknown;
    platform: unknown;
    install_id: unknown;
    build_number: unknown;
    outcome: unknown;
    release_id?: unknown;
    detail?: unknown;
  },
): Promise<{ ok: true } | GatewayRefusal> {
  const outcomes = ["running", "installed", "failed", "blocked"];
  const build = Number(input.build_number);
  if (
    !isMobilePortal(input.portal) ||
    !isMobilePlatform(input.platform) ||
    !isInstallId(input.install_id) ||
    !Number.isInteger(build) ||
    build < 0 ||
    typeof input.outcome !== "string" ||
    !outcomes.includes(input.outcome)
  ) {
    return refuse(400, "INVALID_REQUEST", "This is not a valid install report.");
  }
  const releaseId =
    typeof input.release_id === "string" && /^[0-9a-f-]{36}$/.test(input.release_id)
      ? input.release_id
      : null;
  const { error } = await supabase.from("mobile_install_reports").insert({
    clone_id: caller.cloneId,
    release_id: releaseId,
    portal: input.portal,
    platform: input.platform,
    install_id: input.install_id,
    build_number: build,
    outcome: input.outcome,
    detail: typeof input.detail === "string" ? input.detail.slice(0, 500) : null,
  });
  if (error) return refuse(503, "UNAVAILABLE", "The report could not be recorded.");
  return { ok: true };
}

// ── The link page asks for the first install ────────────────────────────────

/**
 * The link page's "Install app" button. The activation ticket is READ, never
 * spent: the person still has to open the app with the same link to claim.
 * Answers a download URL only for a live link to an Android build this
 * workspace is subscribed to.
 */
export async function issueGatewayDownloadTicket(
  supabase: Db,
  input: { grant_ref: unknown; ticket: unknown; ip: string },
): Promise<{ ok: true; url: string; expires_at: string; version: string } | GatewayRefusal> {
  if (!isGrantRef(input.grant_ref) || !isActivationTicket(input.ticket))
    return refuse(400, "INVALID_REQUEST", "This is not a valid access link.");
  const rl = await checkPublicRateLimit("mobile:download:ip", input.ip, 30);
  if (!rl.ok) return refuse(429, "RATE_LIMITED", "Too many requests. Try again in a few minutes.");

  const g = await supabase
    .from("mobile_access_grants")
    .select("id, clone_id, portal, status")
    .eq("grant_ref", input.grant_ref)
    .maybeSingle();
  if (g.error) return refuse(503, "UNAVAILABLE", "Access could not be checked.");
  const invalid = refuse(401, "AUTH_REQUIRED", "This access link is not valid.");
  if (!g.data || g.data.status === "revoked" || !isMobilePortal(g.data.portal)) return invalid;
  const t = await supabase
    .from("mobile_activation_tickets")
    .select("grant_id, expires_at, consumed_at, consumed_install_id")
    .eq("ticket_hash", await sha256Hex(input.ticket))
    .maybeSingle();
  if (t.error) return refuse(503, "UNAVAILABLE", "Access could not be checked.");
  if (!t.data || t.data.grant_id !== g.data.id) return invalid;
  const state = ticketState(t.data, new Date(), null);
  // A spent ticket still installs: the person may be reinstalling on the
  // device that claimed it. Only an expired one is refused.
  if (state === "expired") return refuse(410, "INVITE_EXPIRED", "This access link has expired.");

  const sub = await supabase
    .from("clone_mobile_release_subscriptions")
    .select("enabled, channel")
    .eq("clone_id", g.data.clone_id)
    .eq("portal", g.data.portal)
    .maybeSingle();
  if (sub.error) return refuse(503, "UNAVAILABLE", "The subscription could not be read.");
  if (!sub.data?.enabled)
    return refuse(403, "PORTAL_NOT_LICENSED", "This workspace is not licensed for that app.");

  const loaded = await loadCandidates(supabase, {
    portal: g.data.portal,
    platform: "android",
    channel: sub.data.channel as MobileChannel,
  });
  if (!loaded.ok) return refuse(503, "UNAVAILABLE", "Releases could not be read.");
  // A first install has no install id yet; the grant ref stands in as the
  // cohort member, so the same person lands in the same cohort every time.
  const selection = selectReleaseForInstall(
    loaded.candidates,
    {
      portal: g.data.portal,
      platform: "android",
      environment: "production",
      channel: sub.data.channel as MobileChannel,
    },
    input.grant_ref,
    0,
  );
  if (!selection.target || selection.target.rollout_paused)
    return refuse(404, "NOT_FOUND", "No version of this app is available to install yet.");
  const row = loaded.rows.get(selection.target.id);
  if (!row) return refuse(404, "NOT_FOUND", "No version of this app is available to install yet.");
  const minted = await mintDownloadTicket(supabase, {
    releaseId: row.id,
    cloneId: g.data.clone_id,
    grantId: g.data.id,
    installId: null,
  });
  if (!minted) return refuse(503, "UNAVAILABLE", "The download could not be prepared.");
  return {
    ok: true,
    url: downloadUrl(minted.ticket),
    expires_at: minted.expires_at,
    version: row.version,
  };
}

/**
 * Redeem a download ticket for a 60-second signed storage URL. The first use is
 * stamped; a ticket stays usable for its ten minutes so a dropped connection
 * can resume with a Range request, but it never outlives that, and a release
 * that was paused or withdrawn since the ticket was minted serves nothing.
 *
 * This is why the GET and HEAD that redeem it do not break "a GET never
 * consumes a credential": the stamp is a first-use MARKER for adoption, never
 * a refusal, so a link preview or a probe cannot spend what the download needs.
 * The credential a GET must not spend is the activation ticket, and nothing on
 * this path reads one.
 */
export async function redeemDownloadTicket(
  supabase: Db,
  ticket: string,
): Promise<{ ok: true; url: string; fileName: string } | GatewayRefusal> {
  if (!isDownloadTicket(ticket)) return refuse(404, "NOT_FOUND", "Not found.");
  const t = await supabase
    .from("mobile_download_tickets")
    .select("id, release_id, expires_at, consumed_at")
    .eq("ticket_hash", await sha256Hex(ticket))
    .maybeSingle();
  if (t.error) return refuse(503, "UNAVAILABLE", "The download could not be checked.");
  if (!t.data) return refuse(404, "NOT_FOUND", "Not found.");
  if (Date.parse(t.data.expires_at) <= Date.now())
    return refuse(410, "INVITE_EXPIRED", "This download link has expired.");
  const r = await supabase
    .from("mobile_releases")
    .select("state, storage_bucket, storage_path, portal, version, build_number")
    .eq("id", t.data.release_id)
    .maybeSingle();
  if (r.error) return refuse(503, "UNAVAILABLE", "The download could not be checked.");
  if (!r.data || r.data.state !== "promoted" || !r.data.storage_bucket || !r.data.storage_path) {
    return refuse(410, "INVITE_EXPIRED", "This version is no longer offered.");
  }
  if (!t.data.consumed_at) {
    const { error: markError } = await supabase
      .from("mobile_download_tickets")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", t.data.id)
      .is("consumed_at", null);
    // A marker for adoption, not a gate: a failed stamp never refuses a download.
    if (markError) console.warn("[mobile] first-use stamp not written:", markError.message);
  }
  const fileName = `aurixa-${r.data.portal}-${r.data.version}+${r.data.build_number}.apk`;
  const signed = await supabase.storage
    .from(r.data.storage_bucket)
    .createSignedUrl(r.data.storage_path, 60, { download: fileName });
  if (signed.error || !signed.data)
    return refuse(503, "UNAVAILABLE", "The package could not be fetched.");
  return { ok: true, url: signed.data.signedUrl, fileName };
}
