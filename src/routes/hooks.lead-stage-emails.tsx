// Cron/manual hook: one tick of the priority-access stage mailer.
//
// Two acts in one tick, in this order and for this reason:
//
//   1. `sweepMissingStageEmails` — ask the DATABASE which recent applicants are
//      owed an email nobody raised. The ingest endpoint and the Airtable sync
//      both enqueue as they notice, and both can miss; this is the reader that
//      does not depend on a delivery path having worked.
//   2. `dispatchStageEmails` — claim what is due and send it.
//
// Sweeping first means an obligation raised by the sweep goes out on the same
// tick rather than waiting for the next one, which matters when the tick is a
// minute apart and the email says "your application has been received".
//
// Auth: Bearer CRON_SECRET (or DRIFT_REFRESH_TOKEN, per verifyCronAuth).
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { dispatchStageEmails, sweepMissingStageEmails } from "@/server/lead-stage-emails.server";

export const Route = createFileRoute("/hooks/lead-stage-emails")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          // A sweep that fails must not cost the dispatch: rows already queued
          // are owed whether or not today's sweep could read the table.
          let swept = { queued: 0, skipped: 0, existing: 0 };
          try {
            swept = await sweepMissingStageEmails();
          } catch (err) {
            console.error("lead stage email sweep failed", err);
          }

          const dispatched = await dispatchStageEmails();
          return new Response(JSON.stringify({ ok: true, swept, dispatched }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("lead stage email dispatch failed", err);
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
