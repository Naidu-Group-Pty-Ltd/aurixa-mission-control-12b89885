/**
 * Applying `planCarrierRefresh` to a live carrier.
 *
 * The judgement is in `carrierRefresh.pure.ts` and the reasoning with it. This
 * is the read, the write and the two refusals a database can produce.
 *
 * Two things it deliberately does not do.
 *
 * **It writes no story onto the row.** `cascade_results.diff_summary` is
 * written once and read for as long as the row exists, so it holds only what
 * stays true — which pull request, and what it carries. A transient "re-offered
 * at 03:12" would be exactly the class of write that left rows reading "No
 * check has reported on this pull request" long after every check had. The
 * refresh's story belongs to the pass, and the pass's summary is where it goes.
 *
 * **It clears `progress` and nothing else.** `progress` is a pass's own file
 * cursor over a tree that has just changed underneath it, so carrying it into
 * a delivery of a different head would resume a walk of a tree that no longer
 * exists. `pr_url`, `delivered_sha` and `commit_sha` are left exactly as the
 * earlier pass wrote them: the proposal they name is still open and the next
 * pass finds it, updates it in place and re-stamps all three. Blanking them
 * would lose the standing proposal for the seconds between the update and the
 * pass, and a crash in that window would lose it for good.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import {
  carrierMayRefresh,
  describeCarrierRefresh,
  planCarrierRefresh,
  type CarrierEventFacts,
  type CarrierRefreshDecision,
  type CarrierResultRow,
} from "./carrierRefresh.pure";

type SupabaseLike = SupabaseClient<Database>;

export type CarrierRefreshOutcome = {
  /** How many rows went back to `queued`. Zero on every refusal. */
  refreshed: number;
  /** The one sentence the pass adds to its summary, or null. */
  note: string | null;
  /** Why nothing happened, for the log. Null when something did. */
  why: string | null;
};

const NOTHING: CarrierRefreshOutcome = { refreshed: 0, note: null, why: null };

/**
 * Re-offer prime's current head to the clones this carrier already finished
 * against an older one.
 *
 * A read or a write that FAILS refreshes nothing and says so. That is the
 * conservative side by a wide margin: the pass then behaves exactly as it does
 * today — it delivers to whatever is still queued — and the next claim asks
 * again five minutes later. Failing the event instead would retire a carrier
 * over a transient fault and strand every clone behind it, which is the shape
 * of the outage this module exists to end.
 */
export async function refreshCarrierRows(
  supabase: SupabaseLike,
  args: { eventId: string; event: CarrierEventFacts; head: string },
): Promise<CarrierRefreshOutcome> {
  // Asked of the pure module FIRST, so a manual event, a scoped one or a
  // settled one costs no query at all.
  const gate = carrierMayRefresh(args.event, args.head);
  if (!gate.ok) return { ...NOTHING, why: gate.why };

  const { data, error } = await supabase
    .from("cascade_results")
    .select("id, status, delivered_sha, clones(name)")
    .eq("cascade_event_id", args.eventId);
  if (error) {
    console.error(`[cascade] could not read ${args.eventId}'s rows to refresh:`, error.message);
    return { ...NOTHING, why: `the carrier's rows could not be read: ${error.message}` };
  }

  type Joined = {
    id: string;
    status: string;
    delivered_sha: string | null;
    clones: { name: string | null } | null;
  };
  const rows: CarrierResultRow[] = ((data ?? []) as unknown as Joined[]).map((r) => ({
    id: String(r.id),
    clone_name: r.clones?.name ?? null,
    status: String(r.status),
    delivered_sha: r.delivered_sha ?? null,
  }));

  const decision: CarrierRefreshDecision = planCarrierRefresh({
    event: args.event,
    rows,
    head: args.head,
  });
  if (decision.kind !== "refresh") return { ...NOTHING, why: decision.why };

  const { error: writeError } = await supabase
    .from("cascade_results")
    .update({ status: "queued", completed_at: null, progress: null })
    .in("id", decision.rowIds);
  if (writeError) {
    console.error(
      `[cascade] could not re-offer ${decision.rowIds.length} row(s) on ${args.eventId}:`,
      writeError.message,
    );
    return { ...NOTHING, why: `the re-offer could not be written: ${writeError.message}` };
  }

  return {
    refreshed: decision.rowIds.length,
    note: describeCarrierRefresh(decision),
    why: null,
  };
}
