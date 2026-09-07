import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import crypto from "crypto";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { retryDueDeliveries } from "@/server/token-webhooks.server";

const DEFAULT_EVENTS = [
  "tokens.balance.updated",
  "tokens.key.revoked",
  "tokens.key.rotated",
  "tokens.alert",
] as const;

export const listWebhookEndpoints = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("token_webhook_endpoints")
      .select("id, clone_id, url, events, is_active, created_at, clones:clone_id(id, name, slug)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { endpoints: data ?? [] };
  });

export const upsertWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid().optional(),
        cloneId: z.string().uuid().nullable().optional(),
        url: z.string().url().max(500),
        events: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(10)
          .default([...DEFAULT_EVENTS]),
        isActive: z.boolean().default(true),
        rotateSecret: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // A fleet-wide endpoint (no clone scope) receives EVERY tenant's balance,
    // key and alert events, so it may not be a tenant's own host. Refused
    // here, where the mistake is made, as well as at delivery — the one row
    // that existed was written long before this rule and pointed at the
    // prime's own site.
    const { assertWebhookEndpointScope } = await import("@/server/tokenWebhookScope.server");
    const refusal = await assertWebhookEndpointScope(data.url, data.cloneId ?? null);
    if (refusal) return { ok: false as const, error: refusal.message };

    if (data.id) {
      const newSecret = data.rotateSecret
        ? crypto.randomBytes(32).toString("base64url")
        : undefined;
      const patch = {
        url: data.url,
        events: data.events,
        is_active: data.isActive,
        clone_id: data.cloneId ?? null,
        updated_at: new Date().toISOString(),
        ...(newSecret ? { secret: newSecret } : {}),
      };
      const { error } = await supabaseAdmin
        .from("token_webhook_endpoints")
        .update(patch)
        .eq("id", data.id);
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, secret: newSecret ?? null };
    }
    const secret = crypto.randomBytes(32).toString("base64url");
    const { error } = await supabaseAdmin.from("token_webhook_endpoints").insert({
      url: data.url,
      events: data.events,
      is_active: data.isActive,
      clone_id: data.cloneId ?? null,
      secret,
      created_by: context.userId,
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, secret };
  });

export const deleteWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("token_webhook_endpoints")
      .delete()
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

export const listWebhookDeliveries = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        endpointId: z.string().uuid().optional(),
        status: z.enum(["pending", "delivered", "failed"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("token_webhook_deliveries")
      .select(
        "id, endpoint_id, event_type, status, response_code, response_body, attempts, next_attempt_at, delivered_at, created_at, token_webhook_endpoints:endpoint_id(url)",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.endpointId) q = q.eq("endpoint_id", data.endpointId);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { deliveries: rows ?? [] };
  });

export const retryWebhookDeliveriesNow = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const r = await retryDueDeliveries();
    return { ok: true as const, ...r };
  });

export const redriveWebhookDelivery = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("token_webhook_deliveries")
      .update({ status: "pending", next_attempt_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    const r = await retryDueDeliveries();
    return { ok: true as const, ...r };
  });

/**
 * Send a synthetic `tokens.test` event to a single endpoint so operators can
 * verify HMAC signature handling + idempotency on the receiver side. Bypasses
 * subscription matching — always delivers to the specified endpoint.
 */
export const sendTestWebhook = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ endpointId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: ep, error } = await supabaseAdmin
      .from("token_webhook_endpoints")
      .select("id, url, secret, is_active")
      .eq("id", data.endpointId)
      .maybeSingle();
    if (error || !ep) return { ok: false as const, error: error?.message ?? "endpoint_not_found" };
    if (!ep.is_active) return { ok: false as const, error: "endpoint_paused" };

    const testId = crypto.randomUUID();
    const payload = {
      event: "tokens.test",
      occurred_at: new Date().toISOString(),
      data: {
        test_id: testId,
        message: "Synthetic test event from Mission Control. Safe to ignore.",
      },
    };
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", ep.secret).update(body).digest("hex");

    const delivery = await supabaseAdmin
      .from("token_webhook_deliveries")
      .insert({
        endpoint_id: ep.id,
        event_type: "tokens.test",
        payload: payload as never,
        status: "pending",
      })
      .select("id")
      .single();

    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mc-signature": signature,
          "x-mc-event": "tokens.test",
          "x-mc-idempotency-key": testId,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text().catch(() => "");
      await supabaseAdmin
        .from("token_webhook_deliveries")
        .update({
          status: res.ok ? "delivered" : "failed",
          response_code: res.status,
          response_body: text.slice(0, 2000),
          attempts: 1,
          delivered_at: res.ok ? new Date().toISOString() : null,
          next_attempt_at: res.ok ? null : new Date(Date.now() + 60_000).toISOString(),
        })
        .eq("id", delivery.data!.id);
      return {
        ok: res.ok,
        status: res.status,
        test_id: testId,
        signature,
        body: text.slice(0, 500),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      await supabaseAdmin
        .from("token_webhook_deliveries")
        .update({
          status: "failed",
          attempts: 1,
          response_body: msg.slice(0, 2000),
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .eq("id", delivery.data!.id);
      return { ok: false as const, error: msg, test_id: testId };
    }
  });
