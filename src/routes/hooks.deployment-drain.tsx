// Deployment worker — advances `clone_deployments` one state per pass.
//
// Called by pg_cron every minute (Bearer auth via verifyCronAuth), scheduled in
// 20260820180000_schedule_deployment_drain.sql. See docs/HOSTING_ARCHITECTURE.md.
//
// ONE STEP PER PASS, and that is the whole design. Every step here is a call to
// a rate-limited API and some of them (a production build) take minutes. A
// worker that tries to run a clone end-to-end inside one invocation loses all of
// it when the Cloudflare Worker request is terminated — the same way a
// `void (async () => …)` cascade was killed mid-flight and left a fresh repo
// without its module files. So: take a step, persist, return. The next tick
// continues.
//
// Waiting is not failing. A build in progress and a domain waiting on DNS
// propagation both re-queue WITHOUT incrementing `attempts`, because burning the
// retry budget on a healthy wait is how a clone that was going to be fine gets
// marked failed. They are bounded by wall-clock instead (STUCK_HOURS), which is
// the thing actually going wrong if it happens.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson, asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { getHostingProvider, asHostingSlug } from "@/server/hosting";
import "@/server/hosting/index"; // ensure providers register
import {
  ADVANCE,
  CLAIMABLE,
  backoffSeconds,
  isRetryable,
  judgeWait,
  type DeploymentStatus,
} from "@/server/hosting/deploymentState.pure";
import { buildCloneEnv, envDigest } from "@/server/hosting/envPolicy.pure";
import { cloneFqdn, resolveCloneOrigin } from "@/server/hosting/dnsTarget.pure";
import {
  enqueueDomainVerificationJobs,
  enqueueSubdomainJob,
} from "@/server/hosting/subdomainJobs.server";
import { VercelError } from "@/server/hosting/vercel-client";

const admin = supabaseAdmin;

const MAX_ROWS_PER_RUN = 6;
/** A build or a DNS propagation that has not resolved in this long is stuck. */
const STUCK_HOURS = 6;

type DeploymentRow = {
  clone_id: string;
  provider_slug: string;
  status: DeploymentStatus;
  project_id: string | null;
  project_name: string | null;
  team_id: string | null;
  latest_deployment_id: string | null;
  provider_origin: string | null;
  domain: string | null;
  dns_target_type: string | null;
  dns_target_value: string | null;
  domain_verification: unknown;
  env_digest: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  /** When the row entered the status it is in now. See judgeWait. */
  status_since: string | null;
};

type StepOutcome =
  | { kind: "advance"; patch?: Record<string, unknown>; result?: unknown }
  | { kind: "wait"; seconds: number; detail: string; patch?: Record<string, unknown> }
  | { kind: "done"; patch?: Record<string, unknown>; result?: unknown }
  | { kind: "error"; error: string; retryAfterSeconds?: number | null; retryable: boolean };

/**
 * Claim up to `limit` rows.
 *
 * A READ THAT FAILED IS NOT A QUEUE THAT IS EMPTY. Both statements here used to
 * destructure `data` alone. PostgREST resolves to `{ data: null, error }` on any
 * failure, and `data: null` is *also* what an empty queue and a lost claim race
 * look like — so a database fault returned `[]`, the drain reported
 * `claimed: 0` with `success: true`, and the queue simply never drained with
 * nothing anywhere to grep. That is the defect `SCREENING_EXECUTION.md` records
 * in the prime, in the same shape, in the worker that had actually been running.
 *
 * So a genuine failure THROWS. The route's catch turns it into a non-200 with
 * the message, which lands in `net._http_response` where `cron_delivery_health()`
 * can see it. Silence is the one outcome that converges nowhere.
 */
async function claim(limit: number): Promise<DeploymentRow[]> {
  const nowIso = new Date().toISOString();
  const { data: candidates, error: selectError } = await admin
    .from("clone_deployments")
    .select("clone_id")
    .in("status", CLAIMABLE)
    .lte("next_attempt_at", nowIso)
    .is("worker_started_at", null)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (selectError) {
    throw new Error(`claim: could not read the queue: ${selectError.message}`);
  }
  if (!candidates?.length) return [];

  const ids = candidates.map((c: { clone_id: string }) => c.clone_id);
  const { data: claimed, error: claimError } = await admin
    .from("clone_deployments")
    .update({ worker_started_at: nowIso })
    .in("clone_id", ids)
    .is("worker_started_at", null)
    .in("status", CLAIMABLE)
    .select(
      "clone_id, provider_slug, status, project_id, project_name, team_id, latest_deployment_id, provider_origin, domain, dns_target_type, dns_target_value, domain_verification, env_digest, attempts, max_attempts, created_at, status_since",
    );
  // Losing the race is normal and returns zero rows with no error. A fault is
  // not, and must not be reported as one.
  if (claimError) {
    throw new Error(`claim: could not claim ${ids.length} row(s): ${claimError.message}`);
  }
  return (claimed ?? []) as DeploymentRow[];
}

/**
 * Rows whose worker died mid-step. Reclaimed rather than left claimed forever —
 * `worker_started_at` with no matching finish is exactly the shape
 * `clone_backends` reclaims, and for the same reason: a terminated Worker
 * invocation leaves no error anywhere.
 */
async function reclaimStalled() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await admin
    .from("clone_deployments")
    .update({ worker_started_at: null, status_detail: "Worker stalled — requeued" })
    .lt("worker_started_at", cutoff)
    .in("status", CLAIMABLE);
}

async function loadContext(cloneId: string) {
  const [{ data: clone }, { data: backend }, { data: config }] = await Promise.all([
    admin
      .from("clones")
      .select(
        "id, name, slug, github_owner, github_repo, default_branch, subdomain, subdomain_fqdn",
      )
      .eq("id", cloneId)
      .maybeSingle(),
    admin
      .from("clone_backends")
      .select("supabase_url, supabase_project_ref, anon_key, status")
      .eq("clone_id", cloneId)
      .maybeSingle(),
    admin.from("platform_hosting_config").select("*").eq("singleton", true).maybeSingle(),
  ]);
  return { clone, backend, config };
}

async function step(row: DeploymentRow): Promise<StepOutcome> {
  const provider = getHostingProvider(asHostingSlug(row.provider_slug));
  const { clone, backend, config } = await loadContext(row.clone_id);

  if (!clone) return { kind: "error", error: "clone_not_found", retryable: false };

  if (!provider.isConfigured()) {
    // Dormant, not failed. Nothing has been attempted, so nothing is broken —
    // the same posture the subdomain feature already takes without a Cloudflare
    // token.
    return {
      kind: "done",
      patch: {
        status: "pending_platform",
        status_detail: `${provider.slug} is not configured (no API token).`,
      },
    };
  }

  switch (row.status) {
    // ── Preconditions ────────────────────────────────────────────────────
    case "pending": {
      if (!clone.github_owner || !clone.github_repo) {
        return {
          kind: "error",
          error: "clone has no GitHub repository to build from",
          retryable: false,
        };
      }
      const prefix = (config?.vercel_project_prefix ?? "").trim();
      const name = `${prefix}${clone.slug}`.toLowerCase();
      return {
        kind: "advance",
        patch: { project_name: name, team_id: config?.vercel_team_id ?? null },
      };
    }

    // ── Project ──────────────────────────────────────────────────────────
    case "creating_project": {
      const res = await provider.createOrAdoptProject({
        cloneId: row.clone_id,
        name: row.project_name ?? clone.slug,
        repo: {
          owner: clone.github_owner,
          name: clone.github_repo,
          defaultBranch: clone.default_branch || "main",
        },
      });
      return {
        kind: "advance",
        patch: {
          project_id: res.projectId,
          project_name: res.projectName,
          team_id: res.teamId ?? null,
          provider_origin: res.origin ?? null,
        },
        result: { adopted: res.adopted, projectId: res.projectId },
      };
    }

    case "linking_repo": {
      // This step's whole job is to turn a confusing 400 five steps later
      // ("no git link" at deploy) into a named failure at the step that owns
      // it — and until it asked the provider anything, it did not do that job.
      // It checked only that a project id had been recorded, so an ADOPTED
      // project with no git link sailed through: adoption never links a
      // repository, only creation does (`gitRepository` is a create-time
      // parameter), and the one production case was exactly that — a
      // hand-made project adopted by name, whose link then broke when the
      // repository transferred to another GitHub org, because Vercel's App
      // installation does not follow a repo across orgs.
      if (!row.project_id) return { kind: "error", error: "no project_id", retryable: false };
      if (!provider.describeProject) return { kind: "advance" };

      const described = await provider.describeProject(row.project_id, row.team_id);
      if (!described.found) {
        return {
          kind: "error",
          error:
            `Vercel project ${row.project_name ?? row.project_id} is not visible to this ` +
            `token — moved into a team, renamed, or deleted. Fix the project (or clear ` +
            `project_id so provisioning re-creates it) and retry.`,
          retryable: false,
        };
      }
      if (!described.linkedRepo) {
        return {
          kind: "error",
          error:
            `Vercel project ${described.name ?? row.project_id} has no linked GitHub ` +
            `repository, so nothing can be built from a ref. Link ` +
            `${clone.github_owner}/${clone.github_repo} in that project's Settings → Git, ` +
            `then retry. (Adoption never links: only project CREATION passes a repository.)`,
          retryable: false,
        };
      }
      // A link that names a different repo is not failed here: a repository
      // transferred between orgs legitimately diverges from the owner this
      // clone recorded, and Vercel builds from what IT holds. It is surfaced
      // instead, so the event log says what the build will actually use.
      return { kind: "advance", result: { linked_repo: described.linkedRepo } };
    }

    // ── Environment ──────────────────────────────────────────────────────
    case "syncing_env": {
      if (!row.project_id) return { kind: "error", error: "no project_id", retryable: false };
      if (!backend?.anon_key || !backend?.supabase_url) {
        // Two different situations wear the same shape here, and waiting is
        // only right for one of them.
        //
        // A backend still PROVISIONING will write these itself, so waiting is
        // correct — deploying a build wired to nothing renders an empty shell
        // that looks like a broken app.
        //
        // A backend that already says `ready` will not. Nothing in the system
        // writes these columns after provisioning finishes, so waiting is
        // waiting for something that is never coming — a clone enrolled by
        // hand, or adopted from an existing project, lands here permanently.
        // That is how this deployment sat in `syncing_env` with a backend
        // reporting `ready — Synced to 20260920000000`.
        //
        // The keys are recoverable rather than lost: the row names the project
        // ref, and the Management API is authoritative about that project's
        // keys. Reading them is not a guess, so recover once and re-queue.
        if (backend?.status === "ready" && backend.supabase_project_ref) {
          const ref = backend.supabase_project_ref;
          try {
            const { getProjectApiKeys, selectProjectKeys, getProjectUrl } =
              await import("@/server/backend-provisioning.server");
            const { anonKey } = selectProjectKeys(await getProjectApiKeys(ref));
            if (!anonKey) {
              return {
                kind: "error",
                error: `Backend ${ref} is marked ready but publishes no anon key. Re-run provisioning for this clone.`,
                retryable: false,
              };
            }
            // Only the anon key — the client-safe one, which the build ships to
            // browsers anyway. The service-role key is not needed to deploy and
            // is not written here.
            const { error: healError } = await admin
              .from("clone_backends")
              .update({
                anon_key: anonKey,
                supabase_url: backend.supabase_url ?? getProjectUrl(ref),
              })
              .eq("clone_id", row.clone_id);
            if (healError) {
              return {
                kind: "error",
                error: `recovered the anon key for ${ref} but could not store it: ${healError.message}`,
                retryable: true,
              };
            }
            return {
              kind: "wait",
              seconds: 5,
              detail: `Recovered the backend's anon key from project ${ref}.`,
            };
          } catch (e) {
            // A Management API fault is transient and worth retrying; it is
            // reported as an error rather than swallowed into a wait, because a
            // wait here is indistinguishable from the permanent case above.
            return {
              kind: "error",
              error: `could not read API keys for ${ref}: ${e instanceof Error ? e.message : String(e)}`,
              retryable: true,
            };
          }
        }
        if (backend?.status === "ready") {
          return {
            kind: "error",
            error:
              "The clone's backend is marked ready but records no Supabase project ref, so its URL and key cannot be recovered. Re-run backend provisioning for this clone.",
            retryable: false,
          };
        }
        return {
          kind: "wait",
          seconds: 120,
          detail: "Waiting for the clone's Supabase backend to report its URL and key.",
        };
      }
      // The Aurixa API key is deliberately NOT pushed here. It already lives in
      // the clone's own private repo at `.aurixa/credentials.json`, which the
      // build reads, and `cascadeApiKeyToRepo` rewrites that file on rotation.
      // A second copy in the hosting provider's environment is a second source
      // of truth that goes stale the first time the key is rotated.
      // Best-effort: a deployment that has not configured the prime backend
      // still gets the pairing checks, it just has no name to compare against.
      // Resolving it must never be able to STOP a deployment — an unconfigured
      // prime is a Mission Control setting, not a fault in this clone.
      let primeProjectRef: string | null = null;
      try {
        const { resolvePrimeBackendRef } = await import("@/server/prime-backend.server");
        primeProjectRef = await resolvePrimeBackendRef(admin);
      } catch {
        primeProjectRef = null;
      }
      // This clone's OWN Turnstile widget, minted here because Vite inlines
      // `VITE_*` at BUILD time: a site key that arrives after `deploying` is a
      // site key the bundle does not have. Best-effort for the same reason the
      // prime ref above is — a clone that cannot get a widget should reach
      // production saying its security check is unconfigured, not fail to
      // deploy at all. The refusal is recorded on the identity row and shown in
      // the clone's Turnstile panel, so it is visible rather than swallowed.
      //
      // Never the prime's key. `buildCloneEnv` has no parameter for one, and
      // the only value that can reach the bundle is the one Cloudflare minted
      // for this clone.
      let turnstileSiteKey: string | null = null;
      let turnstileNote = "not attempted";
      try {
        const { provisionTurnstileIdentity, isCloudflareConfigured } =
          await import("@/server/turnstile-identity.server");
        if (!isCloudflareConfigured()) {
          turnstileNote = "CLOUDFLARE_API_TOKEN not configured — no widget minted for this clone";
        } else {
          const minted = await provisionTurnstileIdentity(admin, row.clone_id, {
            mode: "provision",
          });
          if (minted.ok) {
            turnstileSiteKey = minted.row?.site_key ?? null;
            turnstileNote = minted.advanced.length
              ? minted.advanced.join("; ")
              : "already provisioned";
          } else {
            turnstileNote = minted.error;
          }
        }
      } catch (e) {
        turnstileNote = e instanceof Error ? e.message : String(e);
      }

      const vars = buildCloneEnv({
        supabaseUrl: backend.supabase_url,
        supabaseProjectRef: backend.supabase_project_ref,
        supabaseAnonKey: backend.anon_key,
        primeProjectRef,
        extra: { VITE_TURNSTILE_SITE_KEY: turnstileSiteKey },
      });
      const digest = envDigest(vars);
      if (digest === row.env_digest) {
        return { kind: "advance", result: { skipped: true, reason: "env unchanged" } };
      }
      const synced = await provider.syncEnv(row.project_id, vars, row.team_id);
      return {
        kind: "advance",
        patch: { env_digest: digest, env_synced_at: new Date().toISOString() },
        result: { ...(synced as Record<string, unknown>), turnstile: turnstileNote },
      };
    }

    // ── Build ────────────────────────────────────────────────────────────
    case "deploying": {
      if (!row.project_id) return { kind: "error", error: "no project_id", retryable: false };
      if (!row.latest_deployment_id) {
        const created = await provider.deploy(row.project_id, {
          ref: clone.default_branch || "main",
          teamId: row.team_id,
        });
        return {
          kind: "wait",
          seconds: 30,
          detail: "Build queued.",
          patch: { latest_deployment_id: created.deploymentId },
        };
      }
      const current = await provider.getDeployment(row.latest_deployment_id, row.team_id);
      if (current.state === "ready") {
        return {
          kind: "advance",
          patch: {
            last_deployed_at: new Date().toISOString(),
            provider_origin: current.url ?? row.provider_origin,
          },
        };
      }
      if (current.state === "error" || current.state === "canceled") {
        // A failed BUILD is not a transient fault. Retrying the identical commit
        // produces the identical failure, so this is terminal until a person or
        // a new commit changes something.
        return {
          kind: "error",
          error: `build ${current.state}`,
          retryable: false,
        };
      }
      return { kind: "wait", seconds: 30, detail: `Build ${current.state}.` };
    }

    // ── Domain ───────────────────────────────────────────────────────────
    case "attaching_domain": {
      if (!row.project_id) return { kind: "error", error: "no project_id", retryable: false };
      // The clone's RESERVED name, never its raw slug.
      //
      // Falling back to `clone.slug` is what bypassed `reserved_slugs` — a clone
      // slugged `admin` would attach `admin.aurixasystems.com.au`, a name the
      // platform expects to own — and it also skipped the collision check, so
      // two clones would race for one domain and Vercel would 409 the second.
      // Allocation happens once, at provisioning, in `reserveCloneSubdomain`.
      const fqdn = clone.subdomain_fqdn ?? cloneFqdn(clone.subdomain, config?.primary_domain);
      if (!fqdn) {
        // No domain to attach. That is a complete, correct outcome — the clone
        // is live on the provider's own origin — and must not read as a failure.
        return {
          kind: "done",
          patch: {
            status: "live",
            status_detail: "Live on the provider origin. No subdomain is reserved for this clone.",
          },
        };
      }
      const attached = await provider.attachDomain(row.project_id, fqdn, row.team_id);
      const dns = await enqueueSubdomainJob({
        cloneId: row.clone_id,
        slug: clone.subdomain ?? clone.slug,
        fqdn,
        zoneId: config?.cloudflare_zone_id,
        fleet: config,
        deployment: {
          dns_target_type: attached.dnsTargetType,
          dns_target_value: attached.dnsTargetValue,
        },
        action: "resync_subdomain",
      });
      const txt = await enqueueDomainVerificationJobs({
        cloneId: row.clone_id,
        zoneId: config?.cloudflare_zone_id,
        challenges: attached.challenges,
      });
      // Keep `clones.subdomain_status` in step. It is what the Subdomains
      // registry renders, and leaving it at `awaiting_deployment` after the DNS
      // job has been queued tells an operator nothing is happening while the
      // record is being written.
      if (dns.ok) {
        await admin.from("clones").update({ subdomain_status: "queued" }).eq("id", row.clone_id);
      }

      return {
        kind: "advance",
        patch: {
          domain: fqdn,
          dns_target_type: attached.dnsTargetType?.toLowerCase() ?? null,
          dns_target_value: attached.dnsTargetValue ?? null,
          domain_verification: attached.challenges,
        },
        result: { dns, txt, verified: attached.verified },
      };
    }

    case "verifying_domain": {
      if (!row.project_id || !row.domain) {
        return { kind: "error", error: "no project or domain", retryable: false };
      }
      const state = await provider.getDomain(row.project_id, row.domain, row.team_id);
      if (!state.verified) {
        return {
          kind: "wait",
          seconds: 120,
          detail: "Waiting for DNS to propagate and the provider to verify the domain.",
          patch: { domain_verification: state.challenges },
        };
      }
      return {
        kind: "advance",
        patch: { domain_verified_at: new Date().toISOString(), domain_verification: [] },
      };
    }

    default:
      return { kind: "error", error: `unhandled_status:${row.status}`, retryable: false };
  }
}

/**
 * Everything that happens when a clone first becomes reachable.
 *
 * This is the point of the whole feature: `clones.deploy_url` gets a value, for
 * the first time in this codebase's history. Twenty read sites have been
 * degrading quietly on a null — clone health's uptime ping, the pentest target
 * list, the billing handoff host pin — and they all start working here.
 *
 * The auth re-apply matters just as much. `backend-provisioning` writes the new
 * Supabase project's `site_url` and `uri_allow_list` minutes before any
 * deployment exists, from that same null. Without this call a clone gets a
 * working URL and a backend that refuses to sign anybody in from it.
 */
async function onLive(row: DeploymentRow, origin: string | null) {
  if (!origin) return;

  // `subdomain_status` moves to `active` alongside `deploy_url` because they
  // become true at the same instant, and only here: the domain has been observed
  // resolving to this project. Setting it earlier — at `attaching_domain`, when
  // the record was merely queued — is how the Subdomains registry came to show
  // `active` for names that did not resolve.
  const patch: Record<string, unknown> = { deploy_url: origin };
  if (row.domain) patch.subdomain_status = "active";
  await admin.from("clones").update(asRow<TablesUpdate<"clones">>(patch)).eq("id", row.clone_id);

  const { data: clone } = await admin
    .from("clones")
    .select("id, name, slug")
    .eq("id", row.clone_id)
    .maybeSingle();

  // Re-apply the backend's auth origins now that one actually exists.
  try {
    const { data: backend } = await admin
      .from("clone_backends")
      .select("supabase_project_ref")
      .eq("clone_id", row.clone_id)
      .maybeSingle();
    if (backend?.supabase_project_ref) {
      const { applyAuthConfig } = await import("@/server/backend-provisioning.server");
      // `null` for the prime's [auth] block on purpose: this call CORRECTS the
      // origins and must not re-copy the prime's own hostnames onto a
      // customer's project. buildAuthConfigPatch drops prime entries anyway,
      // and passing null keeps that guarantee independent of what the prime's
      // config.toml happens to say today.
      await applyAuthConfig(backend.supabase_project_ref, null, {
        siteUrl: origin,
        additionalRedirectUrls: [row.provider_origin, origin],
      });
    }
  } catch (e) {
    // Non-fatal and reported: the deployment IS live, and an operator can
    // re-run the auth sync. Failing the deployment here would be a worse lie
    // than the one this fixes.
    await admin.from("deployment_events").insert({
      clone_id: row.clone_id,
      provider_slug: row.provider_slug,
      action: "reapply_auth_config",
      success: false,
      error_message: e instanceof Error ? e.message : String(e),
    });
  }

  // ...and the CORS allow-list, which is a different system from the auth
  // config above and was the half nobody set.
  //
  // `applyAuthConfig` patches GoTrue's `/config/auth`. `ALLOWED_ORIGINS` is an
  // EDGE FUNCTION environment variable, read by `Deno.env.get` in the prime's
  // `_shared/auth.ts` — and when it is unset that helper falls back to a
  // hard-coded pair of the PRIME's hostnames. So a clone answered its own
  // login request with `access-control-allow-origin:
  // https://command-centre.npcservices.com.au` and the browser refused the
  // response: sign-in failing with correct credentials and no server-side
  // error.
  //
  // Here rather than at provisioning because this is the first moment a
  // clone's real origins exist. `applyCloneAllowedOrigins` resolves its target
  // through the clone-only guard and records its own outcome, so nothing here
  // needs to know a project ref.
  try {
    const { applyCloneAllowedOrigins } = await import("@/server/cloneAllowedOrigins.server");
    await applyCloneAllowedOrigins(admin, row.clone_id, { providerSlug: row.provider_slug });
  } catch (e) {
    // Defensive only — that function reports its own refusals and does not
    // throw for them. Same judgement as above: the deployment IS live.
    await admin.from("deployment_events").insert({
      clone_id: row.clone_id,
      provider_slug: row.provider_slug,
      action: "set_allowed_origins",
      success: false,
      error_message: e instanceof Error ? e.message : String(e),
    });
  }

  await admin.from("notifications").insert({
    kind: "deployment_live",
    severity: "success",
    title: `Deployment live: ${clone?.name ?? row.clone_id}`,
    body: `${clone?.name ?? "The clone"} is serving from ${origin}.`,
    clone_id: row.clone_id,
    url: `/clones/${row.clone_id}`,
    metadata: { origin, provider: row.provider_slug, project_id: row.project_id },
  });
}

async function finalize(row: DeploymentRow, outcome: StepOutcome) {
  const nowIso = new Date().toISOString();
  const base: Record<string, unknown> = { worker_started_at: null, updated_at: nowIso };
  let toStatus: DeploymentStatus = row.status;

  if (outcome.kind === "advance") {
    toStatus = (ADVANCE[row.status] ?? row.status) as DeploymentStatus;
    Object.assign(base, outcome.patch ?? {}, {
      status: toStatus,
      status_detail: null,
      error_message: null,
      attempts: 0,
      next_attempt_at: nowIso,
    });
    if (toStatus === "live") {
      base.worker_finished_at = nowIso;
    }
  } else if (outcome.kind === "done") {
    Object.assign(base, outcome.patch ?? {}, {
      worker_finished_at: nowIso,
      next_attempt_at: nowIso,
    });
    toStatus = (base.status as DeploymentStatus) ?? row.status;
  } else if (outcome.kind === "wait") {
    // A wait does NOT consume an attempt. Burning the retry budget on a healthy
    // build is how a clone that was going to be fine gets marked failed.
    //
    // Measured from `status_since` — when this row entered the status it is in
    // now — and NOT from `created_at`, which is the age of the whole row. Those
    // are different quantities, and the message has always claimed the first
    // one. See judgeWait for what the second one cost.
    const verdict = judgeWait({
      statusSince: row.status_since,
      now: Date.now(),
      stuckHours: STUCK_HOURS,
    });
    if (verdict.kind === "stuck") {
      Object.assign(base, {
        status: "failed",
        status_detail: `Stuck in ${row.status} for more than ${STUCK_HOURS}h: ${outcome.detail}`,
        error_message: "stuck",
        worker_finished_at: nowIso,
      });
      toStatus = "failed";
    } else {
      Object.assign(base, outcome.patch ?? {}, {
        status_detail: outcome.detail,
        next_attempt_at: new Date(Date.now() + outcome.seconds * 1000).toISOString(),
      });
    }
  } else {
    const attempts = row.attempts + 1;
    const willRetry = outcome.retryable && attempts < row.max_attempts;
    const delay = outcome.retryAfterSeconds ?? backoffSeconds(attempts);
    Object.assign(base, {
      attempts,
      error_message: outcome.error,
      status_detail: outcome.error,
      status: willRetry ? row.status : "failed",
      next_attempt_at: willRetry ? new Date(Date.now() + delay * 1000).toISOString() : nowIso,
      worker_finished_at: willRetry ? null : nowIso,
    });
    toStatus = willRetry ? row.status : "failed";
  }

  // Stamped here and nowhere else, because this is the only place a status is
  // written. A transition restarts the clock the wait budget is measured
  // against; a wait inside the same status must NOT, or the budget can never
  // be reached and the bound stops existing in the other direction.
  if (toStatus !== row.status) base.status_since = nowIso;

  await admin
    .from("clone_deployments")
    .update(asRow<TablesUpdate<"clone_deployments">>(base))
    .eq("clone_id", row.clone_id);

  await admin.from("deployment_events").insert({
    clone_id: row.clone_id,
    provider_slug: row.provider_slug,
    action: row.status,
    from_status: row.status,
    to_status: toStatus,
    payload: { project_id: row.project_id, domain: row.domain },
    result: asJson(
      (outcome.kind === "advance" || outcome.kind === "done" ? outcome.result : null) ?? {},
    ),
    success: outcome.kind !== "error",
    error_message: outcome.kind === "error" ? outcome.error : null,
  });

  if (toStatus === "live") {
    const origin = resolveCloneOrigin({
      domain: (base.domain as string) ?? row.domain,
      providerOrigin: (base.provider_origin as string) ?? row.provider_origin,
      deploymentStatus: "live",
    });
    await onLive({ ...row, ...(base as Partial<DeploymentRow>) } as DeploymentRow, origin);
  }

  if (toStatus === "failed") {
    await admin.from("notifications").insert({
      kind: "deployment_failed",
      severity: "error",
      title: "Deployment failed",
      body: String(base.status_detail ?? base.error_message ?? "unknown"),
      clone_id: row.clone_id,
      url: `/clones/${row.clone_id}`,
      metadata: { at_status: row.status, provider: row.provider_slug },
    });
  }
}

async function runOne(row: DeploymentRow) {
  try {
    return await step(row);
  } catch (e) {
    const status = e instanceof VercelError ? e.status : undefined;
    return {
      kind: "error" as const,
      error: e instanceof Error ? e.message : String(e),
      retryAfterSeconds: e instanceof VercelError ? e.retryAfterSeconds : null,
      retryable: isRetryable(status === undefined ? null : { status }),
    };
  }
}

/**
 * Hosting left behind by a deleted clone.
 *
 * The queue is filled by a BEFORE DELETE trigger on `clones`, because every
 * table holding the provider references cascades on that same delete — by the
 * time application code could react, the project id and the DNS record ids are
 * gone. See 20260820200000_hosting_teardown.sql.
 *
 * The order matters and is the reverse of provisioning: DNS first, then the
 * project. Removing the project while the CNAME still points at it leaves the
 * domain resolving to a Vercel edge that no longer knows it, which serves
 * DEPLOYMENT_NOT_FOUND on our own domain until DNS is cleaned up. Removing DNS
 * first makes the name stop resolving immediately, which is what "deleted"
 * should look like.
 *
 * `absent` is success at every step. A record somebody already deleted by hand
 * and a project that was never created are both the state we are trying to
 * reach, and treating either as an error means a teardown that can never finish.
 */
const TEARDOWN_ROWS_PER_RUN = 3;

async function processTeardowns() {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await admin
    .from("hosting_teardowns")
    .select("*")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("created_at", { ascending: true })
    .limit(TEARDOWN_ROWS_PER_RUN);

  // Same rule as the sweep: a queue that could not be READ is not a queue that
  // is EMPTY, and a teardown that never runs leaves a provider project billing.
  if (error) {
    console.error("deployment-drain teardown: could not read the queue:", error.message);
    return { claimed: 0, done: 0, failed: 0, error: error.message };
  }

  let done = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const result: Record<string, unknown> = { dns_deleted: 0, dns_absent: 0, project: "skipped" };
    try {
      // 1. DNS first.
      const { cloudflareApi } = await import("@/server/cloudflare/client");
      if (row.zone_id && process.env.CLOUDFLARE_API_TOKEN) {
        for (const recordId of row.dns_record_ids ?? []) {
          try {
            await cloudflareApi.deleteDnsRecord(row.zone_id, recordId);
            result.dns_deleted = (result.dns_deleted as number) + 1;
          } catch {
            // Already gone is the outcome we wanted.
            result.dns_absent = (result.dns_absent as number) + 1;
          }
        }
      }

      // 2. Then the project.
      if (row.project_id) {
        const provider = getHostingProvider(asHostingSlug(row.provider_slug));
        if (provider.isConfigured()) {
          try {
            await provider.removeProject(row.project_id, row.team_id);
            result.project = "removed";
          } catch (e) {
            if (e instanceof VercelError && e.status === 404) {
              result.project = "absent";
            } else {
              throw e;
            }
          }
        } else {
          // Not a failure and not a success: nothing was attempted. Marking it
          // done would claim we removed a project that is still running and
          // still billing.
          result.project = "provider_unconfigured";
          throw new Error("provider_unconfigured");
        }
      }

      await admin
        .from("hosting_teardowns")
        .update({ status: "done", result: asJson(result), completed_at: new Date().toISOString() })
        .eq("id", row.id);
      done++;
    } catch (e) {
      const attempts = (row.attempts ?? 0) + 1;
      const willRetry = attempts < (row.max_attempts ?? 5);
      await admin
        .from("hosting_teardowns")
        .update({
          status: willRetry ? "queued" : "failed",
          attempts,
          error_message: e instanceof Error ? e.message : String(e),
          result: asJson(result),
          next_attempt_at: new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
          completed_at: willRetry ? null : new Date().toISOString(),
        })
        .eq("id", row.id);
      if (!willRetry) {
        failed++;
        // A teardown that gave up is a live site nobody owns. It has to be said
        // out loud — there is no clone page left to show it on.
        await admin.from("notifications").insert({
          kind: "deployment_failed",
          severity: "error",
          title: `Hosting teardown failed: ${row.clone_name ?? row.clone_id}`,
          body: `${row.domain ?? row.project_name ?? "A deleted clone"} may still be serving. Remove the project and the DNS record by hand.`,
          url: `/fleet/deployments`,
          metadata: { teardown_id: row.id, project_id: row.project_id, domain: row.domain },
        });
      }
    }
  }
  return { claimed: rows?.length ?? 0, done, failed, error: null as string | null };
}

/**
 * Rows that are LIVE, checked against the provider rather than against a webhook
 * that may never have arrived.
 *
 * `/hooks/vercel` is the fast path and this is the honest one. A webhook that
 * was not delivered — a rotated secret, a receiver that 500'd, a webhook nobody
 * ever created in the Vercel dashboard — leaves NO trace on either side. That is
 * the same failure `cron_delivery_health` exists for: pg_cron reports on the SQL
 * that queued the HTTP call, not on the call, so the only honest signal is
 * asking the far end what it thinks.
 *
 * Deliberately slow. One clone's production build state changes when somebody
 * pushes, which is not often, so this is a low-frequency correctness net and not
 * a monitor — SWEEP_INTERVAL_MINUTES between checks per clone, and a hard cap on
 * how many are checked per run so a fifty-clone fleet cannot spend the team's
 * rate limit on reconciliation.
 */
const SWEEP_ROWS_PER_RUN = 4;
const SWEEP_INTERVAL_MINUTES = 30;

async function sweepLiveBuilds() {
  const cutoff = new Date(Date.now() - SWEEP_INTERVAL_MINUTES * 60 * 1000).toISOString();
  const { data: rows, error } = await admin
    .from("clone_deployments")
    .select(
      "clone_id, provider_slug, project_id, team_id, status, domain, last_build_state, last_build_deployment_id",
    )
    .eq("status", "live")
    .not("project_id", "is", null)
    .or(`build_checked_at.is.null,build_checked_at.lt.${cutoff}`)
    .order("build_checked_at", { ascending: true, nullsFirst: true })
    .limit(SWEEP_ROWS_PER_RUN);

  // This sweep is the backup for a webhook that was never delivered, so it is
  // the last thing that should fail quietly: a discarded error here reported
  // `checked: 0` — identical to "no build was due" — and the backup for one
  // silent failure mode became a second one. It does not throw, because the
  // claim work above it already succeeded and is worth keeping; it is named in
  // the response instead.
  if (error) {
    console.error("deployment-drain sweep: could not read live deployments:", error.message);
    return { checked: 0, changed: 0, error: error.message };
  }

  let checked = 0;
  let changed = 0;
  for (const row of rows ?? []) {
    // Stamp the check FIRST, whatever happens next. A provider call that throws
    // must still record that we asked, or a permanently failing project is
    // re-selected every single run and starves every other row out of the cap.
    await admin
      .from("clone_deployments")
      .update({ build_checked_at: new Date().toISOString() })
      .eq("clone_id", row.clone_id);
    checked++;

    try {
      const provider = getHostingProvider(asHostingSlug(row.provider_slug));
      if (!provider.isConfigured()) continue;
      const build = await provider.latestProductionBuild(row.project_id, row.team_id);
      if (!build) continue;

      const state =
        build.state === "ready"
          ? "ready"
          : build.state === "error"
            ? "error"
            : build.state === "canceled"
              ? "canceled"
              : "building";

      // Nothing new. Recording it anyway would rewrite `last_build_at` on every
      // sweep and destroy the one signal that says WHEN the build last changed.
      if (
        state === row.last_build_state &&
        (build.deploymentId ?? null) === row.last_build_deployment_id
      ) {
        continue;
      }

      await admin
        .from("clone_deployments")
        .update({
          last_build_state: state,
          last_build_deployment_id: build.deploymentId || null,
          last_build_error: state === "error" ? "Build failed (found by sweep)" : null,
          last_build_at: new Date().toISOString(),
        })
        .eq("clone_id", row.clone_id);
      changed++;

      await admin.from("deployment_events").insert({
        clone_id: row.clone_id,
        provider_slug: row.provider_slug,
        action: "sweep_build",
        from_status: row.status,
        to_status: null,
        success: true,
        payload: { state, deployment_id: build.deploymentId, found_by: "sweep" },
      });

      // Only on the transition INTO failure, and only when the webhook did not
      // already say so. Notifying on every sweep that observes a still-failed
      // build is how an operator learns to ignore the notification.
      if (state === "error" && row.last_build_state !== "error") {
        const { data: clone } = await admin
          .from("clones")
          .select("name")
          .eq("id", row.clone_id)
          .maybeSingle();
        await admin.from("notifications").insert({
          kind: "deployment_build_failed",
          severity: "warning",
          title: `Build failed: ${clone?.name ?? row.clone_id}`,
          body: `${row.domain ?? "The clone"} is still serving the previous build. Found by reconciliation, so the deployment webhook may not be reaching us.`,
          clone_id: row.clone_id,
          url: `/clones/${row.clone_id}`,
          metadata: { found_by: "sweep", deployment_id: build.deploymentId },
        });
      }
    } catch (e) {
      await admin.from("deployment_events").insert({
        clone_id: row.clone_id,
        provider_slug: row.provider_slug,
        action: "sweep_build",
        success: false,
        error_message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { checked, changed, error: null as string | null };
}

async function drain() {
  await reclaimStalled();
  const rows = await claim(MAX_ROWS_PER_RUN);
  let advanced = 0;
  let waiting = 0;
  let failed = 0;
  // Serial on purpose. Project creation and domain attachment are the two most
  // rate-limited calls on the provider's side, and this queue is measured in
  // clones, not in thousands of rows.
  for (const row of rows) {
    const outcome = await runOne(row);
    await finalize(row, outcome);
    if (outcome.kind === "advance" || outcome.kind === "done") advanced++;
    else if (outcome.kind === "wait") waiting++;
    else failed++;
  }
  const sweep = await sweepLiveBuilds();
  const teardown = await processTeardowns();
  return { claimed: rows.length, advanced, waiting, failed, sweep, teardown };
}

export const Route = createFileRoute("/hooks/deployment-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const summary = await drain();
          return new Response(JSON.stringify({ success: true, ...summary }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("deployment-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
