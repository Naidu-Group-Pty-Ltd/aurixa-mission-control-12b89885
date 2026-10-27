// Server-only helpers for the cascade approval gate.
// The pure assessment lives in src/lib/blast-radius.ts so it can be imported
// from client routes; this module adds DB-touching helpers (engine gate).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export {
  assessBlastRadius,
  HIGH_RISK_CLONE_COUNT,
  AUTO_MERGE_THRESHOLD,
  type BlastAssessment,
  type CascadeOrigin,
} from "@/lib/blast-radius";

type SupabaseLike = SupabaseClient<Database>;

/**
 * Returns true iff the event is currently blocked waiting for a second-operator
 * approval. Used by the engine to short-circuit before doing any GitHub work.
 *
 * A gate that could not be read holds. An unread gate is not an open one, and
 * the engine's inline callers run whatever this lets through.
 */
export async function isBlockedByApproval(
  supabase: SupabaseLike,
  cascadeEventId: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const { data: ev, error } = await supabase
    .from("cascade_events")
    .select("requires_approval, approved_at")
    .eq("id", cascadeEventId)
    .maybeSingle();
  if (error) {
    return { blocked: true, reason: `The approval gate could not be read: ${error.message}` };
  }
  if (!ev) return { blocked: false };
  if (ev.requires_approval && !ev.approved_at) {
    return { blocked: true, reason: "Awaiting second-operator approval" };
  }
  return { blocked: false };
}
