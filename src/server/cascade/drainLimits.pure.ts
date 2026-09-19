/**
 * The drain's two ceilings, in one place because more than one reader needs
 * them.
 *
 * They lived as file-local constants in `hooks.cascade-drain.tsx`, which was
 * fine while the drain was their only reader. The blockage ledger has to know
 * both — an event at the attempt ceiling and an event stuck past the stall
 * window are two different blockages with two different owners, and a ledger
 * carrying its own copy of either number would classify against a rule the
 * drain had stopped following.
 *
 * Moved rather than duplicated, for the reason `globToRegex` is one
 * implementation: two answers to "is this event exhausted?" is how the
 * classifier comes to describe a fleet that is not the one running.
 */

/**
 * Attempts an event may spend before it is retired.
 *
 * A deferral refunds its attempt and so does a pause that landed at least one
 * clone, so this counts passes that made no progress rather than ticks.
 */
export const MAX_ATTEMPTS = 3;

/**
 * How long a claim may sit in `running` before the reclaim assumes the
 * invocation that took it is gone.
 *
 * pg_net stops WAITING at 60,000 ms and does not stop the isolate, so a
 * working pass can outlive the delivery that started it; ten minutes is well
 * past any pass that is still going to report.
 */
export const STALL_MINUTES = 10;
