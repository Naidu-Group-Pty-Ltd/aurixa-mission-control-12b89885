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

import { isMachineStampedMigration } from "./migrationBodyIdentity.pure";
import { versionUnits } from "./sharedVersionDelivery.pure";

export type CorpusMeta = {
  id: string;
  name: string;
  /**
   * Digests of this file's body, most literal form first, as
   * `migrationBodyForms` orders them. See `migrationBodyIdentity.pure.ts`.
   *
   * Optional, and its three states are three different facts:
   *
   * - **absent** — nobody asked. Every caller that does not read bodies is
   *   unchanged by this field's existence, and scopes exactly as it did when
   *   only the version could clear a migration.
   * - **empty array** — asked, and the body could not be read: past the size
   *   ceiling, or the fetch failed. Withheld as `body_unread`, because a read
   *   that FAILED is not a body that matched nothing.
   * - **non-empty** — asked and answered. These are the digests that may
   *   clear it.
   */
  bodyDigests?: readonly string[];
  /**
   * Object names this migration creates, from `dependencyFactsOf`.
   *
   * Three states, and they are the three `bodyDigests` has, for the same
   * reason: **absent** means nobody asked and the barrier falls back to the
   * blanket rule for this migration; **empty** means asked and it creates
   * nothing, so nothing can be waiting for it; **non-empty** is what a
   * candidate's `requires` is intersected against.
   *
   * A body that could not be READ must leave this absent rather than empty —
   * an unread file that creates ten tables would otherwise be declared unable
   * to block anything.
   */
  creates?: readonly string[];
  /** Object names it resolves at the statement. Same three states as {@link creates}. */
  requires?: readonly string[];
};

/**
 * Why a migration was withheld.
 *
 * The distinction is DIAGNOSTIC and never decides anything. See
 * {@link scopeCorpusToPrime} for why that separation is the whole point.
 */
export type WithheldReason =
  /**
   * The prime's ledger holds neither this version nor these bytes.
   *
   * Since the body test exists this is a strong reading rather than a
   * default: the prime stores the SQL of everything it ran, and none of it
   * is this.
   */
  | "never_applied"
  /**
   * The bodies disagree, and a MACHINE-STAMPED ledger entry sits within
   * {@link SKEW_WINDOW_SECONDS}.
   *
   * This used to be the interesting half of the withheld set and is now the
   * residue. Lovable stamps the ledger with the moment it APPLIED a file, not
   * with the version in the filename, so `…091525` in the repo appears as
   * `…091523` in the ledger — and that pair is now settled by its body
   * (byte-identical, 151 bytes) rather than by its clock. What is left here is
   * a near-in-time row whose SQL is NOT this file's, which is a weaker signal
   * than it was before anything could check: two different migrations authored
   * seconds apart look identical to a clock and always did.
   *
   * It is a hypothesis for a person, and it is offered only where the version
   * is a real instant — see {@link isMachineStampedMigration}.
   */
  | "skew_suspected"
  /**
   * The body could not be read, so the body test never ran.
   *
   * Its own reason because "we could not check" is not "it does not match".
   * A file past the digest ceiling, or one GitHub would not serve this tick,
   * lands here and is withheld exactly as it was before bodies were read —
   * fail-closed, and saying which kind of silence it is.
   */
  | "body_unread";

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
  bodyUnread: number;
};

/**
 * How a migration came to be runnable.
 *
 * Returned beside `runnable` rather than folded into it: five call sites
 * consume that array as plain metas and none of them wants provenance, while
 * the reading an operator has to act on wants nothing else.
 */
export type RunnableVia =
  /** The prime's ledger records this exact version string. */
  | "version"
  /** The prime's ledger holds a body whose executable bytes are this file's. */
  | "body";

export type RunnableEntry = {
  id: string;
  via: RunnableVia;
  /** Which form matched — index into `migrationBodyForms`. Body clearances only. */
  formIndex?: number;
  /** The matching digest. Body clearances only. */
  digest?: string;
  /**
   * Other corpus files carrying the same digest, if any.
   *
   * Recorded, never acted on. Every rung of the ladder removes only bytes
   * that cannot execute, so files that collide here have identical executable
   * bytes and running any of them runs what the prime ran — measured at 11
   * collisions on this prime, 0 with differing executable bytes. What the
   * collision costs is the ability to say WHICH file the ledger row was, and
   * a surface that claimed that anyway would be inventing it.
   */
  sharedWith?: string[];
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
  /** Why each runnable migration is runnable, in `runnable` order. */
  runnableBy: RunnableEntry[];
};

/**
 * How far apart two MACHINE-STAMPED versions can be and still be suspected of
 * being the same migration under two timestamps.
 *
 * Measured, and the measurement is the reason it was not simply widened. Of
 * the 617 machine-stamped files whose bodies the prime's ledger holds, 524
 * were stamped within this window, **86 between 11 and 60 seconds**, and 7
 * about twelve hours out (`20250912170521` in the repo, `20250912050519` in
 * the ledger). Ten seconds therefore explains 85% of a real phenomenon and
 * the obvious repair — widen it to 120 — would have explained 99% of it while
 * still being a guess about somebody else's clock.
 *
 * It is left at ten because it no longer decides anything worth widening for.
 * Every one of those 617 is now cleared by its BODY, which is not a guess at
 * all; what remains is a diagnostic sentence beside a withheld file, and a
 * tight window makes that sentence mean something. A 120-second window over a
 * corpus where 300 files were authored in one afternoon would attach a
 * "nearest prime version" to almost everything and inform nobody.
 *
 * It never promotes, it is asked only where the version is a real instant,
 * and it is asked only after the body test has already said no.
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
 * ## What decides `runnable`
 *
 * Two facts, and only these two: the prime's ledger records this exact
 * VERSION, or it holds a BODY whose executable bytes are this file's.
 *
 * The second is new, and it is what this module's own header has asked for
 * since it was written — "it is the argument for reconciling the ledger, not
 * a reason to keep stepping over holes". Measured 22 Sep 2026: on the version
 * alone, 180 of 1,002 files cleared and the rest became barriers that
 * orphaned everything behind them. On the version OR the body, 785 clear.
 *
 * It is not a loosening. The objection the old header raised — that a rule
 * elastic enough to bridge a three-second skew is elastic enough to bridge
 * onto `rollback_client_data_rls_policies.sql` — is exactly right about
 * TIMESTAMPS and does not touch bodies. A rollback script can only clear here
 * if the prime's ledger holds its SQL, which is the same as saying the prime
 * ran it. The body test cannot bridge anywhere; it can only confirm.
 *
 * It is also strictly stronger than the version test, which this corpus can
 * fool: 24 versions are carried by 59 files (23 Sep 2026, withdrawals removed;
 * 32 over 77 on 20 Sep), and a version the ledger records clears every file
 * carrying it — including one the prime may never have run, which nothing here
 * can tell apart. See `sharedVersionDelivery.pure.ts`.
 *
 * ## The skew test is a TIME test and only speaks about times
 *
 * It runs over migrations that have already been withheld, it reaches a
 * report and never the set sent to a tenant, and it is now asked only where
 * the version is a real instant. A hand-named `20260730190000_…phase3.sql`
 * carries a sequence number, not a clock; of the hand-named files this prime
 * HAS run, every one sat outside the window. Answering `never_applied` there
 * is the right answer for no reason at all, and `skew_suspected` would be a
 * confident statement derived from a number that is not a time.
 *
 * @param primeBodyDigests Digests of every body the prime's ledger holds, by
 *   {@link LEDGER_BODY_DIGEST_SQL}. Omitted — or empty — and nothing clears by
 *   body, which is precisely the behaviour before bodies were read. The empty
 *   digest is never admitted; the caller strips it.
 */
export function scopeCorpusToPrime<T extends CorpusMeta>(
  metas: readonly T[],
  primeApplied: ReadonlySet<string>,
  primeBodyDigests: ReadonlySet<string> = new Set(),
): CorpusScope<T> {
  const runnable: T[] = [];
  const runnableBy: RunnableEntry[] = [];
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

  // Which corpus files claim each digest. Reported, never acted on — see
  // RunnableEntry.sharedWith.
  const claimants = new Map<string, string[]>();
  for (const m of metas) {
    for (const d of m.bodyDigests ?? []) {
      const seen = claimants.get(d);
      if (seen) seen.push(m.name);
      else claimants.set(d, [m.name]);
    }
  }

  for (const m of metas) {
    if (primeApplied.has(m.id)) {
      runnable.push(m);
      runnableBy.push({ id: m.id, via: "version" });
      continue;
    }

    const forms = m.bodyDigests;
    const formIndex = forms?.findIndex((d) => primeBodyDigests.has(d)) ?? -1;
    if (forms && formIndex >= 0) {
      const digest = forms[formIndex];
      const shared = (claimants.get(digest) ?? []).filter((n) => n !== m.name);
      runnable.push(m);
      runnableBy.push({
        id: m.id,
        via: "body",
        formIndex,
        digest,
        ...(shared.length > 0 ? { sharedWith: shared } : {}),
      });
      continue;
    }

    // Asked, and the body could not be read. Not the same as a body that
    // failed to match, and not counted as one.
    if (forms && forms.length === 0) {
      withheld.push({ meta: m, reason: "body_unread" });
      continue;
    }

    const own = isMachineStampedMigration(m.name) ? migrationEpochSeconds(m.id) : null;
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
    runnableBy,
    withheld,
    breakdown: {
      neverApplied: withheld.filter((w) => w.reason === "never_applied").length,
      skewSuspected: withheld.filter((w) => w.reason === "skew_suspected").length,
      bodyUnread: withheld.filter((w) => w.reason === "body_unread").length,
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
 *
 * That reconciliation has since been done, and in the only way that does not
 * weaken the barrier: `scopeCorpusToPrime` now clears a migration whose BODY
 * the prime's ledger holds, so 605 of the versions that used to be holes are
 * holes no longer — not because the barrier was relaxed, but because the
 * evidence that they ran was finally read. The twelve-hour case above is
 * exactly one of them, and it is settled by its bytes rather than by a window
 * wide enough to contain it.
 *
 * ## And the barrier is per-dependency now, not blanket
 *
 * Everything above is about WHICH versions are holes. This is about what a
 * hole is entitled to stop, and the blanket answer — everything after it —
 * was wrong by a margin that only a thinly-stamped clone makes visible.
 *
 * Measured 22 Sep 2026 on `qvuwrvwzjyigptmnijyb`, the CRM clone, against the
 * prime's 1,021-file corpus and that clone's live ledger:
 *
 *     blanket          would_send    0 | orphaned  35 | holes 212
 *     per-dependency   would_send   34 | orphaned   1 | holes 212
 *
 * Its first hole is at corpus ordinal **1**:
 * `20250124120000_fix_client_data_rls_policies.sql`, a policy fix from January
 * 2025 that creates no object any later file can name. Under the blanket rule
 * that one file had shut that clone's cascade since it was provisioned — not
 * slowed it, shut it, `would_send 0` on every tick.
 *
 * So a hole now stops a candidate only where the hole CREATES an object the
 * candidate REQUIRES, read from the two files' SQL by
 * `migrationDependencyFacts.pure.ts` — which is the prime's own extractor,
 * ported rather than re-decided. The one migration still orphaned above is
 * `20260921060000`, which needs `market_updates`, `market_ingestion_runs` and
 * `market_source_fetch_runs`; the holes `20260703000000` and `20260725010000`
 * create them. That is the `20261027010000` incident class, caught, with the
 * blast radius it actually has.
 *
 * **Unread is never narrowed.** The facts are optional and their absence means
 * nobody asked, so a hole whose body could not be read blocks everything after
 * it exactly as before, and a candidate whose body could not be read is
 * blocked by every hole before it exactly as before. A caller that supplies no
 * facts at all gets byte-identical behaviour to the blanket rule — which is
 * what makes this safe to land ahead of the wiring that feeds it.
 */
export type OrphanedEntry<T> = {
  meta: T;
  /**
   * The holes that actually block it — the ones creating an object it
   * requires, where both sides' facts were read, and every earlier hole where
   * either side's were not.
   */
  blockedBy: string[];
  /**
   * The object names it is waiting for, where those could be read.
   *
   * Empty when the blocking was decided by the blanket fallback, which is the
   * honest reading: under that rule an orphan is not waiting for anything in
   * particular, it is behind a hole nobody could ask about.
   */
  blockedOn?: string[];
};

export type DependencyPartition<T> = {
  /** Runnable, in corpus order, with every predecessor accounted for. */
  send: T[];
  /** Runnable, but sitting behind at least one hole. Never sent. */
  orphaned: OrphanedEntry<T>[];
  /**
   * Every corpus version the prime's ledger does not record and this clone
   * does not have, in corpus order.
   *
   * Returned because it was not, and a hole that withholds nothing was
   * therefore invisible everywhere. This array was accumulated and discarded,
   * so a hole reached an operator only as the `blockedBy` of an orphan sitting
   * after it — and a hole at the TAIL of the corpus has no orphan after it. It
   * withholds nothing from the clone, which is exactly why nothing reported
   * it, and it still means the prime is behind its own repository. Four such
   * versions sat unrecorded on the prime for days in September 2026 and were
   * found by a person reading the ledger by hand.
   *
   * A hole is a fact about the PRIME. Whether anything is queued behind it is
   * a separate fact about the corpus, and `orphaned` is where that second one
   * lives.
   */
  holes: string[];
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

  /**
   * Hole version -> the objects it creates, for the holes whose bodies were
   * read. A hole ABSENT from this map is opaque: nobody could read it, so it
   * blocks everything after it exactly as every hole used to.
   */
  const provides = new Map<string, ReadonlySet<string>>();

  /** The holes so far that one FILE is blocked by, and what it waits for. */
  const judge = (m: T): { blockedBy: ReadonlySet<string>; blockedOn: ReadonlySet<string> } => {
    // Its own requirements could not be read. Every hole before it stands.
    if (m.requires === undefined) return { blockedBy: new Set(holes), blockedOn: new Set() };
    const needs = new Set(m.requires);
    const blockedBy = new Set<string>();
    const blockedOn = new Set<string>();
    for (const hole of holes) {
      const creates = provides.get(hole);
      if (creates === undefined) {
        // An opaque hole. Conservative, and the blanket rule's behaviour.
        blockedBy.add(hole);
        continue;
      }
      for (const need of needs) {
        if (creates.has(need)) {
          blockedOn.add(need);
          blockedBy.add(hole);
        }
      }
    }
    return { blockedBy, blockedOn };
  };

  /*
    A VERSION IS THE UNIT, NOT A FILE.

    Both ledgers this reads speak in versions, and a version several files
    share is recorded ONCE for all of them — so a file is not sendable on its
    own merits while a sibling is blocked, and a withheld version is one hole
    however many files carry it. Walked per file, a shared version sent the
    sibling a hole did not reach while the other waited, and the replay then
    recorded the version: the waiting file was never sent by anything again.
    The unit is sent whole or held whole, and it is held behind the UNION of
    what blocks each of its files. See `sharedVersionDelivery.pure.ts`.

    A version one file carries — every version but a handful — is a unit of
    one, and walks exactly as it always did.
  */
  for (const unit of versionUnits(metas)) {
    // Already on this clone. Not a hole, and not ours to send again.
    if (cloneApplied.has(unit.version)) continue;

    if (runnableIds.has(unit.version)) {
      // Nothing withheld before it: nothing to ask about.
      if (holes.length === 0) {
        send.push(...unit.members);
        continue;
      }

      const blockedBy = new Set<string>();
      const blockedOn = new Set<string>();
      for (const m of unit.members) {
        const judged = judge(m);
        for (const hole of judged.blockedBy) blockedBy.add(hole);
        for (const need of judged.blockedOn) blockedOn.add(need);
      }

      if (blockedBy.size === 0) {
        send.push(...unit.members);
        continue;
      }
      // In hole order, which is corpus order: the FIRST are what an operator
      // would investigate.
      const first = holes.filter((h) => blockedBy.has(h)).slice(0, maxBlockedBy);
      for (const m of unit.members) {
        orphaned.push({
          meta: m,
          blockedBy: [...first],
          ...(blockedOn.size > 0 ? { blockedOn: [...blockedOn].slice(0, maxBlockedBy) } : {}),
        });
      }
      continue;
    }

    // Withheld by the scope and absent from this clone: ONE hole, however
    // many files carry the version. What it creates is known only where every
    // file's creations were read — one unread file makes the whole hole
    // opaque, because that file might create anything.
    holes.push(unit.version);
    if (unit.members.every((m) => m.creates !== undefined)) {
      provides.set(unit.version, new Set(unit.members.flatMap((m) => m.creates ?? [])));
    }
  }

  return { send, orphaned, holes };
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
