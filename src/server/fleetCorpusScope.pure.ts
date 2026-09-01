/**
 * What a clone is allowed to be sent: the prime's REPO, narrowed to what the
 * prime's own DATABASE has actually applied.
 *
 * ## Why this exists
 *
 * The fleet sync's corpus used to be every `.sql` file under
 * `supabase/migrations/` in the prime repo. That reads like the obvious
 * definition and it is the wrong one, because a repository is a record of
 * everything anyone ever wrote, not of what is true of the running system.
 * Measured on this prime: 906 distinct versions in the repo, 864 in the
 * database's ledger. The 42-version gap is not drift to be closed — it is
 * files the prime deliberately never ran.
 *
 * Pushing that gap at a clone does not bring the clone level with the prime.
 * It takes the clone PAST the prime, into states no one has ever run in
 * production, one tenant database at a time and with nobody watching.
 *
 * ## What it cost, measured
 *
 * The first run that got far enough to try reached
 * `20250124120001_rollback_client_data_rls_policies.sql` and
 * `20250124130001_rollback_financial_data_rls_policies.sql` — two files whose
 * stated purpose is to UNDO a security fix — and applied both. 23 permissive
 * `USING (true) WITH CHECK (true)` policies, every one granted to `public`,
 * appeared on a tenant's client and financial tables: `client_files`,
 * `client_notes`, `cash_flow_analyses`, `portfolio_reviews` and six more. The
 * prime has none of them. Nothing was exposed only because that clone happens
 * to hold no rows yet.
 *
 * Those two files even carry a header asserting they are "harmless in practice
 * — clone backends are built by catalog introspection and have this version
 * stamped in their ledger, so it is never replayed". That was an assumption
 * about a caller, written in the callee, and it stopped being true the moment
 * a clone was stamped from the prime's ledger rather than from the repo. A
 * migration must be safe to replay or unreachable by construction; a comment
 * predicting that nobody will call it is neither.
 *
 * ## The rule
 *
 * **A clone never runs a migration the prime itself has not run.** The prime's
 * ledger is the authority on what the product's schema IS; the repo is the
 * authority on what each version SAYS. A version needs both to reach a tenant.
 *
 * This also disposes, without naming them one by one, of the 52 future-dated
 * files, the two rollback scripts, and anything a contributor leaves in the
 * tree that production never took.
 */

export type CorpusMeta = { id: string; name: string };

/**
 * Why a migration was withheld.
 *
 * The distinction is DIAGNOSTIC and never decides anything. See
 * {@link scopeCorpusToPrime} for why that separation is the whole point.
 */
export type WithheldReason =
  /** No prime ledger entry anywhere near this version. The prime never ran it. */
  | "never_applied"
  /**
   * A prime ledger entry exists within {@link SKEW_WINDOW_SECONDS}.
   *
   * Consistent with the apply-timestamp skew `docs/MIGRATION_PIPELINE.md`
   * records — Lovable stamps the ledger with the moment it applied a file, not
   * with the version in the filename, so `…091525` in the repo appears as
   * `…091523` in the ledger. It is a HYPOTHESIS for a person to confirm, not a
   * fact: two genuinely different migrations authored seconds apart look
   * identical to this test.
   */
  | "skew_suspected";

export type WithheldEntry<T> = {
  meta: T;
  reason: WithheldReason;
  /** The nearest prime ledger version, when one is inside the window. */
  nearestPrimeVersion?: string;
  /** Signed seconds from the repo version to that entry. */
  skewSeconds?: number;
};

export type WithheldBreakdown = {
  neverApplied: number;
  skewSuspected: number;
};

export type CorpusScope<T extends CorpusMeta> = {
  /** Versions the prime has applied — the only ones a clone may be sent. */
  runnable: T[];
  /**
   * In the repo, absent from the prime's ledger. Counted and named rather than
   * quietly filtered: "962 files, 4 applied" with no account of the other 958
   * is the shape of report that hides exactly this class of defect.
   */
  withheld: WithheldEntry<T>[];
  /** The same set, counted by reason, for a surface that shows one number. */
  breakdown: WithheldBreakdown;
};

/**
 * How far apart two versions can be and still be suspected of being the same
 * migration under two timestamps.
 *
 * Measured rather than picked: the observed skews on this prime are 2-3
 * seconds (`20250831091525` → `20250831091523`, `20251029030456` →
 * `20251029030453`). Ten seconds covers them with room to spare and is still
 * far tighter than the gap between migrations anybody authors deliberately.
 *
 * Widening it costs nothing in safety — the classification cannot promote a
 * migration — and costs precision in the report, which is the only thing it
 * feeds.
 */
export const SKEW_WINDOW_SECONDS = 10;

/**
 * `YYYYMMDDHHMMSS` → epoch seconds, or null when the id is not that shape.
 *
 * Null rather than a guess: a version this cannot parse is one the skew test
 * has no opinion about, and an unparsed id defaulting to 0 would sit fourteen
 * hundred years from every ledger entry and read as `never_applied` — which is
 * the correct answer for the wrong reason, and would stop being correct the
 * moment somebody adds a differently-shaped id.
 */
export function migrationEpochSeconds(version: string): number | null {
  if (!/^\d{14}$/.test(version)) return null;
  const y = Number(version.slice(0, 4));
  const mo = Number(version.slice(4, 6));
  const d = Number(version.slice(6, 8));
  const h = Number(version.slice(8, 10));
  const mi = Number(version.slice(10, 12));
  const sec = Number(version.slice(12, 14));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000;
}

/** Nearest value in a sorted array, by binary search. */
function nearest(sorted: readonly number[], target: number): number | null {
  if (sorted.length === 0) return null;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [sorted[lo]];
  if (lo > 0) candidates.push(sorted[lo - 1]);
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - target) < Math.abs(best - target)) best = c;
  }
  return best;
}

/**
 * Split the corpus, and say WHY each withheld migration was withheld.
 *
 * ## The classification never promotes
 *
 * `runnable` is decided by exact membership of the prime's ledger and by
 * nothing else. The skew test runs only over migrations that have ALREADY been
 * withheld, and its output reaches a report and an audit row — never the set
 * that is sent to a tenant.
 *
 * That separation is deliberate and load-bearing. It is tempting to close the
 * loop: if `…091525` is "obviously" the same migration as `…091523`, why not
 * run it? Because "obviously" is a guess about somebody else's timestamping,
 * and the thing on the other side of the guess is a tenant's database. The
 * corpus already contained two `rollback_*` scripts whose stated purpose is to
 * undo a security fix; a matching rule loose enough to bridge a three-second
 * skew is loose enough to bridge onto one of those.
 *
 * ## Why the breakdown exists at all
 *
 * `withheld: 828` on its own is unreadable, and unreadable in BOTH directions —
 * it can be waved away as "just the backlog" or panicked over as "the sync is
 * doing nothing". Neither reading is available once the number is split: on
 * this prime the great majority are `skew_suspected`, which is the known
 * two-namespace problem and harmless for a clone stamped from the prime's
 * ledger, and the remainder are `never_applied`, which is the set an operator
 * should actually look at.
 */
export function scopeCorpusToPrime<T extends CorpusMeta>(
  metas: readonly T[],
  primeApplied: ReadonlySet<string>,
): CorpusScope<T> {
  const runnable: T[] = [];
  const withheld: WithheldEntry<T>[] = [];

  // Built once for the whole corpus rather than per withheld migration.
  const ledgerEpochs: number[] = [];
  const epochToVersion = new Map<number, string>();
  for (const v of primeApplied) {
    const e = migrationEpochSeconds(v);
    if (e === null) continue;
    ledgerEpochs.push(e);
    if (!epochToVersion.has(e)) epochToVersion.set(e, v);
  }
  ledgerEpochs.sort((a, b) => a - b);

  for (const m of metas) {
    // The ONLY thing that decides runnable.
    if (primeApplied.has(m.id)) {
      runnable.push(m);
      continue;
    }

    const own = migrationEpochSeconds(m.id);
    const near = own === null ? null : nearest(ledgerEpochs, own);
    if (own !== null && near !== null && Math.abs(near - own) <= SKEW_WINDOW_SECONDS) {
      withheld.push({
        meta: m,
        reason: "skew_suspected",
        ...(epochToVersion.has(near) ? { nearestPrimeVersion: epochToVersion.get(near)! } : {}),
        skewSeconds: near - own,
      });
    } else {
      withheld.push({ meta: m, reason: "never_applied" });
    }
  }

  return {
    runnable,
    withheld,
    breakdown: {
      neverApplied: withheld.filter((w) => w.reason === "never_applied").length,
      skewSuspected: withheld.filter((w) => w.reason === "skew_suspected").length,
    },
  };
}

/**
 * Which runnable migrations may actually be SENT to one clone, given what that
 * clone already has and what the scope withheld.
 *
 * ## The hole this closes
 *
 * `scopeCorpusToPrime` decides `runnable` by exact membership of the prime's
 * ledger AND NOTHING ELSE — deliberately, and that part is right. But the
 * result is a SET, and migrations are a SEQUENCE. A version the prime's ledger
 * happens to record can therefore be handed to a clone while the version it
 * depends on — sitting earlier in the corpus, absent from that ledger — is
 * withheld from the same run.
 *
 * That is not hypothetical. Measured on `npc-client-dashboard`:
 * `20261012000000_builder_stock_auto_source_drain.sql` DEFINES
 * `ensure_builder_stock_settlement_scheduled()` and is absent from the prime's
 * ledger, so it was withheld. `20261027010000_builder_stock_ladder_generation.sql`
 * CALLS that function and IS in the ledger, so it was sent. The clone answered
 * `42883: function public.ensure_builder_stock_settlement_scheduled() does not
 * exist`, `applyPrimeMigrations` halted, and provisioning stopped at step 5 of
 * 7 — four steps short of `seedAdminUser`. The clone has 546 tables, no admin
 * user, and has been unusable since 2026-08-27. Three of the six versions the
 * prime's ledger records above that clone's frontier call that same withheld
 * function, so every provisioning attempt died the same way.
 *
 * ## Skip, do not halt
 *
 * The obvious repair is to stop the replay at the first hole. That is wrong
 * here for a specific reason: halting is what starved the admin seed. A clone
 * whose schema is 546 tables deep does not become more correct by refusing to
 * give it an owner — it becomes unreachable. So an orphan is SKIPPED and
 * named, the replay continues past it, and the pipeline reaches step 7.
 *
 * Skipping is also strictly safer than what happens today: today the orphan
 * RUNS, against a database missing what it needs, and whatever it managed to
 * do before the error is left behind. Not running it leaves the clone exactly
 * where it was.
 *
 * ## Why the barrier is every withheld version, not just the suspicious ones
 *
 * It is tempting to let `skew_suspected` entries pass — the prime almost
 * certainly ran those, under a differently-stamped id. But the skew is not
 * bounded by {@link SKEW_WINDOW_SECONDS} in practice: this prime's repo holds
 * `20250912170521` where its ledger holds `20250912050519`, twelve hours
 * apart and therefore classified `never_applied` by that window. A barrier
 * that trusted the classification would be trusting a test we can measure to
 * be wrong. So ANY corpus version this clone does not have and this run will
 * not send is a hole, and nothing after it is sent.
 *
 * The consequence is deliberate and must not be papered over: while the
 * prime's ledger under-reports its own schema, a clone advances very little
 * and this function says so, loudly, in `blockedBy`. That is the honest
 * reading of the fleet's real state — and it is the argument for reconciling
 * the ledger, not a reason to keep stepping over holes.
 */
export type OrphanedEntry<T> = {
  meta: T;
  /** Corpus versions before it that this clone has not got and will not be sent. */
  blockedBy: string[];
};

export type DependencyPartition<T> = {
  /** Runnable, in corpus order, with every predecessor accounted for. */
  send: T[];
  /** Runnable, but sitting behind at least one hole. Never sent. */
  orphaned: OrphanedEntry<T>[];
};

/**
 * @param metas        The whole corpus, in corpus order.
 * @param runnableIds  Ids `scopeCorpusToPrime` cleared — the prime has run these.
 * @param cloneApplied This clone's own ledger. A version it already holds is
 *                     not a hole, whatever the prime's ledger says about it.
 * @param maxBlockedBy Cap on the blockers recorded per orphan; the number of
 *                     holes can run to hundreds and this is read by a person.
 *                     The FIRST ones are kept — those are what an operator
 *                     would investigate.
 */
export function partitionByDependency<T extends CorpusMeta>(
  metas: readonly T[],
  runnableIds: ReadonlySet<string>,
  cloneApplied: ReadonlySet<string>,
  maxBlockedBy = 5,
): DependencyPartition<T> {
  const send: T[] = [];
  const orphaned: OrphanedEntry<T>[] = [];
  const holes: string[] = [];

  for (const m of metas) {
    // Already on this clone. Not a hole, and not ours to send again.
    if (cloneApplied.has(m.id)) continue;

    if (runnableIds.has(m.id)) {
      if (holes.length === 0) send.push(m);
      else orphaned.push({ meta: m, blockedBy: holes.slice(0, maxBlockedBy) });
      continue;
    }

    // Withheld by the scope and absent from this clone: a hole.
    holes.push(m.id);
  }

  return { send, orphaned };
}

/**
 * Is the prime's ledger usable as an authority at all?
 *
 * Returns the operator-facing refusal, or null when the run may proceed.
 *
 * Both refusals exist because the fallback is catastrophic in the same
 * direction. If a failed or empty read degraded to "use the whole repo", then
 * a transient fault on the prime would be indistinguishable from a prime that
 * has applied nothing — and both would answer by sending a clone every file in
 * the tree, which is the exact behaviour this module was written to stop. A
 * fleet sync that does nothing this tick costs half an hour. One that runs a
 * rollback script against a tenant costs a great deal more.
 */
export function assertPrimeLedgerUsable(input: {
  failed: boolean;
  errorMessage?: string | null;
  appliedCount: number;
  primeRef: string;
}): string | null {
  if (input.failed) {
    return (
      `Could not read the prime backend's migration ledger (${input.primeRef}): ` +
      `${input.errorMessage ?? "unknown error"}. Refusing to sync — a ledger that could ` +
      "not be read is not a prime that has applied nothing, and the fallback would be to " +
      "send clones every file in the repo."
    );
  }
  if (input.appliedCount === 0) {
    return (
      `The prime backend (${input.primeRef}) reports no applied migrations. Refusing to ` +
      "sync: with no authority for what the prime has actually run, every repo file — " +
      "including rollback scripts and future-dated work — would qualify to run on a tenant."
    );
  }
  return null;
}
