// Per-clone Anthropic attribution — the operator surface over the identity
// ledger and the self-test. Admin-only: the probe crosses a tenant's own
// Mission Control key and the reading names their workspace.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/**
 * What this clone's Anthropic identity currently says.
 *
 * A row that does not exist is a real state — a clone provisioned before
 * workspaces, or one whose tenant supplied their own key — and is reported as
 * absent rather than as a fault.
 */
export const getCloneAnthropicIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("clone_anthropic_identity")
      .select(
        "clone_id, workspace_id, workspace_name, service_account_id, federation_rule_id, federation_issuer_id, federated_at, verified_at, last_error, updated_at",
      )
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    // A failed read is not an absent identity, and collapsing the two would
    // offer "provision a workspace" for a clone that already has one.
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, row: row ?? null };
  });

/**
 * Give this clone its own Anthropic workspace, or adopt the one it has.
 *
 * Safe to call repeatedly: the provisioner finds by name before creating, so a
 * second press cannot spend the organisation's workspace allowance twice or
 * split one tenant's spend across two lines.
 */
export const provisionCloneAnthropicWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { provisionAnthropicWorkspace } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/anthropicWorkspace.server"
    );
    const res = await provisionAnthropicWorkspace(context.supabase, data.cloneId, {
      actorUserId: context.userId,
    });
    // Through the helper rather than a raw insert: it branches on the error
    // and never throws, so a failed audit write cannot fail the act it records.
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: "clone_anthropic.provision_workspace",
      entityType: "clone",
      entityId: data.cloneId,
      actorUserId: context.userId,
      metadata: {
        provisioned: res.provisioned,
        workspace_id: res.workspaceId ?? null,
        reason: res.provisioned ? null : (res.reason ?? null),
      },
    });
    return res;
  });

/**
 * Ask the clone to prove it can reach Anthropic.
 *
 * Costs nothing at either end — a federated exchange is not billable and the
 * model list is metadata — and writes only the verification stamp. It is
 * deliberately a call rather than a flag: five things sit between a clone's
 * edge function and a credential, and none of them is visible from here.
 */
export const runCloneAnthropicSelftestFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { runCloneAnthropicSelftest } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/anthropicSelftest.server"
    );
    const res = await runCloneAnthropicSelftest(data.cloneId);
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: "clone_anthropic.selftest",
      entityType: "clone",
      entityId: data.cloneId,
      actorUserId: context.userId,
      // The reading itself, never a credential: the probe is built so there is
      // no value in it to log by accident.
      metadata: res.ok
        ? { ok: true, route: res.reach.route, reached: res.reach.ok, end: res.reach.end }
        : { ok: false, reason: res.reason },
    });
    return res;
  });
