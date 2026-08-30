// Server-only core of the cascade engine. The user-facing server function in
// cascade-engine.functions.ts wraps this with auth middleware; the GitHub
// webhook receiver invokes it directly with the admin client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CHECKS_PERMISSION_REMEDY,
  checksUnreadable,
  decideCascadeMerge,
} from "./cascade/autoMergeGate.pure";
import {
  describeMissingHeldReferences,
  describeStaleHeldReferences,
  findMissingHeldReferences,
  findStaleHeldReferences,
  type MissingHeldReference,
  type StaleHeldReference,
} from "./cascade/heldFileStaleness.pure";
import {
  getAppOctokit,
  listFilesMatchingGlobs,
  listTreeEntries,
  getFileContent,
  type RepoRef,
} from "./github-app.server";
import { cascadeEventStatus, summariseCascade } from "./cascade/prReconcile.pure";
import {
  assertMirrorPolicy,
  backendIdentityHold,
  backendRefsIn,
  isShippedPath,
  partitionCascadePaths,
  reportableHeld,
  reconcileSuffixFor,
  summaryOwesReconcile,
  requireExclusions,
  type HeldPath,
  type SyncExclusion,
} from "./cascade/syncExclusions.pure";
import { isBlockedByApproval } from "./cascade-approvals.server";
import { validateClonePinsServer } from "./library-validation.server";
import { validateModuleGlobs } from "@/lib/module-globs";
import { mapWithConcurrency } from "@/lib/concurrency";

type CascadeResultUpdate = Database["public"]["Tables"]["cascade_results"]["Update"];
type SupabaseLike = SupabaseClient<Database>;

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function branchName(sourceSha: string) {
  return `aurixa/cascade-${shortSha(sourceSha)}-${Date.now().toString(36)}`;
}

export type CascadeRunResult =
  | {
      ok: true;
      status: "completed" | "failed" | "partial";
      counts: { succeeded: number; opened: number; failed: number; skipped: number; total: number };
    }
  | { ok: false; error: string };

export async function executeCascade(
  supabase: SupabaseLike,
  cascadeEventId: string,
): Promise<CascadeRunResult> {
  const [eventRes, primeRes, queuedRes] = await Promise.all([
    supabase.from("cascade_events").select("*").eq("id", cascadeEventId).single(),
    supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    supabase
      .from("cascade_results")
      .select("*, clones(*)")
      .eq("cascade_event_id", cascadeEventId)
      .eq("status", "queued"),
  ]);

  const event = eventRes.data;
  if (eventRes.error || !event) {
    return { ok: false, error: "Cascade event not found" };
  }
  if (event.status === "completed" || event.status === "failed") {
    return { ok: false, error: `Already ${event.status}` };
  }
  // Blast-radius gate — block engine if a second-operator approval is required
  // and not yet recorded. Engine will re-run via approveCascade.
  const gate = await isBlockedByApproval(supabase, cascadeEventId);
  if (gate.blocked) {
    return { ok: false, error: gate.reason ?? "Awaiting approval" };
  }
  const prime = primeRes.data;
  if (!prime) {
    return { ok: false, error: "Prime not configured — set it up in Settings first" };
  }

  let octokit;
  try {
    octokit = getAppOctokit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GitHub App not configured";
    await supabase
      .from("cascade_events")
      .update({ status: "failed", completed_at: new Date().toISOString(), summary: msg })
      .eq("id", event.id);
    return { ok: false, error: msg };
  }

  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: event.source_branch || prime.default_branch || "main",
  };
  let sourceSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: primeRef.owner,
      repo: primeRef.repo,
      branch: primeRef.branch,
    });
    sourceSha = br.commit.sha;
  } catch (e) {
    const msg = `Cannot read prime ${primeRef.owner}/${primeRef.repo}@${primeRef.branch}: ${e instanceof Error ? e.message : "unknown"}`;
    await supabase
      .from("cascade_events")
      .update({ status: "failed", completed_at: new Date().toISOString(), summary: msg })
      .eq("id", event.id);
    return { ok: false, error: msg };
  }

  await supabase
    .from("cascade_events")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      source_sha: sourceSha,
      source_branch: primeRef.branch,
    })
    .eq("id", event.id);

  let succeeded = 0;
  let failed = 0;
  let opened = 0;
  let skipped = 0;
  /** Clones this run left owing a hand-reconcile. Counted as results land. */
  let owedReconcile = 0;

  // Pre-flight: validate clone library pins. If any pin references a missing,
  // unapproved, or empty library entry, fail that clone's queued result early
  // so the cascade can't push partial/wrong file sets.
  const queuedRows = queuedRes.data ?? [];
  const cloneIds = queuedRows
    .map((r) => (r as { clones: { id: string } | null }).clones?.id)
    .filter((v): v is string => Boolean(v));
  const pinCheck = await validateClonePinsServer(supabase, cloneIds);
  const blockedClones = new Map<string, string[]>();
  if (pinCheck.ok && pinCheck.issues.length > 0) {
    for (const issue of pinCheck.issues) {
      if (issue.severity !== "error") continue;
      const list = blockedClones.get(issue.cloneId) ?? [];
      list.push(`${issue.slug}@v${issue.version}: ${issue.reason}`);
      blockedClones.set(issue.cloneId, list);
    }
  }

  for (const r of queuedRows) {
    const clone = (r as { clones: unknown }).clones as {
      id: string;
      name: string;
      github_owner: string;
      github_repo: string;
      default_branch: string;
      sync_scope: string | null;
    } | null;

    if (!clone) {
      await supabase
        .from("cascade_results")
        .update({
          status: "skipped",
          error_message: "Clone not found",
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      skipped++;
      continue;
    }

    const pinErrors = blockedClones.get(clone.id);
    if (pinErrors && pinErrors.length > 0) {
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: `Pin validation failed: ${pinErrors.join("; ")}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      failed++;
      continue;
    }

    await supabase
      .from("cascade_results")
      .update({ status: "pushing", started_at: new Date().toISOString() })
      .eq("id", r.id);

    try {
      const patch = await processClone({
        octokit,
        primeRef,
        sourceSha,
        mode: event.mode,
        clone,
        supabase,
        scopeFilter: event.scope_filter as Record<string, unknown> | null,
      });

      await supabase.from("cascade_results").update(patch).eq("id", r.id);

      // Read off the patch, not off `queuedRes.data`: those rows were fetched
      // before this loop and still carry the pre-run `diff_summary`.
      if (summaryOwesReconcile((patch as { diff_summary?: string | null }).diff_summary)) {
        owedReconcile++;
      }

      if (patch.status === "succeeded") succeeded++;
      else if (patch.status === "pr_opened") opened++;
      else if (patch.status === "failed") failed++;
      else if (patch.status === "skipped") skipped++;

      if (patch.status === "succeeded" || patch.status === "pr_opened") {
        await supabase
          .from("clones")
          .update({
            sync_status: patch.status === "succeeded" ? "in_sync" : "cascading",
            last_synced_sha: patch.status === "succeeded" ? sourceSha : undefined,
            last_cascade_at: new Date().toISOString(),
            commits_behind: patch.status === "succeeded" ? 0 : undefined,
          })
          .eq("id", clone.id);

        // Code reached the clone's default branch — rebuild what serves it.
        //
        // `succeeded` only, never `pr_opened`: a pull request is a proposal, and
        // the branch the deployment builds from does not have the change on it
        // yet. Rebuilding here would produce an identical artefact and tell an
        // operator the change had shipped.
        //
        // Vercel rebuilds on push by itself ONLY where its GitHub App is
        // installed on the repository. Mission Control forks clones through its
        // own App and never installs Vercel's, so on this fleet nothing else
        // asks. `requestRedeployAfterPush` decides whether the clone's state
        // makes a rebuild appropriate and never throws — a cascade that pushed
        // correctly must not report as failed because a hosting row could not be
        // updated.
        if (patch.status === "succeeded") {
          try {
            const { requestRedeployAfterPush } = await import("@/server/hosting/redeploy.server");
            await requestRedeployAfterPush({
              cloneId: clone.id,
              reason: `cascade ${event.id}`,
              sha: sourceSha,
            });
          } catch (e) {
            console.error("[cascade] redeploy request failed:", e);
          }
        }
      } else if (patch.status === "failed") {
        await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      }
    } catch (e) {
      failed++;
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: e instanceof Error ? e.message : String(e),
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
    }
  }

  const totalQueued = (queuedRes.data ?? []).length;
  const finalStatus = cascadeEventStatus({ succeeded, opened, failed });
  // A cascade can do everything asked of it and still leave a clone unable to
  // go green, because a `manual_reconcile` path moved upstream and was held
  // back by design. That is not a failure of the cascade and it is not a
  // success either: it is work owed to a person, and reporting it as
  // `completed · success` is what left a clone red for twelve hours with the
  // explanation sitting unread in a pull request body.
  //
  // Composed by `summariseCascade` rather than here, because the engine is no
  // longer the only writer: a pull request that lands later is reconciled by
  // `cascadeMergeDrain`, which recounts this line. Two copies of the format is
  // how "0 merged" and "1 merged" come to be rendered in two different shapes.
  const summary = summariseCascade({
    succeeded,
    opened,
    failed,
    skipped,
    total: totalQueued,
    owedReconcile,
  });

  await supabase
    .from("cascade_events")
    .update({ status: finalStatus, completed_at: new Date().toISOString(), summary })
    .eq("id", event.id);

  // Through the helper rather than a bare insert: it checks the error and logs
  // it. A discarded audit write is a record that silently does not exist.
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: "cascade.executed",
    entityType: "cascade_event",
    entityId: event.id,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped, owedReconcile },
  });

  const kind =
    finalStatus === "completed"
      ? "cascade_completed"
      : finalStatus === "failed"
        ? "cascade_failed"
        : "cascade_partial";
  // `finalStatus` is deliberately untouched — the run did complete, and
  // collapsing "owes a human" into "failed" would make the two unreadable.
  // Severity is the attention channel, so that is what changes.
  const severity =
    finalStatus === "failed"
      ? "error"
      : finalStatus === "completed" && owedReconcile === 0
        ? "success"
        : "warning";

  // Not `notifyOperators()`: that helper has no `cascade_event_id`, and the
  // link from a notification back to its run is the whole point of this one.
  // So the error is checked here instead, the same way the helper checks it.
  const { error: notifyError } = await supabase.from("notifications").insert({
    kind,
    severity,
    title: `Cascade ${finalStatus} (${event.mode})`,
    body: summary,
    cascade_event_id: event.id,
    url: `/cascades/${event.id}`,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped, owedReconcile },
  });
  if (notifyError) {
    console.error(`[cascade] could not raise the ${kind} notification:`, notifyError.message);
  }

  type NotifInsert = Database["public"]["Tables"]["notifications"]["Insert"];
  const cloneNotifs: NotifInsert[] = [];
  for (const r of queuedRes.data ?? []) {
    const clone = (r as { clones: { id: string; name: string } | null }).clones;
    if (!clone) continue;
    cloneNotifs.push({
      kind,
      severity,
      title: `${clone.name} · ${event.mode.replace("_", " ")}`,
      body: summary,
      clone_id: clone.id,
      cascade_event_id: event.id,
      url: `/cascades/${event.id}`,
      metadata: { mode: event.mode },
    });
  }
  if (cloneNotifs.length > 0) {
    await supabase.from("notifications").insert(cloneNotifs);
  }

  return {
    ok: true,
    status: finalStatus,
    counts: { succeeded, opened, failed, skipped, total: totalQueued },
  };
}

async function processClone(args: {
  octokit: ReturnType<typeof getAppOctokit>;
  primeRef: RepoRef;
  sourceSha: string;
  mode: Database["public"]["Enums"]["cascade_mode"];
  clone: {
    id: string;
    name: string;
    github_owner: string;
    github_repo: string;
    default_branch: string;
    sync_scope: string | null;
  };
  supabase: SupabaseLike;
  scopeFilter: Record<string, unknown> | null;
}): Promise<CascadeResultUpdate> {
  const { octokit, primeRef, sourceSha, mode, clone, supabase, scopeFilter } = args;

  const isMirror = clone.sync_scope === "mirror";

  // Read what this clone is allowed to receive BEFORE deciding anything else.
  //
  // Fail-closed by construction: `requireExclusions` throws when the query
  // errored or returned nothing at all, and `processClone`'s caller records the
  // throw as a failed cascade_result. A cascade that ran without its guard
  // rails cannot be undone by noticing afterwards -- see the module header.
  const exclusionRes = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", clone.id);
  const exclusions = requireExclusions(
    clone.id,
    exclusionRes.data as SyncExclusion[] | null,
    exclusionRes.error,
  );
  if (isMirror) assertMirrorPolicy(clone.id, exclusions);

  // This clone's own Supabase project, for `backendIdentityHold` below.
  //
  // Read through the safe view, and read leniently on purpose: a clone with no
  // registered backend is an ordinary state (nothing has been provisioned yet),
  // and it must not stop a cascade. What it does is make every project ref
  // unresolvable rather than benign — see that function's header. So a missing
  // row and a failed read land in the same place, which is the strict one.
  const backendRes = await supabase
    .from("clone_backends_safe")
    .select("supabase_project_ref")
    .eq("clone_id", clone.id)
    .maybeSingle();
  const ownProjectRef =
    (backendRes.data as { supabase_project_ref: string | null } | null)?.supabase_project_ref ??
    null;

  // Module-sync cascades pin the file_globs to a single module so the push
  // only touches that module's files, not every installed module on the clone.
  // Always run overrides through validateModuleGlobs — the pinning caller
  // could hand us anything (module row, dry-run payload, webhook body).
  const rawOverride = Array.isArray(scopeFilter?.module_globs)
    ? (scopeFilter!.module_globs as unknown[]).filter((g): g is string => typeof g === "string")
    : null;
  const overrideGlobs = rawOverride ? validateModuleGlobs(rawOverride).valid : null;
  if (rawOverride && overrideGlobs && overrideGlobs.length !== rawOverride.length) {
    console.warn(
      `[cascade] dropped ${rawOverride.length - overrideGlobs.length} unsafe override glob(s) for clone ${clone.id}`,
    );
  }

  let installedGlobs: string[];
  let pinSummary: string | null = null;
  if (overrideGlobs && overrideGlobs.length > 0) {
    installedGlobs = overrideGlobs;
  } else {
    const { data: cmods } = await supabase
      .from("clone_modules")
      .select("modules(slug, file_globs)")
      .eq("clone_id", clone.id);

    // Library pins: when a clone pins a specific library version for a module
    // slug, swap that module's live globs for the pinned entry's file_paths.
    // This lets a fork stay on v3 of "checkout" while the prime is on v5.
    const { data: pins } = await supabase
      .from("clone_library_pins")
      .select("slug, version, library_entry_id")
      .eq("clone_id", clone.id);

    const pinRows = (pins ?? []) as Array<{
      slug: string;
      version: number;
      library_entry_id: string;
    }>;

    const pinMap = new Map<string, { version: number; files: string[] }>();
    if (pinRows.length > 0) {
      const entryIds = pinRows.map((p) => p.library_entry_id);
      const { data: entries } = await supabase
        .from("module_library")
        .select("id, file_paths")
        .in("id", entryIds);
      const fileMap = new Map<string, string[]>();
      for (const e of (entries ?? []) as Array<{ id: string; file_paths: string[] | null }>) {
        fileMap.set(e.id, e.file_paths ?? []);
      }
      for (const p of pinRows) {
        const files = fileMap.get(p.library_entry_id) ?? [];
        if (files.length > 0) pinMap.set(p.slug, { version: p.version, files });
      }
    }

    const honored: string[] = [];
    installedGlobs = (cmods ?? []).flatMap(
      (cm: { modules: { slug: string | null; file_globs: string[] | null } | null }) => {
        const slug = cm.modules?.slug ?? null;
        if (slug && pinMap.has(slug)) {
          const pin = pinMap.get(slug)!;
          honored.push(`${slug}@v${pin.version}`);
          return pin.files;
        }
        return cm.modules?.file_globs ?? [];
      },
    );
    if (honored.length > 0) {
      pinSummary = `pins: ${honored.join(", ")}`;
    }
  }

  if (!isMirror && installedGlobs.length === 0) {
    return {
      status: "skipped",
      diff_summary: "No installed modules — nothing to cascade",
      completed_at: new Date().toISOString(),
    };
  }

  const cloneRef: RepoRef = {
    owner: clone.github_owner,
    repo: clone.github_repo,
    branch: clone.default_branch || "main",
  };

  let cloneBranchSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      branch: cloneRef.branch,
    });
    cloneBranchSha = br.commit.sha;
  } catch (e) {
    throw new Error(
      `Clone ${cloneRef.owner}/${cloneRef.repo}@${cloneRef.branch} unreachable: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  // ── Which paths are candidates ────────────────────────────────────────────
  //
  // A module-scoped clone asks the globs of what it installed. A MIRROR asks
  // git: two recursive tree reads, and a path is a candidate when prime's blob
  // SHA differs from the clone's or the clone has no such blob. Content is then
  // fetched only for those, which is what makes a whole-tree cascade affordable
  // (see `listTreeEntries`).
  //
  // Neither scope ever DELETES. A path present in the clone and absent from
  // prime is left alone: the clone legitimately carries files of its own -- its
  // isolation spec, its transfer scripts -- and a mirror that pruned them would
  // remove the very things that make it a clone rather than a copy. Prime-side
  // deletions are counted and named, never acted on.
  let candidatePaths: string[];
  let scopeLabel: string;
  let onlyInClone = 0;
  if (isMirror) {
    const [primeTree, cloneTree] = await Promise.all([
      listTreeEntries(octokit, primeRef),
      listTreeEntries(octokit, cloneRef),
    ]);
    // A truncated tree read as complete looks exactly like a clone that is
    // already in sync, which is the most expensive way for this to be wrong.
    if (primeTree.truncated || cloneTree.truncated) {
      throw new Error(
        `Tree listing truncated (prime=${primeTree.truncated}, clone=${cloneTree.truncated}); ` +
          `refusing to cascade a partial mirror`,
      );
    }
    candidatePaths = [];
    for (const [path, sha] of primeTree.entries) {
      if (cloneTree.entries.get(path) !== sha) candidatePaths.push(path);
    }
    for (const path of cloneTree.entries.keys()) {
      if (!primeTree.entries.has(path)) onlyInClone++;
    }
    scopeLabel = "mirror";
  } else {
    candidatePaths = await listFilesMatchingGlobs(octokit, primeRef, installedGlobs);
    scopeLabel = "installed modules";
  }

  // The guard rail. Applied in BOTH scopes: a module glob that grows to cover
  // `src/integrations/**` would otherwise reach the clone's backend identity
  // by a different route than the one this was written for.
  const partition = partitionCascadePaths(candidatePaths, exclusions);
  const primeFiles = partition.write;
  const needsReconcile = reportableHeld(partition.held);

  if (mode === "notify") {
    const body =
      `### Aurixa cascade — drift notice\n\n` +
      `Prime \`${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}\` ` +
      `has **${primeFiles.length}** file(s) in your installed modules that may be behind.\n\n` +
      `_No commits were made. This is notify-only mode._\n\n` +
      `Files in scope:\n${primeFiles
        .slice(0, 20)
        .map((p) => `- \`${p}\``)
        .join("\n")}` +
      (primeFiles.length > 20 ? `\n\n…and ${primeFiles.length - 20} more.` : "");
    const { data: issue } = await octokit.issues.create({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      title: `Aurixa drift notice · prime@${shortSha(sourceSha)} (${primeFiles.length} files)`,
      body,
      labels: ["aurixa", "drift-notice"],
    });
    return {
      status: "succeeded",
      diff_summary: `Drift issue #${issue.number} opened (${primeFiles.length} files in scope)`,
      pr_url: issue.html_url,
      files_changed: primeFiles.length,
      completed_at: new Date().toISOString(),
    };
  }

  const treeEntries: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];

  // Bounded concurrency, and this is the difference between a cascade that
  // finishes and one that does not exist.
  //
  // The first mirror run measured 71 candidate paths, each needing a content
  // read and a blob create -- ~144 sequential round-trips. Run one at a time
  // that overruns the 60-second `timeout_milliseconds` on the pg_cron
  // `net.http_post` that drives the scheduled path, and outlives the isolate on
  // the webhook path. Both were observed: three cascade_events sat in `running`
  // with their results at `pushing`, `net._http_response` recorded
  // `timed_out = true` at exactly 60,000 ms, and no branch was ever created on
  // the clone. Nothing reported a failure, because nothing got far enough to.
  //
  // Eight at a time is chosen against GitHub's secondary rate limits rather
  // than for maximum speed: the work is IO, not CPU, and the same 144 calls
  // finish inside the budget with room to spare.
  type Prepared =
    | {
        kind: "blob";
        path: string;
        mode: "100644";
        type: "blob";
        sha: string;
        /**
         * The text this cascade delivers, kept only for source modules so
         * `findStaleHeldReferences` can read the exports it is about to
         * remove. Held to the same paths the check can act on, so a cascade of
         * images or lockfiles carries nothing extra.
         */
        content: string | null;
      }
    | { kind: "held"; held: HeldPath };

  const prepared = await mapWithConcurrency<string, Prepared | null>(
    primeFiles,
    8,
    async (path) => {
      const primeFile = await getFileContent(octokit, primeRef, path);
      if (!primeFile) return null;

      // A mirror already knows this path differs -- the blob SHAs said so -- and
      // re-reading the clone's copy to confirm it would double the request count
      // of the one scope that cannot afford it.
      let cloneFile = null as Awaited<ReturnType<typeof getFileContent>> | null;
      let cloneFileRead = false;
      if (!isMirror) {
        cloneFile = await getFileContent(octokit, cloneRef, path);
        cloneFileRead = true;
        if (cloneFile && cloneFile.content === primeFile.content) return null;
      }

      // The content rule. Path exclusions protect what somebody remembered to
      // list; this protects the property itself.
      //
      // Cheap by construction. The clone's copy is only fetched when prime's
      // content actually names a Supabase project inside a path this clone
      // ships -- one file out of 71 on the first mirror run -- so the extra
      // read costs nothing on the paths that are not about identity, which is
      // nearly all of them.
      if (
        isShippedPath(path) &&
        backendRefsIn(primeFile.content).some((r) => r !== ownProjectRef)
      ) {
        if (!cloneFileRead) {
          cloneFile = await getFileContent(octokit, cloneRef, path);
          cloneFileRead = true;
        }
        const hold = backendIdentityHold({
          path,
          primeContent: primeFile.content,
          cloneContent: cloneFile ? cloneFile.content : null,
          ownRef: ownProjectRef,
        });
        if (hold) return { kind: "held", held: hold };
      }

      const { data: blob } = await octokit.git.createBlob({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        content: Buffer.from(primeFile.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      return {
        kind: "blob",
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
        content: /\.[cm]?tsx?$/.test(path) ? primeFile.content : null,
      };
    },
  );
  const deliveredSource: Record<string, string> = {};
  for (const entry of prepared) {
    if (!entry) continue;
    if (entry.kind === "held") {
      // Recorded in the same partition the path rules feed, so a content hold
      // reaches the pull request body, the withheld count and the "nothing to
      // cascade" reason by exactly the route a listed path does.
      partition.held.push(entry.held);
      needsReconcile.push(entry.held);
      continue;
    }
    treeEntries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
    if (entry.content !== null) deliveredSource[entry.path] = entry.content;
  }

  if (treeEntries.length === 0) {
    // "Nothing to write" and "nothing differed" are different states, and the
    // second one is the one an operator can safely ignore. A mirror whose only
    // differences were all withheld must not report as in sync.
    //
    // The test is `held > 0`, not `write.length === 0`. A content hold
    // (`backendIdentityHold`) is decided while the blob is being prepared, so
    // its path is still in `partition.write` — it passed the path rules — and
    // keying on that count would report a cascade that withheld every one of
    // its files as "already in sync". We are inside `treeEntries.length === 0`,
    // so nothing was written by definition; anything withheld therefore
    // accounts for every path that reached a decision.
    const why =
      partition.held.length > 0
        ? `Nothing to cascade: all ${partition.held.length} differing path(s) are withheld by this clone's exclusion policy`
        : `Already in sync with prime@${shortSha(sourceSha)}`;
    return {
      status: "skipped",
      diff_summary: why,
      files_changed: 0,
      completed_at: new Date().toISOString(),
    };
  }

  // Does this cascade break a file it is not allowed to touch?
  //
  // A `manual_reconcile` path is held because the clone's copy must win. That
  // hold cannot notice that a file the cascade DID deliver removed a symbol the
  // held file still imports — which is exactly how prime@909417c put
  // `src/App.tsx` on this clone's `main` importing an `AmlIntakeQueue` that
  // `AmlShellPages.tsx` had stopped exporting, failing every Vercel deployment
  // while the cascade reported the same "1 awaiting manual reconcile" it
  // reports on every healthy run.
  //
  // Only the clone's copy of the reportable held paths is read, and only when
  // this cascade actually delivers TypeScript — a handful of files on the runs
  // that can break this way, and no request at all on the ones that cannot.
  let staleHeld: StaleHeldReference[] = [];
  let missingHeld: MissingHeldReference[] = [];
  const heldSourcePaths = needsReconcile
    .map((h) => h.path)
    .filter((path) => /\.[cm]?tsx?$/.test(path));
  if (heldSourcePaths.length > 0 && Object.keys(deliveredSource).length > 0) {
    const heldFiles: Record<string, string> = {};
    const heldFilesPrime: Record<string, string> = {};
    await Promise.all(
      heldSourcePaths.flatMap((path) => [
        // A read that fails is not a file with no imports. Skipping it loses a
        // warning; inventing an empty one would claim the cascade is safe.
        (async () => {
          try {
            const f = await getFileContent(octokit, cloneRef, path);
            if (f) heldFiles[path] = f.content;
          } catch {
            /* leave it out — see above */
          }
        })(),
        // The prime's copy of the same path: the one the cascade DECLINED to
        // write. Comparing the two in general is meaningless — they differ on
        // purpose, which is what "held" means — but comparing what each imports
        // from a module this run is delivering is not.
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
    staleHeld = findStaleHeldReferences({ heldFiles, cascadedFiles: deliveredSource });
    missingHeld = findMissingHeldReferences({
      heldFilesClone: heldFiles,
      heldFilesPrime,
      cascadedFiles: deliveredSource,
    });
  }
  const missingSuffix =
    missingHeld.length > 0
      ? ` · ${missingHeld.length} held file(s) MISSING new wiring: ${missingHeld
          .map((r) => `${r.heldPath} needs ${r.missing.join("/")}`)
          .join("; ")}`
      : "";
  const staleSuffix =
    staleHeld.length > 0
      ? ` · BREAKS ${staleHeld.length} held file(s): ${staleHeld
          .map((r) => `${r.heldPath} needs ${r.missing.join("/")}`)
          .join("; ")}`
      : "";

  // Build the "diff_summary" — first 5 file paths + count of remainder.
  // If any library pins were honored, surface that in the summary too.
  const summaryFiles = treeEntries.slice(0, 5).map((t) => t.path);
  const summarySuffix = treeEntries.length > 5 ? ` (+${treeEntries.length - 5} more)` : "";
  const pinSuffix = pinSummary ? ` · ${pinSummary}` : "";
  const heldSuffix = partition.held.length > 0 ? ` · ${partition.held.length} withheld` : "";
  const reconcileSuffix = reconcileSuffixFor(needsReconcile.length);
  const fileSummary = `${summaryFiles.join(", ")}${summarySuffix}${pinSuffix}${heldSuffix}${reconcileSuffix}${staleSuffix}${missingSuffix}`;

  const { data: cloneCommit } = await octokit.git.getCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    commit_sha: cloneBranchSha,
  });
  const { data: newTree } = await octokit.git.createTree({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    base_tree: cloneCommit.tree.sha,
    tree: treeEntries,
  });

  const message =
    `chore(aurixa): cascade ${treeEntries.length} file(s) from prime@${shortSha(sourceSha)}\n\n` +
    treeEntries.map((t) => `- ${t.path}`).join("\n");

  // What the pull request has to say beyond the file list. `manual_reconcile`
  // paths are the reason this section exists: withholding them silently is how
  // a clone stops learning about new routes without anyone noticing.
  const cascadeBody = (lead: string) =>
    lead +
    `\n\nScope: **${scopeLabel}**.\n\n` +
    `Files synchronized:\n\n` +
    treeEntries.map((t) => `- \`${t.path}\``).join("\n") +
    (staleHeld.length > 0
      ? `\n\n### ⚠ This cascade breaks a held file\n\n` +
        `A file this cascade delivers no longer exports something a withheld file still imports. ` +
        `Merging this as-is puts the clone's default branch in a state that cannot build — ` +
        `the bundler fails with "is not exported by", not a test.\n\n` +
        describeStaleHeldReferences(staleHeld)
          .map((l) => `- ${l}`)
          .join("\n") +
        `\n\nRepair the held file in the same merge, or carry the removal across by hand.`
      : "") +
    (missingHeld.length > 0
      ? `\n\n### ⚠ A held file is missing wiring this cascade delivered\n\n` +
        `Upstream uses something from a file this cascade DID deliver, and this clone's ` +
        `held copy does not. Nothing fails the build — the routes or components are simply ` +
        `absent here, and stay absent until somebody brings them across.\n\n` +
        describeMissingHeldReferences(missingHeld)
          .map((l) => `- ${l}`)
          .join("\n") +
        `\n\nAdd the import and its use to the held file in the same merge.`
      : "") +
    (needsReconcile.length > 0
      ? `\n\n### Needs a human — ${needsReconcile.length} file(s) changed upstream and were held back\n\n` +
        `These carry deliberate divergence on this clone, so the cascade will never overwrite them. ` +
        `Prime has moved; someone has to decide what to carry across.\n\n` +
        needsReconcile.map((h) => `- \`${h.path}\`${h.note ? ` — ${h.note}` : ""}`).join("\n")
      : "") +
    (partition.held.length - needsReconcile.length > 0
      ? `\n\n_${partition.held.length - needsReconcile.length} further path(s) are owned by this clone and were withheld without comment._`
      : "") +
    (onlyInClone > 0
      ? `\n\n_${onlyInClone} path(s) exist only in this clone. Nothing was deleted — a cascade never removes files._`
      : "");

  const { data: newCommit } = await octokit.git.createCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    message,
    tree: newTree.sha,
    parents: [cloneBranchSha],
  });

  // === One open cascade proposal per clone, in EVERY mode ===
  //
  // Opening a fresh pull request every time is what the first live run
  // actually did: prime merged eight pull requests in the minutes it took a
  // fix to deploy, eight cascades queued, and every one of them opened its own
  // pull request carrying THE SAME 57 files — #27 through #34 on the clone.
  //
  // That was fixed for `pr` mode and NOT for `auto_merge`, on the reasoning
  // that under auto-merge "the first will win and the rest will skip". It does
  // not, because auto-merge does not merge on the spot — it waits for checks
  // that take about seventeen minutes, and prime moves faster than that. On
  // 30 Aug 2026 three prime commits inside thirty-one minutes produced #67,
  // #68 and #69, all open together, all carrying overlapping trees cut from a
  // common ancestor. #67 merged; the other two were left proposing changes to
  // the same files, so at least one of them could only ever land as a conflict.
  //
  // So the rule is the one Dependabot has, and it belongs to both modes:
  //
  //   same tree  -> nothing new to say; report the pull request that already
  //                 says it, and open nothing.
  //   new tree   -> move that pull request's branch to the new commit. The
  //                 commit's parent is the clone's current default branch, so
  //                 the diff stays honest.
  //   none open  -> open one.
  //
  // Failing to LIST is not failing to find: if the lookup errors we fall
  // through to opening a new pull request, because a duplicate is a tidiness
  // problem and a cascade that silently did not propose anything is not.
  const intro =
    mode === "auto_merge"
      ? "Auto-merge: this lands on green and waits otherwise."
      : `Automated cascade from **${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}**.`;
  const title = `Aurixa cascade · prime@${shortSha(sourceSha)} → ${treeEntries.length} file(s)`;

  const existing = await findOpenCascadePr(octokit, cloneRef);
  let proposal: { number: number; url: string; nodeId: string | null; headSha: string } | null = null;

  if (existing) {
    let existingTreeSha: string | null = null;
    try {
      const { data: headCommit } = await octokit.git.getCommit({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        commit_sha: existing.headSha,
      });
      existingTreeSha = headCommit.tree.sha;
    } catch {
      existingTreeSha = null;
    }

    if (existingTreeSha && existingTreeSha === newTree.sha) {
      // Nothing new to propose. The open pull request already carries this
      // exact tree, and the merge drain is what lands it once checks pass.
      return {
        status: "skipped",
        pr_url: existing.url,
        diff_summary: `Already proposed — PR #${existing.number} carries this exact tree (${treeEntries.length} file(s))`,
        files_changed: treeEntries.length,
        completed_at: new Date().toISOString(),
      };
    }

    try {
      await octokit.git.updateRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: `heads/${existing.branch}`,
        sha: newCommit.sha,
        // Its only writer is this engine, and the new commit sits on the
        // clone's current default branch rather than on the old proposal.
        force: true,
      });
      const { data: updated } = await octokit.pulls.update({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        pull_number: existing.number,
        title,
        body: cascadeBody(
          `${intro}\n\n` +
            `_This pull request was updated in place rather than replaced, so one proposal tracks prime._`,
        ),
      });
      proposal = {
        number: existing.number,
        url: existing.url,
        nodeId: updated.node_id ?? null,
        headSha: newCommit.sha,
      };
    } catch {
      // Branch deleted under an open pull request, or a race. Fall through and
      // open a fresh one.
      proposal = null;
    }
  }

  if (!proposal) {
    const branch = branchName(sourceSha);
    try {
      await octokit.git.createRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: `refs/heads/${branch}`,
        sha: newCommit.sha,
      });
      const { data: pr } = await octokit.pulls.create({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        title,
        head: branch,
        base: cloneRef.branch,
        body: cascadeBody(intro),
      });
      proposal = {
        number: pr.number,
        url: pr.html_url,
        nodeId: pr.node_id ?? null,
        headSha: newCommit.sha,
      };
    } catch (prErr) {
      return {
        status: "failed",
        diff_summary: `Could not open a cascade pull request: ${fileSummary}`,
        files_changed: treeEntries.length,
        error_message: prErr instanceof Error ? prErr.message : "unknown",
        completed_at: new Date().toISOString(),
      };
    }
  }

  // The summary a result carries is written ONCE and read for as long as the
  // row exists, so it holds only what stays true: which pull request, and what
  // it carries. Why it has not merged yet is a fact about this minute, and
  // `cascadeMergeDrain` owns it — writing it here is what left rows reading
  // "No check has reported on this pull request" long after every check had.
  const durableSummary = `PR #${proposal.number} ${existing ? "updated" : "opened"}: ${fileSummary}`;

  // === auto_merge: always through a pull request, never past its checks ===
  //
  // This used to try `git.updateRef` first — a direct fast-forward push to the
  // clone's default branch, with no pull request and no checks — and only fell
  // back to a pull request when branch protection REFUSED the push. Every clone
  // in this fleet has an unprotected `main`, so that push always succeeded and
  // CI was never consulted at all.
  //
  // The comment that used to live here already said what that meant: protection
  // was doing the work this function thought it was doing itself, and where
  // protection is absent it merged a tree nothing had built. It named the day
  // it bit, 26 Aug 2026 — a cascade carrying a package.json/package-lock.json
  // pair that fails `npm ci`, six of eight checks red, a clone's `main` unable
  // to install or deploy. Then it went on to call `pulls.merge` immediately
  // whenever GitHub auto-merge could not be armed, which is the same hole one
  // level down.
  //
  // Both are gone. `decideCascadeMerge` reads the pull request's own check runs
  // and an unattended cascade merges only on green.
  if (mode === "auto_merge") {
    // Preferred: let GitHub hold it and merge the moment checks pass. That is
    // race-free in a way polling cannot be — it cannot merge a head that a
    // later push has replaced.
    //
    // `MERGE`, never `SQUASH`. A squash rewrites the cascade commit that names
    // the prime SHA it came from, which is the one durable record of what a
    // clone has received.
    if (proposal.nodeId) {
      try {
        await octokit.graphql(
          `mutation($id: ID!) {
             enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) {
               pullRequest { autoMergeRequest { enabledAt } }
             }
           }`,
          { id: proposal.nodeId },
        );
        return {
          status: "pr_opened",
          pr_url: proposal.url,
          commit_sha: newCommit.sha.slice(0, 7),
          diff_summary: durableSummary,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
        };
      } catch {
        // Auto-merge is a repository setting and GitHub refuses to arm it on a
        // pull request with nothing to wait for. Falling through does NOT mean
        // merging blind — it means reading the checks ourselves.
      }
    }

    let checkData: {
      check_runs?: Array<{ name: string; status: string; conclusion: string | null }>;
    };
    try {
      ({ data: checkData } = await octokit.checks.listForRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: proposal.headSha,
      }));
    } catch (e) {
      // A missing `checks: read` permission is not a broken cascade. The pull
      // request is open and correct; what is missing is the signal that would
      // let it merge unattended, and the drain will say so on its next pass.
      if (checksUnreadable(e)) {
        return {
          status: "pr_opened",
          pr_url: proposal.url,
          commit_sha: newCommit.sha.slice(0, 7),
          diff_summary: durableSummary,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
        };
      }
      throw e;
    }
    const verdict = decideCascadeMerge(
      (checkData.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      })),
    );

    if (verdict.merge) {
      try {
        const { data: merged } = await octokit.pulls.merge({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          pull_number: proposal.number,
          merge_method: "merge",
          commit_title: `Aurixa cascade prime@${shortSha(sourceSha)} (#${proposal.number})`,
        });
        return {
          status: "succeeded",
          commit_sha: merged.sha?.slice(0, 7) ?? null,
          pr_url: proposal.url,
          diff_summary: `Merged as ${merged.sha?.slice(0, 7) ?? "?"}. ${durableSummary}`,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
        };
      } catch (mergeErr) {
        // Green and unmergeable is a real state — a conflict, or a head that
        // moved under us. The proposal stands and the drain will try again.
        console.error("[cascade] merge on green failed:", mergeErr);
      }
    }
    // Left open on purpose. A cascade that cannot land is a fact an operator
    // needs; one that lands anyway is the defect this block exists to remove.
  }

  return {
    status: "pr_opened",
    pr_url: proposal.url,
    commit_sha: newCommit.sha.slice(0, 7),
    diff_summary: durableSummary,
    files_changed: treeEntries.length,
    completed_at: new Date().toISOString(),
  };
}

/**
 * The clone's open cascade proposal, if it has one.
 *
 * Identified by the branch name this engine gives its own branches
 * (`aurixa/cascade-…`) rather than by author, because the pull request is
 * opened by whichever GitHub App installation is configured and that is not a
 * stable identity to match on.
 *
 * The OLDEST is chosen when several are open. That is the one a reviewer is
 * most likely already looking at, and after the duplicate storm there were
 * eight; picking the newest would have kept abandoning the one with the
 * comments on it.
 */
async function findOpenCascadePr(
  octokit: ReturnType<typeof getAppOctokit>,
  cloneRef: RepoRef,
): Promise<{ number: number; url: string; branch: string; headSha: string } | null> {
  try {
    const { data: open } = await octokit.pulls.list({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      base: cloneRef.branch,
      state: "open",
      sort: "created",
      direction: "asc",
      per_page: 100,
    });
    const mine = open.find((p) => (p.head?.ref ?? "").startsWith("aurixa/cascade-"));
    if (!mine) return null;
    return {
      number: mine.number,
      url: mine.html_url,
      branch: mine.head.ref,
      headSha: mine.head.sha,
    };
  } catch {
    return null;
  }
}
