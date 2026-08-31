import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { fireTokenWebhook, balanceSnapshot } from "@/server/token-webhooks.server";
import { assertGateOpen, gateLockedBody } from "@/server/payment-gate.server";

const Schema = z.object({
  tenant_ref: z.string().min(1).max(200),
  display_name: z.string().max(200).optional().nullable(),
  kind: z.string().min(1).max(64),
  estimated_tokens: z.number().int().min(0).max(10_000_000),
  idempotency_key: z.string().min(1).max(200),
  ttl_seconds: z.number().int().min(30).max(86_400).optional(),
  request_payload: z.record(z.string(), z.unknown()).optional(),
});

export const Route = createFileRoute("/api/public/tokens/reserve")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "tokens:meter",
        );
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
              count: rl.count,
              limit: rl.limit,
              retry_after_seconds: rl.retry_after_seconds,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retry_after_seconds),
              },
            },
          );
        }

        // Track first-use of an API key (security signal)
        if (!key.first_used_at) {
          await supabaseAdmin
            .from("clone_api_keys")
            .update({ first_used_at: new Date().toISOString() })
            .eq("id", key.id);
          await supabaseAdmin.from("notifications").insert({
            kind: "tokens_key_first_use",
            severity: "info",
            title: `API key first use: ${key.label ?? key.key_prefix ?? key.id.slice(0, 8)}`,
            body: "An API key was used for the first time.",
            clone_id: key.clone_id,
            url: "/settings/billing",
            metadata: { key_id: key.id },
          });
          await fireTokenWebhook(
            "tokens.alert",
            { alert: "key_first_use", key_id: key.id },
            key.clone_id,
          );
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        }
        const data = parsed.data;

        // The activation gate, enforced where it matters most. A workspace
        // provisioned by Mission Control runs on the PRIME'S forwarded vendor
        // keys, so an unpaid clone generating reports spends Aurixa's own
        // OpenAI and property-data budget — and a browser lock screen does not
        // stop a scripted caller. A clone with no gate (the prime, and every
        // clone that pre-dates this) is waved straight through.
        const gate = await assertGateOpen(key.clone_id);
        if (!gate.open) {
          return jsonResponse(gateLockedBody(gate), 402);
        }

        const tenant = await ensureTenant(
          key.clone_id,
          data.tenant_ref,
          data.display_name ?? undefined,
        );
        if (!tenant.ok) return jsonResponse(tenant, 500);

        const { data: result, error } = await supabaseAdmin.rpc("reserve_tokens", {
          _tenant_id: tenant.tenantId,
          _clone_id: key.clone_id as string,
          _kind: data.kind,
          _estimated_tokens: data.estimated_tokens,
          _idempotency_key: data.idempotency_key,
          _ttl_seconds: data.ttl_seconds ?? 600,
          _request_payload: (data.request_payload ?? {}) as never,
        });
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);
        // Fire balance update webhook (fire-and-forget)
        balanceSnapshot(tenant.tenantId)
          .then((snap) =>
            fireTokenWebhook(
              "tokens.balance.updated",
              { ...snap, source: "reserve" },
              key.clone_id,
            ),
          )
          .catch(() => {});
        // Echo the tenant's operator-assigned tracking id so the caller can
        // stamp it onto its token-usage rows — payments (attributed by
        // billing_user_id) and usage then join on a single key.
        const withBilling =
          result && typeof result === "object" && !Array.isArray(result)
            ? { ...result, billing_user_id: tenant.billingUserId ?? null }
            : result;
        return jsonResponse(withBilling, 200);
      },
    },
  },
});
