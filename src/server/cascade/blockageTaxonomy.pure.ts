/**
 * Every reason a clone is not converging, with an owner and a clock.
 *
 * ## The rule
 *
 * **A blockage may be silent, or it may be permanent. It may never be both.**
 *
 * That one sentence is the whole contract, and it is what the September freeze
 * cost. From 14 to 16 Sep 2026 the fleet froze at prime@66c49f8 while prime
 * moved 118 commits and the engine worked continuously. Every individual
 * signal was correct: the pull request body named the held files, the run
 * notification said "1 awaiting manual reconcile" (the same words it says on a
 * healthy run), and the drain held the proposal with a true sentence about
 * failing checks. Nothing distinguished "waiting on CI" from "will fail for
 * ever until a person acts", so nobody acted.
 *
 * The auditor (`convergence.pure.ts`) says WHETHER a clone is converging. This
 * says WHY it is not, and — more importantly — **who can clear it**. The owner
 * is the field everything else turns on: it decides whether the custodian may
 * touch a blockage at all, and it is declared here, once, rather than carried
 * as a private list by whatever wants to act.
 *
 * ## Why an incomplete taxonomy is still sound
 *
 * The list below cannot be exhaustive. The next freeze will take a path nobody
 * has walked, which is the whole reason this design exists rather than another
 * guard. So the taxonomy is built to fail in the right direction:
 *
 * **If the auditor says a clone is stalled and no detector here fires, that
 * absence is itself the finding.** `unclassified` is owned by a PERSON, never
 * self-heals, and is the loudest thing in the table. A condition nobody
 * anticipated therefore arrives as a named gap rather than as silence — which
 * is the difference between this and every mechanism that preceded it.
 *
 * ## What this must never do
 *
 * It classifies. It repairs nothing, notifies nobody and merges nothing.
 * `ci_red` in particular is a GENUINE breakage: prime shipped something the
 * clone's CI refuses, the gate is doing its job, and the only thing that
 * changes here is that it stops producing the same silence as a proposal
 * waiting on a runner. `selfHeals` is `false` on it and a test asserts that no
 * future edit can flip it.
 *
 * Client-safe: pure, and its only imports are the two constants the drain
 * itself runs on.
 */
import { MAX_ATTEMPTS, STALL_MINUTES } from "./drainLimits.pure";

/**
 * Who can actually clear this. The custodian reads it as a permission, so a
 * misfiled owner is a permission bug rather than a labelling one.
 *
 *  - `machinery`    — nothing about the code is wrong; a pass has to be
 *                     re-run, a stale record repaired, a policy seeded.
 *  - `operator`     — a decision only a person may record: an approval, a
 *                     held-file reconcile, a closed proposal, a repository
 *                     nobody can reach.
 *  - `prime_author` — prime shipped something the clone's CI refuses.
 *  - `account_owner`— a billing or account setting outside this repository.
 */
export type BlockageOwner = "machinery" | "operator" | "prime_author" | "account_owner";

export type BlockageClass =
  | "policy_unseeded"
  | "repo_retargeted"
  | "unreconciled_proposal"
  | "attempts_exhausted"
  | "partial_clone_dropped"
  | "approval_pending"
  | "deferred_far_future"
  | "event_stuck_running"
  | "invocation_cut"
  | "consecutive_failures"
  | "ci_red"
  | "prime_ledger_hole"
  | "unclassified";

export type BlockagePolicy = {
  owner: BlockageOwner;
  /**
   * May a custodian re-run the work that clears this, without any new
   * decision being taken?
   *
   * `true` means the blockage is a fact about the machinery — a spent window,
   * a stale URL, an unseeded policy — and re-running is not a judgement.
   * `false` means clearing it requires somebody to decide something, and no
   * amount of retrying substitutes for that.
   */
  selfHeals: boolean;
  /**
   * Is this only a blockage while the clone is actually short of something?
   *
   * Most classes describe a DELIVERY that went wrong, and a delivery that
   * went wrong costs nothing once the clone holds everything it is owed — a
   * commit cascade delivers prime's head at run time, so a later pass
   * supersedes a failed one entirely. Reporting those against a converged
   * clone would fill the ledger with history, which is how a list of open
   * problems stops being read.
   *
   * The classes that are `false` are STANDING faults: they are wrong right
   * now whatever today's convergence says, and they will be wrong for the
   * next cascade too.
   */
  conditionedOnDivergence: boolean;
  /** One line an operator reads. Never database vocabulary. */
  what: string;
};

export const BLOCKAGE_POLICY: Record<BlockageClass, BlockagePolicy> = {
  policy_unseeded: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: false,
    what: "This clone mirrors the whole tree and has no exclusion policy, so every cascade into it is refused.",
  },
  repo_retargeted: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: false,
    what: "Proposals were recorded against a repository owner this clone no longer has, so no reconcile can ever reach them.",
  },
  unreconciled_proposal: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: false,
    what: "A proposal has been open longer than a delivery window without its record being brought up to date.",
  },
  attempts_exhausted: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "The delivery was retired after spending its attempts, and nothing will offer it again.",
  },
  partial_clone_dropped: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "A delivery finished for the rest of the fleet and failed for this clone, and the record settled anyway.",
  },
  approval_pending: {
    owner: "operator",
    selfHeals: false,
    conditionedOnDivergence: true,
    what: "A delivery is waiting on a second operator's approval and will not move until somebody gives it.",
  },
  deferred_far_future: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "A delivery is parked further out than any provider reset should place it.",
  },
  event_stuck_running: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "A delivery has been marked as running for longer than any pass survives.",
  },
  invocation_cut: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "Passes keep being cut off before they finish, so the same work is re-bought and never lands.",
  },
  consecutive_failures: {
    owner: "machinery",
    selfHeals: true,
    conditionedOnDivergence: true,
    what: "This clone has failed its last several deliveries while the fleet kept moving.",
  },
  ci_red: {
    /*
      THE ONE THAT MUST NEVER BE HEALED.

      A proposal going red because prime shipped something the clone's checks
      refuse is the system working — the clone's CI is the gate, which is the
      stated reason `pr` mode exists. Nothing retries it, nothing rebuilds it
      hoping for a different answer, nothing merges it. What changes is only
      that it stops producing the same silence as a proposal waiting on a
      runner.
    */
    owner: "prime_author",
    selfHeals: false,
    conditionedOnDivergence: true,
    what: "The clone's own checks refuse this delivery, and they will go on refusing it until the code changes.",
  },
  prime_ledger_hole: {
    /*
      THE ONE THE LEDGER COULD NOT SEE AT ALL.

      Rule #71 says a clone never runs a migration the prime itself has not
      run, and `scopeCorpusToPrime` enforces it against the prime's own
      `supabase_migrations.schema_migrations`. What nothing enforced is what
      ENTERS that ledger: the prime's `apply-migration.yml` is
      `workflow_dispatch` with a required file input, and its own header says
      "Deciding *which* file is a human judgement made before dispatch". So
      the ledger records what somebody remembered to dispatch, not what
      merged.

      Measured 19 September 2026: four migrations sat on prime's `main`
      unrecorded and — asserted by effect, not by the ledger — genuinely
      unapplied. Every object `20261202090000_builder_marketplace_ranking.sql`
      declares is absent from the prime's live catalogue, and
      `20261206000000` enables RLS on a table the prime reports
      `rls_enabled: false`. Two tenants had been held at frontier
      `20261201100000` behind them.

      The condition had no name anywhere. Not a class here, no field on
      `FleetMigrationResult`, no notification, no row — its only trace was
      free-text in `clone_backends.status_detail`, while both clones read
      `status: ready` with `migration_blocked_at` NULL. And
      `buildPrimeLedgerReconciliation`, the one function that computes
      object-level evidence for exactly this, had ZERO call sites.

      `operator`, because the act that clears it is on the prime and is a
      person's: dispatch the migration, or decide it should not exist. Never
      `selfHeals` — a custodian cannot apply DDL to the prime, and re-running
      the fleet lane produces this same reading for ever. It is a STANDING
      fault rather than one conditioned on divergence: it is wrong right now
      whatever today's convergence says, and it will hold the NEXT migration
      too.
    */
    owner: "operator",
    selfHeals: false,
    conditionedOnDivergence: false,
    what: "The prime has merged a migration it has not run, so this clone is held at the version before it — and so is everything after.",
  },
  unclassified: {
    /*
      The reason an incomplete taxonomy is still sound. See the header.
    */
    owner: "operator",
    selfHeals: false,
    conditionedOnDivergence: true,
    what: "This clone is not converging and nothing here can say why — which is itself the finding.",
  },
};

/** Everything one clone's classification is decided from. */
export type CloneBlockageFacts = {
  cloneId: string;
  label: string;
  syncScope: string | null;
  /** How many `clone_sync_exclusions` rows this clone has. */
  exclusionCount: number;
  /** `owner/repo` as the clone record now states it. */
  repoFullName: string | null;
  /** The auditor's newest reading, when there is one. */
  convergence: {
    state: string;
    owedCount: number;
    owedFingerprint: string | null;
    unchangedSince: string | null;
  } | null;
  /** Result rows still recorded as an open proposal. */
  openProposals: Array<{
    resultId: string;
    prUrl: string | null;
    /** `owner/repo` parsed out of `prUrl`, when it parses. */
    prRepo: string | null;
    createdAt: string;
  }>;
  /** Events carrying a non-succeeded row for THIS clone. */
  events: Array<{
    id: string;
    status: string;
    attempts: number;
    requiresApproval: boolean;
    approvedAt: string | null;
    nextAttemptAt: string | null;
    workerStartedAt: string | null;
    /** This clone's own row under that event. */
    resultStatus: string | null;
    resultSummary: string | null;
    resultError: string | null;
    updatedAt: string;
  }>;
  /** Failed rows for this clone since its last successful one. */
  consecutiveFailures: number;
  /** The drain's own standing-blockage notification, when one is unread. */
  blockedNotice: { title: string; body: string; createdAt: string } | null;
  /**
   * Prime versions this clone's last migration pass was held behind.
   *
   * Read from `clone_backends.migrations_applied` — the pass already records
   * `blockedBy` on every migration it skipped, and has since
   * `partitionByDependency` was written. Nothing had ever read it back.
   *
   * It is the clone's OWN record of its last pass, so this costs no GitHub
   * call and no read of the prime: the condition is reported from the same
   * evidence that produced it.
   */
  primeLedgerHoles: Array<{
    /** The prime version the clone is held behind. */
    version: string;
    /** How many of this clone's migrations that one version is holding. */
    heldCount: number;
    /** The first migration it holds, for the sentence an operator reads. */
    firstHeld: string | null;
  }>;
  sloMinutes: number;
};

export type DetectedBlockage = {
  cls: BlockageClass;
  owner: BlockageOwner;
  selfHeals: boolean;
  /** One stable identity for one way of being blocked. */
  fingerprint: string;
  /** What an operator is told, naming the specific thing. */
  detail: string;
  /** When the condition itself began, as the facts report it. */
  since: string | null;
};

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/**
 * How far out a deferral may legitimately be parked.
 *
 * `rateLimitDeferral` never places one past sixty-five minutes, on the
 * reasoning that a reset a day away is a header this code misread. Anything
 * beyond that plus a margin was not written by that rule, and an event parked
 * past it will simply never be claimed again by anything that is watching.
 */
export const DEFERRAL_CEILING_MINUTES = 90;

/** Failures in a row before this is a standing condition rather than an event. */
export const CONSECUTIVE_FAILURE_FLOOR = 3;

export function classifyBlockages(facts: CloneBlockageFacts, now: Date): DetectedBlockage[] {
  const found: DetectedBlockage[] = [];
  const t = now.getTime();
  const sloMs = Math.max(1, facts.sloMinutes) * 60_000;

  const add = (cls: BlockageClass, fingerprint: string, detail: string, since: string | null) => {
    const policy = BLOCKAGE_POLICY[cls];
    found.push({
      cls,
      owner: policy.owner,
      selfHeals: policy.selfHeals,
      fingerprint,
      detail,
      since,
    });
  };

  /*
    A mirror with no exclusions is the state `assertMirrorPolicy` refuses to
    cascade into, and provisioning created it every time until
    `seedSyncExclusions` gained a caller. It is first because it blocks
    everything behind it.
  */
  /*
    A migration the prime merged and never ran.

    First alongside the unseeded policy, for the same reason: it blocks
    everything behind it, and it is the clone's SCHEMA rather than one
    delivery. One blockage per hole VERSION, fingerprinted on that version —
    so the row is stable across passes, and it discharges itself the moment
    the prime's ledger records the version and the next pass stops reporting
    `blockedBy`. Nobody has to remember to close it.

    Deliberately NOT one blockage per held migration: three held migrations
    behind one hole is one condition with one remedy, and three rows would be
    three findings about the same file.
  */
  for (const hole of facts.primeLedgerHoles) {
    add(
      "prime_ledger_hole",
      `prime_ledger_hole:${hole.version}`,
      /*
        WHAT THIS ROW KNOWS, AND WHAT IT DOES NOT.

        It used to open "the prime has that migration in its repository and has
        not run it". The second half is a claim about the prime's SCHEMA, and
        the only thing behind this row is its LEDGER — `scopeCorpusToPrime`
        reads `supabase_migrations.schema_migrations` and nothing else.

        On this prime those two disagree, measurably: the database HAS
        `ensure_builder_stock_settlement_scheduled()` and the ledger does not
        record the migration that creates it, and 481 of its 890 rows carry an
        empty name and a version matching no repo file. So "absent from the
        ledger" covers a file the prime deliberately never ran AND one it ran
        under an id nothing wrote down, and those have opposite remedies.

        The refusal is UNCHANGED and stays first, because it is the
        conservative side and this classifier has no evidence to leave it on:
        nothing here may invite a stamp. What is added is where the evidence
        lives, so an operator holding this row can find out which of the two
        they have rather than being told.
      */
      `${facts.label} is held at the version before ${hole.version}: the prime's ledger does not record that migration, so this clone may not run it either. ` +
        `${hole.heldCount} migration(s) wait behind it` +
        (hole.firstHeld ? `, starting with ${hole.firstHeld}` : "") +
        ". It clears when the prime runs that file — nothing here can, and stamping the prime's ledger instead would send this clone a migration whose prerequisite does not exist. " +
        "Whether this prime ran it untracked is a separate reading, against its catalog rather than its ledger: Fleet Manager → Prime Ledger Reconciliation.",
      null,
    );
  }

  if (facts.syncScope === "mirror" && facts.exclusionCount === 0) {
    add(
      "policy_unseeded",
      "policy_unseeded",
      `${facts.label} mirrors the whole tree with no exclusion policy — every cascade into it is refused until one is seeded.`,
      null,
    );
  }

  /*
    THE 43-ROW FAULT, NAMED.

    Measured 18 Sep 2026: 43 rows recorded against
    `lavan96/npc-client-dashboard` while the clone's own record reads
    `Naidu-Group-Pty-Ltd/npc-client-dashboard`. The repository moved owners,
    the historical rows kept the old URL, and the drain has classed them
    unreachable and skipped — every five minutes, for three weeks, silently.
  */
  const retargeted = facts.openProposals.filter(
    (p) =>
      p.prRepo && facts.repoFullName && p.prRepo.toLowerCase() !== facts.repoFullName.toLowerCase(),
  );
  const byWrongRepo = new Map<string, typeof retargeted>();
  for (const p of retargeted) {
    const list = byWrongRepo.get(p.prRepo!) ?? [];
    list.push(p);
    byWrongRepo.set(p.prRepo!, list);
  }
  for (const [wrongRepo, rows] of byWrongRepo) {
    const oldest = rows.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    add(
      "repo_retargeted",
      `repo_retargeted:${wrongRepo}`,
      `${rows.length} proposal record(s) name ${wrongRepo}, which is not this clone's repository ` +
        `(${facts.repoFullName}). No reconcile can reach them, so they stay open for ever.`,
      oldest.createdAt,
    );
  }

  /*
    An open proposal whose record is simply behind. Distinct from the above:
    the URL is right, so the drain CAN reach it and has not.
  */
  for (const p of facts.openProposals) {
    if (retargeted.includes(p)) continue;
    const age = t - (ms(p.createdAt) ?? t);
    if (age < sloMs) continue;
    add(
      "unreconciled_proposal",
      `unreconciled_proposal:${p.prUrl ?? p.resultId}`,
      `A proposal recorded as open since ${p.createdAt} has not been reconciled against its own ` +
        `pull request, which is longer than one delivery window.`,
      p.createdAt,
    );
  }

  for (const e of facts.events) {
    /*
      A retired event is never claimed again by anything. Its clone's row is
      whatever the pass left, and the work it carried reaches this clone only
      if some later cascade happens to carry it too.
    */
    if (e.status === "failed" && e.attempts >= MAX_ATTEMPTS) {
      add(
        "attempts_exhausted",
        `attempts_exhausted:${e.id}`,
        `A delivery was retired after ${e.attempts} attempt(s) with this clone's part unfinished ` +
          `(${e.resultStatus ?? "no row"}). Nothing will claim it again.`,
        e.updatedAt,
      );
    }

    /*
      `partial` is terminal. Some clones landed, this one failed, and the
      event settled — so the failure is carried only by the next cascade
      happening to succeed. Measured 18 Sep: 15 such events, and 42 failed
      rows that nothing anywhere accumulates.
    */
    if (e.status === "partial" && e.resultStatus === "failed") {
      add(
        "partial_clone_dropped",
        `partial_clone_dropped:${e.id}`,
        `A delivery completed for the rest of the fleet and failed for ${facts.label}; the record ` +
          `settled, so nothing will retry this clone's part.`,
        e.updatedAt,
      );
    }

    if (e.requiresApproval && !e.approvedAt && e.status === "pending") {
      add(
        "approval_pending",
        `approval_pending:${e.id}`,
        `A delivery is held for a second operator's approval and will not move until one is recorded.`,
        e.updatedAt,
      );
    }

    const nextAt = ms(e.nextAttemptAt);
    if (
      e.status === "pending" &&
      nextAt !== null &&
      nextAt - t > DEFERRAL_CEILING_MINUTES * 60_000
    ) {
      add(
        "deferred_far_future",
        `deferred_far_future:${e.id}`,
        `A delivery is parked until ${e.nextAttemptAt}, further out than any provider reset places one.`,
        e.updatedAt,
      );
    }

    const startedAt = ms(e.workerStartedAt);
    if (e.status === "running" && startedAt !== null && t - startedAt > STALL_MINUTES * 60_000) {
      add(
        "event_stuck_running",
        `event_stuck_running:${e.id}`,
        `A delivery has been marked running since ${e.workerStartedAt}, past the point any pass survives.`,
        e.workerStartedAt,
      );
    }

    /*
      The platform abandons an invocation the isolate survives, and the
      message it leaves is the PLATFORM's rather than the engine's — "your
      request timed out", recorded against the clone's row. A single one is
      ordinary: the pass ledger keeps its work and the next tick continues.
      Repeated, with the clone still not converging, it is a pass that does
      not fit and never will.
    */
    if (
      isInvocationCut(e.resultSummary, e.resultError) &&
      (facts.convergence?.owedCount ?? 0) > 0
    ) {
      add(
        "invocation_cut",
        `invocation_cut:${e.id}`,
        `A pass was cut off before it finished (${(e.resultSummary ?? e.resultError ?? "").slice(0, 120)}).`,
        e.updatedAt,
      );
    }
  }

  if (facts.consecutiveFailures >= CONSECUTIVE_FAILURE_FLOOR) {
    add(
      "consecutive_failures",
      "consecutive_failures",
      `${facts.label} has failed its last ${facts.consecutiveFailures} deliveries. Failure is recorded ` +
        `per delivery, so this reads as several unrelated events unless it is counted here.`,
      null,
    );
  }

  /*
    The gate's own verdict, read rather than re-derived.

    `decideCascadeMerge` is the one authority on whether a proposal may merge,
    and the drain already writes its verdict — with a fingerprint — when the
    same failure recurs on a rebuilt head. Re-deriving it here would be a
    second implementation of "may this merge", which is how one of them
    becomes wrong.
  */
  if (facts.blockedNotice) {
    add(
      "ci_red",
      `ci_red:${facts.blockedNotice.title}`,
      firstParagraphs(facts.blockedNotice.body, 2),
      facts.blockedNotice.createdAt,
    );
  }

  /*
    THE RULE THAT MAKES AN INCOMPLETE LIST SOUND.

    The auditor says this clone is not converging. If nothing above can say
    why, the absence IS the finding — owned by a person, never self-healed,
    and named as a gap rather than left as the silence every previous freeze
    was reported in.
  */
  const notConverging =
    facts.convergence?.state === "stalled" || facts.convergence?.state === "falling_behind";
  if (notConverging && found.length === 0) {
    add(
      "unclassified",
      `unclassified:${facts.convergence?.owedFingerprint ?? "none"}`,
      `${facts.label} is ${facts.convergence?.state === "stalled" ? "stalled" : "falling behind"} with ` +
        `${facts.convergence?.owedCount ?? 0} path(s) owed, and no known condition explains it. ` +
        `This is a shape the taxonomy has not seen.`,
      facts.convergence?.unchangedSince ?? null,
    );
  }

  /*
    A DELIVERY THAT WENT WRONG COSTS NOTHING ONCE THE CLONE HOLDS EVERYTHING.

    A commit cascade delivers prime's head at run time, so a later pass
    supersedes a failed one entirely — which means a retired event, a dropped
    partial or a run of failures is history the moment the auditor reports
    `converged`. Reporting them anyway would fill a list of open problems with
    things nobody can or should act on, which is how the notification channel
    came to hold 2,459 unread rows.

    The standing faults are exempt: an unseeded policy and a proposal recorded
    against the wrong repository are wrong RIGHT NOW, whatever today's
    convergence says, and will be wrong for the next cascade too.
  */
  if (facts.convergence?.state === "converged") {
    return found.filter((b) => !BLOCKAGE_POLICY[b.cls].conditionedOnDivergence);
  }
  return found;
}

/**
 * The platform's own abandonment message, and the engine's own pause.
 *
 * Matched on both because they are the two halves of one event: pg_net stops
 * waiting at 60,000 ms and the isolate keeps going, so the clone's row carries
 * either the engine's honest "paused at the invocation budget" or the
 * platform's "your request timed out", depending on which of them got to write
 * first.
 */
export function isInvocationCut(summary: string | null, error: string | null): boolean {
  const hay = `${summary ?? ""} ${error ?? ""}`.toLowerCase();
  return hay.includes("paused at the invocation budget") || hay.includes("request timed out");
}

/** `owner/repo` out of a GitHub pull request URL, or null when it does not parse. */
export function parsePrRepo(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(prUrl);
  return m ? `${m[1]}/${m[2]}` : null;
}

function firstParagraphs(body: string, n: number): string {
  return body.split("\n\n").slice(0, n).join(" ").trim();
}
