// The clone-creation pipeline, server-only. Split from
// clone-provisioning.functions.ts because the client bundle imports that
// file for its server-function stubs, and a plain exported function (unlike
// a .handler() body) is not stripped from the client graph — the
// import-protection gate refuses `./github-app.server` there, correctly.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAppOctokit } from "./github-app.server";
import { generateApiKey } from "./clone-api-keys.server";
import { fireTokenWebhook } from "./token-webhooks.server";
import { armGate } from "./payment-gate.server";
import type { Database } from "@/integrations/supabase/types";
import type { ProvisionCloneInput, ProvisionCloneResult } from "./clone-provisioning.functions";

/**
 * The whole clone-creation pipeline as a plain function, so it has exactly
 * two callers: the operator wizard's server function above, and the
 * signed-agreement flow (`agreement-provisioning.server.ts`), which runs it
 * with the service-role client and the agreement creator's user id. One
 * pipeline — repo, clone row, add-ons, modules, cascade, API key, secrets,
 * subdomain, deployment enqueue — never a second implementation of part of
 * it.
 */
export async function provisionCloneCore(
  supabase: SupabaseClient<Database>,
  userId: string,
  data: ProvisionCloneInput,
): Promise<ProvisionCloneResult> {
  // ─── Issue #13: idempotency short-circuit ─────────────────────────
  // If the same operator resubmits with the same key (double-click,
  // network retry, tab-switch-then-back), return the existing clone
  // instead of forking a second GitHub repo. Enforced by the partial
  // unique index on (owner_user_id, idempotency_key).
  if (data.idempotencyKey) {
    const { data: existing } = await supabase
      .from("clones")
      .select("id, github_url")
      .eq("owner_user_id", userId)
      .eq("idempotency_key", data.idempotencyKey)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        cloneId: existing.id,
        githubUrl: existing.github_url,
        idempotent: true,
      };
    }
  }

  const { data: prime } = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (!prime) {
    return { ok: false, error: "Prime not configured — set it up in Settings first" };
  }

  let githubOwner = data.targetOwner;
  let githubRepo = data.slug;
  let githubUrl: string | null = null;
  let lastSyncedSha: string | null = null;

  // Real GitHub work for fork / template
  if (data.method === "fork" || data.method === "template") {
    let octokit;
    try {
      octokit = getAppOctokit();
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "GitHub App not configured",
      };
    }

    try {
      if (data.method === "fork") {
        const { data: forked } = await octokit.repos.createFork({
          owner: prime.github_owner,
          repo: prime.github_repo,
          organization: data.targetOwner,
          name: data.slug,
          default_branch_only: true,
        });
        githubOwner = forked.owner.login;
        githubRepo = forked.name;
        githubUrl = forked.html_url;
      } else {
        // template
        const { data: created } = await octokit.repos.createUsingTemplate({
          template_owner: prime.github_owner,
          template_repo: prime.github_repo,
          owner: data.targetOwner,
          name: data.slug,
          private: true,
          include_all_branches: false,
          description: `Aurixa clone of ${prime.github_owner}/${prime.github_repo}`,
        });
        githubOwner = created.owner.login;
        githubRepo = created.name;
        githubUrl = created.html_url;
      }

      // Record the baseline: the PRIME revision this clone's content was
      // copied from.
      //
      // It is read from the PRIME repository, and that is the whole point.
      // This used to read the branch off the CLONE — which is equivalent on
      // the fork path, where history is shared, and wrong on the template
      // path, where `createUsingTemplate` starts a fresh history whose commits
      // exist in no other repository. Every consumer of `last_synced_sha`
      // reads it as a prime revision — `runDriftRefresh` compares it against
      // the prime, and `requestBackendSyncAfterCascade` says so in its own
      // contract — so a clone sha stored here is a base the prime answers 404
      // to, for ever.
      //
      // Both outcomes of the old code were wrong and looked different: a fast
      // template copy stored a sha nothing could resolve, and a slow one hit
      // the catch and stored null. Preflight Property Group and NPC Test took
      // the second road and read `failed` on every drift sweep from the day
      // they were provisioned.
      //
      // Null stays a legitimate answer — `workForCascade` treats a clone with
      // no recorded revision as owing every backend file, which is the safe
      // reading — so a prime that cannot be read is recorded as no baseline
      // rather than as somebody else's commit.
      try {
        const { data: br } = await octokit.repos.getBranch({
          owner: prime.github_owner,
          repo: prime.github_repo,
          branch: prime.default_branch || "main",
        });
        lastSyncedSha = br.commit.sha;
      } catch {
        // The prime is unreadable this instant; a wrong baseline is worse
        // than none, and the first cascade to merge writes the real one.
        lastSyncedSha = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "GitHub repo creation failed";
      return { ok: false, error: msg };
    }
  }

  // Insert the clone row
  const { data: inserted, error: insertErr } = await supabase
    .from("clones")
    .insert({
      name: data.name,
      slug: data.slug,
      tags: data.tags,
      provisioning_method: data.method,
      github_owner: githubOwner,
      github_repo: githubRepo,
      github_url: githubUrl,
      default_branch: prime.default_branch || "main",
      cloudflare_enabled: data.cloudflareEnabled,
      // `in_sync` is a claim that this clone holds a known prime revision, so
      // it is only made where one was actually recorded. With no baseline the
      // distance from the prime is unmeasurable rather than zero, and the
      // drift sweep says exactly that until a cascade merges.
      sync_status: lastSyncedSha ? "in_sync" : "unknown",
      last_synced_sha: lastSyncedSha,
      last_cascade_at: lastSyncedSha ? new Date().toISOString() : null,
      owner_user_id: userId,
      billing_user_id: data.billingUserId ?? null,
      billing_stripe_customer_id: data.billingStripeCustomerId ?? null,
      notes: data.notes || null,
      isolated_tenant: data.isolatedTenant === true,
      idempotency_key: data.idempotencyKey ?? null,
      entitled_plan_slug: data.planSlug ?? null,
    })
    .select()
    .single();

  if (insertErr || !inserted) {
    return { ok: false, error: insertErr?.message ?? "Clone insert failed" };
  }

  // ─── The sync exclusion policy, before anything cascades ──────────
  //
  // `DEFAULT_MIRROR_EXCLUSIONS` has always described itself as "seeded when a
  // mirror is registered" and nothing had ever written it — the only INSERT in
  // the codebase was a one-off migration naming the mirrors that existed the
  // day it ran. So every clone provisioned since has carried an empty policy,
  // which is why moving one to `sync_scope: 'mirror'` needs a hand-written
  // seed and why `assertMirrorPolicy` exists to refuse the state in between.
  //
  // Seeded for EVERY clone, not only a mirror. The list is this deployment's
  // own identity — its Supabase project, its hosting config, its lead-capture
  // embed — and that is true whatever the scope; an empty set on a module
  // clone is legitimate but indistinguishable from one nobody ever wrote.
  //
  // Ahead of the provision cascade below on purpose: that cascade is the first
  // thing to write into the new repository, and a policy that arrives after it
  // protects nothing it did.
  //
  // Never fatal. The clone exists, its repository is forked and its modules are
  // about to install; refusing all of that to report a policy gap that was the
  // status quo five minutes ago would be the worse outcome. `seedSyncExclusions`
  // is idempotent, so the operator's retry finishes it.
  {
    const { seedSyncExclusions } = await import("./cascade/seedSyncExclusions.server");
    const seeded = await seedSyncExclusions(supabase, inserted.id);
    if (!seeded.ok) {
      console.error("[provisionCloneCore] sync exclusion policy not seeded", {
        cloneId: inserted.id,
        error: seeded.error,
      });
      await supabase.from("audit_log").insert({
        action: "clone.sync_exclusions_seed_failed",
        entity_type: "clone",
        entity_id: inserted.id,
        actor_user_id: userId,
        metadata: { offered: seeded.offered, error: seeded.error },
      });
    }
  }

  // Record any add-ons bought alongside the tier. Written as purchase rows,
  // not to `clones.purchased_addon_slugs` — that column is derived by a
  // trigger now, so writing it directly would be overwritten on the next
  // purchase change.
  if ((data.addonSlugs ?? []).length > 0) {
    await supabase.from("clone_addon_purchases").insert(
      (data.addonSlugs ?? []).map((addon_slug) => ({
        clone_id: inserted.id,
        addon_slug,
        status: "active" as const,
        source: "operator" as const,
        created_by: userId,
        notes: "Selected during clone provisioning",
      })),
    );
  }

  // ─── Arm the activation gate ──────────────────────────────────────────
  // A clone provisioned onto a PAID plan boots on a clock and is locked when
  // it runs out, until Stripe captures the activation payment.
  //
  // It sits in the PIPELINE rather than in the wizard's server function
  // precisely because this function has two callers — the operator wizard and
  // the signed-agreement flow — and a gate armed in only one of them would
  // mean a clone created by an agreement is never gated at all. One pipeline,
  // one gate, exactly as the header above says.
  //
  // This is also the only place a gate is ever created: nothing backfills, so
  // the prime and every clone that already exists are untouched by
  // construction rather than by a flag somebody has to remember to set.
  //
  // Deliberately non-fatal. The repo is already forked and the clone row is
  // already written; failing here would leave a half-provisioned clone behind
  // a gate that is also the thing that failed. A clone that does not arm is a
  // clone with no gate — the fleet's existing behaviour — and the Payment
  // Gates console lists paid clones with no gate for exactly this reason.
  const gate = await armGate({
    cloneId: inserted.id,
    cloneName: data.name,
    planSlug: data.planSlug,
    graceHours: data.gateGraceHours,
    actorId: userId,
  });
  if (!gate.armed && gate.reason === "write_failed") {
    console.error("[provisionCloneCore] activation gate not armed", {
      cloneId: inserted.id,
      detail: gate.detail,
    });
  }

  // Install picked modules
  if (data.moduleIds.length > 0) {
    await supabase.from("clone_modules").insert(
      data.moduleIds.map((module_id) => ({
        clone_id: inserted.id,
        module_id,
        installed_by: userId,
      })),
    );

    // ─── Scoped cascade for picked module files ──────────────────
    // Push only the file_globs from picked modules to the freshly-created
    // repo so it lands with the modules pre-populated. Fire-and-forget:
    // failure here is non-fatal — the operator can re-cascade from the UI.
    if (data.method !== "clone" && githubUrl) {
      try {
        const { data: mods } = await supabase
          .from("modules")
          .select("id, name, file_globs")
          .in("id", data.moduleIds);
        const globs = Array.from(new Set((mods ?? []).flatMap((m) => m.file_globs ?? [])));
        if (globs.length > 0) {
          const { data: ev } = await supabase
            .from("cascade_events")
            .insert({
              trigger: "manual",
              mode: "auto_merge",
              status: "pending",
              requires_approval: false,
              scope_filter: {
                scope: "clone_provision_modules",
                clone_ids: [inserted.id],
                module_ids: data.moduleIds,
                module_globs: globs,
              },
              summary: `Provision cascade · ${mods?.length ?? 0} module(s) → ${data.name}`,
              initiated_by: userId,
            })
            .select()
            .single();
          if (ev) {
            await supabase.from("cascade_results").insert({
              cascade_event_id: ev.id,
              clone_id: inserted.id,
              status: "queued" as const,
            });
            // Durable execution: the /hooks/cascade-drain worker (pg_cron
            // every minute) atomically claims pending auto_merge events and
            // runs executeCascade. This survives Cloudflare Worker request
            // termination — previously a `void (async () => ...)` invocation
            // could be killed mid-flight, leaving the fresh clone repo
            // without its module files. (Audit finding #7.)
          }
        }
      } catch (e) {
        console.error("[provisionClone] module cascade setup failed:", e);
      }
    }
  }

  // ─── The clone's Mission Control key ──────────────────────────────
  //
  // There is ONE key and it is minted where it is delivered:
  // `ensureCloneMissionControlLink` writes `MISSION_CONTROL_CLONE_API_KEY`
  // into the clone's own Supabase project, which is the only place anything
  // reads it from (`_shared/missionControl.ts` and seven siblings).
  //
  // What stood here minted a SECOND key labelled `auto-provisioned` and
  // committed its plaintext into the clone's repository as
  // `.aurixa/credentials.json`, "so the clone's frontend can read it at build
  // time". Nothing has ever read that file — not in the prime, not in a clone,
  // not in a workflow — so the key had no delivery channel at all: both of the
  // two ever minted show `first_used_at` NULL and `last_used_at` NULL, from
  // 30 Aug and 1 Sep. What it did have was permanence. The file was later
  // overwritten by an ordinary cascade, so it is absent from `main` and
  // present in history: commit 79d3a13 of `preflight-property-group` still
  // serves the full key in plaintext to anyone with repository access, and a
  // history rewrite is the only removal.
  //
  // So the writer is DELETED rather than left unused. A dormant helper that
  // commits a live credential is one import away from committing one again,
  // and there is nothing left for it to deliver. Both orphaned keys are
  // revoked.
  //
  // Self-rotation survives the change: `clones:rotate` moved onto the key
  // that is actually delivered (see `CLONE_API_SCOPES`), so the public rotate
  // endpoint is reachable for the first time rather than reachable only by a
  // credential nobody could read.

  // ─── Tell the clone's CI who deploys its Supabase project ─────────
  //
  // Not gated on the provisioning method, unlike the secret sync below: a
  // forked clone and a created one are both deployed by Mission Control, and
  // this variable is what lets each one's `deploy-supabase-functions.yml`
  // stand down instead of failing on every push for want of a token it is
  // deliberately not given.
  //
  // A plain variable, never a secret — it is a name, not a key. The token it
  // replaces would have carried every permission on every project the account
  // can reach, in every clone repository at once.
  //
  // Non-fatal by construction: if this cannot be written the clone's deploy
  // check goes red, which is the loud recoverable state rather than a silent
  // one.
  if (githubUrl && githubOwner && githubRepo) {
    const { declareMissionControlDeploysBackend } =
      await import("@/server/github-variables.server");
    const declared = await declareMissionControlDeploysBackend({
      owner: githubOwner,
      repo: githubRepo,
    });
    if (!declared.ok) {
      console.error("[provisionClone] backend-deployer variable not written:", declared.error);
    }
  }

  // ─── Auto-sync Codex Actions secrets to the new repo ──────────────
  // The scan and remediation workflows need the model API key to run.
  // Push the secrets immediately so the clone is ready for autonomous
  // scanning and remediation from minute one. Non-fatal.
  if (data.method !== "clone" && githubUrl) {
    try {
      const { syncRepoSecrets, buildCodexRepoSecrets } =
        await import("@/server/github-secrets.server");
      const secretResult = await syncRepoSecrets({
        owner: githubOwner,
        repo: githubRepo,
        secrets: await buildCodexRepoSecrets(),
      });
      // github_secret_syncs grants only SELECT to `authenticated`; writing
      // through the request-scoped client was denied by RLS and the error
      // discarded, so provisioning never left a history row.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: historyErr } = await supabaseAdmin.from("github_secret_syncs").insert({
        target_kind: "clone",
        clone_id: inserted.id,
        owner: githubOwner,
        repo: githubRepo,
        written: secretResult.written,
        skipped: secretResult.skipped,
        failed: secretResult.failed,
        ok: secretResult.ok,
        trigger_source: "auto-provision",
        triggered_by: userId,
      });
      if (historyErr) {
        console.error("[provisionClone] failed to record secret sync history:", historyErr.message);
      }
    } catch (e) {
      console.error("[provisionClone] github secret sync failed:", e);
    }
  }

  // ─── Reserve the clone's name in the Aurixa zone ──────────────────
  // Before the deployment, because the deployment attaches THIS name. The
  // drain used to fall back to `clone.slug` when no subdomain was recorded,
  // which silently bypassed `reserved_slugs` — a clone slugged `admin` would
  // have taken `admin.aurixasystems.com.au` — and pushed collisions down to a
  // unique index whose error every caller on this path discards.
  //
  // Non-fatal: a clone with no name is served on its provider origin, which is
  // a complete outcome rather than a failure (see the `attaching_domain` step).
  let reservedSubdomain: string | null = null;
  try {
    const { reserveCloneSubdomain } = await import("@/server/hosting/subdomainAllocation.server");
    const reservation = await reserveCloneSubdomain({
      cloneId: inserted.id,
      slug: data.slug,
      preferred: data.subdomain ?? null,
    });
    if (reservation.ok) {
      reservedSubdomain = reservation.subdomain;
    } else {
      console.error("[provisionClone] subdomain reservation failed:", reservation.reason);
    }
  } catch (e) {
    console.error("[provisionClone] subdomain reservation failed:", e);
  }

  // ─── Enqueue the deployment ───────────────────────────────────────
  // The step this pipeline never had. Everything above creates a repository
  // and a backend; nothing built the clone or served it, which is why
  // `clones.deploy_url` was read in twenty places and written in none.
  //
  // Enqueue only — the wizard's submit must never block on a third party, and
  // a Cloudflare Worker request can be terminated mid-flight. The drain owns
  // every provider call. Non-fatal for the same reason the API-key cascade is:
  // the clone exists either way and the operator can retry from the clone
  // page.
  try {
    const { data: hostingCfg } = await supabaseAdmin
      .from("platform_hosting_config")
      .select("hosting_provider_slug")
      .eq("singleton", true)
      .maybeSingle();
    // The fleet decision: every clone is staged on Vercel. `manual` used to be
    // the fallback here, which meant a missing config row silently produced a
    // clone nothing would ever build — the failure looked like "deployment
    // declined" rather than like "the platform config is gone".
    const requested = data.deploymentProvider ?? hostingCfg?.hosting_provider_slug ?? "vercel";
    const { isVercelConfigured } = await import("@/server/hosting/vercel-client");

    // Three outcomes, and they are three different facts (see
    // deploymentState.pure): declined, served by hand, and queued. A row is
    // written for all three so the clone page can tell them apart — an absent
    // row would make "nobody asked" indistinguishable from "the worker has not
    // reached it yet".
    const status =
      requested === "none"
        ? "not_requested"
        : requested === "manual"
          ? "not_requested"
          : isVercelConfigured()
            ? "pending"
            : "pending_platform";

    const { error: deployErr } = await supabaseAdmin.from("clone_deployments").upsert(
      {
        clone_id: inserted.id,
        provider_slug: requested === "vercel" ? "vercel" : "manual",
        status,
        status_detail:
          requested === "none"
            ? "Deployment declined during provisioning."
            : requested === "manual"
              ? "Served by a manually configured target."
              : status === "pending_platform"
                ? "No hosting provider token configured. Nothing has been attempted."
                : null,
        requested_by: userId,
      },
      { onConflict: "clone_id" },
    );
    if (deployErr) {
      console.error("[provisionClone] deployment enqueue failed:", deployErr.message);
    }
  } catch (e) {
    console.error("[provisionClone] deployment enqueue failed:", e);
  }

  await supabase.from("audit_log").insert({
    action: "clone.created",
    entity_type: "clone",
    entity_id: inserted.id,
    actor_user_id: userId,
    metadata: {
      method: data.method,
      cloudflare: data.cloudflareEnabled,
      modules: data.moduleIds,
      github_url: githubUrl,
      subdomain: reservedSubdomain,
    },
  });

  await supabase.from("notifications").insert({
    kind: "clone_created",
    severity: "success",
    title: `Clone created: ${data.name}`,
    body:
      data.method === "clone"
        ? `Registered as independent clone (no repo created)`
        : `Provisioned via ${data.method} → ${githubOwner}/${githubRepo}`,
    clone_id: inserted.id,
    url: `/clones/${inserted.id}`,
    metadata: { method: data.method, cloudflare: data.cloudflareEnabled, github_url: githubUrl },
  });

  // No "API key issued" notification here any more, and no `new_key_secret`
  // in its metadata. That notification announced the auto-provisioned key,
  // whose plaintext it also stored a SECOND copy of — a credential nobody
  // could use, in a drawer, for ever. The key the clone actually runs on is
  // minted and delivered by `ensureCloneMissionControlLink`, which reports
  // its own outcome.

  return { ok: true, cloneId: inserted.id, githubUrl };
}
