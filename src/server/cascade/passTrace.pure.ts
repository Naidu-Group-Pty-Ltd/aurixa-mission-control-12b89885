/**
 * Where a cascade pass was when it stopped, written as it goes.
 *
 * A pass the platform kills leaves nothing behind but the `pushing` mark it
 * wrote before any work, so the database could say THAT a pass died and never
 * WHERE. Measured 20 Oct 2026 (F21 in the 19 Oct hand-over): no pass on the
 * CRM line had finished since 17 Oct, every one was cut before its first ledger
 * write, and the two candidates for the stage that ran past the platform's
 * wait — the import closure, whose read is never cut short by the budget, and
 * the tree write, which the budget does not gate — could not be told apart.
 * Every remedy for a pass that does not fit starts from that answer.
 *
 * So the engine names each stage as it enters it (`onPhase`), and the drain
 * writes the list to the row (`cascade_results.pass_trace`) without waiting on
 * the write. A trace whose list ends without an `outcome` is a pass that died
 * in its last stage, and the times say how long each stage had.
 *
 * Observability only, and it must never cost the pass anything: nothing reads
 * the trace to decide anything, a write that fails is dropped, and a database
 * the column has not reached yet is simply not traced.
 */

/** The stages of `processClone`, in the order a pass enters them. */
export const PASS_PHASES = [
  /** The two tree listings and the candidate list. */
  "listing",
  /** Edge Functions the clone carries that prime no longer defines. */
  "functions",
  /** The import closure: every candidate module's imports, read in full. */
  "closure",
  /** Held paths, probed against prime's history. */
  "held",
  /** Held line variants, merged three ways. */
  "variants",
  /** What prime deleted, probed against prime's history. */
  "deletions",
  /** Prime's text for the files left to prepare, a batch at a time. */
  "prefetch",
  /** Each file judged and prepared. */
  "prepare",
  /** The delivery decided: specs, subjects, reconciles, the baselines. */
  "deliver",
  /** The tree written, a chunk at a time. */
  "tree",
  /** The commit, the branch and the pull request. */
  "proposal",
] as const;

export type PassPhase = (typeof PASS_PHASES)[number];

/**
 * How a traced pass ended. `deferred` is a pass GitHub turned away for a
 * window (a rate limit, a server error worth retrying), whose row is queued
 * again. Absent: it did not end — the platform ended it.
 */
export type PassOutcome = "paused" | "finished" | "deferred" | "failed";

/**
 * How long a clone whose work is done waits for its trace's last write. The
 * marks are fired without waiting while the pass works, which is right; but a
 * write still in flight when the invocation returns can be dropped with it,
 * and a trace that lost its outcome reads exactly like a pass the platform
 * ended — an instrument failing the way its subject fails. Waiting once the
 * work is done costs the pass nothing it needed, and the bound keeps a slow
 * database from making it cost more.
 */
export const TRACE_FLUSH_MS = 2_000;

/** Waits for the trace's writes, but never longer than `boundMs`. */
export async function settleTrace(writes: Promise<void>, boundMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    writes,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export type PassTrace = {
  v: 1;
  /** When the pass began, by the engine's clock. */
  started_at: string;
  /** Each stage entered, with the milliseconds since the pass began. */
  phases: Array<[PassPhase, number]>;
  /** Milliseconds from the start to the outcome, where there was one. */
  ended_ms?: number;
  outcome?: PassOutcome;
};

/** The trace with one more stage entered. Never mutates its input. */
export function enterPhase(
  trace: PassTrace | null,
  phase: PassPhase,
  atMs: number,
  startedAt: string,
): PassTrace {
  const base: PassTrace = trace ?? { v: 1, started_at: startedAt, phases: [] };
  return { ...base, phases: [...base.phases, [phase, Math.max(0, Math.round(atMs))]] };
}

/** The trace with its outcome recorded. */
export function endPass(
  trace: PassTrace | null,
  outcome: PassOutcome,
  atMs: number,
  startedAt: string,
): PassTrace {
  const base: PassTrace = trace ?? { v: 1, started_at: startedAt, phases: [] };
  return { ...base, outcome, ended_ms: Math.max(0, Math.round(atMs)) };
}

/**
 * One sentence for an operator: where the pass was, and for how long.
 * `null` for anything that is not a trace this module wrote.
 */
export function describePassTrace(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<PassTrace>;
  if (t.v !== 1 || !Array.isArray(t.phases) || t.phases.length === 0) return null;
  const phases = t.phases.filter(
    (p): p is [PassPhase, number] =>
      Array.isArray(p) &&
      (PASS_PHASES as readonly string[]).includes(p[0] as string) &&
      typeof p[1] === "number",
  );
  if (phases.length === 0) return null;
  const [last, enteredMs] = phases[phases.length - 1];
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  if (t.outcome && typeof t.ended_ms === "number") {
    return `The pass ${t.outcome} in ${last} at ${seconds(t.ended_ms)}.`;
  }
  return (
    `The pass entered ${last} at ${seconds(enteredMs)} and recorded no outcome — ` +
    `it was ended there.`
  );
}
