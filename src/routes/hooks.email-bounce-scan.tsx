import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (every fifteen minutes, `email-bounce-scan-15min`): reads the
// sending mailboxes for delivery-status reports and writes hard failures to
// the do-not-send register.
//
// This is the ONLY source of bounces the product has — Microsoft Graph raises
// no webhook for an application-identity send — so without it the "never mail
// an address that bounced" rule has nothing to enforce and reports itself as
// working.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/email-bounce-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { scanForBounces } = await import("@/server/email-bounces.server");
          const result = await scanForBounces();
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
