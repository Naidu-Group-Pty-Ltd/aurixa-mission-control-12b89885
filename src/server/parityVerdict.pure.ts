/**
 * What a clone backend's status line says about its parity with the prime —
 * stated once, for both writers of it.
 *
 * The pass that finishes a backend compares it with the prime and leads the
 * ready line with the verdict. Since `provisioningFinish.pure.ts`, that pass
 * may also skip the comparison when it would outlive the pass, and say so:
 * "Backend ready, but parity could not be verified …". The catch-up in
 * `deferredParity.server.ts` runs it afterwards and replaces that line with
 * the verdict. Two writers of one sentence is how the two come to disagree,
 * so the sentences are built here and nowhere else.
 *
 * `fleetBlockageRecord.pure.ts` keeps the migration lanes off every one of
 * these: a parity verdict is a fact about the clone that no migration pass may
 * retract. So the catch-up is the only thing that ever replaces the
 * unverified line, and it must.
 */

/** How the line a backend carries when its parity was not run begins. */
export const PARITY_UNVERIFIED_PREFIX = "Backend ready, but parity could not be verified";

/** The line for a backend whose parity was not run, and why. */
export function parityUnverifiedLine(reason: string): string {
  return `${PARITY_UNVERIFIED_PREFIX} (${reason}) — it has not been compared with the prime`;
}

/** The line for a backend that does not match the prime. It leads every other reading. */
export function parityMismatchLine(blockingIssues: readonly string[], cloneId: string): string {
  return `Backend provisioned but DOES NOT MATCH the prime — ${blockingIssues.join(", ")}. Review at /clones/${cloneId}`;
}

/**
 * The line for a backend holding everything the prime has, and more.
 *
 * `clone >= prime` is CONTAINMENT, not equality, and the schema build creates
 * without ever dropping — so a clone holds every object the prime has since
 * deleted. Saying "verified against the prime" over that is the reading that
 * hid a table the prime does not have on the Preflight clone.
 */
export function paritySurplusLine(surplusTotal: number, cloneId: string): string {
  return `Backend is ready — every object the prime has is present, and ${surplusTotal} the prime does NOT have are also on the clone (prime-dropped or tenant-added; nothing was removed). Review at /clones/${cloneId}`;
}

/** A blocking issue that is only credentials the clone was not given (`missing_secrets:N`). */
export function isCredentialGap(issue: string): boolean {
  return issue.startsWith("missing_secrets:");
}

/** The line for a backend that matches the prime. */
export const PARITY_VERIFIED_LINE = "Backend is ready — verified against the prime";

/**
 * What a comparison run after the backend was finished may write, and whether
 * an operator must be told.
 *
 * - **A mismatch** is written whatever stands, as the finishing pass leads
 *   with it. It is raised when it is a gap in what was replicated — a table,
 *   a function, a policy — because nobody was watching when it was found.
 *   Credentials alone are not raised: `missing_secrets` is blocking on every
 *   clone in the fleet (measured 30 Oct 2026: 4, 58, 58, 72 and 72 — the
 *   prime's own vendor keys, which each tenant supplies or goes without), so
 *   an alarm on it would fire for every clone and be read as noise. They are
 *   on the line, and on the clone's secrets page.
 * - **A match** replaces only the unverified line. Any other line belongs to
 *   whoever wrote it since, and a match has nothing to retract there.
 */
export function lateParityVerdict(input: {
  blockingIssues: readonly string[];
  surplusTotal: number;
  cloneId: string;
  /** The status line on the row when the comparison was started. */
  standing: string | null;
}): { detail: string | null; raise: boolean } {
  if (input.blockingIssues.length > 0) {
    return {
      detail: parityMismatchLine(input.blockingIssues, input.cloneId),
      raise: input.blockingIssues.some((issue) => !isCredentialGap(issue)),
    };
  }
  if (!(input.standing ?? "").startsWith(PARITY_UNVERIFIED_PREFIX)) {
    return { detail: null, raise: false };
  }
  return {
    detail:
      input.surplusTotal > 0
        ? paritySurplusLine(input.surplusTotal, input.cloneId)
        : PARITY_VERIFIED_LINE,
    raise: false,
  };
}
