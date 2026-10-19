// Admin-facing server functions to push GitHub Actions repository
// secrets from Mission Control into the Prime repo — and to take the Codex
// ones back out of clone repos, which no longer run the Codex workflows
// (src/lib/codex-scan-policy.ts).
//
// Three faults used to make this fail from the settings page:
//
//  1. The clone queries selected `github_app_installation_id`, a column that
//     did not exist. PostgREST answered 400, the error was discarded, and
//     `data` came back null — so a single-clone sync reported "no GitHub repo
//     attached" and the fleet sync silently found zero clones.
//  2. `return { ok: result.ok, ...result }` — the spread re-applied `ok` from
//     the payload, so the fleet variant's boolean was overwritten by a
//     *count*. Zero clones, or every clone failing, both produced `ok: 0`,
//     which the card read as a falsy failure with no message.
//  3. `recordSync` wrote through the request-scoped (authenticated) client,
//     but `github_secret_syncs` only grants SELECT to `authenticated`. Every
//     insert was denied, and the discarded error meant the history panel was
//     permanently empty.
//
// Supabase errors are now surfaced rather than dropped, history is written
// with the service-role client, and every handler returns one explicit shape.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
  if (error) throw new Error(`Could not verify admin role: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin only");
}

/** Human-readable one-liner for a completed single-repo sync. */
function summarize(
  target: string,
  result: {
    ok: boolean;
    written: string[];
    removed?: string[];
    failed: any[];
    nothingConfigured: boolean;
  },
): string {
  const removed = result.removed?.length ?? 0;
  const removedNote = removed ? ` Removed ${removed} secret(s) no longer used.` : "";
  if (result.nothingConfigured && result.written.length === 0) {
    if (result.failed.length) {
      return `Could not update ${target}. ${result.failed[0]?.error ?? ""}`.trim();
    }
    return removed
      ? `Removed ${removed} Codex secret(s) from ${target}; it needs none.`
      : `No secrets are configured in Mission Control, so nothing was pushed to ${target}.`;
  }
  if (result.ok) {
    return `Wrote ${result.written.length} secret(s) to ${target}.${removedNote}`;
  }
  if (result.written.length === 0) {
    return `Could not write any secret to ${target}. ${result.failed[0]?.error ?? ""}`.trim();
  }
  return `Wrote ${result.written.length} secret(s) to ${target}; ${result.failed.length} failed.${removedNote}`;
}

/**
 * Push Codex Actions secrets to the Prime repo. Admin only.
 *
 * The same sync the nightly run and `/hooks/codex-repo-secrets` perform
 * (`codex-repo-secrets.server.ts`), recorded as this person's.
 */
export const syncPrimeActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { syncPrimeCodexSecrets } = await import("@/server/codex-repo-secrets.server");
    const sync = await syncPrimeCodexSecrets({ triggerSource: "manual", triggeredBy: userId });
    if (!("result" in sync)) return { ok: false, error: sync.error };
    const { target, result, historyError } = sync;

    // `ok` is assigned last, deliberately: spreading `result` after it is
    // what previously clobbered this field.
    return {
      target,
      written: result.written,
      skipped: result.skipped,
      failed: result.failed,
      nothingConfigured: result.nothingConfigured,
      message: summarize(target, result),
      historyError,
      ok: result.ok,
      error: result.ok ? undefined : summarize(target, result),
    };
  });

const CloneInput = z.object({ cloneId: z.string().uuid() });

/** What a clean-up of one clone's repository says it did. */
function cloneMessage(r: { ok: boolean; target: string; removed: string[]; error?: string }) {
  if (!r.ok) return `Could not update ${r.target}. ${r.error ?? ""}`.trim();
  return r.removed.length > 0
    ? `Removed ${r.removed.length} Codex secret(s) from ${r.target}; it needs none.`
    : `${r.target} holds no Codex secrets; there was nothing to remove.`;
}

/**
 * Take the Codex Actions secrets out of one clone's repo. Admin only. Clones
 * no longer run the Codex workflows, and nothing else reads these names.
 */
export const syncCloneActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => CloneInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { removeCodexSecretsFromClones } = await import("@/server/codex-repo-secrets.server");
    const pass = await removeCodexSecretsFromClones({
      cloneIds: [data.cloneId],
      triggerSource: "manual",
      triggeredBy: userId,
      recordClean: true,
    });
    if (pass.error) return { ok: false, error: pass.error };
    if (pass.skippedPrime.length > 0) {
      return {
        ok: false,
        error: "This clone's repository is Prime's own, which keeps its Codex secrets.",
      };
    }
    const r = pass.results[0];
    if (!r) return { ok: false, error: "Clone has no GitHub repo attached" };

    return {
      target: r.target,
      written: [],
      removed: r.removed,
      skipped: [],
      failed: r.failed,
      // Nothing is ever written to a clone, so "nothing configured" would
      // turn a failure here into the card's warning about Prime's keys.
      nothingConfigured: false,
      message: cloneMessage(r),
      historyError: r.historyError,
      ok: r.ok,
      error: r.ok ? undefined : cloneMessage(r),
    };
  });

/** The same, for every clone that has a GitHub repo. Admin only. */
export const syncAllCloneActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { removeCodexSecretsFromClones } = await import("@/server/codex-repo-secrets.server");
    const pass = await removeCodexSecretsFromClones({
      triggerSource: "fleet-rotation",
      triggeredBy: userId,
      recordClean: true,
    });
    if (pass.error) return { ok: false, error: pass.error, results: [] };
    if (pass.results.length === 0) {
      // An empty fleet is a valid state, not a failure — the previous code
      // returned ok: 0 here and the card rendered it as "Sync failed".
      return {
        ok: true,
        attempted: 0,
        succeeded: 0,
        failedCount: 0,
        results: [],
        message: "No clones with a GitHub repo attached — nothing to sync.",
      };
    }

    const results = pass.results.map((r) => ({
      cloneId: r.cloneId,
      name: r.name,
      target: r.target,
      ok: r.ok,
      // The count the card shows beside each repo: what was actually removed.
      written: r.removed.length,
      error: r.error,
    }));
    const succeeded = results.filter((r) => r.ok).length;
    const failedCount = results.length - succeeded;
    const removed = results.reduce((n, r) => n + r.written, 0);

    return {
      attempted: results.length,
      succeeded,
      failedCount,
      results,
      message:
        failedCount > 0
          ? `Cleaned ${succeeded}/${results.length} clone repo(s); ${failedCount} failed.`
          : removed > 0
            ? `Removed ${removed} Codex secret(s) across ${succeeded} clone repo(s); none holds any now.`
            : `None of the ${succeeded} clone repo(s) holds a Codex secret.`,
      ok: failedCount === 0,
      error: failedCount === 0 ? undefined : `${failedCount} clone repo(s) failed — see below.`,
    };
  });

/**
 * Which secrets a sync would push, and which are missing. Names and
 * configured/not only — values never leave the server.
 */
export const previewActionsSecrets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { previewCodexRepoSecrets } = await import("@/server/github-secrets.server");
    return previewCodexRepoSecrets();
  });

const ListInput = z.object({
  cloneId: z.string().uuid().optional(),
  targetKind: z.enum(["prime", "clone"]).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const listGithubSecretSyncs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("github_secret_syncs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    if (data.targetKind) q = q.eq("target_kind", data.targetKind);
    const { data: rows, error } = await q;
    if (error) throw error;
    return { ok: true, rows: rows ?? [] };
  });
