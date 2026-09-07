import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (every minute, `email-campaign-dispatch-1min`): sends the next
// messages of every running campaign, inside its own window, gap and caps, and
// under the per-parameter quotas it carries.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/email-campaign-dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { dispatchDueCampaigns } = await import("@/server/email-campaigns.server");
          const result = await dispatchDueCampaigns();
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
