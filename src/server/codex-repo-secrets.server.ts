/**
 * The Actions secrets the Codex workflows read, kept where they belong:
 * Prime's repository holds the model keys, and no clone's holds any.
 *
 * Clones are neither scanned nor fixed (src/lib/codex-scan-policy.ts), so
 * Prime alone runs `codex-security-scan.yml` and `codex-remediation.yml`.
 * Until 19 Oct 2026 keeping it that way was two buttons in Settings and
 * nothing else, and neither had been pressed in months: Prime's last sync was
 * on 27 Jul, to the repository's previous owner, so the Anthropic key set in
 * Mission Control since had never reached it; and four clones still held
 * OpenAI's key and both callback-signing masters, written into them when they
 * were provisioned.
 *
 * So the same two steps now run from four places, all through this module:
 *
 * - the two Settings buttons, as before (`github-secrets.functions.ts`);
 * - `/hooks/codex-repo-secrets`, so Mission Control can be asked to do it with
 *   no person's session;
 * - the nightly run, before Prime's scan, so a key rotated in Mission Control
 *   reaches Prime by the next scan and a clone that gained a Codex secret
 *   loses it within a day;
 * - clone provisioning, so a new clone is checked the day it exists.
 *
 * Nothing here reads a secret's value back, and nothing returns one: GitHub
 * never discloses a secret, and every answer below carries names only.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapWithConcurrency } from "@/lib/concurrency";
import { loadCloneInstallationIds } from "@/server/clone-installation.server";
import {
  buildCodexRepoSecrets,
  CLONE_CODEX_REPO_SECRETS,
  listRepoSecretNames,
  RETIRED_CODEX_REPO_SECRETS,
  syncRepoSecrets,
  type SyncSecretsResult,
} from "@/server/github-secrets.server";

/** Parallel repos per fleet pass. Each is one read, and a delete per secret it holds. */
const FLEET_CONCURRENCY = 4;

/**
 * What started a sync, as `github_secret_syncs.trigger_source` records it.
 * `manual` and `fleet-rotation` are the Settings buttons' existing words.
 */
export type SecretSyncTrigger =
  | "manual"
  | "fleet-rotation"
  | "mission-control"
  | "nightly"
  | "provisioning";

/**
 * Append a sync-history row. Uses the service-role client because the table
 * is deliberately service-role-write only; a failure here is logged but must
 * never mask the outcome of the sync itself.
 */
export async function recordSecretSync(row: {
  target_kind: "prime" | "clone";
  clone_id: string | null;
  owner: string;
  repo: string;
  result: Pick<SyncSecretsResult, "ok" | "written" | "removed" | "skipped" | "failed">;
  trigger_source: SecretSyncTrigger;
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
        ...row.result.removed.map((name) => ({
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

export type PrimeSecretSync =
  | { ok: false; target: string | null; error: string }
  | {
      ok: boolean;
      target: string;
      result: SyncSecretsResult;
      historyError: string | null;
    };

/**
 * Write Mission Control's current Codex keys into Prime's Actions secrets,
 * and delete any copy of a callback-signing master an earlier version left
 * there. Writing a secret that has not changed is harmless, and it is how a
 * key rotated in Mission Control reaches Prime: GitHub never shows a secret's
 * value, so there is nothing to compare against.
 */
export async function syncPrimeCodexSecrets(opts: {
  triggerSource: SecretSyncTrigger;
  triggeredBy?: string | null;
}): Promise<PrimeSecretSync> {
  const { data: prime, error } = await supabaseAdmin
    .from("prime_config")
    .select("github_owner, github_repo, github_app_installation_id")
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ok: false, target: null, error: `Could not read prime_config: ${error.message}` };
  }
  if (!prime?.github_owner || !prime?.github_repo) {
    return {
      ok: false,
      target: null,
      error: "Prime repo is not configured — set the GitHub owner and repo above first.",
    };
  }
  const result = await syncRepoSecrets({
    owner: prime.github_owner,
    repo: prime.github_repo,
    installationId: prime.github_app_installation_id ?? null,
    secrets: await buildCodexRepoSecrets(),
    remove: RETIRED_CODEX_REPO_SECRETS,
  });
  const historyError = await recordSecretSync({
    target_kind: "prime",
    clone_id: null,
    owner: prime.github_owner,
    repo: prime.github_repo,
    result,
    trigger_source: opts.triggerSource,
    triggered_by: opts.triggeredBy ?? null,
  });
  return {
    ok: result.ok,
    target: `${prime.github_owner}/${prime.github_repo}`,
    result,
    historyError,
  };
}

export type CloneSecretCleanup = {
  cloneId: string;
  name: string;
  target: string;
  ok: boolean;
  /** Codex secrets that were in the repository and are not any more. */
  removed: string[];
  failed: { name: string; error: string }[];
  /** The first failure, for a one-line summary. */
  error?: string;
  historyError: string | null;
};

export type FleetSecretCleanup = {
  /** False when the clones could not be listed, or any clone failed. */
  ok: boolean;
  error: string | null;
  results: CloneSecretCleanup[];
  /** Clones whose repository is Prime's own, which this never cleans. */
  skippedPrime: string[];
};

/**
 * Delete every Codex secret from each clone's repository: all clones with a
 * repository, or the ones named.
 *
 * It asks each repository what it holds and deletes only those, so `removed`
 * means removed, and a clean clone costs one read rather than a delete per
 * name. Where the list cannot be read, or fills a whole page, it deletes every
 * name blind, as the buttons always did; a name already gone is not an error.
 *
 * Nothing is ever written to a clone. A clone row naming Prime's repository is
 * skipped rather than cleaned, because cleaning it would delete the keys the
 * Prime sync writes.
 *
 * `recordClean` decides whether a clone that held nothing gets a history row:
 * yes when a person or the on-demand hook asked, so each check is on the
 * record; no on the nightly pass, which would otherwise add a row per clone
 * per night saying nothing happened.
 */
export async function removeCodexSecretsFromClones(opts: {
  triggerSource: SecretSyncTrigger;
  triggeredBy?: string | null;
  cloneIds?: string[];
  recordClean: boolean;
}): Promise<FleetSecretCleanup> {
  let query = supabaseAdmin
    .from("clones")
    .select("id, name, github_owner, github_repo")
    .order("name", { ascending: true });
  if (opts.cloneIds) query = query.in("id", opts.cloneIds);
  const { data: clones, error } = await query;
  if (error) {
    return {
      ok: false,
      error: `Could not list clones: ${error.message}`,
      results: [],
      skippedPrime: [],
    };
  }

  const { data: prime } = await supabaseAdmin
    .from("prime_config")
    .select("github_owner, github_repo")
    .limit(1)
    .maybeSingle();
  const primeRepo =
    prime?.github_owner && prime?.github_repo
      ? `${prime.github_owner}/${prime.github_repo}`.toLowerCase()
      : null;

  const withRepo = (clones ?? []).filter((c) => c.github_owner && c.github_repo);
  const isPrime = (c: (typeof withRepo)[number]) =>
    `${c.github_owner}/${c.github_repo}`.toLowerCase() === primeRepo;
  const targets = withRepo.filter((c) => !isPrime(c));
  const installations = await loadCloneInstallationIds(
    supabaseAdmin,
    targets.map((c) => c.id),
  );

  const results = await mapWithConcurrency(targets, FLEET_CONCURRENCY, async (c) => {
    const owner = c.github_owner as string;
    const repo = c.github_repo as string;
    const target = `${owner}/${repo}`;
    const installationId = installations.get(c.id) ?? null;
    try {
      const held = await listRepoSecretNames({ owner, repo, installationId });
      const remove =
        held === null || held.length >= 100
          ? [...CLONE_CODEX_REPO_SECRETS]
          : CLONE_CODEX_REPO_SECRETS.filter((name) => held.includes(name));
      const result: SyncSecretsResult =
        remove.length === 0
          ? { ok: true, written: [], removed: [], skipped: [], failed: [], nothingConfigured: true }
          : await syncRepoSecrets({ owner, repo, installationId, secrets: {}, remove });
      const historyError =
        opts.recordClean || remove.length > 0 || !result.ok
          ? await recordSecretSync({
              target_kind: "clone",
              clone_id: c.id,
              owner,
              repo,
              result,
              trigger_source: opts.triggerSource,
              triggered_by: opts.triggeredBy ?? null,
            })
          : null;
      return {
        cloneId: c.id,
        name: c.name,
        target,
        ok: result.ok,
        removed: result.removed,
        failed: result.failed,
        error: result.ok ? undefined : (result.failed[0]?.error ?? "unknown error"),
        historyError,
      };
    } catch (e) {
      // One unreachable repo must not abort the rest of the fleet.
      const error = e instanceof Error ? e.message : String(e);
      return {
        cloneId: c.id,
        name: c.name,
        target,
        ok: false,
        removed: [],
        failed: [{ name: "*", error }],
        error,
        historyError: null,
      };
    }
  });

  return {
    ok: results.every((r) => r.ok),
    error: null,
    results,
    skippedPrime: withRepo.filter(isPrime).map((c) => c.name),
  };
}

export type CodexSecretsReconcile = {
  ok: boolean;
  prime: PrimeSecretSync;
  clones: FleetSecretCleanup;
};

/** Both halves, Prime first: the nightly run and `/hooks/codex-repo-secrets`. */
export async function reconcileCodexRepoSecrets(opts: {
  triggerSource: "mission-control" | "nightly";
  recordClean: boolean;
}): Promise<CodexSecretsReconcile> {
  const prime = await syncPrimeCodexSecrets({ triggerSource: opts.triggerSource });
  const clones = await removeCodexSecretsFromClones({
    triggerSource: opts.triggerSource,
    recordClean: opts.recordClean,
  });
  return { ok: prime.ok && clones.ok, prime, clones };
}
