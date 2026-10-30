import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  reconcileCloneEntitlements,
  drainPlanChangeReconciliations,
  seedPricingModuleMap,
  resolveClonePlan,
  classifyChange,
  readPricingLibrary,
} from "./entitlement-modules.server";
import {
  resolveEntitledModules,
  buildFullMapping,
  unplacedModules,
} from "@/lib/pricing/module-mapping";
import { MODULES } from "@/lib/pricing/aurixa-catalog";
import {
  listAddonPurchases,
  grantAddon,
  cancelAddon,
  syncFromStripeItems,
  type StripeLineItem,
} from "./addon-purchases.server";

/**
 * Bring one clone's installed modules in line with its billing plan.
 * `dryRun` reports the diff without writing.
 */
export const reconcileClone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; planSlug?: string; dryRun?: boolean }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) =>
    reconcileCloneEntitlements({
      supabase: context.supabase,
      options: {
        cloneId: data.cloneId,
        planSlug: data.planSlug,
        dryRun: data.dryRun ?? false,
        userId: context.userId,
      },
    }),
  );

/** Process every plan change whose modules have not been reconciled yet. */
export const drainPlanChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { limit?: number }) => data ?? {})
  .handler(async ({ data, context }) => {
    const res = await drainPlanChangeReconciliations({
      supabase: context.supabase,
      limit: data.limit ?? 25,
      userId: context.userId,
    });
    return {
      ok: true as const,
      processed: res.processed,
      failed: res.results.filter((r) => !r.ok).length,
      results: res.results,
    };
  });

/** Refresh the derived mapping, preserving operator overrides. */
export const seedModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const res = await seedPricingModuleMap({ supabase: context.supabase, userId: context.userId });
    return { ok: true as const, ...res };
  });

/**
 * The mapping table, for the operator-facing editor, and the library modules
 * no plan places (`unplacedModules`) — null, with the reason, when the library
 * could not be read, because a failed read is not "every module is placed".
 */
export const getModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [map, library] = await Promise.all([
      context.supabase
        .from("pricing_module_map")
        .select("*")
        .order("source_kind", { ascending: true })
        .order("source_slug", { ascending: true })
        .order("source_name", { ascending: true }),
      readPricingLibrary(context.supabase),
    ]);
    if (map.error) return { ok: false as const, error: map.error.message, rows: [] };
    return {
      ok: true as const,
      rows: map.data ?? [],
      unplaced: library.ok
        ? unplacedModules(new Set(library.catalogue.keys()), library.overrides)
        : null,
      unplacedError: library.ok ? null : library.error,
    };
  });

/** Take operator ownership of one mapping row. */
export const overrideModuleMap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; moduleSlugs: string[]; mappingKind?: string }) => {
    if (!data?.id) throw new Error("id required");
    if (!Array.isArray(data.moduleSlugs)) throw new Error("moduleSlugs required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("pricing_module_map")
      .update({
        module_slugs: data.moduleSlugs,
        mapping_kind: data.mappingKind ?? (data.moduleSlugs.length > 0 ? "installs" : "unmapped"),
        confidence: "manual",
        is_override: true,
        overridden_by: context.userId,
        overridden_at: new Date().toISOString(),
        reason: "Set by operator",
      })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "pricing_module_map.override",
      entity_type: "pricing_module_map",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: { module_slugs: data.moduleSlugs },
    });

    return { ok: true as const };
  });

/** Release an operator override so the row tracks the derived mapping again. */
export const clearModuleMapOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("pricing_module_map")
      .update({ is_override: false, overridden_by: null, overridden_at: null })
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

/**
 * Which technical modules a tier entitles a clone to — used by the clone
 * creation wizard to pre-select modules instead of making an operator tick
 * seventy-five boxes from memory.
 */
export const previewTierModules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { planSlug: string; purchasedAddons?: string[] }) => {
    if (!data?.planSlug) throw new Error("planSlug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const [{ data: modules }, { data: overrideRows }] = await Promise.all([
      context.supabase.from("modules").select("id, slug, name, layer").neq("status", "archived"),
      context.supabase
        .from("pricing_module_map")
        .select("source_kind, source_slug, source_name, module_slugs")
        .eq("is_override", true),
    ]);

    const known = new Set((modules ?? []).map((m) => m.slug as string));

    const overrides: Record<string, string[]> = {};
    for (const r of overrideRows ?? []) {
      const key =
        r.source_kind === "tier"
          ? `tier:${r.source_slug}:${String(r.source_name)
              .toLowerCase()
              .replace(/\//g, " ")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")}`
          : `module:${r.source_slug}`;
      overrides[key] = (r.module_slugs as string[]) ?? [];
    }

    const resolution = resolveEntitledModules({
      planSlug: data.planSlug,
      purchasedAddons: data.purchasedAddons ?? [],
      knownModules: known,
      overrides,
    });

    const idBySlug = new Map((modules ?? []).map((m) => [m.slug as string, m.id as string]));

    return {
      ok: true as const,
      ...resolution,
      moduleIds: resolution.moduleSlugs
        .map((s) => idBySlug.get(s))
        .filter((id): id is string => Boolean(id)),
    };
  });

/** Per-clone entitlement state plus its reconciliation history. */
export const getCloneEntitlements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const [{ data: clone }, { data: history }, plan] = await Promise.all([
      context.supabase
        .from("clones")
        // One literal — a concatenated select list is `string` to supabase-js,
        // which degrades the row to `GenericStringError`.
        // prettier-ignore
        .select(
          "id, name, entitled_plan_slug, entitled_module_slugs, revoked_module_slugs, purchased_addon_slugs, entitlement_keys, entitlements_synced_at",
        )
        .eq("id", data.cloneId)
        .maybeSingle(),
      context.supabase
        .from("clone_entitlement_reconciliations")
        .select("*")
        .eq("clone_id", data.cloneId)
        .order("created_at", { ascending: false })
        .limit(20),
      resolveClonePlan(context.supabase, data.cloneId),
    ]);

    if (!clone) return { ok: false as const, error: "Clone not found" };

    return {
      ok: true as const,
      clone,
      currentPlanSlug: plan.planSlug,
      /** Non-null when the live plan has drifted from the last reconciliation. */
      pendingDirection:
        plan.planSlug && plan.planSlug !== clone.entitled_plan_slug
          ? classifyChange(clone.entitled_plan_slug, plan.planSlug)
          : null,
      history: history ?? [],
    };
  });

/** Every add-on a clone holds, live and historical. */
export const listCloneAddons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const purchases = await listAddonPurchases(context.supabase, data.cloneId);
    return { ok: true as const, purchases, catalogue: MODULES };
  });

/**
 * Grant one add-on to a clone and apply it immediately — an add-on the
 * customer has paid for should not wait for the next plan change to arrive.
 */
export const grantCloneAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; addonSlug: string; notes?: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data?.addonSlug) throw new Error("addonSlug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const granted = await grantAddon({
      supabase: context.supabase,
      input: {
        cloneId: data.cloneId,
        addonSlug: data.addonSlug,
        source: "operator",
        notes: data.notes ?? null,
        userId: context.userId,
      },
    });
    if (!granted.ok) return { ok: false as const, error: granted.error };

    await context.supabase.from("audit_log").insert({
      action: "clone.addon_granted",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { addon_slug: data.addonSlug, already_held: granted.alreadyHeld ?? false },
    });

    const recon = await reconcileCloneEntitlements({
      supabase: context.supabase,
      options: { cloneId: data.cloneId, userId: context.userId, direction: "manual" },
    });
    return { ok: true as const, alreadyHeld: granted.alreadyHeld ?? false, reconciliation: recon };
  });

/**
 * Cancel an add-on. Consistent with a tier downgrade, this stops the
 * entitlement and leaves the module's files in place.
 */
export const cancelCloneAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; addonSlug: string; reason?: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data?.addonSlug) throw new Error("addonSlug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const res = await cancelAddon({
      supabase: context.supabase,
      cloneId: data.cloneId,
      addonSlug: data.addonSlug,
      reason: data.reason,
    });
    if (!res.ok) return { ok: false as const, error: res.error };

    await context.supabase.from("audit_log").insert({
      action: "clone.addon_cancelled",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { addon_slug: data.addonSlug, reason: data.reason ?? null },
    });

    const recon = await reconcileCloneEntitlements({
      supabase: context.supabase,
      options: { cloneId: data.cloneId, userId: context.userId, direction: "manual" },
    });
    return { ok: true as const, cancelled: res.cancelled, reconciliation: recon };
  });

/**
 * Reconcile a clone's add-ons against live Stripe subscription items.
 *
 * This is the entry point a line-item webhook calls. Idempotent on the
 * subscription item id, so a replayed delivery converges instead of granting
 * the same add-on twice.
 */
export const syncCloneAddonsFromStripe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; items: StripeLineItem[] }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!Array.isArray(data.items)) throw new Error("items required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const res = await syncFromStripeItems({
      supabase: context.supabase,
      cloneId: data.cloneId,
      items: data.items,
      userId: context.userId,
    });

    if (res.granted.length > 0 || res.cancelled.length > 0) {
      await reconcileCloneEntitlements({
        supabase: context.supabase,
        options: { cloneId: data.cloneId, userId: context.userId, direction: "manual" },
      });
    }
    return res;
  });

/** The derived mapping, without touching the database — for previews. */
export const previewDerivedMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: modules } = await context.supabase
      .from("modules")
      .select("slug")
      .neq("status", "archived");
    const known = new Set((modules ?? []).map((m) => m.slug as string));
    return { ok: true as const, rows: buildFullMapping(known) };
  });
