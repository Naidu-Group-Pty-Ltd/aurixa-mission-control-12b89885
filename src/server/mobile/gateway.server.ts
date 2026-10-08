/**
 * The mobile gateway's server side: who may hold which app, and the one POST
 * that turns a link into a device.
 *
 * Every decision lives in a pure module (`grants`, `tickets`, `eligibility`,
 * `claimFacts`, `activationAssertion`); this file reads, decides through them,
 * and writes. Four rules carry it.
 *
 * - **A GET consumes nothing.** `previewGrant` and `issueGatewayDownloadTicket`
 *   read a ticket and never spend it; only `claim` spends one, by ONE
 *   conditional UPDATE (`consumed_at IS NULL AND expires_at > now`), so two
 *   racing claims cannot both win.
 * - **A failed read is not an absent row.** Every fact a failed read would
 *   have supplied is `null` and refused (`claimFacts.pure.ts`).
 * - **The magic-link answer is uniform.** Whether the email names a grant,
 *   names nothing, or the workspace does not exist, the caller reads the same
 *   sentence, so the form cannot be used to learn who has access.
 * - **No password exists anywhere in this flow.** The claim returns a 60-second
 *   assertion the clone exchanges, PKCE-bound, for its own native session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { cloneIssuerUrl, signCloneAssertion } from "../anthropicOidc.server";
import { factsOf, readGate } from "../payment-gate.server";
import { resolveGateState } from "@/lib/clonePaymentGate.pure";
import { timingSafeEqualStr } from "../cron-auth.server";
import { checkPublicRateLimit } from "../token-rate-limit.server";
import { isResendConfigured, sendPlatformEmail } from "../resend-client";
import { writeAuditLog } from "../audit.server";
import { composeAccessEmail } from "./accessEmail.pure";
import {
  ACTIVATION_LIFETIME_SECONDS,
  ACTIVATION_PURPOSE,
  activationAudience,
  activationSubject,
  isCodeChallenge,
  isInstallId,
  isThumbprint,
  type PrincipalKind,
} from "./activationAssertion.pure";
import { eligibilityFactsFrom, seatAvailableFrom, type Read } from "./claimFacts.pure";
import { assessNativeEligibility } from "./eligibility.pure";
import { decideClaim, nextGrantStatus, type GrantStatus } from "./grants.pure";
import { mobileGatewayOrigin } from "./cloneMobileGateway.server";
import { isMobilePortal, PORTAL_APPS, type MobilePortal } from "./portals.pure";
import { signManifest, releaseSigningKeyPresent } from "./signing.server";
import {
  buildGatewayLink,
  isActivationTicket,
  isCloneMobileCredential,
  isGrantRef,
  newActivationTicket,
  newGatewayKey,
  parseGatewayKey,
  sha256Hex,
  ticketExpiry,
  ticketState,
  type TicketKind,
  type TicketState,
} from "./tickets.pure";

type Db = SupabaseClient<Database>;

export type GatewayRefusal = { ok: false; status: number; code: string; message: string };

function refuse(status: number, code: string, message: string): GatewayRefusal {
  return { ok: false, status, code, message };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type GrantRow = Database["public"]["Tables"]["mobile_access_grants"]["Row"];

// ── Clone credential ────────────────────────────────────────────────────────

export type CloneMobileCaller = { cloneId: string; gatewayId: string; status: string };

/**
 * Authenticate a clone calling MC with its `mmc_` credential. Returns null for
 * anything that is not a live credential; the caller answers 401 and says no
 * more. A revoked gateway's credential stops working the moment it is revoked.
 */
export async function authenticateCloneMobileCredential(
  supabase: Db,
  authorization: string | null,
): Promise<CloneMobileCaller | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m || !isCloneMobileCredential(m[1])) return null;
  const hash = await sha256Hex(m[1]);
  const { data, error } = await supabase
    .from("clone_mobile_gateways")
    .select("clone_id, gateway_id, status")
    .eq("credential_hash", hash)
    .maybeSingle();
  if (error || !data || data.status === "revoked") return null;
  // Best effort: a stamp that fails to land must not refuse a live clone.
  void supabase
    .from("clone_mobile_gateways")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("clone_id", data.clone_id)
    .then(({ error: stampError }) => {
      if (stampError) console.warn("[mobile] last_seen stamp not written:", stampError.message);
    });
  return { cloneId: data.clone_id, gatewayId: data.gateway_id, status: data.status };
}

// ── Grants ──────────────────────────────────────────────────────────────────

export async function createGrant(
  supabase: Db,
  input: {
    cloneId: string;
    portal: MobilePortal;
    principalKind: PrincipalKind;
    email: string;
    actorUserId: string | null;
  },
): Promise<{ ok: true; grant: GrantRow; existed: boolean } | GatewayRefusal> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return refuse(400, "INVALID_REQUEST", "That is not an email address.");
  const principalRef = `email:${email}`;
  const existing = await supabase
    .from("mobile_access_grants")
    .select("*")
    .eq("clone_id", input.cloneId)
    .eq("portal", input.portal)
    .eq("principal_ref", principalRef)
    .neq("status", "revoked")
    .maybeSingle();
  if (existing.error) return refuse(503, "UNAVAILABLE", "Grants could not be read.");
  if (existing.data) return { ok: true, grant: existing.data, existed: true };

  const { newGrantRef } = await import("./tickets.pure");
  const { data, error } = await supabase
    .from("mobile_access_grants")
    .insert({
      grant_ref: newGrantRef(),
      clone_id: input.cloneId,
      portal: input.portal,
      principal_kind: input.principalKind,
      principal_ref: principalRef,
      principal_email: email,
      status: "issuable",
      created_by: input.actorUserId,
    })
    .select("*")
    .single();
  if (error) {
    // 23505: a concurrent create won — read it back rather than failing.
    if (error.code === "23505") {
      const again = await supabase
        .from("mobile_access_grants")
        .select("*")
        .eq("clone_id", input.cloneId)
        .eq("portal", input.portal)
        .eq("principal_ref", principalRef)
        .neq("status", "revoked")
        .maybeSingle();
      if (again.data) return { ok: true, grant: again.data, existed: true };
    }
    return refuse(503, "UNAVAILABLE", `The grant could not be written: ${error.message}`);
  }
  await writeAuditLog({
    action: "mobile_grant.created",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: {
      grant_ref: data.grant_ref,
      portal: input.portal,
      principal_kind: input.principalKind,
    },
  });
  return { ok: true, grant: data, existed: false };
}

export async function revokeGrant(
  supabase: Db,
  input: { grantId: string; reason: string; actorUserId: string | null },
): Promise<{ ok: true } | GatewayRefusal> {
  if (input.reason.trim().length < 10)
    return refuse(400, "INVALID_REQUEST", "Say why, in at least ten characters.");
  const { data, error } = await supabase
    .from("mobile_access_grants")
    .update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      revoked_reason: input.reason.trim(),
    })
    .eq("id", input.grantId)
    .neq("status", "revoked")
    .select("clone_id, grant_ref")
    .maybeSingle();
  if (error) return refuse(503, "UNAVAILABLE", error.message);
  if (!data) return refuse(404, "NOT_FOUND", "No live grant has that id.");
  // Unspent tickets die with the grant. A claim refuses a revoked grant
  // anyway, so a write that failed here is logged rather than reported.
  const { error: expireError } = await supabase
    .from("mobile_activation_tickets")
    .update({ expires_at: new Date().toISOString() })
    .eq("grant_id", input.grantId)
    .is("consumed_at", null);
  if (expireError) console.warn("[mobile] tickets not expired on revoke:", expireError.message);
  await writeAuditLog({
    action: "mobile_grant.revoked",
    entityType: "clone",
    entityId: data.clone_id,
    actorUserId: input.actorUserId,
    metadata: { grant_ref: data.grant_ref, reason: input.reason.trim() },
  });
  return { ok: true };
}

// ── Links ───────────────────────────────────────────────────────────────────

export type IssuedLink = {
  ok: true;
  grantRef: string;
  kind: TicketKind;
  expiresAt: string;
  /** Present only for a provisioned URL. A magic link is never shown to anyone. */
  link: string | null;
  emailedTo: string | null;
  reissued: boolean;
};

/**
 * Mint a fresh link for one grant. A device-bound grant is RE-ISSUED: the
 * device is unbound (the old installation's next refresh fails) and the seat
 * returns. Every older unspent ticket is expired, so only the newest link
 * works.
 */
export async function issueAccessLink(
  supabase: Db,
  input: {
    grantId: string;
    kind: TicketKind;
    /** Email the link here. A magic link is always emailed, to the grant's own address. */
    deliverTo?: string | null;
    actorUserId: string | null;
    now?: Date;
  },
): Promise<IssuedLink | GatewayRefusal> {
  const now = input.now ?? new Date();
  const { data: grant, error } = await supabase
    .from("mobile_access_grants")
    .select("*")
    .eq("id", input.grantId)
    .maybeSingle();
  if (error) return refuse(503, "UNAVAILABLE", "The grant could not be read.");
  if (!grant) return refuse(404, "NOT_FOUND", "No grant has that id.");
  if (grant.status === "revoked") return refuse(409, "GRANT_REVOKED", "This grant is revoked.");

  const status = grant.status as GrantStatus;
  const reissued = status === "device_bound";
  const next = nextGrantStatus(status, reissued ? "reissue" : "issue_link");
  if (!next) return refuse(409, "CONFLICT", `A ${status} grant cannot be issued a link.`);

  const deliverTo =
    input.kind === "magic_link" ? grant.principal_email : input.deliverTo?.trim() || null;
  if (input.kind === "magic_link" && !deliverTo)
    return refuse(409, "CONFLICT", "This grant has no email address to send a magic link to.");
  if (deliverTo && !isResendConfigured())
    return refuse(503, "EMAIL_UNAVAILABLE", "Platform email is not configured yet.");

  const [cloneRes] = await Promise.all([
    supabase.from("clones").select("name").eq("id", grant.clone_id).maybeSingle(),
  ]);
  if (cloneRes.error) return refuse(503, "UNAVAILABLE", "The workspace could not be read.");

  const patch: Database["public"]["Tables"]["mobile_access_grants"]["Update"] = { status: next };
  if (reissued) {
    Object.assign(patch, {
      device_install_id: null,
      device_thumbprint: null,
      key_hash: null,
      bound_at: null,
    });
  }
  const { data: moved, error: moveError } = await supabase
    .from("mobile_access_grants")
    .update(patch)
    .eq("id", grant.id)
    .eq("status", grant.status)
    .select("id")
    .maybeSingle();
  if (moveError) return refuse(503, "UNAVAILABLE", moveError.message);
  if (!moved) return refuse(409, "CONFLICT", "The grant changed while the link was issued.");

  // One live link per grant: an earlier link still in somebody's inbox must
  // not stay usable beside the new one, so a failure here refuses the issue.
  const { error: supersedeError } = await supabase
    .from("mobile_activation_tickets")
    .update({ expires_at: now.toISOString() })
    .eq("grant_id", grant.id)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString());
  if (supersedeError)
    return refuse(
      503,
      "UNAVAILABLE",
      `Earlier links could not be withdrawn: ${supersedeError.message}`,
    );

  const ticket = newActivationTicket();
  const expiresAt = ticketExpiry(input.kind, now).toISOString();
  const { error: recordError } = await supabase.from("mobile_activation_tickets").insert({
    grant_id: grant.id,
    kind: input.kind,
    ticket_hash: await sha256Hex(ticket),
    expires_at: expiresAt,
    delivered_to_email: deliverTo,
    issued_by: input.actorUserId,
  });
  if (recordError)
    return refuse(503, "UNAVAILABLE", `The link could not be recorded: ${recordError.message}`);

  const link = buildGatewayLink(grant.grant_ref, ticket, mobileGatewayOrigin());
  if (deliverTo) {
    const mail = composeAccessEmail({
      workspaceName: cloneRes.data?.name ?? "your workspace",
      appLabel: PORTAL_APPS[grant.portal as MobilePortal]?.label ?? "Aurixa",
      link,
      kind: input.kind,
    });
    try {
      await sendPlatformEmail({
        to: deliverTo,
        ...mail,
        idempotencyKey: `mgt:${await sha256Hex(ticket)}`,
      });
    } catch (e) {
      // The ticket exists and nobody holds it; expire it so a failed send
      // leaves nothing live behind.
      const { error: expireError } = await supabase
        .from("mobile_activation_tickets")
        .update({ expires_at: now.toISOString() })
        .eq("ticket_hash", await sha256Hex(ticket));
      if (expireError) console.warn("[mobile] unsent ticket not expired:", expireError.message);
      return refuse(502, "EMAIL_FAILED", `The email could not be sent: ${msg(e)}`);
    }
  }
  await writeAuditLog({
    action: reissued ? "mobile_grant.reissued" : "mobile_grant.link_issued",
    entityType: "clone",
    entityId: grant.clone_id,
    actorUserId: input.actorUserId,
    metadata: { grant_ref: grant.grant_ref, kind: input.kind, emailed: Boolean(deliverTo) },
  });
  return {
    ok: true,
    grantRef: grant.grant_ref,
    kind: input.kind,
    expiresAt,
    link: input.kind === "provisioned_url" ? link : null,
    emailedTo: deliverTo,
    reissued,
  };
}

export const MAGIC_LINK_ANSWER =
  "If that email has access to an app for that workspace, a link is on its way. It lasts 15 minutes.";

/**
 * The self-service form. Always answers `MAGIC_LINK_ANSWER`; what happened is
 * logged, never returned.
 */
export async function requestMagicLink(
  supabase: Db,
  input: { email: string; workspace: string; portal?: string | null; ip: string },
): Promise<{ ok: true; message: string } | GatewayRefusal> {
  const email = (input.email ?? "").trim().toLowerCase();
  const workspace = (input.workspace ?? "").trim().toLowerCase();
  const portal: MobilePortal = isMobilePortal(input.portal) ? input.portal : "command-centre";
  const uniform = { ok: true as const, message: MAGIC_LINK_ANSWER };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[a-z0-9.-]{1,253}$/.test(workspace)) {
    return refuse(400, "INVALID_REQUEST", "Enter your email and your workspace's address.");
  }
  const [byIp, byEmail] = await Promise.all([
    checkPublicRateLimit("mobile:magic-link:ip", input.ip, 20),
    checkPublicRateLimit("mobile:magic-link:email", email, 5),
  ]);
  if (!byIp.ok || !byEmail.ok) {
    return refuse(429, "RATE_LIMITED", "Too many requests. Try again in a few minutes.");
  }
  try {
    const slug = workspace.split(".")[0];
    // Three separate equality reads — a filter is never composed as a string.
    const [bySlug, bySubdomain, byFqdn] = await Promise.all([
      supabase.from("clones").select("id").eq("slug", slug).limit(2),
      supabase.from("clones").select("id").eq("subdomain", slug).limit(2),
      supabase.from("clones").select("id").eq("subdomain_fqdn", workspace).limit(2),
    ]);
    const ids = new Set(
      [...(bySlug.data ?? []), ...(bySubdomain.data ?? []), ...(byFqdn.data ?? [])].map(
        (c) => c.id,
      ),
    );
    if (ids.size !== 1) return uniform;
    const cloneId = [...ids][0];
    const { data: grant } = await supabase
      .from("mobile_access_grants")
      .select("id")
      .eq("clone_id", cloneId)
      .eq("portal", portal)
      .eq("principal_email", email)
      .neq("status", "revoked")
      .maybeSingle();
    if (!grant) return uniform;
    const issued = await issueAccessLink(supabase, {
      grantId: grant.id,
      kind: "magic_link",
      actorUserId: null,
    });
    if (!issued.ok) console.warn("[mobile] magic link not issued:", issued.code, issued.message);
  } catch (e) {
    console.error("[mobile] magic link request failed:", msg(e));
  }
  return uniform;
}

// ── Facts a claim is judged on ──────────────────────────────────────────────

/**
 * The seat entitlement, read so a failure is distinguishable from "no
 * entitlement" — `seatEntitlementSnapshot` reads both as null, and a database
 * fault must never mean "unmetered".
 */
async function readSeatEntitlement(
  supabase: Db,
  cloneId: string,
): Promise<Read<{ seat_limit: number | null }>> {
  const ent = await supabase
    .from("clone_seat_entitlements")
    .select("seat_plan_id, status")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (ent.error) return { ok: false };
  if (!ent.data) return { ok: true, row: null };
  const plan = await supabase
    .from("seat_plans")
    .select("seat_limit")
    .eq("id", ent.data.seat_plan_id)
    .maybeSingle();
  if (plan.error) return { ok: false };
  return { ok: true, row: { seat_limit: plan.data?.seat_limit ?? null } };
}

async function countBoundDevices(supabase: Db, cloneId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("mobile_access_grants")
    .select("id", { count: "exact", head: true })
    .eq("clone_id", cloneId)
    .eq("status", "device_bound");
  return error ? null : (count ?? 0);
}

type ClaimContext = {
  gateway: Read<{
    gateway_id: string;
    status: string;
    cohort_enabled: boolean;
    licensed_portals: string[];
    trial_started_at: string;
    trial_extension_hours: number;
    legacy_clone: boolean;
    exception_granted_at: string | null;
  }>;
  backend: Read<{ status: string; supabase_url: string | null; anon_key: string | null }>;
  clone: Read<{ name: string }>;
  gate: Read<{ paid: boolean; locked: boolean }>;
  entitlement: Read<{ seat_limit: number | null }>;
  boundDevices: number | null;
};

async function readClaimContext(supabase: Db, cloneId: string, now: Date): Promise<ClaimContext> {
  const [gw, be, cl, gate, entitlement, boundDevices] = await Promise.all([
    supabase
      .from("clone_mobile_gateways")
      .select(
        "gateway_id, status, cohort_enabled, licensed_portals, trial_started_at, trial_extension_hours, legacy_clone, exception_granted_at",
      )
      .eq("clone_id", cloneId)
      .maybeSingle(),
    supabase
      .from("clone_backends")
      .select("status, supabase_url, anon_key")
      .eq("clone_id", cloneId)
      .maybeSingle(),
    supabase.from("clones").select("name").eq("id", cloneId).maybeSingle(),
    readGate(cloneId),
    readSeatEntitlement(supabase, cloneId),
    countBoundDevices(supabase, cloneId),
  ]);
  return {
    gateway: gw.error ? { ok: false } : { ok: true, row: gw.data },
    backend: be.error ? { ok: false } : { ok: true, row: be.data },
    clone: cl.error ? { ok: false } : { ok: true, row: cl.data },
    gate: !gate.ok
      ? { ok: false }
      : {
          ok: true,
          row: gate.row
            ? {
                paid: gate.row.paid_at != null,
                locked: resolveGateState(factsOf(gate.row), now).locked,
              }
            : null,
        },
    entitlement,
    boundDevices,
  };
}

// ── The claim ───────────────────────────────────────────────────────────────

export type ClaimBody = {
  grant_ref?: unknown;
  portal?: unknown;
  ticket?: unknown;
  gateway_key?: unknown;
  install_id?: unknown;
  device_thumbprint?: unknown;
  code_challenge?: unknown;
};

export type ClaimAnswer = {
  ok: true;
  assertion: string;
  expires_in: number;
  /** Returned ONLY on the claim that binds the device (or its lost-answer retry). */
  gateway_key: string | null;
  workspace_bootstrap: Awaited<ReturnType<typeof signManifest>>;
};

/**
 * The one POST that spends a link.
 *
 * Two modes. A TICKET claim is the first open of a link: it spends the ticket
 * and, on a grant not yet bound, binds this installation and returns the
 * gateway key once. A KEY claim is a bound installation activating again (its
 * session was lost or logged out): it proves the key, the install id and the
 * device thumbprint all match the binding, and spends nothing.
 *
 * Signing happens BEFORE anything is spent, so a missing key costs the person
 * nothing but a retry.
 */
export async function claim(
  supabase: Db,
  body: ClaimBody,
  ip: string,
  now: Date = new Date(),
): Promise<ClaimAnswer | GatewayRefusal> {
  const invalid = refuse(400, "INVALID_REQUEST", "This request is not a valid claim.");
  if (!isGrantRef(body.grant_ref) || !isMobilePortal(body.portal)) return invalid;
  if (!isInstallId(body.install_id) || !isThumbprint(body.device_thumbprint)) return invalid;
  if (!isCodeChallenge(body.code_challenge)) return invalid;
  const grantRef = body.grant_ref;
  const portal = body.portal;
  const installId = body.install_id;
  const thumbprint = body.device_thumbprint;
  const codeChallenge = body.code_challenge;

  const ticketMode = body.ticket !== undefined && body.ticket !== null;
  const key = ticketMode ? null : parseGatewayKey(body.gateway_key);
  if (ticketMode && !isActivationTicket(body.ticket)) return invalid;
  if (!ticketMode && (!key || key.grantRef !== grantRef)) return invalid;

  const [byIp, byGrant] = await Promise.all([
    checkPublicRateLimit("mobile:claim:ip", ip, 30),
    checkPublicRateLimit("mobile:claim:grant", grantRef, 10),
  ]);
  if (!byIp.ok || !byGrant.ok)
    return refuse(429, "RATE_LIMITED", "Too many attempts. Try again in a few minutes.");

  const g = await supabase
    .from("mobile_access_grants")
    .select("*")
    .eq("grant_ref", grantRef)
    .maybeSingle();
  if (g.error) return refuse(503, "UNAVAILABLE", "Access could not be checked. Try again.");
  const grant = g.data;

  // Work out what the presented credential is worth, without spending it.
  let ticketRowId: string | null = null;
  let state: TicketState | "missing" = "missing";
  if (grant && ticketMode) {
    const t = await supabase
      .from("mobile_activation_tickets")
      .select("id, grant_id, expires_at, consumed_at, consumed_install_id")
      .eq("ticket_hash", await sha256Hex(body.ticket as string))
      .maybeSingle();
    if (t.error) return refuse(503, "UNAVAILABLE", "Access could not be checked. Try again.");
    if (t.data && t.data.grant_id === grant.id) {
      ticketRowId = t.data.id;
      state = ticketState(t.data, now, installId);
      // A retry of a lost answer is honoured only inside the link's lifetime.
      if (state === "used_by_this_install" && Date.parse(t.data.expires_at) <= now.getTime()) {
        state = "expired";
      }
    }
  } else if (grant && key) {
    const keyMatches =
      grant.key_hash !== null &&
      timingSafeEqualStr(grant.key_hash, await sha256Hex(key.key)) &&
      grant.device_install_id === installId &&
      grant.device_thumbprint === thumbprint;
    state = keyMatches ? "used_by_this_install" : "missing";
  }

  const ctx = grant ? await readClaimContext(supabase, grant.clone_id, now) : null;
  const gw = ctx?.gateway.ok ? ctx.gateway.row : null;
  const eligibility = assessNativeEligibility(
    eligibilityFactsFrom({
      gateway: ctx?.gateway ?? { ok: false },
      backendStatus: ctx?.backend ?? { ok: false },
      gate: ctx?.gate ?? { ok: false },
      portal,
      now,
    }),
  );
  const gatewayStatus =
    ctx && !ctx.gateway.ok
      ? null
      : gw && (gw.status === "active" || gw.status === "suspended" || gw.status === "revoked")
        ? gw.status
        : null;

  const decision = decideClaim({
    grant: grant
      ? {
          status: grant.status as GrantStatus,
          portal: grant.portal as MobilePortal,
          device_install_id: grant.device_install_id,
          device_thumbprint: grant.device_thumbprint,
        }
      : null,
    ticket: state,
    requestedPortal: portal,
    installId,
    deviceThumbprint: thumbprint,
    eligibility,
    gatewayStatus,
    seatAvailable: ctx
      ? seatAvailableFrom({ entitlement: ctx.entitlement, boundDevices: ctx.boundDevices })
      : null,
  });
  if (!decision.ok) return refuse(decision.status, decision.code, decision.message);
  if (!grant || !ctx || !gw) return refuse(401, "AUTH_REQUIRED", "This access link is not valid.");

  const backend = ctx.backend.ok ? ctx.backend.row : null;
  if (!backend?.supabase_url || !backend.anon_key) {
    return refuse(503, "PROVISIONING_UNVERIFIED", "This workspace is not ready for its apps yet.");
  }
  if (!releaseSigningKeyPresent()) {
    return refuse(503, "UNAVAILABLE", "App activation is not configured yet. Try again later.");
  }

  // ── Sign first: nothing is spent until both signatures exist. ────────────
  const jti = crypto.randomUUID();
  // A ticket claim always hands the device a key: the binding claim mints the
  // first one, and a lost-answer retry replaces it (the device never received
  // the old one). A key claim already holds its key.
  const gatewayKey = ticketMode ? newGatewayKey(grant.grant_ref) : null;
  let assertion: string;
  let bootstrap: Awaited<ReturnType<typeof signManifest>>;
  try {
    assertion = await signCloneAssertion({
      subject: activationSubject(grant.clone_id),
      audience: activationAudience(gw.gateway_id, mobileGatewayOrigin()),
      lifetimeSeconds: ACTIVATION_LIFETIME_SECONDS,
      jti,
      claims: {
        purpose: ACTIVATION_PURPOSE,
        clone_id: grant.clone_id,
        gateway_id: gw.gateway_id,
        portal,
        principal_kind: grant.principal_kind,
        principal_ref: grant.principal_ref,
        grant_ref: grant.grant_ref,
        install_id: installId,
        device_thumbprint: thumbprint,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      },
    });
    bootstrap = await signManifest({
      v: 1,
      kind: "workspace_bootstrap",
      clone_id: grant.clone_id,
      gateway_id: gw.gateway_id,
      portal,
      workspace_name: ctx.clone.ok ? (ctx.clone.row?.name ?? null) : null,
      supabase_url: backend.supabase_url,
      anon_key: backend.anon_key,
      functions_url: `${backend.supabase_url.replace(/\/$/, "")}/functions/v1`,
      issuer: cloneIssuerUrl(),
      grant_ref: grant.grant_ref,
      install_id: installId,
      issued_at: now.toISOString(),
    });
  } catch (e) {
    console.error("[mobile] claim signing failed:", msg(e));
    return refuse(503, "UNAVAILABLE", "App activation is not configured yet. Try again later.");
  }

  // ── Spend. ───────────────────────────────────────────────────────────────
  if (ticketMode && state === "valid" && ticketRowId) {
    const { data: spentRow, error: spendError } = await supabase
      .from("mobile_activation_tickets")
      .update({
        consumed_at: now.toISOString(),
        consumed_install_id: installId,
        assertion_jti: jti,
      })
      .eq("id", ticketRowId)
      .is("consumed_at", null)
      .gt("expires_at", now.toISOString())
      .select("id")
      .maybeSingle();
    if (spendError) return refuse(503, "UNAVAILABLE", "Access could not be recorded. Try again.");
    if (!spentRow) return refuse(409, "TICKET_USED", "This access link has already been used.");
  }

  if (ticketMode && gatewayKey) {
    const keyHash = await sha256Hex(gatewayKey);
    // The first claim binds the device; a later one from the SAME device only
    // rotates its key. Both are compare-and-set on the grant's own state.
    const bindResult = await (async () => {
      if (decision.bindsDevice) {
        return await supabase
          .from("mobile_access_grants")
          .update({
            status: "device_bound",
            device_install_id: installId,
            device_thumbprint: thumbprint,
            key_hash: keyHash,
            bound_at: now.toISOString(),
            last_claimed_at: now.toISOString(),
          })
          .eq("id", grant.id)
          .eq("status", "active")
          .select("id")
          .maybeSingle();
      }
      return await supabase
        .from("mobile_access_grants")
        .update({ key_hash: keyHash, last_claimed_at: now.toISOString() })
        .eq("id", grant.id)
        .eq("status", "device_bound")
        .eq("device_install_id", installId)
        .eq("device_thumbprint", thumbprint)
        .select("id")
        .maybeSingle();
    })();
    const { data: boundRow, error: bindError } = bindResult;
    if (bindError) return refuse(503, "UNAVAILABLE", "Access could not be recorded. Try again.");
    if (!boundRow)
      return refuse(409, "ALREADY_CLAIMED", "This access is already in use on another device.");
  } else {
    const { error: stampError } = await supabase
      .from("mobile_access_grants")
      .update({ last_claimed_at: now.toISOString() })
      .eq("id", grant.id);
    if (stampError) console.warn("[mobile] last_claimed stamp not written:", stampError.message);
  }

  await writeAuditLog({
    action: decision.bindsDevice ? "mobile_grant.device_bound" : "mobile_grant.claimed",
    entityType: "clone",
    entityId: grant.clone_id,
    actorUserId: null,
    metadata: { grant_ref: grant.grant_ref, portal, mode: ticketMode ? "ticket" : "key", jti },
  });

  return {
    ok: true,
    assertion,
    expires_in: ACTIVATION_LIFETIME_SECONDS,
    gateway_key: gatewayKey,
    workspace_bootstrap: bootstrap,
  };
}

// ── The link page's preview ────────────────────────────────────────────────

export type GrantPreview = {
  workspaceName: string | null;
  portal: MobilePortal;
  appLabel: string;
  /** False when the clone cannot mint a native session for this portal yet. */
  appReady: boolean;
  blocker: string | null;
  androidAvailable: boolean;
  iosCustomAppUrl: string | null;
};

/**
 * What the GET of a link shows. Spends nothing and reveals nothing about the
 * person: no email, no name — the workspace and the app are already in the
 * link's own context. An unknown, revoked or unreadable grant is one answer.
 */
export async function previewGrant(
  supabase: Db,
  grantRef: string,
): Promise<{ ok: true; preview: GrantPreview } | { ok: false }> {
  if (!isGrantRef(grantRef)) return { ok: false };
  const g = await supabase
    .from("mobile_access_grants")
    .select("clone_id, portal, status")
    .eq("grant_ref", grantRef)
    .maybeSingle();
  if (g.error || !g.data || g.data.status === "revoked" || !isMobilePortal(g.data.portal)) {
    return { ok: false };
  }
  const portal = g.data.portal;
  const [clone, releases] = await Promise.all([
    supabase.from("clones").select("name").eq("id", g.data.clone_id).maybeSingle(),
    supabase
      .from("mobile_releases")
      .select("platform, apple_custom_app_url")
      .eq("portal", portal)
      .eq("environment", "production")
      .eq("state", "promoted"),
  ]);
  const rows = releases.data ?? [];
  const app = PORTAL_APPS[portal];
  return {
    ok: true,
    preview: {
      workspaceName: clone.data?.name ?? null,
      portal,
      appLabel: app.label,
      appReady: app.nativeSessionReady,
      blocker: app.blocker,
      androidAvailable: rows.some((r) => r.platform === "android"),
      iosCustomAppUrl: rows.find((r) => r.platform === "ios")?.apple_custom_app_url ?? null,
    },
  };
}

// ── The clone asks: is this grant still good? ───────────────────────────────

export type GrantStatusAnswer = {
  ok: true;
  status: GrantStatus | "unknown";
  bound_to_install: boolean;
  gateway_status: string;
};

/**
 * `mobile-auth-refresh` on a clone asks this before honouring a refresh
 * family. The answer is scoped to the calling clone: a grant ref belonging to
 * another clone reads `unknown`, exactly as one that does not exist.
 */
export async function grantStatusForClone(
  supabase: Db,
  caller: CloneMobileCaller,
  grantRef: unknown,
  installId: unknown,
): Promise<GrantStatusAnswer | GatewayRefusal> {
  if (!isGrantRef(grantRef) || !isInstallId(installId))
    return refuse(400, "INVALID_REQUEST", "grant_ref and install_id are required.");
  const { data, error } = await supabase
    .from("mobile_access_grants")
    .select("status, device_install_id")
    .eq("grant_ref", grantRef)
    .eq("clone_id", caller.cloneId)
    .maybeSingle();
  if (error) return refuse(503, "UNAVAILABLE", "The grant could not be read.");
  if (!data)
    return { ok: true, status: "unknown", bound_to_install: false, gateway_status: caller.status };
  return {
    ok: true,
    status: data.status as GrantStatus,
    bound_to_install: data.status === "device_bound" && data.device_install_id === installId,
    gateway_status: caller.status,
  };
}
