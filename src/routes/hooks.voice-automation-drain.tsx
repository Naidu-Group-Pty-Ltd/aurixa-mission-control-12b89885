import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 5 minutes
// (20261009120100_schedule_voice_automation_drain.sql).
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Carries every CRM-independent clone's voice-automation settings forward:
//   1. reads Make's answer for each open connection request (a tenant
//      authorising Outlook or Google in another tab), binds what was
//      authorised and applies the revision that was waiting on it;
//   2. retries applies that failed on a Make error, on a back-off, until an
//      operator is told;
//   3. re-checks blocked revisions (a block that needs a person clears itself
//      the moment that person acts, and is re-read here in case they acted in
//      Make rather than in the product);
//   4. once a day per clone, reads the live CFG record and reports fields that
//      somebody edited in Make by hand (drift).
//
// The response is the run's own reading — including whether Mission Control
// holds a Make token at all — because an empty success on an unconfigured
// deployment reads exactly like a healthy one.
export const Route = createFileRoute("/hooks/voice-automation-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const { sweepVoiceAutomation } = await import("@/server/voice-automation.server");
          const summary = await sweepVoiceAutomation();
          return new Response(JSON.stringify({ ok: true, ...summary }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const { writeAuditLog } = await import("@/server/audit.server");
          await writeAuditLog({
            action: "voice_automation.drain_failed",
            entityType: "system",
            metadata: { error: (e as Error)?.message ?? String(e) },
          });
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error)?.message ?? "drain failed" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      },
    },
  },
});
