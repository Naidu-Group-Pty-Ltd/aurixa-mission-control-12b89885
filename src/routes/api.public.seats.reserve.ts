import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { checkSeatThresholds, fireSeatWebhook } from "@/server/seats.server";
import { assertGateOpen, gateLockedBody } from "@/server/payment-gate.server";

const Schema = z.object({
  external_user_id: z.string().min(1).max(200),
  email: z.string().email().max(320).optional().nullable(),
  display_name: z.string().max(200).optional().nullable(),
  idempotency_key: z.string().min(1).max(200),
  ttl_seconds: z.number().int().min(30).max(86_400).optional(),
});

export const Route = createFileRoute("/api/public/seats/reserve")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "seats:manage",
        );
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
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
        // A locked workspace may not take on new users. Blocking the seat is
        // the honest place: reserving one commits Aurixa to a seat nobody has
        // paid for, and it is the only seats endpoint that grows the account —
        // `release` and `commit` stay open so a locked workspace can still be
        // tidied up and an in-flight signup can finish or unwind.
        const gate = await assertGateOpen(key.clone_id);
        if (!gate.open) {
          return jsonResponse(gateLockedBody(gate), 402);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success)
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        const data = parsed.data;

        const { data: result, error } = await supabaseAdmin.rpc(
          "reserve_seat" as never,
          {
            _clone_id: key.clone_id,
            _external_user_id: data.external_user_id,
            _email: data.email ?? null,
            _display_name: data.display_name ?? null,
            _idempotency_key: data.idempotency_key,
            _ttl_seconds: data.ttl_seconds ?? 600,
          } as never,
        );
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);
        const res = result as any;
        const status = res?.ok === false && res?.error === "seat_limit_reached" ? 402 : 200;

        // fire-and-forget thresholds + webhook
        checkSeatThresholds(key.clone_id).catch(() => {});
        if (res?.ok) {
          fireSeatWebhook("seats.reserved", res, key.clone_id).catch(() => {});
        }
        return jsonResponse(res, status);
      },
    },
  },
});
