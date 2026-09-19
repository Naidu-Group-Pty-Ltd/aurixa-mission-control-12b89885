import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 5 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Carries every STARTED per-clone email identity forward. Every other
// provisioning pipeline in this platform has a drain and this one did not, so
// an identity waiting on DNS propagation sat still until a person reopened the
// clone's page and pressed a button. That is how a clone ends up registered,
// with its records installed and its domain verified, and still holding no
// key — one click short of the mail outage the feature exists to end.
//
// It advances and never starts. Registering a sending domain chooses a
// hostname and a region and creates a resource at Resend; that is an
// operator's decision. `decideEmailIdentitySweep` refuses any row without a
// `resend_domain_id`, which is also what makes it safe for the drain to use
// the same `provision` mode the operator's button uses — `refresh`
// deliberately mints nothing, and a drain that polls verification forever
// without ever minting the key would close no gap at all.
//
// The response is the run's own reading: whether the master key is visible at
// all, and a per-clone outcome. An empty success on an unconfigured
// deployment reads exactly like a healthy one, which is the failure mode this
// programme keeps paying for.
export const Route = createFileRoute("/hooks/email-identity-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileEmailIdentities, sweepEmailIdentities } =
            await import("@/server/email-identity.server");

          /*
           * START before ADVANCE, in that order and in this same job.
           *
           * The sweep selects FROM `clone_email_identities`, so a clone with no
           * row is invisible to it for ever — it advances identities and cannot
           * begin one. The only thing that ever began one was the deployment
           * drain at `syncing_env`, whose case opens `if (!row.project_id)
           * return`; provisioning writes `not_requested` for `manual` and
           * `none` and `pending_platform` with no Vercel token, and a
           * deployment in any of those states never advances. Every clone in
           * this fleet is served manually, so in practice nothing started one.
           *
           * Here rather than behind a cron job of its own: THE_CLONING_ENGINE.md
           * records six pg_cron jobs that were never scheduled at all, each
           * recorded as applied by a migration that declined to schedule it. A
           * new job is the likeliest way for this repair never to run.
           *
           * Starting first means an identity begun on this pass is advanced on
           * the next one, not two passes later.
           */
          const started = await reconcileEmailIdentities(supabaseAdmin);
          const report = { ...(await sweepEmailIdentities(supabaseAdmin)), started };

          // Only write a breadcrumb when the run did something or refused for
          // a reason worth reading. A drain that files an identical row every
          // five minutes is how an audit log stops being read.
          if (
            report.advanced ||
            report.failed ||
            started.started ||
            started.failed ||
            !report.resendConfigured
          ) {
            await writeAuditLog({
              action: "email_identity_drain_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with the refusals in the body, not 500: an unconfigured
          // credential is a state, not a crash.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Email identity drain failed";
          console.error("[hooks/email-identity-drain]", message);
          await writeAuditLog({
            action: "email_identity_drain_cron",
            entityType: "cron",
            metadata: { error: message },
          });
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
