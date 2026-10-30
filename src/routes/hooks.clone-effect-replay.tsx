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
const INVOCATION_BUDGET_MS = 45_000;

export const Route = createFileRoute("/hooks/clone-effect-replay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls (githubUsageMeter.ts).
        beginGithubLane("clone-effect-replay");

        let body: { dryRun?: unknown; cloneId?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }
        const dryRun = body.dryRun === true;
        const cloneId =
          typeof body.cloneId === "string" && /^[0-9a-f-]{36}$/i.test(body.cloneId)
            ? body.cloneId
            : undefined;

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
