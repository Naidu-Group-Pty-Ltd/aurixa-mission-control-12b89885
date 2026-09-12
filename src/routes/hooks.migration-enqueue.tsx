import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  enqueueMigrations,
  readMigrationStatus,
  readSettledDigests,
} from "@/server/migration-enqueue.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import type { MigrationSubmission } from "@/server/migrationQueue.pure";

// Called by `.github/workflows/apply-migrations.yml` on merge, not by a timer.
// Auth: the shared CRON_SECRET as a Bearer token, the same credential every
// scheduled worker here uses.
//
// Mission Control's database is a Lovable Cloud project. `get_project` answers
// 403 for it and Supabase's docs are explicit that there is no service-role key
// and no direct database URL for such a project -- so the Management API path
// this replaces could never have worked, whatever secret was set. What arrives
// here goes on `public.schema_migration_queue`, and the `postgres`-owned
// `schema-migration-drain` cron job applies it within the minute.
//
// THE TARGET IS NOT CONFIGURABLE. The old script took a `PROJECT_REF` and had
// to defend itself against its own configuration with a behavioural identity
// check and a forbidden-ref list, because the Management API token reaches
// every project in the organisation and a wrong ref writes this control plane's
// admin schema onto a tenant. Here the target is whichever database this
// deployment is connected to, which is the only answer there is.
//
// Three actions on one route rather than three routes, so the "what is
// scheduled" story stays one line: enqueue submits, status polls, digests
// reports what ran, and none is on a timer because there is nothing to do
// until a merge happens.
//
// `digests` is READ-ONLY and answers nothing a caller could not already get
// from `status` one version at a time. It exists because `sha256` was written
// from the first version of this queue "so what RAN can be compared to the
// repo" and nothing ever compared it — measured, 2 of 55 settled rows differ
// from their repository file today.
type EnqueueBody = { action?: "enqueue"; migrations?: MigrationSubmission[]; enqueuedBy?: string };
type StatusBody = { action: "status"; versions?: string[] };
type DigestsBody = { action: "digests" };

export const Route = createFileRoute("/hooks/migration-enqueue")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        let body: EnqueueBody | StatusBody | DigestsBody;
        try {
          body = (await request.json()) as EnqueueBody | StatusBody | DigestsBody;
        } catch {
          return json({ success: false, error: "body must be JSON" }, 400);
        }

        try {
          if (body?.action === "digests") {
            const digests = await readSettledDigests(supabaseAdmin);
            return json({ success: true, digests });
          }

          if (body?.action === "status") {
            const versions = Array.isArray(body.versions) ? body.versions : [];
            const result = await readMigrationStatus(supabaseAdmin, versions);
            return json({ success: true, ...result });
          }

          const migrations = Array.isArray((body as EnqueueBody).migrations)
            ? ((body as EnqueueBody).migrations as MigrationSubmission[])
            : [];
          if (migrations.length === 0) {
            return json({ success: false, error: "no migrations submitted" }, 400);
          }
          const result = await enqueueMigrations(supabaseAdmin, migrations, {
            ...((body as EnqueueBody).enqueuedBy
              ? { enqueuedBy: String((body as EnqueueBody).enqueuedBy) }
              : {}),
          });
          // 400 when nothing was accepted: a caller that submitted five files
          // and enqueued none has a broken merge, and answering 200 with a
          // rejection list buried in the body is how CI goes green on it.
          const nothingAccepted =
            result.enqueued.length === 0 &&
            result.alreadyQueued.length === 0 &&
            result.alreadyApplied.length === 0;
          return json({ success: !nothingAccepted, ...result }, nothingAccepted ? 400 : 200);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Migration enqueue failed";
          console.error("Migration enqueue failed:", msg);
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
