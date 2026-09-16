// Server functions for approving / rejecting / inspecting blast-radius gates.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { executeCascade, terminaliseOrphanedRows } from "./cascade-engine.server";
import { assessBlastRadius, type BlastAssessment } from "./cascade-approvals.server";
import type { Database } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

// Quick blast-radius probe — no auth gate beyond the standard middleware.
export const assessCascadeBlast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { mode: CascadeMode; cloneCount: number }) => {
    if (typeof data?.cloneCount !== "number") throw new Error("cloneCount required");
    if (!data?.mode) throw new Error("mode required");
    return data;
  })
  .handler(async ({ data }): Promise<BlastAssessment> => {
    return assessBlastRadius(data.mode, data.cloneCount);
  });

export type ApproveResult =
  | { ok: true; ran: boolean; status?: string }
  | { ok: false; error: string };

// Second-operator approval. RLS prevents the initiator from approving their
// own event (policy on cascade_approvals checks initiated_by). On success we
// stamp the event and immediately kick the engine so the user sees results.
export const approveCascade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cascadeEventId: string; reason?: string }) => {
    if (!data?.cascadeEventId) throw new Error("cascadeEventId required");
    return data;
  })
  .handler(async ({ data, context }): Promise<ApproveResult> => {
    const supabase = context.supabase;
    const { data: ev, error: evErr } = await supabase
      .from("cascade_events")
      .select("id, initiated_by, requires_approval, approved_at, mode")
      .eq("id", data.cascadeEventId)
      .maybeSingle();
    if (evErr || !ev) return { ok: false, error: "Cascade event not found" };
    if (!ev.requires_approval) return { ok: false, error: "Cascade does not require approval" };
    if (ev.approved_at) return { ok: false, error: "Cascade already approved" };
    if (ev.initiated_by === context.userId) {
      return { ok: false, error: "Initiator cannot approve their own cascade" };
    }

    // Insert approval — RLS double-checks the second-operator rule.
    const { error: insErr } = await supabase.from("cascade_approvals").insert({
      cascade_event_id: data.cascadeEventId,
      approver_user_id: context.userId,
      decision: "approved",
      reason: data.reason ?? null,
    });
    if (insErr) return { ok: false, error: insErr.message };

    const now = new Date().toISOString();
    await supabase
      .from("cascade_events")
      .update({ approved_at: now, approved_by: context.userId })
      .eq("id", data.cascadeEventId);

    await supabase.from("audit_log").insert({
      action: "cascade.approved",
      entity_type: "cascade_event",
      entity_id: data.cascadeEventId,
      actor_user_id: context.userId,
      metadata: { mode: ev.mode },
    });

    // Clear the "awaiting approval" notification(s) for this event.
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("cascade_event_id", data.cascadeEventId)
      .eq("kind", "cascade_awaiting_approval")
      .is("read_at", null);

    // Ping the original initiator with a verdict notification so they don't
    // need to keep the page open to learn their cascade got approved.
    if (ev.initiated_by) {
      await supabase.from("notifications").insert({
        kind: "cascade_approved",
        severity: "success",
        title: "Cascade approved",
        body: `Operator ${context.userId.slice(0, 8)} approved your cascade — engine running now.`,
        cascade_event_id: data.cascadeEventId,
        url: `/cascades/${data.cascadeEventId}`,
        metadata: { mode: ev.mode, reason: data.reason ?? null, approver: context.userId },
      });
    }

    // Run the engine now that the gate is open.
    const res = await executeCascade(supabase, data.cascadeEventId);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, ran: true, status: res.status };
  });

export const rejectCascade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cascadeEventId: string; reason?: string }) => {
    if (!data?.cascadeEventId) throw new Error("cascadeEventId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: ev } = await supabase
      .from("cascade_events")
      .select("id, initiated_by, requires_approval, approved_at, mode")
      .eq("id", data.cascadeEventId)
      .maybeSingle();
    if (!ev) return { ok: false as const, error: "Cascade event not found" };
    if (ev.approved_at) return { ok: false as const, error: "Cascade already approved" };
    if (ev.initiated_by === context.userId) {
      return { ok: false as const, error: "Initiator cannot reject their own cascade" };
    }

    const { error: insErr } = await supabase.from("cascade_approvals").insert({
      cascade_event_id: data.cascadeEventId,
      approver_user_id: context.userId,
      decision: "rejected",
      reason: data.reason ?? null,
    });
    if (insErr) return { ok: false as const, error: insErr.message };

    await supabase
      .from("cascade_events")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        summary: `Rejected by reviewer${data.reason ? `: ${data.reason}` : ""}`,
      })
      .eq("id", data.cascadeEventId);

    // The act that settles an event settles its rows. A rejection is a
    // settle, and without this its three queued rows sit for ever under a
    // failed carrier, reading as live work nothing will ever act on — the
    // one settle path the orphaned-rows sweep missed.
    await terminaliseOrphanedRows(
      supabase,
      data.cascadeEventId,
      `Skipped: the carrier event was rejected by a reviewer${data.reason ? ` — ${data.reason}` : ""}.`,
    );

    await supabase.from("audit_log").insert({
      action: "cascade.rejected",
      entity_type: "cascade_event",
      entity_id: data.cascadeEventId,
      actor_user_id: context.userId,
      metadata: { mode: ev.mode, reason: data.reason ?? null },
    });

    // Clear the "awaiting approval" notification(s) for this event.
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("cascade_event_id", data.cascadeEventId)
      .eq("kind", "cascade_awaiting_approval")
      .is("read_at", null);

    // Ping the original initiator with a verdict notification so they don't
    // need to keep the page open to learn their cascade got rejected.
    if (ev.initiated_by) {
      await supabase.from("notifications").insert({
        kind: "cascade_rejected",
        severity: "warning",
        title: "Cascade rejected",
        body: data.reason
          ? `Operator ${context.userId.slice(0, 8)} rejected your cascade: ${data.reason}`
          : `Operator ${context.userId.slice(0, 8)} rejected your cascade.`,
        cascade_event_id: data.cascadeEventId,
        url: `/cascades/${data.cascadeEventId}`,
        metadata: { mode: ev.mode, reason: data.reason ?? null, approver: context.userId },
      });
    }

    return { ok: true as const };
  });
