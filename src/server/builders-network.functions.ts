/**
 * Server functions for the /builders-network console (extraction plan §5).
 *
 * Every mutation travels MC → network as a federation-asserted call — see
 * buildersNetworkAdmin.server.ts for the switch and the mint. What MC adds
 * of its own here is the METERING IDENTITY (plan §10, decided: PER BUILDER
 * ORGANISATION): approving an organisation ensures a Mission Control tenant
 * keyed `builders-network:<org uuid>` with a NULL clone_id, so every spend
 * the network later reports for that organisation has a ledger of its own
 * from the day it is approved. `ensureTenant` is the existing machinery —
 * one tenant model, not a parallel one — and a tenant that already exists
 * is patched, never duplicated.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant } from "./clone-api-keys.server";
import {
  callBuilderNetworkAdmin,
  networkAdminUrl,
  operateSwitch,
} from "./buildersNetworkAdmin.server";
import { signingKeyPresent } from "./anthropicOidc.server";

export interface NetworkOverview {
  organisations: Record<string, number>;
  connections: Record<string, number>;
  pending_join_requests: number;
  dead_letters: number;
}

export interface NetworkOrganisation {
  id: string;
  legal_name: string;
  trading_name: string | null;
  org_type: string;
  abn: string | null;
  state: string | null;
  status: string;
  is_active: boolean;
  activated_at: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  contact_email: string | null;
  created_at: string;
}

export interface NetworkJoinRequest {
  id: string;
  organisation_id: string;
  builder_user_id: string;
  status: string;
  message: string | null;
  created_at: string;
  decided_at: string | null;
  organisation_legal_name: string | null;
  requester: { name: string; email: string } | null;
}

export interface NetworkWorkspace {
  id: string;
  mc_clone_id: string;
  slug: string;
  display_name: string | null;
}

/** The tenant external_ref for one builder organisation's ledger. */
export function builderOrgTenantRef(organisationId: string): string {
  return `builders-network:${organisationId}`;
}

export const buildersNetworkStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const gate = await operateSwitch();
    const configured = networkAdminUrl() !== null;
    // The THIRD precondition, which this status used not to report at all.
    // `callBuilderNetworkAdmin` checks switch → signing key → url and returns
    // the FIRST failure, so an operator who fixed the switch could walk
    // straight into `signing_key_missing` with no card on the page that had
    // ever mentioned a signing key. Reporting all three at once is what stops
    // one repair from revealing a wall nobody had been shown.
    const signed = signingKeyPresent();
    // The overview is best-effort: a console that cannot reach the network
    // still renders its own switch state and says which leg is missing.
    let overview: NetworkOverview | null = null;
    let overviewError: string | null = null;
    if (gate.enabled && configured) {
      const result = await callBuilderNetworkAdmin("overview");
      if (result.ok) overview = result.body as unknown as NetworkOverview;
      else overviewError = result.error;
    }
    return {
      switch: gate,
      network_url_configured: configured,
      signing_key_present: signed,
      overview,
      overview_error: overviewError,
    };
  });

export const listNetworkOrganisations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { status?: string } | undefined) => data ?? {})
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("list_organisations", {
      ...(data.status ? { status: data.status } : {}),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      organisations: (result.body.organisations as NetworkOrganisation[] | undefined) ?? [],
    };
  });

export const listNetworkJoinRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const result = await callBuilderNetworkAdmin("list_join_requests");
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      join_requests: (result.body.join_requests as NetworkJoinRequest[] | undefined) ?? [],
    };
  });

export const approveNetworkOrganisation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string; legalName?: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("approve_organisation", {
      organisation_id: data.organisationId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };

    // Per-organisation metering identity (plan §10 decision): the ledger
    // exists from approval. A tenant failure does not UNDO the approval —
    // the network's answer stands — but it is surfaced, never swallowed,
    // because a spend with no ledger bills nobody.
    const tenant = await ensureTenant(
      null,
      builderOrgTenantRef(data.organisationId),
      data.legalName ?? null,
    );
    return {
      ok: true as const,
      status: String(result.body.status ?? "active"),
      tenant: tenant.ok
        ? { ok: true as const, tenantId: tenant.tenantId }
        : { ok: false as const, error: tenant.error },
    };
  });

export const suspendNetworkOrganisation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string; reason: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    if (!data?.reason?.trim()) throw new Error("reason required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("suspend_organisation", {
      organisation_id: data.organisationId,
      reason: data.reason.trim(),
    });
    return result.ok
      ? { ok: true as const, status: String(result.body.status ?? "suspended") }
      : { ok: false as const, error: result.error };
  });

export const reinstateNetworkOrganisation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("reinstate_organisation", {
      organisation_id: data.organisationId,
    });
    return result.ok
      ? { ok: true as const, status: String(result.body.status ?? "active") }
      : { ok: false as const, error: result.error };
  });

export const registerWorkspaceOnNetwork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data }) => {
    // The directory travels MC → network from MC's own clone row — the
    // network never takes a workspace's word for its identity.
    const { data: clone, error } = await supabaseAdmin
      .from("clones")
      .select("id, slug, name")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (error || !clone) return { ok: false as const, error: "clone_not_found" };
    const result = await callBuilderNetworkAdmin("upsert_workspace", {
      mc_clone_id: clone.id,
      slug: clone.slug,
      display_name: clone.name ?? null,
    });
    return result.ok
      ? { ok: true as const, workspace: result.body.workspace as unknown as NetworkWorkspace }
      : { ok: false as const, error: result.error };
  });

export const createNetworkConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { cloneId: string; builderOrganisationId: string }) => {
    if (!data?.cloneId || !data?.builderOrganisationId) {
      throw new Error("cloneId and builderOrganisationId required");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("create_connection", {
      mc_clone_id: data.cloneId,
      builder_organisation_id: data.builderOrganisationId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };

    // Mirror into the shadow ledger — operator visibility only, never
    // authoritative (the network's row is the truth; this is the phone book).
    const connectionId = String(result.body.connection_id ?? "");
    if (connectionId) {
      const { error: shadowError } = await supabaseAdmin
        .from("builders_network_connections_shadow")
        .upsert({
          clone_id: data.cloneId,
          network_connection_id: connectionId,
          builder_org_ref: data.builderOrganisationId,
          state: "invited",
          reported_at: new Date().toISOString(),
        }, { onConflict: "network_connection_id" });
      if (shadowError) console.error("[builders-network] shadow upsert failed", shadowError);
    }
    return {
      ok: true as const,
      connection_id: connectionId,
      // Shown ONCE by the console; the network stores only the hash.
      invite_code: String(result.body.invite_code ?? ""),
      expires_at: String(result.body.expires_at ?? ""),
    };
  });

export const revokeNetworkConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { connectionId: string; reason: string }) => {
    if (!data?.connectionId) throw new Error("connectionId required");
    if (!data?.reason?.trim()) throw new Error("reason required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("revoke_connection", {
      connection_id: data.connectionId,
      reason: data.reason.trim(),
    });
    if (result.ok) {
      // The network's revocation already succeeded; the shadow row is the
      // phone book, so a failed mirror write is logged, never surfaced as a
      // failed revocation.
      const { error: shadowError } = await supabaseAdmin
        .from("builders_network_connections_shadow")
        .update({ state: "revoked", reported_at: new Date().toISOString() })
        .eq("network_connection_id", data.connectionId);
      if (shadowError) console.error("[builders-network] shadow revoke update failed", shadowError);
    }
    return result.ok
      ? { ok: true as const }
      : { ok: false as const, error: result.error };
  });

export const setNetworkConnectionTransport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { connectionId: string; inboundUrl: string }) => {
    if (!data?.connectionId) throw new Error("connectionId required");
    if (!/^https:\/\//.test(data?.inboundUrl ?? "")) throw new Error("inboundUrl must be https");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("set_inbound_url", {
      connection_id: data.connectionId,
      inbound_url: data.inboundUrl,
    });
    return result.ok
      ? { ok: true as const }
      : { ok: false as const, error: result.error };
  });

export const listShadowConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("builders_network_connections_shadow")
      .select("id, clone_id, network_connection_id, builder_org_ref, builder_org_label, state, scopes, reported_at")
      .order("reported_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, connections: data ?? [] };
  });

export const listClonesForNetwork = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("clones")
      .select("id, name, slug")
      .order("name", { ascending: true })
      .limit(200);
    if (error) return { ok: false as const, error: error.message };
    return {
      ok: true as const,
      clones: (data ?? []).map((c) => ({ id: c.id, name: c.name ?? c.slug, slug: c.slug })),
    };
  });

// ---------------------------------------------------------------- ranking
/**
 * The marketplace ranking's operator plane.
 *
 * Mission Control does not compute the ranking and cannot edit a score. What
 * it holds are the three instruments the product owner asked for — pin a
 * builder to a position, take one out of the marketplace, freeze the whole
 * published order — plus the commercial placement that buys a labelled band
 * above the organic list.
 *
 * THERE IS NO `setBuilderMeritScore` AND THERE MUST NEVER BE ONE. An operator
 * who could type a merit score could tell a builder a number no evidence
 * produced, and the signal breakdown, the confidence and the list of what
 * could not be measured would all become decoration over a typed figure. Every
 * instrument here sits BESIDE the computed answer rather than replacing it.
 */

/*
 * These describe what the network actually returns, rather than
 * `Record<string, unknown>`.
 *
 * Two reasons, and the second is the one that failed the build. A server
 * function's return has to be provably serializable, and an index signature of
 * `unknown` is not — TanStack rejects it, which is a fair complaint about a
 * value crossing a wire. And a console that renders a builder's evidence needs
 * to know what the evidence looks like; `Record<string, unknown>` tells the
 * page nothing and defers every mistake to runtime.
 */
export interface NetworkRankingOverride {
  id: string;
  organisation_id: string;
  kind: "pin" | "suppress";
  position: number | null;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

export interface NetworkCommercialPlacement {
  id: string;
  organisation_id: string;
  tier: string;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
}

/**
 * One signal's reading. A signal is either measured — with the evidence it was
 * read from — or it is not, with the reason why. There is no third state and
 * no zero: an absence leaves BOTH sides of the average rather than scoring as
 * the worst possible value, which is the rule the whole scorer turns on.
 */
export type NetworkSignalReading =
  | {
    state: "measured";
    value: number;
    evidence: Record<string, number | string | boolean | null>;
  }
  | { state: "not_measured"; reason: string };

export interface NetworkRankingSnapshot {
  organisation_id: string;
  merit_score: number;
  confidence: number;
  measured_score: number | null;
  band: number;
  signals: Record<string, NetworkSignalReading>;
  ranking_version: number;
  computed_at: string;
}

export interface NetworkRankedBuilder {
  organisation_id: string;
  legal_name: string | null;
  trading_name: string | null;
  status: string | null;
  merit_score: number;
  confidence: number;
  measured_score: number | null;
  band: number;
  live_stock: number;
  computed_at: string;
  ranking_version: number;
  override: {
    id: string;
    kind: "pin" | "suppress";
    position: number | null;
    reason: string;
    created_by: string;
    created_at: string;
    expires_at: string | null;
  } | null;
  placement: {
    id: string;
    tier: string;
    priority: number;
    starts_at: string | null;
    ends_at: string | null;
    note: string | null;
  } | null;
}

export interface NetworkRankingState {
  frozen: boolean;
  frozen_reason: string | null;
  frozen_by: string | null;
  frozen_at: string | null;
  last_run_at: string | null;
  last_run_organisations: number | null;
  last_run_items: number | null;
  last_run_error: string | null;
  ranking_version: number;
}

export const listNetworkRanking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const result = await callBuilderNetworkAdmin("ranking_overview");
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      state: (result.body.state as NetworkRankingState | null) ?? null,
      builders: (result.body.builders as NetworkRankedBuilder[] | undefined) ?? [],
    };
  });

export const explainNetworkRanking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("ranking_explain", {
      organisation_id: data.organisationId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, snapshot: result.body.snapshot as NetworkRankingSnapshot };
  });

export const setNetworkRankingOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: {
    organisationId: string;
    kind: "pin" | "suppress";
    position?: number | null;
    reason: string;
    /**
     * Absent takes the network's ninety-day default. An explicit null is the
     * deliberate ask for a STANDING override, and is passed through as null
     * rather than being dropped — the distinction is the whole reason a
     * forgotten pin cannot shape the marketplace for a year.
     */
    expiresAt?: string | null;
  }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    if (data.kind !== "pin" && data.kind !== "suppress") throw new Error("kind must be pin or suppress");
    if (!data.reason || data.reason.trim().length < 10) {
      throw new Error("a reason of at least 10 characters is required");
    }
    if (data.kind === "pin" && (!Number.isInteger(data.position) || Number(data.position) < 1)) {
      throw new Error("a pin needs a position of 1 or more");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const payload: Record<string, unknown> = {
      organisation_id: data.organisationId,
      kind: data.kind,
      reason: data.reason.trim(),
    };
    if (data.kind === "pin") payload.position = data.position;
    if (Object.prototype.hasOwnProperty.call(data, "expiresAt")) {
      payload.expires_at = data.expiresAt ?? null;
    }
    const result = await callBuilderNetworkAdmin("ranking_set_override", payload);
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, override: result.body.override as NetworkRankingOverride };
  });

export const clearNetworkRankingOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string; kind: "pin" | "suppress"; reason?: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    if (data.kind !== "pin" && data.kind !== "suppress") throw new Error("kind must be pin or suppress");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("ranking_clear_override", {
      organisation_id: data.organisationId,
      kind: data.kind,
      ...(data.reason ? { reason: data.reason } : {}),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const };
  });

export const setNetworkRankingFreeze = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { frozen: boolean; reason?: string }) => {
    if (typeof data?.frozen !== "boolean") throw new Error("frozen must be true or false");
    if (data.frozen && (!data.reason || data.reason.trim().length < 10)) {
      throw new Error("freezing the ranking requires a reason of at least 10 characters");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("ranking_set_freeze", {
      frozen: data.frozen,
      ...(data.reason ? { reason: data.reason.trim() } : {}),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, frozen: Boolean(result.body.frozen) };
  });

export const setNetworkCommercialPlacement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: {
    organisationId: string;
    tier: "partner" | "premium" | "featured";
    priority?: number;
    endsAt?: string | null;
    note?: string;
  }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    if (!["partner", "premium", "featured"].includes(data.tier)) throw new Error("unknown tier");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("ranking_set_placement", {
      organisation_id: data.organisationId,
      tier: data.tier,
      ...(Number.isInteger(data.priority) ? { priority: data.priority } : {}),
      ...(data.endsAt !== undefined ? { ends_at: data.endsAt } : {}),
      ...(data.note ? { note: data.note } : {}),
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, placement: result.body.placement as NetworkCommercialPlacement };
  });

export const clearNetworkCommercialPlacement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { organisationId: string }) => {
    if (!data?.organisationId) throw new Error("organisationId required");
    return data;
  })
  .handler(async ({ data }) => {
    const result = await callBuilderNetworkAdmin("ranking_clear_placement", {
      organisation_id: data.organisationId,
    });
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const };
  });
