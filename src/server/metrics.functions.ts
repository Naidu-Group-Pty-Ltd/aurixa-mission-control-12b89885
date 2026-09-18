import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getFleetMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    // The sixth query used to be 500 rows of `clone_health_snapshots`,
    // destructured and then never read by anything below. A history-shaped
    // read against a table that holds one row per clone, paid for on every
    // dashboard load and consumed by nobody — the shape of the mistake this
    // whole area is being repaired for. The series lives in
    // `clone_health_daily` now, and the SLO page is what reads it.
    const [clones, cascades, drift, ai, push] = await Promise.all([
      supabase.from("clones").select("id, sync_status, commits_behind, cloudflare_enabled"),
      supabase
        .from("cascade_events")
        .select("id, status, mode, created_at")
        .gte("created_at", since30),
      supabase
        .from("module_drift_alerts")
        .select("id, severity, created_at")
        .gte("created_at", since30),
      supabase
        .from("ai_usage_log")
        .select("feature, total_tokens, created_at")
        .gte("created_at", since30),
      supabase.from("push_delivery_log").select("success, created_at").gte("created_at", since30),
    ]);

    const cs = cascades.data ?? [];
    const total = cs.length;
    const succeeded = cs.filter((c: any) => c.status === "succeeded").length;
    const failed = cs.filter((c: any) => c.status === "failed").length;

    const byDay = (rows: any[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) {
        const d = (r.created_at ?? r.probed_at ?? "").slice(0, 10);
        if (!d) continue;
        m[d] = (m[d] ?? 0) + 1;
      }
      return Object.entries(m)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));
    };

    const tokens = (ai.data ?? []).reduce((s: number, r: any) => s + (r.total_tokens ?? 0), 0);
    const pushTotal = push.data?.length ?? 0;
    const pushOk = (push.data ?? []).filter((p: any) => p.success).length;

    return {
      summary: {
        clones_total: clones.data?.length ?? 0,
        clones_drifted: (clones.data ?? []).filter((c: any) => (c.commits_behind ?? 0) > 0).length,
        clones_cf: (clones.data ?? []).filter((c: any) => c.cloudflare_enabled).length,
        cascades_30d: total,
        cascade_success_rate: total ? succeeded / total : 0,
        cascades_failed: failed,
        drift_alerts_30d: drift.data?.length ?? 0,
        ai_tokens_30d: tokens,
        push_success_rate: pushTotal ? pushOk / pushTotal : null,
        push_total_30d: pushTotal,
      },
      cascades_by_day: byDay(cs),
      drift_by_day: byDay(drift.data ?? []),
      ai_by_day: byDay(ai.data ?? []),
    };
  });

/**
 * One clone's uptime series, by day.
 *
 * THIS ENDPOINT HAD ZERO CALL SITES, and it could not have been useful if it
 * had one: it read `clone_health_snapshots` sixty rows deep, and that table is
 * UNIQUE on `clone_id`, so the deepest answer it could ever give was one row.
 * A history endpoint over a table with no history.
 *
 * It has a caller now — `CloneHealthTimeline`, which used to query that same
 * cache DIRECTLY FROM THE BROWSER and return `null` when the result was empty.
 * Three different states drew identically there: a clone with no probes, a
 * clone whose read RLS had filtered (which returns `[]` with HTTP 200, the
 * trap three surfaces in this fleet have now hit), and a clone the card was
 * never meant to draw for. Reading through the server is what keeps them
 * apart.
 *
 * `windowDays` is honoured rather than decorative, because there is now a
 * series behind it.
 */
export const getCloneHealthHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string; windowDays?: number }) =>
    z
      .object({
        cloneId: z.string().uuid(),
        windowDays: z.number().int().min(1).max(90).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { daySeriesFor, averageOf } = await import("@/server/health/uptimeSlo.pure");
    const days = data.windowDays ?? 30;
    const sinceDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const { data: rows, error } = await context.supabase
      .from("clone_health_daily")
      .select("clone_id, day, up, down, unmeasured, first_probed_at, last_probed_at, last_status")
      .eq("clone_id", data.cloneId)
      .gte("day", sinceDay);

    // A read that failed is not a clone with no history. Whatever draws this
    // has to be able to tell them apart, so they are different answers.
    if (error) return { ok: false as const, error: error.message, windowDays: days };

    const series = daySeriesFor(
      (rows ?? []).map((r) => ({
        cloneId: String(r.clone_id),
        day: String(r.day),
        up: r.up ?? 0,
        down: r.down ?? 0,
        unmeasured: r.unmeasured ?? 0,
        firstProbedAt: String(r.first_probed_at),
        lastProbedAt: String(r.last_probed_at),
        lastStatus: (r.last_status ?? "unknown") as "up" | "down" | "unknown",
      })),
    );

    return { ok: true as const, windowDays: days, series, average: averageOf(series) };
  });
