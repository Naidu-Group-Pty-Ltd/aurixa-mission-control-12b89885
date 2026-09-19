/**
 * The one act that joins a Builders Network connection to the workspace that
 * owns it — deliberately its OWN module, not part of the console plane.
 *
 * `buildersNetworkAdmin.test.ts` pins a rule over
 * `buildersNetworkAdmin.server.ts` and `builders-network.functions.ts`: no
 * service-key name and no Supabase client anywhere on the plane that talks to
 * the network, so that MC can never come to hold the NETWORK's service-role
 * key. This act needs a service-role credential of a different kind — the
 * WORKSPACE's own, which Mission Control already holds in `clone_backends`
 * and already uses to write to clone projects (`branding/mirror.ts`,
 * `cloneSigningPair.server.ts`).
 *
 * Rather than loosen that guard to fit, the act moved. The console plane stays
 * exactly as strict as it was, and the rules that matter here are pinned
 * separately in `buildersTransportInstall.pure.test.ts`: the network is
 * reached only through `callBuilderNetworkAdmin`, no client is ever
 * constructed, and the workspace credential comes from the backends table
 * rather than from this deployment's environment.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callBuilderNetworkAdmin } from "./buildersNetworkAdmin.server";
import { decryptSecret } from "./crypto.server";
import { writeAuditLog } from "./audit.server";
import {
  cloneConnectionRow,
  readTransportGrant,
  redactInstallOutcome,
  refuseBeforeSpending,
  spentSecretRemedy,
  type InstallOutcome,
} from "./buildersTransportInstall.pure";

/**
 * Install a connection's transport on the workspace that owns it.
 *
 * This is the hand-off `builder-network-admin` names and nothing performed:
 * `provision_transport` returns the symmetric secret ONCE "for MC to install
 * in the clone's builder_network_connections row alongside this URL", and
 * Mission Control had no code that caught it. The clone reads that table in
 * four places and writes it in none, so the row was uncreatable and every
 * deployment's Builders Network sat dark behind an empty table.
 *
 * The order is the whole design, and it lives in
 * `buildersTransportInstall.pure.ts`: the workspace is proved WRITABLE before
 * the network is asked for anything, because a secret taken and then dropped
 * is unrecoverable except by a rotation that invalidates whatever the clone
 * already holds. Every refusal before the ask costs nothing; the one failure
 * after it names the rotation remedy instead of inviting a retry the network
 * will refuse.
 *
 * The secret is fetched and installed inside this one server act and is never
 * part of an answer — `redactInstallOutcome` is what the route returns.
 *
 * It deliberately does NOT enable the workspace's `builder_network_enabled`
 * flag. Transport is the credential; the flag is the decision to open the
 * door, and performing one by way of the other is how a feature turns itself
 * on.
 */
export const installCloneNetworkTransport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((data: { connectionId: string; rotate?: boolean }) => {
    if (!data?.connectionId) throw new Error("connectionId required");
    return { connectionId: data.connectionId, rotate: data.rotate === true };
  })
  .handler(async ({ data }): Promise<InstallOutcome> => {
    const { data: shadow } = await supabaseAdmin
      .from("builders_network_connections_shadow")
      .select("clone_id, network_connection_id, builder_org_label, scopes, state")
      .eq("network_connection_id", data.connectionId)
      .maybeSingle();

    const backendRes = shadow?.clone_id
      ? await supabaseAdmin
          .from("clone_backends")
          .select("supabase_url, service_role_key, status")
          .eq("clone_id", shadow.clone_id)
          .maybeSingle()
      : { data: null };

    const refusal = refuseBeforeSpending({
      connection: shadow ? { clone_id: shadow.clone_id, state: shadow.state } : null,
      backend: backendRes.data ?? null,
    });
    if (refusal) return redactInstallOutcome({ ok: false, error: refusal.message });

    const backend = backendRes.data!;
    const cloneUrl = String(backend.supabase_url).replace(/\/+$/, "");
    let cloneKey: string;
    try {
      cloneKey = decryptSecret(String(backend.service_role_key));
    } catch {
      return redactInstallOutcome({
        ok: false,
        error: "This workspace's stored credentials could not be read.",
      });
    }

    const cloneHeaders = {
      apikey: cloneKey,
      Authorization: `Bearer ${cloneKey}`,
      "Content-Type": "application/json",
    };

    /*
     * Prove the table is reachable and writable BEFORE anything is spent. A
     * `limit=0` read answers 200 on a healthy workspace, 404 on one whose
     * migrations never reached the mirror, and 401 on a stale key — three
     * different remedies, all free to discover here and none of them
     * recoverable once `provision_transport` has answered.
     */
    let probe: Response;
    try {
      probe = await fetch(`${cloneUrl}/rest/v1/builder_network_connections?select=id&limit=0`, {
        headers: cloneHeaders,
      });
    } catch (e) {
      return redactInstallOutcome({
        ok: false,
        error: `This workspace's database is unreachable: ${e instanceof Error ? e.message : "network error"}.`,
      });
    }
    if (!probe.ok) {
      const detail = (await probe.text().catch(() => "")).slice(0, 300);
      return redactInstallOutcome({
        ok: false,
        error:
          probe.status === 404
            ? "This workspace has no builder_network_connections table — the Builders Network " +
              "mirror migration has not reached it yet."
            : `This workspace refused the write probe (HTTP ${probe.status}). ${detail}`,
      });
    }

    const operation = data.rotate ? "rotate_transport" : "provision_transport";
    const result = await callBuilderNetworkAdmin(operation, {
      connection_id: data.connectionId,
    });
    if (!result.ok) {
      return redactInstallOutcome({
        ok: false,
        error: String(result.error),
        ...(String(result.error) === "transport_already_provisioned"
          ? {
              remedy:
                "This connection's secret was handed out once already. Rotate transport issues a " +
                "new one and installs it — the old one stops verifying immediately.",
            }
          : {}),
      });
    }

    const grant = readTransportGrant(result.body);
    if (!grant.ok) return redactInstallOutcome({ ok: false, error: grant.message });

    const now = new Date().toISOString();
    const row = cloneConnectionRow({
      networkConnectionId: data.connectionId,
      hmacSecret: grant.secret,
      networkInboundUrl: grant.inboundUrl,
      builderOrgLabel: shadow!.builder_org_label ?? null,
      scopes: (shadow!.scopes as string[] | null) ?? null,
      now,
    });

    /*
     * `network_connection_id` carries a plain UNIQUE constraint on the
     * workspace, so PostgREST can infer it for the merge — checked rather
     * than assumed, because a PARTIAL unique index cannot be inferred from
     * `on_conflict` and answers 42P10 on every deployment.
     */
    let install: Response;
    try {
      install = await fetch(
        `${cloneUrl}/rest/v1/builder_network_connections?on_conflict=network_connection_id`,
        {
          method: "POST",
          headers: { ...cloneHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(row),
        },
      );
    } catch (e) {
      return redactInstallOutcome({
        ok: false,
        error: "The transport secret was spent and could not be installed.",
        remedy: spentSecretRemedy(e instanceof Error ? e.message : "network error"),
      });
    }
    if (!install.ok) {
      const detail = (await install.text().catch(() => "")).slice(0, 300);
      return redactInstallOutcome({
        ok: false,
        error: "The transport secret was spent and could not be installed.",
        remedy: spentSecretRemedy(`HTTP ${install.status} ${detail}`),
      });
    }

    await supabaseAdmin
      .from("builders_network_connections_shadow")
      .update({ state: "active", reported_at: now })
      .eq("network_connection_id", data.connectionId);

    await writeAuditLog({
      action: data.rotate
        ? "builders_network_transport_rotated"
        : "builders_network_transport_installed",
      entityType: "builders_network_connection",
      entityId: data.connectionId,
      // Never the secret. What an operator audits is which workspace was
      // joined to which connection, and when.
      metadata: { clone_id: shadow!.clone_id, network_connection_id: data.connectionId },
    });

    return redactInstallOutcome({
      ok: true,
      cloneId: String(shadow!.clone_id),
      networkConnectionId: data.connectionId,
      rotated: data.rotate,
    });
  });
