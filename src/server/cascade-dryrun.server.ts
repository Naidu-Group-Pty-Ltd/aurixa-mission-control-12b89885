// Pre-cascade dry-run: what would this cascade actually do?
//
// This runs the ENGINE with `dryRun: true` — the same tree reads, the same
// exclusion policy, the same content holds, the same deletion evidence, the
// same held-file guards — and stops at the write boundary. Nothing is
// uploaded, no branch moves, no pull request opens, and `processClone` writes
// to the database on no path at all.
//
// It used to be a second walk of its own, and it disagreed with the cascade on
// nearly every point that matters:
//
//   - it compared DECODED STRINGS (`cf.content !== pf.content`), so two
//     different binaries both decoding to replacement characters read as
//     unchanged — the exact comparison the binary-fidelity work removed from
//     the engine;
//   - it probed the first 30 files per clone and reported that as the blast
//     radius;
//   - it applied no exclusion policy, so protected and manual_reconcile paths
//     counted as "will be pushed";
//   - it had no concept of a mirror, asking `clone_modules` for globs whatever
//     the clone's sync scope was;
//   - and it could not see a deletion at all.
//
// A rehearsal that does not rehearse the real thing is worse than none: it is
// a green light nobody checked. So there is one implementation now, and the
// dry run is a parameter on it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit, type RepoRef } from "./github-app.server";
import { processClone, type ClonePlan } from "./cascade-engine.server";

type SupabaseLike = SupabaseClient<Database>;

export type ImpactLevel = "green" | "yellow" | "red";

export type CloneImpact = {
  cloneId: string;
  name: string;
  level: ImpactLevel;
  /** Files the cascade would write. */
  filesChanged: number;
  /** Files it would REMOVE, having proved prime deleted them. */
  filesDeleted: number;
  /** Paths in scope for this clone — its whole tree, or its module globs. */
  filesInScope: number;
  installedModules: number;
  /** Withheld by the exclusion policy or a content hold. */
  filesHeld: number;
  /** Held paths a person is expected to reconcile by hand. */
  needsReconcile: string[];
  /** Held files this cascade would BREAK, and wiring they would be missing. */
  breaks: string[];
  /** Prime deletions this cascade would not deliver, and why. */
  deletionsWithheld: Array<{ path: string; why: string }>;
  reason: string;
};

export type DryRunResult =
  | {
      ok: true;
      cloneImpacts: CloneImpact[];
      totals: { green: number; yellow: number; red: number; totalFilesChanged: number };
      sourceSha: string;
      aiSummary: string | null;
    }
  | { ok: false; error: string };

const MAX_CLONES_TO_DRYRUN = 25;

/**
 * How much attention this clone's cascade needs.
 *
 * A breakage is RED whatever the file count: a cascade that leaves a held file
 * importing something no longer exported puts the clone's default branch in a
 * state that cannot build, and one file is enough to do it. Removals count
 * towards the size because a removal is a change — under the old scoring a
 * cascade that deleted nine files and wrote none read as "no changes".
 */
function classify(input: {
  filesChanged: number;
  filesDeleted: number;
  breaks: number;
  needsReconcile: number;
}): ImpactLevel {
  if (input.breaks > 0) return "red";
  const total = input.filesChanged + input.filesDeleted;
  if (total === 0) return input.needsReconcile > 0 ? "yellow" : "green";
  if (total > 15) return "red";
  return "yellow";
}

export async function runCascadeDryRun(
  supabase: SupabaseLike,
  opts: { cloneIds?: string[] },
): Promise<DryRunResult> {
  let octokit;
  try {
    octokit = getAppOctokit();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "GitHub App not configured" };
  }

  const { data: prime } = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (!prime) return { ok: false, error: "Prime not configured" };

  let clonesQuery = supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch, sync_scope");
  if (opts.cloneIds && opts.cloneIds.length > 0) {
    clonesQuery = clonesQuery.in("id", opts.cloneIds);
  }
  const { data: clones } = await clonesQuery;
  if (!clones || clones.length === 0) return { ok: false, error: "No clones in scope" };

  const limited = clones.slice(0, MAX_CLONES_TO_DRYRUN);

  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: prime.default_branch || "main",
  };

  let sourceSha = "";
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: primeRef.owner,
      repo: primeRef.repo,
      branch: primeRef.branch,
    });
    sourceSha = br.commit.sha;
  } catch (e) {
    return { ok: false, error: `Cannot read prime: ${e instanceof Error ? e.message : "unknown"}` };
  }

  // Installed-module counts, for the operator's reading only. Which files are
  // in scope is the ENGINE's decision now, not a second reading of these rows:
  // a mirror's scope is its whole tree whatever `clone_modules` says, and that
  // disagreement is how this page came to describe a cascade nobody would run.
  const { data: cmRows } = await supabase
    .from("clone_modules")
    .select("clone_id")
    .in(
      "clone_id",
      limited.map((c) => c.id),
    );
  const cloneToModuleCount = new Map<string, number>();
  for (const row of cmRows ?? []) {
    const id = (row as { clone_id: string }).clone_id;
    cloneToModuleCount.set(id, (cloneToModuleCount.get(id) ?? 0) + 1);
  }

  const impacts: CloneImpact[] = [];
  for (const clone of limited) {
    const modCount = cloneToModuleCount.get(clone.id) ?? 0;
    let plan: ClonePlan | null = null;
    let patchSummary = "";

    try {
      const patch = await processClone({
        octokit,
        primeRef,
        sourceSha,
        // `pr` rather than the event's mode on purpose: a dry run must never
        // take the notify branch, and mode changes nothing about WHAT the
        // cascade decides — only what it would then do with it.
        mode: "pr",
        clone,
        supabase,
        scopeFilter: null,
        dryRun: true,
        onPlan: (p) => {
          plan = p;
        },
      });
      patchSummary = patch.diff_summary ?? "";
    } catch (e) {
      // A refusal is a RESULT, not a missing row. `requireExclusions` and
      // `assertMirrorPolicy` both throw, and both are exactly what an operator
      // needs to see before firing rather than during.
      impacts.push({
        cloneId: clone.id,
        name: clone.name,
        level: "red",
        filesChanged: 0,
        filesDeleted: 0,
        filesInScope: 0,
        installedModules: modCount,
        filesHeld: 0,
        needsReconcile: [],
        breaks: [],
        deletionsWithheld: [],
        reason: `Cascade would refuse: ${e instanceof Error ? e.message : "unknown error"}`,
      });
      continue;
    }

    if (!plan) {
      // The engine returned before it decided anything — already in sync, or
      // nothing it may write. Its own words are better than a number.
      impacts.push({
        cloneId: clone.id,
        name: clone.name,
        level: "green",
        filesChanged: 0,
        filesDeleted: 0,
        filesInScope: 0,
        installedModules: modCount,
        filesHeld: 0,
        needsReconcile: [],
        breaks: [],
        deletionsWithheld: [],
        reason: patchSummary || "Nothing to cascade",
      });
      continue;
    }

    const settled: ClonePlan = plan;
    const breaks = [
      ...settled.staleHeld.map(
        (r) =>
          `${r.heldPath} imports ${r.missing.join("/")} from ${r.cascadedPath}, which this cascade no longer exports`,
      ),
      ...settled.missingHeld.map(
        (r) =>
          `${r.heldPath} is missing ${r.missing.join("/")} that upstream takes from ${r.cascadedPath}`,
      ),
    ];
    const level = classify({
      filesChanged: settled.writes.length,
      filesDeleted: settled.deletes.length,
      breaks: settled.staleHeld.length,
      needsReconcile: settled.needsReconcile.length,
    });

    const parts: string[] = [];
    if (settled.writes.length > 0) parts.push(`${settled.writes.length} file(s) would be written`);
    if (settled.deletes.length > 0) parts.push(`${settled.deletes.length} removed`);
    if (settled.needsReconcile.length > 0) {
      parts.push(`${settled.needsReconcile.length} awaiting hand-reconcile`);
    }
    if (settled.staleHeld.length > 0)
      parts.push(`${settled.staleHeld.length} held file(s) WOULD BREAK`);
    if (settled.deletionRefusal) parts.push("deletions refused");

    impacts.push({
      cloneId: clone.id,
      name: clone.name,
      level,
      filesChanged: settled.writes.length,
      filesDeleted: settled.deletes.length,
      filesInScope: settled.writes.length + settled.heldTotal,
      installedModules: modCount,
      filesHeld: settled.heldTotal,
      needsReconcile: settled.needsReconcile,
      breaks,
      deletionsWithheld: settled.deletionKept
        .filter((k) => k.reason !== "clone_owns")
        .map((k) => ({ path: k.path, why: k.why })),
      reason:
        parts.length > 0
          ? `${parts.join(" · ")} (${settled.scope})`
          : `Clone matches prime — nothing would be pushed (${settled.scope})`,
    });
  }

  const totals = impacts.reduce(
    (acc, i) => {
      acc[i.level]++;
      acc.totalFilesChanged += i.filesChanged;
      return acc;
    },
    { green: 0, yellow: 0, red: 0, totalFilesChanged: 0 },
  );

  // AI summary — best-effort. Fail open with null if no key or API errors.
  let aiSummary: string | null = null;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (apiKey && totals.totalFilesChanged > 0) {
    try {
      const top = impacts
        .filter((i) => i.level !== "green")
        .slice(0, 12)
        .map((i) => `- ${i.name}: ${i.filesChanged}/${i.filesInScope} files differ (${i.level})`)
        .join("\n");
      const prompt =
        `You are summarizing a fleet cascade dry-run for an operator. ` +
        `Be terse (<= 2 short sentences). Highlight the riskiest clones and the magnitude. ` +
        `Avoid hedging.\n\nDry-run results from prime@${sourceSha.slice(0, 7)}:\n` +
        `Total clones probed: ${impacts.length} (green ${totals.green} · yellow ${totals.yellow} · red ${totals.red}).\n` +
        `Top impacted:\n${top || "(all green)"}`;
      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: "You are a senior platform engineer. Be concise." },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (aiRes.ok) {
        const json = (await aiRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        aiSummary = json.choices?.[0]?.message?.content?.trim() ?? null;
      }
    } catch {
      // Non-fatal
    }
  }

  return { ok: true, cloneImpacts: impacts, totals, sourceSha, aiSummary };
}
