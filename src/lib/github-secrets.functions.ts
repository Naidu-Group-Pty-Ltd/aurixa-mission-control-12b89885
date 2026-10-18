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
import { mapWithConcurrency } from "@/lib/concurrency";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

/** Parallel repos per fleet sync. Each repo is 2 GitHub calls per secret. */
const FLEET_CONCURRENCY = 4;

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_admin", { _user_id: userId });
  if (error) throw new Error(`Could not verify admin role: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin only");
}

/**
 * Append a sync-history row. Uses the service-role client because the table
 * is deliberately service-role-write only; a failure here is logged but must
 * never mask the outcome of the sync itself.
 */
async function recordSync(row: {
  target_kind: "prime" | "clone";
  clone_id: string | null;
  owner: string;
  repo: string;
  result: { ok: boolean; written: string[]; removed?: string[]; skipped: any[]; failed: any[] };
  trigger_source: string;
  triggered_by: string | null;
}): Promise<string | null> {
  try {
    const { error } = await supabaseAdmin.from("github_secret_syncs").insert({
      target_kind: row.target_kind,
      clone_id: row.clone_id,
      owner: row.owner,
      repo: row.repo,
      written: row.result.written,
      // The history table has no column for deletions; they are listed with
      // the names this sync did not write, and say why.
      skipped: [
        ...row.result.skipped,
        ...(row.result.removed ?? []).map((name) => ({
          name,
          reason: "removed from the repository (no longer used)",
        })),
      ],
      failed: row.result.failed,
      ok: row.result.ok,
      trigger_source: row.trigger_source,
      triggered_by: row.triggered_by,
    });
    if (error) {
      console.error("[github-secrets] failed to record sync history:", error.message);
      return error.message;
    }
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[github-secrets] failed to record sync history:", message);
    return message;
  }
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

/** Push Codex Actions secrets to the Prime repo. Admin only. */
export const syncPrimeActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: prime, error: primeErr } = await supabase
      .from("prime_config")
      .select("github_owner, github_repo, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    if (primeErr) {
      return { ok: false, error: `Could not read prime_config: ${primeErr.message}` };
    }
    if (!prime?.github_owner || !prime?.github_repo) {
      return {
        ok: false,
        error: "Prime repo is not configured — set the GitHub owner and repo above first.",
      };
    }

    const { syncRepoSecrets, buildCodexRepoSecrets, RETIRED_CODEX_REPO_SECRETS } =
      await import("@/server/github-secrets.server");
    const target = `${prime.github_owner}/${prime.github_repo}`;
    const result = await syncRepoSecrets({
      owner: prime.github_owner,
      repo: prime.github_repo,
      installationId: prime.github_app_installation_id ?? null,
      secrets: await buildCodexRepoSecrets(),
      remove: RETIRED_CODEX_REPO_SECRETS,
    });

    const historyError = await recordSync({
      target_kind: "prime",
      clone_id: null,
      owner: prime.github_owner,
      repo: prime.github_repo,
      result,
      trigger_source: "manual",
      triggered_by: userId,
    });

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

    const { data: clone, error: cloneErr } = await supabase
      .from("clones")
      .select("id, name, github_owner, github_repo")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (cloneErr) {
      return { ok: false, error: `Could not read clone: ${cloneErr.message}` };
    }
    if (!clone?.github_owner || !clone?.github_repo) {
      return { ok: false, error: "Clone has no GitHub repo attached" };
    }

    const { syncRepoSecrets, CLONE_CODEX_REPO_SECRETS } =
      await import("@/server/github-secrets.server");
    const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
    const target = `${clone.github_owner}/${clone.github_repo}`;
    const result = await syncRepoSecrets({
      owner: clone.github_owner,
      repo: clone.github_repo,
      installationId: await loadCloneInstallationId(supabase, clone.id),
      secrets: {},
      remove: CLONE_CODEX_REPO_SECRETS,
    });

    const historyError = await recordSync({
      target_kind: "clone",
      clone_id: clone.id,
      owner: clone.github_owner,
      repo: clone.github_repo,
      result,
      trigger_source: "manual",
      triggered_by: userId,
    });

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

/** The same, for every clone that has a GitHub repo. Admin only. */
export const syncAllCloneActionsSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    const { data: clones, error: clonesErr } = await supabase
      .from("clones")
      .select("id, name, github_owner, github_repo")
      .order("name", { ascending: true });
    if (clonesErr) {
      return { ok: false, error: `Could not list clones: ${clonesErr.message}`, results: [] };
    }

    const targets = (clones ?? []).filter((c: any) => c.github_owner && c.github_repo);
    if (targets.length === 0) {
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

    const { syncRepoSecrets, CLONE_CODEX_REPO_SECRETS } =
      await import("@/server/github-secrets.server");
    const { loadCloneInstallationIds } = await import("@/server/clone-installation.server");
    const installations = await loadCloneInstallationIds(
      supabase,
      targets.map((c: any) => c.id),
    );

    // Serial fan-out used to make a large fleet exceed the request timeout
    // well before it finished.
    const results = await mapWithConcurrency(targets, FLEET_CONCURRENCY, async (c: any) => {
      const target = `${c.github_owner}/${c.github_repo}`;
      try {
        const result = await syncRepoSecrets({
          owner: c.github_owner,
          repo: c.github_repo,
          installationId: installations.get(c.id) ?? null,
          secrets: {},
          remove: CLONE_CODEX_REPO_SECRETS,
        });
        await recordSync({
          target_kind: "clone",
          clone_id: c.id,
          owner: c.github_owner,
          repo: c.github_repo,
          result,
          trigger_source: "fleet-rotation",
          triggered_by: userId,
        });
        return {
          cloneId: c.id,
          name: c.name,
          target,
          ok: result.ok,
          written: result.removed.length,
          error: result.ok ? undefined : (result.failed[0]?.error ?? "unknown error"),
        };
      } catch (e) {
        // One unreachable repo must not abort the rest of the fleet.
        return {
          cloneId: c.id,
          name: c.name,
          target,
          ok: false,
          written: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });

    const succeeded = results.filter((r) => r.ok).length;
    const failedCount = results.length - succeeded;

    return {
      attempted: results.length,
      succeeded,
      failedCount,
      results,
      message:
        failedCount === 0
          ? `Removed the Codex secrets from all ${succeeded} clone repo(s).`
          : `Cleaned ${succeeded}/${results.length} clone repo(s); ${failedCount} failed.`,
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
