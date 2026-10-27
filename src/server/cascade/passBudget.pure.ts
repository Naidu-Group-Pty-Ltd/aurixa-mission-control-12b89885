/**
 * How much of a tick a clone's pass needs, read from what its last pass took.
 *
 * ## The window, and who was overrunning it
 *
 * The drain gives the engine 45 s of a tick (`INVOCATION_BUDGET_MS`), because
 * pg_net stops waiting at 60 s, and the platform ends the invocation at about
 * that point (measured 60–70 s, `docs/CASCADE_PASS_REPLAY.md`). A pass the
 * platform ends records no outcome, keeps its claim for `STALL_MINUTES` (10)
 * and spends an attempt; three of those and the event is retired with every
 * unreached row `skipped`.
 *
 * Measured on 27 Oct 2026 from `cascade_results.pass_trace` over ten days:
 *
 *   - 48 of the CRM's 67 traced passes ended with no outcome — the platform
 *     ended them — and 37 of those were in the spec channel, between 34 and
 *     47 s into the pass;
 *   - the stages after `prepare` (deliver through proposal) took the mirrors
 *     13 s at the median and 17.6 s at p90, and the CRM 19 s at the median and
 *     37.8 s at p90. None of those stages asks the budget;
 *   - a finished CRM pass took 33 s at the median and 61 s at p90; a mirror's,
 *     20–22 s and 28–30 s.
 *
 * Two checks asked the budget the wrong question:
 *
 *   - before each clone after the first, the engine reserved the SLOWEST
 *     clone so far in this pass — not the clone about to start. A 20 s mirror
 *     followed by the CRM reserved 20 s for a pass that takes 40;
 *   - the prepare loop reserved one more FILE, then went into a tail that
 *     takes 13–38 s and asks nothing.
 *
 * This module answers both from the clone's own last trace: how long its pass
 * takes, and how long its tail takes. Every reading it cannot make answers the
 * old behaviour (no reservation beyond what the engine already made), so a
 * missing or unreadable trace costs what it always cost, never more.
 */
import { PASS_PHASES, type PassPhase, type PassTrace } from "./passTrace.pure";

/**
 * The share of a tick the drain gives the engine. The drain's own constant
 * reads this one, so the engine's arithmetic below and the deadline it is
 * measured against cannot disagree.
 */
export const INVOCATION_BUDGET_MS = 45_000;

/**
 * Where the platform stops waiting for an invocation: pg_net's 60 s. Passes
 * that ran past it were ended by the platform at 60–70 s.
 */
export const PLATFORM_WAIT_MS = 60_000;

/**
 * How far past the budget an unchecked stage may run and still be waited for.
 * The tail reserve below is what is LEFT of a clone's tail once this is spent,
 * so a clone whose tail fits in it — every mirror, at p90 — prepares exactly
 * as long as it did before.
 */
export const PAST_BUDGET_SLACK_MS = PLATFORM_WAIT_MS - INVOCATION_BUDGET_MS;

/**
 * How much of the budget must be left for a claim to be worth taking.
 *
 * A claim runs its first clone whatever the budget says — that is the
 * forward-progress guarantee — and the cheapest pass that does anything took
 * 15–20 s (listing, closure, tail). A claim taken with less than this left
 * starts a pass that cannot finish inside the platform's wait; one minute
 * later, at the next tick, it would have had the whole budget. The first claim
 * of a tick is taken a few seconds in, after the reclaim and the fold, so this
 * stops only the second and third — the ones that used to start at second 30
 * or 44 behind a quick hold.
 */
export const CLAIM_HEADROOM_MS = 25_000;

/** Whether the drain may still take a claim with this much of its budget left. */
export function claimHasHeadroom(nowMs: number, deadlineAtMs: number): boolean {
  return deadlineAtMs - nowMs >= CLAIM_HEADROOM_MS;
}

/** A trace this module can read, or null. */
export function readPassTrace(raw: unknown): PassTrace | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<PassTrace>;
  if (t.v !== 1 || !Array.isArray(t.phases)) return null;
  const phases = t.phases.filter(
    (p): p is [PassPhase, number] =>
      Array.isArray(p) &&
      (PASS_PHASES as readonly string[]).includes(p[0] as string) &&
      typeof p[1] === "number" &&
      Number.isFinite(p[1]) &&
      p[1] >= 0,
  );
  const endedMs =
    typeof t.ended_ms === "number" && Number.isFinite(t.ended_ms) && t.ended_ms >= 0
      ? t.ended_ms
      : undefined;
  return {
    v: 1,
    started_at: typeof t.started_at === "string" ? t.started_at : "",
    phases,
    ...(t.outcome && endedMs !== undefined ? { outcome: t.outcome, ended_ms: endedMs } : {}),
  };
}

/**
 * How long this clone's next pass should be assumed to take, before another
 * clone in the same tick lets it start.
 *
 *   - a pass that ended, however it ended: what it took;
 *   - a pass the platform ended (no outcome): the whole budget. It did not fit
 *     in a tick, so it must only ever start first — where the engine runs it
 *     whatever the budget says — and never behind another clone;
 *   - no trace: null, which reserves nothing beyond the slowest clone so far,
 *     exactly as before.
 */
export function ownPassReserveMs(raw: unknown): number | null {
  const trace = readPassTrace(raw);
  if (!trace || trace.phases.length === 0) return null;
  if (trace.outcome && typeof trace.ended_ms === "number") return trace.ended_ms;
  return INVOCATION_BUDGET_MS;
}

/**
 * How much of the budget the prepare loop must leave for the stages after it,
 * read from the clone's last FINISHED pass: its tail (from entering `deliver`
 * to its end) less the slack the platform allows past the budget. Zero where
 * there is no such pass, or where the tail fits in the slack — which is the
 * old behaviour exactly.
 */
export function tailReserveMs(rawFinished: unknown): number {
  const trace = readPassTrace(rawFinished);
  if (!trace || trace.outcome !== "finished" || typeof trace.ended_ms !== "number") return 0;
  const deliver = trace.phases.find(([phase]) => phase === "deliver");
  if (!deliver) return 0;
  const tail = trace.ended_ms - deliver[1];
  return tail > PAST_BUDGET_SLACK_MS ? tail - PAST_BUDGET_SLACK_MS : 0;
}

/** What the engine keeps per clone for one pass. */
export type ClonePassBudget = {
  /** `ownPassReserveMs` of the clone's latest trace, or null. */
  readonly passMs: number | null;
  /** `tailReserveMs` of the clone's latest finished trace. */
  readonly tailMs: number;
};

/**
 * Per clone, from trace rows newest first: the latest trace of any kind for
 * the pass reserve, and the latest FINISHED one for the tail. A clone with no
 * row is absent — the old behaviour.
 */
export function clonePassBudgets(
  rowsNewestFirst: ReadonlyArray<{ clone_id: string | null; pass_trace: unknown }>,
): Map<string, ClonePassBudget> {
  const latest = new Map<string, unknown>();
  const latestFinished = new Map<string, unknown>();
  for (const row of rowsNewestFirst) {
    if (!row.clone_id) continue;
    const trace = readPassTrace(row.pass_trace);
    if (!trace || trace.phases.length === 0) continue;
    if (!latest.has(row.clone_id)) latest.set(row.clone_id, row.pass_trace);
    if (trace.outcome === "finished" && !latestFinished.has(row.clone_id)) {
      latestFinished.set(row.clone_id, row.pass_trace);
    }
  }
  const out = new Map<string, ClonePassBudget>();
  for (const cloneId of new Set([...latest.keys(), ...latestFinished.keys()])) {
    out.set(cloneId, {
      passMs: ownPassReserveMs(latest.get(cloneId)),
      tailMs: tailReserveMs(latestFinished.get(cloneId)),
    });
  }
  return out;
}
