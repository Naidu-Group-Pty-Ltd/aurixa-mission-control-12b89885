// Operator-facing reads and controls for piggybacked API-key usage.
//
// Reading is open to any operator — knowing which tenant is burning our OpenAI
// budget is operational, not privileged. Editing the rate catalog and waiving a
// charge are admin-only: both change what a customer pays.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  closeUsagePeriod,
  invoiceClosedCharge,
  waiveCharge,
} from "@/server/api-usage-settlement.server";
import { USAGE_UNITS } from "@/lib/api-usage-rating";
import type { Json } from "@/integrations/supabase/types";

// `requireSupabaseAuth` does not thread its context into the handler's inferred
// type. Narrow it here rather than switching the whole file off with
type AuthContext = { supabase: unknown; user: { id?: string } | null };

// The metering tables post-date the generated DB types.
const adminAny = supabaseAdmin;

async function callerRoles(supabase: unknown, userId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).from("user_roles").select("role").eq("user_id", userId);
  return ((data ?? []) as Array<{ role: string }>).map((r) => r.role);
}

function isAdmin(roles: string[]): boolean {
  return roles.includes("admin") || roles.includes("super_admin");
}

/** How far back the unattributed-usage count reads when no period is asked for. */
const GAP_WINDOW_DAYS = 31;

/**
 * Fleet-wide view: who spent what on our keys, broken down by tenant and by
 * provider, plus the charges already settled.
 *
 * Asked for no period, it shows each tenant's current one. Tenants' periods
 * start on the day each was provisioned, so the first of the calendar month
 * this used to ask for matched none of them and the page said there was no
 * usage while every Airtable read was metered (key audit R7).
 */
export const getApiUsageOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        period_start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    // Named for the CSV: the period asked for, or the day each tenant's
    // current period was read on.
    const period = data.period_start ?? new Date().toISOString().slice(0, 10);
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];

    const { data: summary, error } = await adminAny.rpc("api_usage_fleet_summary", {
      _period_start: data.period_start,
    });
    if (error) return { ok: false as const, error: error.message };

    // Named, so a held charge says whose it is: the dashboard, Preflight and
    // the CRM have no display name, only their clone's.
    const { data: charges, error: chargesError } = await adminAny
      .from("api_usage_charges")
      .select(
        "id, tenant_id, clone_id, period_start, period_end, currency, amount_cents, amount_micros, cost_micros, status, stripe_invoice_item_id, last_error, closed_at, invoiced_at, tenant:tenants(display_name, external_ref), clone:clones(name)",
      )
      .order("period_start", { ascending: false })
      .limit(100);
    // An unread list is not an empty one.
    if (chargesError) {
      return { ok: false as const, error: `charges could not be read: ${chargesError.message}` };
    }

    // Un-catalogued or unattributable calls are the two ways this system fails
    // quietly: the first meters at zero, the second never reaches an invoice.
    // Surface both as a first-class number rather than leaving them in the tail
    // of an events table nobody opens.
    const gapQuery = adminAny
      .from("api_usage_events")
      .select("secret_name, billing_reason, clone_id")
      .in("billing_reason", ["rate_missing", "unknown_secret"]);
    const { data: gaps } = await (
      data.period_start
        ? gapQuery.gte("period_start", data.period_start)
        : gapQuery.gte(
            "occurred_at",
            new Date(Date.now() - GAP_WINDOW_DAYS * 86_400_000).toISOString(),
          )
    ).limit(2000);

    const gapCounts = new Map<string, { secret_name: string; reason: string; count: number }>();
    for (const g of (gaps ?? []) as Array<{ secret_name: string; billing_reason: string }>) {
      const k = `${g.secret_name}:${g.billing_reason}`;
      const hit = gapCounts.get(k);
      if (hit) hit.count += 1;
      else gapCounts.set(k, { secret_name: g.secret_name, reason: g.billing_reason, count: 1 });
    }

    return {
      ok: true as const,
      period,
      summary: summary as Json,
      charges: charges ?? [],
      gaps: Array.from(gapCounts.values()).sort((a, b) => b.count - a.count),
      canManage: isAdmin(roles),
    };
  });

/** One tenant's period detail — the answer to "what is this line on my bill". */
export const getTenantApiUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        period_start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: summary, error } = await adminAny.rpc("api_usage_tenant_summary", {
      _tenant_id: data.tenant_id,
      _period_start: data.period_start ?? undefined,
    });
    if (error) return { ok: false as const, error: error.message };

    const { data: charge } = await adminAny
      .from("api_usage_charges")
      .select("*, lines:api_usage_charge_lines(*)")
      .eq("tenant_id", data.tenant_id)
      .order("period_start", { ascending: false })
      .limit(12);

    return { ok: true as const, summary, charges: charge ?? [] };
  });

/** The rate catalog, with each row's live usage so a price change is informed. */
export const listApiProviderRates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];

    const { data: rates, error } = await adminAny
      .from("api_provider_rates")
      .select("*")
      .order("category", { ascending: true })
      .order("display_name", { ascending: true });
    if (error) return { ok: false as const, error: error.message };

    // Which clones are actually piggybacking on each key right now. This is the
    // number that turns a rate into revenue, and it comes from the same table
    // the billability rule reads — no second source to drift.
    const { data: secrets } = await adminAny
      .from("clone_backend_secrets")
      .select("name, status, clone_id");

    const piggyback = new Map<string, { inherited: number; byok: number }>();
    for (const s of (secrets ?? []) as Array<{ name: string; status: string }>) {
      const hit = piggyback.get(s.name) ?? { inherited: 0, byok: 0 };
      if (s.status === "inherited") hit.inherited += 1;
      else if (s.status === "set") hit.byok += 1;
      piggyback.set(s.name, hit);
    }

    return {
      ok: true as const,
      rates: ((rates ?? []) as Array<{ secret_name: string }>).map((r) => ({
        ...r,
        clones_inherited: piggyback.get(r.secret_name)?.inherited ?? 0,
        clones_byok: piggyback.get(r.secret_name)?.byok ?? 0,
      })),
      canManage: isAdmin(roles),
      units: USAGE_UNITS,
    };
  });

const RateEdit = z.object({
  secret_name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  provider: z.string().min(1).max(64).optional(),
  display_name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(32).optional(),
  unit: z.enum(USAGE_UNITS).optional(),
  cost_micros_per_unit: z.number().min(0).max(100_000_000).optional(),
  resale_micros_per_unit: z.number().min(0).max(100_000_000).optional(),
  included_free_units: z.number().min(0).max(1_000_000_000).optional(),
  is_billable: z.boolean().optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/**
 * Create or reprice a metered key.
 *
 * Repricing is not retroactive by design: `api_usage_events.rated_micros` is
 * stamped at ingest, so a rate changed today cannot rewrite what a tenant was
 * quoted last week. Every edit is recorded in the audit log with the old and
 * new values, because this decides what customers pay.
 */
export const upsertApiProviderRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RateEdit.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];
    if (!isAdmin(roles)) return { ok: false as const, error: "forbidden" };

    const { data: before } = await adminAny
      .from("api_provider_rates")
      .select("*")
      .eq("secret_name", data.secret_name)
      .maybeSingle();

    const patch = {
      ...data,
      // A brand-new row needs the not-null columns filled; an edit keeps
      // whatever it already had.
      provider: data.provider ?? before?.provider ?? "unknown",
      display_name: data.display_name ?? before?.display_name ?? data.secret_name,
      category: data.category ?? before?.category ?? "other",
      unit: data.unit ?? before?.unit ?? "request",
    };

    const { error } = await adminAny
      .from("api_provider_rates")
      .upsert(patch, { onConflict: "secret_name" });
    if (error) return { ok: false as const, error: error.message };

    await adminAny.from("audit_log").insert({
      action: before ? "api_usage.rate_updated" : "api_usage.rate_created",
      entity_type: "api_provider_rate",
      entity_id: null,
      actor_user_id: user?.id ?? null,
      metadata: {
        secret_name: data.secret_name,
        before: before
          ? {
              resale_micros_per_unit: before.resale_micros_per_unit,
              cost_micros_per_unit: before.cost_micros_per_unit,
              included_free_units: before.included_free_units,
              is_billable: before.is_billable,
              is_active: before.is_active,
            }
          : null,
        after: patch,
      },
    });
    void supabase;
    return { ok: true as const };
  });

/** Close a period early (month-end runs on cron; this is the manual path). */
export const closeApiUsagePeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];
    if (!isAdmin(roles)) return { ok: false as const, error: "forbidden" };

    const result = await closeUsagePeriod(data.tenant_id, data.period_start);
    if (!result.ok) return result;

    await adminAny.from("audit_log").insert({
      action: "api_usage.period_closed",
      entity_type: "tenant",
      entity_id: data.tenant_id,
      actor_user_id: user?.id ?? null,
      metadata: { ...result, period_start: data.period_start, manual: true },
    });
    void supabase;
    // `result` carries its own `ok`, which wins over the spread — so the
    // `ok: true as const` this replaces was a claim the runtime never made.
    return { ...result };
  });

/** Push one closed charge to Stripe without waiting for the nightly sweep. */
export const invoiceApiUsageChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ charge_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];
    if (!isAdmin(roles)) return { ok: false as const, error: "forbidden" };
    void supabase;
    return await invoiceClosedCharge(data.charge_id);
  });

/** Write off a closed charge. Never edits the meter — see waiveCharge. */
export const waiveApiUsageChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ charge_id: z.string().uuid(), reason: z.string().min(3).max(500) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, user } = context as unknown as AuthContext;
    const roles = user?.id ? await callerRoles(supabase, user.id) : [];
    if (!isAdmin(roles)) return { ok: false as const, error: "forbidden" };
    if (!user?.id) return { ok: false as const, error: "unauthenticated" };
    void supabase;
    return await waiveCharge(data.charge_id, user.id, data.reason);
  });
