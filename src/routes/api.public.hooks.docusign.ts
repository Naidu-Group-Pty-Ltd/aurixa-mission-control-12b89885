// DocuSign Connect receiver — the instant path from "envelope completed" to
// "clone provisioned".
//
// Configure in DocuSign (Settings → Connect → Add Configuration → REST v2.1
// JSON): URL https://mission-control.aurixasystems.com.au/api/public/hooks/docusign,
// envelope events Sent/Delivered/Completed/Declined/Voided, "Include HMAC
// Signature" with the key stored here as DOCUSIGN_CONNECT_HMAC_KEY. Document
// and recipient data are NOT needed — this receiver reads only the envelope
// id and status, and everything commercial comes from the agreement row
// Mission Control itself wrote before sending.
//
// Security model:
//  - No secret configured → 503 on every delivery. Fail closed, visibly:
//    an unauthenticated receiver that shrugs is how forged "completed"
//    events would start provisioning infrastructure.
//  - HMAC-SHA256(raw body) must match a X-DocuSign-Signature-N header
//    (timing-safe compare). Mismatch → 401, recorded nowhere (a forger does
//    not get to fill the ledger).
//  - Idempotency: (envelope_id, event) claims a ledger row by unique
//    constraint — a Connect retry of a processed delivery answers 200
//    without re-processing. A prior attempt that failed transiently is
//    reprocessed (applyDocusignStatus and the provisioning claim are both
//    idempotent).
//  - Unknown envelopes answer 200 ("not ours"): this account also carries
//    envelopes Mission Control did not send.
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import {
  parseConnectPayload,
  statusFromConnect,
  summarizeConnectPayload,
} from "@/server/agreementProvisioning.pure";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time check of the body's HMAC against every signature header. */
function verifyConnectHmac(rawBody: string, request: Request, key: string): boolean {
  const expected = createHmac("sha256", key).update(rawBody, "utf8").digest();
  for (let i = 1; i <= 4; i++) {
    const header = request.headers.get(`x-docusign-signature-${i}`);
    if (!header) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(header, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

export const Route = createFileRoute("/api/public/hooks/docusign")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.DOCUSIGN_CONNECT_HMAC_KEY?.trim();
        if (!key) {
          return json(
            {
              success: false,
              error:
                "DOCUSIGN_CONNECT_HMAC_KEY is not configured — refusing unauthenticated Connect deliveries.",
            },
            503,
          );
        }

        const rawBody = await request.text();
        if (!verifyConnectHmac(rawBody, request, key)) {
          return json({ success: false, error: "invalid signature" }, 401);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          return json({ success: false, error: "not JSON" }, 400);
        }
        const facts = parseConnectPayload(parsed);
        if (!facts) {
          // Authenticated but unrecognisable (e.g. a non-envelope event kind).
          // Acknowledge so Connect does not retry forever.
          return json({ success: true, ignored: "no envelope id" });
        }

        // ── Idempotency claim by unique (envelope_id, event) ────────────
        const { error: claimErr } = await supabaseAdmin.from("docusign_connect_events").insert({
          envelope_id: facts.envelopeId,
          event_type: facts.event,
          docusign_status: facts.status,
          hmac_valid: true,
          decision: "received",
          payload_summary: asJson(summarizeConnectPayload(facts)),
        });
        if (claimErr) {
          if (claimErr.code === "23505") {
            // Already delivered and recorded. Reprocessing is safe but
            // pointless for a completed claim; answer 200 so Connect stops.
            return json({ success: true, duplicate: true });
          }
          // Ledger unavailable = transient. 5xx so Connect retries.
          return json({ success: false, error: claimErr.message }, 500);
        }

        // ── Match the envelope to an agreement we sent ──────────────────
        const { data: agreement, error: findErr } = await supabaseAdmin
          .from("client_agreements")
          .select("id")
          .eq("docusign_envelope_id", facts.envelopeId)
          .maybeSingle();

        const record = async (
          decision: string,
          extra: Partial<{ agreement_id: string; error: string }> = {},
        ) => {
          const { error: updErr } = await supabaseAdmin
            .from("docusign_connect_events")
            .update({ decision, ...extra })
            .eq("envelope_id", facts.envelopeId)
            .eq("event_type", facts.event);
          if (updErr) console.error("[hooks/docusign] ledger update failed:", updErr.message);
        };

        if (findErr) {
          await record("error", { error: findErr.message });
          return json({ success: false, error: findErr.message }, 500);
        }
        if (!agreement) {
          await record("not_ours");
          return json({ success: true, ignored: "envelope not raised by Mission Control" });
        }

        try {
          const { applyDocusignStatus } = await import("@/server/agreements.server");
          const applied = await applyDocusignStatus(agreement.id, statusFromConnect(facts), {
            completedDateTime: facts.completedAt,
            voidedDateTime: facts.voidedAt,
          });
          await record(applied.transitioned ? "applied" : "no_change", {
            agreement_id: agreement.id,
          });
          return json({ success: true, status: applied.status });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await record("error", { agreement_id: agreement.id, error: message });
          return json({ success: false, error: message }, 500);
        }
      },
    },
  },
});
