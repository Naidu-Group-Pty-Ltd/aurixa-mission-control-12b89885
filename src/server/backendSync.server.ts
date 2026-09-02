/**
 * Asking for a clone's BACKEND to catch up after code lands in its repository.
 *
 * The frontend half of this already exists and its comment says why nothing
 * else does it: "Vercel rebuilds on push by itself ONLY where its GitHub App
 * is installed on the repository. Mission Control forks clones through its own
 * App and never installs Vercel's, so on this fleet nothing else asks."
 *
 * Every word of that is true of the backend too, and nothing asked. Edge
 * functions and migrations travel in the same commit as the frontend, reach the
 * clone's default branch in the same push, and then sit there. The only thing
 * that ever looked was the clone's own `deploy-supabase-functions.yml`, which
 * needs a `SUPABASE_ACCESS_TOKEN` repository secret — and on
 * `npc-client-dashboard` all 28 runs since 19 August have ended with
 * "Edge functions changed but no SUPABASE_ACCESS_TOKEN is configured — nothing
 * was deployed." So a cascade rebuilt the frontend and left the backend on the
 * previous commit, which is worse than deploying neither: the two halves of a
 * deployment are then from different revisions and nothing says so.
 *
 * ## Why this cascades no credential
 *
 * The obvious repair is to seal the prime's `SUPABASE_ACCESS_TOKEN` into every
 * clone repository — Mission Control already cascades Actions secrets, so it is
 * a few lines. It is also the wrong shape. Supabase's own documentation:
 *
 *   "Classic tokens carry your account's full access. That means every
 *    permission, on every organization and every project you belong to today,
 *    and on every one you create or join in the future."
 *
 * That token in N clone repositories is fleet-wide database administration in N
 * places, reachable by anyone who can run a workflow in any of them — the exact
 * inversion of the isolation the cloning engine exists to provide, and the same
 * mistake as a shared Turnstile widget.
 *
 * Mission Control already holds the credential and already does both jobs:
 * `deployEdgeFunction` posts bundles to the Management API, and
 * `executeSqlMigration` replays pending migrations under a destructiveness
 * gate. Nothing needed a new capability — only something to ask.
 *
 * ## What this is not
 *
 * It is not a second deployer. It plans `remediation_runs` and the two existing
 * self-healing lanes do the work, so a cascade-driven catch-up and an
 * operator-driven repair execute through exactly one implementation.
 *
 * It never throws, for the same reason `requestRedeployAfterPush` never
 * throws: the caller is mid-loop over every clone in a cascade, and a cascade
 * that pushed code correctly must not be reported as failed because a repair
 * row could not be written.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideRemediation } from "@/lib/remediation-policy";
import { cascadeBackendWork, hasBackendWork } from "@/server/cascadeBackendWork.pure";
import type { CascadeBackendWork } from "@/server/cascadeBackendWork.pure";

const admin = supabaseAdmin;

/** A cascade catch-up is routine maintenance, never an incident. */
const CASCADE_PRIORITY = "P3" as const;

/** Statuses in which a run still has the work ahead of it. */
const OPEN_RUN_STATUSES = ["planned", "approved", "awaiting_validation", "executing"] as const;

/**
 * How much of the prime's history one comparison will describe.
 *
 * GitHub's compare endpoint caps `files` at 300 and says so in `truncated`.
 * Past that we cannot know which functions changed, and guessing narrow is the
 * failure that leaves a clone half-deployed — so a truncated comparison widens
 * to every function instead.
 */
const COMPARE_FILE_CAP = 300;

export type BackendSyncSkip =
  | "no_backend_work"
  | "no_backend_project"
  | "prime_not_configured"
  | "compare_failed"
  | "db_error";

export type BackendSyncRequest =
  | {
      requested: true;
      work: CascadeBackendWork;
      /** One entry per run planned or widened; empty when everything was already queued. */
      runs: Array<{ action: "edge_function_deploy" | "sql_migration"; outcome: string }>;
      /**
       * Whether Mission Control could tell this repository's CI who deploys
       * it. Carried out rather than swallowed: the write is best-effort, but
       * a fleet-wide permission gap must not look like nothing happening.
       */
      deployer: DeployerDeclaration;
    }
  | { requested: false; reason: BackendSyncSkip };

/**
 * Plan the backend catch-up a cascade owes a clone.
 *
 * `fromSha`/`toSha` are PRIME revisions — what the clone had before this
 * cascade and what it has now. The diff is taken on the prime rather than on
 * the clone because that is the question actually being asked: which of the
 * prime's backend files changed between the two states this clone has been in.
 * It also makes both callers identical, which is what stops the engine's path
 * and the merge drain's path drifting.
 */
export async function requestBackendSyncAfterCascade(input: {
  cloneId: string;
  /** Free text for the audit trail — "cascade #123", "cascade merge drain", … */
  reason: string;
  fromSha: string | null;
  toSha: string;
}): Promise<BackendSyncRequest> {
  // A clone with no Supabase project has nowhere to deploy INTO. Checked first
  // because it is the cheapest question and the commonest answer for a clone
  // whose backend provisioning has not finished.
  const { data: backend, error: backendErr } = await admin
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", input.cloneId)
    .maybeSingle();
  // A read that FAILED is not a row that is ABSENT — reporting a database
  // fault as "this clone has no backend" would silently stop the whole fleet
  // catching up, and nothing would say so.
  if (backendErr) return { requested: false, reason: "db_error" };
  if (!backend?.supabase_project_ref) return { requested: false, reason: "no_backend_project" };

  const work = await workForCascade(input.fromSha, input.toSha);
  if (work === "prime_not_configured" || work === "compare_failed") {
    return { requested: false, reason: work };
  }
  if (!hasBackendWork(work)) return { requested: false, reason: "no_backend_work" };

  const runs: Array<{ action: "edge_function_deploy" | "sql_migration"; outcome: string }> = [];

  if (work.staleFunctions === null || work.staleFunctions.length > 0) {
    runs.push({
      action: "edge_function_deploy",
      outcome: await planFunctionDeploy(input, work.staleFunctions, work.reasons),
    });
  }
  if (work.migrationsOwed) {
    runs.push({
      action: "sql_migration",
      outcome: await planMigrationCatchUp(input, work.reasons),
    });
  }

  // Now that Mission Control is demonstrably deploying this clone's backend,
  // say so on the repository — this is the moment the statement becomes true.
  //
  // Here rather than only at provisioning, because provisioning is the one
  // moment the clones that need it most have already passed. Every clone that
  // existed before this change would otherwise keep failing its deploy check
  // on every push until somebody opened repository settings, which is asking
  // an operator to correct this product's own bookkeeping by hand.
  //
  // Idempotent (create, then update on 409) and only on a cascade that
  // actually queued backend work, so it is neither a per-push cost nor a
  // claim made before it is warranted.
  const deployer = await declareDeployer(input.cloneId);

  return { requested: true, work, runs, deployer };
}

/**
 * Best-effort, and never the reason a queued catch-up reports as failed — but
 * never SILENT either.
 *
 * The result used to be discarded here. Measured 2 Sep 2026 on
 * `npc-client-dashboard`: this ran at 00:30:17, the variable was never set,
 * and every one of that repository's 31 deploy-workflow runs has failed. The
 * only trace was a console line. "Best-effort" has to mean the caller carries
 * on, not that nobody is told — a capability the whole fleet depends on was
 * missing and looked exactly like nothing happening.
 */
async function declareDeployer(cloneId: string): Promise<DeployerDeclaration> {
  try {
    const { data: clone } = await admin
      .from("clones")
      .select("github_owner, github_repo")
      .eq("id", cloneId)
      .maybeSingle();
    if (!clone?.github_owner || !clone?.github_repo) {
      // Not a permission problem, and it must not be reported as one: this
      // clone has no repository recorded to declare anything on.
      return { attempted: false, ok: false, error: "no GitHub repository recorded for this clone" };
    }
    const { declareMissionControlDeploysBackend } =
      await import("@/server/github-variables.server");
    const declared = await declareMissionControlDeploysBackend({
      owner: clone.github_owner,
      repo: clone.github_repo,
    });
    if (!declared.ok) {
      console.error("[backend-sync] backend-deployer variable not written:", declared.error);
      return { attempted: true, ok: false, error: declared.error };
    }
    return { attempted: true, ok: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[backend-sync] could not declare the deployer:", error);
    return { attempted: true, ok: false, error };
  }
}

/** What the declaration attempt did, so a caller can report it rather than guess. */
export type DeployerDeclaration = {
  /** False where there was nothing to declare on — not a failure to fix. */
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly error: string | null;
};

/** The prime's backend diff between two of its own revisions. */
async function workForCascade(
  fromSha: string | null,
  toSha: string,
): Promise<CascadeBackendWork | "prime_not_configured" | "compare_failed"> {
  // A clone that has never recorded a synced sha has no "before" to diff
  // against. Everything is stale by definition, and asking GitHub to compare
  // against nothing would answer with an error we would then have to guess
  // about.
  if (!fromSha) {
    return {
      staleFunctions: null,
      migrationsOwed: true,
      reasons: ["this clone had no recorded prime revision — treating every backend file as new"],
    };
  }
  if (fromSha === toSha) {
    return { staleFunctions: [], migrationsOwed: false, reasons: [] };
  }

  try {
    const { resolvePrimeSource } = await import("@/server/prime-backend.server");
    const { getAppOctokit } = await import("@/server/github-app.server");
    const source = await resolvePrimeSource(admin);
    if (!source) return "prime_not_configured";

    const res = await getAppOctokit().request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner: source.owner,
      repo: source.repo,
      basehead: `${fromSha}...${toSha}`,
    });
    const files = res.data.files ?? [];
    if (files.length >= COMPARE_FILE_CAP) {
      return {
        staleFunctions: null,
        migrationsOwed: true,
        reasons: [
          `the comparison listed ${files.length} files and GitHub caps it at ${COMPARE_FILE_CAP} — ` +
            "widened to every function rather than deploying the subset that happened to fit",
        ],
      };
    }
    return cascadeBackendWork(files.map((f) => f.filename));
  } catch (e) {
    console.error("[backend-sync] could not compare prime revisions:", e);
    return "compare_failed";
  }
}

/**
 * One open run per clone per lane.
 *
 * The drain runs every minute and a busy fleet cascades often, so inserting
 * unconditionally would pile up runs that each redeploy the same bundles. An
 * already-queued run absorbs later cascades by itself: the lane reads the
 * prime's snapshot when it EXECUTES, not when it was planned, so it deploys
 * whatever the prime holds by then.
 *
 * The one thing that does not absorb is the slug filter, which is pinned at
 * plan time — so a queued run for `a` and a new cascade touching `b` widens
 * the existing run rather than skipping `b`.
 */
async function planFunctionDeploy(
  input: { cloneId: string; reason: string; toSha: string },
  slugs: readonly string[] | null,
  reasons: readonly string[],
): Promise<string> {
  const { data: open, error } = await admin
    .from("remediation_runs")
    .select("id, plan")
    .eq("clone_id", input.cloneId)
    .eq("action_type", "edge_function_deploy")
    .in("status", [...OPEN_RUN_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return `not planned — could not read open runs: ${error.message}`;

  if (open) {
    const existing = (open.plan as { slugs?: string[] | null } | null)?.slugs ?? null;
    if (existing === null) return "already queued (that run covers every function)";
    if (slugs === null) {
      const { error: wErr } = await admin
        .from("remediation_runs")
        .update({ plan: { slugs: null, source: "cascade", reasons: [...reasons] } })
        .eq("id", open.id);
      return wErr
        ? `could not widen the open run: ${wErr.message}`
        : "widened the open run to every function";
    }
    const union = [...new Set([...existing, ...slugs])].sort();
    if (union.length === existing.length) return "already queued (that run covers these functions)";
    const { error: wErr } = await admin
      .from("remediation_runs")
      .update({ plan: { slugs: union, source: "cascade", reasons: [...reasons] } })
      .eq("id", open.id);
    return wErr
      ? `could not widen the open run: ${wErr.message}`
      : `widened the open run to ${union.length} functions`;
  }

  const decision = decideRemediation({
    actionType: "edge_function_deploy",
    priority: CASCADE_PRIORITY,
  });
  const { error: insErr } = await admin.from("remediation_runs").insert({
    ticket_id: null,
    clone_id: input.cloneId,
    action_type: "edge_function_deploy",
    priority: CASCADE_PRIORITY,
    status: decision.autoExecute ? "planned" : "awaiting_validation",
    requires_human: decision.requiresHuman,
    policy: decision,
    plan: {
      slugs: slugs === null ? null : [...slugs],
      source: "cascade",
      trigger: input.reason,
      prime_sha: input.toSha,
      reasons: [...reasons],
    },
  });
  if (insErr) return `not planned: ${insErr.message}`;
  return slugs === null ? "planned for every function" : `planned for ${slugs.length} function(s)`;
}

async function planMigrationCatchUp(
  input: { cloneId: string; reason: string; toSha: string },
  reasons: readonly string[],
): Promise<string> {
  const { data: open, error } = await admin
    .from("remediation_runs")
    .select("id")
    .eq("clone_id", input.cloneId)
    .eq("action_type", "sql_migration")
    .in("status", [...OPEN_RUN_STATUSES])
    .limit(1)
    .maybeSingle();
  if (error) return `not planned — could not read open runs: ${error.message}`;
  // Nothing to widen: `mode: "catch_up"` has no filter to miss. The lane
  // recomputes what is pending when it runs, so an open run already covers
  // migrations this cascade delivered.
  if (open) return "already queued";

  // The lane assesses every pending body immediately before applying it and
  // parks the batch on the first destructive statement — a stronger check than
  // one taken here, because the prime moves between planning and executing.
  const decision = decideRemediation({
    actionType: "sql_migration",
    priority: CASCADE_PRIORITY,
    sqlAssessedByLane: true,
  });
  const { error: insErr } = await admin.from("remediation_runs").insert({
    ticket_id: null,
    clone_id: input.cloneId,
    action_type: "sql_migration",
    priority: CASCADE_PRIORITY,
    status: decision.autoExecute ? "planned" : "awaiting_validation",
    requires_human: decision.requiresHuman,
    policy: decision,
    plan: {
      mode: "catch_up",
      source: "cascade",
      trigger: input.reason,
      prime_sha: input.toSha,
      reasons: [...reasons],
    },
  });
  return insErr ? `not planned: ${insErr.message}` : "planned";
}
