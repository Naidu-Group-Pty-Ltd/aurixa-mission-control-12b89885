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
