import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 5 minutes
// (20261011090100_schedule_voice_stack_drain.sql).
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Carries every clone's own Vapi organisation and voice stack forward:
//   1. custody — turns on receiving for a clone's domain and mints its Vapi
//      login once the clone's email identity has a verified domain;
//   2. stacks — opens a stack for every clone on a line, re-judges its
//      requirements, and runs the build steps a tick can afford, in order,
//      recording each object the moment it exists; re-checks a stack waiting on
//      a tenant's grant and switches it on when the grant arrives;
//   3. line changes — parks a stack whose clone has left its line.
//
// The response is the run's own reading, including whether Mission Control
// holds a Make token and a Vapi key at all, because an empty success on an
// unconfigured deployment reads exactly like a healthy one.
export const Route = createFileRoute("/hooks/voice-stack-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const { sweepVoiceStacks } = await import("@/server/voice-stack.server");
          const summary = await sweepVoiceStacks();
          return new Response(JSON.stringify({ ok: true, ...summary }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const { writeAuditLog } = await import("@/server/audit.server");
          await writeAuditLog({
            action: "voice_stack.drain_failed",
            entityType: "system",
            metadata: { error: (e as Error)?.message ?? String(e) },
          });
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error)?.message ?? "drain failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
