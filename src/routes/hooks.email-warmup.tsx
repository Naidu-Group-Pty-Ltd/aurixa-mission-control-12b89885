import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked (every two minutes, `email-warmup-2min`): one pass of the email
// warmup engine — confirms and finds what was sent, engages with what landed,
// replies, and starts the next conversations of every warming mailbox.
// Auth: requires Bearer CRON_SECRET.
export const Route = createFileRoute("/hooks/email-warmup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { runWarmupTick } = await import("@/server/email-warmup.server");
          const result = await runWarmupTick();
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
