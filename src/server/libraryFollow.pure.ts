/**
 * The module library follows the prime: the decisions (docs/DELIVERY_SYSTEM_PLAN.md,
 * D19, the owner's decision of 29 Oct 2026).
 *
 * The owner asked on 29 Oct that the library update itself whenever the prime
 * changes, rather than waiting for an admin to reset and re-ingest it, so that
 * a clone provisioned at any time is reconciled against the catalogue as the
 * prime holds it (provisioning's own reconcile, `catalogueSettledAt`).
 * `library-follow.server.ts` does the reads and writes; this module decides
 * what they are.
 *
 * ## One run, at one commit, settled whole
 *
 * A follow detects the catalogue at the prime's head, in follow mode
 * (`module-detection.server.ts`): every module it finds is rewritten from the
 * run, an approved one included, so every module names the run that shaped
 * it, and its files and backend were found at that run's one commit. The run
 * stays `running` while the follow settles the catalogue at it, so a reset or
 * a detection started meanwhile meets it and stops. Settling is:
 *
 *  - approving what the run proposed, as the owner decided: by policy, with no
 *    approver, at the run's commit;
 *  - archiving what the run no longer found, marked as the follow's, so a
 *    module it finds again is brought back, and a module a person archived is
 *    never brought back;
 *  - publishing an entry for each module whose entry would differ from its
 *    latest, or whose latest is not approved at a commit (every entry before
 *    the follow), so a push that changes nothing a clone receives publishes
 *    nothing.
 *
 * Then the run is `completed`, and the catalogue is at its commit.
 *
 * ## It changes no clone
 *
 * The follow writes the catalogue and the library, and no clone's row or
 * installs. A reconcile resolves a clone's plan from its metering tenant, and
 * on 29 Oct 2026 all four clones metered on `free` while Mission Control
 * recorded `scale`, `scale`, `launch` and `scale` (D16: they stay on `free`
 * until launch). Reconciling them would have rewritten each clone's recorded
 * plan to `free`, which plan-targeted notices and the payment gate read. Every
 * clone is a mirror, which receives every file whatever its installs say, so
 * the follow owes a clone nothing: a new clone is reconciled when it is
 * provisioned, against the catalogue the follow keeps at the prime's head.
 *
 * ## It stops for a person rather than archive the catalogue
 *
 * A run that found nothing, or that would archive more than a quarter of the
 * live catalogue, is `held`, and it is asked before the run writes a module
 * (`beforeWriting` in `module-detection.server.ts`): no module is rewritten,
 * nothing is approved, archived or published, the operators are told, and the
 * follow does not try that commit again. The first follow
 * archives 14 of 135 (measured against prime@122b761, 29 Oct 2026), well
 * inside it.
 *
 * A follow that fails is tried again at the next tick. Three failures in a row
 * (`FOLLOW_ATTEMPTS`), at any commits, tell the operators once, and from then
 * the follow tries once every six hours (`FOLLOW_BACKOFF_MS`) until one
 * settles: a failure that repeats, a runtime that kills the detection, say,
 * would otherwise spend a detection every fifteen minutes, or every merge,
 * and say nothing.
 *
 * A detection a person ran, or a reset, after the follow last settled is a
 * change to the catalogue the follow did not make, so the follow settles it
 * again at the same commit.
 */
import type { Database, Json } from "@/integrations/supabase/types";
import { isCommitSha, primeCommitLabel } from "@/lib/libraryCommit.pure";

type LibraryInsert = Database["public"]["Tables"]["module_library"]["Insert"];
type NotificationInsert = Database["public"]["Tables"]["notifications"]["Insert"];

/** The audit action every follow that did something, or could not, records. */
export const FOLLOW_AUDIT_ACTION = "module_library.follow";

/** The status of a follow run that stopped for a person, and is not tried again at its commit. */
export const FOLLOW_HELD = "held";

/** A follow archives at most this many modules without a person, whatever the catalogue's size. */
export const ARCHIVE_FLOOR = 10;

/** ...or this share of the live catalogue, where that is more. */
export const ARCHIVE_SHARE = 0.25;

/** How many failures in a row tell the operators, and slow the follow to one try per backoff. */
export const FOLLOW_ATTEMPTS = 3;

/** How long the follow waits between tries once it has failed `FOLLOW_ATTEMPTS` times in a row. */
export const FOLLOW_BACKOFF_MS = 6 * 60 * 60_000;

/** The status of a follow run that stepped aside for a reset or a detection: not a try. */
export const FOLLOW_SKIPPED = "skipped";

/**
 * How long a run that has written every module it found is left to the
 * invocation that detected it, which settles it next. A tick after that
 * settles it instead, without detecting again.
 */
export const SETTLE_QUIET_MS = 10 * 60_000;

/** How long a run that has written its modules stays the follow's to settle. Past it, the run died. */
export const SETTLE_WINDOW_MS = 2 * 60 * 60_000;

// ─── Which run is the follow's, and what it does next ───────────────────────

/** A detection run, as the follow reads it. */
export type FollowRun = {
  id: string;
  status: string;
  commit_sha: string | null;
  parameters: Json | null;
  started_at: string | null;
  completed_at: string | null;
  /** Written with the run's findings, after its last module (`runDetection`). */
  tree_hash: string | null;
  /** The run row's last write, stamped by its trigger. */
  updated_at: string | null;
};

/** Whether a run is the follow's: its configuration says so (`DetectionRunConfig.follow`). */
export function isFollowRun(run: Pick<FollowRun, "parameters">): boolean {
  const p = run.parameters;
  return !!p && typeof p === "object" && !Array.isArray(p) && p.follow === true;
}

/**
 * Whether a follow run, still `running`, has written every module it found
 * and waits only to be settled. Its tree hash is written with its findings,
 * after the last module, and nowhere else in follow mode.
 */
export function hasDetected(run: Pick<FollowRun, "status" | "tree_hash">): boolean {
  return run.status === "running" && run.tree_hash !== null;
}

export type FollowStep =
  /** The catalogue was settled at the head, and nothing changed it since. */
  | { kind: "up_to_date"; run: FollowRun }
  /** The follow stopped for a person at the head, and waits for the head to move. */
  | { kind: "held"; run: FollowRun }
  /** The follow failed `FOLLOW_ATTEMPTS` times in a row and waits out its backoff. */
  | { kind: "exhausted"; failed: FollowRun[]; stale: FollowRun[] }
  /** A run wrote every module it found moments ago, and the invocation that detected it may be settling it. */
  | { kind: "settling"; run: FollowRun }
  /**
   * Settle `run`, which wrote every module it found before the invocation
   * that detected it ended, without detecting again. `stale`, `attempt` and
   * `afterHold` as for `detect`.
   */
  | {
      kind: "settle";
      run: FollowRun;
      commitSha: string;
      stale: FollowRun[];
      attempt: number;
      afterHold: boolean;
    }
  /**
   * Detect at the head, as the follow's `attempt`th try in a row. `stale` are
   * follow runs that died before they settled. `afterHold` says the last
   * follow run that finished was held, whose notice the operators have.
   */
  | { kind: "detect"; stale: FollowRun[]; attempt: number; afterHold: boolean };

/**
 * What the follow does at `headSha`, from the detection runs read (newest
 * first). A follow run still `running` past the window died with its
 * invocation, and is `stale`: the follow closes it as failed. Every follow run
 * since the follow last settled or held that failed, or died, is a try,
 * whatever commit it read: after `FOLLOW_ATTEMPTS` of them the follow tries
 * once per `FOLLOW_BACKOFF_MS`, counted from the newest. A run that stepped
 * aside (`FOLLOW_SKIPPED`) is not a try.
 *
 * A follow run that wrote every module it found (`hasDetected`) is settled,
 * not detected again, once `SETTLE_QUIET_MS` has passed since it wrote them,
 * which is long after the invocation that detected it ended: settling is what
 * that invocation did next. On 29 Oct 2026 two invocations died in their
 * second minute, the second of them 23 entries into its publication, and each
 * cost a whole detection and a try. Only while the run is the newest
 * detection of all: one a person's detection or a reset followed had its
 * modules written over, and is stale. Past `SETTLE_WINDOW_MS` it is stale
 * too, so a settle that dies at every tick is a try in the end.
 */
export function nextFollowStep(args: {
  headSha: string;
  runs: readonly FollowRun[];
  now: number;
  windowMs: number;
  backoffMs?: number;
}): FollowStep {
  const follows = args.runs.filter(isFollowRun);
  const lastIndex = follows.findIndex((r) => r.status === "completed" || r.status === FOLLOW_HELD);
  const last = lastIndex >= 0 ? follows[lastIndex] : undefined;
  // A completed detection that is not the follow's, newer than the follow's
  // last settle: a person's detection or a reset changed the catalogue.
  const changedSince =
    last !== undefined &&
    args.runs
      .slice(0, args.runs.indexOf(last))
      .some((r) => !isFollowRun(r) && r.status === "completed");
  if (last && last.commit_sha === args.headSha && !changedSince) {
    return last.status === FOLLOW_HELD
      ? { kind: "held", run: last }
      : { kind: "up_to_date", run: last };
  }
  const detectedAt = (r: FollowRun) => Date.parse(r.updated_at ?? "") || 0;
  const newestRun = args.runs[0];
  const pending =
    newestRun !== undefined &&
    isFollowRun(newestRun) &&
    hasDetected(newestRun) &&
    newestRun.commit_sha !== null &&
    detectedAt(newestRun) >= args.now - SETTLE_WINDOW_MS
      ? newestRun
      : undefined;
  const stale = follows.filter(
    (r) =>
      r.status === "running" &&
      r !== pending &&
      (hasDetected(r) ||
        (r.started_at !== null && Date.parse(r.started_at) < args.now - args.windowMs)),
  );
  const died = new Set(stale.map((r) => r.id));
  const since = lastIndex >= 0 ? follows.slice(0, lastIndex) : follows;
  const failed = since.filter((r) => r.status === "failed" || died.has(r.id));
  const afterHold = last?.status === FOLLOW_HELD;
  if (pending?.commit_sha) {
    // Settling it is cheap, and the backoff is for detections.
    if (detectedAt(pending) > args.now - SETTLE_QUIET_MS) return { kind: "settling", run: pending };
    return {
      kind: "settle",
      run: pending,
      commitSha: pending.commit_sha,
      stale,
      attempt: failed.length + 1,
      afterHold,
    };
  }
  if (failed.length >= FOLLOW_ATTEMPTS) {
    const newest = Math.max(
      ...failed.map((r) => Date.parse(r.completed_at ?? r.started_at ?? "") || 0),
    );
    if (args.now - newest < (args.backoffMs ?? FOLLOW_BACKOFF_MS)) {
      return { kind: "exhausted", failed, stale };
    }
  }
  return { kind: "detect", stale, attempt: failed.length + 1, afterHold };
}

// ─── Settling the catalogue at a run ────────────────────────────────────────

/** A module, as the follow reads it to settle. */
export type FollowModule = {
  id: string;
  slug: string;
  name: string;
  status: string;
  detection_run_id: string | null;
  archived_by_follow_run_id: string | null;
};

export type SettlePlan = {
  /** Proposed modules the run found: approved by policy. */
  approve: FollowModule[];
  /** Modules the follow archived that the run found again: approved again. */
  revive: FollowModule[];
  /** Live modules the run did not find: archived, as the follow's. */
  archive: FollowModule[];
  /** Every module the run found that is approved once the settle is done: what may publish. */
  publish: FollowModule[];
  /** Slugs the run found whose module a person archived or rejected: left as the person left them, and named. */
  keptOut: string[];
  /** Why the follow stops for a person, or null. */
  held: string | null;
};

const live = (m: Pick<FollowModule, "status">) =>
  m.status === "approved" || m.status === "proposed";
const archivedByFollow = (m: FollowModule) =>
  m.status === "archived" && m.archived_by_follow_run_id !== null;

/**
 * Why the follow stops for a person rather than settle a run, or null: the
 * run found nothing, or it would archive more of the live catalogue than a
 * follow archives without one. The one rule, asked before the run writes a
 * module and again when it settles.
 */
export function holdReason(args: {
  found: number;
  live: number;
  archive: readonly string[];
}): string | null {
  if (args.found === 0) {
    return "the run found no module, so nothing it found can stand for the catalogue";
  }
  const limit = Math.max(ARCHIVE_FLOOR, Math.ceil(args.live * ARCHIVE_SHARE));
  if (args.archive.length <= limit) return null;
  const named = args.archive.slice(0, 10).join(", ");
  const more = args.archive.length > 10 ? `, and ${args.archive.length - 10} more` : "";
  return (
    `the run would archive ${args.archive.length} of the ${args.live} live modules, ` +
    `more than the ${limit} a follow archives without a person: ${named}${more}`
  );
}

/**
 * The hold asked before the run writes a module: the run's slugs against the
 * catalogue as it stands. Every live module the run found is rewritten from
 * it, so the live modules whose slug it did not find are the ones the settle
 * would archive.
 */
export function holdBeforeWriting(args: {
  modules: readonly Pick<FollowModule, "slug" | "status">[];
  detectedSlugs: readonly string[];
}): string | null {
  const detected = new Set(args.detectedSlugs);
  const liveModules = args.modules.filter(live);
  return holdReason({
    found: detected.size,
    live: liveModules.length,
    archive: liveModules
      .filter((m) => !detected.has(m.slug))
      .map((m) => m.slug)
      .sort(),
  });
}

/**
 * What settling the catalogue at `runId` writes. A module the run found names
 * it (`detection_run_id`), because follow mode rewrites every module it finds
 * but one a person archived, which keeps the run that last shaped it.
 * `detectedSlugs` is every slug the run found, which is how a module a person
 * archived is told apart from one the run did not find. One a person rejected
 * is rewritten and stays rejected: it is neither approved nor archived.
 */
export function planSettle(args: {
  runId: string;
  modules: readonly FollowModule[];
  detectedSlugs: readonly string[];
}): SettlePlan {
  const found = args.modules.filter((m) => m.detection_run_id === args.runId);
  const approve = found.filter((m) => m.status === "proposed");
  const revive = found.filter(archivedByFollow);
  const publish = found.filter(
    (m) => m.status === "approved" || m.status === "proposed" || archivedByFollow(m),
  );
  const liveModules = args.modules.filter(live);
  const archive = liveModules.filter((m) => m.detection_run_id !== args.runId);
  const detected = new Set(args.detectedSlugs);
  const keptOut = args.modules
    .filter(
      (m) =>
        detected.has(m.slug) &&
        (m.status === "rejected" || (m.status === "archived" && !archivedByFollow(m))),
    )
    .map((m) => m.slug)
    .sort();

  const held = holdReason({
    found: found.length,
    live: liveModules.length,
    archive: archive.map((m) => m.slug).sort(),
  });
  return { approve, revive, archive, publish, keptOut, held };
}

// ─── Whether a module's entry changed ───────────────────────────────────────

/** The latest entry of a slug, as the follow compares it. */
export type LatestEntry = {
  slug: string;
  version: number;
  approval_status: string;
  source_commit_sha: string | null;
  name: string;
  description: string | null;
  route_path: string | null;
  entry_file: string;
  file_paths: string[] | null;
  metadata: Json | null;
};

export type EntryChange = "new" | "unapproved" | "changed" | "unchanged" | "rejected";

/** The backend contract an entry's metadata carries: what a pinned install needs (libraryEntryInsert). */
const CONTRACT_KEYS = [
  "layer",
  "edge_functions",
  "database_tables",
  "required_secrets",
  "required_migrations",
  "storage_buckets",
  "cron_jobs",
] as const;

const sortedList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map(String))].sort() : [];

function contractOf(metadata: Json | null | undefined): Record<string, unknown> {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const out: Record<string, unknown> = {};
  for (const key of CONTRACT_KEYS) {
    out[key] = key === "layer" ? (m[key] ?? null) : sortedList(m[key]);
  }
  return out;
}

/**
 * Whether `candidate`, the entry the follow would publish, says anything its
 * slug's latest entry does not: what a clone receives (the paths, the route,
 * the entry file and the backend contract) and what the library shows (the
 * name and description). A score is not: it moves on every run and changes
 * nothing a clone receives. A latest entry that is not approved at a commit,
 * which every entry published before the follow is, is superseded whatever it
 * says.
 */
export function entryChange(
  latest: LatestEntry | undefined,
  candidate: LibraryInsert,
): EntryChange {
  if (!latest) return "new";
  // A person rejected it, and the follow approves nothing over a person.
  if (latest.approval_status === "rejected") return "rejected";
  if (latest.approval_status !== "approved" || !isCommitSha(latest.source_commit_sha)) {
    return "unapproved";
  }
  const same =
    latest.name === candidate.name &&
    (latest.description ?? null) === (candidate.description ?? null) &&
    (latest.route_path ?? null) === (candidate.route_path ?? null) &&
    latest.entry_file === candidate.entry_file &&
    JSON.stringify(sortedList(latest.file_paths)) ===
      JSON.stringify(sortedList(candidate.file_paths)) &&
    JSON.stringify(contractOf(latest.metadata)) === JSON.stringify(contractOf(candidate.metadata));
  return same ? "unchanged" : "changed";
}

// ─── What a follow reports ──────────────────────────────────────────────────

export type FollowOutcome = "up_to_date" | "held" | "exhausted" | "settled" | "failed" | "skipped";

export type FollowReport = {
  outcome: FollowOutcome;
  /** The prime's head the follow read, or null where it could not. */
  headSha: string | null;
  /** The run the follow detected with, or settled at. */
  runId: string | null;
  /** The commit that run read. */
  commitSha: string | null;
  /** Which try at the head this was, out of `FOLLOW_ATTEMPTS`. */
  attempt: number | null;
  /** Whether this tick settled a run an earlier invocation had detected (`settle`). */
  resumed: boolean;
  approved: string[];
  revived: string[];
  archived: string[];
  keptOut: string[];
  published: Array<{ slug: string; version: number; change: EntryChange }>;
  unchanged: number;
  /** Modules the publication's own judge refused: named, and not a failure of the follow. */
  refused: Array<{ slug: string; reason: string }>;
  /** Slugs whose latest entry a person rejected: the follow publishes nothing over it. */
  rejectedEntries: string[];
  /** Why the follow stopped, held or failed. */
  stoppedBecause?: string;
  /** Follow runs that died before they settled, closed as failed. */
  closedStale: string[];
  /** Earlier runs whose diagnostics (edges, backend artifacts, drift alerts) were pruned. */
  pruned: string[];
  warnings: string[];
};

export function emptyFollowReport(outcome: FollowOutcome = "failed"): FollowReport {
  return {
    outcome,
    headSha: null,
    runId: null,
    commitSha: null,
    attempt: null,
    resumed: false,
    approved: [],
    revived: [],
    archived: [],
    keptOut: [],
    published: [],
    unchanged: 0,
    refused: [],
    rejectedEntries: [],
    closedStale: [],
    pruned: [],
    warnings: [],
  };
}

/** The report, as the audit row records it: every list, cut at 200 so a row stays a row. */
export function followAuditMetadata(report: FollowReport): Json {
  const cut = <T>(list: T[]) => list.slice(0, 200);
  return JSON.parse(
    JSON.stringify({
      outcome: report.outcome,
      head_sha: report.headSha,
      run_id: report.runId,
      commit_sha: report.commitSha,
      attempt: report.attempt,
      resumed: report.resumed,
      approved: cut(report.approved),
      revived: cut(report.revived),
      archived: cut(report.archived),
      kept_out: cut(report.keptOut),
      published: cut(report.published),
      unchanged: report.unchanged,
      refused: cut(report.refused),
      rejected_entries: cut(report.rejectedEntries),
      stopped_because: report.stoppedBecause ?? null,
      closed_stale: report.closedStale,
      pruned: cut(report.pruned),
      warnings: cut(report.warnings),
    }),
  );
}

/**
 * The operators' notice that the follow stopped for a person at a commit:
 * held, or failed for the last of its tries there.
 */
export function stoppedNotice(report: FollowReport): NotificationInsert {
  const at = primeCommitLabel(report.commitSha) ?? "the prime's head";
  const why = report.stoppedBecause ?? "no reason was recorded";
  const held = report.outcome === "held";
  return {
    kind: "library_follow_held",
    severity: "warning",
    title: held ? `Library follow held at ${at}` : `Library follow failed at ${at}`,
    body: held
      ? `The module library did not follow ${at}: ${why}. No module was approved, archived ` +
        `or published. It follows again when the prime moves.`
      : `The module library failed to follow the prime ${FOLLOW_ATTEMPTS} times in a row, ` +
        `most recently at ${at} because ${why}. It tries again every six hours until one ` +
        `follow settles.`,
    url: "/modules",
    metadata: { run_id: report.runId, commit_sha: report.commitSha, outcome: report.outcome },
  };
}
