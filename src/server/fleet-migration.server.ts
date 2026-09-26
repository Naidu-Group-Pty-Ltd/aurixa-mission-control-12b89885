/**
 * Applying the prime's migrations to every clone database, without a person.
 *
 * ## The gap this closes
 *
 * When the prime gains a migration, the cascade copies the FILE into every
 * clone's repository automatically. Nothing applied it to the clone's
 * DATABASE. `fleetMigrationSync` has existed and worked the whole time, and
 * its only caller was a button on an admin page — so a fleet stayed in step
 * with the prime exactly as often as somebody remembered to press it.
 *
 * That is the ceiling on how many clones this platform can carry. One clone is
 * a click. Ten is a chore nobody does on the day it matters. The schema drifts,
 * the clone's edge functions start naming columns it does not have, and the
 * symptom arrives as PostgREST 42703s in a tenant's application rather than as
 * anything anyone here would recognise as a missed migration.
 *
 * ## Why this lives in Mission Control rather than in each clone's CI
 *
 * The alternative is a GitHub Actions workflow in every clone repository. It
 * does not scale, for three concrete reasons:
 *
 *   - It needs a Management API token and a project ref configured in N
 *     repositories. The token reaches every project in the organisation, so
 *     that is N copies of the most dangerous credential here, and N chances for
 *     a ref to name the wrong tenant.
 *   - Clone repositories are MIRRORS. The cascade overwrites them. A workflow
 *     file living there is a file the cascade has to be told to leave alone —
 *     `apply-migration.yml` is already in `DEFAULT_MIRROR_EXCLUSIONS` for
 *     exactly that reason.
 *   - Only Mission Control knows the fleet. A clone's repository does not know
 *     which Supabase project it belongs to; `clone_backends` does.
 *
 * Mission Control already holds one token that reaches every project, the
 * project ref for every clone, an idempotent applier, and a worker system. The
 * scalable answer is to use them.
 *
 * ## One engine, two callers
 *
 * The admin button and the scheduled worker both call `runFleetMigrationSync`.
 * They were never allowed to become two implementations of "sync the fleet" —
 * that is how a button and a cron job come to disagree about what a clone is
 * owed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  openPrimeMigrationCorpus,
  resolvePrimeSource,
  resolvePrimeBackendRef,
} from "./prime-backend.server";
import {
  applyPrimeMigrations,
  readCloneMigrationLedger,
  runSqlOnProject,
} from "./backend-provisioning.server";
import { scopeCorpusToPrime, assertPrimeLedgerUsable } from "./fleetCorpusScope.pure";
import { LEDGER_BODY_DIGEST_SQL, EMPTY_BODY_SHA256 } from "./migrationBodyIdentity.pure";
import { withdrawnButRecorded } from "./migrationWithdrawals.pure";
import { wholeRunnableVersions, type SplitVersion } from "./sharedVersionDelivery.pure";
import { digestPrimeBodies } from "./primeBodyDigests.server";
import type { MigrationDependencyFacts } from "./migrationDependencyFacts.pure";
import { readThroughSeedSkeletons, type SeedSkeletonReport } from "./seedSkeletonManifest.pure";
import {
  MIGRATION_CLAIMABLE_STATUSES,
  blockIsDischarged,
  blockIsUpstreamRefusal,
  isMidSeed,
  migrationEligibility,
  orderMigrationQueue,
  scopeQueueToMode,
  type FleetPassMode,
  type MigrationSkipReason,
} from "./fleetMigrationEligibility.pure";
import { blockOvertakenBySequence } from "./blockSequence.pure";
import { notifyOperators, writeAuditLog } from "./audit.server";
import { chunkCursorFor } from "./chunkCursorStore.pure";
import { ClaimLostError } from "./provisioningBudget";
import {
  PRIME_LEDGER_HOLE_NOTE_CAP,
  blockageDetailFor,
  primeLedgerHoleSentence,
  reconcileBlockageRecord,
} from "./fleetBlockageRecord.pure";

type Db = SupabaseClient<Database>;

/**
 * How many clones one run will touch.
 *
 * Each clone is a round trip per unapplied migration against its own project,
 * and the corpus is 962 files. A fleet-wide loop in a single invocation is the
 * shape that timed out the first mirror cascade at exactly 60,000 ms, so this
 * takes a bounded slice and lets the next tick take the rest. Clones are
 * ordered by how far behind they are, so the one that has waited longest goes
 * first rather than whichever the planner happened to return.
 *
 * The batch bounds the APPLY work. It never bounded the read: the corpus was
 * downloaded in full before the first clone was claimed, which is why this job
 * hit the same 60,000 ms wall with `batchSize` of 5 and of 1 alike. That is
 * fixed in `openPrimeMigrationCorpus`, not here.
 */
const DEFAULT_BATCH = 5;

/**
 * A claim this old AND this quiet is treated as abandoned.
 *
 * It used to be thirty minutes of age alone, and age alone cannot tell a run
 * that is working from one that is dead — so the number had to be long enough
 * for the slowest legitimate run, which made it exactly as long as the cadence.
 * A leaked claim therefore cost a clone a FULL PASS: claimed 12:00:49, still
 * held at 12:30 because it was 29.2 minutes old, freed only at 13:00.
 *
 * The heartbeat settles it instead: this lane stamps
 * `migration_heartbeat_at` when it takes a claim and again on every statement
 * the replay sends, so a run that is alive and working says so several times a
 * minute. Asserted by effect rather than by a guess about how long work takes.
 *
 * It must be THIS LANE'S column and not `updated_at`. `updated_at` is
 * row-wide: every writer of `clone_backends` refreshes it, and one of them is
 * the reference-data lane, which claims and releases the same `ready` backend
 * through `reference_sync_started_at` and never looks at `worker_started_at`.
 * Its cadence is `13,28,43,58` against this lane's half-hourly one, so it
 * writes two minutes before every fleet pass — a dead claim on any clone it
 * touches would be permanently "recent" and stick for ever, which is worse
 * than the window this replaced. Raised by review on the first version of
 * this change.
 *
 * What the number still has to cover is the longest SILENT stretch of a living
 * pass, which is the initial download rather than the sending: a 40 MB seed
 * arrives before the first statement can be recorded. Five minutes is roughly
 * five times that, and pg_net has given up on the request four minutes earlier.
 *
 * Measured 19 Sep 2026: fleet passes ran 49 s, 102 s and 102 s from the cron
 * fire, and three claims leaked — npc-test 11:31:02.064, npc-client-dashboard
 * 12:00:49.571, npc-test 13:01:42.513 — each with its last write 19-39 ms
 * later. That gap is clock skew between the isolate's `new Date()` and the
 * database's trigger, so the claim was the last thing to touch the row: the
 * isolate died before the replay's first await returned.
 */
const STALE_CLAIM_MINUTES = 5;

/*
 * A CEILING ON CLAIM AGE WAS CONSIDERED HERE AND DELIBERATELY NOT ADDED.
 *
 * Review is right that the residual below is not "one reclaim window once".
 * `stop` aborts the outstanding beats — dropping every one not yet sent and
 * closing the connection of one that has been — but Postgres notices a
 * vanished client only when it next writes to the socket, which for a short
 * UPDATE is after it has committed. So on the one path where the pass's own
 * release ALSO failed, leaving `worker_started_at` still equal to the claim,
 * each late beat stamps its own `clock_timestamp()` and pushes the silence
 * window out again. The true bound is one window after the LAST queued beat
 * commits, and nothing local bounds when that is.
 *
 * The obvious answer is an absolute age past which a claim is freed whatever
 * its stamp says. It was written, and then removed, because it is the SAME
 * SHAPE as the `_not_after` deadline removed one round earlier: a rule that
 * can free a claim a LIVE pass is holding, which is how two passes end up
 * inside one schema. Only the trigger differs — ordinary latency there, an
 * improbably long pass here — and "improbable" is the reasoning this codebase
 * keeps paying for.
 *
 * The trade decides it. The residual costs a DELAY: a claim held by nobody,
 * a clone skipped until the beats drain and the window passes, nothing
 * applied twice and nothing corrupted. A ceiling would trade that for a
 * chance of concurrent application — which is the wrong way round, and is
 * the same argument made against the deadline.
 *
 * What is done instead costs nothing: the beats are stopped BEFORE the
 * release is attempted rather than after it, so the set that can outlive a
 * failed release is only those still in flight after the drain. See the
 * `heartbeat.stop()` above the result write.
 *
 * What would change this: a MEASURED ceiling on how long one invocation can
 * live in this runtime. A claim ceiling set from that is a fact about the
 * platform rather than a guess about latency, and could never reach a pass
 * the platform would not already have killed. That measurement is not in
 * hand, and guessing it is the thing this comment exists to refuse.
 */

/**
 * A pass will not claim a clone it cannot plausibly do anything for.
 *
 * The budget check before the claim asked only whether the deadline had
 * passed, so a claim could be taken with milliseconds left — and it was, three
 * times in one morning. The replay's first act is opening a 40 MB seed, which
 * cannot finish in what remained, and the isolate was killed holding the claim.
 *
 * This is a FLOOR rather than a measurement, and it is worth saying so: what a
 * pass needs is enough time to open the stream and record one statement, and
 * nothing here measures that. Fifteen seconds is chosen as obviously-too-little
 * to do it, against passes measured at ~102 s for one clone.
 *
 * The reserve reduces how often a claim is wasted; the heartbeat-aware reclaim
 * above bounds what it costs when one still is. Neither depends on the other
 * being right, which is the point of having both.
 */
const CLAIM_RESERVE_MS = 15_000;

/**
 * What a write says when the claim it was fenced against is gone.
 *
 * Named once because two sites raise it — the progress write throws it to stop
 * the replay, the result write reports it — and they mean the same thing. Two
 * spellings of one condition is how the two come to disagree, and this is the
 * string an operator will search for when a pass reports a clone it never
 * changed.
 */
const CLAIM_LOST = "claim lost mid-pass";

/**
 * How long the scheduled request waits for a pass to answer.
 *
 * `20260922150000_fleet_sync_http_patience.sql` set it for both of this lane's
 * jobs, after every half-hourly sweep for six hours came back
 * `Timeout of 60000 ms reached`. Named here because the budget below is
 * derived from it, and `fleetPassIsBudgeted.contract.test.ts` reads the
 * migration to hold the two in step: a budget computed from a patience the
 * cron job no longer has is how a pass outlives the request that asked for it.
 */
const FLEET_HOOK_PATIENCE_MS = 150_000;

/**
 * What a pass leaves between its budget and that patience.
 *
 * The budget is checked BETWEEN units, so a pass can start one statement, or
 * one small migration, just inside it — and must still write its verdict,
 * release its claim and write the audit row before the request stops being
 * waited on. A seed statement measured a few seconds; sixty leaves room for a
 * slow one several times over, plus the writes.
 */
const FLEET_PASS_HEADROOM_MS = 60_000;

/**
 * How long one pass may spend before it stops handing out work.
 *
 * THIS LANE HAD NO BUDGET AT ALL, and its comment beside `applyPrimeMigrations`
 * said why it needed none: a killed pass is "reclaimed after
 * `STALE_CLAIM_MINUTES` and re-sends from the first statement, which is
 * idempotent … Slower, never wrong." Idempotent is true. Slower is not: a seed
 * the runtime cannot finish inside ONE invocation restarts at statement 1 on
 * every pass, so it never lands however often it is tried.
 *
 * Measured 19 Sep 2026, the day the streaming fetch first worked. Both passes
 * after it died mid-seed: no `lane:fleet-migration-sync` usage row, both
 * claims left set, `migration_version` unmoved. Before the fetch was fixed the
 * same passes returned in about eight seconds, because a 403 arrives quickly —
 * the lane looked healthiest exactly while it could not do the work.
 *
 * It was forty-five seconds, because pg_net gave up on the hook at sixty. That
 * reason went on 22 Sep, when the jobs were given 150 s, and the budget stayed
 * where the old patience had put it. Measured 26 Sep 2026: every pass for an
 * hour and a quarter took 47–53 s, served exactly ONE clone and sent exactly
 * ONE seed statement. A pass pays its setup and a full read of the seed — the
 * chunker holds all ~41 MB before it hands over a statement, see
 * `seedChunking.pure.ts` — before it sends anything, and forty-five seconds
 * left room for one. That is ~14 statements an hour across the fleet, ~3.5 per
 * clone with four clones mid-seed, against ~42 a seed — while the prime
 * released v21 and v22 two days apart. The fleet was falling behind the seeds.
 *
 * So the budget is the patience less the headroom, and the same read now pays
 * for as many statements as the time allows. It is still a budget that is
 * spent rather than a failure: the chunk cursor makes the next pass carry on
 * from the statement after the last one sent.
 */
const FLEET_PASS_BUDGET_MS = FLEET_HOOK_PATIENCE_MS - FLEET_PASS_HEADROOM_MS;

export type FleetMigrationResult = {
  /** Clones eligible and claimed this run. */
  processed: number;
  /**
   * True when the pass ran out of its wall-clock budget with eligible clones
   * it never reached, or stopped inside a chunked seed.
   *
   * Reported because the alternative readings are identical: a pass that
   * served two of five clones and a pass that found five level both say
   * `processed: 2, failed: []`. It is NOT an error — the chunk cursor and the
   * free claim mean the next tick carries on — but a fleet that never finishes
   * a pass is a fleet whose last clones are never served, and that has to be
   * visible from the outside.
   */
  stoppedAtBudget: boolean;
  /** Clones that received at least one migration. */
  advanced: number;
  /** Clones already level with the prime. */
  upToDate: number;
  /** Clones whose apply failed; each is now `failed` and out of the fleet. */
  failed: Array<{ cloneId: string; cloneName: string; error: string }>;
  /**
   * Backends excluded because their status is not `ready`.
   *
   * Reported rather than merely skipped. A clone leaves the eligible set the
   * moment a migration fails on it, and a fleet sync that says "5 processed"
   * while three clones sit outside the query is the quiet half of the failure
   * this module exists to end.
   */
  excluded: number;
  /**
   * Clones whose `migration_blocked` flag this run cleared: their own ledger
   * now records the version the block names, the block recorded an upstream
   * refusal rather than anything the clone did, or the lane would now send an
   * earlier version first (`blockSequence.pure.ts`).
   *
   * Reported rather than silent for the same reason `skipped` is. A block that
   * disappears with nothing saying so is indistinguishable from one nobody
   * ever set, and the whole defect here was a state changing — the prime being
   * repaired — that no reading reflected.
   */
  rehabilitated: string[];
  /**
   * The excluded ones, NAMED, with this lane's own verdict on each.
   *
   * `excluded: 2` is the reading that hid the defect this field exists to end.
   * It is true, it is unactionable, and it reads identically whether the two
   * are mid-provision (fine, they will be along shortly) or held out of the
   * fleet for a day by a verdict another worker reached about a job. An
   * operator cannot tell those apart from a number, and for a day nobody did.
   *
   * Every skip carries the clone's NAME and a sentence saying what to do, so
   * a run that serves one of three tenants says which two it did not and why.
   */
  skipped: Array<{
    cloneId: string;
    cloneName: string;
    reason: MigrationSkipReason;
    detail: string;
  }>;
  /**
   * Clones where a migration was left unsent because its body is past the
   * corpus ceiling and this pass could not stream it.
   *
   * Its own field rather than a line in `failed`, because the two are opposite
   * claims about the clone: `failed` says the clone rejected something and has
   * left the fleet, `heldOversize` says nothing was sent and it has not. A run
   * that reported the second as the first is what ejected a healthy clone for
   * a day.
   */
  heldOversize: Array<{ cloneId: string; cloneName: string; migration: string }>;
  /**
   * Clones whose pass was cut short because an upstream API quota refused to
   * serve a migration body. Its own field for the same reason `heldOversize`
   * is, and counted OUT of `upToDate` for a reason of its own.
   *
   * `upToDate` means "already level with the prime". A pass that could not
   * FETCH what it meant to send has established nothing of the kind — and it
   * was counted there anyway, so a fleet held up by an exhausted window
   * reported as a fleet in perfect health. That is the quiet half of the
   * failure this module exists to end, in the one shape it had left.
   */
  rateLimited: Array<{ cloneId: string; cloneName: string; migration: string }>;
  /**
   * Clones where a version was HELD by a rule rather than sent: nothing was
   * sent and the clone is exactly as it was. Its own field for the reason the
   * other two holds have theirs, and a third because the remedy differs again
   * — this one is neither waited out nor carried by the chunking lane, it is a
   * change on the prime. `migration` is the first file of the version.
   */
  heldByRule: Array<{ cloneId: string; cloneName: string; migration: string; rule: string }>;
  /**
   * Versions the scope cleared part of — one file of a shared version in the
   * prime's ledger by body, another not. Nothing at such a version is sent to
   * any clone. Said once per run, because it is a fact about the prime.
   */
  splitVersions?: SplitVersion[];
  /**
   * Repo migrations the prime has NOT applied, and which were therefore not
   * offered to any clone. Reported rather than silently filtered — a run that
   * says "962 files, 4 applied" with no account of the rest is how a corpus
   * containing rollback scripts reached a tenant database in the first place.
   */
  withheld: number;
  /**
   * The withheld set split by reason.
   *
   * `withheld: 828` on its own is unreadable in BOTH directions — it can be
   * waved away as "just the backlog" or panicked over as "the sync does
   * nothing". Split, it says which: `skewSuspected` is the apply-timestamp
   * skew `docs/MIGRATION_PIPELINE.md` records and is harmless for a clone
   * stamped from the prime's ledger, and `neverApplied` is the set an operator
   * should actually look at.
   *
   * Diagnostic only. Neither number can move a migration into `runnable`.
   */
  withheldBreakdown: { neverApplied: number; skewSuspected: number; bodyUnread: number };
  /**
   * What the prime's `MIGRATION_WITHDRAWN.json` took out of the corpus before
   * anything was scoped. Absent when the corpus was never read.
   *
   * Reported beside `withheld` and never inside it: a withheld file is one the
   * prime has not run and a clone may be owed one day, a withdrawn file is one
   * whose effect is deliberately absent everywhere. `unreadable` is the state
   * to watch — it is the one in which a withdrawn file silently becomes a hole
   * on every clone again.
   */
  withdrawn?: {
    state: "absent" | "read" | "unreadable";
    why?: string;
    files: string[];
    /** Listed, but not in the prime's tree. Enforced on nothing. */
    unmatched: string[];
    /**
     * Withdrawn files whose version the prime's ledger RECORDS. The
     * declaration and the ledger disagree, and which is wrong is a person's
     * call; the file stays unsent either way.
     */
    recordedOnPrime: string[];
  };
  /**
   * What the prime's `migration-seed-skeletons.json` contributed: the seeds
   * whose dependency facts this pass read through a skeleton, and the ones it
   * could not. Absent when the corpus was never read or the step failed.
   *
   * `unreadable` is the state to watch, for the reason `withdrawn`'s is: it is
   * the one in which every seed quietly becomes a barrier to everything behind
   * it again, and the count of what was sent is the only other place it shows.
   */
  seedSkeletons?: SeedSkeletonReport;
  /** Set when the run could not start at all. */
  error?: string;
};

const EMPTY: FleetMigrationResult = {
  processed: 0,
  stoppedAtBudget: false,
  advanced: 0,
  upToDate: 0,
  failed: [],
  excluded: 0,
  rehabilitated: [],
  skipped: [],
  heldOversize: [],
  rateLimited: [],
  heldByRule: [],
  withheld: 0,
  withheldBreakdown: { neverApplied: 0, skewSuspected: 0, bodyUnread: 0 },
};

/**
 * How often a pass says it is still alive while it holds a claim.
 *
 * Read against `STALE_CLAIM_MINUTES` rather than chosen on its own: what has
 * to be true is that several beats fit inside the reclaim window, so a single
 * lost beat — a transient database fault, a request that took longer than
 * usual — cannot make a living pass look dead. Thirty seconds against five
 * minutes is ten beats; a pass would have to miss nine in a row.
 *
 * The two numbers are the whole cadence because beats do not wait for each
 * other. That was not true of the version that serialised them, where a slow
 * beat delayed the next one and this ratio described a system with no latency;
 * `fleet_claim_heartbeat` taking the MAXIMUM at the database is what makes
 * independence safe and therefore makes this arithmetic honest again.
 */
const CLAIM_HEARTBEAT_MS = 30_000;

/**
 * How long a pass will wait for beats still in the air when it stops.
 *
 * `clearInterval` stops the next beat, not one already dispatched. The
 * cancellation is the abort beside it; this only stops the pass from walking
 * away while that cancellation is still landing, so the beats it aborted have
 * settled before the release runs rather than racing it.
 *
 * It does NOT bound how late a beat can write — nothing in this isolate can,
 * which is the finding that removed the deadline that used to sit here and is
 * recorded in full on `fleet_claim_heartbeat`. Claiming otherwise was one of
 * this mechanism's own defects and is worth not re-acquiring.
 *
 * Bounded, because this is awaited in a `finally`: a beat that never settles
 * would otherwise hang the whole run, which is a far worse fault than the one
 * the wait addresses. Two seconds drains the ordinary case and abandons the
 * pathological one.
 */
const CLAIM_DRAIN_MS = 2_000;

/**
 * Say, on a clock, that this pass still holds the claim it took.
 *
 * Separate from the cursor write in `onStatementDone`: that one belongs to the
 * oversized-seed path and carries progress, and a heartbeat that only exists
 * where there is progress to report is absent on every other path — an
 * ordinary DDL, and above all a request blocked inside the timeout-less
 * `runSqlOnProject`. Those are the stretches the window has to cover.
 *
 * Takes no callback: nothing here can interrupt a pass blocked in a fetch, so
 * this does not pretend to. What it does is make a living pass VISIBLE, and
 * stop beating the moment the row says the claim is somebody else's.
 *
 * BEATS ARE INDEPENDENT, AND THAT IS THE POINT.
 *
 * Three shapes were tried here and the first two each bought the next defect.
 * Overlapping beats on a plain interval REORDERED, because each chose its
 * timestamp before its request went out. Serialising them fixed that and made
 * a HUNG beat end the heartbeat for ever — on an egress shared with the
 * migration's own SQL, so the beat fails exactly when it is needed. Bounding
 * each beat with an abort fixed that and turned a merely SLOW database into
 * total silence, every beat past the ceiling discarded and the stamp never
 * moving.
 *
 * All three were the caller trying to defend an ordering it does not control.
 * `fleet_claim_heartbeat` takes `greatest(migration_heartbeat_at,
 * clock_timestamp())`, so whichever write commits last the column ends at the
 * maximum and commit order stops mattering. Beats can then be independent,
 * which is what makes a hang harmless, which is what makes an abort
 * unnecessary. Nothing here is traded against anything else.
 */
export function beatWhileClaimHeld(
  supabase: Db,
  cloneId: string,
  claimedAt: string,
): { stop: () => Promise<void> } {
  let stopped = false;
  /** Beats dispatched and not yet settled, so `stop` can drain them. */
  const outstanding = new Set<Promise<unknown>>();
  /**
   * Cancels the beats that are out when the pass ends.
   *
   * It removes every beat that had not yet been sent, and closes the
   * connection of one that had, which Postgres answers by cancelling the
   * statement where it can still see the socket. What it cannot promise is
   * the beat already executing at the server; that residual is accepted and
   * named on `fleet_claim_heartbeat`, along with why a deadline on the beat
   * is not the way to close it.
   *
   * This half cannot backfire, which is why it survived the deadline that
   * was tried beside it: an aborted beat simply means the next one goes.
   */
  const inflightBeats = new AbortController();

  const timer = setInterval(() => {
    if (stopped) return;
    const run = (async () => {
      const { data: held, error } = await supabase
        .rpc("fleet_claim_heartbeat", {
          _clone_id: cloneId,
          _claimed_at: claimedAt,
        })
        .abortSignal(inflightBeats.signal);
      if (error) {
        // One lost beat is survivable by design — see CLAIM_HEARTBEAT_MS — so
        // this neither throws nor stops. Silence would hide a database fault
        // that is about to cost a live pass its claim.
        console.error("[fleet-migration] heartbeat not recorded", {
          cloneId,
          error: error.message,
        });
        return;
      }
      if (held === false) {
        // The claim is gone. Beating on would say a pass that owns nothing is
        // alive. Told by the function's own answer rather than by a row count,
        // which could not separate "the claim is gone" from "a newer beat
        // already won" once the write itself became conditional on advancing.
        //
        // `=== false` and not falsy: a beat whose transport failed returns
        // `null` above and has ALREADY returned, so the only way to reach
        // here with nothing is a shape this lane does not produce. Reading it
        // as a lost claim would end the heartbeat on a fault that says
        // nothing about the claim.
        console.warn("[fleet-migration] heartbeat stopped: the claim is no longer this pass's", {
          cloneId,
          claimedAt,
        });
        stopped = true;
        clearInterval(timer);
      }
    })().catch((e: unknown) => {
      // A rejected beat must not become an unhandled rejection: in this
      // runtime that can take down the whole invocation, which would lose the
      // replay this exists to protect.
      console.error("[fleet-migration] heartbeat threw", {
        cloneId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    outstanding.add(run);
    void run.finally(() => outstanding.delete(run));
  }, CLAIM_HEARTBEAT_MS);

  /*
    MEMOISED, BECAUSE "IDEMPOTENT" WAS TRUE OF THE EFFECT AND FALSE OF THE COST.

    There are three call sites now — before the result write, before the catch's
    release, and the `finally` behind both — and I said in two places that a
    second call was free because `clearInterval` and `abort` are no-ops on an
    already-stopped timer. They are. The DRAIN is not: a promise still unsettled
    after `CLAIM_DRAIN_MS` stays in `outstanding`, so the next call starts a
    fresh two-second race over the same promise. Every exit therefore spent up
    to four seconds rather than the two the constant names — and it is spent at
    the END of a pass, out of the margin left for the audit write and
    the response. Raised by review, against my own claim.

    So the first call's promise is the answer to every later one. Later callers
    await the SAME drain rather than starting another: already settled, they
    return at once; still running, they join it. `??=` and not a boolean,
    because two exits can reach this concurrently and a flag would let the
    second walk away while the first was still draining.
  */
  let stopping: Promise<void> | null = null;
  return {
    stop: () =>
      (stopping ??= (async () => {
        stopped = true;
        clearInterval(timer);
        inflightBeats.abort();
        /*
          Drained, but never indefinitely. `allSettled` cannot reject, so `stop`
          cannot throw in the `finally` that awaits it — a throw there would
          replace the error the pass is carrying, or on the success path escape
          the clone loop and kill the run. The race bounds a beat that never
          settles, which `allSettled` alone would wait for for ever.
        */
        await Promise.race([
          Promise.allSettled([...outstanding]),
          new Promise((resolve) => setTimeout(resolve, CLAIM_DRAIN_MS)),
        ]);
      })()),
  };
}

/**
 * Release claims from runs that died holding one.
 *
 * `worker_started_at` is reused as the claim, and that is safe rather than
 * lucky: the backend-provisioning drain claims `pending` and reclaims
 * `pending`/`provisioning`/`migrating`/`seeding_admin`. It never looks at a
 * row in `MIGRATION_CLAIMABLE_STATUSES`, which is the only set this touches.
 * The two workers cannot meet.
 *
 * The set is named rather than spelled `ready` here. This lane no longer gates
 * on `ready` — see `migrationEligibility` — so a reclaim that still did would
 * strand its own claim on a `failed` row for ever, which is worse than the
 * defect it was written to prevent.
 */
/**
 * Frees claims this lane left behind. Returns the reason it could not, rather
 * than throwing it.
 *
 * ## Why not a throw
 *
 * It threw, and nothing catches it: `runFleetMigrationSync` has no try around
 * this call, its caller checks `result.error` and never sees one, and the
 * scheduled hook turns it into a 500. So a sweep that failed left no usage
 * row, no error on any clone, and nothing an operator reading Mission Control
 * could see — observable only to somebody who knew to go and look at
 * `net._http_response.status_code`, which is the "a green cron run is not a
 * delivered request" trap from the other side.
 *
 * The result type already carries `error`, and returning it stops the pass
 * exactly as the throw did — which it must, because proceeding with the sweep
 * failed means leaked claims stay held and the candidate list is wrong. What
 * changes is only that the failure is written down.
 *
 * It matters more than it did: this sweep now names `migration_heartbeat_at`,
 * so between a merge and the moment `20260919133000` is applied the column
 * does not exist and both statements answer 42703. Bounded (the queue applies
 * within the minute) and self-healing (the next pass is thirty minutes later),
 * but a fleet that stopped should say so rather than 500 quietly.
 */
async function reclaimStale(supabase: Db): Promise<string | null> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();

  /*
    TWO STATEMENTS, AND NOT ONE `or`.

    The condition is "old AND (quiet OR never beat at all)", which reads as a
    single `.or(...)` — and an `.or()` here would be a STRING with a timestamp
    interpolated into it, which is the filter this platform has already paid
    for once: the screening consumer's claim predicate was exactly that, it
    never parsed, and the claim had never once succeeded while the code and
    its test double agreed with each other. A contract test forbids it.

    So each half is its own statement with typed filters the builder composes.
    The sweep runs once a pass; a second round-trip is not a cost worth a
    composed predicate.
  */
  const claimable = [...MIGRATION_CLAIMABLE_STATUSES];

  /*
    QUIET SINCE, on THIS LANE'S OWN heartbeat — the only reason the age above
    can be short enough to matter.

    `updated_at` cannot serve however tempting: it is ROW-wide, and the
    reference-data lane claims and releases the same `ready` backend through
    `reference_sync_started_at` without ever looking at `worker_started_at`.
    Its cadence writes this row two minutes before every fleet pass, so a dead
    claim on any clone it touches would read as alive for ever.
  */
  const { error: quietErr } = await supabase
    .from("clone_backends")
    .update({ worker_started_at: null })
    .in("status", claimable)
    .not("worker_started_at", "is", null)
    .lt("worker_started_at", cutoff)
    .lt("migration_heartbeat_at", cutoff);
  if (quietErr) {
    return `Could not reclaim quiet migration claims: ${quietErr.message}`;
  }

  /*
    AND a claim that has never beat at all — taken by a deployment older than
    the heartbeat column. It carries NULL, a NULL comparison is not true, and
    the sweep above would therefore leave it held FOR EVER: the exact failure
    this whole change exists to end, reintroduced for the rows that most need
    it. Gated by the claim's age, which is how those rows behaved before.

    Two statements rather than one `.or(...)`, and that is not a style
    preference. An `.or()` here would be a STRING with a timestamp interpolated
    into it — the filter this platform has already paid for once, where the
    screening consumer's claim predicate never parsed and had never once
    succeeded while its code and its test double agreed with each other.
    `fleetPassIsBudgeted.contract.test.ts` asserts both sweeps carry the same
    guard, so the repetition below cannot drift into two different rules.
  */
  const { error: unbeatenErr } = await supabase
    .from("clone_backends")
    .update({ worker_started_at: null })
    .in("status", claimable)
    .not("worker_started_at", "is", null)
    .lt("worker_started_at", cutoff)
    .is("migration_heartbeat_at", null);
  if (unbeatenErr) {
    return `Could not reclaim unbeaten migration claims: ${unbeatenErr.message}`;
  }
  return null;
}

/**
 * The prime corpus, ALREADY narrowed to what the prime's database has applied.
 *
 * Extracted so there is exactly one implementation of the #71 rule — "a clone
 * never runs a migration the prime itself has not run" — for every caller that
 * replays prime migrations onto a clone.
 *
 * It had two callers and one implementation. The scheduled fleet sync scoped;
 * the per-clone "Sync migrations" button passed `corpus.metas` — the raw repo,
 * 962 files including two rollback scripts and 52 future-dated versions —
 * straight to `applyPrimeMigrations`. One click on 2026-08-28 replayed the
 * repo's January-2025 tail at a tenant backend: the four versions the earlier
 * incident had already stamped were skipped by the ledger, and the fifth
 * (`20250124140000`, absent from the prime's own ledger, so a version the
 * clone should never have been sent) failed on the introspected schema and
 * marked the backend `failed` — which took it out of the fleet sync AND
 * blocked its deployment, whose env step waits on a ready backend.
 *
 * Fails closed exactly as the scheduled path always has: an unreadable or
 * empty prime ledger is a refusal, never a fall-back to the whole repo.
 */
export async function openScopedPrimeCorpus(
  supabase: Db,
  source: NonNullable<Awaited<ReturnType<typeof resolvePrimeSource>>>,
): Promise<
  | {
      ok: true;
      corpus: Awaited<ReturnType<typeof openPrimeMigrationCorpus>>;
      /**
       * The whole corpus in corpus order, carrying what this pass READ —
       * body digests, and what each migration creates and requires.
       *
       * `corpus.metas` is the same sequence WITHOUT them, and passing that to
       * `partitionByDependency` leaves its barrier blanket: with no `requires`
       * on a candidate and no `creates` on a hole there is nothing to
       * intersect, so the first hole orphans everything behind it. Every
       * caller that partitions reads this field.
       */
      metas: readonly CorpusMetaOf[];
      runnable: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["runnable"];
      /**
       * The VERSIONS a replay may treat as runnable: those every file of which
       * the scope cleared. Every caller hands this to the partition and the
       * replay rather than mapping `runnable` to its ids, which cleared a whole
       * shared version on the strength of one of its files — so a file the
       * prime never ran was sent because its sibling had been.
       */
      runnableIds: ReadonlySet<string>;
      /**
       * Versions the scope cleared PART of: some files at the version are in
       * the prime's ledger by body, others are not. Each stands as a hole and
       * nothing at it is sent; named, because a version the prime ran half of
       * is a finding about the prime rather than a gap on a clone.
       */
      splitVersions: SplitVersion[];
      runnableBy: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["runnableBy"];
      withheld: number;
      breakdown: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["breakdown"];
      sourceSha: string;
      primeAppliedCount: number;
      /** Distinct migration BODIES the prime's ledger holds. */
      primeBodyCount: number;
      withheldEntries: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["withheld"];
      primeRef: string;
      /**
       * Withdrawn files whose version the prime's ledger records anyway. The
       * files stay out of the corpus; this only names the contradiction.
       */
      withdrawnButRecorded: ReadonlyArray<{ id: string; name: string }>;
      /**
       * What the prime's seed skeletons contributed to this pass's facts: the
       * seeds read through one, and the ones that could not be. Null when the
       * manifest step itself failed, which leaves every seed unread — the
       * behaviour the pass had before the prime published skeletons.
       */
      seedSkeletons: SeedSkeletonReport | null;
    }
  | { ok: false; error: string }
> {
  let corpus: Awaited<ReturnType<typeof openPrimeMigrationCorpus>>;
  try {
    corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to read prime repo migrations",
    };
  }

  let primeApplied: Set<string>;
  let primeBodyDigests: Set<string>;
  let primeRef: string;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
    // Both halves of the ledger in one read: what the prime recorded, and what
    // it actually ran. The digest is computed by the one expression named in
    // `migrationBodyIdentity.pure.ts` so the two sides of the comparison
    // cannot drift into two rules.
    const rows = (await runSqlOnProject(
      primeRef,
      `select version, ${LEDGER_BODY_DIGEST_SQL} as body_digest from supabase_migrations.schema_migrations`,
    )) as Array<{ version?: unknown; body_digest?: unknown }>;
    const safe = Array.isArray(rows) ? rows : [];
    primeApplied = new Set(
      safe.map((r) => r?.version).filter((v): v is string => typeof v === "string"),
    );
    primeBodyDigests = new Set(
      safe
        .map((r) => r?.body_digest)
        .filter((d): d is string => typeof d === "string" && d !== EMPTY_BODY_SHA256),
    );
  } catch (e) {
    return {
      ok: false,
      error:
        assertPrimeLedgerUsable({
          failed: true,
          errorMessage: e instanceof Error ? e.message : String(e),
          appliedCount: 0,
          primeRef: "unresolved",
        }) ?? "Could not read the prime backend's migration ledger",
    };
  }
  const unusable = assertPrimeLedgerUsable({
    failed: false,
    appliedCount: primeApplied.size,
    primeRef,
  });
  if (unusable) return { ok: false, error: unusable };

  // The whole corpus is READ, and the size ceiling still decides what is
  // actually fetched — measured 22 Sep 2026, 986 of 1,002 files are under it
  // and come to 4.17 MB, and the 16 above it are version-matched anyway. The
  // cache is keyed on the prime's commit, so this is one extra batch pass per
  // prime commit rather than per tick.
  //
  // Why the whole corpus rather than the unmatched part: `partitionByDependency`
  // narrows its barrier only where BOTH sides' facts are present, and a hole is
  // a file the clone has not run while a candidate is one it might. Reading only
  // the unmatched set would leave every candidate's `requires` absent and the
  // barrier blanket, which is the defect this exists to close.
  const needBody = new Set(corpus.metas.filter((m) => !primeApplied.has(m.id)).map((m) => m.path));
  let digested: Map<string, string[]> = new Map();
  let facts: Map<string, MigrationDependencyFacts> = new Map();
  let mentions: Map<string, string[]> = new Map();
  try {
    const pass = await digestPrimeBodies(
      corpus,
      corpus.metas.map((m) => m.path),
      getAppOctokit(),
      source,
    );
    digested = pass.byPath;
    facts = pass.factsByPath;
    mentions = pass.mentionsByPath;
  } catch {
    // Nothing is cleared by body this tick and nothing is narrowed by
    // dependency. That is the behaviour this function had before bodies were
    // read at all, which is the only safe direction for a failure here to fall.
  }
  // The seeds past the pass's ceiling, read through the statements the prime
  // publishes for them — each pinned to the blob it describes, so only a seed
  // whose bytes are the ones listed here gains facts. Facts and names only:
  // `digested` is untouched, so a skeleton clears nothing by body and a seed
  // the prime has not run stays withheld. What changes is that such a seed is
  // no longer an OPAQUE barrier holding every migration behind it. See
  // `seedSkeletonManifest.pure.ts`.
  let seedSkeletons: SeedSkeletonReport | null = null;
  try {
    const through = readThroughSeedSkeletons(await corpus.seedSkeletons(), corpus.files, {
      facts,
      mentions,
    });
    facts = through.facts;
    mentions = through.mentions;
    seedSkeletons = through.report;
  } catch {
    // Every seed unread, as before the prime published skeletons. The reader
    // does not reject; this is for what it does not foresee.
  }
  const metas = corpus.metas.map((m) => {
    // Digests are attached to exactly the set they always were. A
    // version-matched file never reaches the digest branch of
    // `scopeCorpusToPrime`, but it DOES reach `claimants`, so attaching one
    // here would widen an operator-visible `sharedWith` on the strength of a
    // read that was widened for a different reason.
    const d = needBody.has(m.path) ? digested.get(m.path) : undefined;
    const f = facts.get(m.path);
    // Beside the facts and from the same decoded text: the partition narrows a
    // candidate only where both were read. See `CorpusMeta.mentions`.
    const named = mentions.get(m.path);
    return {
      ...m,
      ...(d === undefined ? {} : { bodyDigests: d }),
      ...(f === undefined ? {} : { creates: f.creates, requires: f.requires }),
      ...(named === undefined ? {} : { mentions: named }),
    };
  });

  const { runnable, runnableBy, withheld, breakdown } = scopeCorpusToPrime(
    metas,
    primeApplied,
    primeBodyDigests,
  );
  const { runnableIds, split } = wholeRunnableVersions(metas, runnable);
  return {
    ok: true,
    corpus,
    metas,
    runnable,
    runnableIds,
    splitVersions: split,
    runnableBy,
    withheld: withheld.length,
    withheldEntries: withheld,
    breakdown,
    sourceSha: corpus.sourceSha,
    primeAppliedCount: primeApplied.size,
    primeBodyCount: primeBodyDigests.size,
    primeRef,
    withdrawnButRecorded: withdrawnButRecorded(
      corpus.withdrawal.excluded,
      new Set(corpus.metas.map((m) => m.id)),
      primeApplied,
    ),
    seedSkeletons,
  };
}

type CorpusMetaOf = Awaited<ReturnType<typeof openPrimeMigrationCorpus>>["metas"][number];

/**
 * Is there a seed in flight anywhere in the fleet?
 *
 * The drain tick's own front door, asked BEFORE the hook reads the GitHub
 * allowance, so a tick on a level fleet costs one indexed select and nothing
 * else — no round trip to GitHub, not even the free one to `/rate_limit`. That
 * is what a five-minute cadence has to cost to be worth having.
 *
 * ## It may only ever be MORE permissive than the pass
 *
 * This asks `isMidSeed` and nothing else. It deliberately does not apply
 * `migrationEligibility`, though the pass will: a clone whose claim has gone
 * stale reads as ineligible here and IS served by the pass, because
 * `reclaimStale` runs inside it. Asking the full question here would skip the
 * tick that would have recovered that clone, and the stale claim would then
 * wait for the half-hourly sweep.
 *
 * So the two answers are allowed to differ in exactly one direction. A false
 * yes costs one cheap pass that selects nothing; a false no costs a clone its
 * place in the drain. The test that pins this pins the direction, not the
 * predicate.
 *
 * An unreadable table answers YES. "We could not check" is not "there is
 * nothing to do", and the pass is the thing that reports a broken read.
 */
export async function fleetDrainHasWork(supabase: Db): Promise<boolean> {
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, chunk_cursor")
    .not("chunk_cursor", "is", null);
  if (error) {
    console.warn("[fleet-migration] drain pre-check could not read the fleet:", error.message);
    return true;
  }
  return (data ?? []).some((row) => isMidSeed(row));
}

/**
 * Apply the prime's migrations to a bounded slice of the fleet.
 *
 * `actorUserId` is the operator when a person pressed the button and null when
 * the scheduler ran it, so the audit row says which.
 */
export async function runFleetMigrationSync(
  supabase: Db,
  opts?: {
    batchSize?: number;
    actorUserId?: string | null;
    budgetMs?: number;
    /**
     * `sweep` (the default) is the half-hourly pass over the whole fleet.
     * `drain` serves only the clones with a seed in flight — see
     * `FleetPassMode`, which carries the measurement that made a second
     * cadence necessary.
     */
    mode?: FleetPassMode;
  },
): Promise<FleetMigrationResult> {
  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);
  const mode: FleetPassMode = opts?.mode ?? "sweep";
  // Taken before the first read, so everything this pass spends is inside it.
  const passStartedAt = Date.now();
  const budgetMs = Math.max(5_000, opts?.budgetMs ?? FLEET_PASS_BUDGET_MS);
  const deadlineAt = passStartedAt + budgetMs;

  const source = await resolvePrimeSource(supabase);
  if (!source) {
    return { ...EMPTY, error: "Prime not configured — set the prime repo in Settings first" };
  }

  const reclaimError = await reclaimStale(supabase);
  if (reclaimError) {
    /*
      LOGGED, BECAUSE THE RETURN ALONE IS QUIETER THAN THE THROW WAS.

      The commit that replaced the throw claimed this reached "the caller's own
      `result.error` and the audit row with it". Only the first half is true,
      and only for the admin button: this return is ABOVE `writeAuditLog`, so a
      pass that stops here writes no audit row at all, and the scheduled hook
      serialises the result as HTTP 200 `{"success":true,…}`. So the change
      made the failure LESS visible than the throw it replaced — the throw at
      least reached the hook's catch and a non-200 that
      `net._http_response.status_code` records.

      The return still stops the pass, which is right. What was missing is that
      it says so anywhere a person looks. Found by review.
    */
    console.error("[fleet-migration] stale-claim sweep failed; pass abandoned", {
      error: reclaimError,
    });
    return { ...EMPTY, error: reclaimError };
  }

  /*
    EVERY BACKEND, THEN THIS LANE'S OWN VERDICT ON EACH.

    This used to be `.eq("status", "ready")` — a PROVISIONING queue status,
    written by a different worker, read here as though it were a fact about a
    tenant's database. It is not, and every other reader of `clone_backends`
    in this repository already knows that: deploy, secret forwarding, signing
    pairs, allowed origins and CI credentials all ignore `status` entirely.
    The migration lane was the only one gating on it, which is precisely why
    the symptom presented as "SQL migrations don't run on clones" while
    nothing else in the fleet looked wrong.

    Measured 8 Sep 2026: two clones were queued as REPAIRS on 7 September,
    never claimed once (`attempts: 0`), and swept to `failed` 24 hours later
    by the provisioning drain's wall-clock ceiling. Both databases were
    healthy and level with the third. Every run for the next day reported
    `processed 1 … excluded 2`, and two of three tenants stopped receiving the
    prime's schema with nothing anywhere naming them.

    So this lane asks its own question, in `migrationEligibility`: is there a
    project to talk to, is the provisioning worker not currently inside it,
    and has a migration failed here before? Only the last of those is a fact
    about the schema, and only this lane may write it.
  */
  // `migrations_applied` and `status_detail` are deliberately NOT here. They
  // were, for the blockage reconciliation — and reconciling from a row read
  // before the claim and before up to a whole pass budget of network work is how a
  // concurrent writer's record gets replaced by a stale one. That pair is
  // re-read per clone at the moment it is written, so selecting it here would
  // be a snapshot nothing may use.
  const { data: allBackends, error: excludedErr } = await supabase
    .from("clone_backends")
    .select(
      "clone_id, supabase_project_ref, migration_version, status, worker_started_at, migration_heartbeat_at, migration_blocked_at, migration_blocked_reason, chunk_cursor",
    );
  if (excludedErr) {
    return { ...EMPTY, error: `Could not read clone backends: ${excludedErr.message}` };
  }

  const verdicts = (allBackends ?? []).map((b) => ({
    row: b,
    verdict: migrationEligibility({
      supabaseProjectRef: b.supabase_project_ref,
      status: b.status,
      workerStartedAt: b.worker_started_at,
      migrationBlockedAt: b.migration_blocked_at,
      migrationBlockedReason: b.migration_blocked_reason,
    }),
  }));
  /*
    A BLOCK THE CLONE HAS SINCE DISCHARGED IS NOT A BLOCK.

    `migration_blocked_at` holds a clone out of this lane until it is repaired,
    and nothing was watching for the repair. The sync will not create a run for
    a blocked clone, and the only thing that clears the flag runs inside a run
    — so a clone could only leave the state through a route that does not
    consult eligibility at all. `npc-test-76b3b3` sat there for five hours
    quoting a syntax error that had been fixed on the prime two minutes after
    it was recorded, while its own ledger already held the version.

    So each blocked clone is asked one question before it is skipped: does it
    now record the version its block names? One ledger read, and only for a
    clone that is already being excluded — the common path costs nothing. The
    answer is the clone's own applied-set, which is the same union the replay
    skips, so this cannot license a send the replay would refuse.

    It clears the block and nothing else. `status` belongs to whichever lane
    last ran a migration here; two writers on one field is the fault this
    codebase keeps meeting, and `clearStaleMigrationFailure` settles it on the
    pass that follows.
  */
  const rehabilitated: string[] = [];
  /*
    The scoped corpus, when the sequence test below had to open it before the
    queue was known. The replay reuses it rather than reading the prime twice
    in one pass; left null on every pass that test does not run, which is
    every drain tick and every sweep with no ordering block to test.
  */
  let earlyScoped: Awaited<ReturnType<typeof openScopedPrimeCorpus>> | null = null;
  for (const v of verdicts) {
    if (v.verdict.eligible) continue;
    if (v.verdict.reason !== "migration_blocked") continue;
    const ref = v.row.supabase_project_ref;
    if (!ref) continue;

    /*
      A QUOTA REFUSAL IS RETRACTED WITHOUT ASKING THE LEDGER.

      The ledger test below answers "has this clone since applied what it
      refused?", and a block written from an upstream refusal can never pass
      it: nothing was sent, so the version it names cannot enter this clone's
      ledger except through a run, and a blocked clone gets no run. Three
      clones sat in that deadlock for five days while the prime moved
      twenty-three migrations ahead of them.

      Asked FIRST, and deliberately: such a block needs no evidence about the
      clone's schema, so the ledger read is not merely redundant here, it is a
      round trip whose FAILURE would keep a block that was never about this
      clone — the `!ledger.ok` guard below is correct for a real block and
      would be wrong for this one.
    */
    const upstreamRefusal = blockIsUpstreamRefusal(v.row.migration_blocked_reason);
    // Set when the block is discharged by the lane's own order rather than by
    // the ledger — the third route, named in the log line below.
    let overtaken: string | null = null;

    if (!upstreamRefusal) {
      const ledger = await readCloneMigrationLedger(ref);
      // A read that FAILED says nothing, and an empty array is a claim. Keep
      // the block rather than discharging one on a query that did not answer.
      if (!ledger.ok) {
        console.error(
          `[fleet-migration] could not read ${v.row.clone_id}'s ledger to test its block:`,
          ledger.error,
        );
        continue;
      }
      const appliedVersions = ledger.rows.map((r) => r.version);
      if (!blockIsDischarged(v.row.migration_blocked_reason, appliedVersions)) {
        /*
          A BLOCK THE LANE'S OWN ORDER CAUSED IS ASKED ONE MORE QUESTION.

          The ledger test cannot discharge a block written because this lane
          sent a migration before the one it depends on: the named version
          enters the ledger only by running, and a blocked clone is sent
          nothing — including the migration that would let it run. The
          independent sat there from 22 Sep, blocked on the v15 template
          refresh the lane had sent ahead of its seed. So the block is tested
          against the order the lane would send NOW, from the same partition
          and the same ledger the replay decides from. See
          `blockSequence.pure.ts` for why it cannot loop.

          Sweep passes only. The test needs the scoped corpus, and a drain tick
          may open that only once it has a clone to serve — that is what keeps
          an idle drain free (`fleetDrainCadence.test.ts`). A discharge waits
          at most one sweep for it, and the corpus it opens is the one the
          replay then uses.
        */
        if (mode !== "sweep") continue;
        earlyScoped ??= await openScopedPrimeCorpus(supabase, source);
        if (!earlyScoped.ok) {
          console.error(
            `[fleet-migration] could not open the prime's corpus to test ${v.row.clone_id}'s block against the lane's order:`,
            earlyScoped.error,
          );
          continue;
        }
        const sequence = blockOvertakenBySequence({
          reason: v.row.migration_blocked_reason,
          metas: earlyScoped.metas,
          runnableIds: earlyScoped.runnableIds,
          cloneApplied: new Set(appliedVersions),
        });
        if (!sequence.discharged) continue;
        overtaken = sequence.why;
      }
    }

    const { error: clearErr } = await supabase
      .from("clone_backends")
      .update({ migration_blocked_at: null, migration_blocked_reason: null })
      .eq("clone_id", v.row.clone_id)
      .not("migration_blocked_at", "is", null);
    if (clearErr) {
      console.error(
        `[fleet-migration] ${v.row.clone_id} has discharged its block but it could not be cleared:`,
        clearErr.message,
      );
      continue;
    }

    // Named, because the two routes mean different things: one says the clone
    // has since applied what it refused, the other says it never refused
    // anything. An operator reading this later needs to know which.
    console.log(
      `[fleet-migration] ${v.row.clone_id} rejoins the lane — ` +
        (upstreamRefusal
          ? "its block recorded an upstream quota refusal, not a schema rejection"
          : overtaken
            ? `the lane no longer sends the version its block named first: ${overtaken}`
            : "its ledger now records the version the block named"),
    );

    v.row.migration_blocked_at = null;
    v.row.migration_blocked_reason = null;
    v.verdict = { eligible: true };
    rehabilitated.push(v.row.clone_id);
  }

  const skipped = verdicts.filter((v) => !v.verdict.eligible);
  const excludedCount = skipped.length;

  // Furthest behind first, ties broken by least progress on the seed in
  // flight. The order lives in the pure module beside the eligibility rules
  // because who is served first is the same kind of decision as who is served
  // at all — and because a comparator that returned 0 on a tie handed this
  // fleet's whole budget to one clone for as long as it was measured. See
  // `compareMigrationQueue`.
  /*
    THE MODE NARROWS WHAT IS ALREADY ELIGIBLE, AND NEVER THE OTHER WAY.

    Applied after `migrationEligibility` and before the order, so a drain tick
    reaches no clone a sweep would not, and the clone it serves first is chosen
    by the same comparator. A tick that selects nothing falls out at the early
    return below — which sits ABOVE the corpus open, so an idle drain costs no
    GitHub call at all. That placement is what makes a five-minute cadence
    affordable, and `fleetDrainSelectsNothingWithoutTheCorpus` pins it.
  */
  const backends = orderMigrationQueue(
    scopeQueueToMode(
      verdicts.filter((v) => v.verdict.eligible).map((v) => v.row),
      mode,
    ),
  ).slice(0, batchSize);

  // Names for BOTH sets, read once. A skipped clone is reported by name, so
  // this read has to cover the ones this run will not touch as well as the
  // ones it will — which is the whole difference between `excluded: 2` and
  // knowing which two.
  const { data: clones } = await supabase
    .from("clones")
    .select("id, name")
    .in("id", [...verdicts.map((v) => v.row.clone_id)]);
  const nameOf = new Map((clones ?? []).map((c) => [c.id, c.name]));

  const out: FleetMigrationResult = {
    ...EMPTY,
    failed: [],
    heldOversize: [],
    rateLimited: [],
    heldByRule: [],
    excluded: excludedCount,
    rehabilitated,
    skipped: skipped.map((v) => ({
      cloneId: v.row.clone_id,
      cloneName: nameOf.get(v.row.clone_id) ?? v.row.clone_id,
      // Narrowed by the filter above; restated for the type.
      reason: (v.verdict as { reason: MigrationSkipReason }).reason,
      detail: (v.verdict as { detail: string }).detail,
    })),
  };
  if (!backends || backends.length === 0) return out;

  // List the prime's migrations ONCE, as metadata, and let the bodies arrive on
  // demand.
  //
  // Materialising them here is what made this job impossible to finish: the
  // corpus is 962 files and 158 MB — four generated template-library seeds are
  // 36-41 MB each — so the run spent 59.8 s in GitHub round trips and pg_net
  // cut it off at 60 s having claimed nothing and written nothing. It failed
  // that way every time, and on the admin button before it.
  //
  // The bodies were never the shared cost they looked like. A clone in step
  // with the prime needs NONE of them, and two clones behind by the same
  // migration share one fetch through the corpus's own memo. Listing is two
  // API calls; a body costs a round trip only when some clone is actually
  // missing that version.
  // One implementation of the corpus-plus-scoping sequence, shared with the
  // per-clone sync button. See openScopedPrimeCorpus for what having two cost.
  // Opened once per pass: the sequence test above may already have read it,
  // and a read that failed there is asked again rather than inherited.
  const scoped = earlyScoped?.ok ? earlyScoped : await openScopedPrimeCorpus(supabase, source);
  if (!scoped.ok) return { ...out, error: scoped.error };
  const { corpus, metas: scopedMetas, runnable, sourceSha } = scoped;
  out.withheld = scoped.withheld;
  out.withheldBreakdown = scoped.breakdown;
  if (scoped.splitVersions.length > 0) out.splitVersions = scoped.splitVersions;
  out.withdrawn = {
    state: corpus.withdrawal.state,
    ...(corpus.withdrawal.why ? { why: corpus.withdrawal.why } : {}),
    files: corpus.withdrawal.excluded.map((m) => m.name),
    unmatched: [...corpus.withdrawal.unmatched],
    recordedOnPrime: scoped.withdrawnButRecorded.map((m) => m.name),
  };
  if (scoped.seedSkeletons) out.seedSkeletons = scoped.seedSkeletons;

  for (const backend of backends) {
    const cloneId = backend.clone_id;
    const cloneName = nameOf.get(cloneId) ?? cloneId;

    /*
      OUT OF TIME IS NOT A VERDICT ABOUT THIS CLONE.

      Checked BEFORE the claim, so a pass with nothing left to give leaves the
      row exactly as it found it. Claiming first and dying is what left
      `worker_started_at` set on two clones on 19 Sep, and a leaked claim does
      not merely delay that clone: `backends` is filtered on the claim being
      free, so for the next half hour the whole fleet behind it waits too.

      `stoppedAtBudget` is reported rather than swallowed, because a pass that
      served three of five clones and a pass that found five level are the same
      shape in every other field.
    */
    if (Date.now() + CLAIM_RESERVE_MS >= deadlineAt) {
      out.stoppedAtBudget = true;
      break;
    }

    // Claim. The filter carries `worker_started_at is null` so two overlapping
    // runs cannot both take the same clone — pg_cron does not serialise its own
    // job, and applying one migration twice concurrently is how a clone gets
    // marked failed by a duplicate-object error it never really had.
    //
    // `status` is a COMPARE-AND-SWAP on the value eligibility was decided
    // against, not a requirement that it be `ready`. Between the plan above
    // and this line an operator can retry or repair a backend, which moves it
    // to `pending` and hands it to the provisioning worker; claiming it then
    // would put this lane inside a schema somebody else is rebuilding. A
    // changed status returns no row and the clone waits for the next tick,
    // which is the correct outcome and costs half an hour at most.
    /*
      THE FENCE.

      One timestamp, held for the rest of this clone's turn and required by
      every write that follows. `worker_started_at` stops being a flag that a
      claim exists and becomes the name of WHOSE claim it is.

      Needed because the reclaim window above is now five minutes rather than
      thirty. A pass parked inside `runSqlOnProject` — which carries no
      timeout — can be reclaimed, resumed, and then go on writing: its cursor
      into the successor's claim, and, worse, its release over the successor's
      `worker_started_at`, which puts two passes inside one clone's schema
      applying the same migrations at once. That is the exact outcome the
      claim's own compare-and-swap exists to prevent, arriving a few minutes
      later through the back door. Raised by review; the shorter window is
      what makes it reachable.

      A fenced write that matches no row is not an error and must not be
      treated as one: it is this pass being told the clone is no longer its
      to write about. Each site below says what it does with that answer.

      It also closes a smaller thing: the two fields were two separate
      `new Date()` calls and could differ by a tick, so nothing could be
      compared against the other.
    */
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from("clone_backends")
      .update({
        worker_started_at: claimedAt,
        // Stamped WITH the claim, in the same statement. A claim whose
        // heartbeat is only written by the first statement would be
        // indistinguishable from an abandoned one for as long as the seed
        // takes to download — which is the longest part of a pass.
        migration_heartbeat_at: claimedAt,
      })
      .eq("clone_id", cloneId)
      .eq("status", backend.status)
      .is("worker_started_at", null)
      .select("clone_id");
    if (claimErr) {
      // A claim that ERRORED is not a claim somebody else won. Discarding the
      // difference is what made the screening consumer's claim look like a lost
      // race for months while it had never once succeeded.
      out.failed.push({ cloneId, cloneName, error: `claim failed: ${claimErr.message}` });
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // another run has it

    /*
      THE HEARTBEAT IS A CLOCK, NOT A BYPRODUCT OF PROGRESS.

      The first version beat only in `onStatementDone`, which belongs to the
      OVERSIZED-SEED path alone. Every other replay — an ordinary DDL, and in
      particular one blocked inside the timeout-less `runSqlOnProject` — was
      silent from the claim onwards, so a five-minute window would reclaim a
      pass that is working and a successor would start sending the same
      migrations into the same schema. The fence stops the reclaimed pass from
      WRITING; it cannot stop the SQL it has already dispatched, and that is
      the concurrent application the claim exists to prevent. Raised by review
      on #227, and it is a defect this PR creates: at thirty minutes the same
      hole existed and was very hard to reach.

      So liveness is measured by a timer rather than inferred from work. It
      covers every silent stretch there is, including one nothing in this file
      can see. Three properties make it safe:

      - It is FENCED, like every other write here. A beat that matches no row
        means the claim has already gone, and the timer stops rather than
        resurrecting a claim this pass no longer holds.
      - It is stopped in a `finally`, so a pass that returns, throws or breaks
        stops beating at once. A timer outliving its pass would hold a dead
        claim open for ever, which is worse than the window it replaces.
      - It dies with the isolate. A killed pass stops beating by construction,
        which is the case the window is actually for.
    */
    const heartbeat = beatWhileClaimHeld(supabase, cloneId, claimedAt);

    try {
      const {
        results,
        latestApplied,
        stoppedEarly,
        chunksApplied,
        chunkCursor,
        chunkCursorDiscarded,
        primeLedgerHoles,
      } = await applyPrimeMigrations(
        backend.supabase_project_ref!,
        runnable,
        undefined,
        // By FILE: a version two files share is two bodies.
        (m) => corpus.loadSql(m),
        // `runnable` alone cannot say whether a cleared version sits behind a
        // withheld one. The whole corpus can — and `scoped.metas` rather than
        // `corpus.metas`, because only the first carries the dependency facts
        // that narrow the barrier from blanket to per-dependency. The ids are
        // the scope's WHOLE versions, never `runnable`'s: see its field.
        { corpus: scopedMetas, runnableIds: scoped.runnableIds },
        /*
          A BODY TOO BIG TO HOLD IS STILL SENDABLE.

          `openPrimeMigrationCorpus` refuses a body past its ceiling, and the
          ceiling is right: the template-library seed is one 39 MB INSERT, and
          this runtime cannot hold it. But `applyPrimeMigrations` has always
          been able to STREAM such a body and send it as statements — and only
          one of its four callers ever supplied the option, so the other three
          could not apply that migration at all.

          The corpus this function already holds exposes the stream. Passing it
          is the whole fix: the chunker sends the file's own ON CONFLICT clause
          with every statement, so a pass that dies mid-seed is re-sent by the
          next one rather than double-inserting, and the ledger row is written
          only once every statement has landed.

          A CURSOR IS PASSED NOW, AND THE REASONING THAT SAID IT NEED NOT BE
          IS KEPT HERE BECAUSE IT WAS NEARLY RIGHT.

          It read: "No cursor is passed. The self-healing lane persists one
          because it runs inside a hard invocation budget; this job is
          reclaimed after `STALE_CLAIM_MINUTES` and re-sends from the first
          statement, which is idempotent by the clause above. Slower, never
          wrong."

          Idempotent, yes — the ON CONFLICT clause above makes a re-send free.
          Slower, no. Re-sending from the first statement is only slower if a
          pass eventually reaches the LAST one, and a ~40 MB seed in this
          runtime does not: every pass restarts at statement 1 and is killed
          before the end, so the seed never lands however often it is tried.
          That is a livelock, and it was hidden for as long as the body could
          not be fetched at all — a 403 returns in milliseconds, so the lane
          looked healthy precisely while it was incapable of the work.

          Measured 19 Sep 2026, the day the streaming fetch first worked: the
          two passes that followed both died mid-seed, neither recorded a
          `lane:fleet-migration-sync` usage row, both left `worker_started_at`
          set — which starves every OTHER clone too, since the loop needs the
          claim free — and no clone's `migration_version` moved.
        */
        // Stop BETWEEN migrations once this pass's budget is spent, reserving
        // the slowest migration applied so far — so a pass never STARTS one it
        // cannot live to finish and then reports the clone level.
        { isPastDeadline: (reserveMs) => Date.now() + reserveMs >= deadlineAt },
        {
          streamSql: (m) => corpus.openSqlStream(m),
          /*
            AND WHICH BODY THAT STREAM WILL OPEN.

            The corpus already knows: every entry came from a git tree listing,
            and a blob sha IS the content. Handing it down is what lets the
            cursor below be refused when the file it names has been re-released
            since the position in it was taken — which the shape cannot detect,
            because rewriting every tuple's VALUES moves neither the header, the
            ON CONFLICT clause, the tail nor the COUNT.
          */
          bodyIdentity: (m) => corpus.bodyIdentity(m),
          /*
            THE CURSOR IS THE DIFFERENCE BETWEEN SLOW AND NEVER.

            Read from the clone's own row and written on EVERY statement, not
            at the end of the pass. A pass that is killed is the ordinary case
            for a 40 MB seed in this runtime, so a cursor only a surviving pass
            could write would be worth exactly as much as no cursor — which is
            what this lane had, and why the seed could not land however many
            times it was tried.

            The stamp is checked against the migration it names AND against
            the body's own sha before it is believed: a cursor into a different
            file — or into an older release of the same file — would make this
            pass skip statements of the seed it is actually sending.
          */
          cursor: chunkCursorFor(backend.chunk_cursor),
          onStatementDone: async (p) => {
            const { data: beat, error } = await supabase
              .from("clone_backends")
              .update({
                // `shape` rides the cursor so the NEXT pass reads this
                // 41 MB body once instead of twice — see
                // `chunkCursorStore.pure.ts`.
                chunk_cursor: {
                  migrationId: p.migrationId,
                  statementsDone: p.statementsDone,
                  shape: p.shape,
                  /*
                    Spread rather than assigned. `undefined` and an absent key
                    are the same to TypeScript and different to the jsonb this
                    lands in, where an explicit null would read as "this body
                    has no identity" rather than "nobody said" — and the two
                    send the next pass to opposite behaviours.
                  */
                  ...(p.bodySha === undefined ? {} : { bodySha: p.bodySha }),
                },
                status_detail: `Sending ${p.name} — ${p.statementsDone} statement(s) in (${p.label})`,
                /*
                    AND NOT THE HEARTBEAT.

                    This wrote `migration_heartbeat_at` too, from the days
                    before the timer existed and liveness had to be inferred
                    from progress. With the timer it is a SECOND, unserialised
                    writer of one column: a beat dispatched earlier can land
                    after this one and move the stamp BACKWARDS, which is the
                    reordering serialising the timer had just closed, arriving
                    through the other door. Raised by review.

                    Removing it restores what `reclaimStale` has always claimed
                    — that one mechanism writes this column — and loses no
                    coverage, because the timer beats through the download this
                    callback cannot reach anyway. The fence stays: that is
                    ownership, which is a different question.
                  */
              })
              .eq("clone_id", cloneId)
              .eq("worker_started_at", claimedAt)
              .select("clone_id");
            if (error) {
              // Not fatal: the statements themselves have landed and the seed's
              // own ON CONFLICT makes re-sending them free. But a cursor that
              // cannot be written turns a resumable pass back into the livelock
              // this exists to end, so it must not be silent.
              console.error("[fleet-migration] chunk cursor not recorded", {
                cloneId,
                migration: p.name,
                statementsDone: p.statementsDone,
                error: error.message,
              });
              return;
            }
            /*
                A FENCE MISS IS FATAL, WHERE A FAILED WRITE IS NOT.

                No row matched, so `worker_started_at` is not this pass's any
                more: the claim was reclaimed and another pass holds it. The
                write not landing is the least of it — continuing would send
                the next statement of this seed into a database a second pass
                is already sending to, which is the concurrent application the
                claim exists to prevent.

                Thrown rather than returned, because the replay has no way to
                be told "stop" and nothing below it would ask. It is neither a
                `SeedShapeError` nor a `cloneSaidNothing`, so it travels
                through the replay's own catches untouched and lands in this
                clone's `catch` — where the release is fenced too, and
                therefore takes nothing away from the pass that now owns the
                row.
              */
            if (!beat || beat.length === 0) {
              // `ClaimLostError` rather than a plain `Error`: the replay
              // catches every exception per migration and records it as a
              // migration the CLONE refused, which is the wrong sentence and
              // skips the fenced release below. That class is the one thing
              // it rethrows.
              throw new ClaimLostError(
                `${CLAIM_LOST}: this pass was reclaimed while sending ${p.name} ` +
                  `(statement ${p.statementsDone}); another pass now holds this clone, so ` +
                  `this one stops rather than sending into a database it no longer owns`,
              );
            }
          },
        },
      );
      const successes = results.filter((r) => r.success && !r.skipped);
      /*
        A HOLD IS NOT A FAILURE, AND THE DIFFERENCE IS THE CLONE'S LIFE.

        A body past the corpus ceiling with no streaming option available is
        reported `heldOversize`: the clone was never sent anything and is
        exactly as healthy as it was. An ordinary failure means the clone's
        schema REJECTED something and the replay must stop.

        Both halt the replay. Only one may move the clone out of `ready` — and
        conflating them is what put `NPC Client Dashboard` at `failed` on 3
        September under `Migration failed at 20260916100000_seed_template_
        library_v9_report_part_numbering.sql`, ejected from this worker's own
        query, with an operator notice reading "no further prime migrations
        will reach this clone's database". It was true, and nothing was wrong
        with the clone.

        With `streamSql` supplied above this branch should now be unreachable
        from here. It is kept because it is the safety net for the NEXT caller,
        and because the cost of getting it wrong is measured rather than
        imagined.
      */
      const held = results.filter((r) => r.heldOversize);
      // The second kind of hold, and the one this lane was blind to. A body an
      // upstream quota refused to SERVE never reached the clone either, so it
      // answers to the rule directly above rather than to the failure branch:
      // it was the fetch that was refused, not the schema that rejected
      // anything. Measured 19 Sep 2026, three clones were moved to `failed`
      // here under the name of a migration not one of them had been sent.
      const limited = results.filter((r) => r.heldUpstreamLimited);
      // The third kind: a version a RULE held — a shared version that could
      // not travel whole. Nothing was sent, so nothing about the clone was
      // judged, and it answers to the rule above rather than to the failure
      // branch. See `sharedVersionDelivery.pure.ts`.
      const byRule = results.filter((r) => r.heldByRule);
      const failures = results.filter(
        (r) => !r.success && !r.heldOversize && !r.heldUpstreamLimited && !r.heldByRule,
      );
      // Runnable, but sitting behind a version this clone has not got. Skipped
      // rather than run — see `partitionByDependency`.
      const blocked = results.filter((r) => r.blockedBy && r.blockedBy.length > 0);

      out.processed++;
      // `limited` joins this guard rather than falling through it: see the
      // field's own note. A pass that could not FETCH is not a pass that found
      // nothing to do.
      if (
        successes.length === 0 &&
        failures.length === 0 &&
        held.length === 0 &&
        limited.length === 0 &&
        byRule.length === 0 &&
        // Nor is a pass that sent part of a chunked seed. `upToDate` is read as
        // "nothing to do on this clone", and a clone forty statements into a
        // 40 MB seed has a great deal left to do — the same distinction
        // `didNothing` draws below, in the counter rather than the sentence.
        chunksApplied === 0
      ) {
        out.upToDate++;
      } else if (failures.length === 0) {
        out.advanced++;
      }

      /*
        A PASS THAT DID NOTHING MUST SAY NOTHING.

        This update used to be unconditional, so a clone that was already level
        — the ordinary, healthy case — had three facts overwritten with the
        shape of "nothing happened":

          migration_version  → null   (the recorded version, erased)
          migrations_applied → []     (what provisioning applied, emptied)
          status_detail      → "Synced to null"

        Measured 4 Sep 2026: both ready clones carried exactly that, and the
        third — the one that is `failed`, and therefore outside this worker's
        query — still held its real version and its three migration rows. Only
        the HEALTHY clones lost their record, which is the wrong way round and
        is why nobody noticed.

        The status line is the worst of the three: it replaced the parity
        verdict the provisioning run had just written ("Backend provisioned but
        DOES NOT MATCH the prime — …") with a string that means nothing and
        reads like a bug. That is the two-writers-of-one-status-field rule
        again: the last writer wins, and a sync that applied nothing has
        nothing to say about the row's health.

        So a no-op pass writes only what it genuinely establishes — where the
        prime is, and the release of its own claim — and leaves every fact
        about the clone's schema exactly as it found it. And where the pass DID
        do something, a null `latestApplied` is never interpolated into prose.
      */
      // `limited` belongs in this list for the same reason it joined the
      // `upToDate` guard twenty lines up, and leaving it out made the reading
      // written for it unreachable in exactly the case it describes.
      //
      // A pass whose ONLY outcome is an upstream hold has `successes`,
      // `failures`, `blocked` and `held` all empty — so without this it counts
      // as "nothing happened", writes no `status_detail`, and leaves whatever
      // the previous pass said standing. Measured on `npc-test-76b3b3`, which
      // sits at `20261201100000` with the 40 MB seed as its only pending
      // migration: a held pass left it reading `Migration failed at
      // 20261202000000_…` from an earlier run, which is the sentence this
      // whole change exists to stop an operator being shown.
      //
      // It also leaves the row `failed`, and a `failed` row is outside the
      // reference-data lane's query — so the clone stops receiving its
      // sanctions register too, which is how one quota refusal on 14 Sep came
      // to freeze `aml.sanctions_entries` at 21,600 of 24,294 for five days.
      const didNothing =
        successes.length === 0 &&
        failures.length === 0 &&
        blocked.length === 0 &&
        held.length === 0 &&
        limited.length === 0 &&
        byRule.length === 0 &&
        // A pass that sent part of a chunked seed and finished no migration
        // still moved this clone forward. Counting it as "nothing happened"
        // would leave the previous pass's sentence standing over real progress.
        chunksApplied === 0;
      /*
        THE BEATS STOP BEFORE THE RELEASE, NOT AFTER IT.

        The `finally` below still stops the heartbeat — this is not a move,
        it is an earlier first call, and the later ones await the SAME drain
        rather than starting another — see the memoisation on `stop`, which is
        what makes calling it three times cost what calling it once costs.
        What the order buys is the set of beats that can outlive the release.

        Stopped afterwards, every beat dispatched during the replay is still
        live while the release runs, and any of them that commits after a
        FAILED release re-stamps a claim nobody holds. Stopped here, the
        abort has already dropped everything not yet sent and the drain has
        given what was sent its two seconds, so only a beat still in flight
        past that can land late.

        It cannot go the other way round and it cannot backfire: after this
        line the pass does one small UPDATE, which is far inside
        `STALE_CLAIM_MINUTES`, and if that write is slow enough to be
        reclaimed anyway its own fence catches it — which is the case
        `CLAIM_LOST` already reports.
      */
      await heartbeat.stop();
      /*
        WHAT THIS CLONE RECORDS, NEVER A PHRASE THAT ASSERTS THE FRONTIER.

        `latestApplied` is what THIS PASS applied, and it is null whenever the
        pass applied nothing — which is the ordinary outcome of a pass that
        spent its whole budget inside one seed. The fallback said "the prime's
        latest recorded migration", so the sentence an operator read was
        "Synced to the prime's latest recorded migration" about a clone four
        migrations behind. Measured on `npc-client-dashboard` at 18:43 on
        19 Sep 2026, beside "4 migration(s) held back".

        Found twice, independently, and the second reading is why the prose at
        the end is what it is: at 06:21 on 20 Sep all THREE draining clones
        read `Synced to the prime's latest recorded migration so far — this
        pass stopped at its time budget`. The opening clause is the strongest
        claim of synchrony this product can make and the qualification after
        it does not undo it — so the last rung names the CLONE's own record,
        or says there is none, and never the prime's frontier.

        The clone's own recorded version is on the row this pass just read, and
        it is a fact rather than a claim. A clone that records nothing says so.

        ONE RULE, READ BY EVERY SENTENCE THIS PASS MAY WRITE — the no-op
        path's reading and the active branch's ladder both take it, so two
        consecutive passes cannot name one clone's level differently.

        The RULE is shared; the READING it is applied to is each path's own
        freshest. `backend` was read before the claim and before up to a pass
        budget of network work, and a manual sync can finish inside that window:
        `applyPrimeMigrations` then finds the clone already level and returns a
        no-op, so `latestApplied` is null and this ladder falls through to a
        `migration_version` the sync has since moved. Composing from it writes
        `Synced to <the version before that sync>` over the accurate sentence
        the sync had just left — a stale reading passing a guard that only
        proves the SENTENCE had not moved. The no-op path therefore applies
        this rule to the version it re-reads with that sentence.
      */
      const syncedToFor = (recorded: string | null | undefined) =>
        latestApplied ?? recorded ?? "no migration recorded yet";
      const syncedTo = syncedToFor(backend.migration_version);
      /*
        WHAT THIS PASS MEASURED, AS AGAINST WHAT IT CHANGED.

        `didNothing` asks what the pass CHANGED, and gates the clone-facts on
        it for good reason. But the blockage record is not one of those facts:
        `partitionByDependency` and `rescueScopedOrphans` walk the whole corpus
        BEFORE the replay loop runs, so the holes and the held-back versions
        are a complete, current reading on every pass — including one the
        budget stopped, and one that broke on a cursor it could not honour and
        pushed no result at all.

        So the record of a blockage was written by the pass that found it and
        by no pass that disproved it. `migrations_applied` kept `blockedBy`
        entries for a hole the prime had since recorded, `blockageLedger` reads
        exactly those, and the `prime_ledger_hole` row stayed open for ever
        with the row's prose still announcing it.

        Reconciled rather than overwritten: entries that are not blockage notes
        are carried through untouched, because emptying provisioning's record
        is one of the three things the `didNothing` guard exists to stop, and
        trading that defect for this one would be no trade at all.
      */
      /*
        A PASS THE BUDGET STOPPED HAS NOT FINISHED LOOKING.

        `stoppedEarly` means the replay stopped between migrations with more to
        send, and `chunksApplied > 0` with nothing completed means it stopped
        inside a seed. Either way this clone is NOT level, and the one thing
        this lane must never write about it is a bare "Synced to X" — that is
        the reading which reports a clone dozens of migrations behind as
        healthy, and the reason `blocked` is named in the sentence below.

        It is not a failure and raises no notice: the cursor is on the row, the
        claim is released, and the next tick carries on from the statement after
        the last one sent.
      */
      const pausedMidReplay = stoppedEarly || (chunksApplied > 0 && successes.length === 0);
      if (pausedMidReplay) out.stoppedAtBudget = true;
      /*
        AN OPINION IS READ FRESH, WRITTEN UNDER THE CLAIM, AND GUARDED.

        A pass that changed nothing establishes no fact about the clone. What
        it has is a READING, and both halves of it — the blockage record and
        the sentence — are derived from a row someone else may have written
        since. Three things keep that honest, and each closes a different
        hole.

        READ FRESH. `backend` comes from the query at the top of the run,
        before the claim and before up to a pass budget of GitHub and clone
        work. Reconciling the ledger from THAT is how a concurrent manual
        sync's results get replaced by a stale array: the sync cycles
        `status_detail` from `Migrations up to date (X)` through
        `Syncing migrations from …` and back to the identical sentence while
        replacing `migrations_applied`, so a guard on the sentence alone reads
        as unchanged. Re-reading here means the reconciliation is against what
        the row holds now, not what it held a minute ago.

        WRITTEN UNDER THE CLAIM, before the update that releases it, so no
        other FLEET pass can interleave. The lanes that can — the manual sync,
        provisioning, parity, self-healing — take no claim at all
        (`worker_started_at` appears in none of them), which is what the guard
        below is for.

        GUARDED on the sentence, which is a compare-and-set on its own column
        and therefore sound: a value that cycled away and back is the value
        that was inspected, and writing over it is what this pass would have
        done anyway.

        What is NOT closed: the window between this read and this write. A
        true multi-column compare-and-set would need a jsonb predicate on
        `migrations_applied`, which is not something to build out of a URL
        filter over an array of up to fifty notes, or a revision column, which
        is a schema change. The window is one round trip rather than a whole
        pass, and the manual sync that would have to complete inside it takes
        seconds. A miss is deference, not an error — the next pass re-measures.
      */
      if (didNothing) {
        const { data: current, error: readErr } = await supabase
          .from("clone_backends")
          .select("migrations_applied, status_detail, migration_version")
          .eq("clone_id", cloneId)
          .maybeSingle();
        if (readErr) {
          // Nothing about the clone changed this pass, so there is nothing to
          // salvage and nothing to fail: the reading is re-derived next time.
          console.error("[fleet-migration] blockage reading not re-read", {
            cloneId,
            error: readErr.message,
          });
        } else {
          const blockage = reconcileBlockageRecord({
            stored: (current as { migrations_applied?: unknown } | null)?.migrations_applied,
            measured: primeLedgerHoles.slice(0, PRIME_LEDGER_HOLE_NOTE_CAP),
          });
          const inspected =
            (current as { status_detail?: string | null } | null)?.status_detail ?? null;
          const recorded =
            (current as { migration_version?: string | null } | null)?.migration_version ?? null;
          /*
            THE CLONE MOVED UNDER THIS PASS, SO THIS PASS HAS NOTHING TO SAY
            ABOUT ITS LEVEL.

            `migration_version` is re-read here, and the manual sync writes it
            in the same statement as the sentence. If it differs from the one
            this run started on, another writer advanced — or rebuilt, which
            erases it — the clone while this pass was working, and everything
            this pass knows about the clone's level was measured before that.

            Two readings would otherwise be written, and both are wrong:

            - A PAUSE. This pass stopped with more to send, so it composes
              `stopped at its time budget with more to send` — over a sync
              that has since finished the work. The sentence guard passes,
              because `Migrations up to date (…)` is this lane's own prose,
              and an accurate result is replaced by a stale pause.
            - A LEVEL READING from a version that moved. `latestApplied` is
              null on a no-op pass in this lane (`partitionByDependency` drops
              what the clone already has, so a levelled clone is sent nothing
              and the replay loop never runs), and the rung under it was the
              top-of-run snapshot.

            So the sentence is withheld entirely rather than re-derived. The
            blockage RECORD still stands: it is a reading of the PRIME's
            ledger, which no clone-side writer can invalidate.
          */
          const movedUnderUs = (recorded ?? null) !== (backend.migration_version ?? null);
          const blockageDetail = movedUnderUs
            ? null
            : blockageDetailFor({
                standing: inspected,
                holes: blockage.holes,
                total: primeLedgerHoles.length,
                // A pass that changed nothing can still have stopped with more to
                // send, so this is handed over rather than assumed: without it the
                // retraction writes a bare "Synced to X" over a pause, which is
                // the one reading this lane must never give about a clone behind.
                pausedMidReplay,
                // The same rule the active branch's sentences read, applied to
                // the version re-read a line above. Past `movedUnderUs` the two
                // readings are equal, so this is not what stops a stale
                // sentence — it is what keeps the composition reading the row
                // it is guarded on, rather than one taken a pass budget earlier whose
                // agreement has to be argued rather than seen.
                syncedTo: syncedToFor(recorded),
              });
          const noopFacts = {
            ...(blockage.entries === null ? {} : { migrations_applied: blockage.entries }),
            ...(blockageDetail === null ? {} : { status_detail: blockageDetail }),
          };
          if (Object.keys(noopFacts).length > 0) {
            // `.eq` never matches NULL in SQL, so an absent sentence needs
            // `.is`. Both branches carry the whole chain rather than sharing a
            // builder bound above them, so that the write and the `error` that
            // is read from it are one statement — which is what
            // `check:discarded-errors` reads, and what every other write in
            // this file looks like.
            const { data: wrote, error: noopErr } = await (
              inspected === null
                ? supabase.from("clone_backends").update(noopFacts).is("status_detail", null)
                : supabase.from("clone_backends").update(noopFacts).eq("status_detail", inspected)
            )
              .eq("clone_id", cloneId)
              .eq("worker_started_at", claimedAt)
              .select("clone_id");
            if (noopErr) {
              console.error("[fleet-migration] blockage reading not recorded", {
                cloneId,
                error: noopErr.message,
              });
            } else if (!wrote || wrote.length === 0) {
              /*
                TWO REASONS, AND NEITHER IS THIS PASS'S TO ACT ON.

                Either the sentence moved under the read above, or this pass
                no longer holds the claim. They are indistinguishable from one
                answer and do not need distinguishing here: both mean somebody
                else's facts are fresher, and the next pass re-measures.

                A LOST CLAIM IS STILL REPORTED — by the result write below,
                which carries the same fence, asks for its rows back and
                raises `CLAIM_LOST`. Saying it from here as well would turn
                one reclaim into two entries about one clone.
              */
              console.warn("[fleet-migration] blockage reading deferred", { cloneId });
            }
          }
        }
      }
      /*
        THE CURSOR OUTLIVES A PASS, BUT NOT ITS FILE.

        Three states, and the middle one is why this cannot be a plain write of
        whatever `applyPrimeMigrations` returned.

        FOUR states, and the fourth was the one this enumeration missed.

        A pass that stopped INSIDE the seed returns a cursor: store it.
        A pass that FINISHED the seed returns null and the migration is among
        `successes`: clear it, because a cursor into a completed file would make
        the next oversized seed skip statements that never landed on this clone.
        A pass that never REACHED the seed — the budget stopped it earlier —
        also returns null, and here the stored cursor is still exactly true.
        Writing null for that third case would throw away a resume point and
        put the livelock back for one pass in every chain.

        And a pass that found the FILE changed under a stored cursor returns
        null meaning DISCARD. It reads like the third case in every field —
        null cursor, migration not among the successes — so it fell into the
        "leave it alone" branch, the stale shape stayed on the row, and the
        next pass read it, hit the same mismatch and held again. Permanently:
        nothing in that loop ever re-reads the file, which is the livelock
        this block exists to prevent, arriving through the door the block
        itself opened. Raised by review; `chunkCursorDiscarded` is the fourth
        state said out loud rather than inferred from three fields that cannot
        distinguish it.
      */
      const storedCursor = chunkCursorFor(backend.chunk_cursor);
      const cursorFileLanded =
        storedCursor !== null && successes.some((r) => r.id === storedCursor.migrationId);
      const cursorWrite =
        chunkCursor !== null
          ? { chunk_cursor: chunkCursor }
          : chunkCursorDiscarded || cursorFileLanded
            ? { chunk_cursor: null }
            : {};
      const { data: recorded, error: updErr } = await supabase
        .from("clone_backends")
        .update({
          // Where the prime is: established by this pass whatever it applied.
          source_repo: `${source.owner}/${source.repo}`,
          source_ref: source.branch,
          source_sha: sourceSha,
          // Released here, not in a finally: on the failure path the row is
          // deliberately left `failed`, and a `failed` row is outside this
          // worker's query anyway.
          worker_started_at: null,
          ...cursorWrite,
          // Facts about the CLONE — written only by a pass that changed one.
          //
          // A pass that changed nothing writes NONE of them here. What it has
          // to say is an opinion drawn from a snapshot rather than a fact it
          // established, so it goes in its own guarded write below.
          ...(didNothing
            ? {}
            : {
                ...(latestApplied ? { migration_version: latestApplied } : {}),
                migrations_applied: results,
                // `held` is deliberately absent from this expression: a body
                // this worker declined to carry never moves the clone.
                status: failures.length > 0 ? ("failed" as const) : ("ready" as const),
                // THE ONLY WRITER OF THIS FIELD.
                //
                // `status` is shared with the provisioning drain and says
                // nothing reliable about a schema; this pair is this lane's
                // own record of the one thing only it can establish — that a
                // prime migration was sent to this clone and refused. It is
                // set on a failure and CLEARED on any pass that succeeds, so
                // a repaired clone rejoins the fleet by being repaired rather
                // than by somebody remembering to clear a flag.
                ...(failures.length > 0
                  ? {
                      migration_blocked_at: new Date().toISOString(),
                      migration_blocked_reason: `${failures[0].name}: ${failures[0].error}`,
                    }
                  : { migration_blocked_at: null, migration_blocked_reason: null }),
                status_detail:
                  failures.length > 0
                    ? `Migration failed at ${failures[0].name}`
                    : limited.length > 0
                      ? // Named as a WAIT, and named as ours. An operator who
                        // reads "failed" goes looking for what the clone
                        // rejected; there is nothing to find, because the
                        // prime's own body was never read.
                        //
                        // It does not say "rate limit" any more: the refusal
                        // that produced this on npc-test-76b3b3 was a bare 403
                        // against a window with 4,300 calls left in it, and
                        // naming a cause the message cannot know sent the
                        // reader to wait out a window that was never closed.
                        //
                        // So the upstream's OWN words are quoted here instead.
                        // They cannot go in `error_message` or
                        // `migration_blocked_reason`: both mean "this clone
                        // refused something", and this clone was sent nothing.
                        // This reading is the only place they can land, which
                        // is why it carries them rather than describing them.
                        `Synced to ${syncedTo} — the prime's copy of ${limited[0].name} could ` +
                        `not be read, so nothing was sent for it; the clone is unchanged and still ` +
                        `in the fleet, and the next pass retries from that migration. Upstream said: ` +
                        `${(limited[0].error ?? "no detail").slice(0, 300)}`
                      : held.length > 0
                        ? // Named, and named as a HOLD. An operator who reads
                          // "failed" goes looking for what the clone rejected;
                          // there is nothing to find, because nothing was sent.
                          `Synced to ${syncedTo} — ${held[0].name} is too large for this pass to carry ` +
                          `and is left for the chunking lane; the clone is unchanged and still in the fleet`
                        : byRule.length > 0
                          ? // A HOLD again, and one no pass will clear on its
                            // own: the rule's own sentence names what was not
                            // sent and the change on the prime that ends it.
                            `Synced to ${syncedTo} — ${byRule[0].heldByRule?.detail ?? byRule[0].error ?? ""} ` +
                            `The clone is unchanged and still in the fleet.`
                          : blocked.length > 0
                            ? // `ready` and NOT level. Saying only "Synced to X" here
                              // would report a clone holding dozens of migrations back
                              // as healthy — the exact shape of report this module
                              // exists to stop. The first hole is named because it is
                              // the one to reconcile first.
                              `Synced to ${syncedTo} — ${blocked.length} migration(s) held back behind ` +
                              `${blocked[0].blockedBy?.[0] ?? "a withheld version"}, which the prime's ledger does not record`
                            : pausedMidReplay
                              ? // Said before the level reading, because it is the
                                // one case where "Synced to X" would be a claim
                                // about a clone the pass never finished examining.
                                //
                                // WHERE IT STOPPED DECIDES WHAT THE NEXT PASS DOES,
                                // and this promised a resume on every one of them.
                                //
                                // A pass stops in one of two places. INSIDE a seed,
                                // where a cursor is written and the next pass really
                                // does carry on from that statement; or BETWEEN
                                // migrations, where there is no position at all and
                                // the next pass starts the following migration from
                                // its beginning. `chunkCursor` is exactly that fact,
                                // computed above for the write.
                                //
                                // `chunksApplied` cannot stand in for it: it counts
                                // statements sent THIS pass, so a pass that sent the
                                // last three statements of a seed, recorded it, and
                                // then ran out of budget reported "(3 statement(s) of
                                // a large seed sent) … it resumes where it stopped".
                                // True about the statements, false about the resume,
                                // and read as the inverse of what happened — the
                                // seed had just finished. Measured on `npc-test` at
                                // 00:00 on 20 Sep 2026, cursor null.
                                `Synced to ${syncedTo} so far — this pass stopped at its time budget ` +
                                `with more to send` +
                                //
                                // AND THE QUESTION IS WHAT THE ROW WILL HOLD, not
                                // what this pass did. The third reading said "the
                                // next pass starts from the one after X" on
                                // `chunkCursor === null && chunksApplied === 0` —
                                // which is precisely the case where `cursorWrite`
                                // resolves to `{}` and a STORED cursor survives
                                // untouched. A pass that hit the deadline before
                                // reaching the seed therefore promised a fresh
                                // start while the next pass resumes mid-seed from
                                // the cursor already on the row. Found by review.
                                (chunkCursor !== null
                                  ? ` (${chunksApplied} statement(s) of a large seed sent); the next ` +
                                    `pass carries on from statement ${chunkCursor.statementsDone} of it`
                                  : chunkCursorDiscarded || cursorFileLanded
                                    ? `${chunksApplied > 0 ? ` (${chunksApplied} statement(s) sent, finishing a large seed)` : ""}; ` +
                                      `the next pass starts the migration after it`
                                    : storedCursor !== null
                                      ? `; this pass did not reach the large seed it is part-way through, so the ` +
                                        `next pass carries on from statement ${storedCursor.statementsDone} of it`
                                      : `; the next pass starts from the one after ${syncedTo}`)
                              : primeLedgerHoles.length > 0
                                ? // Level with the prime, and the prime is not
                                  // level with its own repository. Said on the
                                  // rung BELOW the pause because a pass that has
                                  // not finished looking should report that
                                  // first — but said, because until this existed
                                  // a hole with nothing queued behind it
                                  // produced no entry, no blockage row and no
                                  // sentence, and four such versions sat
                                  // unrecorded on the prime for days.
                                  `Synced to ${syncedTo} — ${primeLedgerHoleSentence(
                                    primeLedgerHoles.slice(0, PRIME_LEDGER_HOLE_NOTE_CAP),
                                    primeLedgerHoles.length,
                                  )}`
                                : `Synced to ${syncedTo}`,
                error_message: failures.length > 0 ? failures[0].error : null,
              }),
        })
        .eq("clone_id", cloneId)
        .eq("worker_started_at", claimedAt)
        .select("clone_id");
      if (updErr) {
        out.failed.push({ cloneId, cloneName, error: `result not recorded: ${updErr.message}` });
        continue;
      }
      /*
        THE VERDICT IS ABOUT A CLAIM THIS PASS NO LONGER HOLDS.

        Unfenced, this write is the dangerous one: it sets `worker_started_at`
        to null, so a reclaimed pass arriving here would RELEASE the successor's
        claim — and write a status, a version and a `migrations_applied` list
        for a replay the successor is still running. The fence turns that into
        no rows and nothing written.

        Reported and skipped rather than swallowed: no notification, because
        the `failed` status this would have set did not land either, and an
        alert saying a clone has fallen out of the fleet would be a claim about
        a row this pass did not write.
      */
      if (!recorded || recorded.length === 0) {
        out.failed.push({
          cloneId,
          cloneName,
          error:
            `${CLAIM_LOST}: this pass finished its replay after being reclaimed, so its ` +
            `result was not recorded and the clone's row belongs to the pass that now holds it`,
        });
        continue;
      }

      // Reported, and reported as what it is. No notification: nothing has
      // gone wrong with this clone, it is still in the fleet, and the run's
      // own result is where a held migration belongs. `cascade_failed` here
      // would be an alert about a healthy tenant.
      for (const h of held) {
        out.heldOversize.push({ cloneId, cloneName, migration: h.name });
      }

      // Same treatment, same reasoning: nothing went wrong with this clone, so
      // this is a line in the run's result rather than an alert.
      for (const l of limited) {
        out.rateLimited.push({ cloneId, cloneName, migration: l.name });
      }

      // And the third hold: a line in the run's result, never an alert.
      for (const r of byRule) {
        out.heldByRule.push({
          cloneId,
          cloneName,
          migration: r.name,
          rule: r.heldByRule?.rule ?? "unknown",
        });
      }

      if (failures.length > 0) {
        out.failed.push({ cloneId, cloneName, error: `${failures[0].name}: ${failures[0].error}` });
        // A clone that fails leaves the eligible set — `status` is no longer
        // `ready`, so the next run will not see it. That is the right
        // behaviour and the wrong silence: without this it drops out of the
        // fleet and nothing anywhere says so.
        await notifyOperators({
          kind: "cascade_failed",
          severity: "error",
          title: `${cloneName} has fallen out of migration sync`,
          body:
            `A prime migration failed on this clone (${failures[0].name}: ${failures[0].error}). ` +
            `Its backend is now \`failed\`, which takes it out of the fleet sync until an ` +
            `operator repairs it — no further prime migrations will reach this clone's database.`,
          cloneId,
          url: `/clones/${cloneId}`,
          metadata: { migration: failures[0].name, source_sha: sourceSha },
        });
      }
    } catch (e) {
      /*
        AND THE SAME STOP HERE, BEFORE THIS PATH'S OWN RELEASE.

        Added on the success path and missed on this one, which review caught
        in the same round it shipped. A throw anywhere above — setup, the
        replay, the result write — jumps straight here with the timer still
        running, so the release below was attempted with beats live and the
        `finally` did not stop them until it had resolved. If that release
        hangs and then FAILS, beats dispatched during the wait can land
        afterwards and refresh a claim nobody holds, which is exactly the
        extension the reordering exists to shrink — and this is the path where
        a failed release is most likely, because something has already gone
        wrong.

        Before `out.failed.push` would be wrong: a slow drain must not delay
        the run's own record of the failure. Before the release is the
        boundary that matters.
      */
      const error = e instanceof Error ? e.message : "Unknown error";
      out.failed.push({ cloneId, cloneName, error });
      await heartbeat.stop();
      // Release the claim so a transient fault does not park the clone for
      // STALE_CLAIM_MINUTES. The status is untouched: this threw before any
      // verdict about the clone's schema was reached, and guessing one is
      // worse than retrying.
      const { data: released, error: relErr } = await supabase
        .from("clone_backends")
        .update({ worker_started_at: null })
        .eq("clone_id", cloneId)
        .eq("worker_started_at", claimedAt)
        .select("clone_id");
      if (relErr) {
        // Not fatal — `reclaimStale` will free it on a later run — but silence
        // here would turn a clone that is merely stuck into one that looks
        // like it was never eligible.
        console.error("[fleet-migration] could not release claim", {
          cloneId,
          error: relErr.message,
        });
      } else if (!released || released.length === 0) {
        /*
          NOT AN ERROR, AND THE REASON THE FENCE IS SAFE HERE.

          Two ways to reach this and both are correct. The claim was reclaimed
          and a successor holds it — releasing would hand ITS clone to a third
          pass, which is precisely what the fence stops. Or the result write
          above already released it and something after that threw, in which
          case there is nothing left to release.

          Logged because a claim this pass believed it held and does not is
          worth seeing, and `console.error` is reserved for the branch above,
          where a release genuinely failed and the clone is stuck until
          `reclaimStale` reaches it.
        */
        console.warn("[fleet-migration] claim was not this pass's to release", {
          cloneId,
          claimedAt,
        });
      }
    } finally {
      // In a `finally` rather than after each exit, because there are three:
      // the result write's `continue`, a throw, and falling off the end. A
      // timer that outlives its pass would hold a dead claim open for ever.
      //
      // AWAITED, so the pass does not move to the next clone while a beat for
      // this one is still out. A late beat cannot be recalled; what this
      // bounds is how late it can be.
      await heartbeat.stop();
    }
  }

  await writeAuditLog({
    action: "fleet.migrations_synced",
    entityType: "fleet",
    actorUserId: opts?.actorUserId ?? null,
    metadata: {
      source_repo: `${source.owner}/${source.repo}`,
      source_sha: sourceSha,
      trigger: opts?.actorUserId ? "operator" : "schedule",
      mode,
      // How long the pass took against what it was allowed. The budget was
      // raised from 45 s on 26 Sep on a measurement of passes that each sent
      // one statement; this is the reading that says whether the change
      // bought what it was for, and whether a pass ever nears the hook's
      // patience.
      elapsed_ms: Date.now() - passStartedAt,
      budget_ms: budgetMs,
      stopped_at_budget: out.stoppedAtBudget,
      processed: out.processed,
      advanced: out.advanced,
      up_to_date: out.upToDate,
      failed: out.failed.length,
      held_oversize: out.heldOversize.map((h) => `${h.cloneName}: ${h.migration}`),
      rate_limited: out.rateLimited.map((l) => `${l.cloneName}: ${l.migration}`),
      held_by_rule: out.heldByRule.map((h) => `${h.cloneName}: ${h.migration} (${h.rule})`),
      ...(out.splitVersions
        ? {
            split_versions: out.splitVersions.map(
              (v) =>
                `${v.version}: cleared ${v.cleared.join(", ")}; withheld ${v.withheld.join(", ")}`,
            ),
          }
        : {}),
      excluded: out.excluded,
      // WHICH ones, and why. `excluded: 2` is the reading that hid two
      // tenants falling out of the fleet for a day.
      skipped: out.skipped.map((sk) => `${sk.cloneName}: ${sk.reason}`),
      withheld: out.withheld,
      withheld_never_applied: scoped.breakdown.neverApplied,
      withheld_skew_suspected: scoped.breakdown.skewSuspected,
      // The names, capped. A count tells an operator how big the problem is;
      // the names tell them which migration to go and look at, and that is the
      // half a dashboard number always loses.
      withheld_never_applied_sample: scoped.withheldEntries
        .filter((w) => w.reason === "never_applied")
        .slice(0, 20)
        .map((w) => w.meta.name),
      prime_backend_ref: scoped.primeRef,
      prime_applied: scoped.primeAppliedCount,
      // What the prime declared withdrawn, and whether the declaration could be
      // read. An unreadable manifest withdraws nothing, which turns every file
      // it lists back into a hole — the audit row is where that shows first.
      withdrawn_state: out.withdrawn?.state ?? null,
      withdrawn_files: out.withdrawn?.files ?? [],
      withdrawn_unmatched: out.withdrawn?.unmatched ?? [],
      withdrawn_recorded_on_prime: out.withdrawn?.recordedOnPrime ?? [],
      ...(out.withdrawn?.why ? { withdrawn_unreadable_why: out.withdrawn.why } : {}),
      // Which seeds the barrier could see into, and which it could not. An
      // unreadable manifest or a stale entry turns a seed back into a barrier
      // to everything behind it, and a smaller `advanced` is otherwise the
      // only sign.
      seed_skeletons_state: out.seedSkeletons?.state ?? null,
      seed_skeletons_used: out.seedSkeletons?.used ?? [],
      seed_skeletons_stale: out.seedSkeletons?.stale ?? [],
      seed_skeletons_unmatched: out.seedSkeletons?.unmatched ?? [],
      seed_skeletons_refused: out.seedSkeletons?.refused ?? [],
      ...(out.seedSkeletons?.why ? { seed_skeletons_unreadable_why: out.seedSkeletons.why } : {}),
    },
  });

  return out;
}

/**
 * The fleet migration lane's cron handler, for both of its cadences.
 *
 * ## Why two doors and one implementation
 *
 * `/hooks/fleet-migration-sync` is the half-hourly pass over the whole fleet.
 * `/hooks/fleet-migration-drain` is a five-minute tick that serves only the
 * clones with a seed in flight.
 *
 * They are separate ROUTES rather than one route reading a mode out of the
 * cron job's body, for two reasons and neither is style. `check-cron-coverage`
 * refuses two jobs pointing at one hook — correctly, because that is what a
 * rescheduled job under a new name looks like when nobody retired the old one,
 * and the gate cannot tell that apart from a deliberate second cadence. And a
 * mode carried in a body is invisible in `cron.job`: an operator reading the
 * schedule would see the same URL twice and no way to tell which is which.
 *
 * They are one HANDLER because everything either one does — the auth, the
 * allowance, the lane attribution, the shape of the answer — is the same
 * question asked at a different rate, and two copies of that is how one of
 * them comes to be missing a guard the other has.
 *
 * It lives in the LANE'S module rather than one of its own, and that is not
 * filing. `everyGithubLaneYields.contract.test.ts` decides which routes must
 * consult the GitHub budget by following ONE import hop from the route, so a
 * route whose work reaches GitHub two hops away is not detected as a lane at
 * all. Putting the handler in a module of its own would have hidden both of
 * these doors from that gate. Deepening the gate is a change to every lane
 * and is filed separately, with the measurement; keeping the handler here
 * costs nothing and leaves the gate exactly as strong as it was.
 *
 * ## What the drain mode changes, and what it cannot
 *
 * The mode NARROWS an already-eligible set (`scopeQueueToMode`, applied after
 * `migrationEligibility`), so a drain tick can reach no clone a sweep would
 * not. It grants no new authority; it stops a clone already being served from
 * waiting half an hour between statements.
 */
export async function handleFleetMigrationCron(
  request: Request,
  mode: FleetPassMode,
): Promise<Response> {
  const auth = verifyCronAuth(request);
  if (!auth.ok) return auth.response;

  // Attribute this invocation's App-installation calls. See githubUsageMeter.ts:
  // the count is taken at the one hook every call already passes through, and
  // named here. The two cadences are named apart, because "the fleet lane spent
  // the window" and "the drain spent the window" send an operator to different
  // places.
  beginGithubLane(mode === "drain" ? "fleet-migration-drain" : "fleet-migration-sync");

  try {
    /*
      THE CHEAP QUESTION FIRST, AND ONLY THE DRAIN ASKS IT.

      A drain tick exists to move a seed along, and on a level fleet there is
      none to move. Asking the fleet table before `readGitHubRemaining` keeps an
      idle tick down to one indexed select: the rate-limit endpoint costs no
      quota, but it is still a round trip to GitHub, 288 times a day, for
      nothing.

      It fails OPEN — an unreadable table answers yes and the pass runs, because
      the pass is the thing that reports a broken read, and a drain that
      silences itself on a failed read is a drain that stops for a reason
      nobody is told.
    */
    if (mode === "drain" && !(await fleetDrainHasWork(supabaseAdmin))) {
      return new Response(JSON.stringify({ success: true, mode, skipped: "no seed in flight" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // This lane reads the prime's whole migration corpus from GitHub and then a
    // body per unapplied migration per clone, on an installation it shares with
    // every other lane. It stood down for nothing until 19 Sep 2026: it
    // exhausted the window that night, and because a quota refusal mid-pass
    // looked like a migration the clone had rejected, three clones were ejected
    // from the fleet on the strength of it. Both halves of that are fixed —
    // this is the half that stops it spending the window down in the first
    // place.
    const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return new Response(JSON.stringify({ success: true, mode, skipped: spend.why }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await runFleetMigrationSync(supabaseAdmin, { mode });
    // 200 with the failures in the body rather than 500: one clone whose
    // migration failed is not a failed run, and a job that reports failure for
    // a state it handled correctly is one people stop reading.
    //
    // `result.error` is a different thing from a clone's failure and was being
    // flattened into the same `success: true`. It is set only where the PASS
    // could not run at all — the prime unconfigured, the backends unreadable,
    // the stale-claim sweep refused — and a run that touched no clone reporting
    // as a healthy one is the reading this whole lane exists to stop.
    return new Response(JSON.stringify({ success: !result.error, mode, ...result }), {
      status: result.error ? 500 : 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fleet migration sync failed";
    console.error(`Fleet migration ${mode} failed:`, msg);
    return new Response(JSON.stringify({ success: false, mode, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
