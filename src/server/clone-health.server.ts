// Per-clone health snapshot: deploy uptime ping, last successful cascade,
// and AI-summarized recent activity over the last 7 days.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type SupabaseLike = SupabaseClient<Database>;

// 5-minute TTL — fresh enough that operators see meaningful changes,
// stale enough to make /health load instantly after the first probe.
export const HEALTH_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export async function readCachedCloneHealth(
  supabase: SupabaseLike,
  cloneId: string,
): Promise<{ payload: CloneHealth; probedAt: string } | null> {
  const { data } = await supabase
    .from("clone_health_snapshots")
    .select("payload, probed_at")
    .eq("clone_id", cloneId)
    .maybeSingle();
  const row = data as unknown as { payload: CloneHealth; probed_at: string } | null;
  if (!row) return null;
  const age = Date.now() - new Date(row.probed_at).getTime();
  if (age > HEALTH_SNAPSHOT_TTL_MS) return null;
  return { payload: row.payload, probedAt: row.probed_at };
}

async function writeSnapshot(
  supabase: SupabaseLike,
  cloneId: string,
  payload: CloneHealth,
  probedAt: string,
): Promise<void> {
  const { error } = await supabase.from("clone_health_snapshots").upsert(
    {
      clone_id: cloneId,
      payload: payload as unknown as Json,
      probed_at: probedAt,
      updated_at: probedAt,
    },
    { onConflict: "clone_id" },
  );
  // Best-effort is not silent. A cache that has been failing to write for a
  // month serves a stale reading and says nothing, which is the whole class of
  // defect this area is being repaired for.
  if (error) console.warn("[clone-health] snapshot write failed:", error.message);
}

/**
 * The same probe, appended to the series — but only from the scheduled pass.
 *
 * THIS IS THE ONLY MODULE THAT KNOWS THE PAYLOAD'S SHAPE, and that is the
 * point. Every reader of uptime used to reach into the blob for
 * `payload.status ?? payload.health` — keys `CloneHealth` has never carried,
 * because the status is nested under `uptime` — so the SLO page rendered
 * 0.00% across a fleet that was up on HTTP 200 in under 50 ms. Extracting the
 * three facts here means nothing downstream can misread a shape it never sees.
 *
 * AN UPTIME SLO IS ONLY MEANINGFUL OVER A REGULAR CADENCE. Three of this
 * function's callers probe on demand: the clone health card's Refresh, the
 * `/health` dashboard, and a forced fleet walk. Those are real probes, and
 * they are taken at moments a PERSON chose — which in practice means when
 * somebody already suspected a problem. Folding them into the series would
 * make "99.9% over thirty days" depend on how worried people were that month,
 * and there is no way to read such a number back out afterwards.
 *
 * So `recordSample` defaults to FALSE and exactly one caller passes it: the
 * five-minute cron. That is also why `clone_health_history` carries no INSERT
 * policy — the only writer is the service role, which makes the cadence an
 * access control rather than a convention.
 *
 * Best-effort, like the cache and separately from it: a probe cannot land in
 * one and not the other by accident, and a failure in one must not lose the
 * other. A missing sample is a gap in a series rather than a wrong reading
 * in it.
 */
async function writeHistory(
  supabase: SupabaseLike,
  cloneId: string,
  payload: CloneHealth,
  probedAt: string,
): Promise<void> {
  const { error } = await supabase.from("clone_health_history").insert({
    clone_id: cloneId,
    probed_at: probedAt,
    status: payload.uptime.status,
    http_status: payload.uptime.httpStatus,
    latency_ms: payload.uptime.latencyMs,
  });
  // Likewise. Every history write failing would leave the SLO page empty with
  // nothing anywhere saying why — an empty series and a series nobody could
  // write are the two states this whole change exists to keep apart.
  if (error) console.warn("[clone-health] history write failed:", error.message);
}

export type CloneHealth = {
  cloneId: string;
  deployUrl: string | null;
  uptime: {
    status: "up" | "down" | "unknown";
    httpStatus: number | null;
    latencyMs: number | null;
  };
  lastSuccessfulCascadeAt: string | null;
  lastFailedCascadeAt: string | null;
  cascadeCount7d: number;
  failureCount7d: number;
  driftSuggestionsOpen: number;
  aiSummary: string | null;
};

const FETCH_TIMEOUT_MS = 4000;

async function pingDeploy(url: string): Promise<{
  status: "up" | "down" | "unknown";
  httpStatus: number | null;
  latencyMs: number | null;
}> {
  try {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
    clearTimeout(timer);
    const latency = Date.now() - t0;
    return {
      status: res.ok || res.status === 405 ? "up" : "down",
      httpStatus: res.status,
      latencyMs: latency,
    };
  } catch {
    return { status: "down", httpStatus: null, latencyMs: null };
  }
}

export async function getCloneHealth(
  supabase: SupabaseLike,
  cloneId: string,
  opts: {
    skipCache?: boolean;
    /**
     * Append this probe to the uptime series.
     *
     * Default false. Only the five-minute scheduled pass sets it — see
     * `writeHistory` for why an on-demand probe must not join the series.
     */
    recordSample?: boolean;
  } = {},
): Promise<CloneHealth> {
  if (!opts.skipCache) {
    const cached = await readCachedCloneHealth(supabase, cloneId);
    if (cached) return cached.payload;
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: clone }, { data: results }, { data: audit }] = await Promise.all([
    supabase.from("clones").select("*").eq("id", cloneId).maybeSingle(),
    supabase
      .from("cascade_results")
      .select("status, completed_at, diff_summary, error_message")
      .eq("clone_id", cloneId)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("audit_log")
      .select("action, created_at, metadata")
      .eq("entity_type", "clone")
      .eq("entity_id", cloneId)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // `deploy_url` was the only source, and until the deployment pipeline existed
  // nothing wrote it — so this ping never ran for any clone and every health
  // card in the fleet has shown `unknown` uptime since the feature shipped.
  //
  // `unknown` is still the honest answer for a clone that is not deployed, which
  // is why the fallback resolves an origin rather than constructing one: a ping
  // against a guessed hostname reports "down" for a site that was never meant to
  // exist, and a red pip is worse than a grey one.
  let uptime: CloneHealth["uptime"] = { status: "unknown", httpStatus: null, latencyMs: null };
  let deployUrl: string | null = clone?.deploy_url ?? null;
  if (!deployUrl) {
    const { data: deployment } = await supabase
      .from("clone_deployments")
      .select("domain, provider_origin, status")
      .eq("clone_id", cloneId)
      .maybeSingle();
    if (deployment) {
      const { resolveCloneOrigin } = await import("@/server/hosting/dnsTarget.pure");
      deployUrl = resolveCloneOrigin({
        domain: deployment.domain,
        providerOrigin: deployment.provider_origin,
        deploymentStatus: deployment.status,
      });
    }
  }
  if (deployUrl) {
    uptime = await pingDeploy(deployUrl);
  }

  // `succeeded` alone. A `pr_opened` result is a PROPOSAL — the change has not
  // reached the clone's default branch and nothing it carries is deployed — so
  // counting one as the last successful cascade dated this clone's health from
  // a pull request that might still be open. `cascadeMergeDrain` reconciles a
  // landed proposal to `succeeded`, so this reads true rather than optimistic.
  const succeeded = (results ?? []).filter((r) => r.status === "succeeded");
  const failed = (results ?? []).filter((r) => r.status === "failed");
  const lastSuccessfulCascadeAt = succeeded[0]?.completed_at ?? null;
  const lastFailedCascadeAt = failed[0]?.completed_at ?? null;

  const driftRaw = clone?.drift_suggestions as unknown as Array<{ status: string }> | null;
  const driftOpen = (driftRaw ?? []).filter((s) => s.status === "open").length;

  // AI-summarize recent activity. Best-effort.
  let aiSummary: string | null = null;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (apiKey && (results?.length || audit?.length)) {
    try {
      const summaryInput =
        `Clone: ${clone?.name}\n` +
        `Sync status: ${clone?.sync_status} (${clone?.commits_behind ?? 0} behind)\n` +
        `Cascades (7d): ${results?.length ?? 0} total · ${succeeded.length} ok · ${failed.length} failed\n` +
        `Open drift suggestions: ${driftOpen}\n` +
        `Recent cascade results:\n` +
        (results ?? [])
          .slice(0, 8)
          .map((r) => `- [${r.status}] ${r.diff_summary ?? r.error_message ?? "(no detail)"}`)
          .join("\n") +
        `\n\nRecent audit events:\n` +
        (audit ?? [])
          .slice(0, 8)
          .map((a) => `- ${a.action}`)
          .join("\n");
      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "system",
              content:
                "You are a senior SRE. Summarize this clone's last-week activity in 2 short sentences. Highlight risk if any. No hedging.",
            },
            { role: "user", content: summaryInput },
          ],
        }),
      });
      if (aiRes.ok) {
        const json = (await aiRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        aiSummary = json.choices?.[0]?.message?.content?.trim() ?? null;
      }
    } catch {
      // Non-fatal
    }
  }

  const result: CloneHealth = {
    cloneId,
    deployUrl,
    uptime,
    lastSuccessfulCascadeAt,
    lastFailedCascadeAt,
    cascadeCount7d: results?.length ?? 0,
    failureCount7d: failed.length,
    driftSuggestionsOpen: driftOpen,
    aiSummary,
  };

  // Best-effort, and separately so: one probe, two records, neither of which
  // may break the dashboard and neither of which may take the other down with
  // it. They share one `probed_at` so the cache and the series can never
  // disagree about when this reading was taken.
  const probedAt = new Date().toISOString();
  try {
    await writeSnapshot(supabase, cloneId, result, probedAt);
  } catch {
    // ignore
  }
  if (opts.recordSample) {
    try {
      await writeHistory(supabase, cloneId, result, probedAt);
    } catch {
      // ignore
    }
  }

  return result;
}
