import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyzeCloneDrift, type AnalyzeDriftResult } from "./drift-suggestions.server";
import { applyAutoPoliciesForClone } from "./drift-policies.server";
import { executeCascade } from "./cascade-engine.server";
import type { Database } from "@/integrations/supabase/types";
import { assessBlastRadius } from "@/lib/blast-radius";

export type { DriftSuggestion, AnalyzeDriftResult } from "./drift-suggestions.server";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

// Analyze a single clone's drift via Lovable AI and persist suggestions.
// After fresh suggestions land, evaluate the clone's auto-apply policy and
// fire scoped cascades for eligible items so policies actually flow.
export const analyzeDrift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId || typeof data.cloneId !== "string") {
      throw new Error("cloneId required");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<AnalyzeDriftResult & { auto_applied?: number }> => {
    const result = await analyzeCloneDrift(context.supabase, data.cloneId);
    let auto_applied = 0;
    try {
      const auto = await applyAutoPoliciesForClone(context.supabase, data.cloneId);
      if (auto.ok) auto_applied = auto.applied.length;
    } catch {
      // Non-fatal — surface analyze result even if auto-apply hiccups.
    }
    return { ...result, auto_applied };
  });

export type ApplySuggestionResult =
  | { ok: true; cascade_event_id: string }
  | { ok: false; error: string };

// Apply a single AI suggestion: spawn a cascade event scoped to the clone in
// the requested mode (defaults to suggestion's recommended_mode), then mark
// the suggestion as applied with a back-reference to the new event.
export const applyDriftSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; suggestionId: string; mode?: CascadeMode }) => {
    if (!data?.cloneId || !data?.suggestionId) {
      throw new Error("cloneId and suggestionId required");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<ApplySuggestionResult> => {
    const supabase = context.supabase;
    const { data: clone } = await supabase
      .from("clones")
      .select("*")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone) return { ok: false, error: "Clone not found" };

    type Suggestion = {
      id: string;
      status: "open" | "applied" | "dismissed";
      recommended_mode: CascadeMode;
      summary: string;
      files: string[];
      applied_event_id?: string | null;
    };
    const suggestions = (clone.drift_suggestions as unknown as Suggestion[] | null) ?? [];
    const suggestion = suggestions.find((s) => s.id === data.suggestionId);
    if (!suggestion) return { ok: false, error: "Suggestion not found" };
    if (suggestion.status !== "open") {
      return { ok: false, error: `Suggestion already ${suggestion.status}` };
    }

    const mode: CascadeMode = data.mode ?? suggestion.recommended_mode ?? "pr";

    // Spawn a cascade event scoped to this single clone, under the gate every
    // operator-started cascade asks (one clone never waits today).
    const { data: ev, error: evErr } = await supabase
      .from("cascade_events")
      .insert({
        trigger: "manual",
        mode,
        status: "pending",
        requires_approval: assessBlastRadius(mode, 1).requiresApproval,
        scope_filter: {
          scope: "ai_suggestion",
          clone_ids: [data.cloneId],
          suggestion_id: data.suggestionId,
          summary: suggestion.summary,
        },
        summary: `AI suggestion · ${suggestion.summary}`,
        initiated_by: context.userId,
      })
      .select()
      .single();
    if (evErr || !ev) return { ok: false, error: evErr?.message ?? "Failed to create event" };

    const { error: rErr } = await supabase.from("cascade_results").insert({
      cascade_event_id: ev.id,
      clone_id: data.cloneId,
      status: "queued" as const,
    });
    if (rErr) return { ok: false, error: rErr.message };

    // Mark suggestion as applied immediately so UI reflects intent even if
    // execution is slow. The back-reference lets the user jump to the event.
    const updated = suggestions.map((s) =>
      s.id === data.suggestionId
        ? { ...s, status: "applied" as const, applied_event_id: ev.id }
        : s,
    );
    await supabase
      .from("clones")
      .update({
        drift_suggestions:
          updated as unknown as Database["public"]["Tables"]["clones"]["Update"]["drift_suggestions"],
      })
      .eq("id", data.cloneId);

    // Fire-and-await the engine so the user gets immediate feedback.
    const res = await executeCascade(supabase, ev.id);
    if (!res.ok) {
      // Engine failed before completing — surface error but keep the event
      // so the user can retry or inspect on /cascades/$eventId.
      return { ok: false, error: res.error };
    }
    return { ok: true, cascade_event_id: ev.id };
  });

// Lightweight dismissal — just flips status locally, no GitHub action.
export const dismissDriftSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; suggestionId: string }) => {
    if (!data?.cloneId || !data?.suggestionId) {
      throw new Error("cloneId and suggestionId required");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const { data: clone } = await supabase
      .from("clones")
      .select("drift_suggestions")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone) throw new Error("Clone not found");

    type Suggestion = { id: string; status: "open" | "applied" | "dismissed" };
    const suggestions = (clone.drift_suggestions as unknown as Suggestion[] | null) ?? [];
    const updated = suggestions.map((s) =>
      s.id === data.suggestionId ? { ...s, status: "dismissed" as const } : s,
    );
    await supabase
      .from("clones")
      .update({
        drift_suggestions:
          updated as unknown as Database["public"]["Tables"]["clones"]["Update"]["drift_suggestions"],
      })
      .eq("id", data.cloneId);
    return { ok: true as const };
  });
