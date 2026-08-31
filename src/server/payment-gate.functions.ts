/**
 * Operator RPCs for the activation gate.
 *
 * Every mutation is `requireAdmin`: a gate decides whether a paying customer
 * can work, and that is not an operator-level act. The reads are
 * `requireOperator`, so support can see why a workspace is locked without
 * being able to change it.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  defaultGateSettings,
  factsOf,
  readGate,
  resolvePlanPricing,
  setGateOverride,
  setGateWindow,
  settleGatePayment,
  armGate,
  type GateRow,
} from "./payment-gate.server";
import {
  gateEligibility,
  normaliseGraceHours,
  resolveGateState,
  type GateOverride,
  type GateState,
} from "@/lib/clonePaymentGate.pure";
import { asRow } from "@/lib/json-cast";
import type { Json, TablesUpdate } from "@/integrations/supabase/types";
import { writeAuditLog } from "./audit.server";

export type GateListRow = {
  gate: GateRow | null;
  state: GateState;
  clone: {
    id: string;
    name: string;
    slug: string;
    deploy_url: string | null;
    subdomain_fqdn: string | null;
    entitled_plan_slug: string | null;
    billing_user_id: string | null;
    created_at: string;
  };
  /** Paid plan, no gate. Surfaced rather than hidden: a gate that was never
   *  armed is invisible from the clone itself, and the console is the only
   *  place the gap can be seen. */
  ungatedPaidPlan: boolean;
};

export type GateListResult = {
  rows: GateListRow[];
  defaults: { hours: number; enabled: boolean };
  summary: {
    total: number;
    gated: number;
    locked: number;
    counting: number;
    paid: number;
    unpaid: number;
    ungatedPaidPlan: number;
  };
};

/**
 * Every clone, with its gate if it has one.
 *
 * Deliberately lists clones rather than gates. A gates-only list cannot show
 * the two states an operator most needs to find — a paid-plan clone that was
 * never armed, and a clone that is simply not gated — and both of those are
 * absences.
 */
export const listCloneGates = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async (): Promise<GateListResult> => {
    const now = new Date();
    const [clonesQ, gatesQ, defaults] = await Promise.all([
      supabaseAdmin
        .from("clones")
        .select(
          "id, name, slug, deploy_url, subdomain_fqdn, entitled_plan_slug, billing_user_id, created_at",
        )
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("clone_payment_gates").select("*"),
      defaultGateSettings(),
    ]);

    if (clonesQ.error) throw new Error(clonesQ.error.message);
    if (gatesQ.error) throw new Error(gatesQ.error.message);

    const byClone = new Map<string, GateRow>();
    for (const g of (gatesQ.data ?? []) as GateRow[]) byClone.set(g.clone_id, g);

    // Price every distinct plan once rather than per clone.
    const planSlugs = new Set(
      (clonesQ.data ?? []).map((c) => c.entitled_plan_slug ?? "").filter(Boolean),
    );
    const pricing = new Map<string, number | null>();
    await Promise.all(
      [...planSlugs].map(async (slug) => {
        const p = await resolvePlanPricing(slug);
        pricing.set(slug, p.amountDueCents);
      }),
    );

    const rows: GateListRow[] = (clonesQ.data ?? []).map((clone) => {
      const gate = byClone.get(clone.id) ?? null;
      const eligible = gateEligibility({
        planSlug: clone.entitled_plan_slug,
        amountDueCents: pricing.get(clone.entitled_plan_slug ?? "") ?? null,
      });
      return {
        gate,
        state: resolveGateState(factsOf(gate), now),
        clone,
        ungatedPaidPlan: gate === null && eligible.eligible,
      };
    });

    return {
      rows,
      defaults,
      summary: {
        total: rows.length,
        gated: rows.filter((r) => r.gate !== null).length,
        locked: rows.filter((r) => r.state.locked).length,
        counting: rows.filter((r) => r.state.counting).length,
        paid: rows.filter((r) => r.state.paid).length,
        unpaid: rows.filter((r) => r.gate !== null && !r.state.paid).length,
        ungatedPaidPlan: rows.filter((r) => r.ungatedPaidPlan).length,
      },
    };
  });

export type GateDetail = {
  gate: GateRow | null;
  state: GateState;
  events: Array<{
    id: string;
    kind: string;
    reason: string | null;
    status_before: string | null;
    status_after: string | null;
    actor: string;
    actor_id: string | null;
    created_at: string;
    metadata: Json;
  }>;
  pricing: {
    planSlug: string | null;
    planName: string | null;
    amountDueCents: number | null;
    currency: string;
  };
  eligible: boolean;
};

/** One clone's gate, its history, and what its plan costs. */
export const getCloneGate = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data }): Promise<GateDetail> => {
    const read = await readGate(data.cloneId);
    if (!read.ok) throw new Error(read.error);

    const { data: clone } = await supabaseAdmin
      .from("clones")
      .select("entitled_plan_slug")
      .eq("id", data.cloneId)
      .maybeSingle();
    const pricing = await resolvePlanPricing(read.row?.plan_slug ?? clone?.entitled_plan_slug);

    const events = read.row
      ? await supabaseAdmin
          .from("clone_payment_gate_events")
          .select(
            "id, kind, reason, status_before, status_after, actor, actor_id, created_at, metadata",
          )
          .eq("gate_id", read.row.id)
          .order("created_at", { ascending: false })
          .limit(100)
      : { data: [], error: null };

    return {
      gate: read.row,
      state: resolveGateState(factsOf(read.row)),
      events: (events.data ?? []) as GateDetail["events"],
      pricing,
      eligible: gateEligibility({
        planSlug: pricing.planSlug,
        amountDueCents: pricing.amountDueCents,
      }).eligible,
    };
  });

async function cloneName(cloneId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("clones")
    .select("name")
    .eq("id", cloneId)
    .maybeSingle();
  return data?.name ?? null;
}

/** Lock, unlock, or hand the gate back to the clock (`override: null`). */
export const setCloneGateOverride = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { cloneId: string; override: GateOverride | null; reason: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (data.override !== null && data.override !== "locked" && data.override !== "unlocked") {
      throw new Error("override must be 'locked', 'unlocked' or null");
    }
    if (!data.reason || data.reason.trim().length < 5) {
      throw new Error("A reason of at least 5 characters is required");
    }
    return data;
  })
  .handler(async ({ data, context }) =>
    setGateOverride({
      cloneId: data.cloneId,
      override: data.override,
      reason: data.reason,
      actorId: context.userId,
      cloneName: await cloneName(data.cloneId),
    }),
  );

/** Change the activation window. `graceHours: null` removes the deadline. */
export const setCloneGateWindow = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (data: {
      cloneId: string;
      graceHours: number | string | null;
      restartClock?: boolean;
      reason: string;
    }) => {
      if (!data?.cloneId) throw new Error("cloneId required");
      const hours = normaliseGraceHours(data.graceHours);
      if (!hours.ok) throw new Error(`Invalid window: ${hours.error}`);
      if (!data.reason || data.reason.trim().length < 5) {
        throw new Error("A reason of at least 5 characters is required");
      }
      return { ...data, graceHours: hours.hours };
    },
  )
  .handler(async ({ data, context }) =>
    setGateWindow({
      cloneId: data.cloneId,
      graceHours: data.graceHours as number | null,
      restartClock: data.restartClock === true,
      reason: data.reason,
      actorId: context.userId,
      cloneName: await cloneName(data.cloneId),
    }),
  );

/**
 * Arm a gate on a clone that has one owing and never got one — the
 * `ungatedPaidPlan` row in the console.
 *
 * Admin-only, and it goes through the same `armGate` provisioning uses, so
 * eligibility is decided by the same rule rather than by a second one written
 * here. It cannot re-arm a clone that already has a gate.
 */
export const armCloneGate = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { cloneId: string; graceHours?: number | string | null }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (data.graceHours !== undefined) {
      const hours = normaliseGraceHours(data.graceHours);
      if (!hours.ok) throw new Error(`Invalid window: ${hours.error}`);
      return { cloneId: data.cloneId, graceHours: hours.hours };
    }
    return { cloneId: data.cloneId, graceHours: undefined };
  })
  .handler(async ({ data, context }) => {
    const { data: clone } = await supabaseAdmin
      .from("clones")
      .select("name, entitled_plan_slug")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone) return { ok: false as const, error: "clone_not_found" };
    const result = await armGate({
      cloneId: data.cloneId,
      cloneName: clone.name,
      planSlug: clone.entitled_plan_slug,
      graceHours: data.graceHours as number | null | undefined,
      actorId: context.userId,
    });
    return result.armed
      ? { ok: true as const, gate: result.gate }
      : { ok: false as const, error: result.reason, detail: result.detail };
  });

/**
 * Record a payment that reached Aurixa outside Stripe Checkout — a bank
 * transfer, an invoice settled by hand.
 *
 * It writes the same `paid_at` stamp Stripe writes, so the unlock is the same
 * act rather than a second kind of open, and it is attributed to `operator`
 * so the ledger never claims Stripe captured money it did not.
 */
export const recordCloneGatePayment = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { cloneId: string; amountPaidCents?: number | null; reason: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data.reason || data.reason.trim().length < 5) {
      throw new Error("A reason of at least 5 characters is required — what was received, and how");
    }
    return data;
  })
  .handler(async ({ data, context }) =>
    settleGatePayment({
      cloneId: data.cloneId,
      source: "operator",
      amountPaidCents: data.amountPaidCents ?? null,
      actorId: context.userId,
      reason: data.reason,
    }),
  );

/** The platform default window, and the master switch. */
export const setGateDefaults = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { hours?: number | string; enabled?: boolean }) => {
    const patch: { clone_gate_default_hours?: number; clone_gate_enabled?: boolean } = {};
    if (data?.hours !== undefined) {
      const hours = normaliseGraceHours(data.hours);
      if (!hours.ok || hours.hours === null) {
        throw new Error("The platform default must be a whole number of hours between 1 and 8760");
      }
      patch.clone_gate_default_hours = hours.hours;
    }
    if (typeof data?.enabled === "boolean") patch.clone_gate_enabled = data.enabled;
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change");
    return patch;
  })
  .handler(async ({ data, context }) => {
    const { data: row } = await supabaseAdmin
      .from("prime_config")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "prime_not_configured" };
    const { error } = await supabaseAdmin
      .from("prime_config")
      .update(asRow<TablesUpdate<"prime_config">>(data))
      .eq("id", row.id);
    if (error) return { ok: false as const, error: error.message };
    await writeAuditLog({
      action: "clone_gate.defaults_changed",
      entityType: "prime_config",
      entityId: row.id,
      actorUserId: context.userId,
      metadata: data as Record<string, unknown>,
    });
    return { ok: true as const, ...(await defaultGateSettings()) };
  });
