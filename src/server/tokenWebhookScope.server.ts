/**
 * The server half of `tokenWebhookScope.pure.ts` — it reads the fleet's hosts
 * and applies the rule. The rule itself is pure and shared, so what the write
 * path refuses and what the delivery path refuses cannot become two standards.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { tenantHostsFrom, webhookEndpointRefusal, type ScopeRefusal } from "./tokenWebhookScope.pure";

export async function assertWebhookEndpointScope(
  url: string,
  cloneId: string | null,
): Promise<ScopeRefusal | null> {
  // Only the fleet-wide scope is constrained, so a per-clone endpoint costs no
  // reads at all.
  if (cloneId != null) return webhookEndpointRefusal(url, cloneId, []);

  const [clones, deployments, backends, prime] = await Promise.all([
    supabaseAdmin.from("clones").select("id, name, deploy_url, subdomain_fqdn"),
    supabaseAdmin.from("clone_deployments").select("clone_id, domain"),
    supabaseAdmin.from("clone_backends").select("clone_id, supabase_project_ref"),
    supabaseAdmin.from("prime_config").select("supabase_project_ref").limit(1).maybeSingle(),
  ]);

  return webhookEndpointRefusal(
    url,
    cloneId,
    tenantHostsFrom({
      clones: clones.data ?? [],
      deployments: deployments.data ?? [],
      backends: backends.data ?? [],
      primeProjectRef: prime.data?.supabase_project_ref ?? null,
    }),
  );
}
