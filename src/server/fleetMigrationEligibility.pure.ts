import { messageNamesUpstreamRateLimit } from "@/server/provisioningBudget";
import { chunkCursorFor } from "./chunkCursorStore.pure";

/**
 * Whether the fleet migration sync may advance a clone's schema.
 *
 * ## Why this is a module of its own
 *
 * The lane used to ask `status = 'ready'` — a PROVISIONING queue status,
 * written by a different worker, read here as though it described a tenant's
 * database. Every other reader of `clone_backends` in this repository already
 * ignores that column (deploy, secret forwarding, signing pairs, allowed
 * origins, CI credentials); the migration lane was the only one gating on it,
 * which is exactly why the failure presented as "SQL migrations don't run on
 * clones" while nothing else in the fleet looked wrong.
 *
 * Measured 8 Sep 2026: `NPC Test` and `Preflight Property Group` were queued
 * as REPAIRS on 7 September, never claimed once (`attempts: 0`,
 * `worker_started_at` never set), and swept to `failed` 24 hours later by the
 * provisioning drain's wall-clock ceiling. Both databases were healthy and
 * level with the third clone. Every half-hourly run for the following day
 * reported `processed 1 … excluded 2`, and two of three tenants silently
 * stopped receiving the prime's schema.
 *
 * ## The three questions, and only the third is about a schema
 *
 * 1. **Is there a project to talk to?** No project ref, nothing to advance.
 * 2. **Is the provisioning worker inside this backend right now?** Two writers
 *    on one schema is the fault this codebase keeps meeting; a row that is
 *    `pending` or in flight, or that a worker has claimed, is left alone. This
 *    is a fact about a JOB and it is the only place a job status belongs here.
 * 3. **Has a prime migration failed on this clone before?** The one genuine
 *    reason to withhold, established only by this lane and recorded in
 *    `migration_blocked_at`, a column only this lane writes.
 *
 * A `failed` row that is NOT migration-blocked is a queue or provisioning
 * fault: nothing ran, nothing was judged about the schema, and excluding it
 * would be inventing a verdict this lane never reached.
 *
 * ## Why a pure module
 *
 * The decision that took two tenants out of the fleet was three words inside
 * a PostgREST chain, unreachable by any test. It is a function now, and the
 * spec beside it enumerates every state rather than trusting the reading.
 */

/**
 * The provisioning statuses that mean a worker is building this backend.
 *
 * Together with {@link MIGRATION_CLAIMABLE_STATUSES} these partition
 * `clone_backend_status` exactly, and a test asserts it against the enum
 * rather than trusting this list — a status added to the database and not to
 * one of these two would otherwise fall silently into whichever side the code
 * happened to default to, which is the shape of the defect this module exists
 * to close.
 */
export const PROVISIONING_IN_FLIGHT = [
  "pending",
  "provisioning",
  "migrating",
  "seeding_admin",
] as const;

/**
 * The statuses this lane may hold a claim on.
 *
 * `worker_started_at` is the real mutex between this lane and the provisioning
 * drain — neither will claim a row the other holds — but the reclaim of a
 * DEAD claim needs to know whose claim it was releasing, and releasing one
 * the provisioning worker owns would put two writers on a schema mid-build.
 * The provisioning drain claims `pending` and reclaims `pending` plus the
 * in-flight set, so this lane's claims can only ever sit on the complement.
 *
 * `suspended` is in the list because it is claimable in principle; it is
 * refused on its own terms by {@link migrationEligibility}, which is where an
 * administrative state belongs rather than in a mutex.
 */
export const MIGRATION_CLAIMABLE_STATUSES = ["ready", "failed", "suspended"] as const;

export type MigrationSkipReason =
  /** No Supabase project ref — there is nothing to advance. */
  | "no_project"
  /** The provisioning worker is building or rebuilding this backend. */
  | "provisioning_in_flight"
  /** A prime migration failed here. The only reason that is about the schema. */
  | "migration_blocked"
  /** The backend is administratively suspended. Not this lane's decision to override. */
  | "suspended";

export type MigrationEligibility =
  | { eligible: true }
  | { eligible: false; reason: MigrationSkipReason; detail: string };

export type BackendFacts = {
  supabaseProjectRef: string | null;
  status: string;
  workerStartedAt: string | null;
  migrationBlockedAt: string | null;
  migrationBlockedReason: string | null;
};

export function migrationEligibility(facts: BackendFacts): MigrationEligibility {
  if (!facts.supabaseProjectRef) {
    return {
      eligible: false,
      reason: "no_project",
      detail:
        "This backend names no Supabase project, so there is no database to advance. " +
        "Provision it before it can receive the prime's migrations.",
    };
  }

  // A claim held by the provisioning worker, or a status that says one is
  // owed. Both mean the same thing to this lane: somebody else is writing
  // this schema, so do not.
  if (facts.workerStartedAt) {
    return {
      eligible: false,
      reason: "provisioning_in_flight",
      detail:
        "The provisioning worker is inside this backend right now. It will be eligible on the " +
        "next run after that pass settles; nothing is wrong.",
    };
  }
  if ((PROVISIONING_IN_FLIGHT as readonly string[]).includes(facts.status)) {
    return {
      eligible: false,
      reason: "provisioning_in_flight",
      detail:
        `This backend is queued or being built (status: ${facts.status}). Advancing its schema ` +
        "while provisioning writes it is the two-writers fault; it becomes eligible once that " +
        "pass settles.",
    };
  }

  // Administratively out of service. A suspended backend is somebody's
  // decision, and a background lane that keeps writing to it is quietly
  // overruling them. Separate from `migration_blocked` because the remedies
  // are opposite: one is repaired, the other is reinstated.
  if (facts.status === "suspended") {
    return {
      eligible: false,
      reason: "suspended",
      detail:
        "This backend is suspended. Migrations are withheld while it is, and resume by itself " +
        "once it is reinstated — nothing here needs repairing.",
    };
  }

  // The one verdict that is about the tenant's database, and the one this
  // lane writes itself.
  if (facts.migrationBlockedAt) {
    return {
      eligible: false,
      reason: "migration_blocked",
      detail:
        facts.migrationBlockedReason?.trim() ||
        "A prime migration failed on this clone and it is held out of the fleet sync until repaired.",
    };
  }

  // Everything else — including a `failed` row that carries no migration
  // block. Such a row was failed by the PROVISIONING lane (a stalled worker,
  // exhausted attempts, a wall-clock ceiling, a job nothing ever claimed);
  // none of those ran a migration, so none of them establishes anything about
  // this schema, and treating them as a refusal is exactly the defect above.
  return { eligible: true };
}

/**
 * A BLOCK IS DISCHARGED BY THE CLONE'S OWN LEDGER, AND BY NOTHING ELSE.
 *
 * `migration_blocked_at` is the one verdict above that is about a tenant's
 * database, and the header says it is "held out of the fleet sync until
 * repaired". That was written assuming the repair would be noticed. It is not:
 * the sync will not create a run for a blocked clone, and the only thing that
 * clears the flag — `clearStaleMigrationFailure` — runs INSIDE a run. So a
 * clone can only be unblocked by a run that cannot exist while it is blocked.
 *
 * Measured 12 Sep 2026. `npc-test-76b3b3` was blocked at 09:31 by
 * `20250124160000_prepare_extensions_schema.sql` failing on `current_schema`,
 * a reserved word. The prime's copy was fixed at 09:33, the clone applied the
 * file at 10:14 and stood at 28 of 28 target tables — and every sync for the
 * next five hours still answered `excluded: 1 … reason: migration_blocked`,
 * quoting a syntax error that no longer existed anywhere. Its sibling escaped
 * only by accident of routing: a cascade-raised catch-up does not consult
 * eligibility, so Preflight got a run, and that run cleared its flag.
 *
 * The evidence was there the whole time. Both of that clone's ledgers record
 * `20250124160000`. The block was about work the clone has since done.
 *
 * ## Three rules
 *
 * **A reason that names no version is never discharged.** The block is written
 * as `` `${name}: ${error}` `` and the name is the corpus filename, so the
 * version is the leading stamp. Where it cannot be read, nothing here can
 * prove anything and the block stands — which is the direction a guard is
 * allowed to be wrong in.
 *
 * **The proof is the CLONE's applied-set, never the prime's.** The prime
 * holding a fixed file says the file is fixed; it says nothing about whether
 * this tenant ran it. Only the union the replay itself skips can answer that.
 *
 * **It clears on evidence, never on age.** A block that expires on a timer is
 * not a block. Nothing here reads a clock.
 */
export function blockedVersionFrom(reason: string | null | undefined): string | null {
  const match = /^\s*(\d{14})_/.exec(reason ?? "");
  return match ? match[1] : null;
}

/**
 * Whether a recorded block is discharged by the versions this clone holds.
 *
 * `appliedVersions` is the union of `supabase_migrations.schema_migrations`
 * and `aurixa.schema_migrations` — the same set `applyPrimeMigrations` skips,
 * read through `readCloneMigrationLedger`, so this cannot disagree with what
 * the replay would decide. A read that FAILED must never be passed here as an
 * empty array: empty means "this clone holds nothing", which is a claim, and
 * the caller keeps the block instead.
 */
export function blockIsDischarged(
  reason: string | null | undefined,
  appliedVersions: readonly string[],
): boolean {
  const version = blockedVersionFrom(reason);
  if (!version) return false;
  return appliedVersions.includes(version);
}

/**
 * A BLOCK WRITTEN FROM A QUOTA REFUSAL IS NOT A FINDING ABOUT THIS CLONE.
 *
 * The evidence rule above is right for what a block MEANS: this clone was sent
 * a migration and refused it, so the clone's own ledger is what settles it. It
 * cannot settle a block that was never about the clone at all.
 *
 * Measured 19 Sep 2026. `npc-client-dashboard`, `npc-test-76b3b3` and
 * `preflight-property-group` had read `failed` since 14 Sep 13:30 UTC, each
 * blocked at `20261124000000_builder_portal_decommission.sql` with the reason
 *
 *   API rate limit exceeded for installation ID 157200201
 *
 * The bodies were never fetched, so nothing was sent, so nothing was refused
 * and those three schemas are untouched. #216 stopped new blocks being written
 * that way. It could not release the three already written, and neither can
 * `blockIsDischarged`: the version it looks for can only enter a clone's
 * ledger by being applied, a blocked clone gets no run, and only a run applies
 * anything. Five days on, the prime held TWENTY-THREE migrations past where
 * they stopped — a security fix among them — and none could reach them.
 *
 * So the block retracts on what the reason SAYS. That is not the timer this
 * module forbids: nothing here reads a clock, and the retraction is as much a
 * statement about the evidence as the ledger test is — one reads what the
 * clone holds, the other reads that there was never anything to hold.
 *
 * Three rules keep it narrow.
 *
 * **Only this signature retracts.** Every other block still needs the ledger,
 * so a clone that genuinely rejected a migration stays out of the lane until
 * it demonstrably holds it. A reason naming no version is still undischarged
 * by either route, which is the direction a guard may be wrong in.
 *
 * **The recognition is imported, never restated** —
 * `messageNamesUpstreamRateLimit` is the one spelling of this phrase, and the
 * write path that created these blocks reaches the same function through
 * `isUpstreamRateLimit`. A second regex here is how the writer and the
 * releaser come to disagree about the same string.
 *
 * **Retracting clears the block and nothing else.** `status` belongs to
 * whichever lane last ran a migration here, and a `failed` row carrying no
 * block is already eligible above — deliberately, because such a row was
 * failed by the provisioning lane and establishes nothing about this schema.
 * Writing `ready` here would be this lane claiming a result it did not
 * produce.
 */
export function blockIsUpstreamRefusal(reason: string | null | undefined): boolean {
  if (typeof reason !== "string" || reason.length === 0) return false;
  return messageNamesUpstreamRateLimit(reason);
}

/** What the queue order is decided from. A row of `clone_backends`. */
export type MigrationQueueRow = {
  migration_version: string | null;
  /** Raw JSONB. Narrowed through `chunkCursorFor`, never read field by field. */
  chunk_cursor?: unknown;
  /**
   * When this lane last CLAIMED the clone. Optional because the column arrived
   * after this comparator did and a caller that does not select it must still
   * order correctly — see the third key below.
   */
  migration_heartbeat_at?: string | null;
  /** A total order, so the sort can never fall back to the table's layout. */
  clone_id?: string;
};

/**
 * Which eligible clone the pass serves first.
 *
 * ## An arbitrary tie-break is not the absence of a policy
 *
 * The lane sorts by `migration_version` ascending — furthest behind first —
 * and takes a batch. That is the right primary key and it decides nothing at
 * all on the fleet this exists for: a fleet held at ONE frontier ties on every
 * row, `Array.prototype.sort` is stable, and a comparator returning 0 hands
 * the order to the table's physical layout and then keeps it there for every
 * pass.
 *
 * Measured 19 September 2026, three clones all recording `20261201100000`
 * with a ~40 MB template-library seed as their next migration. Scan order was
 * Preflight, NPC Client Dashboard, NPC Test. Over two hours and forty-five
 * minutes Preflight advanced eight statements, NPC Client Dashboard advanced
 * none, and NPC Test was never CLAIMED — its row was not written once. The
 * pass spends its whole wall-clock budget streaming the seed back to the
 * leader's cursor, the outer loop breaks on the deadline before it reaches
 * anyone else, and because the leader's progress does not change its
 * `migration_version`, it leads again on the next pass. Left alone that is not
 * a slow fleet, it is one clone draining and two that never will.
 *
 * ## Why progress, and not a clock
 *
 * The obvious tie-break is least-recently-served, and there is no honest field
 * for it: `updated_at` is written by the provisioning drain, the secret
 * reconcilers and the parity sweep as well, so a clone another lane touches
 * often would read as freshly served by this one and be pushed to the back for
 * a reason that has nothing to do with migrations. Adding a column for it is a
 * schema change to carry a fact this lane already has.
 *
 * `chunk_cursor` is written by this lane and only this lane, on every
 * statement it lands. Fewest statements done is furthest behind on the work
 * actually in flight, which is the thing the order is being asked about — and
 * it self-rotates: serving the laggard advances it past its peers, which then
 * lead. Comparing counts across two DIFFERENT seeds would be meaningless, and
 * this never does: it is reached only when two clones agree on
 * `migration_version`, so their next migration is the same file.
 *
 * A clone with no cursor sorts as zero, which puts a clone that is not
 * mid-seed ahead of one that is. That is deliberate and cheap — such a pass
 * either has nothing to do and returns at once, or has an ordinary small
 * migration to send — and it is the conservative direction: the failure this
 * function exists to stop is a clone never reached, never a clone reached too
 * often.
 *
 * ## And then two clones with no cursor tie at zero
 *
 * Which is the same defect this function exists to close, narrower: the sort
 * returns 0, `Array.prototype.sort` is stable, and the order is the table's
 * layout again. The case is not rare — it is every clone that is not mid-seed,
 * which after the seed lands is the whole fleet. Two things have to be true at
 * once for it to bite, and both are ordinary: several migrations owed rather
 * than one, and a budget that runs out before the batch does. Then the clone
 * the table returns last is never reached, with small migrations instead of one
 * big seed.
 *
 * So there is a third key, and the reason the paragraph above rejected a clock
 * no longer holds. It rejected one for a good reason — `updated_at` is written
 * by the provisioning drain, the secret reconcilers and the parity sweep, so a
 * clone another lane touches often would read as freshly served — and for one
 * that has since stopped being true: "adding a column for it is a schema
 * change to carry a fact this lane already has". `migration_heartbeat_at` is
 * not added for this. It arrived so the reclaim sweep could tell a working pass
 * from a dead one, it is written by this lane and nothing else, and it survives
 * the release. Reading it here is free.
 *
 * It means "last CLAIMED" rather than "last served", and those are the same
 * thing now: `CLAIM_RESERVE_MS` means a claim is only taken with time to work
 * in. Nulls sort first, which is a clone this lane has never held.
 *
 * The fourth key is `clone_id`, and it is there so that the answer never
 * depends on the table's physical layout at all — not because two clones with
 * the same version, the same progress and the same claim time are expected, but
 * because "expected" is what the first version of this function assumed.
 */
export function compareMigrationQueue(a: MigrationQueueRow, b: MigrationQueueRow): number {
  // Nulls first: a backend that has never recorded a version is furthest
  // behind by definition.
  const av = a.migration_version ?? "";
  const bv = b.migration_version ?? "";
  if (av !== bv) {
    if (av === "") return -1;
    if (bv === "") return 1;
    return av < bv ? -1 : 1;
  }
  const ap = chunkCursorFor(a.chunk_cursor)?.statementsDone ?? 0;
  const bp = chunkCursorFor(b.chunk_cursor)?.statementsDone ?? 0;
  if (ap !== bp) return ap - bp;
  // Least recently CLAIMED by this lane, nulls first. Compared as strings
  // because an ISO-8601 UTC timestamp sorts lexicographically, and parsing a
  // date to compare two of them is a way to turn a malformed value into NaN.
  const ah = a.migration_heartbeat_at ?? null;
  const bh = b.migration_heartbeat_at ?? null;
  if (ah !== bh) {
    if (ah === null) return -1;
    if (bh === null) return 1;
    return ah < bh ? -1 : 1;
  }
  // A total order. Undefined on a caller that does not select it, in which case
  // this contributes nothing and the sort is as stable as it was.
  const ai = a.clone_id ?? "";
  const bi = b.clone_id ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** The eligible rows, in the order the pass should serve them. Never mutates. */
export function orderMigrationQueue<T extends MigrationQueueRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareMigrationQueue);
}
