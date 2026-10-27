/**
 * When a clone's hosting project may be created.
 *
 * ## Vercel builds a repository the moment a project links it
 *
 * The drain's order — create the project, link it, sync the environment,
 * deploy — reads as though the build waits for the environment. It never did.
 * The project is created WITH its git link, and Vercel starts a production
 * build of the default branch on that link, then on every push after it.
 * Measured from `deployment_events` and the repositories' own history:
 *
 *   - NPC CRM Independent, 19 Sep 2026: project created 05:22:03, a production
 *     build queued 05:23:07 with no push in between (the only commit was the
 *     05:20:40 "Initial commit"), READY at 05:25. Its environment was synced
 *     at 07:19:17. The two retarget commits at 07:18:45 and 07:18:47 queued
 *     two more production builds at 07:18:50 and 07:18:51 — before the sync.
 *   - Preflight, 30 Aug: created 15:36:13, built 15:40:07, no push between.
 *   - NPC Test, 1 Sep: created 04:41:32, built 04:45:57, no push between.
 *
 * A build with no `VITE_SUPABASE_*` falls back to the pair the repository
 * itself declares: the prime's, or — for a clone copied from a parent — the
 * PARENT's live project, until the retarget rewrites it, which can take about
 * two hours. Those builds were reachable on the provider's origin and were the
 * production deployment of record until the drain's own build replaced them.
 *
 * ## What holds it now
 *
 * The project is not created until the backend is `ready`, has published its
 * URL and anon key, and has recorded a retarget that left none of the files a
 * build ships naming another project. The drain then creates the project
 * HOLDING that pair (`CreateProjectInput.env`), so the build Vercel starts on
 * link, and any push before `syncing_env`, inlines this clone's own backend.
 * `syncing_env` adds the rest — the Turnstile site key, the billing identity —
 * and the drain's own build at `deploying` carries all of it.
 *
 * Gating creation alone would not have been enough, and that is the point of
 * the evidence above: the build Vercel started on link came 64 seconds after
 * creation on the CRM, and `syncing_env` runs two passes after creation, so
 * that build would still have read an empty environment. Creating the project
 * with git builds switched off was the other candidate. It needs a Vercel
 * setting this deployment has never exercised and cannot verify without
 * changing a live project, and a switch that is not turned back on leaves a
 * clone that never builds a push again. This needs one more field on the
 * create call the drain already makes — `environmentVariables`, Vercel's own
 * way to give a new project its variables, not yet exercised here either, so
 * the first rehearsal is its proof — and nothing that has to be undone later.
 *
 * ## A deployment already past this point is never held
 *
 * A row that records a project, a synced environment or a finished build has
 * been here before. Its repository is already linked and already builds every
 * push, so holding it at `pending` protects nothing, and every one of the
 * live clones is that row: an operator re-queuing one must not find it parked
 * behind a check it passed weeks ago.
 */

import type { WaitDependency } from "./deploymentState.pure";

/** What `clone_backends.repo_retarget` says about the files a build ships. */
export type RetargetReading =
  /** Nothing readable is recorded: the retarget never ran, threw, or found no repository. */
  | { recorded: false }
  /** Recorded. `unresolved` names the build-identity files it reported `failed`. */
  | { recorded: true; unresolved: string[] };

/**
 * Read a stored retarget result for the one question the gate asks.
 *
 * `buildIdentityTargets` comes from the module that names the targets
 * (`BUILD_IDENTITY_TARGETS` in `clone-repo-retarget.server.ts`), so this never
 * spells a path. A failure on anything else — the CI guard, the Dependabot
 * config, the repository variable — is the backend's to report and does not
 * change what a build would inline.
 *
 * A record whose shape cannot be read is NOT recorded. Reading it as "nothing
 * failed" would let a malformed row through as the clean one.
 */
export function readRetargetRecord(
  stored: unknown,
  buildIdentityTargets: readonly string[],
): RetargetReading {
  if (!stored || typeof stored !== "object") return { recorded: false };
  const actions = (stored as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return { recorded: false };
  const unresolved: string[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const { target, status } = action as { target?: unknown; status?: unknown };
    if (status !== "failed" || typeof target !== "string") continue;
    if (buildIdentityTargets.includes(target) && !unresolved.includes(target)) {
      unresolved.push(target);
    }
  }
  return { recorded: true, unresolved };
}

export type ProjectCreationFacts = {
  /** `clone_deployments.project_id` is set. */
  hasProject: boolean;
  /** `clone_deployments.env_synced_at`: when an environment was last published, if ever. */
  envSyncedAt: string | null;
  /** `clone_deployments.last_deployed_at`: when a build last reached READY, if ever. */
  lastDeployedAt: string | null;
  /** The clone's backend row, or null when none exists. */
  backend: {
    status: string;
    hasUrl: boolean;
    hasAnonKey: boolean;
    retarget: RetargetReading;
  } | null;
};

export type ProjectCreationDecision =
  | { kind: "proceed"; why: "past_first_build" | "backend_published" }
  /** Re-queue without an attempt; `judgeWait` bounds it from the dependency or the clock. */
  | { kind: "wait"; detail: string; dependency: WaitDependency | null }
  /** Nothing will change this by itself. Fails the row, saying what a person has to do. */
  | { kind: "refuse"; reason: string };

const BACKEND = "the clone's Supabase backend";

/** Why the wait is a wait, said once so the three messages cannot drift apart. */
const WHY =
  "The hosting project is created only once the backend has published its URL and key and " +
  "the repository has been re-pointed at it, because Vercel builds the repository the moment " +
  "a project links it.";

export function decideProjectCreation(facts: ProjectCreationFacts): ProjectCreationDecision {
  if (facts.hasProject || facts.envSyncedAt || facts.lastDeployedAt) {
    return { kind: "proceed", why: "past_first_build" };
  }

  const backend = facts.backend;
  if (!backend) {
    // No dependency is named: nothing is progressing and nothing has given
    // up. The wizard enqueues the backend from the browser after the clone
    // exists, so an interrupted submit leaves exactly this, and the clock is
    // the right judge of it — the same reading `syncing_env` gives.
    return {
      kind: "wait",
      detail:
        "No backend has been requested for this clone, so there is no URL or key to build " +
        `with. Start one from the clone page. ${WHY}`,
      dependency: null,
    };
  }

  if (backend.status === "failed") {
    // Terminal, so `judgeWait` fails the row now rather than after six hours
    // of a deployment that cannot proceed reading as though it might.
    return {
      kind: "wait",
      detail: `It will publish no URL or key until it is re-run (backend: failed). ${WHY}`,
      dependency: { name: BACKEND, state: "terminal" },
    };
  }

  if (backend.status !== "ready") {
    // Hours, on a healthy clone: a provisioning run deploys the prime's
    // functions a few at a time. The dependency keeps that from reading as a
    // stall, exactly as it does for `syncing_env`.
    return {
      kind: "wait",
      detail: `Waiting for the clone's Supabase backend (backend: ${backend.status}). ${WHY}`,
      dependency: { name: BACKEND, state: "progressing" },
    };
  }

  // `ready` from here on, and nothing in the pipeline writes these columns
  // after `ready` is written — so each of these is permanent until somebody
  // re-runs backend provisioning, which writes the pair and the retarget in
  // the same update that marks the backend ready.
  if (!backend.hasUrl || !backend.hasAnonKey) {
    return {
      kind: "refuse",
      reason:
        "The clone's backend is marked ready but has not published its URL and anon key, so a " +
        "hosting project created now would build with neither. Re-run backend provisioning for " +
        "this clone, then retry this deployment.",
    };
  }

  if (!backend.retarget.recorded) {
    return {
      kind: "refuse",
      reason:
        "The clone's backend is ready but no repository retarget is recorded for it, so the " +
        "repository may still declare another deployment's backend — and Vercel builds it the " +
        "moment a project links it. Re-run backend provisioning for this clone (it re-points " +
        "the repository), then retry this deployment.",
    };
  }

  if (backend.retarget.unresolved.length > 0) {
    return {
      kind: "refuse",
      reason:
        `The repository retarget could not rewrite ${backend.retarget.unresolved.join(", ")}, ` +
        "so a build would still ship another deployment's backend in it. The backend's status " +
        "line gives each reason. Fix them, re-run backend provisioning for this clone, then " +
        "retry this deployment.",
    };
  }

  return { kind: "proceed", why: "backend_published" };
}
