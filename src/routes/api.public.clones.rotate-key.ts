/**
 * Public endpoint: a clone's own frontend can rotate its Mission Control
 * API key by calling this with its CURRENT key in `x-clone-api-key`.
 *
 * Flow:
 *  1. Authenticate the caller via its current key (scope `clones:rotate`).
 *  2. Mint a new key (same clone, same scopes; the link key stays the link key).
 *  3. Deliver it into the clone's function environment, and record it there.
 *  4. Only then schedule the old key for revocation after `grace_hours`
 *     (default 1h). A delivery that fails revokes the NEW key and leaves the
 *     old one exactly as it was.
 *  5. Notify operators with the new key's prefix, and fire the
 *     `tokens.key.rotated` webhook to every subscribed endpoint.
 *
 * Mission Control delivers the key itself (key audit S5). The clone's own
 * `mission-control-rotate-key` function was meant to store it and cannot:
 * writing a project secret needs a management token, and a clone never holds
 * one. Measured 30 Oct 2026, a rotation from any clone minted a key nobody
 * received and revoked the old one an hour later, until the link pass minted
 * a third. So the plaintext never leaves Mission Control now: the response
 * carries the prefix and `delivered_to`, never the key.
 *
 * The rotated key is NOT written back into the clone's repository. That step
 * existed and is deleted: nothing anywhere read `.aurixa/credentials.json`,
 * and every write of it left a plaintext credential in git history that no
 * later commit removes.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateApiKey, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { deliverRotatedLinkKey } from "@/server/rotatedLinkKey.server";
import { MISSION_CONTROL_LINK_KEY_LABEL } from "@/server/missionControlLink.pure";
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
            // The link key stays the link key, so the link pass keeps its scopes.
            label:
              parsed.data.label ??
              (current.label === MISSION_CONTROL_LINK_KEY_LABEL
                ? MISSION_CONTROL_LINK_KEY_LABEL
                : `${current.label ?? "key"} (self-rotated)`),
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

        // Delivered before the old key's life is ended: a clone that never
        // received its new key keeps the one it holds.
        const delivered = await deliverRotatedLinkKey(supabaseAdmin, current.clone_id, newId, raw);
        if (!delivered.ok) {
          const { error: undoErr } = await supabaseAdmin
            .from("clone_api_keys")
            .update({ revoked_at: new Date().toISOString() })
            .eq("id", newId);
          return jsonResponse(
            {
              ok: false,
              error: "delivery_failed",
              detail: undoErr
                ? `The new key could not be delivered (${delivered.error}), and could not be revoked either: revoke key ${prefix}… from Mission Control. The current key is unchanged.`
                : `The new key could not be delivered (${delivered.error}) and was revoked. The current key is unchanged.`,
            },
            502,
          );
        }

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
            // SECURITY: the raw key is intentionally NOT stored here, and is
            // not returned either: it went straight to the clone's environment.
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
          key_prefix: prefix,
          new_key_id: newId,
          old_key_id: current.id,
          revoke_at: revokeAt,
          delivered_to: "function_environment",
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
