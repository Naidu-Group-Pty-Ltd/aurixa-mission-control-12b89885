// Deploying an approved package into the client's VAPI org: queue it, then let
// the worker run it tick by tick (vapiDeploy.pure.ts does the work).
//
// Three modes, one engine:
//   dry_run  - reads the org and reports what WOULD change; writes nothing.
//   apply    - makes the org match the package, then reads it back.
//   rollback - apply, of an earlier approved package. Old knowledge-base files
//              are never deleted, so rolling back is always possible.
//
// Only after an apply (or rollback) verifies does the tenant's tool backend
// switch on, with the package's booking window and types - so a half-deployed
// fleet never answers calls from a config that belongs to a different package.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type { BuildPackage } from "@/lib/voice-studio/package.pure";
import { executeDeploy, type DeployStep, type LedgerEntry } from "@/lib/voice-studio/vapiDeploy.pure";
import { writeAuditLog } from "@/server/audit.server";
import { ensureTenantConfig, readDeploySecrets, readProjectVapiKey } from "./credentials.server";
import { vapiClient } from "./vapi-client.server";

const DEFAULT_TICK_BUDGET_MS = 200_000;

export async function queueDeployment(args: {
  projectId: string;
  packageId: string;
  mode: "dry_run" | "apply" | "rollback";
  phoneNumberId: string | null;
  userId: string;
}): Promise<{ deploymentId: string }> {
  const { data: pkg, error } = await supabaseAdmin
    .from("voice_studio_packages")
    .select("id, project_id, status, package")
    .eq("id", args.packageId)
    .single();
  if (error) throw error;
  if (pkg.project_id !== args.projectId) throw new Error("package_not_in_project");
  if (pkg.status !== "approved" && !(args.mode === "rollback" && pkg.status === "superseded")) {
    throw new Error("only an approved package can be deployed; approve it on the Package tab first");
  }
  if (args.mode === "rollback") {
    const { data: prior, error: priorError } = await supabaseAdmin
      .from("voice_studio_deployments")
      .select("id")
      .eq("package_id", pkg.id)
      .in("mode", ["apply", "rollback"])
      .eq("status", "succeeded")
      .limit(1)
      .maybeSingle();
    if (priorError) throw priorError;
    if (!prior) throw new Error("a rollback returns to a package that was deployed successfully before; this one never was");
  }

  // Fail at the click, not a minute later in the worker.
  await readProjectVapiKey(args.projectId);
  const content = pkg.package as unknown as BuildPackage;
  await ensureTenantConfig(args.projectId, content.businessName);
  if (args.mode !== "dry_run") {
    const secrets = await readDeploySecrets(args.projectId);
    if (content.tools.some((t) => t.backend === "make_twilio_redirect") && !secrets.makeTransferUrl) {
      throw new Error("this package transfers calls to a human; set the Make transfer hook on the Deploy tab first");
    }
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from("voice_studio_deployments")
    .insert({
      project_id: args.projectId,
      package_id: args.packageId,
      mode: args.mode,
      phone_number_id: args.phoneNumberId,
      requested_by: args.userId,
      steps: [] as unknown as Json,
    })
    .select("id")
    .single();
  // 23505: the one-live-deployment index.
  if (insertError?.code === "23505") throw new Error("a deployment is already running for this project");
  if (insertError) throw insertError;

  if (args.mode !== "dry_run") {
    const { error: projError } = await supabaseAdmin.from("voice_studio_projects").update({ status: "deploying" }).eq("id", args.projectId);
    if (projError) throw projError;
  }
  await writeAuditLog({
    action: `voice_studio.deploy_${args.mode}_queued`,
    entityType: "voice_studio_project",
    entityId: args.projectId,
    actorUserId: args.userId,
    metadata: { package_id: args.packageId, deployment_id: row.id, phone_number_id: args.phoneNumberId },
  });
  return { deploymentId: row.id };
}

type ClaimedDeployment = {
  id: string;
  project_id: string;
  package_id: string;
  mode: "dry_run" | "apply" | "rollback";
  steps: Json;
  phone_number_id: string | null;
  requested_by: string | null;
};

function tickBudget(): number {
  const n = Number(process.env.VOICE_STUDIO_TICK_BUDGET_MS);
  return Number.isFinite(n) && n >= 30_000 ? n : DEFAULT_TICK_BUDGET_MS;
}

export async function runVoiceStudioDeployTick(): Promise<{ claimed: number; succeeded: number; continued: number; failed: number }> {
  const deadline = Date.now() + tickBudget();
  const { data: rows, error } = await supabaseAdmin.rpc("claim_voice_studio_deployments", { _limit: 1, _lease_seconds: 600 });
  if (error) throw error;
  const summary = { claimed: rows?.length ?? 0, succeeded: 0, continued: 0, failed: 0 };
  for (const d of (rows ?? []) as ClaimedDeployment[]) {
    try {
      const outcome = await runDeployment(d, deadline);
      summary[outcome]++;
    } catch (err) {
      summary.failed++;
      await finish(d, "failed", err instanceof Error ? err.message : String(err), null);
    }
  }
  return summary;
}

async function runDeployment(d: ClaimedDeployment, deadline: number): Promise<"succeeded" | "continued" | "failed"> {
  const { data: pkgRow, error } = await supabaseAdmin.from("voice_studio_packages").select("package").eq("id", d.package_id).single();
  if (error) throw error;
  const pkg = pkgRow.package as unknown as BuildPackage;

  const { data: ledgerRows, error: ledgerError } = await supabaseAdmin
    .from("voice_studio_vapi_ledger")
    .select("kind, key, vapi_id, payload_sha, adopted")
    .eq("project_id", d.project_id);
  if (ledgerError) throw ledgerError;
  const ledger: LedgerEntry[] = (ledgerRows ?? []).map((r) => ({
    kind: r.kind as LedgerEntry["kind"],
    key: r.key,
    vapiId: r.vapi_id,
    payloadSha: r.payload_sha,
    adopted: r.adopted,
  }));

  const apiKey = await readProjectVapiKey(d.project_id);
  const s = await readDeploySecrets(d.project_id);
  // A fleet with nowhere to send call logs sends them to its own tenant
  // webhook, which acknowledges and ignores them - better a working fleet with
  // no call log than a deploy that cannot run. The Deploy tab says which.
  const secrets = {
    tenantWebhookUrl: s.tenantWebhookUrl,
    tenantWebhookSecret: s.tenantWebhookSecret,
    makeTransferUrl: s.makeTransferUrl,
    callLogUrl: s.callLogUrl ?? s.tenantWebhookUrl,
    callLogSecret: s.callLogUrl ? (s.callLogSecret ?? s.tenantWebhookSecret) : s.tenantWebhookSecret,
  };

  const steps: DeployStep[] = Array.isArray(d.steps) ? (d.steps as unknown as DeployStep[]) : [];
  const outcome = await executeDeploy({
    pkg,
    ledger,
    api: vapiClient(apiKey),
    secrets,
    mode: d.mode === "dry_run" ? "dry_run" : "apply",
    phoneNumberId: d.phone_number_id,
    onLedger: async (e) => {
      const { error: upsertError } = await supabaseAdmin.from("voice_studio_vapi_ledger").upsert(
        {
          project_id: d.project_id,
          kind: e.kind,
          key: e.key,
          vapi_id: e.vapiId,
          payload_sha: e.payloadSha,
          package_id: d.package_id,
          adopted: e.adopted ?? false,
        },
        { onConflict: "project_id,kind,key" },
      );
      if (upsertError) throw upsertError;
    },
    onStep: async (st) => {
      steps.push(st);
      const { error: stepError } = await supabaseAdmin
        .from("voice_studio_deployments")
        .update({ steps: steps as unknown as Json })
        .eq("id", d.id);
      if (stepError) console.error(`[voice-studio] step log for ${d.id} failed: ${stepError.message}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    deadline,
  });

  if (outcome.status === "continue") {
    const { error: requeueError } = await supabaseAdmin
      .from("voice_studio_deployments")
      .update({ status: "queued", claimed_at: null })
      .eq("id", d.id);
    if (requeueError) throw requeueError;
    return "continued";
  }

  if (outcome.status === "failed") {
    await finish(d, "failed", outcome.error, outcome.verification ?? null);
    return "failed";
  }

  if (d.mode !== "dry_run") {
    const { error: cfgError } = await supabaseAdmin
      .from("voice_tenant_configs")
      .update({
        enabled: true,
        business_name: pkg.businessName,
        timezone: pkg.tenant.timezone,
        booking_window: pkg.tenant.bookingWindow as unknown as Json,
        booking_types: pkg.tenant.bookingTypes as unknown as Json,
        package_id: d.package_id,
      })
      .eq("project_id", d.project_id);
    if (cfgError) throw cfgError;
    const { error: verifiedError } = await supabaseAdmin
      .from("voice_studio_vapi_ledger")
      .update({ verified_at: new Date().toISOString() })
      .eq("project_id", d.project_id)
      .eq("kind", "assistant");
    if (verifiedError) throw verifiedError;
  }
  await finish(d, "succeeded", null, outcome.verification);
  return "succeeded";
}

async function finish(d: ClaimedDeployment, status: "succeeded" | "failed", error: string | null, verification: unknown): Promise<void> {
  const { error: updateError } = await supabaseAdmin
    .from("voice_studio_deployments")
    .update({
      status,
      last_error: error?.slice(0, 2000) ?? null,
      verification: (verification ?? null) as Json,
      completed_at: new Date().toISOString(),
    })
    .eq("id", d.id);
  if (updateError) console.error(`[voice-studio] could not close deployment ${d.id}: ${updateError.message}`);
  if (d.mode !== "dry_run") {
    const { error: projError } = await supabaseAdmin
      .from("voice_studio_projects")
      .update({ status: status === "succeeded" ? "deployed" : "package_approved" })
      .eq("id", d.project_id);
    if (projError) console.error(`[voice-studio] could not update project ${d.project_id}: ${projError.message}`);
  }
  await writeAuditLog({
    action: `voice_studio.deploy_${d.mode}_${status}`,
    entityType: "voice_studio_project",
    entityId: d.project_id,
    actorUserId: d.requested_by,
    metadata: { deployment_id: d.id, package_id: d.package_id, error },
  });
}
