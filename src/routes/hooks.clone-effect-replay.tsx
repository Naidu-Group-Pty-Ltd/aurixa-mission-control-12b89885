import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";

// Operator- or cron-invocable. Not scheduled: see `check-cron-coverage.mjs`.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Runs the provisioning stage's replay against clones that already exist:
// each owner-approved privilege and policy file in the prime's
// `MIGRATION_EFFECT_REPLAYS.json` whose `-- @effect:` probe returns no row on
// the clone is dry-run in a statement that rolls back, then run for real once
// the dry run shows its probe returning a row, never touching the migration
// ledger; every other probe the prime declares is reported, never repaired.
// A new clone gets this at build (the owner's decision of 30 Oct 2026); this
// is the lever for one built before that, or for a file approved after its
// build. A clone still being provisioned is refused, because its own stage
// does it once its schema is verified. See `migrationEffectReplay.server.ts`.
//
// Body (all optional): `{ "dryRun": true }` probes and dry-runs without
// committing anything (a file that would replay says `would_replay`);
// `{ "cloneId": "…" }` limits the run to one clone.
//
// An option is honoured as given or the request is refused (400) before
// anything runs. Read leniently, a clone's name or a mistyped id became no
// filter, `"dryRun": "true"` became a run for real, and a body that did not
// parse became no options: each an invocation meant for one clone, or for a
// dry run, that replayed across every ready clone. Only an omitted option
// takes its default.
const INVOCATION_BUDGET_MS = 45_000;

const CLONE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/hooks/clone-effect-replay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls (githubUsageMeter.ts).
        beginGithubLane("clone-effect-replay");

        let raw: string;
        try {
          raw = await request.text();
        } catch {
          return refuse("the request body could not be read");
        }
        let body: { dryRun?: unknown; cloneId?: unknown } = {};
        if (raw.trim() !== "") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return refuse("the body must be a JSON object, or empty");
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return refuse("the body must be a JSON object, or empty");
          }
          body = parsed as typeof body;
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          return refuse("dryRun must be true or false");
        }
        if (
          body.cloneId !== undefined &&
          (typeof body.cloneId !== "string" || !CLONE_ID.test(body.cloneId))
        ) {
          return refuse(
            "cloneId must be a clone's id (a UUID); omit it to run against every ready clone",
          );
        }
        const dryRun = body.dryRun === true;
        const cloneId = body.cloneId as string | undefined;

        try {
          // Yields at the actor floor: it lands work the owner approved, as the
          // provisioning drain does, and reads the prime's manifest, the files
          // it names and (for the report) the corpus on the installation's
          // window. Stood down, it says so and changes nothing; asked again,
          // it carries on from what each clone holds.
          const { decideSpend } = await import("@/server/cascade/githubBudget.pure");
          const { readGitHubRemaining } = await import("@/server/githubAllowance.server");
          const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          const { reconcileCloneEffectReplays, effectSweepIsNoteworthy } =
            await import("@/server/migrationEffectReplay.server");
          const result = await reconcileCloneEffectReplays(supabaseAdmin, {
            deadlineAt: Date.now() + INVOCATION_BUDGET_MS,
            dryRun,
            cloneId,
          });

          // A breadcrumb when the run replayed, refused or was stopped, or
          // found a probe returning no row. The report is reviewed by a
          // person, and the template refresh decisions no clone holds always
          // fail, so every run that is not a dry run files one.
          if (effectSweepIsNoteworthy(result)) {
            await writeAuditLog({
              action: "clone_effect_replay_cron",
              entityType: "cron",
              metadata: result as unknown as Record<string, unknown>,
            });
          }

          // 200 with refusals in the body: one clone that could not be
          // resolved is a state, not a failed run.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Effect replay failed";
          console.error("[hooks/clone-effect-replay]", message);
          await writeAuditLog({
            action: "clone_effect_replay_cron",
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
