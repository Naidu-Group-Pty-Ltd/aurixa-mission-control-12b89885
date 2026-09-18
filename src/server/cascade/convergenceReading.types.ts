/**
 * The reading's vocabulary, as types alone.
 *
 * `src/server/**` is denied to the client environment, and correctly so. A
 * type import is erased before the bundler sees it, so a client module may
 * name these without pulling a single byte of server code across the seam —
 * but only if the module it names carries nothing else. That is the whole
 * purpose of this file: one import specifier the client can use, containing no
 * runtime value at all.
 */
export type { ConvergenceState } from "./convergence.pure";
export type { LedgerAgreement, LedgerPosition } from "./convergenceReading.pure";
