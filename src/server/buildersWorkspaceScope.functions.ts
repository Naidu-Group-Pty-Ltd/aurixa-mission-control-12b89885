/**
 * Grant or withdraw a scope this workspace discloses — `aml:reliance` above
 * all — on the network AND on the workspace, in one operator act.
 *
 * Its own module for the reason `buildersTransportInstall.functions.ts` is:
 * it writes to the workspace's database with the workspace's service-role
 * credential, which the console plane (`builders-network.functions.ts`) is
 * pinned never to name. The rules it holds are in
 * `buildersWorkspaceScope.pure.ts`; the order — network first on a grant,
 * workspace first on a withdrawal — is asserted against this source.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callBuilderNetworkAdmin } from "./buildersNetworkAdmin.server";
import { decryptSecret } from "./crypto.server";
import { writeAuditLog } from "./audit.server";
import { refuseBeforeSpending } from "./buildersTransportInstall.pure";
import {
  isWorkspaceGrantableScope,
  redactScopeOutcome,
  scopesAfter,
  workspaceRowRefusal,
  type ScopeOutcome,
  type WorkspaceConnectionRow,
} from "./buildersWorkspaceScope.pure";

const ROW_COLUMNS =
  "network_connection_id,state,builder_organisation_id,scopes,identity_mismatch_since";

export const setWorkspaceConnectionScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { connectionId: string; scopeKey: string; grant: boolean }) => {
    if (!data?.connectionId) throw new Error("connectionId required");
    if (!data?.scopeKey) throw new Error("scopeKey required");
    if (typeof data.grant !== "boolean") throw new Error("grant must be true or false");
    return { connectionId: data.connectionId, scopeKey: data.scopeKey.trim(), grant: data.grant };
  })
  .handler(async ({ data, context }): Promise<ScopeOutcome> => {
    if (!isWorkspaceGrantableScope(data.scopeKey)) {
      return redactScopeOutcome({
        ok: false,
        error:
          `"${data.scopeKey}" is not a scope this workspace discloses, so it is not the ` +
          "workspace's to grant.",
      });
    }

    const { data: shadow } = await supabaseAdmin
      .from("builders_network_connections_shadow")
      .select("clone_id, network_connection_id, builder_org_ref, scopes, state")
      .eq("network_connection_id", data.connectionId)
      .maybeSingle();
    const backendRes = shadow?.clone_id
      ? await supabaseAdmin
          .from("clone_backends")
          .select("supabase_url, service_role_key, status")
          .eq("clone_id", shadow.clone_id)
          .maybeSingle()
      : { data: null };

    /*
     * The same refusals the install uses. A withdrawal is still allowed on a
     * revoked connection: narrowing is never wrong, and the workspace's copy
     * of the scope outlives a network revocation.
     */
    const withdrawingFromRevoked = !data.grant && shadow?.state === "revoked";
    const refusal = refuseBeforeSpending({
      connection: shadow
        ? {
            clone_id: shadow.clone_id,
            // Judged as live so the backend checks below it still run.
            state: withdrawingFromRevoked ? "active" : shadow.state,
            builder_org_ref: shadow.builder_org_ref,
          }
        : null,
      backend: backendRes.data ?? null,
    });
    if (refusal) return redactScopeOutcome({ ok: false, error: refusal.message });

    const backend = backendRes.data!;
    const cloneUrl = String(backend.supabase_url).replace(/\/+$/, "");
    let cloneKey: string;
    try {
      cloneKey = decryptSecret(String(backend.service_role_key));
    } catch {
      return redactScopeOutcome({
        ok: false,
        error: "This workspace's stored credentials could not be read.",
      });
    }
    const cloneHeaders = {
      apikey: cloneKey,
      Authorization: `Bearer ${cloneKey}`,
      "Content-Type": "application/json",
    };
    const organisationId = String(shadow!.builder_org_ref);
    const rowFilter = `network_connection_id=eq.${encodeURIComponent(data.connectionId)}`;

    // The workspace's own row, read before anything is written anywhere.
    let row: WorkspaceConnectionRow | null;
    try {
      const res = await fetch(
        `${cloneUrl}/rest/v1/builder_network_connections?select=${ROW_COLUMNS}&${rowFilter}`,
        { headers: cloneHeaders },
      );
      if (!res.ok) {
        return redactScopeOutcome({
          ok: false,
          error: `This workspace could not be read (HTTP ${res.status}). Nothing was changed.`,
        });
      }
      const rows = (await res.json()) as WorkspaceConnectionRow[];
      row = rows[0] ?? null;
    } catch (e) {
      return redactScopeOutcome({
        ok: false,
        error: `This workspace is unreachable: ${e instanceof Error ? e.message : "network error"}. Nothing was changed.`,
      });
    }

    /** Write the workspace's copy of the scopes; true when exactly one row took it. */
    const writeWorkspaceScopes = async (scopes: string[], filter: string): Promise<boolean> => {
      try {
        const res = await fetch(`${cloneUrl}/rest/v1/builder_network_connections?${filter}`, {
          method: "PATCH",
          headers: { ...cloneHeaders, Prefer: "return=representation" },
          body: JSON.stringify({ scopes, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return false;
        const written = (await res.json().catch(() => [])) as unknown[];
        return Array.isArray(written) && written.length === 1;
      } catch {
        return false;
      }
    };

    let scopes: string[];
    if (data.grant) {
      const rowRefusal = workspaceRowRefusal(row, organisationId);
      if (rowRefusal) return redactScopeOutcome({ ok: false, error: rowRefusal });

      // Network first: until the workspace's copy follows, the workspace refuses.
      const granted = await callBuilderNetworkAdmin("grant_workspace_scope", {
        connection_id: data.connectionId,
        scope_key: data.scopeKey,
      });
      if (!granted.ok) {
        return redactScopeOutcome({
          ok: false,
          error: `The network refused the grant: ${String(granted.error)}. Nothing was granted.`,
        });
      }
      scopes = scopesAfter(row!.scopes, data.scopeKey, true);
      const recorded = await writeWorkspaceScopes(
        scopes,
        `${rowFilter}&builder_organisation_id=eq.${encodeURIComponent(organisationId)}&state=eq.active`,
      );
      if (!recorded) {
        return redactScopeOutcome({
          ok: false,
          error: "The network holds the grant and this workspace did not record it.",
          remedy:
            "The workspace refuses every read until it holds its own copy, so nothing is exposed. " +
            "Grant again — both sides accept a repeat.",
        });
      }
    } else {
      // Workspace first: its copy alone stops every read at the next request.
      scopes = scopesAfter(row?.scopes ?? [], data.scopeKey, false);
      const withdrawnHere = row ? await writeWorkspaceScopes(scopes, rowFilter) : true;
      const withdrawn = await callBuilderNetworkAdmin("revoke_workspace_scope", {
        connection_id: data.connectionId,
        scope_key: data.scopeKey,
      });
      if (!withdrawnHere || !withdrawn.ok) {
        const networkError = withdrawn.ok ? null : String(withdrawn.error);
        return redactScopeOutcome({
          ok: false,
          error: !withdrawnHere
            ? networkError === null
              ? "The network no longer holds the grant, and this workspace's copy could not be removed."
              : "Neither side could be changed; the grant still stands."
            : `This workspace no longer holds the grant, and the network refused: ${networkError}.`,
          remedy:
            "Reads need both copies, so either side withdrawn already stops them. Withdraw again " +
            "to clear the other.",
        });
      }
    }

    // Display only (`builders_network_connections_shadow` is the phone book),
    // but it is what a rotation reinstalls, so it follows the act.
    const { error: shadowError } = await supabaseAdmin
      .from("builders_network_connections_shadow")
      .update({
        scopes: scopesAfter(shadow!.scopes as string[] | null, data.scopeKey, data.grant),
        reported_at: new Date().toISOString(),
      })
      .eq("network_connection_id", data.connectionId);
    if (shadowError) console.error("[builders-network] shadow scope update failed", shadowError);

    await writeAuditLog({
      action: data.grant ? "builders_network_scope_granted" : "builders_network_scope_withdrawn",
      entityType: "builders_network_connection",
      entityId: data.connectionId,
      actorUserId: context.userId,
      metadata: {
        clone_id: shadow!.clone_id,
        network_connection_id: data.connectionId,
        builder_organisation_id: organisationId,
        scope_key: data.scopeKey,
        granted_by_side: "workspace",
      },
    });

    return redactScopeOutcome({
      ok: true,
      networkConnectionId: data.connectionId,
      scopeKey: data.scopeKey,
      granted: data.grant,
      scopes,
    });
  });
