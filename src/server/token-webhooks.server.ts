import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { tenantHostsFrom, webhookEndpointRefusal } from "./tokenWebhookScope.pure";

// How many due deliveries one retry pass takes.
const DELIVERY_RETRY_BATCH = 50;

export type TokenWebhookEvent =
  | "tokens.balance.updated"
  | "tokens.key.revoked"
  | "tokens.key.rotated"
  | "tokens.alert";

function sign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Every host a tenant of this control plane answers on.
 *
 * Read here rather than passed in because `fireTokenWebhook` is called from
 * sixteen places and the guard must not be one of them to remember.
 */
async function tenantHosts() {
  const [clones, deployments, backends, prime] = await Promise.all([
    supabaseAdmin.from("clones").select("id, name, deploy_url, subdomain_fqdn"),
    supabaseAdmin.from("clone_deployments").select("clone_id, domain"),
    supabaseAdmin.from("clone_backends").select("clone_id, supabase_project_ref"),
    supabaseAdmin.from("prime_config").select("supabase_project_ref").limit(1).maybeSingle(),
  ]);
  return tenantHostsFrom({
    clones: clones.data ?? [],
    deployments: deployments.data ?? [],
    backends: backends.data ?? [],
    primeProjectRef: prime.data?.supabase_project_ref ?? null,
  });
}

/**
 * Enqueue + best-effort deliver a webhook event to every active endpoint that
 * subscribes to the event and matches the cloneId (or has no clone scope).
 */
export async function fireTokenWebhook(
  event: TokenWebhookEvent,
  payload: Record<string, unknown>,
  cloneId?: string | null,
): Promise<void> {
  const { data: endpoints } = await supabaseAdmin
    .from("token_webhook_endpoints")
    .select("id, url, secret, events, clone_id")
    .eq("is_active", true);

  const subscribed = (endpoints ?? []).filter((e) => {
    if (!(e.events ?? []).includes(event)) return false;
    if (e.clone_id == null) return true;
    return cloneId == null ? false : e.clone_id === cloneId;
  });
  if (subscribed.length === 0) return;

  // A fleet-wide endpoint receives every tenant's events, so it may not BE a
  // tenant's host. Enforced here as well as at the write, because a row that
  // predates the rule — the one that existed did, pointing at the prime's own
  // site — must not be able to ship a single event. Only the fleet-wide rows
  // are checked, so the per-clone endpoints cost nothing.
  const matches: typeof subscribed = [];
  const hosts = subscribed.some((e) => e.clone_id == null) ? await tenantHosts() : [];
  for (const e of subscribed) {
    const refusal = webhookEndpointRefusal(e.url, e.clone_id, hosts);
    if (!refusal) {
      matches.push(e);
      continue;
    }
    // Recorded, never silent: a refused delivery is a fact an operator has to
    // be able to find, and "nothing arrived" is indistinguishable from a
    // receiver that is down.
    const { error } = await supabaseAdmin.from("token_webhook_deliveries").insert({
      endpoint_id: e.id,
      event_type: event,
      payload: { event, data: {} } as never,
      status: "failed",
      response_body: `Refused before sending — ${refusal.message}`,
      attempts: 1,
    });
    if (error) {
      console.error(`[webhook] could not record the refusal for endpoint ${e.id}:`, error.message);
    }
  }
  if (matches.length === 0) return;

  const body = JSON.stringify({
    event,
    occurred_at: new Date().toISOString(),
    data: payload,
  });

  await Promise.all(
    matches.map(async (e) => {
      const delivery = await supabaseAdmin
        .from("token_webhook_deliveries")
        .insert({
          endpoint_id: e.id,
          event_type: event,
          payload: { event, data: payload } as never,
          status: "pending",
        })
        .select("id")
        .single();

      const deliveryId = delivery.data?.id;
      try {
        const sig = sign(e.secret, body);
        const res = await fetch(e.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mc-signature": sig,
            "x-mc-event": event,
            // Receivers de-dupe on this; without it a receiver can only guess
            // a key from the payload and may wrongly drop later events.
            "x-mc-idempotency-key": deliveryId ?? crypto.randomUUID(),
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
          .eq("id", deliveryId!);
      } catch (err) {
        await supabaseAdmin
          .from("token_webhook_deliveries")
          .update({
            status: "failed",
            attempts: 1,
            response_body: err instanceof Error ? err.message.slice(0, 2000) : "unknown",
            next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
          })
          .eq("id", deliveryId!);
      }
    }),
  );
}

/** Retry deliveries that are pending/failed and due. Returns counts. */
export async function retryDueDeliveries(): Promise<{ retried: number; delivered: number }> {
  const { data: due } = await supabaseAdmin
    .from("token_webhook_deliveries")
    .select("id, endpoint_id, event_type, payload, attempts")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .lt("attempts", 6)
    // Due-longest first, so a backlog drains in order rather than leaving the
    // same deliveries permanently behind an arbitrary window of newer ones.
    .order("next_attempt_at", { ascending: true })
    .limit(DELIVERY_RETRY_BATCH);
  if (!due || due.length === 0) return { retried: 0, delivered: 0 };

  let delivered = 0;
  for (const d of due) {
    const ep = await supabaseAdmin
      .from("token_webhook_endpoints")
      .select("url, secret, is_active")
      .eq("id", d.endpoint_id)
      .maybeSingle();
    if (!ep.data?.is_active) continue;
    const body = JSON.stringify(d.payload);
    const sig = sign(ep.data.secret, body);
    try {
      const res = await fetch(ep.data.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mc-signature": sig,
          "x-mc-event": d.event_type,
          // Same key on every retry of this delivery so receivers de-dupe.
          "x-mc-idempotency-key": d.id,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      const ok = res.ok;
      if (ok) delivered += 1;
      const nextAttempts = (d.attempts ?? 0) + 1;
      const backoffMs = Math.min(60_000 * 2 ** nextAttempts, 6 * 60 * 60_000);
      await supabaseAdmin
        .from("token_webhook_deliveries")
        .update({
          status: ok ? "delivered" : "failed",
          response_code: res.status,
          attempts: nextAttempts,
          delivered_at: ok ? new Date().toISOString() : null,
          next_attempt_at: ok ? null : new Date(Date.now() + backoffMs).toISOString(),
        })
        .eq("id", d.id);
    } catch (err) {
      const nextAttempts = (d.attempts ?? 0) + 1;
      await supabaseAdmin
        .from("token_webhook_deliveries")
        .update({
          status: "failed",
          attempts: nextAttempts,
          response_body: err instanceof Error ? err.message.slice(0, 2000) : "unknown",
          next_attempt_at: new Date(Date.now() + 60_000 * 2 ** nextAttempts).toISOString(),
        })
        .eq("id", d.id);
    }
  }
  return { retried: due.length, delivered };
}

/** Helper: load tenant balance snapshot for webhook payloads. */
export async function balanceSnapshot(tenantId: string) {
  const { data: bal } = await supabaseAdmin
    .from("token_balances")
    .select("available, reserved, lifetime_granted, lifetime_spent")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const { data: ten } = await supabaseAdmin
    .from("tenants")
    .select("id, clone_id, external_ref, display_name, current_period_end")
    .eq("id", tenantId)
    .maybeSingle();
  return { tenant: ten, balance: bal };
}
