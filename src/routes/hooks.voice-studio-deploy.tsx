// Cron hook: one tick of the Voice Cloning Studio's deploy worker.
//
// Scheduled every minute by 20260924130000 with a 290 s HTTP timeout. A tick
// claims one queued deployment and runs it until done or until its budget is
// spent (the knowledge-base file can take a while to parse); unfinished work
// is re-queued, and the ledger makes the next tick skip everything already
// written.
//
// Auth: Bearer CRON_SECRET (or DRIFT_REFRESH_TOKEN, per verifyCronAuth).
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { runVoiceStudioDeployTick } from "@/server/voice-studio/deploy.server";

export const Route = createFileRoute("/hooks/voice-studio-deploy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const summary = await runVoiceStudioDeployTick();
          return new Response(JSON.stringify({ ok: true, ...summary }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("voice studio deploy tick failed", err);
          return new Response(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : "unknown_error",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
