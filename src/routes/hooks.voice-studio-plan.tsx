// Cron hook: one tick of the Voice Cloning Studio's planning worker.
//
// Scheduled every minute by 20260924130000 with a 290 s HTTP timeout. A tick
// claims at most two queued planning runs and advances each until its budget
// (VOICE_STUDIO_TICK_BUDGET_MS, 150 s by default) is spent; a run with work
// left is re-queued with every finished stage kept, so the next tick resumes
// it. An empty queue is one UPDATE that matches no row.
//
// Auth: Bearer CRON_SECRET (or DRIFT_REFRESH_TOKEN, per verifyCronAuth).
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { runVoiceStudioPlanTick } from "@/server/voice-studio/planner.server";

export const Route = createFileRoute("/hooks/voice-studio-plan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const summary = await runVoiceStudioPlanTick();
          return new Response(JSON.stringify({ ok: true, ...summary }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("voice studio plan tick failed", err);
          return new Response(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "unknown_error" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
