/**
 * A migration body past the ceiling for one Management API statement.
 *
 * Its own class rather than a message, because two callers have to tell it
 * apart from every other failure of a body read: the fleet sync's replay,
 * which can chunk a seed-shaped INSERT from a stream instead of giving up,
 * and the destructiveness gate in front of it, which can assess the seed's
 * skeleton instead of parking the run as unreadable. Defined here, apart
 * from both, because `backend-provisioning.server.ts` already imports from
 * `prime-backend.server.ts` and the class must not be the reason the two
 * import each other.
 */
export class OversizedMigrationError extends Error {
  constructor(
    readonly migration: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Migration ${migration} is ${(bytes / 1_048_576).toFixed(1)} MB, past the ` +
        `${(maxBytes / 1_048_576).toFixed(0)} MB ceiling for a single Management API statement. ` +
        "A seed-shaped INSERT is chunked from a stream instead. For anything else: Apply it to " +
        "this clone by hand (psql or the SQL editor), record its version in " +
        "supabase_migrations.schema_migrations, then re-run the sync.",
    );
    this.name = "OversizedMigrationError";
  }
}

/**
 * The prime's own copy of a migration could not be read.
 *
 * ## Why this is a class and not a status code
 *
 * Nothing about the CLONE is established by a body this pipeline never
 * fetched, so a refusal here has to be held rather than reported as a
 * migration the clone rejected. #216 made that true for the batched loader by
 * asking `isUpstreamRateLimit`, and the very next pass proved a predicate over
 * the error is the wrong instrument: `npc-test-76b3b3` cleared its five-day
 * block, applied 13 migrations and stopped on the 40 MB template-library seed
 * with `Streaming blob b92e5e8 failed: HTTP 403`. A bare 403 matches no
 * rate-limit wording and carries no 429, so it fell through to the generic
 * failure path and took a healthy clone out of the fleet — the same class,
 * one layer out.
 *
 * Widening the predicate to 403 was the obvious repair and it is wrong: a 403
 * from that endpoint is a primary rate limit, a secondary rate limit or a
 * permanent refusal, with three opposite remedies, and the installation was
 * at ~694 calls against a 5,000/hour window when this one fired. Treating it
 * as a quota refusal would have parked the clone waiting on a window that was
 * never closed.
 *
 * So the split is structural rather than diagnostic. WHERE the failure
 * happened is knowable with certainty at the point it happens; WHAT kind of
 * refusal it was is a question for whoever reads the message. This class says
 * the first and quotes the second verbatim.
 */
export class PrimeBodyUnavailableError extends Error {
  constructor(
    readonly migration: string,
    /** The upstream's own words, already truncated by the caller. */
    readonly detail: string,
    /** The HTTP status, where there was one. */
    readonly status?: number,
  ) {
    // Deliberately says nothing about what reached the clone. A refusal on the
    // first read of a streamed seed has sent nothing; one mid-second-pass has
    // sent every statement before it. Only the caller counted, so only the
    // caller may say — and "the clone is unchanged" is exactly the kind of
    // claim that is worth nothing once it is sometimes wrong.
    super(
      `The prime's copy of ${migration} could not be read` +
        (status ? ` (HTTP ${status})` : "") +
        (detail ? `: ${detail}` : "") +
        ". The replay stops here; nothing about this clone's schema is established by it.",
    );
    this.name = "PrimeBodyUnavailableError";
  }
}
