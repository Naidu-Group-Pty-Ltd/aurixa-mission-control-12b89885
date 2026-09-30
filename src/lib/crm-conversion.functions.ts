// Moving a clone from one CRM line to the other — the clone page's four calls.
//
// Admin-gated, every one: a conversion opens a pull request on a customer's
// repository that, once merged, changes which CRM their deployment talks to.
// The reads and writes go through the service role, because the engine reads
// tables (`clone_backends_safe`, `clone_sync_exclusions`) the way every
// cascade reads them; the role check above them is what decides who may ask.
//
// Every decision is `src/server/crmConversion.pure.ts`'s. Nothing here
// decides anything — it validates the request, calls the server module and
// writes an audit row for the two acts that change something.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value.trim())) {
    throw new Error(`${name} must be a uuid`);
  }
  return value.trim();
}

function requireMode(value: unknown): "dependent" | "independent" {
  if (value !== "dependent" && value !== "independent") {
    throw new Error(`toMode must be "dependent" or "independent"`);
  }
  return value;
}

async function deps() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { getAppOctokit } = await import(
    /* @vite-ignore */ "@/lib/_server-shims/github-app.server"
  );
  const mod = await import(/* @vite-ignore */ "@/lib/_server-shims/crmConversion.server");
  return { supabase: supabaseAdmin, octokit: getAppOctokit(), mod };
}

/** What a conversion would do, rehearsed by the engine. Writes nothing. */
export const previewCrmConversion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; toMode: string }) => ({
    cloneId: requireId(input?.cloneId, "cloneId"),
    toMode: requireMode(input?.toMode),
  }))
  .handler(async ({ data }) => {
    const { supabase, octokit, mod } = await deps();
    const preview = await mod.previewCrmConversion({
      supabase,
      octokit,
      cloneId: data.cloneId,
      toMode: data.toMode,
    });
    return JSON.parse(JSON.stringify(preview)) as typeof preview;
  });

/** Propose the conversion: one pull request on the clone, never merged by the platform. */
export const startCrmConversion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; toMode: string }) => ({
    cloneId: requireId(input?.cloneId, "cloneId"),
    toMode: requireMode(input?.toMode),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, octokit, mod } = await deps();
    const result = await mod.startCrmConversion({
      supabase,
      octokit,
      cloneId: data.cloneId,
      toMode: data.toMode,
      requestedBy: context.userId,
    });
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: result.ok ? "crm_conversion_started" : "crm_conversion_refused",
      entityType: "clone",
      entityId: data.cloneId,
      actorUserId: context.userId,
      metadata: { toMode: data.toMode, ...result },
    });
    return result;
  });

/** Close an open proposal. A merged conversion is finished, never cancelled. */
export const cancelCrmConversion = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { conversionId: string; cloneId: string }) => ({
    conversionId: requireId(input?.conversionId, "conversionId"),
    cloneId: requireId(input?.cloneId, "cloneId"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, octokit, mod } = await deps();
    const result = await mod.cancelCrmConversion({
      supabase,
      octokit,
      conversionId: data.conversionId,
    });
    if (result.ok) {
      const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
      await writeAuditLog({
        action: "crm_conversion_cancelled",
        entityType: "clone",
        entityId: data.cloneId,
        actorUserId: context.userId,
        metadata: { conversionId: data.conversionId },
      });
    }
    return result;
  });

/** The clone's conversions, newest first. */
export const listCrmConversions = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string }) => ({
    cloneId: requireId(input?.cloneId, "cloneId"),
  }))
  .handler(async ({ data }) => {
    const { supabase, mod } = await deps();
    const rows = await mod.listCloneConversions(supabase, data.cloneId);
    return JSON.parse(JSON.stringify(rows)) as typeof rows;
  });
