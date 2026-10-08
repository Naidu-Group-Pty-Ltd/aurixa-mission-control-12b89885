/**
 * What Mission Control's operators see and do about the mobile apps.
 *
 * Every act here goes through the same functions the public routes use
 * (`createGrant`, `issueAccessLink`, `revokeGrant`, `moveReleaseState`,
 * `repairCloneMobileGateway`), so the console can do nothing the gateway would
 * refuse, and nothing the gateway does is out of the console's sight. The one
 * thing only this file does is READ the whole picture for one clone in one
 * answer, because a page assembling it from five calls shows five moments.
 *
 * A failed read is not an empty one: each part carries `error` rather than an
 * empty list, so "no devices" never stands in for "the devices could not be read".
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { MOBILE_PORTALS, isMobilePortal, type MobilePortal } from "./portals.pure";
import {
  createGrant,
  issueAccessLink,
  revokeGrant,
  type GatewayRefusal,
  type IssuedLink,
} from "./gateway.server";
import { listReleases, moveReleaseState, type ReleaseListing } from "./releases.server";
import {
  repairCloneMobileGateway,
  type MobileGatewayRepairResult,
} from "./cloneMobileGateway.server";
import type { ReleaseAction } from "./releaseStates.pure";
import type { TicketKind } from "./tickets.pure";

type Part<T> = { rows: T; error: null } | { rows: null; error: string };

export type MobileGatewaySummary = {
  gateway_id: string;
  credential_prefix: string;
  status: string;
  delivered_project_ref: string | null;
  delivered_env_at: string | null;
  licensed_portals: string[];
  trial_started_at: string;
  last_seen_at: string | null;
  created_at: string;
};

export type MobileGrantSummary = {
  id: string;
  grant_ref: string;
  portal: string;
  principal_kind: string;
  principal_email: string | null;
  status: string;
  device_install_id: string | null;
  bound_at: string | null;
  last_claimed_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  /** The newest link issued for this grant, if any — never the ticket itself. */
  latest_ticket: {
    kind: string;
    expires_at: string;
    consumed_at: string | null;
    delivered_to_email: string | null;
    created_at: string;
  } | null;
};

export type MobileSubscriptionSummary = { portal: string; channel: string; enabled: boolean };

export type CloneMobileOverview = {
  cloneId: string;
  cloneName: string | null;
  gateway: Part<MobileGatewaySummary | null>;
  subscriptions: Part<MobileSubscriptionSummary[]>;
  grants: Part<MobileGrantSummary[]>;
};

function fail<T>(error: { message: string } | null | undefined): Part<T> | null {
  return error ? { rows: null, error: error.message } : null;
}

export async function getCloneMobileOverview(cloneId: string): Promise<CloneMobileOverview> {
  const db = supabaseAdmin;
  const [clone, gw, subs, grants] = await Promise.all([
    db.from("clones").select("name").eq("id", cloneId).maybeSingle(),
    db
      .from("clone_mobile_gateways")
      .select(
        "gateway_id, credential_prefix, status, delivered_project_ref, delivered_env_at, licensed_portals, trial_started_at, last_seen_at, created_at",
      )
      .eq("clone_id", cloneId)
      .maybeSingle(),
    db
      .from("clone_mobile_release_subscriptions")
      .select("portal, channel, enabled")
      .eq("clone_id", cloneId),
    db
      .from("mobile_access_grants")
      .select(
        "id, grant_ref, portal, principal_kind, principal_email, status, device_install_id, bound_at, last_claimed_at, revoked_at, revoked_reason, created_at",
      )
      .eq("clone_id", cloneId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  let grantPart: Part<MobileGrantSummary[]> = fail<MobileGrantSummary[]>(grants.error) ?? {
    rows: [],
    error: null,
  };
  if (!grants.error && grants.data && grants.data.length) {
    const ids = grants.data.map((g) => g.id);
    const tickets = await db
      .from("mobile_activation_tickets")
      .select("grant_id, kind, expires_at, consumed_at, delivered_to_email, created_at")
      .in("grant_id", ids)
      .order("created_at", { ascending: false });
    if (tickets.error) {
      grantPart = { rows: null, error: tickets.error.message };
    } else {
      const newest = new Map<string, NonNullable<MobileGrantSummary["latest_ticket"]>>();
      for (const t of tickets.data ?? []) {
        if (newest.has(t.grant_id)) continue;
        newest.set(t.grant_id, {
          kind: t.kind,
          expires_at: t.expires_at,
          consumed_at: t.consumed_at,
          delivered_to_email: t.delivered_to_email,
          created_at: t.created_at,
        });
      }
      grantPart = {
        rows: grants.data.map((g) => ({ ...g, latest_ticket: newest.get(g.id) ?? null })),
        error: null,
      };
    }
  }

  const subsOrdered = (subs.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        MOBILE_PORTALS.indexOf(a.portal as MobilePortal) -
        MOBILE_PORTALS.indexOf(b.portal as MobilePortal),
    );

  return {
    cloneId,
    cloneName: clone.data?.name ?? null,
    gateway: fail<MobileGatewaySummary | null>(gw.error) ?? { rows: gw.data ?? null, error: null },
    subscriptions: fail<MobileSubscriptionSummary[]>(subs.error) ?? {
      rows: subsOrdered,
      error: null,
    },
    grants: grantPart,
  };
}

export async function operatorCreateGrant(input: {
  cloneId: string;
  portal: string;
  email: string;
  actorUserId: string | null;
}) {
  if (!isMobilePortal(input.portal)) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Unknown portal." } as const;
  }
  // The console grants staff access to the Command Centre and partner access
  // to a partner portal; the seeded superadmin's grant is minted at birth.
  const kind = input.portal === "command-centre" ? "staff" : "partner";
  return createGrant(supabaseAdmin, {
    cloneId: input.cloneId,
    portal: input.portal,
    principalKind: kind,
    email: input.email,
    actorUserId: input.actorUserId,
  });
}

/** The grant must belong to the clone the page names — an id from another clone is refused. */
async function grantBelongsTo(grantId: string, cloneId: string): Promise<GatewayRefusal | null> {
  const { data, error } = await supabaseAdmin
    .from("mobile_access_grants")
    .select("clone_id")
    .eq("id", grantId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, code: "UNAVAILABLE", message: error.message };
  if (!data || data.clone_id !== cloneId)
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "No grant on this workspace has that id.",
    };
  return null;
}

export async function operatorIssueLink(input: {
  cloneId: string;
  grantId: string;
  kind: TicketKind;
  deliverTo: string | null;
  actorUserId: string | null;
}): Promise<IssuedLink | GatewayRefusal> {
  const wrong = await grantBelongsTo(input.grantId, input.cloneId);
  if (wrong) return wrong;
  return issueAccessLink(supabaseAdmin, {
    grantId: input.grantId,
    kind: input.kind,
    deliverTo: input.deliverTo,
    actorUserId: input.actorUserId,
  });
}

export async function operatorRevokeGrant(input: {
  cloneId: string;
  grantId: string;
  reason: string;
  actorUserId: string | null;
}) {
  const wrong = await grantBelongsTo(input.grantId, input.cloneId);
  if (wrong) return wrong;
  return revokeGrant(supabaseAdmin, {
    grantId: input.grantId,
    reason: input.reason,
    actorUserId: input.actorUserId,
  });
}

export function operatorRepairGateway(
  cloneId: string,
  actorUserId: string | null,
): Promise<MobileGatewayRepairResult> {
  return repairCloneMobileGateway(supabaseAdmin, cloneId, { actorUserId });
}

export async function operatorListReleases(
  portal: string | null,
): Promise<{ ok: true; releases: ReleaseListing[] } | GatewayRefusal> {
  if (portal && !isMobilePortal(portal))
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Unknown portal." };
  return listReleases(supabaseAdmin, portal ? (portal as MobilePortal) : undefined);
}

const ACTIONS: readonly ReleaseAction[] = ["approve", "promote", "pause", "resume", "withdraw"];

export async function operatorMoveRelease(input: {
  releaseId: string;
  action: string;
  percentage?: number;
  reason?: string;
  actorUserId: string;
}) {
  if (!(ACTIONS as readonly string[]).includes(input.action))
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Unknown action." } as const;
  return moveReleaseState(supabaseAdmin, {
    releaseId: input.releaseId,
    action: input.action as ReleaseAction,
    percentage: input.percentage,
    reason: input.reason,
    actorUserId: input.actorUserId,
  });
}
