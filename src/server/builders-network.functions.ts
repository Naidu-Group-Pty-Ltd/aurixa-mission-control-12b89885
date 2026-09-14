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
