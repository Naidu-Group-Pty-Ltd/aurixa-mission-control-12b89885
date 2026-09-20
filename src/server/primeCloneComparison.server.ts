/**
 * Hold one clone against the prime and say whose problem each blockage is.
 *
 * The judgement is `primeCloneComparison.pure.ts`. This file gathers, and it
 * gathers from three places that fail independently:
 *
 *   - `clones` — the code position Mission Control recorded for this clone;
 *   - `clone_backends` — the migration cursor its last pass wrote;
 *   - `clone_sync_blockages` — every open reason it is not converging.
 *
 * ## Why the roster and the comparison are one call
 *
 * The selector must work even when the comparison cannot be made — a refused
 * GitHub window, a prime backend that is not configured, a clone whose
 * blockage read failed. If the roster rode the comparison's success, the one
 * state an operator most needs the page in would be the state with no way to
 * pick a different clone. So the roster is read first, on its own, and is
 * returned whatever happens to everything after it.
 *
 * ## The prime's side is handed in, never read here
 *
 * `primeHeadSha` and `frontier` are the authority the comparison turns on, and
 * both are resolved by the caller against `prime_config` — under the ADMIN
 * client, because RLS filters rather than erroring and a policy that declined
 * that read would be indistinguishable from a deployment with no prime
 * configured. The fleet tables below are read under the CALLER'S client, so
 * this page cannot become a way to see rows an operator could not see
 * directly. Two clients, two different reasons, and neither is interchangeable
 * with the other.
 *
 * Nothing here accepts either value from a browser. A request field asserting
 * what the server is being asked to decide is the pattern IPV 1.1.0 was
 * written to forbid.
 *
 * ## Read-only
 *
 * It writes nothing. Not a blockage, not a cursor, not an audit row. The
 * blockage ledger is written by one pass and read by every surface, which is
 * the rule `blockageLedger.contract.test.ts` asserts by source position, and a
 * page that classified a clone into the table it reads would be describing its
 * own writes back to itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  buildCloneComparison,
  compareBlockers,
  readCodeStanding,
  readMigrationStanding,
  type BlockageRow,
  type CloneComparison,
} from "./primeCloneComparison.pure";

type Db = SupabaseClient<Database>;

/** One entry in the selector. Enough to name the clone and nothing more. */
export type CloneChoice = {
  id: string;
  label: string;
  slug: string;
  repoFullName: string | null;
  syncScope: string | null;
  syncStatus: string | null;
};

export type CloneComparisonResult = {
  /** Always present when the roster read succeeded, whatever else failed. */
  clones: CloneChoice[];
  /** Null when the roster itself could not be read — not an empty fleet. */
  rosterError: string | null;
  /** The selected clone's reading, or null when nothing is selected. */
  comparison: CloneComparison | null;
  /** Why a requested comparison produced nothing. */
  comparisonError: string | null;
  readAt: string;
};

/**
 * `.select()` takes ONE literal string.
 *
 * Built with `+` or a template, PostgREST's types cannot resolve the row shape
 * and every column reads as `GenericStringError` — nine of them on the first
 * pass of the health page, each surfacing as a property that "does not exist".
 * It is long; it is not splittable.
 */
const CLONE_COLUMNS =
  "id, name, slug, repo_full_name, github_owner, github_repo, sync_scope, sync_status, last_synced_sha, commits_behind";

export async function comparePrimeAgainstClone(
  supabase: Db,
  args: {
    cloneId: string | null;
    /** Prime's head, as the caller resolved it. Null when it could not be read. */
    primeHeadSha: string | null;
    /** The newest version the prime has both merged and run. */
    frontier: string | null;
    /** Every runnable version, ascending. Null when the scope was not computed. */
    runnableVersions: string[] | null;
  },
): Promise<CloneComparisonResult> {
  const readAt = new Date().toISOString();

  const roster = await supabase.from("clones").select(CLONE_COLUMNS).order("name");

  const clones: CloneChoice[] = (roster.data ?? []).map((c) => ({
    id: c.id,
    label: c.name ?? c.github_repo ?? c.slug,
    slug: c.slug,
    repoFullName: c.repo_full_name ?? `${c.github_owner}/${c.github_repo}`,
    syncScope: c.sync_scope ?? null,
    syncStatus: c.sync_status ?? null,
  }));

  const base = {
    clones,
    // A roster that FAILED is named. `[]` on an error would report an empty
    // fleet to a console whose whole subject is the fleet.
    rosterError: roster.error ? roster.error.message : null,
    comparison: null,
    comparisonError: null,
    readAt,
  } satisfies CloneComparisonResult;

  if (!args.cloneId) return base;

  const chosen = (roster.data ?? []).find((c) => c.id === args.cloneId);
  if (!chosen) {
    return {
      ...base,
      comparisonError: roster.error
        ? `The fleet roster could not be read (${roster.error.message}), so this clone could not be resolved.`
        : "That clone is not in this deployment's roster.",
    };
  }

  const label = chosen.name ?? chosen.github_repo ?? chosen.slug;

  /*
    A frontier the caller could not establish is null, and stays null.

    `readMigrationStanding` renders that as `unknown` with its own sentence.
    The code position and the open blockages are Mission Control's own rows
    and are still true, so one unavailable reading costs its own half and
    never the whole comparison.
  */
  const { frontier, runnableVersions } = args;

  const [backend, blockages] = await Promise.all([
    supabase
      .from("clone_backends")
      .select("migration_version, migration_blocked_reason, status, status_detail")
      .eq("clone_id", chosen.id)
      .maybeSingle(),
    supabase
      .from("clone_sync_blockages")
      .select("id, class, owner, detail, first_seen_at, self_heals")
      .eq("clone_id", chosen.id)
      .is("cleared_at", null)
      .order("first_seen_at", { ascending: true }),
  ]);

  const comparison = buildCloneComparison({
    cloneId: chosen.id,
    label,
    repoFullName: chosen.repo_full_name ?? `${chosen.github_owner}/${chosen.github_repo}`,
    syncScope: chosen.sync_scope ?? null,
    code: readCodeStanding({
      primeHeadSha: args.primeHeadSha,
      syncedSha: chosen.last_synced_sha ?? null,
      commitsBehind: typeof chosen.commits_behind === "number" ? chosen.commits_behind : null,
      label,
    }),
    migrations: readMigrationStanding({
      frontier,
      runnableVersions,
      // A backend row that FAILED to read is not a clone with no cursor. The
      // standing reads `unknown` either way, but the sentence differs and the
      // error is what an operator acts on.
      recordedVersion: backend.error ? null : (backend.data?.migration_version ?? null),
      blockedReason: backend.error ? null : (backend.data?.migration_blocked_reason ?? null),
      label,
    }),
    // `null` and never `[]`: "nothing is blocking this clone" is a claim, and
    // a query that did not answer cannot make it.
    blockers: blockages.error ? null : compareBlockers((blockages.data ?? []) as BlockageRow[]),
    blockersError: blockages.error ? blockages.error.message : null,
  });

  return {
    ...base,
    comparison,
    comparisonError: backend.error
      ? `This clone's backend record could not be read: ${backend.error.message}`
      : null,
  };
}
