// Phase 11 — Reliability server functions:
// - SLO computation from clone_health_daily (the probe series, not the cache)
// - Module library deprecation
// - Brand drift severity timeseries
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ─── SLO surface ──────────────────────────────────────────────────────

/**
 * Fleet uptime over a window the reading can actually see.
 *
 * ## What this replaces
 *
 * The previous version read `clone_health_snapshots` — a table that is UNIQUE
 * on `clone_id`, so it holds exactly one row per clone and `windowDays` could
 * not change its answer. It then resolved each clone's status as
 * `payload.status ?? payload.health`, and `CloneHealth` has carried neither
 * key since the day it was written: the status is at `payload.uptime.status`.
 *
 * Measured against production on 18 Sep 2026, all three clones were up on HTTP
 * 200 in 41-50 ms and this function returned **0.00% for every one of them and
 * for the fleet**, which the page drew in destructive red. Not "0% or 100%
 * from one probe" — it could only ever be 0%, because the expression had no
 * way to resolve anything else.
 *
 * ## What it does now
 *
 * Reads `clone_health_daily`, which aggregates the append-only probe series in
 * the database (78,000 rows over the widest window this page offers, and 1.3
 * million at fifty clones — not numbers to count in a function). The
 * arithmetic and the honesty are in `uptimeSlo.pure.ts`: `unknown` is excluded
 * from both sides of the fraction, nothing measured reads `null` rather than
 * zero, and the span the evidence actually covers travels with the answer.
 *
 * A failed read answers `ok: false` rather than an empty window. That
 * distinction is the whole substance of this programme, and this function is
 * the one that got it wrong loudest.
 */
export const computeFleetSlo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { windowDays?: number }) =>
    z.object({ windowDays: z.number().int().min(1).max(90).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { summariseUptime } = await import("@/server/health/uptimeSlo.pure");
    const days = data.windowDays ?? 30;
    const now = new Date();
    // The view buckets by UTC calendar day, so the filter is a date. The
    // reading still reports the first and last probe it actually saw, so
    // nothing a reader is told is rounded by this.
    const sinceDay = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

    const [daily, clones] = await Promise.all([
      supabase
        .from("clone_health_daily")
        .select("clone_id, day, up, down, unmeasured, first_probed_at, last_probed_at, last_status")
        .gte("day", sinceDay),
      supabase.from("clones").select("id, name, slug"),
    ]);

    if (daily.error) {
      // Never an empty window. A read that did not happen has measured
      // nothing, and rendering that as 0% uptime is the defect this function
      // is being repaired for.
      return { ok: false as const, error: daily.error.message };
    }

    const summary = summariseUptime({
      now,
      requestedWindowDays: days,
      rows: (daily.data ?? []).map((r) => ({
        cloneId: String(r.clone_id),
        day: String(r.day),
        up: r.up ?? 0,
        down: r.down ?? 0,
        unmeasured: r.unmeasured ?? 0,
        firstProbedAt: String(r.first_probed_at),
        lastProbedAt: String(r.last_probed_at),
        lastStatus: (r.last_status ?? "unknown") as "up" | "down" | "unknown",
      })),
    });

    const byClone = new Map(summary.byClone.map((c) => [c.cloneId, c]));
    // Every clone appears, including one with no probes at all: a clone that
    // vanishes from an SLO list because nothing measured it is the same
    // silence in a different place.
    const cloneSlo = (clones.data ?? []).map((c) => {
      const stat = byClone.get(c.id);
      return {
        clone_id: c.id,
        name: c.name,
        slug: c.slug,
        uptime_pct: stat?.uptimePct ?? null,
        samples: stat?.measured ?? 0,
        unmeasured: stat?.unmeasured ?? 0,
        last_status: stat?.lastStatus ?? null,
        last_probed_at: stat?.lastProbedAt ?? null,
      };
    });

    return {
      ok: true as const,
      windowDays: days,
      fleetUptime: summary.fleetUptimePct,
      samplesTotal: summary.measuredTotal,
      unmeasuredTotal: summary.unmeasuredTotal,
      observedFrom: summary.observedFrom,
      observedTo: summary.observedTo,
      observedHours: summary.observedHours,
      coversRequestedWindow: summary.coversRequestedWindow,
      clones: cloneSlo.sort((a, b) => {
        // Lowest uptime first, and a clone nothing has measured is not the
        // worst clone in the fleet — it is an absence, and it sorts after
        // every real reading rather than at the top of the list of problems.
        if (a.uptime_pct === null && b.uptime_pct === null) return a.name.localeCompare(b.name);
        if (a.uptime_pct === null) return 1;
        if (b.uptime_pct === null) return -1;
        return a.uptime_pct - b.uptime_pct;
      }),
    };
  });

// ─── Module library deprecation ───────────────────────────────────────

export const deprecateLibraryEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { entryId: string; reason: string; replacementSlug?: string }) =>
    z
      .object({
        entryId: z.string().uuid(),
        reason: z.string().min(2).max(500),
        replacementSlug: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_library")
      .update({
        deprecated_at: new Date().toISOString(),
        deprecated_reason: data.reason,
        replacement_slug: data.replacementSlug ?? null,
      })
      .eq("id", data.entryId);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "module_library.deprecated",
      entity_type: "module_library",
      entity_id: data.entryId,
      actor_user_id: userId,
      metadata: { reason: data.reason, replacement_slug: data.replacementSlug ?? null },
    });
    return { ok: true as const };
  });

export const undeprecateLibraryEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { entryId: string }) => z.object({ entryId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_library")
      .update({ deprecated_at: null, deprecated_reason: null, replacement_slug: null })
      .eq("id", data.entryId);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "module_library.undeprecated",
      entity_type: "module_library",
      entity_id: data.entryId,
      actor_user_id: userId,
    });
    return { ok: true as const };
  });

// ─── Brand drift severity timeseries ──────────────────────────────────

export const brandDriftTimeseries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { days?: number }) =>
    z.object({ days: z.number().int().min(1).max(90).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const days = data.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await supabase
      .from("clone_brand_assignments")
      .select("status, last_drift_check_at, updated_at")
      .gte("updated_at", since);
    // bucket by day, severity ~= status mapping
    const buckets = new Map<
      string,
      { date: string; pending: number; drifted: number; failed: number; applied: number }
    >();
    for (const r of rows ?? []) {
      const ts = r.last_drift_check_at ?? r.updated_at;
      if (!ts) continue;
      const date = ts.slice(0, 10);
      const cur = buckets.get(date) ?? { date, pending: 0, drifted: 0, failed: 0, applied: 0 };
      const status = String(r.status ?? "");
      if (status === "pending") cur.pending += 1;
      else if (status === "drifted") cur.drifted += 1;
      else if (status === "failed") cur.failed += 1;
      else if (status === "applied") cur.applied += 1;
      buckets.set(date, cur);
    }
    const series = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true as const, days, series };
  });
