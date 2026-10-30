/**
 * Give a clone the prime's owner-approved privilege and policy files whose
 * effect it lacks, and report every other declared effect it lacks.
 *
 * Two callers, one engine. Provisioning runs it as a stage once a new clone's
 * schema is verified and its ledger stamped (`runEffectReplayStage`, supplied
 * to the pipeline by the runner, like the Mission Control link, because it
 * resolves the clone and records the outcome in Mission Control's own tables).
 * `/hooks/clone-effect-replay` runs it against clones that already exist
 * (`reconcileCloneEffectReplays`). What each file goes through, and why, is
 * `migrationEffectReplay.pure.ts`; how a probe is read and run is
 * `migrationEffectProbe.pure.ts`.
 *
 * ## What it may touch
 *
 * A clone's database, and nothing else. The project ref comes from
 * `resolveCloneSecretTarget`, the one resolver that refuses the prime's
 * project and Mission Control's own and refuses when it cannot tell; the
 * provisioning stage also refuses a ref that is not the project the pipeline
 * is building. Every statement goes through `runSqlOnProject`, the
 * Management API route the fleet lane applies migrations by. The probes run
 * read-only and roll back; a dry run rolls back; only a file the owner
 * approved, whose dry run showed its probe returning a row, is run for real,
 * and nothing here writes the migration ledger.
 *
 * ## What it reads from the prime
 *
 * The manifest and the approved files at the commit the caller's pass read
 * (the provisioning snapshot's), and, for the report, every migration body
 * under the fleet lane's 256 KB read ceiling, through the same per-commit
 * reader the fleet sync uses (`digestPrimeBodies`). The 28 template-library
 * seeds past that ceiling (30 Oct 2026; 37 to 43 MB each) are not read for a
 * report, and are counted as not read: 12 of them declare a probe on their
 * first line, and streaming each one's head is a 40 MB request apiece, the
 * shape that trips GitHub's secondary limit on the installation the fleet
 * lane delivers seeds through.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit, type RepoRef } from "./github-app.server";
import {
  fetchEffectReplayManifest,
  openPrimeMigrationCorpus,
  resolvePrimeSource,
} from "./prime-backend.server";
import { runSqlOnProject } from "./backend-provisioning.server";
import {
  CloneSecretTargetError,
  resolveCloneSecretTarget,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import { rotate } from "./clonePrivilegeRepair.server";
import { pastDeadline } from "./provisioningBudget";
import { MAX_DIGEST_BYTES, digestPrimeBodies } from "./primeBodyDigests.server";
import { DRY_RUN_LOCK_TIMEOUT, DRY_RUN_MAX_BYTES } from "./primeMigrationDiagnosis.server";
import { DRY_RUN_INCONCLUSIVE_STATES } from "./primeMigrationDiagnosis.pure";
import {
  PROBES_PER_STATEMENT,
  probeBatchStatement,
  probeIsReadOnly,
  readProbeBatch,
  type ProbeAnswer,
} from "./migrationEffectProbe.pure";
import {
  EFFECT_NOTICE_AUDIT_ACTION,
  EFFECT_REPLAY_AUDIT_ACTION,
  admitBody,
  admitEntry,
  applyStatement,
  buildEffectReport,
  decideEffectNotice,
  describeEffectNotice,
  describeReplays,
  describeReport,
  dryRunStatement,
  effectExposures,
  exposureKey,
  exposuresTold,
  failureWords,
  normaliseInstant,
  notReplayed,
  outcomeAfterApply,
  outcomeOfProbe,
  readApplyFailure,
  readDryRun,
  replaySettled,
  reportComplete,
  settledEarlier,
  type BodiesNotRead,
  type EffectExposure,
  type EffectReplayEntry,
  type EffectReplayReading,
  type EffectReport,
  type ReplayKind,
  type ReplayOutcome,
  type ReportProbe,
} from "./migrationEffectReplay.pure";

type Db = SupabaseClient<Database>;

/**
 * How much of a pass the report must have left to be started: the bodies of
 * the whole corpus (1,127 under the read ceiling on 30 Oct 2026, so fifteen
 * GraphQL batches cold and nothing warm) and one probe request. Not measured
 * on a live pass; it borrows parity's allowance (`provisioningFinish.pure.ts`)
 * and errs long, because a report started without the room to finish is
 * asked for again on the next pass anyway.
 */
export const EFFECT_REPORT_NEEDS_MS = 20_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One approved file, ready to be probed, or the outcome that stopped it. */
type Candidate =
  | {
      ok: true;
      entry: EffectReplayEntry;
      version: string;
      body: string;
      probe: string;
    }
  | { ok: false; outcome: ReplayOutcome };

type ReportInput =
  | {
      read: true;
      probes: ReportProbe[];
      refused: string[];
      bodiesNotRead: BodiesNotRead;
    }
  | { read: false; why: string; transient: boolean };

/** What the prime holds for this stage at one commit, read once and shared by every clone a pass reaches. */
type PrimeEffects = {
  commit: string;
  manifest: EffectReplayReading;
  candidates: Candidate[];
  report: ReportInput;
};

/** The prime's head moved between two reads that must agree. Never acted on; the next pass reads again. */
class PrimeHeadMoved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimeHeadMoved";
  }
}

/**
 * Read the manifest, the files it approves and (when asked) every declared
 * probe, at one commit.
 *
 * Throws when the corpus cannot be listed or the commit is not the one the
 * caller's pass read; every other failure is a reading carried on the result.
 */
async function readPrimeEffects(
  octokit: Octokit,
  source: RepoRef,
  opts: {
    expectedSha: string | null;
    /** Set when the caller has no room for the report: it is recorded as not taken, and why. */
    reportNotTakenBecause?: string | null;
  },
): Promise<PrimeEffects> {
  const corpus = await openPrimeMigrationCorpus(octokit, source);
  const { commitSha, reading } = await fetchEffectReplayManifest(octokit, source);
  if (commitSha !== corpus.sourceSha) {
    throw new PrimeHeadMoved(
      `the prime's head moved between two reads (${corpus.sourceSha.slice(0, 7)}, then ${commitSha.slice(0, 7)})`,
    );
  }
  if (opts.expectedSha && corpus.sourceSha !== opts.expectedSha) {
    throw new PrimeHeadMoved(
      `the prime's head is ${corpus.sourceSha.slice(0, 7)}, not the ${opts.expectedSha.slice(0, 7)} this pass was built from`,
    );
  }

  const candidates: Candidate[] = reading.refused.map((r) => ({
    ok: false,
    outcome: {
      file: r.file ?? `replays[${r.index}]`,
      version: r.file ? r.file.slice(0, 14) : null,
      kind: null,
      status: "refused",
      why: r.why,
    },
  }));
  if (reading.state === "read") {
    const facts = {
      versionOf: new Map(corpus.files.map((f) => [f.name, f.id])),
      withdrawn: new Set(corpus.withdrawal.excluded.map((m) => m.name)),
      withdrawalState: corpus.withdrawal.state,
      commit: corpus.sourceSha,
    };
    const admitted = await Promise.all(
      reading.entries.map(async (entry): Promise<Candidate> => {
        const gate = admitEntry(entry, facts);
        if (!gate.ok) return { ok: false, outcome: gate.outcome };
        let body: string;
        try {
          // By FILE name: a version two files share names neither of them.
          body = await corpus.loadSql({ id: gate.version, name: entry.file });
        } catch (e) {
          return {
            ok: false,
            outcome: {
              file: entry.file,
              version: gate.version,
              kind: entry.kind,
              status: "probe_unreadable",
              why: `its body could not be read from the prime (${msg(e).slice(0, 200)})`,
              transient: true,
            },
          };
        }
        const admittedBody = admitBody(entry, gate.version, body, { maxBytes: DRY_RUN_MAX_BYTES });
        if (!admittedBody.ok) return { ok: false, outcome: admittedBody.outcome };
        return { ok: true, entry, version: gate.version, body, probe: admittedBody.probe };
      }),
    );
    candidates.push(...admitted);
  }

  let report: ReportInput;
  if (opts.reportNotTakenBecause) {
    report = { read: false, why: opts.reportNotTakenBecause, transient: true };
  } else {
    const pass = await digestPrimeBodies(
      corpus,
      corpus.files.map((f) => f.path),
      octokit,
      source,
    );
    const probes: ReportProbe[] = [];
    const refused: string[] = [];
    let pastCeiling = 0;
    let beyondFileLimit = 0;
    let failed = 0;
    for (const f of corpus.files) {
      if (!pass.probesByPath.has(f.path)) {
        // A body nobody read declares nothing anybody knows of. One the pass
        // never asked for (past `MAX_DIGEST_FILES`), or past the ceiling or of
        // unknown size, is never read; one under it should have been, and a
        // pass that did not is one to take again.
        if (!pass.byPath.has(f.path)) beyondFileLimit += 1;
        else if (f.size === null || f.size > MAX_DIGEST_BYTES) pastCeiling += 1;
        else failed += 1;
        continue;
      }
      const probe = pass.probesByPath.get(f.path) ?? null;
      if (!probe) continue;
      if (probeIsReadOnly(probe)) probes.push({ file: f.name, probe });
      else refused.push(f.name);
    }
    report = {
      read: true,
      probes,
      refused,
      bodiesNotRead: { pastCeiling, beyondFileLimit, failed, ceilingBytes: MAX_DIGEST_BYTES },
    };
  }
  return { commit: corpus.sourceSha, manifest: reading, candidates, report };
}

/**
 * Evaluate probes on a clone, read-only, a statement at a time.
 *
 * The statement always raises; its answers are read from what was thrown. A
 * statement that returned instead carried no answers, and says so.
 */
async function askProbes(projectRef: string, probes: readonly string[]): Promise<ProbeAnswer[]> {
  const out: ProbeAnswer[] = [];
  for (let i = 0; i < probes.length; i += PROBES_PER_STATEMENT) {
    const slice = probes.slice(i, i + PROBES_PER_STATEMENT);
    try {
      await runSqlOnProject(
        projectRef,
        probeBatchStatement(slice, { lockTimeout: DRY_RUN_LOCK_TIMEOUT }),
      );
      out.push(
        ...slice.map(
          (): ProbeAnswer => ({
            kind: "unread",
            why: "the probe statement returned without its answers",
          }),
        ),
      );
    } catch (e) {
      out.push(...readProbeBatch(msg(e), slice.length));
    }
  }
  return out;
}

/** A failure that says nothing about the file: no code at all, or a limit this run set. */
const inconclusive = (sqlstate: string | null) =>
  sqlstate === null || DRY_RUN_INCONCLUSIVE_STATES.has(sqlstate);

export type CloneEffectRun = {
  cloneId: string;
  cloneName: string;
  projectRef: string;
  commit: string;
  dryRun: boolean;
  manifest: {
    state: EffectReplayReading["state"];
    why?: string;
    approved: number;
    refused: number;
  };
  outcomes: ReplayOutcome[];
  /** The budget ran out before every approved file was decided. */
  stopped: boolean;
  report: EffectReport;
  /** Every file decided, and the report taken whole. See `replaySettled`. */
  settled: boolean;
};

/**
 * Probe, dry-run, replay and re-probe the approved files on one clone, then
 * evaluate every other declared probe for the report.
 *
 * `dryRun` stops at the dry run: a file whose dry run shows the probe
 * returning a row is `would_replay`, and nothing is committed.
 */
async function replayEffectsOnClone(
  target: CloneSecretTarget,
  prime: PrimeEffects,
  opts: { deadlineAt: number | null; dryRun: boolean },
): Promise<CloneEffectRun> {
  const outcomes: ReplayOutcome[] = [];
  const ready: Array<Extract<Candidate, { ok: true }>> = [];
  for (const c of prime.candidates) {
    if (c.ok) ready.push(c);
    else outcomes.push(c.outcome);
  }

  let stopped = false;
  // Set when a dry run answered in a way it never can (see below): nothing
  // more is sent to this clone in this run, and the next one asks again.
  let halted = false;
  const applied: Array<{
    base: { file: string; version: string; kind: ReplayKind };
    probe: string;
  }> = [];
  if (ready.length > 0) {
    const first = await askProbes(
      target.projectRef,
      ready.map((c) => c.probe),
    );
    for (const [i, c] of ready.entries()) {
      const base = { file: c.entry.file, version: c.version, kind: c.entry.kind };
      if (stopped || halted) {
        outcomes.push({
          ...base,
          status: "not_reached",
          ...(halted
            ? { why: "not sent: an earlier dry run on this clone did not answer as it must" }
            : {}),
        });
        continue;
      }
      const decided = outcomeOfProbe(base, first[i]);
      if (decided !== "dry_run") {
        outcomes.push(decided);
        continue;
      }
      // Between files, never between a file's dry run and its apply: the two
      // are one unit, and a pass that stopped between them would only have
      // spent the dry run.
      if (pastDeadline(opts.deadlineAt)) {
        stopped = true;
        outcomes.push({ ...base, status: "not_reached" });
        continue;
      }

      let dry: ReturnType<typeof readDryRun> | null;
      try {
        await runSqlOnProject(
          target.projectRef,
          dryRunStatement(c.body, c.probe, { lockTimeout: DRY_RUN_LOCK_TIMEOUT }),
        );
        dry = null;
      } catch (e) {
        dry = readDryRun(msg(e));
      }
      if (dry === null) {
        // The statement ends in a RAISE on every path, so a reply with no
        // error is one this code cannot explain. Nothing more is sent.
        outcomes.push({
          ...base,
          status: "dry_run_failed",
          why: "the dry run returned without raising its answer, so whether it rolled back is not known; nothing more is run on this clone",
          transient: true,
        });
        halted = true;
        continue;
      }
      if (!dry.ran) {
        outcomes.push({
          ...base,
          status: "dry_run_failed",
          sqlstate: dry.sqlstate,
          why: failureWords(dry.sqlstate, dry.message),
          ...(inconclusive(dry.sqlstate) ? { transient: true } : {}),
        });
        continue;
      }
      if (!dry.effect) {
        outcomes.push({
          ...base,
          status: "dry_run_failed",
          why: "the file ran in the dry run and its probe still returned no row, so it is not run for real",
        });
        continue;
      }
      if (opts.dryRun) {
        outcomes.push({ ...base, status: "would_replay" });
        continue;
      }

      try {
        await runSqlOnProject(
          target.projectRef,
          applyStatement(c.body, c.probe, { lockTimeout: DRY_RUN_LOCK_TIMEOUT }),
        );
        applied.push({ base, probe: c.probe });
      } catch (e) {
        const failure = readApplyFailure(msg(e));
        outcomes.push({
          ...base,
          status: "apply_failed",
          sqlstate: failure.sqlstate,
          why: failure.refusedByProbe
            ? "the file ran and its probe returned no row inside the same transaction, so nothing committed"
            : failureWords(failure.sqlstate, failure.message),
          ...(!failure.refusedByProbe && inconclusive(failure.sqlstate) ? { transient: true } : {}),
        });
      }
    }
  }

  // A separate read, after every commit: the outcome is what the clone says now.
  if (applied.length > 0) {
    const after = await askProbes(
      target.projectRef,
      applied.map((a) => a.probe),
    );
    applied.forEach((a, i) => outcomes.push(outcomeAfterApply(a.base, after[i])));
  }

  let report: EffectReport;
  if (!prime.report.read) {
    report = { taken: false, why: prime.report.why, transient: prime.report.transient };
  } else if (stopped) {
    // Past the deadline already; the pass that resumes the replay takes it.
    report = { taken: false, why: "the pass's budget ran out first", transient: true };
  } else {
    const answers =
      prime.report.probes.length > 0
        ? await askProbes(
            target.projectRef,
            prime.report.probes.map((p) => p.probe),
          )
        : [];
    report = buildEffectReport({
      commit: prime.commit,
      probes: prime.report.probes,
      answers,
      refused: prime.report.refused,
      bodiesNotRead: prime.report.bodiesNotRead,
    });
  }

  // File order, whatever order the verdicts were reached in.
  outcomes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const settled =
    replaySettled({ manifest: prime.manifest, outcomes, stopped }) && reportComplete(report);
  return {
    cloneId: target.cloneId,
    cloneName: target.cloneName,
    projectRef: target.projectRef,
    commit: prime.commit,
    dryRun: opts.dryRun,
    manifest: {
      state: prime.manifest.state,
      ...("why" in prime.manifest ? { why: prime.manifest.why } : {}),
      approved: prime.manifest.entries.length,
      refused: prime.manifest.refused.length,
    },
    outcomes,
    stopped,
    report,
    settled,
  };
}

/** The status line for one clone's run. */
function describeEffectRun(run: CloneEffectRun): string {
  return `Migration effects: ${describeReplays({
    commit: run.commit,
    manifest: run.manifest,
    outcomes: run.outcomes,
  })}; ${describeReport(run.report)}.`;
}

/** What a run records about itself, in its audit row. Names and counts; never a body. */
function auditMetadataOf(
  run: CloneEffectRun,
  extra: { source: "provisioning" | "hook"; stampedAt: string | null },
): Record<string, unknown> {
  return {
    source: extra.source,
    project_ref: run.projectRef,
    stamped_at: normaliseInstant(extra.stampedAt),
    prime_sha: run.commit,
    dry_run: run.dryRun,
    settled: run.settled,
    stopped: run.stopped,
    manifest: run.manifest,
    outcomes: run.outcomes,
    report: run.report,
  };
}

/**
 * What became of telling a person about a run's exposures.
 *
 * `not_delivered` is a notice owed and not written: the stage leaves its stamp
 * owed for it, and the hook raises it on its next run, because nothing was
 * recorded as told.
 */
export type EffectNoticeState =
  | { state: "none" }
  | { state: "told_before" }
  | { state: "delivered"; severity: "error" | "warning"; exposures: number; fresh: number }
  | { state: "not_delivered"; severity: "error" | "warning"; exposures: number };

/**
 * Tell the operators what a run left without its effect, once per exposure
 * for this project and stamp (`decideEffectNotice`).
 *
 * The record is the audit log, as the privilege sweep keeps its own: a row
 * under `EFFECT_NOTICE_AUDIT_ACTION` for each notice that landed, written
 * after it landed. A row lost after a notice landed says it again next run,
 * which is noise and the safe direction. Never throws: telling is beside the
 * work, and failing the work over it would be the wrong way round.
 */
async function announceEffectExposures(
  supabase: Db,
  input: {
    cloneId: string;
    cloneName: string | null;
    projectRef: string;
    stampedAt: string | null;
    commit: string | null;
    exposures: readonly EffectExposure[];
    /** The build's next pass resumes what this one did not reach. */
    resumes?: boolean;
  },
): Promise<EffectNoticeState> {
  if (input.exposures.length === 0) return { state: "none" };
  let told: Set<string> | null = null;
  try {
    const { data, error } = await supabase
      .from("audit_log")
      .select("metadata")
      .eq("entity_type", "clone")
      .eq("entity_id", input.cloneId)
      .eq("action", EFFECT_NOTICE_AUDIT_ACTION)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error) {
      told = exposuresTold(data ?? [], {
        projectRef: input.projectRef,
        stampedAt: input.stampedAt,
      });
    }
  } catch {
    told = null;
  }
  const decision = decideEffectNotice({ exposures: input.exposures, told });
  if (!decision.notify) {
    return decision.reason === "told_before" ? { state: "told_before" } : { state: "none" };
  }

  const notice = describeEffectNotice({
    cloneName: input.cloneName,
    projectRef: input.projectRef,
    stampedAt: input.stampedAt,
    commit: input.commit,
    exposures: decision.exposures,
    fresh: decision.fresh,
    resumes: input.resumes ?? false,
  });
  const record = {
    project_ref: input.projectRef,
    stamped_at: normaliseInstant(input.stampedAt),
    prime_sha: input.commit,
    severity: decision.severity,
    exposures: decision.exposures.map(exposureKey),
    fresh: decision.fresh.map(exposureKey),
  };
  let landed = false;
  try {
    landed = await notifyOperators({
      // The privilege sweep's kind: something a person must do on a clone,
      // and one the inbox keeps (`notificationDisposition.ts`).
      kind: "drift_medium",
      severity: decision.severity,
      title: notice.title,
      body: notice.body,
      cloneId: input.cloneId,
      url: `/clones/${input.cloneId}`,
      metadata: { source: EFFECT_NOTICE_AUDIT_ACTION, ...record },
    });
  } catch {
    landed = false;
  }
  if (!landed) {
    return {
      state: "not_delivered",
      severity: decision.severity,
      exposures: decision.exposures.length,
    };
  }
  await writeAuditLog({
    action: EFFECT_NOTICE_AUDIT_ACTION,
    entityType: "clone",
    entityId: input.cloneId,
    metadata: record,
  });
  return {
    state: "delivered",
    severity: decision.severity,
    exposures: decision.exposures.length,
    fresh: decision.fresh.length,
  };
}

export type EffectStageResult = {
  /** False when an earlier pass settled this project's stamp; nothing was asked of anyone. */
  ran: boolean;
  /** The status line, empty when nothing ran. */
  line: string;
  /** The budget stopped the replay with files undecided: the pipeline pauses and the next pass resumes it. */
  stoppedAtDeadline: boolean;
  settled: boolean;
  run?: CloneEffectRun;
  /** Whether the operators were told what the run left without its effect. */
  notice?: EffectNoticeState;
};

/**
 * The provisioning stage: once a new clone's schema is verified and its
 * ledger stamped, give it the approved files and report the rest.
 *
 * Owed once per stamp of a project (`settledEarlier`). Read from this
 * stage's own audit rows, the record it writes every time it runs, so an
 * unreadable record is a run that is owed rather than one that settled: the
 * replay asks the clone before it sends anything, so asking again costs a
 * probe and never a second replay. Never throws for anything a person must
 * act on: every refusal is a line and a row, and the pipeline goes on.
 */
export async function runEffectReplayStage(
  supabase: Db,
  input: {
    cloneId: string;
    /** The project the pipeline is building; the resolver must name the same one. */
    projectRef: string;
    /** When this project's ledger was stamped, as the pass knows it. */
    stampedAt: string | null;
    /** The commit this pass's snapshot was read at. */
    expectedSha: string | null;
    deadlineAt: number | null;
    source?: RepoRef | null;
    octokit?: Octokit;
  },
): Promise<EffectStageResult> {
  const { data: records, error: recordsError } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("entity_type", "clone")
    .eq("entity_id", input.cloneId)
    .eq("action", EFFECT_REPLAY_AUDIT_ACTION)
    .order("created_at", { ascending: false })
    .limit(20);
  if (
    !recordsError &&
    settledEarlier(records ?? [], { projectRef: input.projectRef, stampedAt: input.stampedAt })
  ) {
    return { ran: false, line: "", stoppedAtDeadline: false, settled: true };
  }
  // Owed, and the pass already out of time: the pipeline pauses here and the
  // next pass starts the stage, before anything is read or sent.
  if (pastDeadline(input.deadlineAt)) {
    return { ran: false, line: "", stoppedAtDeadline: true, settled: false };
  }

  const refusal = async (
    why: string,
    cloneName: string | null = null,
  ): Promise<EffectStageResult> => {
    // Nothing listed was reached, so the clone may lack every approved fix.
    const notice = await announceEffectExposures(supabase, {
      cloneId: input.cloneId,
      cloneName,
      projectRef: input.projectRef,
      stampedAt: input.stampedAt,
      commit: input.expectedSha,
      exposures: [notReplayed(why)],
    });
    await writeAuditLog({
      action: EFFECT_REPLAY_AUDIT_ACTION,
      entityType: "clone",
      entityId: input.cloneId,
      metadata: {
        source: "provisioning",
        project_ref: input.projectRef,
        stamped_at: normaliseInstant(input.stampedAt),
        prime_sha: input.expectedSha,
        settled: false,
        refused: why,
        notice: notice.state,
      },
    });
    return {
      ran: true,
      line: `Migration effects not replayed: ${why} — the next pass asks again`,
      stoppedAtDeadline: false,
      settled: false,
      notice,
    };
  };

  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, input.cloneId);
  } catch (e) {
    return refusal(
      `this clone's project could not be resolved (${
        e instanceof CloneSecretTargetError ? e.reason : "unresolved"
      }: ${msg(e).slice(0, 200)})`,
    );
  }
  if (target.projectRef !== input.projectRef) {
    return refusal(
      `the clone's row names ${target.projectRef}, not the ${input.projectRef} this pass is building`,
      target.cloneName,
    );
  }

  let prime: PrimeEffects;
  try {
    const source = input.source ?? (await resolvePrimeSource(supabase));
    if (!source) return refusal("no prime repository is configured", target.cloneName);
    const remaining = input.deadlineAt === null ? null : input.deadlineAt - Date.now();
    prime = await readPrimeEffects(input.octokit ?? getAppOctokit(), source, {
      expectedSha: input.expectedSha,
      reportNotTakenBecause:
        remaining === null || remaining >= EFFECT_REPORT_NEEDS_MS
          ? null
          : "this pass had no time left for it; the next pass takes it",
    });
  } catch (e) {
    return refusal(`the prime could not be read (${msg(e).slice(0, 240)})`, target.cloneName);
  }

  const run = await replayEffectsOnClone(target, prime, {
    deadlineAt: input.deadlineAt,
    dryRun: false,
  });
  const notice = await announceEffectExposures(supabase, {
    cloneId: input.cloneId,
    cloneName: run.cloneName,
    projectRef: input.projectRef,
    stampedAt: input.stampedAt,
    commit: run.commit,
    exposures: effectExposures(run),
    resumes: run.stopped,
  });
  // A notice owed and not written keeps the stamp owed, so the next pass
  // raises it again rather than the stamp settling with nobody told.
  const settled = run.settled && notice.state !== "not_delivered";
  await writeAuditLog({
    action: EFFECT_REPLAY_AUDIT_ACTION,
    entityType: "clone",
    entityId: input.cloneId,
    metadata: {
      ...auditMetadataOf(run, { source: "provisioning", stampedAt: input.stampedAt }),
      settled,
      notice: notice.state,
    },
  });
  return {
    ran: true,
    line: describeEffectRun(run),
    stoppedAtDeadline: run.stopped,
    settled,
    run,
    notice,
  };
}

export type EffectReplaySweepResult = {
  dryRun: boolean;
  /** Null when no clone was a candidate, so the prime was not read. */
  commit: string | null;
  manifest: CloneEffectRun["manifest"] | null;
  considered: number;
  runs: CloneEffectRun[];
  /** The clone the budget stopped the pass at, if any. */
  pausedAt: string | null;
  refused: Array<{ cloneId: string; reason: string; error: string }>;
  /** Each clone whose run left an approved fix unconfirmed, and whether the operators were told. */
  notices: Array<{ cloneId: string } & Exclude<EffectNoticeState, { state: "none" }>>;
};

/**
 * The same replay, against clones that already exist.
 *
 * A clone still being provisioned is left to its own stage: until its schema
 * is verified a replay file finds the tables it names absent, skips them,
 * and its probe can read that absence as the effect being there. Every
 * other clone with a project is a candidate, one or all, rotated so a pass
 * the budget stops does not always stop at the same one.
 */
export async function reconcileCloneEffectReplays(
  supabase: Db,
  opts: { deadlineAt: number; dryRun?: boolean; cloneId?: string; now?: number },
): Promise<EffectReplaySweepResult> {
  const dryRun = Boolean(opts.dryRun);
  let q = supabase
    .from("clone_backends")
    .select("clone_id, status, schema_verified_at")
    .not("supabase_project_ref", "is", null);
  if (opts.cloneId) q = q.eq("clone_id", opts.cloneId);
  const { data, error } = await q;
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const refused: EffectReplaySweepResult["refused"] = [];
  const candidates: string[] = [];
  // Each clone's ledger stamp, the key its exposures are told under, as the
  // stage that built it told them.
  const stamps = new Map<string, string | null>();
  for (const row of (data ?? []) as Array<{
    clone_id: string | null;
    status: string | null;
    schema_verified_at?: string | null;
  }>) {
    if (!row.clone_id) continue;
    if (row.status !== "ready") {
      refused.push({
        cloneId: row.clone_id,
        reason: "not_ready",
        error: `its backend is '${row.status}'; provisioning replays these itself once its schema is verified`,
      });
      continue;
    }
    candidates.push(row.clone_id);
    stamps.set(row.clone_id, row.schema_verified_at ?? null);
  }
  candidates.sort();
  if (candidates.length === 0) {
    return {
      dryRun,
      commit: null,
      manifest: null,
      considered: 0,
      runs: [],
      pausedAt: null,
      refused,
      notices: [],
    };
  }

  const source = await resolvePrimeSource(supabase);
  if (!source)
    throw new Error("No prime repository is configured, so there is no manifest to read");
  const prime = await readPrimeEffects(getAppOctokit(), source, { expectedSha: null });

  const out: EffectReplaySweepResult = {
    dryRun,
    commit: prime.commit,
    manifest: {
      state: prime.manifest.state,
      ...("why" in prime.manifest ? { why: prime.manifest.why } : {}),
      approved: prime.manifest.entries.length,
      refused: prime.manifest.refused.length,
    },
    considered: candidates.length,
    runs: [],
    pausedAt: null,
    refused,
    notices: [],
  };

  const minute = Math.floor((opts.now ?? Date.now()) / 60_000);
  for (const cloneId of rotate(candidates, minute)) {
    if (pastDeadline(opts.deadlineAt)) {
      out.pausedAt = cloneId;
      break;
    }
    let target: CloneSecretTarget;
    try {
      target = await resolveCloneSecretTarget(supabase, cloneId);
    } catch (e) {
      refused.push({
        cloneId,
        reason: e instanceof CloneSecretTargetError ? e.reason : "target_unresolved",
        error: msg(e),
      });
      continue;
    }
    const run = await replayEffectsOnClone(target, prime, { deadlineAt: opts.deadlineAt, dryRun });
    out.runs.push(run);
    // Told as the stage tells it, under the clone's own stamp, so a run here
    // after the build's notice repeats nothing that notice said. Nothing for
    // a dry run (`effectExposures`).
    const notice = await announceEffectExposures(supabase, {
      cloneId,
      cloneName: run.cloneName,
      projectRef: run.projectRef,
      stampedAt: stamps.get(cloneId) ?? null,
      commit: run.commit,
      exposures: effectExposures(run),
    });
    if (notice.state !== "none") out.notices.push({ cloneId, ...notice });
    // The per-clone record of what was done to it. A dry run is somebody
    // looking and answers them; a pass that found every approved file already
    // in effect has nothing to add to the clone's history, and its report
    // travels in the sweep's own row.
    if (!dryRun && replayIsNoteworthy(run)) {
      await writeAuditLog({
        action: EFFECT_REPLAY_AUDIT_ACTION,
        entityType: "clone",
        entityId: cloneId,
        metadata: {
          ...auditMetadataOf(run, { source: "hook", stampedAt: null }),
          notice: notice.state,
        },
      });
    }
    if (run.stopped) {
      out.pausedAt = cloneId;
      break;
    }
  }
  return out;
}

/**
 * Whether the replay half of a run did or met anything: a file run, refused
 * or failing, a manifest that could not be used, a pass the budget stopped.
 * Every approved file already in effect is the settled state, and says
 * nothing new.
 */
function replayIsNoteworthy(run: CloneEffectRun): boolean {
  if (run.stopped || run.manifest.state === "unreadable" || run.manifest.state === "unfetched") {
    return true;
  }
  return run.outcomes.some((o) => o.status !== "already_in_effect");
}

/**
 * Whether a run is worth a line anywhere: the replay half, or a report that
 * was not taken or found a probe returning no row. The report is reviewed by
 * a person, so while any probe fails — the template refresh decisions no
 * clone holds always do — every run that reads it is noteworthy.
 */
function effectRunIsNoteworthy(run: CloneEffectRun): boolean {
  if (replayIsNoteworthy(run)) return true;
  if (!run.report.taken) return true;
  return (
    run.report.failing.length > 0 ||
    run.report.errored.length > 0 ||
    run.report.refused.length > 0 ||
    run.report.unanswered.length > 0
  );
}

/** Whether a sweep deserves a breadcrumb: anything replayed, refused, failing or stopped. */
export function effectSweepIsNoteworthy(result: EffectReplaySweepResult): boolean {
  if (result.dryRun) return false;
  if (result.pausedAt || result.refused.some((r) => r.reason !== "not_ready")) return true;
  return result.runs.some(effectRunIsNoteworthy);
}
