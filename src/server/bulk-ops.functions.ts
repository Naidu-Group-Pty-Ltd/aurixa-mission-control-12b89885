// Cross-domain bulk CRUD operations.
// Each handler validates input with Zod, performs the operation as the caller
// (RLS still enforces authorisation), and writes a single audit_log entry.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { Constants } from "@/integrations/supabase/types";
import { NOTIFICATION_KIND_FILTER_VALUES } from "@/lib/notificationKinds.pure";
import { bulkMarkByIds, bulkMarkMatching } from "./notificationBulkRead.server";
import { decideLibraryEntries } from "./libraryApproval.server";

const idArray = z.array(z.string().uuid()).min(1).max(200);

// ─── Schedules ────────────────────────────────────────────────────────

export const bulkUpdateSchedules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[]; enabled: boolean }) =>
    z.object({ ids: idArray, enabled: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("cascade_schedules")
      .update({ enabled: data.enabled })
      .in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: data.enabled ? "schedules.bulk_enabled" : "schedules.bulk_disabled",
      entity_type: "cascade_schedule",
      actor_user_id: userId,
      metadata: { count: data.ids.length, ids: data.ids },
    });
    return { ok: true as const, count: data.ids.length };
  });

export const bulkDeleteSchedules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("cascade_schedules").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "schedules.bulk_deleted",
      entity_type: "cascade_schedule",
      actor_user_id: userId,
      metadata: { count: data.ids.length, ids: data.ids },
    });
    return { ok: true as const, count: data.ids.length };
  });

// ─── Notifications ────────────────────────────────────────────────────

export const bulkDeleteNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("notifications").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "notifications.bulk_deleted",
      entity_type: "notification",
      actor_user_id: userId,
      metadata: { count: data.ids.length },
    });
    return { ok: true as const, count: data.ids.length };
  });

// Every bulk mark goes through `notificationBulkRead.server.ts`, which never
// changes a `cascade_blocked` notice: an unread one is the blockage ledger's
// record of a standing CI refusal, and it clears itself when its pull request
// closes. "Mark page read" and the bell's "Mark all read" call this one.
export const bulkMarkNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[]; read: boolean }) =>
    z.object({ ids: idArray, read: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => bulkMarkByIds(context.supabase, data.ids, data.read));

// "Mark all matching" on the inbox, with the page's filters as it holds them.
export const markAllMatchingNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { kind: string; severity: string; clone: string; scope: "attention" | "everything" }) =>
      z
        .object({
          kind: z.enum(NOTIFICATION_KIND_FILTER_VALUES),
          severity: z.enum(["all", ...Constants.public.Enums.notification_severity] as const),
          clone: z.union([z.literal("all"), z.string().uuid()]),
          scope: z.enum(["attention", "everything"]),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => bulkMarkMatching(context.supabase, data));

export const purgeReadNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { olderThanDays?: number }) =>
    z.object({ olderThanDays: z.number().int().min(1).max(365).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const cutoff = new Date(Date.now() - (data.olderThanDays ?? 30) * 86_400_000).toISOString();
    const { error, count } = await supabase
      .from("notifications")
      .delete({ count: "exact" })
      .not("read_at", "is", null)
      .lte("read_at", cutoff);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "notifications.purged",
      entity_type: "notification",
      actor_user_id: userId,
      metadata: { older_than_days: data.olderThanDays ?? 30, deleted: count ?? 0 },
    });
    return { ok: true as const, deleted: count ?? 0 };
  });

// ─── Cascade templates ────────────────────────────────────────────────

export const bulkDeleteCascadeTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("cascade_templates").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "cascade_templates.bulk_deleted",
      entity_type: "cascade_template",
      actor_user_id: userId,
      metadata: { count: data.ids.length },
    });
    return { ok: true as const, count: data.ids.length };
  });

// ─── Module library ───────────────────────────────────────────────────

export const bulkSetLibraryApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { ids: string[]; status: "approved" | "rejected" | "pending"; reason?: string }) =>
      z
        .object({
          ids: idArray,
          status: z.enum(["approved", "rejected", "pending"]),
          reason: z.string().optional(),
        })
        .parse(d),
  )
  // Admin only, and approving needs the commit each entry records: an entry is
  // approved at a commit (`libraryApproval.server.ts`, D19).
  .handler(async ({ data, context }) =>
    decideLibraryEntries(context.supabase, {
      userId: context.userId,
      ids: data.ids,
      status: data.status,
      reason: data.reason,
    }),
  );

export const bulkDeprecateLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[]; reason?: string; replacementSlug?: string }) =>
    z
      .object({
        ids: idArray,
        reason: z.string().optional(),
        replacementSlug: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_library")
      .update({
        deprecated_at: new Date().toISOString(),
        deprecated_reason: data.reason ?? null,
        replacement_slug: data.replacementSlug ?? null,
      })
      .in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "library.bulk_deprecated",
      entity_type: "module_library",
      actor_user_id: userId,
      metadata: {
        count: data.ids.length,
        reason: data.reason,
        replacementSlug: data.replacementSlug,
      },
    });
    return { ok: true as const, count: data.ids.length };
  });

export const bulkDeleteLibraryEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("module_library").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "library.bulk_deleted",
      entity_type: "module_library",
      actor_user_id: userId,
      metadata: { count: data.ids.length },
    });
    return { ok: true as const, count: data.ids.length };
  });

// ─── Brand profiles ───────────────────────────────────────────────────

export const bulkSetBrandProfileStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[]; status: "draft" | "published" | "archived" }) =>
    z.object({ ids: idArray, status: z.enum(["draft", "published", "archived"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const patch =
      data.status === "published"
        ? { status: data.status, published_at: new Date().toISOString(), published_by: userId }
        : { status: data.status };
    const { error } = await supabase.from("clone_brand_profiles").update(patch).in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: `brand_profiles.bulk_${data.status}`,
      entity_type: "clone_brand_profile",
      actor_user_id: userId,
      metadata: { count: data.ids.length, ids: data.ids },
    });
    return { ok: true as const, count: data.ids.length };
  });

export const bulkDeleteBrandProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("clone_brand_profiles").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "brand_profiles.bulk_deleted",
      entity_type: "clone_brand_profile",
      actor_user_id: userId,
      metadata: { count: data.ids.length },
    });
    return { ok: true as const, count: data.ids.length };
  });

// ─── Cloudflare ───────────────────────────────────────────────────────

export const bulkDetachCloudflareZones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[] }) => z.object({ cloneIds: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error: e1 } = await supabase
      .from("cloudflare_clone_config")
      .delete()
      .in("clone_id", data.cloneIds);
    if (e1) return { ok: false as const, error: e1.message };
    await supabase
      .from("clones")
      .update({ cloudflare_enabled: false, cloudflare_zone_id: null })
      .in("id", data.cloneIds);
    await supabase.from("audit_log").insert({
      action: "cloudflare.bulk_detached",
      entity_type: "cloudflare_clone_config",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, ids: data.cloneIds },
    });
    return { ok: true as const, count: data.cloneIds.length };
  });

// ─── Drift suggestions ────────────────────────────────────────────────

export const bulkDismissDriftSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { alertIds: string[] }) => z.object({ alertIds: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("module_drift_alerts")
      .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: userId })
      .in("id", data.alertIds);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, count: data.alertIds.length };
  });

// ─── Detection runs ───────────────────────────────────────────────────

export const bulkDeleteDetectionRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { ids: string[] }) => z.object({ ids: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Cascade: drift alerts and import edges share a detection_run_id.
    await supabase.from("module_drift_alerts").delete().in("detection_run_id", data.ids);
    await supabase.from("module_import_edges").delete().in("detection_run_id", data.ids);
    const { error } = await supabase.from("module_detection_runs").delete().in("id", data.ids);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "detection_runs.bulk_deleted",
      entity_type: "module_detection_run",
      actor_user_id: userId,
      metadata: { count: data.ids.length },
    });
    return { ok: true as const, count: data.ids.length };
  });

// ─── Library pins (per-clone bulk unpin) ──────────────────────────────

export const bulkRemoveLibraryPins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { pinIds: string[] }) => z.object({ pinIds: idArray }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("clone_library_pins").delete().in("id", data.pinIds);
    if (error) return { ok: false as const, error: error.message };
    await supabase.from("audit_log").insert({
      action: "library_pins.bulk_removed",
      entity_type: "clone_library_pin",
      actor_user_id: userId,
      metadata: { count: data.pinIds.length },
    });
    return { ok: true as const, count: data.pinIds.length };
  });

// ─── Audit log retention ──────────────────────────────────────────────

export const purgeAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { olderThanDays: number }) =>
    z.object({ olderThanDays: z.number().int().min(7).max(365) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const isAdmin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (!isAdmin.data) return { ok: false as const, error: "Admin role required" };
    const cutoff = new Date(Date.now() - data.olderThanDays * 86_400_000).toISOString();
    const { error, count } = await supabase
      .from("audit_log")
      .delete({ count: "exact" })
      .lte("created_at", cutoff);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, deleted: count ?? 0 };
  });
