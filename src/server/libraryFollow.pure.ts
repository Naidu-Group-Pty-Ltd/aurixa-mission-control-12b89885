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
 * A follow that fails is tried again at the next tick, three times at one
 * commit (`FOLLOW_ATTEMPTS`). The third failure tells the operators, and the
 * follow waits for the prime to move: a failure that repeats would otherwise
 * spend a detection's GitHub calls every fifteen minutes.
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

/** How many times the follow tries one commit before it waits for the prime to move. */
export const FOLLOW_ATTEMPTS = 3;

// ─── Which run is the follow's, and what it does next ───────────────────────

/** A detection run, as the follow reads it. */
export type FollowRun = {
  id: string;
  status: string;
  commit_sha: string | null;
  parameters: Json | null;
  started_at: string | null;
};

/** Whether a run is the follow's: its configuration says so (`DetectionRunConfig.follow`). */
export function isFollowRun(run: Pick<FollowRun, "parameters">): boolean {
  const p = run.parameters;
  return !!p && typeof p === "object" && !Array.isArray(p) && p.follow === true;
}

export type FollowStep =
  /** The catalogue was settled at the head. */
  | { kind: "up_to_date"; run: FollowRun }
  /** The follow stopped for a person at the head, and waits for the head to move. */
  | { kind: "held"; run: FollowRun }
  /** The follow failed `FOLLOW_ATTEMPTS` times at the head, and waits for the head to move. */
  | { kind: "exhausted"; failed: FollowRun[]; stale: FollowRun[] }
  /**
   * Detect at the head, as the follow's `attempt`th try at it. `stale` are
   * follow runs that died before they settled.
   */
  | { kind: "detect"; stale: FollowRun[]; attempt: number };

/**
 * What the follow does at `headSha`, from the detection runs read (newest
 * first). A follow run still `running` past the window died with its
 * invocation, and is `stale`: the follow closes it as failed. A failed
 * follow run at the head, or a stale one, is a try: after `FOLLOW_ATTEMPTS`
 * the follow waits for the head to move, as it does at a held one.
 */
export function nextFollowStep(args: {
  headSha: string;
  runs: readonly FollowRun[];
  now: number;
  windowMs: number;
}): FollowStep {
  const follows = args.runs.filter(isFollowRun);
  const lastIndex = follows.findIndex((r) => r.status === "completed" || r.status === FOLLOW_HELD);
  const last = lastIndex >= 0 ? follows[lastIndex] : undefined;
  if (last && last.commit_sha === args.headSha) {
    return last.status === FOLLOW_HELD
      ? { kind: "held", run: last }
      : { kind: "up_to_date", run: last };
  }
  const stale = follows.filter(
    (r) =>
      r.status === "running" &&
      r.started_at !== null &&
      Date.parse(r.started_at) < args.now - args.windowMs,
  );
  const died = new Set(stale.map((r) => r.id));
  // The tries since the follow last settled or held: a commit it settled at
  // since is not tried again, so an older try at it counts for nothing.
  const since = lastIndex >= 0 ? follows.slice(0, lastIndex) : follows;
  const failed = since.filter(
    (r) => r.commit_sha === args.headSha && (r.status === "failed" || died.has(r.id)),
  );
  if (failed.length >= FOLLOW_ATTEMPTS) return { kind: "exhausted", failed, stale };
  return { kind: "detect", stale, attempt: failed.length + 1 };
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

export type EntryChange = "new" | "unapproved" | "changed" | "unchanged";

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
  approved: string[];
  revived: string[];
  archived: string[];
  keptOut: string[];
  published: Array<{ slug: string; version: number; change: EntryChange }>;
  unchanged: number;
  refused: Array<{ slug: string; reason: string }>;
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
    approved: [],
    revived: [],
    archived: [],
    keptOut: [],
    published: [],
    unchanged: 0,
    refused: [],
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
      approved: cut(report.approved),
      revived: cut(report.revived),
      archived: cut(report.archived),
      kept_out: cut(report.keptOut),
      published: cut(report.published),
      unchanged: report.unchanged,
      refused: cut(report.refused),
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
      : `The module library failed to follow ${at} ${FOLLOW_ATTEMPTS} times, most recently ` +
        `because ${why}. It tries again when the prime moves.`,
    url: "/modules",
    metadata: { run_id: report.runId, commit_sha: report.commitSha, outcome: report.outcome },
  };
}
