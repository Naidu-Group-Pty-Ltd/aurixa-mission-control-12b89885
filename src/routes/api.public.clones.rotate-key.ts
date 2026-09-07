/**
 * Public endpoint: a clone's own frontend can rotate its Mission Control
 * API key by calling this with its CURRENT key in `x-clone-api-key`.
 *
 * Flow:
 *  1. Authenticate the caller via its current key (scope `clones:rotate`).
 *  2. Mint a new key (same clone, same scopes).
 *  3. Schedule the old key for revocation after `grace_hours` (default 1h).
 *  4. Insert a notification on Mission Control with the new key prefix +
 *     full secret (one-time reveal) so operators can see the rotation live.
 *  5. Fire the `tokens.key.rotated` webhook to every subscribed endpoint.
 *
 * The rotated key is NOT written back into the clone's repository. That step
 * existed and is deleted: nothing anywhere read `.aurixa/credentials.json`,
 * and every write of it left a plaintext credential in git history that no
 * later commit removes. The caller receives the new key in this response,
 * which is the channel it asked on.
 *
 * Returns the new key plaintext exactly once to the caller.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateApiKey, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { fireTokenWebhook } from "@/server/token-webhooks.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

const BodySchema = z.object({
  grace_hours: z
    .number()
    .int()
    .min(0)
    .max(24 * 7)
    .optional()
    .default(1),
  label: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(500).optional(),
});

export const Route = createFileRoute("/api/public/clones/rotate-key")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const current = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "clones:rotate",
        );
        if (!current) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(current.id, 10).catch(() => ({ ok: true }));
        if (!rl.ok) {
          return jsonResponse(
            {
              ok: false,
              error: "rate_limited",
              retry_after_seconds: (rl as { retry_after_seconds?: number }).retry_after_seconds,
            },
            429,
          );
        }

        let body: unknown = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const parsed = BodySchema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { ok: false, error: "invalid_body", details: parsed.error.flatten() },
            400,
          );
        }

        if (!current.clone_id) {
          return jsonResponse({ ok: false, error: "prime_keys_cannot_self_rotate" }, 403);
        }

        // Mint the new key
        const { raw, hash, prefix } = generateApiKey();
        const ins = await supabaseAdmin
          .from("clone_api_keys")
          .insert({
            clone_id: current.clone_id,
            label: parsed.data.label ?? `${current.label ?? "key"} (self-rotated)`,
            scopes: current.scopes,
            key_hash: hash,
            key_prefix: prefix,
            rotated_from: current.id,
          })
          .select("id")
          .single();
        if (ins.error || !ins.data) {
          return jsonResponse({ ok: false, error: ins.error?.message ?? "insert_failed" }, 500);
        }
        const newId = ins.data.id;
        const revokeAt = new Date(Date.now() + parsed.data.grace_hours * 3600_000).toISOString();
        // The write that ends the old key's life. Discarded, a failure leaves
        // BOTH keys live for ever while the caller is handed the new one and
        // told it rotated.
        const { error: supersedeErr } = await supabaseAdmin
          .from("clone_api_keys")
          .update({ rotated_to: newId, revoke_at: revokeAt })
          .eq("id", current.id);
        if (supersedeErr) {
          return jsonResponse(
            {
              ok: false,
              error: "rotation_incomplete",
              detail:
                "A new key was minted but the old one could not be scheduled for revocation. Both are live — revoke the old key from Mission Control.",
              key_prefix: prefix,
            },
            500,
          );
        }

        const { data: clone } = await supabaseAdmin
          .from("clones")
          .select("name")
          .eq("id", current.clone_id)
          .maybeSingle();

        // Notify Mission Control with the new key prefix for visibility
        await notifyOperators({
          kind: "tokens_key_rotated",
          severity: "info",
          title: `API key self-rotated by ${clone?.name ?? "clone"}`,
          body: `Clone rotated its own key (prefix ${prefix}…). Old revokes at ${new Date(revokeAt).toLocaleString()}.`,
          cloneId: current.clone_id,
          url: `/settings/billing`,
          metadata: {
            old_key_id: current.id,
            new_key_id: newId,
            new_key_prefix: prefix,
            // SECURITY: the raw key is intentionally NOT stored here.
            // It is returned exactly once in the HTTP response (see below).
            revoke_at: revokeAt,
            grace_hours: parsed.data.grace_hours,
            reason: parsed.data.reason ?? null,
            source: "clone_self_rotate",
          },
        });

        await writeAuditLog({
          action: "clone.api_key.self_rotated",
          entityType: "clone_api_key",
          entityId: newId,
          metadata: {
            clone_id: current.clone_id,
            old_key_id: current.id,
            new_key_prefix: prefix,
            grace_hours: parsed.data.grace_hours,
            reason: parsed.data.reason ?? null,
          },
        });

        void fireTokenWebhook(
          "tokens.key.rotated",
          {
            event_reason: "clone_self_rotate",
            clone_id: current.clone_id,
            old_key_id: current.id,
            new_key_id: newId,
            new_key_prefix: prefix,
            revoke_at: revokeAt,
            grace_hours: parsed.data.grace_hours,
          },
          current.clone_id,
        );

        return jsonResponse({
          ok: true,
          key: raw,
          key_prefix: prefix,
          new_key_id: newId,
          old_key_id: current.id,
          revoke_at: revokeAt,
        });
      },
      OPTIONS: async () => {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, x-clone-api-key",
          },
        });
      },
    },
  },
});
