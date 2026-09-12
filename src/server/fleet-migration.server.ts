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
  migrationEligibility,
  type MigrationSkipReason,
} from "./fleetMigrationEligibility.pure";
import { notifyOperators, writeAuditLog } from "./audit.server";

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
 * A claim older than this is treated as abandoned.
 *
 * Long enough that a slow but living run is not stolen from — a clone hundreds
 * of migrations behind is legitimately slow — and short enough that a worker
 * killed mid-flight does not park a clone forever.
 */
const STALE_CLAIM_MINUTES = 30;

export type FleetMigrationResult = {
  /** Clones eligible and claimed this run. */
  processed: number;
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
  advanced: 0,
  upToDate: 0,
  failed: [],
  excluded: 0,
  rehabilitated: [],
  skipped: [],
  heldOversize: [],
  withheld: 0,
  withheldBreakdown: { neverApplied: 0, skewSuspected: 0 },
};

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
  const { error } = await supabase
    .from("clone_backends")
    .update({ worker_started_at: null })
    .in("status", [...MIGRATION_CLAIMABLE_STATUSES])
    .not("worker_started_at", "is", null)
    .lt("worker_started_at", cutoff);
  if (error) throw new Error(`Could not reclaim stale migration claims: ${error.message}`);
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
  opts?: { batchSize?: number; actorUserId?: string | null },
): Promise<FleetMigrationResult> {
  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);

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
      "clone_id, supabase_project_ref, migration_version, status, worker_started_at, migration_blocked_at, migration_blocked_reason",
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

    const ledger = await readCloneMigrationLedger(ref);
    // A read that FAILED says nothing, and an empty array is a claim. Keep the
    // block rather than discharging one on a query that did not answer.
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
    const { data: claimed, error: claimErr } = await supabase
      .from("clone_backends")
      .update({ worker_started_at: new Date().toISOString() })
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

    try {
      const { results, latestApplied } = await applyPrimeMigrations(
        backend.supabase_project_ref!,
        runnable,
        undefined,
        (m) => corpus.loadSql(m.id),
        // `runnable` alone cannot say whether a cleared version sits behind a
        // withheld one. The whole corpus can.
        { corpus: corpus.metas, runnableIds: new Set(runnable.map((m) => m.id)) },
        undefined,
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

          No cursor is passed. The self-healing lane persists one because it
          runs inside a hard invocation budget; this job is reclaimed after
          `STALE_CLAIM_MINUTES` and re-sends from the first statement, which is
          idempotent by the clause above. Slower, never wrong.
        */
        { streamSql: (m) => corpus.openSqlStream(m.id) },
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
      const failures = results.filter((r) => !r.success && !r.heldOversize);
      // Runnable, but sitting behind a version this clone has not got. Skipped
      // rather than run — see `partitionByDependency`.
      const blocked = results.filter((r) => r.blockedBy && r.blockedBy.length > 0);

      out.processed++;
      if (successes.length === 0 && failures.length === 0 && held.length === 0) {
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
      const didNothing =
        successes.length === 0 && failures.length === 0 && blocked.length === 0 && held.length === 0;
      const syncedTo = latestApplied ?? "the prime's latest recorded migration";
      const { error: updErr } = await supabase
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
                        : `Synced to ${syncedTo}`,
                error_message: failures.length > 0 ? failures[0].error : null,
              }),
        })
        .eq("clone_id", cloneId);
      if (updErr) {
        out.failed.push({ cloneId, cloneName, error: `result not recorded: ${updErr.message}` });
        continue;
      }

      // Reported, and reported as what it is. No notification: nothing has
      // gone wrong with this clone, it is still in the fleet, and the run's
      // own result is where a held migration belongs. `cascade_failed` here
      // would be an alert about a healthy tenant.
      for (const h of held) {
        out.heldOversize.push({ cloneId, cloneName, migration: h.name });
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
      const { error: relErr } = await supabase
        .from("clone_backends")
        .update({ worker_started_at: null })
        .eq("clone_id", cloneId);
      if (relErr) {
        // Not fatal — `reclaimStale` will free it on a later run — but silence
        // here would turn a clone that is merely stuck into one that looks
        // like it was never eligible.
        console.error("[fleet-migration] could not release claim", {
          cloneId,
          error: relErr.message,
        });
      }
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
