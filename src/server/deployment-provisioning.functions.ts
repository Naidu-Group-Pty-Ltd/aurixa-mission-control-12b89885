/**
 * Deployment provisioning — the operator's side of `clone_deployments`.
 *
 * Everything here is an ENQUEUE. No server function talks to the hosting
 * provider directly, for the reason `subdomain-hosting.functions.ts` records:
 * the wizard's submit must never block on a third party, and a Cloudflare Worker
 * request can be terminated mid-flight. The drain owns every provider call.
 *
 * Dormant-until-configured, same as the subdomain path: without a provider token
 * an enqueue still succeeds and the row sits at `pending_platform`. Refusing the
 * request instead would make "we have not set Vercel up yet" indistinguishable
 * from "this clone cannot be deployed".
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asHostingSlug, getHostingProvider } from "@/server/hosting";
import "@/server/hosting/index";
import {
  reading,
  DEPLOYMENT_STATUSES,
  type DeploymentStatus,
} from "@/server/hosting/deploymentState.pure";
import { cloneFqdn, resolveDnsTarget } from "@/server/hosting/dnsTarget.pure";

const admin = supabaseAdmin;

async function loadConfig() {
  const { data } = await admin
    .from("platform_hosting_config")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  return data as any;
}

/** Whether the configured provider has the credentials it needs. */
function providerConfigured(slug: string): boolean {
  try {
    return getHostingProvider(asHostingSlug(slug)).isConfigured();
  } catch {
    return false;
  }
}

// ── Request a deployment ────────────────────────────────────────────────────
export const requestCloneDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string; providerSlug?: string }) =>
    z
      .object({
        cloneId: z.string().uuid(),
        providerSlug: z.enum(["vercel", "manual"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const config = await loadConfig();
    const slug = data.providerSlug ?? asHostingSlug(config?.hosting_provider_slug);

    // `manual` means a person configures the target. Recording that as a
    // deployment row is the point — it is what lets an operator tell "served by
    // hand" from "deployment failed", which is the distinction the whole
    // `reading()` vocabulary exists for.
    if (slug === "manual") {
      const { error } = await admin.from("clone_deployments").upsert(
        {
          clone_id: data.cloneId,
          provider_slug: "manual",
          status: "not_requested",
          status_detail: "Served by a manually configured target.",
          requested_by: context.userId,
        },
        { onConflict: "clone_id" },
      );
      if (error) throw new Error(error.message);
      return { ok: true as const, status: "not_requested" as const };
    }

    const ready = providerConfigured(slug);
    const status: DeploymentStatus = ready ? "pending" : "pending_platform";
    const { error } = await admin.from("clone_deployments").upsert(
      {
        clone_id: data.cloneId,
        provider_slug: slug,
        status,
        status_detail: ready ? null : "No hosting provider token configured.",
        attempts: 0,
        error_message: null,
        next_attempt_at: new Date().toISOString(),
        worker_started_at: null,
        worker_finished_at: null,
        requested_by: context.userId,
      },
      { onConflict: "clone_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, status };
  });

// ── Decline a deployment ────────────────────────────────────────────────────
export const declineCloneDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await admin.from("clone_deployments").upsert(
      {
        clone_id: data.cloneId,
        status: "not_requested",
        status_detail: "Deployment declined by an operator.",
        error_message: null,
        requested_by: context.userId,
      },
      { onConflict: "clone_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ── Retry / redeploy ────────────────────────────────────────────────────────
/**
 * Put a failed row back in the queue, at the step it failed on.
 *
 * Resuming from the failed step rather than from `pending` is deliberate: the
 * project already exists, and re-running `creating_project` would adopt it
 * again for nothing. `resumeAt` lets an operator rewind further when they have
 * changed something upstream.
 */
export const retryCloneDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string; resumeAt?: string }) =>
    z
      .object({
        cloneId: z.string().uuid(),
        resumeAt: z
          .enum(["pending", "creating_project", "syncing_env", "deploying", "attaching_domain"])
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { data: row } = await admin
      .from("clone_deployments")
      .select("status, project_id")
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    if (!row) throw new Error("no deployment for this clone");

    // A row that never got a project can only resume from the beginning,
    // whatever the caller asked for — resuming at `deploying` with no project_id
    // fails immediately and spends an attempt saying so.
    const resume = data.resumeAt ?? (row.project_id ? "syncing_env" : "pending");
    const { error } = await admin
      .from("clone_deployments")
      .update({
        status: row.project_id ? resume : "pending",
        // Whoever moves the status owns its clock (redeployStatusSince): a
        // retried row's next wait is measured from now, not from its failure.
        status_since: new Date().toISOString(),
        attempts: 0,
        error_message: null,
        status_detail: "Re-queued by an operator.",
        next_attempt_at: new Date().toISOString(),
        worker_started_at: null,
        worker_finished_at: null,
      })
      .eq("clone_id", data.cloneId);
    if (error) throw new Error(error.message);
    return { ok: true as const, resumedAt: row.project_id ? resume : "pending" };
  });

/** Force a fresh build of the current default branch. */
export const redeployClone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { error } = await admin
      .from("clone_deployments")
      .update({
        status: "deploying",
        // Cleared so the drain creates a NEW deployment instead of polling the
        // finished one and concluding it is already ready.
        latest_deployment_id: null,
        attempts: 0,
        error_message: null,
        status_detail: "Redeploy requested by an operator.",
        next_attempt_at: new Date().toISOString(),
        worker_started_at: null,
        worker_finished_at: null,
      })
      .eq("clone_id", data.cloneId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Push the environment again — after a backend rotation, for instance. */
export const resyncCloneDeploymentEnv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { error } = await admin
      .from("clone_deployments")
      .update({
        status: "syncing_env",
        // Cleared so the digest comparison cannot skip the very sync that was
        // just asked for.
        env_digest: null,
        attempts: 0,
        error_message: null,
        status_detail: "Environment re-sync requested by an operator.",
        next_attempt_at: new Date().toISOString(),
        worker_started_at: null,
        worker_finished_at: null,
      })
      .eq("clone_id", data.cloneId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ── Read ────────────────────────────────────────────────────────────────────
export const getCloneDeployment = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const [{ data: row }, { data: events }, config] = await Promise.all([
      admin.from("clone_deployments").select("*").eq("clone_id", data.cloneId).maybeSingle(),
      admin
        .from("deployment_events")
        .select("id, action, from_status, to_status, success, error_message, created_at")
        .eq("clone_id", data.cloneId)
        .order("created_at", { ascending: false })
        .limit(20),
      loadConfig(),
    ]);

    const slug = asHostingSlug(row?.provider_slug ?? config?.hosting_provider_slug);
    const target = row ? resolveDnsTarget(row, config) : null;
    const statusValue: DeploymentStatus | null =
      row?.status && (DEPLOYMENT_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as DeploymentStatus)
        : null;

    return {
      deployment: row ?? null,
      events: events ?? [],
      reading: reading(statusValue, { providerConfigured: providerConfigured(slug) }),
      // What DNS *should* say, rendered beside what it does — an operator
      // debugging a stuck domain should not have to open two dashboards to
      // compare two values.
      dnsTarget: target,
      providerSlug: slug,
      providerConfigured: providerConfigured(slug),
      primaryDomain: config?.primary_domain ?? null,
    };
  });

export const listFleetDeployments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const config = await loadConfig();
    const { data } = await admin
      .from("clone_deployments")
      .select(
        // `last_build_*` is the second dimension the fleet page renders: a row
        // can be `live` with a failed build, which means serving the previous
        // artefact. Omitting these columns makes that case indistinguishable
        // from a healthy one on the only screen that could show it.
        "clone_id, provider_slug, status, status_detail, domain, provider_origin, last_deployed_at, last_build_state, last_build_error, last_build_at, updated_at, clones(id, name, slug)",
      )
      .order("updated_at", { ascending: false });
    return {
      rows: (data ?? []).map((row: any) => ({
        ...row,
        reading: reading(row.status, {
          providerConfigured: providerConfigured(row.provider_slug),
        }),
        expectedFqdn: cloneFqdn(row.clones?.slug, config?.primary_domain),
      })),
      providerSlug: asHostingSlug(config?.hosting_provider_slug),
      providerConfigured: providerConfigured(asHostingSlug(config?.hosting_provider_slug)),
    };
  });

/**
 * Fan dormant rows out once the provider token lands.
 *
 * The mirror of `reconcilePendingSubdomains`, and it exists for the same reason:
 * the dormant posture is only honest if there is a way OUT of it that does not
 * require touching every clone by hand.
 */
/**
 * Give every clone that has no deployment row one.
 *
 * `reconcilePendingDeployments` only wakes rows that already exist at
 * `pending_platform`. A clone provisioned before this feature has NO row at all,
 * and every decision in the system reads an absent row as "nobody asked" — which
 * is correct, and which means "all clones are staged on Vercel" would have
 * silently meant "all clones created after today".
 *
 * Three rules make this safe to run against a live fleet:
 *
 *   - It only INSERTS. A clone that already has a row — declined, detached,
 *     failed, live — is left exactly as it is. Enrolment is not a reset, and an
 *     operator's `not_requested` is a decision this must not overturn.
 *   - It reserves the subdomain first, through the same allocator provisioning
 *     uses, so an enrolled clone gets a name that respects `reserved_slugs` and
 *     cannot collide with one already taken.
 *   - `dryRun` is the default. A fleet-wide write that creates a Vercel project
 *     per clone is not something to discover the shape of by running it.
 */
export const enrolFleetInDeployments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { dryRun?: boolean; cloneIds?: string[] } | undefined) =>
    z
      .object({
        dryRun: z.boolean().default(true),
        cloneIds: z.array(z.string().uuid()).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const config = await loadConfig();
    const slug = asHostingSlug(config?.hosting_provider_slug);
    const ready = providerConfigured(slug);

    // Clones with no deployment row. Read both sides rather than using a `not.in`
    // filter: PostgREST renders that as a URL-encoded list, and a fleet of a few
    // hundred ids makes a request long enough to be rejected by the gateway —
    // which comes back as an empty result, i.e. "nothing to enrol".
    const [{ data: clones }, { data: existing }] = await Promise.all([
      admin.from("clones").select("id, name, slug, subdomain").order("name"),
      admin.from("clone_deployments").select("clone_id"),
    ]);
    const enrolled = new Set((existing ?? []).map((r: { clone_id: string }) => r.clone_id));
    let candidates = (clones ?? []).filter((c: { id: string }) => !enrolled.has(c.id));
    if (data.cloneIds?.length) {
      const wanted = new Set(data.cloneIds);
      candidates = candidates.filter((c: { id: string }) => wanted.has(c.id));
    }

    if (data.dryRun) {
      return {
        ok: true as const,
        dryRun: true as const,
        providerSlug: slug,
        providerConfigured: ready,
        wouldEnrol: candidates.length,
        clones: candidates.map((c: { id: string; name: string; slug: string }) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
      };
    }

    const { reserveCloneSubdomain } = await import("@/server/hosting/subdomainAllocation.server");
    const status: DeploymentStatus = ready ? "pending" : "pending_platform";
    let created = 0;
    let named = 0;
    const failures: Array<{ cloneId: string; error: string }> = [];

    for (const clone of candidates as Array<{
      id: string;
      slug: string;
      subdomain: string | null;
    }>) {
      // Name first: the deployment attaches whatever name is on the clone when
      // it reaches `attaching_domain`, so enrolling without one produces a clone
      // that goes live on `*.vercel.app` and never gets its own address.
      if (!clone.subdomain) {
        const reservation = await reserveCloneSubdomain({ cloneId: clone.id, slug: clone.slug });
        if (reservation.ok) named++;
      }
      const { error } = await admin.from("clone_deployments").insert({
        clone_id: clone.id,
        provider_slug: slug,
        status,
        status_detail: ready
          ? "Enrolled by fleet backfill."
          : "No hosting provider token configured.",
        requested_by: context.userId,
      });
      if (error) failures.push({ cloneId: clone.id, error: error.message });
      else created++;
    }

    return {
      ok: true as const,
      dryRun: false as const,
      providerSlug: slug,
      providerConfigured: ready,
      created,
      subdomainsReserved: named,
      failures,
    };
  });

export const reconcilePendingDeployments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .handler(async () => {
    const config = await loadConfig();
    const slug = asHostingSlug(config?.hosting_provider_slug);
    if (!providerConfigured(slug)) {
      return { ok: false as const, error: "provider_not_configured" };
    }
    const { data, error } = await admin
      .from("clone_deployments")
      .update({
        status: "pending",
        status_detail: null,
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
      })
      .eq("status", "pending_platform")
      .eq("provider_slug", slug)
      .select("clone_id");
    if (error) throw new Error(error.message);
    return { ok: true as const, enqueued: (data ?? []).length };
  });
