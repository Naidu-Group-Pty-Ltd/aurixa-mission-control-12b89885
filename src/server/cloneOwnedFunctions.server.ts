/**
 * Deploy the edge functions a clone carries and the prime does not, from the
 * clone's OWN repository — the lane `clone_backends.clone_owned_functions`
 * records.
 *
 * The rules are `cloneOwnedFunctions.pure.ts`'; this is the I/O around them.
 * Three callers:
 *
 *  - **provisioning**, right after the clone's repository has been re-pointed
 *    at its new project, so a clone created under the CRM-independent parent
 *    comes up with its `crm-*` functions rather than a front end calling
 *    three functions its project does not have;
 *  - **the half-hourly backend catch-up**, through
 *    `sweepCloneOwnedFunctionsFromFleet`, which redeploys only when the files
 *    those functions are built from changed, or one went missing, or its last
 *    deploy failed;
 *  - **a CRM conversion**, which changes what a clone owns.
 *
 * ## What it will not do
 *
 * - **Deploy a function the prime declares.** That one is the prime's lane's,
 *   whatever the clone's copy says.
 * - **Act without knowing the prime's list.** An unread prime list makes every
 *   function the clone declares look like its own; the lane refuses rather
 *   than deploying four hundred functions from a clone's copy.
 * - **Touch the prime's project.** A clone row naming the prime's project is a
 *   misconfiguration, and the answer to it is not a deploy.
 * - **Delete anything.** A function the clone no longer declares is recorded
 *   as retired. Taking functions off a project is a conversion's own act.
 * - **Fail its caller.** Every refusal is returned, named. Provisioning goes
 *   on to `ready`; the sweep goes on to the next clone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { getAppOctokit } from "./github-app.server";
import {
  assembleFunctionBundles,
  fetchDeclaredEdgeFunctionSlugs,
  planFunctionBundles,
  readRepoFunctionTree,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { deployEdgeFunctions, readProjectEdgeFunctionSlugs } from "./backend-provisioning.server";
import {
  decideOwnedDeploy,
  nextOwnedRecord,
  ownedFunctionSlugs,
  ownedFunctionsDigest,
  ownedRecordDue,
  readOwnedRecord,
  type OwnedFunctionResult,
} from "./cloneOwnedFunctions.pure";

type Db = SupabaseClient<Database>;
type Octokit = ReturnType<typeof getAppOctokit>;

/** The migration that adds the record's column. Named in the refusal that reports it missing. */
const RECORD_MIGRATION = "20260928100000_clone_crm_mode";

export type CloneOwnedFunctionsOutcome = {
  cloneId: string;
  act: "refused" | "none" | "skip" | "deployed";
  why: string;
  /** Slugs the clone owns; empty when the lane refused before reading them. */
  owned: string[];
  /** Deployed and accepted by the project this pass. */
  deployed: string[];
  /** Attempted this pass and refused, each with its reason. */
  failed: Array<{ slug: string; error: string }>;
  /** Owned once, no longer declared, still live on the project. */
  retired: string[];
  /** Whether this pass wrote `clone_owned_functions`. */
  recorded: boolean;
  /** Why the record was not written when it was due; absent when it was, or was not due. */
  recordRefused?: string;
};

function outcome(
  cloneId: string,
  act: CloneOwnedFunctionsOutcome["act"],
  why: string,
  rest: Partial<CloneOwnedFunctionsOutcome> = {},
): CloneOwnedFunctionsOutcome {
  return {
    cloneId,
    act,
    why,
    owned: [],
    deployed: [],
    failed: [],
    retired: [],
    recorded: false,
    ...rest,
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A write refused because the column is not there yet — PostgREST or Postgres spelling. */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    /clone_owned_functions/.test(error.message ?? "")
  );
}

/**
 * One clone, one pass. Never throws: a refusal is an outcome.
 */
export async function deployCloneOwnedFunctions(args: {
  supabase: Db;
  octokit: Octokit;
  cloneId: string;
  /**
   * The prime's declared slugs, when the caller already holds them — the
   * provisioning snapshot does, and a fleet sweep reads them once. Read here
   * otherwise.
   */
  primeDeclaredSlugs?: readonly string[] | null;
  /** The project to deploy to, when the backend row does not name it yet. */
  projectRef?: string | null;
  /** Deploy every owned function whatever the record says. */
  force?: boolean;
  now?: () => Date;
}): Promise<CloneOwnedFunctionsOutcome> {
  const { supabase, octokit, cloneId } = args;
  const now = (args.now ?? (() => new Date()))();
  try {
    // ── The clone and its project ──
    // `select("*")`, because a deployment the migration has not reached has no
    // `clone_owned_functions` column, and naming it would fail the whole read.
    const { data: clone, error: cloneErr } = await supabase
      .from("clones")
      .select("*")
      .eq("id", cloneId)
      .maybeSingle();
    if (cloneErr)
      return outcome(cloneId, "refused", `could not read the clone: ${cloneErr.message}`);
    if (!clone) return outcome(cloneId, "refused", "no such clone");
    const c = clone as {
      github_owner?: string | null;
      github_repo?: string | null;
      default_branch?: string | null;
    };
    if (!c.github_owner || !c.github_repo) {
      return outcome(
        cloneId,
        "refused",
        "the clone records no repository to read its functions from",
      );
    }
    const cloneRef = {
      owner: c.github_owner,
      repo: c.github_repo,
      branch: c.default_branch || "main",
    };

    const { data: backend, error: backendErr } = await supabase
      .from("clone_backends")
      .select("*")
      .eq("clone_id", cloneId)
      .maybeSingle();
    if (backendErr) {
      return outcome(
        cloneId,
        "refused",
        `could not read the clone's backend: ${backendErr.message}`,
      );
    }
    const b = (backend ?? null) as Record<string, unknown> | null;
    const projectRef = (args.projectRef ?? (b?.supabase_project_ref as string | null) ?? "").trim();
    if (!projectRef) return outcome(cloneId, "refused", "the clone has no Supabase project yet");
    const recordable =
      b !== null && Object.prototype.hasOwnProperty.call(b, "clone_owned_functions");
    const recorded = recordable ? readOwnedRecord(b?.clone_owned_functions) : null;

    // ── The prime: its repository, its project, what it declares ──
    const primeSource = await resolvePrimeSource(supabase);
    if (!primeSource) return outcome(cloneId, "refused", "the prime is not configured");
    if (
      primeSource.owner.toLowerCase() === cloneRef.owner.toLowerCase() &&
      primeSource.repo.toLowerCase() === cloneRef.repo.toLowerCase()
    ) {
      return outcome(
        cloneId,
        "refused",
        "this clone's repository is the prime's, so every function it declares is the prime's",
      );
    }
    const primeProject = (await resolvePrimeBackendRef(supabase)).trim();
    if (!primeProject || primeProject === projectRef) {
      return outcome(
        cloneId,
        "refused",
        primeProject
          ? `the clone's backend row names the prime's own project (${projectRef}); nothing is deployed to it from a clone`
          : "the prime's project is not known, so this clone's project cannot be ruled out as the prime",
      );
    }
    const primeDeclared =
      args.primeDeclaredSlugs ?? (await fetchDeclaredEdgeFunctionSlugs(octokit, primeSource));
    if (!primeDeclared) {
      return outcome(
        cloneId,
        "refused",
        `the prime's declared functions could not be read from ${primeSource.owner}/${primeSource.repo}; ` +
          "without them every function the clone declares would look like its own",
      );
    }
    if (primeDeclared.length === 0) {
      return outcome(
        cloneId,
        "refused",
        "the prime's repository reads as declaring no function at all, which is not a reading this lane acts on",
      );
    }

    // ── The clone's tree, and what it owns ──
    let tree: Awaited<ReturnType<typeof readRepoFunctionTree>>;
    try {
      tree = await readRepoFunctionTree(octokit, cloneRef);
    } catch (e) {
      return outcome(
        cloneId,
        "refused",
        `could not read ${cloneRef.owner}/${cloneRef.repo}@${cloneRef.branch}: ${message(e)}`,
      );
    }
    const owned = ownedFunctionSlugs(tree.declaredFunctionSlugs, primeDeclared);
    const plans = planFunctionBundles(tree, owned);
    const digest = ownedFunctionsDigest(plans);
    const live = await readProjectEdgeFunctionSlugs(projectRef);

    const decision = decideOwnedDeploy({
      owned,
      digest,
      recorded,
      live,
      recordable,
      force: args.force,
    });
    if (decision.act === "refuse") {
      // A refusal is not a reading: the record is left exactly as it was.
      return outcome(cloneId, "refused", decision.why, { owned });
    }

    // ── Deploy ──
    let fresh: OwnedFunctionResult[] = [];
    if (decision.act === "deploy") {
      const wanted = new Set(decision.slugs);
      const toDeploy = plans.filter((p) => wanted.has(p.slug));
      try {
        const bundles = await assembleFunctionBundles(octokit, cloneRef, toDeploy);
        const results = await deployEdgeFunctions(projectRef, bundles);
        fresh = results.map((r) => ({
          slug: r.slug,
          success: r.success,
          ...(typeof r.verifyJwt === "boolean" ? { verifyJwt: r.verifyJwt } : {}),
          ...(r.error ? { error: r.error } : {}),
        }));
      } catch (e) {
        // The source could not be assembled. Each slug is recorded as failed
        // with the reason, so the next pass retries it rather than trusting a
        // digest nothing was deployed against.
        fresh = toDeploy.map((p) => ({
          slug: p.slug,
          success: false,
          error: `its source could not be read: ${message(e)}`,
        }));
      }
    }

    // ── Record ──
    const next = nextOwnedRecord({
      recorded,
      owned,
      digest,
      sourceRepo: tree.sourceRepo,
      sourceSha: tree.sourceSha,
      live,
      fresh,
      now: now.toISOString(),
    });
    let wrote = false;
    let recordRefused: string | undefined;
    if (!recordable) {
      recordRefused =
        b === null
          ? "the clone has no backend row to record on"
          : `clone_backends.clone_owned_functions does not exist on this deployment yet (migration ${RECORD_MIGRATION})`;
    } else if (ownedRecordDue(recorded, next, now.getTime())) {
      const { error: writeErr } = await supabase
        .from("clone_backends")
        .update({ clone_owned_functions: next as unknown as Json })
        .eq("clone_id", cloneId);
      if (writeErr) {
        recordRefused = isMissingColumn(writeErr)
          ? `clone_backends.clone_owned_functions does not exist on this deployment yet (migration ${RECORD_MIGRATION})`
          : `could not record the result: ${writeErr.message}`;
      } else {
        wrote = true;
      }
    }

    const deployed = fresh.filter((r) => r.success).map((r) => r.slug);
    const failed = fresh
      .filter((r) => !r.success)
      .map((r) => ({ slug: r.slug, error: r.error ?? "deploy failed" }));
    const act: CloneOwnedFunctionsOutcome["act"] =
      decision.act === "deploy" ? "deployed" : decision.act === "none" ? "none" : "skip";
    return outcome(cloneId, act, decision.why, {
      owned,
      deployed,
      failed,
      retired: next.retired,
      recorded: wrote,
      ...(recordRefused ? { recordRefused } : {}),
    });
  } catch (e) {
    return outcome(cloneId, "refused", message(e));
  }
}

/** One line for a status field or an audit row. */
export function describeCloneOwnedOutcome(o: CloneOwnedFunctionsOutcome): string {
  const tail = o.recordRefused ? ` (not recorded: ${o.recordRefused})` : "";
  switch (o.act) {
    case "refused":
      return `Clone-owned functions not deployed: ${o.why}${tail}`;
    case "none":
      return `Clone-owned functions: none — ${o.why}${tail}`;
    case "skip":
      return `Clone-owned functions current (${o.owned.join(", ")}) — ${o.why}${tail}`;
    case "deployed": {
      const parts = [`deployed ${o.deployed.length}/${o.deployed.length + o.failed.length}`];
      if (o.deployed.length > 0) parts.push(o.deployed.join(", "));
      if (o.failed.length > 0) {
        parts.push(`failed: ${o.failed.map((f) => `${f.slug} (${f.error})`).join("; ")}`);
      }
      return `Clone-owned functions ${parts.join(" — ")} — ${o.why}${tail}`;
    }
  }
}

export type FleetOwnedFunctionSweep = {
  considered: number;
  deployed: number;
  failed: number;
  outcomes: CloneOwnedFunctionsOutcome[];
  /** Fleet-level refusal: no clone was read. */
  refused: string | null;
};

/**
 * Every clone whose backend is `ready`, one after another.
 *
 * Only `ready`: a row still being provisioned is provisioning's to finish, and
 * every write here bumps `clone_backends.updated_at`, which the provisioning
 * drain reads as liveness and as queue order. The prime's declared list is read
 * ONCE, and a failure to read it stops the sweep, for the reason each clone's
 * pass would refuse on its own.
 */
export async function sweepCloneOwnedFunctionsFromFleet(deps: {
  supabase: Db;
  octokit: Octokit;
  now?: () => Date;
}): Promise<FleetOwnedFunctionSweep> {
  const { supabase, octokit } = deps;
  const result: FleetOwnedFunctionSweep = {
    considered: 0,
    deployed: 0,
    failed: 0,
    outcomes: [],
    refused: null,
  };
  try {
    const primeSource = await resolvePrimeSource(supabase);
    if (!primeSource) {
      result.refused = "the prime is not configured";
      return result;
    }
    const primeDeclared = await fetchDeclaredEdgeFunctionSlugs(octokit, primeSource);
    if (!primeDeclared) {
      result.refused = `the prime's declared functions could not be read from ${primeSource.owner}/${primeSource.repo}`;
      return result;
    }
    const { data: backends, error: backendsErr } = await supabase
      .from("clone_backends")
      .select("clone_id, supabase_project_ref, status")
      .eq("status", "ready");
    if (backendsErr) {
      result.refused = `could not read the clones' backends: ${backendsErr.message}`;
      return result;
    }
    for (const row of backends ?? []) {
      const r = row as { clone_id: string | null; supabase_project_ref: string | null };
      if (!r.clone_id || !(r.supabase_project_ref ?? "").trim()) continue;
      result.considered += 1;
      const o = await deployCloneOwnedFunctions({
        supabase,
        octokit,
        cloneId: r.clone_id,
        primeDeclaredSlugs: primeDeclared,
        now: deps.now,
      });
      result.deployed += o.deployed.length;
      result.failed += o.failed.length;
      result.outcomes.push(o);
    }
  } catch (e) {
    result.refused = message(e);
  }
  return result;
}

/**
 * Whether a sweep deserves a line in the audit log. A fleet whose owned
 * functions are all current is the steady state and writes nothing.
 */
export function ownedFunctionSweepIsNoteworthy(sweep: FleetOwnedFunctionSweep): boolean {
  if (sweep.refused || sweep.deployed > 0 || sweep.failed > 0) return true;
  return sweep.outcomes.some(
    (o) => o.act === "refused" || o.retired.length > 0 || Boolean(o.recordRefused),
  );
}
