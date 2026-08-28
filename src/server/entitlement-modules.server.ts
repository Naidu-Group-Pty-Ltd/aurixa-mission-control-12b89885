/**
 * Tier → module reconciliation.
 *
 * Keeps a clone's installed technical modules in step with what its billing
 * plan entitles it to, so a tier change on the Aurixa Systems pricing page
 * actually moves code and not just money.
 *
 * The asymmetry is deliberate and is the whole design:
 *
 *   upgrade   — install the newly entitled modules. The customer has paid;
 *               withholding access is the expensive failure.
 *   downgrade — record the revocation and leave every file in place. The
 *               clone gates those features on its entitlement flags, so access
 *               stops immediately, nothing in flight breaks, and a re-upgrade
 *               is instant rather than a full re-cascade. Ripping migrations
 *               and shared tables back out could not be done safely anyway.
 *
 * Reconciliation is idempotent: it is keyed on the plan-change event, so a
 * duplicate webhook or a retry re-computes the same diff and writes nothing
 * new.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveEntitledModules,
  applyContractExclusions,
  diffModules,
  buildFullMapping,
  type EntitlementResolution,
} from "@/lib/pricing/module-mapping";
import { TIERS } from "@/lib/pricing/aurixa-catalog";
import { activeAddonSlugs } from "./addon-purchases.server";

type Supabase = SupabaseClient<Database>;

export type ReconcileDirection = "upgrade" | "downgrade" | "lateral" | "initial" | "manual";

export type ReconcileResult = {
  ok: boolean;
  error?: string;
  cloneId: string;
  fromPlanSlug: string | null;
  toPlanSlug: string;
  direction: ReconcileDirection;
  installed: string[];
  revoked: string[];
  unchanged: number;
  entitlementKeys: string[];
  unmapped: EntitlementResolution["unmapped"];
  reconciliationId?: string;
  dryRun: boolean;
};

/** Rank a plan on the tier ladder; -1 for anything not on it. */
export function tierRank(planSlug: string | null | undefined): number {
  if (!planSlug) return -1;
  return TIERS.findIndex((t) => t.slug === planSlug);
}

/**
 * Which way a plan moved. Anything off the tier ladder is "lateral" — we know
 * the plan changed but not that it went up, and treating an unknown move as an
 * upgrade would install modules nobody bought.
 */
export function classifyChange(
  fromPlanSlug: string | null | undefined,
  toPlanSlug: string,
): ReconcileDirection {
  if (!fromPlanSlug) return "initial";
  const from = tierRank(fromPlanSlug);
  const to = tierRank(toPlanSlug);
  if (from === -1 || to === -1) return "lateral";
  if (to > from) return "upgrade";
  if (to < from) return "downgrade";
  return "lateral";
}

/** Live technical module slugs, keyed by slug → id for install writes. */
async function loadCatalogue(supabase: Supabase): Promise<Map<string, string>> {
  const { data } = await supabase.from("modules").select("id, slug").neq("status", "archived");
  return new Map(((data ?? []) as Array<{ id: string; slug: string }>).map((m) => [m.slug, m.id]));
}

/** Operator overrides, as `${kind}:${slug}` → technical slugs. */
async function loadOverrides(supabase: Supabase): Promise<Record<string, string[]>> {
  const { data } = await supabase
    .from("pricing_module_map")
    .select("source_kind, source_slug, source_name, module_slugs, mapping_kind, is_override")
    .eq("is_override", true);

  const out: Record<string, string[]> = {};
  for (const row of (data ?? []) as Array<{
    source_kind: string;
    source_slug: string;
    source_name: string;
    module_slugs: string[] | null;
    mapping_kind: string;
  }>) {
    const key =
      row.source_kind === "tier"
        ? `tier:${row.source_slug}:${slugifyName(row.source_name)}`
        : `module:${row.source_slug}`;
    out[key] = row.module_slugs ?? [];
  }
  return out;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\//g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The plan a clone is currently on, via its tenant's billing plan. */
export async function resolveClonePlan(
  supabase: Supabase,
  cloneId: string,
): Promise<{ planSlug: string | null; tenantId: string | null }> {
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, plan_id")
    .eq("clone_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!tenant?.plan_id) return { planSlug: null, tenantId: tenant?.id ?? null };

  const { data: plan } = await supabase
    .from("billing_plans")
    .select("slug")
    .eq("id", tenant.plan_id)
    .maybeSingle();

  return { planSlug: plan?.slug ?? null, tenantId: tenant.id };
}

/**
 * Priced add-ons a clone currently holds.
 *
 * Read from `clone_addon_purchases` — current state with a status lifecycle —
 * rather than the `purchases` event log, which never retracts and would keep a
 * cancelled add-on entitling code forever. `past_due` still entitles, so a
 * failed card does not strip features mid-period.
 */
async function loadPurchasedAddons(supabase: Supabase, cloneId: string): Promise<string[]> {
  return activeAddonSlugs(supabase, cloneId);
}

export type ReconcileOptions = {
  cloneId: string;
  /** Overrides the plan looked up from the tenant. */
  planSlug?: string;
  fromPlanSlug?: string | null;
  planChangeEventId?: string;
  direction?: ReconcileDirection;
  /** Compute and report the diff without writing anything. */
  dryRun?: boolean;
  userId?: string;
};

/**
 * Bring one clone's installed modules in line with its plan.
 *
 * Writes `clone_modules` for newly entitled modules, records revocations on
 * the clone without touching files, and stores the entitlement keys the clone
 * gates its UI on.
 */
export async function reconcileCloneEntitlements(args: {
  supabase: Supabase;
  options: ReconcileOptions;
}): Promise<ReconcileResult> {
  const { supabase, options } = args;
  const { cloneId, dryRun = false } = options;

  const base: ReconcileResult = {
    ok: false,
    cloneId,
    fromPlanSlug: options.fromPlanSlug ?? null,
    toPlanSlug: options.planSlug ?? "",
    direction: options.direction ?? "manual",
    installed: [],
    revoked: [],
    unchanged: 0,
    entitlementKeys: [],
    unmapped: [],
    dryRun,
  };

  // ── Resolve the plan ──
  let planSlug = options.planSlug ?? null;
  if (!planSlug) {
    const resolved = await resolveClonePlan(supabase, cloneId);
    planSlug = resolved.planSlug;
  }
  if (!planSlug) {
    return { ...base, error: "Clone has no billing plan — nothing to reconcile against" };
  }
  base.toPlanSlug = planSlug;

  // ── Current state ──
  const { data: clone } = await supabase
    .from("clones")
    .select("id, entitled_plan_slug, revoked_module_slugs, contract_excluded_module_slugs")
    .eq("id", cloneId)
    .maybeSingle();
  if (!clone) return { ...base, error: "Clone not found" };

  const fromPlanSlug = options.fromPlanSlug ?? clone.entitled_plan_slug ?? null;
  base.fromPlanSlug = fromPlanSlug;
  base.direction = options.direction ?? classifyChange(fromPlanSlug, planSlug);

  const [catalogue, overrides, addons] = await Promise.all([
    loadCatalogue(supabase),
    loadOverrides(supabase),
    loadPurchasedAddons(supabase, cloneId).catch(() => [] as string[]),
  ]);

  if (catalogue.size === 0) {
    return { ...base, error: "Module catalogue is empty — run detection before reconciling" };
  }

  // Contractual exclusions hold across every reconcile — initial, plan
  // changes, manual — or the first upgrade quietly re-installs what the
  // signed agreement excluded.
  const resolution = applyContractExclusions(
    resolveEntitledModules({
      planSlug,
      purchasedAddons: addons,
      knownModules: new Set(catalogue.keys()),
      overrides,
    }),
    (clone.contract_excluded_module_slugs as string[] | null) ?? [],
  );

  const { data: installedRows } = await supabase
    .from("clone_modules")
    .select("module_id, modules(slug)")
    .eq("clone_id", cloneId);
  const installed = ((installedRows ?? []) as Array<{ modules: { slug: string } | null }>)
    .map((r) => r.modules?.slug)
    .filter((s): s is string => Boolean(s));

  const diff = diffModules(installed, resolution.moduleSlugs);

  base.installed = diff.toInstall;
  base.revoked = diff.toRevoke;
  base.unchanged = diff.unchanged.length;
  base.entitlementKeys = resolution.entitlementKeys;
  base.unmapped = resolution.unmapped;

  if (dryRun) return { ...base, ok: true };

  // ── Install newly entitled modules ──
  // A downgrade can still install: dropping to a lower tier does not remove
  // that tier's own baseline, and a clone provisioned before this feature
  // existed may be missing modules it has always been entitled to.
  if (diff.toInstall.length > 0) {
    const rows = diff.toInstall
      .map((slug) => catalogue.get(slug))
      .filter((id): id is string => Boolean(id))
      .map((module_id) => ({ clone_id: cloneId, module_id, installed_by: options.userId ?? null }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from("clone_modules")
        .upsert(rows, { onConflict: "clone_id,module_id" });
      if (error) return { ...base, error: `Failed to install modules: ${error.message}` };
    }
  }

  // ── Record revocations WITHOUT removing anything ──
  // `clone_modules` is left intact on purpose: it drives the cascade, and
  // deleting rows here would strip files from a running clone on a billing
  // event. The clone gates these features on `entitlement_keys` instead.
  const { error: cloneErr } = await supabase
    .from("clones")
    .update({
      entitled_plan_slug: planSlug,
      entitled_module_slugs: resolution.moduleSlugs,
      revoked_module_slugs: diff.toRevoke,
      entitlement_keys: resolution.entitlementKeys,
      entitlements_synced_at: new Date().toISOString(),
    })
    .eq("id", cloneId);
  if (cloneErr)
    return { ...base, error: `Failed to update clone entitlements: ${cloneErr.message}` };

  // ── Audit ──
  const { data: recon } = await supabase
    .from("clone_entitlement_reconciliations")
    .insert({
      clone_id: cloneId,
      plan_change_event_id: options.planChangeEventId ?? null,
      from_plan_slug: fromPlanSlug,
      to_plan_slug: planSlug,
      direction: base.direction,
      installed_slugs: diff.toInstall,
      revoked_slugs: diff.toRevoke,
      unchanged_count: diff.unchanged.length,
      unmapped: JSON.parse(JSON.stringify(resolution.unmapped)),
      triggered_by: options.userId ?? null,
      ok: true,
    })
    .select("id")
    .single();

  if (options.planChangeEventId) {
    await supabase
      .from("plan_change_events")
      .update({
        modules_reconciled_at: new Date().toISOString(),
        reconciliation_id: recon?.id ?? null,
      })
      .eq("id", options.planChangeEventId);
  }

  await supabase.from("audit_log").insert({
    action: "clone.entitlements_reconciled",
    entity_type: "clone",
    entity_id: cloneId,
    actor_user_id: options.userId ?? null,
    metadata: {
      from_plan: fromPlanSlug,
      to_plan: planSlug,
      direction: base.direction,
      installed: diff.toInstall,
      revoked: diff.toRevoke,
      unmapped_count: resolution.unmapped.length,
    },
  });

  return { ...base, ok: true, reconciliationId: recon?.id };
}

/**
 * Reconcile every plan change that has not been reconciled yet.
 *
 * Driven from the plan-change drain rather than inline with the webhook, so a
 * slow module install cannot make Stripe's delivery time out and retry.
 */
export async function drainPlanChangeReconciliations(args: {
  supabase: Supabase;
  limit?: number;
  userId?: string;
}): Promise<{ processed: number; results: ReconcileResult[] }> {
  const { supabase, limit = 25, userId } = args;

  const { data: events } = await supabase
    .from("plan_change_events")
    .select("id, tenant_id, from_plan_slug, to_plan_slug, created_at")
    .is("modules_reconciled_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  const results: ReconcileResult[] = [];
  for (const ev of (events ?? []) as Array<{
    id: string;
    tenant_id: string;
    from_plan_slug: string | null;
    to_plan_slug: string;
  }>) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("clone_id")
      .eq("id", ev.tenant_id)
      .maybeSingle();

    if (!tenant?.clone_id) {
      // No clone behind this tenant — mark it handled so the queue drains
      // instead of retrying an event that can never succeed.
      await supabase
        .from("plan_change_events")
        .update({ modules_reconciled_at: new Date().toISOString() })
        .eq("id", ev.id);
      continue;
    }

    const result = await reconcileCloneEntitlements({
      supabase,
      options: {
        cloneId: tenant.clone_id,
        planSlug: ev.to_plan_slug,
        fromPlanSlug: ev.from_plan_slug,
        planChangeEventId: ev.id,
        userId,
      },
    });
    results.push(result);

    if (!result.ok) {
      await supabase.from("clone_entitlement_reconciliations").insert({
        clone_id: tenant.clone_id,
        plan_change_event_id: ev.id,
        from_plan_slug: ev.from_plan_slug,
        to_plan_slug: ev.to_plan_slug,
        direction: classifyChange(ev.from_plan_slug, ev.to_plan_slug),
        ok: false,
        error_message: result.error ?? "unknown",
      });
      // Deliberately not marked reconciled — a failure stays in the queue.
    }
  }

  return { processed: results.length, results };
}

/**
 * Refresh `pricing_module_map` from the derived mapping, preserving any row an
 * operator has taken ownership of.
 */
export async function seedPricingModuleMap(args: {
  supabase: Supabase;
  userId?: string;
}): Promise<{ inserted: number; updated: number; preserved: number; unmapped: number }> {
  const { supabase } = args;

  const catalogue = await loadCatalogue(supabase);
  const rows = buildFullMapping(new Set(catalogue.keys()));

  const { data: existing } = await supabase
    .from("pricing_module_map")
    .select("id, source_kind, source_slug, source_name, is_override");

  const byKey = new Map(
    (
      (existing ?? []) as Array<{
        id: string;
        source_kind: string;
        source_slug: string;
        source_name: string;
        is_override: boolean;
      }>
    ).map((r) => [`${r.source_kind}|${r.source_slug}|${r.source_name}`, r]),
  );

  let inserted = 0;
  let updated = 0;
  let preserved = 0;

  for (const row of rows) {
    const key = `${row.sourceKind}|${row.sourceSlug}|${row.sourceName}`;
    const prior = byKey.get(key);

    if (prior?.is_override) {
      preserved++;
      continue;
    }

    const payload = {
      source_kind: row.sourceKind,
      source_slug: row.sourceSlug,
      source_name: row.sourceName,
      mapping_kind: row.kind,
      module_slugs: row.moduleSlugs,
      entitlement_key: row.entitlementKey ?? null,
      confidence: row.confidence,
      reason: row.reason,
    };

    if (prior) {
      await supabase.from("pricing_module_map").update(payload).eq("id", prior.id);
      updated++;
    } else {
      await supabase.from("pricing_module_map").insert(payload);
      inserted++;
    }
  }

  return {
    inserted,
    updated,
    preserved,
    unmapped: rows.filter((r) => r.kind === "unmapped").length,
  };
}
