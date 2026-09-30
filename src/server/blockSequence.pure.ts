/**
 * A block recorded against a sequence the lane no longer sends.
 *
 * ## The deadlock
 *
 * `migration_blocked_at` holds a clone out of the fleet lane until the clone's
 * own ledger records the version the block names (`blockIsDischarged`). That
 * rule is right for a migration the clone genuinely rejected. It can never be
 * satisfied by a block the LANE caused by sending migrations in the wrong
 * order: the named version enters the ledger only by being applied, a blocked
 * clone is sent nothing, and the migration that would let it apply is exactly
 * what it is no longer sent.
 *
 * Measured 26 Sep 2026: `npc-crm-independent` had read `failed` since
 * 22 Sep 20:31 UTC, blocked at
 * `20261204030000_refresh_active_masters_from_library_v15.sql` with
 * `42P01: relation "public.template_library_release_baselines" does not
 * exist`. That table is created by `20261204020000`, the v15 SEED. The same
 * pass's record shows the seed held back — a 41 MB body the lane could not
 * read, behind the clone's holes — and the refresh sent anyway: before
 * 23 Sep a held version was not a barrier to the versions after it, so a
 * refresh reached a clone ahead of the seed it reads. That was fixed on
 * 23 Sep (a held version is a barrier, and a refresh waits for the seed it
 * names), and the seeds have been readable through the prime's skeletons
 * since. The lane would now send the seed first. But the block still named the
 * refresh, the ledger still lacked it, and the clone had received nothing for
 * nearly four days while the prime moved on without it.
 *
 * ## The rule
 *
 * **A block holds back the version it names. Once the lane would send this
 * clone an EARLIER version first, the block is holding back the wrong thing.**
 * The replay walks versions in order and halts at the first failure, so the
 * earlier version is applied — or held, or fails in its own name — before the
 * named one is reached again. If the named version then fails for its own
 * reasons, the block is written again, and nothing earlier is left to
 * discharge it: the rule cannot loop, because every discharge needs an
 * earlier unapplied version, and each one it finds is sent first.
 *
 * Three things it deliberately does not discharge:
 *
 * - **The named version is still first.** Re-sending it would fail the same
 *   way. This is every block written against a migration the clone really
 *   rejected, and it keeps the ledger test's evidence rule intact.
 * - **Nothing is sendable, or only LATER versions are.** The partition
 *   alone cannot promise the named version stays unsent there: the replay's
 *   orphan rescue reads bodies this module does not and can readmit it, and
 *   a rule that discharged on that shape would re-send and re-block the same
 *   migration every sweep.
 * - **A reason that names no version.** Nothing can be proved about it —
 *   `blockedVersionFrom`'s rule, shared rather than restated.
 *
 * The verdict comes from the lane's own partition over the clone's own ledger,
 * the same two inputs the replay decides from, so it cannot license a send the
 * replay would refuse.
 */
import { partitionByDependency, type CorpusMeta } from "./fleetCorpusScope.pure";
import { blockedVersionFrom } from "./fleetMigrationEligibility.pure";

export type BlockSequenceVerdict =
  | {
      readonly discharged: true;
      /** The version the block named. */
      readonly blockedVersion: string;
      /** The earlier version the lane would now send this clone first. */
      readonly nextVersion: string;
      readonly why: string;
    }
  | { readonly discharged: false; readonly why: string };

export function blockOvertakenBySequence<T extends CorpusMeta>(input: {
  readonly reason: string | null | undefined;
  /** The scoped corpus, in corpus order, carrying what the pass read. */
  readonly metas: readonly T[];
  /** The versions the scope cleared whole. */
  readonly runnableIds: ReadonlySet<string>;
  /** The clone's own ledger — the union the replay skips. */
  readonly cloneApplied: ReadonlySet<string>;
}): BlockSequenceVerdict {
  const blocked = blockedVersionFrom(input.reason);
  if (!blocked) return { discharged: false, why: "the block names no version" };
  if (input.cloneApplied.has(blocked)) {
    // Not this rule's to answer: the ledger test discharges it on evidence.
    return { discharged: false, why: `the clone's ledger already records ${blocked}` };
  }

  // Capped at one blocker per orphan: only `send` is read here, and the cap
  // bounds what is recorded, never what is decided.
  const { send } = partitionByDependency(input.metas, input.runnableIds, input.cloneApplied, 1);
  const next = send[0]?.id;
  if (next === undefined) {
    return {
      discharged: false,
      why: "the lane would send this clone nothing, so nothing shows the order it failed in has changed",
    };
  }
  if (next === blocked) {
    return {
      discharged: false,
      why: `${blocked} is still the first version the lane would send, and it would fail the same way`,
    };
  }
  if (next > blocked) {
    return {
      discharged: false,
      why: `nothing earlier than ${blocked} is left to send — the lane's next version, ${next}, comes after it`,
    };
  }
  return {
    discharged: true,
    blockedVersion: blocked,
    nextVersion: next,
    why:
      `the lane would now send ${next} first — an earlier version this clone has never ` +
      `applied — so ${blocked} is not reached again until it has landed`,
  };
}
