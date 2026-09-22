// The clone-creation pipeline, server-only. Split from
// clone-provisioning.functions.ts because the client bundle imports that
// file for its server-function stubs, and a plain exported function (unlike
// a .handler() body) is not stripped from the client graph — the
// import-protection gate refuses `./github-app.server` there, correctly.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCloneBillingIdForProvisioning } from "./clone-billing-identity.server";
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
      /*
        RECONCILE, RATHER THAN BYPASS.

        This returned here, on the existence of the clone row alone. A request
        terminated after that row was inserted and before the side effects ran
        therefore left the backend un-enqueued — with the operator's admin
        password gone, since it exists only in the request — the subdomain
        unreserved and the sending identity unstarted, while the retry reported
        a successful idempotent provision and nothing anywhere recorded that
        any of it had been asked for.

        Every step is safe to run again (see `startRequestedSideEffects`), so
        the retry starts what the first attempt did not. A clone that already
        has everything takes three guarded reads and changes nothing, which is
        the ordinary case and the price of the uncommon one being silent.

        It stays `idempotent: true`: the caller asked for a clone and is
        getting the same clone, which is what that word answers.
      */
      await startRequestedSideEffects(supabase, userId, existing, data);
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

  // ─── Which billing identity this clone spends against ────────────────
  //
  // Resolved before the insert so the column is never written NULL, and
  // through the same module that will judge an operator's later change:
  // what provisioning accepts and what the clone's own page accepts cannot
  // become two standards.
  //
  // It reads the control plane through the admin client rather than through
  // `supabase`: finding the row that WOULD be shadowed is the whole point, and
  // a read the caller cannot see answers "nobody holds it".
  const billingIdentity = await resolveCloneBillingIdForProvisioning({
    requested: data.billingUserId,
    slug: data.slug,
    cloneId: null,
  });
  if (billingIdentity.note) {
    console.warn("[provisionCloneCore] billing identity", {
      slug: data.slug,
      source: billingIdentity.source,
      note: billingIdentity.note,
    });
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
      billing_user_id: billingIdentity.billingId,
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

  // ─── Entitlements, for the plan the operator actually picked ─────────────
  //
  // The wizard writes `clones.entitled_plan_slug` and the picked
  // `clone_modules` rows, and until now that was the end of it: nothing
  // resolved the plan into `entitlement_keys`, and nothing installed the
  // modules the PLAN entitles as opposed to the ones that were ticked. The
  // 2-minute entitlement drain claims `plan_change_events` rows, which
  // provisioning has never written — so a wizard-created clone was the only
  // route that skipped it. The agreement path (`agreement-provisioning.server`)
  // has always reconciled at creation; this is the same call, from the other
  // door.
  //
  // Non-fatal on purpose, and loudly recorded. A clone with a repository, a
  // backend and an unreconciled entitlement set is a clone an operator can
  // repair in one click; a clone whose creation threw after the repository
  // existed is one somebody has to unpick by hand.
  if (data.planSlug) {
    try {
      const { reconcileCloneEntitlements } = await import("./entitlement-modules.server");
      const recon = await reconcileCloneEntitlements({
        supabase,
        options: {
          cloneId: inserted.id,
          planSlug: data.planSlug,
          fromPlanSlug: null,
          direction: "initial",
          userId,
        },
      });
      if (!recon.ok) {
        console.error("[provisionCloneCore] initial entitlement reconcile failed", {
          cloneId: inserted.id,
          error: recon.error,
        });
        await supabase.from("notifications").insert({
          kind: "clone_created",
          severity: "warning",
          title: `Entitlements not applied: ${data.name}`,
          body:
            `The clone was created on plan "${data.planSlug}" and its entitlement set could ` +
            `not be resolved: ${recon.error}. Re-run the reconcile from the clone's page.`,
          clone_id: inserted.id,
          url: `/clones/${inserted.id}`,
          metadata: { stage: "entitlements", plan_slug: data.planSlug },
        });
      }
    } catch (e) {
      console.error("[provisionCloneCore] initial entitlement reconcile threw", {
        cloneId: inserted.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
      // Reported, not just logged. `githubAppCapability.pure.ts` was written
      // for this exact call site and says so in its header: measured 2 Sep
      // 2026 on `npc-client-dashboard`, Mission Control called this, the
      // variable was never set, and EVERY ONE of that workflow's 31 runs
      // failed — "its result was DISCARDED at the call site, so the only
      // trace was a line in a log nobody reads. A fleet-wide capability gap
      // looked exactly like nothing happening."
      //
      // The consequence is specific and permanent: `deploy-supabase-functions`
      // requires either a deploy token this clone is deliberately not given or
      // this variable, so without it the clone's repository shows a red check
      // on every push, for ever. The workflow's own header names what that
      // costs — it "trains people to ignore a red check that still matters on
      // the prime".
      //
      // The message is `declared.error` verbatim: it already distinguishes a
      // refusal GitHub gave from a write that returned cleanly and could not
      // be read back, and those are different remedies.
      await warnOnClone(
        supabase,
        inserted.id,
        `Deploy check will fail on every push: ${data.name}`,
        `Mission Control could not declare itself this repository's backend deployer, so ` +
          `its "Deploy Supabase functions" workflow has no way to stand down and will fail ` +
          `on every push to main: ${declared.error}`,
        "backend_deployer_variable",
      );
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

  // The reservation travels back because the deployment step below attaches
  // THIS name — the one fact the extracted block produces that its caller
  // still needs.
  const { subdomain: reservedSubdomain, fqdn: reservedFqdn } = await startRequestedSideEffects(
    supabase,
    userId,
    inserted,
    data,
  );

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

  return { ok: true, cloneId: inserted.id, githubUrl, subdomainFqdn: reservedFqdn };
}

/**
 * Tell an operator that a clone was created and something it asked for was not.
 *
 * One helper rather than an insert per site, because the rule is the same at
 * every one of them: nothing here is fatal — the clone exists, and a clone
 * that exists with a gap is repairable in a click, while a provision that
 * threw after a GitHub repository existed is not — so the ONLY thing standing
 * between a silent gap and an operator is this row.
 *
 * `kind` is `clone_created` because `notifications.kind` is a PG enum and an
 * unlisted value fails the insert silently, which is the defect three kinds
 * already shipped with here. The stage goes in `metadata`, where it costs
 * nothing to add one.
 */
async function warnOnClone(
  supabase: SupabaseClient<Database>,
  cloneId: string,
  title: string,
  body: string,
  stage: string,
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    kind: "clone_created",
    severity: "warning",
    title,
    body,
    clone_id: cloneId,
    url: `/clones/${cloneId}`,
    metadata: { stage },
  });
  if (error) {
    // The row IS the telling. Losing it leaves the gap and no trace of it.
    console.error(`[provisionCloneCore] could not warn about ${stage}: ${error.message}`);
  }
}

/**
 * The side effects a provisioning REQUEST asks for, started against a clone
 * that already exists.
 *
 * Extracted so the first submit and an idempotent retry cannot ask for
 * different things. The short-circuit at the top of `provisionCloneCore`
 * returns as soon as it finds a clone with the same key — and a request
 * terminated after the clone row was inserted and before this ran left the
 * backend un-enqueued, the operator's admin password gone with the tab, the
 * subdomain unreserved and the sending identity unstarted, while the retry
 * reported a successful idempotent provision. Raised by an automated review on
 * this branch before it merged; the three MOVED here by the provisioning work
 * on this same branch widened the window rather than opening it.
 *
 * Every step is safe to run again, which is what makes calling it from the
 * retry path honest rather than hopeful:
 *
 *  - `provisionCloneSubdomain` reads what the clone already holds.
 *  - `advanceEmailIdentity` "adopts an existing identity rather than creating
 *    a second one" — its own words, and why the deployment drain already calls
 *    it a second time.
 *  - `enqueueCloneBackendProvisioning` refuses outright when a backend is
 *    already `ready`, and upserts otherwise.
 *
 * Every step is also non-fatal and reported on the clone, unchanged: a clone
 * that exists with a repository and no backend is repairable in one click, and
 * failing a provision after a GitHub repository exists is not.
 */
async function startRequestedSideEffects(
  supabase: SupabaseClient<Database>,
  userId: string,
  inserted: { id: string },
  data: ProvisionCloneInput,
): Promise<{ subdomain: string | null; fqdn: string | null }> {
  // ─── Reserve the clone's name in the Aurixa zone ──────────────────
  // Before the deployment, because the deployment attaches THIS name. The
  // drain used to fall back to `clone.slug` when no subdomain was recorded,
  // which silently bypassed `reserved_slugs` — a clone slugged `admin` would
  // have taken `admin.aurixasystems.com.au` — and pushed collisions down to a
  // unique index whose error every caller on this path discards.
  //
  // Non-fatal: a clone with no name is served on its provider origin, which is
  // a complete outcome rather than a failure (see the `attaching_domain` step).
  //
  // `subdomain: null` is a DECISION and not an absent preference — the wizard's
  // "Reserve a subdomain for this clone" control, which until now reserved one
  // anyway because this block ran unconditionally. `undefined` still means
  // "derive one from the slug", which is what the agreement path wants and has
  // always had.
  //
  // One call, because this used to be two: the wizard wrote a SECOND name onto
  // the row from the browser after this function returned. See
  // `provisionCloneSubdomain`, which is now the only writer of
  // `clones.subdomain` on any creation path.
  let reservedSubdomain: string | null = null;
  let reservedFqdn: string | null = null;
  if (data.subdomain !== null) {
    try {
      const { provisionCloneSubdomain } =
        await import("@/server/hosting/subdomainAllocation.server");
      const reservation = await provisionCloneSubdomain({
        cloneId: inserted.id,
        slug: data.slug,
        preferred: data.subdomain,
        createdBy: userId,
      });
      if (reservation.ok) {
        reservedSubdomain = reservation.subdomain;
        reservedFqdn = reservation.fqdn;
      } else {
        console.error("[provisionClone] subdomain reservation failed:", reservation.reason);
      }
    } catch (e) {
      console.error("[provisionClone] subdomain reservation failed:", e);
    }
  }

  // ─── Start the clone's sending identity ───────────────────────────
  //
  // Here rather than in the browser for one reason: the operator's typed
  // domain. `advanceEmailIdentity` falls back to `deriveSendingDomain(clone)`
  // when it finds none recorded, and the deployment drain calls it with no
  // domain at all — so a submit that did not reach the browser's second call
  // did not fail, it quietly started an identity on a domain nobody chose,
  // which is the harder failure to notice of the two.
  //
  // Idempotent: it adopts an existing identity rather than creating a second
  // one, which is why the drain's own call at `syncing_env` stays exactly as
  // it is. Non-fatal for the same reason as everything else here.
  if (data.sendingDomain) {
    try {
      const { advanceEmailIdentity } = await import("@/server/email-identity.server");
      const started = await advanceEmailIdentity(supabase, inserted.id, {
        mode: "provision",
        sendingDomain: data.sendingDomain,
        actorUserId: userId,
      });
      if (!started.ok) {
        console.error("[provisionClone] sending identity refused:", started.error);
        await warnOnClone(
          supabase,
          inserted.id,
          `Sending identity not started: ${data.name}`,
          `The sending domain "${data.sendingDomain}" was requested and could not be ` +
            `started: ${started.error}. Retry it from the clone's page.`,
          "email_identity",
        );
      }
    } catch (e) {
      console.error("[provisionClone] sending identity failed:", e);
      await warnOnClone(
        supabase,
        inserted.id,
        `Sending identity not started: ${data.name}`,
        `The sending domain "${data.sendingDomain}" was requested and threw: ` +
          `${e instanceof Error ? e.message : String(e)}. Retry it from the clone's page.`,
        "email_identity",
      );
    }
  }

  // ─── Enqueue the clone's own backend ──────────────────────────────
  //
  // Before the deployment, because `syncing_env` waits on this: a deployment
  // queued with no backend row sits in a wait whose dependency does not exist.
  //
  // It used to be the BROWSER's job, in a second call made after this function
  // returned. Nothing else in the platform creates a `clone_backends` row —
  // not the deployment drain, not a sweep — so a submit interrupted in between
  // left a clone with a repository, a queued deployment, `isolated_tenant`
  // set, and no backend, for ever, with nothing recording that one had been
  // asked for; the admin password went with the tab.
  //
  // Non-fatal and reported, like every other enqueue here: a clone that exists
  // with no backend is repairable from the clone page in one click, and
  // failing the whole provision after a GitHub repository exists is not.
  if (data.backend) {
    try {
      const { enqueueCloneBackendProvisioning } =
        await import("@/server/backend-provisioning.server");
      const queued = await enqueueCloneBackendProvisioning(supabase, userId, {
        cloneId: inserted.id,
        cloneName: data.name,
        region: data.backend.region,
        adminEmail: data.backend.adminEmail,
        adminPassword: data.backend.adminPassword,
        // Deliberately not passed. `provisionCloneCore` has already written
        // the authoritative set to `clone_modules` and the backend pipeline
        // reads it from there, so the two tracks cannot drift if the picker
        // changed mid-submit. (Audit finding #12.)
      });
      if (!queued.ok) {
        console.error("[provisionClone] backend enqueue refused:", queued.error);
        await warnOnClone(
          supabase,
          inserted.id,
          `Backend not queued: ${data.name}`,
          `A dedicated Supabase backend was requested for this clone and refused: ` +
            `${queued.error}. Start it from the clone's page.`,
          "backend",
        );
      }
    } catch (e) {
      console.error("[provisionClone] backend enqueue failed:", e);
      await warnOnClone(
        supabase,
        inserted.id,
        `Backend not queued: ${data.name}`,
        `A dedicated Supabase backend was requested for this clone and could not be ` +
          `queued: ${e instanceof Error ? e.message : String(e)}. Start it from the ` +
          `clone's page.`,
        "backend",
      );
    }
  }
  return { subdomain: reservedSubdomain, fqdn: reservedFqdn };
}
