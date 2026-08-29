// Phase 2 — Edge provisioning server functions.
// Enqueue/read jobs and per-clone edge config. All mutations require admin.
// The actual work (calling Cloudflare, updating clone_edge_config) is done
// by the drain worker at /hooks/edge-drain.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import crypto from "crypto";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { EdgeProviderSlug, EdgePosture } from "./edge";

// Any-cast helper until types.ts is regenerated after Phase 1 migration.
const admin = supabaseAdmin;

function hashPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload ?? {}))
    .digest("hex");
}

const PostureSchema = z.object({
  security_level: z
    .enum(["off", "essentially_off", "low", "medium", "high", "under_attack"])
    .optional(),
  bot_fight: z.boolean().optional(),
  rate_limit_rps: z.number().int().min(0).max(10000).optional(),
  waf_preset: z.enum(["lenient", "balanced", "strict"]).optional(),
});

const EnqueueSchema = z.object({
  cloneId: z.string().uuid(),
  providerSlug: z.enum(["cloudflare", "aws", "azure"]),
  action: z.enum(["attach", "apply_posture", "sync", "detach"]),
  payload: z
    .object({
      externalRef: z.string().optional(),
      hostname: z.string().optional(),
      accountRef: z.string().optional(),
      posturePreset: z.string().optional(),
      posture: PostureSchema.optional(),
    })
    .default({}),
});

export const enqueueEdgeJob = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => EnqueueSchema.parse(d))
  .handler(async ({ data, context }) => {
    const payload_hash = hashPayload(data.payload);
    const { data: row, error } = await admin
      .from("edge_provisioning_jobs")
      .upsert(
        {
          clone_id: data.cloneId,
          provider_slug: data.providerSlug,
          action: data.action,
          payload: data.payload,
          payload_hash,
          status: "queued",
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          created_by: (context as any).userId ?? null,
        },
        { onConflict: "clone_id,provider_slug,action,payload_hash" },
      )
      .select("id, status")
      .single();
    if (error) throw new Error(error.message);

    // If provider is a mock, resolve the job immediately so the UI updates
    // without needing the worker.
    if (data.providerSlug !== "cloudflare") {
      await admin.from("clone_edge_config").upsert(
        {
          clone_id: data.cloneId,
          provider_slug: data.providerSlug,
          hostname: data.payload.hostname ?? null,
          external_ref: `mock-${data.providerSlug}-${data.cloneId}`,
          status: "waitlisted",
          status_detail: "Provider not yet available. You will be notified.",
        },
        { onConflict: "clone_id,provider_slug" },
      );
      await admin
        .from("edge_provisioning_jobs")
        .update({ status: "succeeded", completed_at: new Date().toISOString() })
        .eq("id", row.id);
      await admin.from("edge_audit").insert({
        clone_id: data.cloneId,
        provider_slug: data.providerSlug,
        action: data.action,
        payload: data.payload,
        result: { mocked: true },
        success: true,
        actor_user_id: (context as any).userId ?? null,
      });
    }

    return { ok: true, jobId: row.id, status: row.status };
  });

export const getCloneEdgeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: configs } = await (supabase as any)
      .from("clone_edge_config")
      .select("*")
      .eq("clone_id", data.cloneId);
    const { data: jobs } = await (supabase as any)
      .from("edge_provisioning_jobs")
      .select("id, provider_slug, action, status, attempts, error, created_at, completed_at")
      .eq("clone_id", data.cloneId)
      .order("created_at", { ascending: false })
      .limit(10);

    // Cloudflare does TWO jobs for a clone and the card only ever reported
    // one. `clone_edge_config` is the OPTIONAL WAF/CDN wrapper; the clone's
    // subdomain DNS is a separate, non-optional thing that Cloudflare has been
    // carrying all along. Reporting only the first is how a page came to read
    // "No edge provider attached" directly above a failed Cloudflare job, for
    // a hostname Cloudflare was resolving at that moment.
    const [{ data: clone }, { data: hosting }, { data: dnsRecord }] = await Promise.all([
      (supabase as any)
        .from("clones")
        .select("subdomain, subdomain_fqdn, subdomain_status")
        .eq("id", data.cloneId)
        .maybeSingle(),
      (supabase as any)
        .from("platform_hosting_config")
        .select("cloudflare_zone_id, cloudflare_zone_name, target_type, target_value, proxied")
        .eq("singleton", true)
        .maybeSingle(),
      (supabase as any)
        .from("edge_dns_records")
        .select("external_record_id, record_type, record_name, record_content, proxied, updated_at")
        .eq("clone_id", data.cloneId)
        .eq("purpose", "clone_subdomain")
        .maybeSingle(),
    ]);

    const dns = clone?.subdomain_fqdn
      ? {
          fqdn: clone.subdomain_fqdn as string,
          status: (clone.subdomain_status as string | null) ?? null,
          zoneId: (hosting?.cloudflare_zone_id as string | null) ?? null,
          zoneName: (hosting?.cloudflare_zone_name as string | null) ?? null,
          // What the record SHOULD say, from the hosting configuration.
          desiredType: (hosting?.target_type as string | null)?.toUpperCase() ?? null,
          desiredContent: (hosting?.target_value as string | null) ?? null,
          desiredProxied: (hosting?.proxied as boolean | null) ?? null,
          // What Mission Control has actually recorded. Null here with a live
          // hostname is the real state this card has to be able to show: the
          // record exists at Cloudflare and we are not tracking it.
          trackedRecordId: (dnsRecord?.external_record_id as string | null) ?? null,
          trackedType: (dnsRecord?.record_type as string | null) ?? null,
          trackedContent: (dnsRecord?.record_content as string | null) ?? null,
          trackedProxied: (dnsRecord?.proxied as boolean | null) ?? null,
          trackedAt: (dnsRecord?.updated_at as string | null) ?? null,
        }
      : null;

    return { configs: configs ?? [], jobs: jobs ?? [], dns };
  });

export const listEdgePresets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("edge_posture_presets")
      .select("*")
      .order("display_name");
    return { presets: data ?? [] };
  });

export const listEdgeProviders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("edge_providers")
      .select("*")
      .order("sort_order");
    return { providers: data ?? [] };
  });

export const applyEdgePreset = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string; providerSlug: EdgeProviderSlug; presetSlug: string }) =>
    z
      .object({
        cloneId: z.string().uuid(),
        providerSlug: z.enum(["cloudflare", "aws", "azure"]),
        presetSlug: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { data: preset, error } = await admin
      .from("edge_posture_presets")
      .select("settings")
      .eq("slug", data.presetSlug)
      .maybeSingle();
    if (error || !preset) throw new Error("preset_not_found");
    const posture = (preset.settings as EdgePosture) ?? {};
    await admin
      .from("clone_edge_config")
      .update({ posture_preset: data.presetSlug })
      .eq("clone_id", data.cloneId)
      .eq("provider_slug", data.providerSlug);
    // Delegate the actual apply via the queue.
    return enqueueEdgeJob({
      data: {
        cloneId: data.cloneId,
        providerSlug: data.providerSlug,
        action: "apply_posture",
        payload: { posture, posturePreset: data.presetSlug },
      },
    });
  });

export const detachEdge = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string; providerSlug: EdgeProviderSlug }) =>
    z
      .object({
        cloneId: z.string().uuid(),
        providerSlug: z.enum(["cloudflare", "aws", "azure"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    return enqueueEdgeJob({
      data: {
        cloneId: data.cloneId,
        providerSlug: data.providerSlug,
        action: "detach",
        payload: {},
      },
    });
  });
