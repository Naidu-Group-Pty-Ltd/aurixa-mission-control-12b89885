import { getAppOctokit } from "./github-app.server";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

// Lightweight drift refresh — computes real commits_behind for each clone
// using GitHub's compareCommitsWithBasehead. Server-only.

type SyncStatus = Database["public"]["Enums"]["sync_status"];
type SupabaseLike = SupabaseClient<Database>;

export type DriftRefreshResult = {
  ok: boolean;
  scanned: number;
  updated: number;
  error?: string;
  per_clone: Array<{
    id: string;
    name: string;
    commits_behind: number;
    sync_status: SyncStatus;
    error?: string;
  }>;
};

/**
 * Pure drift-refresh logic. Accepts any Supabase client (user-scoped or admin)
 * so it can be invoked from a server function (with RLS as the operator) OR
 * from a cron-triggered hook (with the service role key).
 */
export async function runDriftRefresh(supabase: SupabaseLike): Promise<DriftRefreshResult> {
  let octokit;
  try {
    octokit = getAppOctokit();
  } catch (e) {
    return {
      ok: false,
      scanned: 0,
      updated: 0,
      error: e instanceof Error ? e.message : "GitHub App not configured",
      per_clone: [],
    };
  }

  const [primeRes, clonesRes] = await Promise.all([
    supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    supabase.from("clones").select("*"),
  ]);
  const prime = primeRes.data;
  if (!prime) {
    return {
      ok: false,
      scanned: 0,
      updated: 0,
      error: "Prime not configured",
      per_clone: [],
    };
  }
  const clones = clonesRes.data ?? [];
  if (clones.length === 0) {
    return { ok: true, scanned: 0, updated: 0, per_clone: [] };
  }

  let primeSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: prime.github_owner,
      repo: prime.github_repo,
      branch: prime.default_branch || "main",
    });
    primeSha = br.commit.sha;
  } catch (e) {
    return {
      ok: false,
      scanned: 0,
      updated: 0,
      error: `Cannot read prime: ${e instanceof Error ? e.message : "unknown"}`,
      per_clone: [],
    };
  }

  let updated = 0;
  const per_clone: DriftRefreshResult["per_clone"] = [];

  // Concurrency cap: at most 6 GitHub API calls in flight. Prevents
  // exhausting the per-installation rate limit on large fleets and avoids
  // saturating the Worker's outbound connection budget.
  const CONCURRENCY = 6;
  const queue = [...clones];

  const processOne = async (c: (typeof clones)[number]) => {
    try {
      // `last_synced_sha` is a PRIME revision — the commit of the prime that
      // this clone's content was last brought up to. That is what makes the
      // comparison below legal at all: it is asked of the PRIME repository,
      // so a base it cannot resolve is not a comparison, it is a 404.
      //
      // This used to fall back to the CLONE's own HEAD when no baseline was
      // recorded. A clone repository is created from a template rather than
      // forked, so its history is its own: the prime does not contain a single
      // one of its commits. `preflight-property-group@main` was `8fefecf` and
      // the prime answered `No commit found for SHA` — every hour, for every
      // clone that had never merged a cascade. The throw landed in the catch
      // below, which wrote `failed`, and `failed` is the one reading nothing
      // here can lift. Two clones sat in it for a week looking like a broken
      // cascade while the cascade was opening their pull requests on schedule.
      //
      // There is no substitute for a baseline, so none is invented. A clone
      // with none has an UNKNOWN distance from the prime — which is a fact
      // about our record, not a fault in the clone — and the first cascade to
      // merge writes the real one.
      const baseSha = c.last_synced_sha;
      if (!baseSha) {
        const moved = c.sync_status !== "unknown" || !c.last_drift_check_at;
        const { error: unknownErr } = await supabase
          .from("clones")
          .update({
            sync_status: "unknown",
            last_drift_check_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        // A write that failed is not a reading that was taken. Reported on the
        // row rather than swallowed, so a database fault cannot look like a
        // clone that was measured and found unmeasurable.
        if (unknownErr) throw new Error(unknownErr.message);
        if (moved) updated++;
        per_clone.push({
          id: c.id,
          name: c.name,
          commits_behind: c.commits_behind,
          sync_status: "unknown",
          error: "no recorded prime revision — drift cannot be measured until a cascade merges",
        });
        return;
      }

      const { data: cmp } = await octokit.repos.compareCommitsWithBasehead({
        owner: prime.github_owner,
        repo: prime.github_repo,
        basehead: `${baseSha}...${primeSha}`,
      });
      const behind = cmp.ahead_by ?? 0;

      let status: SyncStatus;
      if (c.sync_status === "failed") status = "failed";
      else if (c.sync_status === "cascading") status = "cascading";
      else if (behind === 0) status = "in_sync";
      else status = "behind";

      if (behind !== c.commits_behind || status !== c.sync_status || !c.last_drift_check_at) {
        await supabase
          .from("clones")
          .update({
            commits_behind: behind,
            sync_status: status,
            last_drift_check_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        updated++;
      } else {
        await supabase
          .from("clones")
          .update({ last_drift_check_at: new Date().toISOString() })
          .eq("id", c.id);
      }

      per_clone.push({
        id: c.id,
        name: c.name,
        commits_behind: behind,
        sync_status: status,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unreachable";
      // A measurement that failed is not a clone that failed. This wrote
      // `failed` for anything the comparison threw — a rate limit, a network
      // blip, a base the prime could not resolve — and `failed` is the one
      // reading this sweep will never lift, so a transient fault became a
      // permanent verdict on the clone page.
      //
      // `unknown` says what is true: we could not measure it this pass. It is
      // replaced by the next pass that can. A `failed` the CASCADE recorded is
      // left exactly where it is, because that one is a real outcome and only
      // a cascade may clear it.
      const status: SyncStatus = c.sync_status === "failed" ? "failed" : "unknown";
      await supabase
        .from("clones")
        .update({
          sync_status: status,
          last_drift_check_at: new Date().toISOString(),
        })
        .eq("id", c.id);
      per_clone.push({
        id: c.id,
        name: c.name,
        commits_behind: c.commits_behind,
        sync_status: status,
        error: msg,
      });
      updated++;
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const c = queue.shift();
      if (c) await processOne(c);
    }
  });
  await Promise.all(workers);

  return {
    ok: true,
    scanned: clones.length,
    updated,
    per_clone,
  };
}
