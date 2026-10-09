import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (daily, `marketing-snapshots-daily`): records today's YouTube
// channel counters and the last seven days of each connected advertising
// account — Meta, Google Ads on YouTube, TikTok — into
// marketing_channel_snapshots (docs/MARKETING.md). A source that is not
// connected is skipped and named in the response; a vendor that fails is
// recorded on its connection and the run moves on.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/marketing-snapshots")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { recordMarketingSnapshots } = await import("@/server/marketing/snapshots.server");
          const result = await recordMarketingSnapshots();
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
