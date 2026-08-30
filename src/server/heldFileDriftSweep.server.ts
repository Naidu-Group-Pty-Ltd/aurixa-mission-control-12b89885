/**
 * Come back and look at the held files, on a clock, with no cascade running.
 *
 * ## The gap this closes
 *
 * A `manual_reconcile` path is one the cascade must never write: the clone's
 * copy is a deliberate superset of prime's, so taking prime's version would
 * revert real work. Two guards stand behind that hold, and both of them run
 * *inside a cascade*, over the files that cascade delivers:
 *
 *   - `findStaleHeldReferences` catches a REMOVAL — a held file importing
 *     something a delivered module stopped exporting. That one is loud. It
 *     fails the build, which is how it was found: `src/App.tsx` importing an
 *     `AmlIntakeQueue` that `AmlShellPages.tsx` no longer exported, failing
 *     every Vercel deployment while the cascade reported the same "1 awaiting
 *     manual reconcile" it reports on a healthy run.
 *
 *   - `findMissingHeldReferences` catches an ADDITION — wiring prime's copy has
 *     and the clone's copy never received. That one is SILENT. An import that
 *     is simply absent compiles perfectly. The clone just does not have the
 *     feature.
 *
 * The second one is why this exists. Both guards are blind to a module no
 * cascade has touched since the drift appeared: the guard never runs, nothing
 * goes red, and nobody is told. The AUSTRAC drafting routes were caught only
 * because a source test happened to assert them, which is luck rather than a
 * mechanism. This is the mechanism.
 *
 * ## What it does and, more importantly, what it will not do
 *
 * **It reports; it never repairs.** A held file is held precisely because this
 * platform is forbidden to write it — that rule is the whole reason
 * `syncExclusions.pure.ts` exists, and a sweep that "helpfully" pushed the
 * missing import would be the cascade overwriting a clone's own work by another
 * route. Every finding ends in a record and a notification for a person.
 *
 * **It never invents a finding a cascade would not make.** The finding comes
 * out of `findMissingHeldReferences`, the same function the engine calls, over
 * content actually fetched from both repositories. `planHeldFileDrift` is a
 * pre-filter that decides what to READ — it exists so a held file importing
 * from forty modules costs one blob read rather than forty — and it decides
 * nothing about what is reported.
 *
 * **It stays quiet about ordinary lag.** A module prime's held file imports
 * from that the clone does not have at all is not a gap in the held file; it is
 * a module still in flight, and the cascade's own guard will speak when it
 * lands. Reporting it here would turn every open cascade into a notification.
 *
 * ## Cost
 *
 * Per clone: one tree read, two blob reads per held TypeScript path, and a blob
 * read for each module that actually differs — which on a reconciled fleet is
 * zero. Roughly ten calls for the mirror and two for a module-scoped clone,
 * against an hourly budget of 5,000.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit, getFileContent, listTreeEntries, type RepoRef } from "./github-app.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import {
  decideDriftReport,
  planHeldFileDrift,
  type DriftFetchPlan,
} from "./cascade/heldFileDrift.pure";
import {
  describeMissingHeldReferences,
  findMissingHeldReferences,
  type MissingHeldReference,
} from "./cascade/heldFileStaleness.pure";
import {
  assertMirrorPolicy,
  partitionCascadePaths,
  reportableHeld,
  requireExclusions,
  type SyncExclusion,
} from "./cascade/syncExclusions.pure";

type Db = SupabaseClient<Database>;

/** The audit action this sweep records under. Also how it reads its own past. */
export const HELD_DRIFT_ACTION = "held_file_drift_sweep";

/**
 * Ceilings, so one pathologically divergent clone cannot spend the fleet's
 * GitHub budget. Both are far above anything observed — the mirror holds six
 * `manual_reconcile` patterns — and being capped is reported rather than
 * silently trimmed, because a truncated sweep that looks complete is the
 * failure this whole module exists to stop.
 */
const MAX_HELD_PATHS = 24;
const MAX_TARGETS = 12;

export type CloneDriftOutcome =
  | { clone: string; outcome: "clean"; capped?: boolean }
  | {
      clone: string;
      outcome: "drifted";
      findings: MissingHeldReference[];
      lines: string[];
      announced: boolean;
      capped: boolean;
    }
  | { clone: string; outcome: "cleared" }
  | { clone: string; outcome: "skipped"; why: string }
  | { clone: string; outcome: "failed"; error: string };

export type HeldFileDriftReport = {
  clones: number;
  drifted: number;
  cleared: number;
  announced: number;
  /** Clones whose sweep hit a ceiling, so this run looked at less than all. */
  capped: number;
  skipped: number;
  failed: number;
  detail: CloneDriftOutcome[];
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Source files a held-file import gap can exist in. */
const isSource = (path: string) => /\.[cm]?tsx?$/.test(path);

export async function sweepHeldFileDrift(supabase: Db): Promise<HeldFileDriftReport> {
  const report: HeldFileDriftReport = {
    clones: 0,
    drifted: 0,
    cleared: 0,
    announced: 0,
    capped: 0,
    skipped: 0,
    failed: 0,
    detail: [],
  };

  const primeRes = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (primeRes.error) throw new Error(`Could not read prime config: ${primeRes.error.message}`);
  const prime = primeRes.data;
  // No prime is a fault, not a clean fleet. Returning an empty report here
  // would say "nothing has drifted" about a comparison that never ran.
  if (!prime?.github_owner || !prime?.github_repo) {
    throw new Error("Prime not configured — nothing to compare a held file against");
  }
  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: prime.default_branch || "main",
  };

  const { data, error } = await supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch, sync_scope")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clones: ${error.message}`);

  const octokit = getAppOctokit();

  for (const raw of data ?? []) {
    const clone = raw as {
      id: string;
      name: string | null;
      github_owner: string | null;
      github_repo: string | null;
      default_branch: string | null;
      sync_scope: string | null;
    };
    if (!clone.github_owner || !clone.github_repo) continue;
    const label = clone.name ?? `${clone.github_owner}/${clone.github_repo}`;
    report.clones += 1;

    try {
      const outcome = await sweepOneClone({
        supabase,
        octokit,
        primeRef,
        label,
        clone: {
          id: clone.id,
          github_owner: clone.github_owner,
          github_repo: clone.github_repo,
          default_branch: clone.default_branch,
          sync_scope: clone.sync_scope,
        },
      });
      report.detail.push(outcome);
      if (outcome.outcome === "drifted") {
        report.drifted += 1;
        if (outcome.announced) report.announced += 1;
        // A ceiling reached is a sweep that looked at less than all of it, and
        // a truncated sweep that reports as complete is the exact shape of
        // failure this module exists to stop.
        if (outcome.capped) report.capped += 1;
      } else if (outcome.outcome === "cleared") {
        report.cleared += 1;
      } else if (outcome.outcome === "skipped") {
        report.skipped += 1;
      } else if (outcome.outcome === "clean" && outcome.capped) {
        report.capped += 1;
      }
    } catch (e) {
      // One unreachable repository, or one unreadable exclusion policy, must
      // not blind the sweep to the rest of the fleet. Nothing here writes to a
      // repository, so there is no half-done state to unwind.
      report.failed += 1;
      report.detail.push({ clone: label, outcome: "failed", error: msg(e) });
    }
  }

  return report;
}

async function sweepOneClone(args: {
  supabase: Db;
  octokit: ReturnType<typeof getAppOctokit>;
  primeRef: RepoRef;
  clone: {
    id: string;
    github_owner: string;
    github_repo: string;
    default_branch: string | null;
    sync_scope: string | null;
  };
  label: string;
}): Promise<CloneDriftOutcome> {
  const { supabase, octokit, primeRef, clone, label } = args;

  const cloneRef: RepoRef = {
    owner: clone.github_owner,
    repo: clone.github_repo,
    branch: clone.default_branch || "main",
  };

  // Fail-closed by construction, exactly as the engine does it: an exclusion
  // set that could not be read is not an empty one. Here the consequence is
  // milder than in a cascade — the sweep would look at files it should not
  // rather than write them — but the wrong held list produces a wrong finding,
  // and a wrong finding sends an operator to edit a file that is already right.
  const exclusionRes = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", clone.id);
  const exclusions = requireExclusions(
    clone.id,
    exclusionRes.data as SyncExclusion[] | null,
    exclusionRes.error,
  );
  // A mirror with no policy holds nothing back, so every held file this sweep
  // exists to check would be invisible to it and the clone would report as
  // CLEAN. That is the same lie in the other direction from the one the engine
  // refuses, and it is worth refusing here for the same reason: silence about a
  // question you could not ask is indistinguishable from a good answer.
  if (clone.sync_scope === "mirror") assertMirrorPolicy(clone.id, exclusions);

  const tree = await listTreeEntries(octokit, cloneRef);
  // A partial tree read as complete is indistinguishable from a clone that is
  // missing modules, and this sweep's central judgement — "the clone does not
  // have that module, so say nothing" — would then be made on a file list that
  // is simply short.
  if (tree.truncated) {
    return { clone: label, outcome: "skipped", why: "clone tree listing was truncated" };
  }
  const clonePaths = new Set(tree.entries.keys());

  const held = reportableHeld(partitionCascadePaths([...clonePaths], exclusions).held)
    .map((h) => h.path)
    .filter(isSource)
    // Sorted so the ceiling below takes the same paths every run. An unsorted
    // cap whose membership drifted would read as a changed finding.
    .sort();
  if (held.length === 0) {
    // Not "clean" in the interesting sense and not a failure either: this clone
    // holds no source file back, so there is no held file to be behind.
    return { clone: label, outcome: "clean" };
  }
  const heldPaths = held.slice(0, MAX_HELD_PATHS);
  let capped = heldPaths.length < held.length;

  // Both copies of each held path: the one the clone keeps and the one the
  // cascade declined to write. Comparing them in general is meaningless — they
  // differ on purpose, which is what "held" means — but comparing what each
  // takes from a module the clone already has is not.
  const heldFilesClone: Record<string, string> = {};
  const heldFilesPrime: Record<string, string> = {};
  await Promise.all(
    heldPaths.flatMap((path) => [
      // A read that failed is not a file with no imports. Leaving it out costs
      // a finding; inventing an empty one would claim the clone is reconciled.
      (async () => {
        try {
          const f = await getFileContent(octokit, cloneRef, path);
          if (f) heldFilesClone[path] = f.content;
        } catch {
          /* leave it out — see above */
        }
      })(),
      (async () => {
        try {
          const f = await getFileContent(octokit, primeRef, path);
          if (f) heldFilesPrime[path] = f.content;
        } catch {
          /* leave it out — see above */
        }
      })(),
    ]),
  );

  const plans: DriftFetchPlan[] = [];
  for (const path of heldPaths) {
    const primeSource = heldFilesPrime[path];
    const cloneSource = heldFilesClone[path];
    // A held path prime does not have is not a gap in the clone; a held path
    // the clone does not have is a different question, and the guard skips it
    // anyway.
    if (typeof primeSource !== "string" || typeof cloneSource !== "string") continue;
    plans.push(...planHeldFileDrift({ heldPath: path, primeSource, cloneSource, clonePaths }));
  }

  const targets = [...new Set(plans.map((p) => p.target))];
  const fetchTargets = targets.slice(0, MAX_TARGETS);
  capped = capped || fetchTargets.length < targets.length;

  const modules: Record<string, string> = {};
  await Promise.all(
    fetchTargets.map(async (target) => {
      try {
        const f = await getFileContent(octokit, cloneRef, target);
        if (f) modules[target] = f.content;
      } catch {
        /* a module we could not read cannot support a claim about it */
      }
    }),
  );

  // The finding, from the function the cascade uses, over the content actually
  // fetched. The plan above only decided what was worth reading.
  const findings = findMissingHeldReferences({
    heldFilesClone,
    heldFilesPrime,
    cascadedFiles: modules,
  });

  const previous = await lastFingerprint(supabase, clone.id);
  const decision = decideDriftReport({ previous, findings });

  if (!decision.record) {
    return findings.length > 0
      ? {
          clone: label,
          outcome: "drifted",
          findings,
          lines: describeMissingHeldReferences(findings),
          announced: false,
          capped,
        }
      : { clone: label, outcome: "clean", capped };
  }

  const lines = describeMissingHeldReferences(findings);
  // `writeAuditLog` logs a failed insert and does not throw, so a lost record
  // means the next run sees no previous fingerprint and announces this gap
  // again. That is the safe direction: a repeated notification is noise, a
  // finding that quietly stops being reported is the thing this exists to stop.
  await writeAuditLog({
    action: HELD_DRIFT_ACTION,
    entityType: "clone",
    entityId: clone.id,
    metadata: {
      fingerprint: decision.fingerprint,
      findings,
      lines,
      capped,
      held_paths: heldPaths,
      repo: `${cloneRef.owner}/${cloneRef.repo}`,
    },
  });

  if (!decision.notify) {
    return { clone: label, outcome: "cleared" };
  }

  const symbols = findings.flatMap((f) => f.missing);
  await notifyOperators({
    kind: "drift_medium",
    severity: "warning",
    title:
      `${label}: ${symbols.length} piece${symbols.length === 1 ? "" : "s"} of wiring ` +
      `never reached a held file`,
    // Named in full, because the whole point is that nothing else says it. A
    // notification reading "drift detected" would send an operator to open
    // three repositories to work out which symbol, in which file, from which
    // module.
    body: lines.join("\n"),
    cloneId: clone.id,
    url: `/clones/${clone.id}`,
    metadata: { fingerprint: decision.fingerprint, findings, source: HELD_DRIFT_ACTION },
  });

  return { clone: label, outcome: "drifted", findings, lines, announced: true, capped };
}

/**
 * What this clone was last OBSERVED to owe.
 *
 * Deliberately the last observation rather than the last announcement. A gap
 * that appeared, was fixed and came back is a change again, because the
 * clearance was written down in between — see `decideDriftReport`.
 */
async function lastFingerprint(supabase: Db, cloneId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", HELD_DRIFT_ACTION)
    .eq("entity_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A history that could not be read is not a history of nothing. Treating a
  // failed read as "never seen" would re-announce every standing gap in the
  // fleet on every database hiccup, which is the one way to make these
  // notifications worth ignoring.
  if (error) throw new Error(`Could not read drift history: ${error.message}`);
  const fp = (data?.metadata as { fingerprint?: unknown } | null)?.fingerprint;
  return typeof fp === "string" ? fp : null;
}
