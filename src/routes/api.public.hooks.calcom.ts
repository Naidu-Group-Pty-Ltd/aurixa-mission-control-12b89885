// Cal.com webhook receiver — a booking moved, cancelled or marked a no-show in
// Cal.com itself (the attendee's own reschedule/cancel link, or the host).
//
// Configure in Cal.com (Settings → Developer → Webhooks → New): subscriber URL
// https://mission-control.aurixasystems.com.au/api/public/hooks/calcom, the
// Booking Created / Rescheduled / Cancelled / Rejected / No-show updated
// triggers, and a secret stored here as CALCOM_WEBHOOK_SECRET. Cal.com signs
// the raw body with it (HMAC-SHA256, hex, `x-cal-signature-256`).
//
// Everything this does is in `calcom-webhook.server.ts`; the route only reads
// the raw body — the signature is over the exact bytes, so it must be read as
// text before anything parses it.
import { createFileRoute } from "@tanstack/react-router";
import { handleCalcomWebhook } from "@/server/calcom-webhook.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/hooks/calcom")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const result = await handleCalcomWebhook(
          rawBody,
          request.headers.get("x-cal-signature-256"),
        );
        return json(result.body, result.status);
      },
    },
  },
});
