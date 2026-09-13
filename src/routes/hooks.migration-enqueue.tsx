import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  enqueueMigrations,
  readMigrationStatus,
  readQueueState,
  readSettledDigests,
  resolveMigration,
  type ResolveAction,
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
// Five actions on one route rather than five routes, so the "what is
// scheduled" story stays one line: enqueue submits, status polls a caller's own
// versions, queue reports the whole queue, digests reports what ran, resolve
// ends a halt. None is on a timer, because there is nothing to do until a merge
// happens.
//
// `queue` and `resolve` are the two halves of the September incident. A halted
// queue is ordered, so one failed row stops every migration behind it — and
// `status` could not see it, because it answers about the versions the caller
// submitted. Three merges reported truthfully that their own files were "still
// queued" while a fourth version, from a fortnight earlier, held the line.
//
// `digests` is READ-ONLY and answers nothing a caller could not already get
// from `status` one version at a time. It exists because `sha256` was written
// from the first version of this queue "so what RAN can be compared to the
// repo" and nothing ever compared it — measured, 2 of 55 settled rows differ
// from their repository file today.
type EnqueueBody = { action?: "enqueue"; migrations?: MigrationSubmission[]; enqueuedBy?: string };
type StatusBody = { action: "status"; versions?: string[] };
type DigestsBody = { action: "digests" };
type QueueBody = { action: "queue" };
type ResolveBody = { action: "resolve"; version?: string; resolution?: string; reason?: string };

type Body = EnqueueBody | StatusBody | DigestsBody | QueueBody | ResolveBody;

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

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return json({ success: false, error: "body must be JSON" }, 400);
        }

        try {
          if (body?.action === "queue") {
            return json({ success: true, queue: await readQueueState(supabaseAdmin) });
          }

          if (body?.action === "resolve") {
            // Every argument is checked here AND by the database. Two gates is
            // normally how one of them becomes wrong, but these ask different
            // questions: this one is about the shape of the request, and the
            // function is about the state of the row and the evidence in the
            // catalog. Neither can stand in for the other.
            const version = typeof body.version === "string" ? body.version.trim() : "";
            if (!/^\d{14}$/.test(version)) {
              return json({ success: false, error: "version must be 14 digits" }, 400);
            }
            const resolution = body.resolution;
            if (resolution !== "retry" && resolution !== "record") {
              return json({ success: false, error: 'resolution must be "retry" or "record"' }, 400);
            }
            // A reason is what turns clearing a halt from an anonymous act into
            // a recorded one, so an empty string is not a reason and neither is
            // a word. The database refuses a blank; this refuses a shrug.
            const reason = typeof body.reason === "string" ? body.reason.trim() : "";
            if (reason.length < 10) {
              return json({ success: false, error: "reason must be at least 10 characters" }, 400);
            }
            const result = await resolveMigration(
              supabaseAdmin,
              version,
              resolution as ResolveAction,
              reason,
            );
            // A refusal is a 409, never a 200 with `ok: false` in the body: the
            // caller is a workflow step, and a step that has to read a field to
            // find out it failed is a step that goes green when nobody does.
            return json({ success: result.ok, ...result }, result.ok ? 200 : 409);
          }

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
