/**
 * Each clone's last pass, read once per event pass, for `passBudget.pure.ts`.
 *
 * One read for the whole event: the traces are on `cascade_results`, written
 * by the engine itself, so this costs Mission Control's database and nothing
 * on GitHub. A read that fails answers an EMPTY map, which reserves nothing
 * beyond what the engine reserved before this existed — the pass budget is a
 * way to stop earlier, never a gate, and losing it must not stop the pass.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clonePassBudgets, type ClonePassBudget } from "./passBudget.pure";

/**
 * More than enough rows to reach every clone's latest trace and its latest
 * finished one: each event writes one row per clone, and a clone's last
 * finished pass is rarely more than a few events back. A clone whose traces
 * all fall outside it is simply unread — the old behaviour.
 */
const TRACE_ROWS = 400;

export async function readClonePassBudgets(
  supabase: SupabaseClient<Database>,
  cloneIds: readonly string[],
): Promise<Map<string, ClonePassBudget>> {
  if (cloneIds.length === 0) return new Map();
  try {
    const { data, error } = await supabase
      .from("cascade_results")
      .select("clone_id, pass_trace")
      .in("clone_id", [...cloneIds])
      .not("pass_trace", "is", null)
      .order("updated_at", { ascending: false })
      .limit(TRACE_ROWS);
    if (error) {
      console.warn("[cascade] could not read the clones' last passes:", error.message);
      return new Map();
    }
    return clonePassBudgets(
      (data ?? []) as ReadonlyArray<{ clone_id: string | null; pass_trace: unknown }>,
    );
  } catch (e) {
    console.warn(
      "[cascade] could not read the clones' last passes:",
      e instanceof Error ? e.message : String(e),
    );
    return new Map();
  }
}
