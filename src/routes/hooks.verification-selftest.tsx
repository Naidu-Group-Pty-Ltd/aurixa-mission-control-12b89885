import { createFileRoute } from "@tanstack/react-router";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Operator-invoked endpoint. Auth: the shared CRON_SECRET as a Bearer token.
//
// Asks one clone — or every clone — whether identity verification can
// actually reach the provider from where it runs.
//
// Not a reconcile and not on a schedule: it converges nothing, and a timer
// asking "does it work" every few minutes would spend requests to answer a
// question nobody is holding. It is run when somebody wants to know — after a
// key is withdrawn, after a clone is provisioned, or when a verification is
// reported as failing and the first question is which side of the broker the
// fault is on.
//
// Nothing here decides anything: `runCloneVerificationSelftest` asks and
// reports, and the probe itself belongs to the clone.
export const Route = createFileRoute("/hooks/verification-selftest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        let body: { cloneId?: unknown; mode?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          // No body means the whole fleet, which is the common case.
        }
        const cloneId = typeof body.cloneId === "string" ? body.cloneId.trim() : "";
        /*
         * `probe` unless asked otherwise, and that default is load-bearing:
         * the probe spends nothing while the loop check sends real images
         * through all three operations and is billable on a 2xx. A diagnostic
         * that could start billing because somebody omitted a field is not a
         * diagnostic anybody should trust.
         */
        const mode = body.mode === "loop" ? ("loop" as const) : ("probe" as const);

        try {
          const { runCloneVerificationSelftest, runFleetVerificationSelftest } = await import(
            "@/server/verificationSelftest.server"
          );
          const results = cloneId
            ? [await runCloneVerificationSelftest(cloneId, mode)]
            : await runFleetVerificationSelftest(mode);

          await writeAuditLog({
            action: "verification_selftest",
            entityType: cloneId ? "clone" : "fleet",
            ...(cloneId ? { entityId: cloneId } : {}),
            metadata: { mode, results } as unknown as Record<string, unknown>,
          });

          // 200 with the readings in the body. A clone that could not be
          // asked is a state, not a failed sweep — and reporting it as a
          // failure would hide the clones that answered.
          return new Response(JSON.stringify({ success: true, mode, results }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "self-test failed";
          console.error("[hooks/verification-selftest]", message);
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
