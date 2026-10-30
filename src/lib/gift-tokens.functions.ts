// Bulk token gifting for promotions / one-off comps.
// Uses existing grant_tokens RPC per tenant. Records a campaign id in
// each ledger row's metadata so a promo can be audited/rolled up.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { balanceSnapshot, fireTokenWebhook } from "@/server/token-webhooks.server";
import { operatorDisplayName, recordAdminAction } from "@/server/purchases.server";
import { rollUpGiftCampaigns } from "./giftCampaigns.pure";

const ScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("plan"), planIds: z.array(z.string().uuid()).min(1) }),
  z.object({ scope: z.literal("tenants"), tenantIds: z.array(z.string().uuid()).min(1).max(1000) }),
]);

async function fanBalanceUpdated(tenantId: string, cloneId?: string | null) {
  try {
    const snap = await balanceSnapshot(tenantId);
    await fireTokenWebhook(
      "tokens.balance.updated",
      { ...snap, source: "admin_gift" },
      cloneId ?? snap.tenant?.clone_id ?? null,
    );
  } catch {
    // best-effort
  }
}

export const previewGiftTargets = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .intersection(ScopeSchema, z.object({ excludeInactive: z.boolean().default(true) }))
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("tenants")
      .select("id, display_name, external_ref, plan_id, clone_id, status", { count: "exact" });
    if (data.scope === "plan") q = q.in("plan_id", data.planIds);
    if (data.scope === "tenants") q = q.in("id", data.tenantIds);
    // Mirror bulkGiftTokens' filter so the preview count matches what the
    // send will actually target — otherwise the button can promise N tenants
    // and the send comes back with "no_tenants_matched".
    if (data.excludeInactive) q = q.eq("status", "active");
    const { data: tenants, error, count } = await q.limit(500);
    if (error) throw new Error(error.message);
    return { tenants: tenants ?? [], count: count ?? 0 };
  });

export const bulkGiftTokens = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .intersection(
        ScopeSchema,
        z.object({
          tokensPerTenant: z.number().int().positive().max(10_000_000),
          reason: z.string().min(3).max(300),
          campaignName: z.string().min(1).max(120),
          expiresAt: z.string().datetime().nullable().optional(),
          excludeInactive: z.boolean().default(true),
        }),
      )
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const campaignId = `promo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const operatorName = await operatorDisplayName(context.userId as string);

    // Resolve target tenants
    let q = supabaseAdmin.from("tenants").select("id, clone_id, plan_id, status");
    if (data.scope === "plan") q = q.in("plan_id", data.planIds);
    else if (data.scope === "tenants") q = q.in("id", data.tenantIds);
    if (data.excludeInactive) q = q.eq("status", "active");
    const { data: targets, error } = await q.limit(5000);
    if (error) return { ok: false as const, error: error.message };
    if (!targets || targets.length === 0) {
      return { ok: false as const, error: "no_tenants_matched" };
    }

    const metadata = {
      campaign_id: campaignId,
      campaign_name: data.campaignName,
      scope: data.scope,
      granted_by: operatorName,
    };

    let granted = 0;
    const failures: Array<{ tenantId: string; error: string }> = [];
    const sideEffects: Array<Promise<unknown>> = [];

    for (const t of targets) {
      // Insert ledger row directly to include metadata (grant_tokens RPC doesn't accept it)
      const { error: gErr } = await supabaseAdmin.from("token_ledger").insert({
        tenant_id: t.id,
        kind: "grant",
        tokens: data.tokensPerTenant,
        source: "manual",
        source_ref: campaignId,
        reason: data.reason,
        expires_at: data.expiresAt ?? null,
        created_by: context.userId,
        metadata,
      });
      if (gErr) {
        failures.push({ tenantId: t.id, error: gErr.message });
        continue;
      }
      granted++;
      sideEffects.push(fanBalanceUpdated(t.id, t.clone_id));
      sideEffects.push(
        recordAdminAction({
          mode: "admin_grant",
          tenantId: t.id,
          itemSlug: `promo:${campaignId}`,
          operatorUserId: context.userId as string,
          operatorUsername: operatorName,
          metadata: { ...metadata, tokens: data.tokensPerTenant, reason: data.reason },
        }),
      );
    }

    // Serverless runtimes cancel in-flight promises once the response is sent,
    // so the clone-facing webhooks / oversight rows must be awaited — firing
    // them with `void` silently dropped every balance-updated webhook.
    await Promise.allSettled(sideEffects);

    if (granted === 0) {
      return {
        ok: false as const,
        error: failures[0]?.error ?? "no_grants_applied",
        failures,
      };
    }

    return {
      ok: true as const,
      campaignId,
      targetsMatched: targets.length,
      granted,
      tokensPerTenant: data.tokensPerTenant,
      totalTokensIssued: granted * data.tokensPerTenant,
      failures,
    };
  });

// List past promotion campaigns by rolling up token_ledger rows with source='promotion'.
// `expires_at` is read with the rest. Every row of a campaign carries the expiry
// it was granted with, and one stored and never shown cannot be checked against
// what the operator set.
export const listGiftCampaigns = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("token_ledger")
      .select("source_ref, tokens, tenant_id, reason, metadata, created_at, created_by, expires_at")
      .eq("source", "manual")
      .like("source_ref", "promo:%")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    return { campaigns: rollUpGiftCampaigns(data ?? []) };
  });
