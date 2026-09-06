// User-facing server functions for the white-label branding system.
// All functions require an authenticated operator. Mutations also write
// audit_log + notifications to keep the bell + audit trail in sync with
// the rest of the cascade pipeline.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  applyBrandToClone,
  hashBrandBundle,
  type BrandAsset,
  type BrandConfig,
  type ReportContact,
  type ApplyBrandResult,
} from "./branding.server";
import { assessBlastRadius } from "@/lib/blast-radius";
import { BRAND_MARK_SLOTS } from "@/lib/brand/marks";

type Json = Database["public"]["Tables"]["clone_brand_profiles"]["Insert"]["brand_config"];

// Slug helper — keeps profile slugs URL-safe and unique-friendly.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ─── List ─────────────────────────────────────────────────────────────

export const listBrandProfiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clone_brand_profiles")
      .select("*")
      .order("is_default", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) return { ok: false as const, error: error.message, profiles: [] };
    return { ok: true as const, profiles: data ?? [] };
  });

export const listBrandAssignments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clone_brand_assignments")
      .select("*, clones(id, name, slug), clone_brand_profiles(id, name, slug, version)")
      .order("updated_at", { ascending: false });
    if (error) return { ok: false as const, error: error.message, assignments: [] };
    return { ok: true as const, assignments: data ?? [] };
  });

export const listBrandHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId?: string; limit?: number }) => data ?? {})
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("clone_brand_history")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 50, 200));
    if (data.cloneId) q = q.eq("clone_id", data.cloneId);
    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message, history: [] };
    return { ok: true as const, history: rows ?? [] };
  });

/**
 * The brand marks this one workspace holds, and the ones it does not.
 *
 * Read per clone rather than off the fleet list because this is the question an
 * operator asks while provisioning: *has this workspace got a logo yet, and
 * will its documents carry one?* Those were different answers for a long time
 * — the cascade filled the interface columns and never `logo_config`, which is
 * the map every generated document reads.
 *
 * Reports what is ABSENT, never what is broken. A workspace with no report mark
 * still gets a branded document: the renderer walks
 * `report → sidebar → auth → sidebarIcon`.
 */
export const getCloneBrandMarks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: assignment, error } = await context.supabase
      .from("clone_brand_assignments")
      .select(
        "profile_id, status, applied_at, clone_brand_profiles(id, name, slug, version, brand_config)",
      )
      .eq("clone_id", data.cloneId)
      .maybeSingle();

    if (error) {
      // A read that FAILED is not a workspace with no brand.
      return { ok: false as const, error: error.message };
    }
    if (!assignment) {
      return {
        ok: true as const,
        assigned: false as const,
        slots: BRAND_MARK_SLOTS.map((slot) => ({ ...slot, url: null as string | null })),
      };
    }

    const profile =
      (
        assignment as {
          clone_brand_profiles?: {
            id: string;
            name: string;
            version: number;
            brand_config: unknown;
          } | null;
        }
      ).clone_brand_profiles ?? null;
    const config = (profile?.brand_config ?? {}) as BrandConfig;

    return {
      ok: true as const,
      assigned: true as const,
      status: assignment.status,
      appliedAt: assignment.applied_at,
      profile: profile ? { id: profile.id, name: profile.name, version: profile.version } : null,
      slots: BRAND_MARK_SLOTS.map((slot) => {
        const value = config[slot.field];
        return { ...slot, url: typeof value === "string" && value.trim() ? value.trim() : null };
      }),
    };
  });

// ─── Create / update profile ─────────────────────────────────────────

export const upsertBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      id?: string;
      name: string;
      slug?: string;
      description?: string | null;
      brand_config: BrandConfig;
      report_contact: ReportContact;
      asset_manifest?: BrandAsset[];
      tags?: string[];
      is_default?: boolean;
    }) => {
      if (!data?.name?.trim()) throw new Error("name required");
      if (!data?.brand_config) throw new Error("brand_config required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const slug = data.slug?.trim() || slugify(data.name);
    const config_hash = hashBrandBundle({
      brand_config: data.brand_config,
      report_contact: data.report_contact ?? {},
      asset_manifest: data.asset_manifest ?? [],
    });

    if (data.is_default) {
      // Demote any current default before promoting this one (the unique
      // partial index would reject otherwise).
      await context.supabase
        .from("clone_brand_profiles")
        .update({ is_default: false })
        .eq("is_default", true);
    }

    const payload = {
      name: data.name.trim(),
      slug,
      description: data.description ?? null,
      brand_config: data.brand_config as unknown as Json,
      report_contact: data.report_contact as unknown as Json,
      asset_manifest: (data.asset_manifest ?? []) as unknown as Json,
      tags: data.tags ?? [],
      is_default: data.is_default ?? false,
      config_hash,
      created_by: context.userId,
    };

    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("clone_brand_profiles")
        .update(payload)
        .eq("id", data.id)
        .select()
        .maybeSingle();
      if (error) return { ok: false as const, error: error.message };
      await context.supabase.from("audit_log").insert({
        action: "brand.profile_updated",
        entity_type: "clone_brand_profile",
        entity_id: data.id,
        actor_user_id: context.userId,
        metadata: { slug, hash: config_hash },
      });
      return { ok: true as const, profile: row };
    }

    const { data: row, error } = await context.supabase
      .from("clone_brand_profiles")
      .insert(payload)
      .select()
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    await context.supabase.from("audit_log").insert({
      action: "brand.profile_created",
      entity_type: "clone_brand_profile",
      entity_id: row?.id ?? null,
      actor_user_id: context.userId,
      metadata: { slug, hash: config_hash },
    });
    return { ok: true as const, profile: row };
  });

// ─── Duplicate ───────────────────────────────────────────────────────
export const duplicateBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; newName?: string }) => {
    if (!d?.profileId) throw new Error("profileId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { data: src, error: e1 } = await context.supabase
      .from("clone_brand_profiles")
      .select("*")
      .eq("id", data.profileId)
      .maybeSingle();
    if (e1 || !src) return { ok: false as const, error: e1?.message ?? "Profile not found" };
    const name = (data.newName?.trim() || `${src.name} (copy)`).slice(0, 80);
    const slug = `${slugify(name)}-${Date.now().toString(36).slice(-4)}`;
    const { data: row, error } = await context.supabase
      .from("clone_brand_profiles")
      .insert({
        name,
        slug,
        description: src.description,
        brand_config: src.brand_config,
        report_contact: src.report_contact,
        asset_manifest: src.asset_manifest,
        tags: src.tags,
        is_default: false,
        status: "draft",
        config_hash: src.config_hash,
        created_by: context.userId,
      })
      .select()
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    await context.supabase.from("audit_log").insert({
      action: "brand.profile_duplicated",
      entity_type: "clone_brand_profile",
      entity_id: row?.id ?? null,
      actor_user_id: context.userId,
      metadata: { source_id: data.profileId, slug },
    });
    return { ok: true as const, profile: row };
  });

// ─── Publish / archive ───────────────────────────────────────────────

export const setBrandProfileStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string; status: "draft" | "published" | "archived" }) => {
    if (!data?.profileId) throw new Error("profileId required");
    if (!["draft", "published", "archived"].includes(data.status))
      throw new Error("invalid status");
    return data;
  })
  .handler(async ({ data, context }) => {
    const update: Database["public"]["Tables"]["clone_brand_profiles"]["Update"] = {
      status: data.status,
    };
    if (data.status === "published") {
      update.published_at = new Date().toISOString();
      update.published_by = context.userId;
    }
    const { data: row, error } = await context.supabase
      .from("clone_brand_profiles")
      .update(update)
      .eq("id", data.profileId)
      .select("id, name, slug, version, status")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: `brand.profile_${data.status}`,
      entity_type: "clone_brand_profile",
      entity_id: data.profileId,
      actor_user_id: context.userId,
      metadata: { status: data.status },
    });
    return { ok: true as const, profile: row };
  });

// ─── Assign profile to clones ────────────────────────────────────────

export const assignBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneIds: string[]; profileId: string }) => {
    if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
      throw new Error("cloneIds required");
    if (!data?.profileId) throw new Error("profileId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const rows = data.cloneIds.map((id) => ({
      clone_id: id,
      profile_id: data.profileId,
      status: "pending" as const,
    }));
    const { error } = await context.supabase
      .from("clone_brand_assignments")
      .upsert(rows, { onConflict: "clone_id" });
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "brand.assigned",
      entity_type: "clone_brand_profile",
      entity_id: data.profileId,
      actor_user_id: context.userId,
      metadata: { clone_count: data.cloneIds.length },
    });
    return { ok: true as const, count: data.cloneIds.length };
  });

// ─── Apply: push the brand to one or many clones ─────────────────────

export const applyBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { cloneIds: string[]; profileId: string; cascadeEventId?: string | null }) => {
      if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
        throw new Error("cloneIds required");
      if (!data?.profileId) throw new Error("profileId required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    // Reuse the existing blast-radius gate. Branding pushes count as
    // "auto_merge" semantics — they apply directly and irreversibly.
    const blast = assessBlastRadius("auto_merge", data.cloneIds.length);
    if (blast.requiresApproval) {
      return {
        ok: false as const,
        error: blast.reason ?? "Approval required",
        requiresApproval: true,
        cloneCount: blast.cloneCount,
        results: [] as ApplyBrandResult[],
      };
    }

    // Create (or reuse) a cascade_events row so brand pushes appear in
    // /cascades alongside code cascades. Single-clone pushes still create
    // an event for full auditability.
    let cascadeEventId = data.cascadeEventId ?? null;
    if (!cascadeEventId) {
      const { data: profileRow } = await context.supabase
        .from("clone_brand_profiles")
        .select("name, slug, version, config_hash")
        .eq("id", data.profileId)
        .maybeSingle();
      const { data: ev, error: evErr } = await context.supabase
        .from("cascade_events")
        .insert({
          trigger: "manual",
          mode: "auto_merge",
          status: "running",
          requires_approval: false,
          initiated_by: context.userId,
          started_at: new Date().toISOString(),
          source_branch: null,
          source_sha: profileRow?.config_hash ?? null,
          summary: `Brand cascade · ${profileRow?.name ?? "profile"} v${profileRow?.version ?? "?"} → ${data.cloneIds.length} clone(s)`,
          scope_filter: {
            kind: "brand_sync",
            profile_id: data.profileId,
            profile_slug: profileRow?.slug ?? null,
            clone_ids: data.cloneIds,
          },
        })
        .select("id")
        .maybeSingle();
      if (!evErr && ev) cascadeEventId = ev.id;
    }

    const results: ApplyBrandResult[] = [];
    for (const cloneId of data.cloneIds) {
      const r = await applyBrandToClone(context.supabase, {
        cloneId,
        profileId: data.profileId,
        actorUserId: context.userId,
        cascadeEventId,
      });
      results.push(r);

      // Mirror per-clone outcome into cascade_results so /cascades/$eventId
      // renders the breakdown using the same components as code cascades.
      if (cascadeEventId) {
        await context.supabase.from("cascade_results").insert({
          cascade_event_id: cascadeEventId,
          clone_id: cloneId,
          status: r.ok ? "succeeded" : "failed",
          started_at: new Date(Date.now() - r.durationMs).toISOString(),
          completed_at: new Date().toISOString(),
          diff_summary: r.ok
            ? `Brand hash ${r.configHash.slice(0, 8)} · ${r.assetsUploaded} asset(s)`
            : null,
          error_message: r.ok ? null : r.error,
          files_changed: r.ok ? r.assetsUploaded : 0,
        });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    if (cascadeEventId) {
      const finalStatus = failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";
      await context.supabase
        .from("cascade_events")
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          summary: `Brand cascade · ${succeeded}/${results.length} clones succeeded`,
        })
        .eq("id", cascadeEventId);
    }

    await context.supabase.from("audit_log").insert({
      action: "brand.applied",
      entity_type: "clone_brand_profile",
      entity_id: data.profileId,
      actor_user_id: context.userId,
      metadata: { succeeded, failed, total: results.length, cascade_event_id: cascadeEventId },
    });

    await context.supabase.from("notifications").insert({
      kind: failed === 0 ? "cascade_completed" : "cascade_partial",
      severity: failed === 0 ? "success" : "warning",
      title: `Brand cascade · ${succeeded}/${results.length} clones`,
      body:
        failed === 0
          ? `Brand applied to ${succeeded} clone(s).`
          : `${succeeded} succeeded, ${failed} failed. See branding history for details.`,
      url: cascadeEventId ? `/cascades/${cascadeEventId}` : "/branding",
      cascade_event_id: cascadeEventId,
      metadata: { profile_id: data.profileId, succeeded, failed },
    });

    return { ok: true as const, results, succeeded, failed, cascadeEventId };
  });

// ─── Drift check: read clones' current hash and compare to assignment ─

export const checkBrandDrift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneIds?: string[] }) => data ?? {})
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("clone_brand_assignments")
      .select(
        "clone_id, profile_id, applied_config_hash, clone_brand_profiles(config_hash, version)",
      );
    if (data.cloneIds && data.cloneIds.length > 0) q = q.in("clone_id", data.cloneIds);
    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message, drifted: [] };

    type Row = {
      clone_id: string;
      profile_id: string;
      applied_config_hash: string | null;
      clone_brand_profiles: { config_hash: string | null; version: number } | null;
    };

    const drifted: Array<{ cloneId: string; profileId: string; reason: string }> = [];
    for (const r of (rows ?? []) as Row[]) {
      const profileHash = r.clone_brand_profiles?.config_hash ?? null;
      if (!r.applied_config_hash) {
        drifted.push({ cloneId: r.clone_id, profileId: r.profile_id, reason: "Never applied" });
        continue;
      }
      if (profileHash && profileHash !== r.applied_config_hash) {
        drifted.push({
          cloneId: r.clone_id,
          profileId: r.profile_id,
          reason: "Profile updated since last apply",
        });
      }
    }

    if (drifted.length > 0) {
      const driftedIds = drifted.map((d) => d.cloneId);
      await context.supabase
        .from("clone_brand_assignments")
        .update({
          status: "drifted",
          last_drift_check_at: new Date().toISOString(),
          drift_summary: "Profile changed since last apply",
        })
        .in("clone_id", driftedIds);
    }

    return { ok: true as const, drifted, scanned: rows?.length ?? 0 };
  });

// ─── Delete profile (admin via RLS) ──────────────────────────────────

export const deleteBrandProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { profileId: string }) => {
    if (!data?.profileId) throw new Error("profileId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clone_brand_profiles")
      .delete()
      .eq("id", data.profileId);
    if (error) return { ok: false as const, error: error.message };
    await context.supabase.from("audit_log").insert({
      action: "brand.profile_deleted",
      entity_type: "clone_brand_profile",
      entity_id: data.profileId,
      actor_user_id: context.userId,
    });
    return { ok: true as const };
  });
