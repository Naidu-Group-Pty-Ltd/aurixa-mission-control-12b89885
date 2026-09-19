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
import {
  MIGRATION_CLAIMABLE_STATUSES,
  blockIsDischarged,
  blockIsUpstreamRefusal,
  migrationEligibility,
  type MigrationSkipReason,
} from "./fleetMigrationEligibility.pure";
import { notifyOperators, writeAuditLog } from "./audit.server";
import { chunkCursorFor } from "./chunkCursorStore.pure";
import { ClaimLostError } from "./provisioningBudget";

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
 * Forty-five seconds, the same as the self-healing lane, and for the same
 * reason: pg_net gives up on the hook at sixty, and a pass has to survive long
 * enough to WRITE what it did. A budget that is spent is not a failure here —
 * the chunk cursor makes the next pass carry on from the statement after the
 * last one sent.
 */
const FLEET_PASS_BUDGET_MS = 45_000;

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
   * Clones whose `migration_blocked` flag this run cleared, because their own
   * ledger now records the version the block names.
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
  withheldBreakdown: { neverApplied: number; skewSuspected: number };
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
  withheld: 0,
  withheldBreakdown: { neverApplied: 0, skewSuspected: 0 },
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
 * It is cheap at this cadence. A pass with a 45-second budget beats once or
 * twice; one blocked inside `runSqlOnProject` beats until the runtime reclaims
 * the isolate, which is exactly when it should stop.
 */
const CLAIM_HEARTBEAT_MS = 30_000;

/**
 * Say, on a clock, that this pass still holds the claim it took.
 *
 * Separate from the cursor write in `onStatementDone`: that one belongs to the
 * oversized-seed path and carries progress, and a heartbeat that only exists
 * where there is progress to report is absent on every other path — an
 * ordinary DDL, and above all a request blocked inside the timeout-less
 * `runSqlOnProject`. Those are the stretches the window has to cover.
 *
 * Returns its own stop, and takes no callback: nothing here can interrupt a
 * pass blocked in a fetch, so this does not pretend to. What it does is make
 * a living pass VISIBLE, and stop beating the moment the row says the claim
 * is somebody else's.
 */
function beatWhileClaimHeld(
  supabase: Db,
  cloneId: string,
  claimedAt: string,
): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      const { data: beat, error } = await supabase
        .from("clone_backends")
        .update({ migration_heartbeat_at: new Date().toISOString() })
        .eq("clone_id", cloneId)
        .eq("worker_started_at", claimedAt)
        .select("clone_id");
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
      if (!beat || beat.length === 0) {
        // The claim is gone. Beating on would write into a successor's row and
        // tell the reclaim that a pass which no longer owns anything is alive.
        console.warn("[fleet-migration] heartbeat stopped: the claim is no longer this pass's", {
          cloneId,
          claimedAt,
        });
        clearInterval(timer);
      }
    })().catch((e) => {
      // A rejected beat must not become an unhandled rejection: in this
      // runtime that can take down the whole invocation, which would lose the
      // replay this exists to protect.
      console.error("[fleet-migration] heartbeat threw", {
        cloneId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }, CLAIM_HEARTBEAT_MS);

  return { stop: () => clearInterval(timer) };
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
async function reclaimStale(supabase: Db): Promise<void> {
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
    throw new Error(`Could not reclaim quiet migration claims: ${quietErr.message}`);
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
    throw new Error(`Could not reclaim unbeaten migration claims: ${unbeatenErr.message}`);
  }
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
      runnable: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["runnable"];
      withheld: number;
      breakdown: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["breakdown"];
      sourceSha: string;
      primeAppliedCount: number;
      withheldEntries: ReturnType<typeof scopeCorpusToPrime<CorpusMetaOf>>["withheld"];
      primeRef: string;
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
  let primeRef: string;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
    const rows = (await runSqlOnProject(
      primeRef,
      `select version from supabase_migrations.schema_migrations`,
    )) as Array<{ version?: unknown }>;
    primeApplied = new Set(
      (Array.isArray(rows) ? rows : [])
        .map((r) => r?.version)
        .filter((v): v is string => typeof v === "string"),
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

  const { runnable, withheld, breakdown } = scopeCorpusToPrime(corpus.metas, primeApplied);
  return {
    ok: true,
    corpus,
    runnable,
    withheld: withheld.length,
    withheldEntries: withheld,
    breakdown,
    sourceSha: corpus.sourceSha,
    primeAppliedCount: primeApplied.size,
    primeRef,
  };
}

type CorpusMetaOf = Awaited<ReturnType<typeof openPrimeMigrationCorpus>>["metas"][number];

/**
 * Apply the prime's migrations to a bounded slice of the fleet.
 *
 * `actorUserId` is the operator when a person pressed the button and null when
 * the scheduler ran it, so the audit row says which.
 */
export async function runFleetMigrationSync(
  supabase: Db,
  opts?: { batchSize?: number; actorUserId?: string | null; budgetMs?: number },
): Promise<FleetMigrationResult> {
  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);
  // Taken before the first read, so everything this pass spends is inside it.
  const deadlineAt = Date.now() + Math.max(5_000, opts?.budgetMs ?? FLEET_PASS_BUDGET_MS);

  const source = await resolvePrimeSource(supabase);
  if (!source) {
    return { ...EMPTY, error: "Prime not configured — set the prime repo in Settings first" };
  }

  await reclaimStale(supabase);

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
  const { data: allBackends, error: excludedErr } = await supabase
    .from("clone_backends")
    .select(
      "clone_id, supabase_project_ref, migration_version, status, worker_started_at, migration_blocked_at, migration_blocked_reason, chunk_cursor",
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
      if (
        !blockIsDischarged(
          v.row.migration_blocked_reason,
          ledger.rows.map((r) => r.version),
        )
      ) {
        continue;
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
          : "its ledger now records the version the block named"),
    );

    v.row.migration_blocked_at = null;
    v.row.migration_blocked_reason = null;
    v.verdict = { eligible: true };
    rehabilitated.push(v.row.clone_id);
  }

  const skipped = verdicts.filter((v) => !v.verdict.eligible);
  const excludedCount = skipped.length;

  const backends = verdicts
    .filter((v) => v.verdict.eligible)
    .map((v) => v.row)
    // Nulls first: a backend that has never recorded a version is furthest
    // behind by definition.
    .sort((a, b) => {
      const av = a.migration_version ?? "";
      const bv = b.migration_version ?? "";
      if (av === bv) return 0;
      if (av === "") return -1;
      if (bv === "") return 1;
      return av < bv ? -1 : 1;
    })
    .slice(0, batchSize);

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
  const scoped = await openScopedPrimeCorpus(supabase, source);
  if (!scoped.ok) return { ...out, error: scoped.error };
  const { corpus, runnable, sourceSha } = scoped;
  out.withheld = scoped.withheld;
  out.withheldBreakdown = scoped.breakdown;

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
      const { results, latestApplied, stoppedEarly, chunksApplied, chunkCursor } =
        await applyPrimeMigrations(
          backend.supabase_project_ref!,
          runnable,
          undefined,
          (m) => corpus.loadSql(m.id),
          // `runnable` alone cannot say whether a cleared version sits behind a
          // withheld one. The whole corpus can.
          { corpus: corpus.metas, runnableIds: new Set(runnable.map((m) => m.id)) },
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
            streamSql: (m) => corpus.openSqlStream(m.id),
            /*
            THE CURSOR IS THE DIFFERENCE BETWEEN SLOW AND NEVER.

            Read from the clone's own row and written on EVERY statement, not
            at the end of the pass. A pass that is killed is the ordinary case
            for a 40 MB seed in this runtime, so a cursor only a surviving pass
            could write would be worth exactly as much as no cursor — which is
            what this lane had, and why the seed could not land however many
            times it was tried.

            The stamp is checked against the migration it names before it is
            believed: a cursor into a DIFFERENT file would make this pass skip
            statements of the seed it is actually sending.
          */
            cursor: chunkCursorFor(backend.chunk_cursor),
            onStatementDone: async (p) => {
              const { data: beat, error } = await supabase
                .from("clone_backends")
                .update({
                  chunk_cursor: { migrationId: p.migrationId, statementsDone: p.statementsDone },
                  status_detail: `Sending ${p.name} — ${p.statementsDone} statement(s) in (${p.label})`,
                  // The beat. This is what makes the claim above reclaimable in
                  // minutes rather than in a cadence: a pass that is still
                  // sending says so here, and nothing else writes this column.
                  migration_heartbeat_at: new Date().toISOString(),
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
      const failures = results.filter(
        (r) => !r.success && !r.heldOversize && !r.heldUpstreamLimited,
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
        // A pass that sent part of a chunked seed and finished no migration
        // still moved this clone forward. Counting it as "nothing happened"
        // would leave the previous pass's sentence standing over real progress.
        chunksApplied === 0;
      const syncedTo = latestApplied ?? "the prime's latest recorded migration";
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
        THE CURSOR OUTLIVES A PASS, BUT NOT ITS FILE.

        Three states, and the middle one is why this cannot be a plain write of
        whatever `applyPrimeMigrations` returned.

        A pass that stopped INSIDE the seed returns a cursor: store it.
        A pass that FINISHED the seed returns null and the migration is among
        `successes`: clear it, because a cursor into a completed file would make
        the next oversized seed skip statements that never landed on this clone.
        A pass that never REACHED the seed — the budget stopped it earlier —
        also returns null, and here the stored cursor is still exactly true.
        Writing null for that third case would throw away a resume point and
        put the livelock back for one pass in every chain.
      */
      const storedCursor = chunkCursorFor(backend.chunk_cursor);
      const cursorFileLanded =
        storedCursor !== null && successes.some((r) => r.id === storedCursor.migrationId);
      const cursorWrite =
        chunkCursor !== null
          ? { chunk_cursor: chunkCursor }
          : cursorFileLanded
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
                              `Synced to ${syncedTo} so far — this pass stopped at its time budget ` +
                              `with more to send${chunksApplied > 0 ? ` (${chunksApplied} statement(s) of a large seed sent)` : ""}; ` +
                              `it resumes where it stopped on the next pass`
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
      const error = e instanceof Error ? e.message : "Unknown error";
      out.failed.push({ cloneId, cloneName, error });
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
      heartbeat.stop();
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
      processed: out.processed,
      advanced: out.advanced,
      up_to_date: out.upToDate,
      failed: out.failed.length,
      held_oversize: out.heldOversize.map((h) => `${h.cloneName}: ${h.migration}`),
      rate_limited: out.rateLimited.map((l) => `${l.cloneName}: ${l.migration}`),
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
    },
  });

  return out;
}
