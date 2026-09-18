/**
 * The fleet's uptime, computed from probes rather than from one row.
 *
 * ## The three defects this replaces, all measured on 18 Sep 2026
 *
 * **1. The reader looked at a key no payload has ever carried.**
 * `computeFleetSlo` and `CloneHealthTimeline` both read
 * `payload.status ?? payload.health`, and `CloneHealth` has neither — the
 * status lives at `payload.uptime.status`. Measured against production, all
 * three clones were `up` on HTTP 200 in 41–50 ms while both readers resolved
 * `"unknown"`, counted it as a miss, and rendered **0.00% in destructive red
 * on a healthy fleet**. §1.3 recorded this as "0% or 100% from one probe"; the
 * truth is narrower and worse — it could only ever be 0%.
 *
 * The rule that closes it for good: **an SLO reads a column, never a payload.**
 * Nothing downstream of the probe knows the payload's shape any more, so the
 * only module that can get it wrong is the one that defines the type.
 *
 * **2. There was no history to compute a window over.** `clone_health_snapshots`
 * is UNIQUE on `clone_id` — a correct five-minute cache holding one row per
 * clone — so `windowDays` (1–90) could not change the answer and a one-day and
 * a ninety-day SLO returned the same number. A cache and a history are
 * different tables, and an SLO needs the second one.
 *
 * **3. `unknown` was counted as down.** A clone with no deploy URL has nothing
 * to ping, and the health card already says so — *"a red pip is worse than a
 * grey one"*. The old arithmetic put every such probe in the denominator, so a
 * clone that was never deployed read 0% uptime rather than "not measured".
 * This is `rentalEvidence`'s rule, which this fleet has now paid for on rents,
 * on Places lookups and on builder rankings: **absent is never zero**, and it
 * leaves BOTH sides of the fraction.
 *
 * ## What "fleet uptime" means here
 *
 * The fraction of all MEASURED probes that were up — sample-weighted, not the
 * mean of per-clone percentages. Every clone is probed on the same five-minute
 * schedule, so in practice the two agree; where they differ (a clone added
 * yesterday beside one with ninety days) sample-weighting answers "of every
 * probe we took, how many were up", which is a quantity that can be checked.
 * Stated here because an aggregate nobody defines is one two people read two
 * ways.
 *
 * ## A window asked for is not a window measured
 *
 * The history starts empty, so for its first weeks a "30-day uptime" is a few
 * hours of samples wearing a thirty-day label. Coverage travels with the
 * answer — the same rule the office-holder index and the sanctions register
 * already answer to — so the reading carries the span it actually observed and
 * says whether that reaches the window it was asked for.
 */

/** The three readings a probe can produce. Mirrors `CloneHealth["uptime"]["status"]`. */
export type UptimeStatus = "up" | "down" | "unknown";

/**
 * One clone's probes for one UTC day, as `clone_health_daily` groups them.
 *
 * The aggregation is the database's, for a reason the view's own comment
 * carries: three clones probed every five minutes is 78,000 rows over the
 * widest window this page offers, and at fifty clones it is 1.3 million.
 * Counting those in a function is a mistake that only surfaces once the fleet
 * has grown. What is left here is the arithmetic and the honesty — which are
 * the parts worth testing and the parts that were wrong.
 */
export type UptimeDayRow = {
  cloneId: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  up: number;
  down: number;
  unmeasured: number;
  firstProbedAt: string;
  lastProbedAt: string;
  /** What the clone was on this day's last probe. */
  lastStatus: UptimeStatus;
};

export type CloneUptime = {
  cloneId: string;
  /**
   * `up / (up + down)`, to two decimal places.
   *
   * **`null` when nothing was measured, and never `0`.** A clone with no
   * deploy URL produces `unknown` on every probe; reporting that as zero
   * percent uptime is a claim the probes never made.
   */
  uptimePct: number | null;
  up: number;
  down: number;
  /** Probes that reached no conclusion. In neither side of the fraction. */
  unmeasured: number;
  /** `up + down` — the samples the percentage is actually computed from. */
  measured: number;
  lastProbedAt: string | null;
  /**
   * What it was on the newest probe in the window.
   *
   * A CURRENT fact rather than a summary, and the two answer different
   * questions: 99.9% over ninety days says nothing about whether the clone is
   * answering right now.
   */
  lastStatus: UptimeStatus | null;
};

export type FleetUptime = {
  requestedWindowDays: number;
  /** Oldest and newest probe actually seen, or null where there were none. */
  observedFrom: string | null;
  observedTo: string | null;
  observedHours: number | null;
  /** Does the evidence reach back as far as the window it was asked for? */
  coversRequestedWindow: boolean;
  fleetUptimePct: number | null;
  measuredTotal: number;
  unmeasuredTotal: number;
  byClone: CloneUptime[];
};

function pct(up: number, measured: number): number | null {
  if (measured <= 0) return null;
  return Math.round((up / measured) * 10000) / 100;
}

export function summariseUptime(input: {
  now: Date;
  requestedWindowDays: number;
  rows: readonly UptimeDayRow[];
}): FleetUptime {
  const { now, requestedWindowDays, rows } = input;

  const byClone = new Map<
    string,
    {
      up: number;
      down: number;
      unmeasured: number;
      lastProbedAt: string;
      lastStatus: UptimeStatus;
    }
  >();
  let oldest: string | null = null;
  let newest: string | null = null;

  for (const r of rows) {
    if (oldest === null || r.firstProbedAt < oldest) oldest = r.firstProbedAt;
    if (newest === null || r.lastProbedAt > newest) newest = r.lastProbedAt;

    const cur = byClone.get(r.cloneId) ?? {
      up: 0,
      down: 0,
      unmeasured: 0,
      lastProbedAt: r.lastProbedAt,
      lastStatus: r.lastStatus,
    };
    cur.up += r.up;
    cur.down += r.down;
    cur.unmeasured += r.unmeasured;
    // The newest day decides the current reading, whatever order rows arrive in.
    if (r.lastProbedAt >= cur.lastProbedAt) {
      cur.lastProbedAt = r.lastProbedAt;
      cur.lastStatus = r.lastStatus;
    }
    byClone.set(r.cloneId, cur);
  }

  const out: CloneUptime[] = Array.from(byClone.entries()).map(([cloneId, v]) => ({
    cloneId,
    uptimePct: pct(v.up, v.up + v.down),
    up: v.up,
    down: v.down,
    unmeasured: v.unmeasured,
    measured: v.up + v.down,
    lastProbedAt: v.lastProbedAt,
    lastStatus: v.lastStatus,
  }));

  const measuredTotal = out.reduce((s, r) => s + r.measured, 0);
  const upTotal = out.reduce((s, r) => s + r.up, 0);
  const unmeasuredTotal = out.reduce((s, r) => s + r.unmeasured, 0);

  const observedHours =
    oldest && newest
      ? Math.round(((new Date(newest).getTime() - new Date(oldest).getTime()) / 3_600_000) * 10) /
        10
      : null;

  const windowStart = new Date(now.getTime() - requestedWindowDays * 86_400_000);

  return {
    requestedWindowDays,
    observedFrom: oldest,
    observedTo: newest,
    observedHours,
    // Evidence reaching back to (or past) the window's start is coverage. An
    // empty history covers nothing, which is a fact worth stating rather than
    // an omission — the first weeks after this ships are exactly that case.
    coversRequestedWindow: oldest !== null && new Date(oldest) <= windowStart,
    fleetUptimePct: pct(upTotal, measuredTotal),
    measuredTotal,
    unmeasuredTotal,
    byClone: out,
  };
}

/**
 * One clone's daily series, for the sparkline.
 *
 * Same exclusion: a day whose probes were all `unknown` has no percentage
 * rather than a zero, so a clone that was never deployed draws a gap rather
 * than a floor at the bottom of the chart.
 */
export type UptimeDay = {
  date: string;
  up: number;
  down: number;
  unmeasured: number;
  measured: number;
  pct: number | null;
};

export function daySeriesFor(rows: readonly UptimeDayRow[]): UptimeDay[] {
  return rows
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({
      date: r.day,
      up: r.up,
      down: r.down,
      unmeasured: r.unmeasured,
      measured: r.up + r.down,
      pct: pct(r.up, r.up + r.down),
    }));
}

/**
 * The average a sparkline header quotes.
 *
 * Sample-weighted over the days shown, not the mean of the daily percentages —
 * a day with four probes must not weigh the same as a day with 288, and a day
 * that measured nothing must not weigh at all.
 */
export function averageOf(days: readonly UptimeDay[]): number | null {
  const measured = days.reduce((s, d) => s + d.measured, 0);
  const up = days.reduce((s, d) => s + d.up, 0);
  return pct(up, measured);
}

/**
 * How long a probe series is kept.
 *
 * The SLO window caps at 90 days, and a 90-day reading computed against a tail
 * that is already being pruned would quietly shrink its own evidence. A month
 * of slack past the widest question anyone can ask.
 */
export const HEALTH_HISTORY_RETENTION_DAYS = 120;
