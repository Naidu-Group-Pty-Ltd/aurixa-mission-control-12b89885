// POST /api/public/voice/t/$tenantKey/webhook - the function-tool server URL
// for a fleet the Voice Cloning Studio deployed into a client's VAPI org.
//
// Auth: that tenant's own secret in `x-vapi-secret`, compared constant-time;
// fails closed and audits every refusal. All handling lives in
// src/server/voice-tenant/tenant.server.ts.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/voice/t/$tenantKey/webhook")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const { ingestTenantWebhook } = await import("@/server/voice-tenant/tenant.server");
          return await ingestTenantWebhook(request, params.tenantKey);
        } catch (err) {
          console.error("voice tenant webhook failed:", (err as Error).message);
          return new Response(JSON.stringify({ ok: false, error: "webhook_failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
