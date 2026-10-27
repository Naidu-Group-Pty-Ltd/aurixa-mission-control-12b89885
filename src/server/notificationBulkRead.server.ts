/**
 * The bulk "mark read" writes, with the rule in `notificationBulkRead.pure.ts`
 * applied where nothing on a page can step round it.
 *
 * Both run as the caller, through the user-scoped client, as the pages' own
 * writes did, so row-level security still decides who may mark what.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { RECORD_KINDS_FILTER } from "@/lib/notificationDisposition";
import {
  BULK_READ_EXEMPT_KINDS,
  planMarkMatching,
  type MarkMatchingFilters,
} from "@/lib/notificationBulkRead.pure";

type Db = SupabaseClient<Database>;

export type BulkMarkAnswer =
  | {
      ok: true;
      /** Rows the write changed. */
      count: number;
      /**
       * Blocked notices the same filters matched and the write left unread.
       * Null when they could not be counted: unknown is not zero.
       */
      leftUnread: number | null;
    }
  | { ok: false; error: string };

/**
 * Mark these notifications read (or unread), except any the rule exempts.
 *
 * The exemption is in the query rather than in a filter over ids the page
 * sent, so a page that sent a blocked notice's id, stale or otherwise, still
 * cannot change it.
 */
export async function bulkMarkByIds(
  supabase: Db,
  ids: readonly string[],
  read: boolean,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  let query = supabase
    .from("notifications")
    .update({ read_at: read ? new Date().toISOString() : null })
    .in("id", [...ids]);
  for (const kind of BULK_READ_EXEMPT_KINDS) query = query.neq("kind", kind);
  const { data, error } = await query.select("id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: (data ?? []).length };
}

/** "Mark all matching": every unread notification the page's filters match, except the exempt. */
export async function bulkMarkMatching(
  supabase: Db,
  filters: MarkMatchingFilters,
): Promise<BulkMarkAnswer> {
  const plan = planMarkMatching(filters);
  if (!plan.act) return { ok: false, error: plan.why };

  let query = supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  // The same order the page's list query asks in: a chosen kind outranks the
  // scope, and "Needs attention" leaves the record out.
  if (plan.kind) query = query.eq("kind", plan.kind);
  else if (plan.excludeRecordKinds) query = query.not("kind", "in", RECORD_KINDS_FILTER);
  if (plan.severity) query = query.eq("severity", plan.severity);
  if (plan.cloneId) query = query.eq("clone_id", plan.cloneId);
  for (const kind of plan.exempt) query = query.neq("kind", kind);
  const { data, error } = await query.select("id");
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    count: (data ?? []).length,
    leftUnread: await countLeftUnread(supabase, plan),
  };
}

/** The blocked notices the same filters match, still unread. Null when any count fails. */
async function countLeftUnread(
  supabase: Db,
  plan: Extract<ReturnType<typeof planMarkMatching>, { act: true }>,
): Promise<number | null> {
  let total = 0;
  for (const kind of plan.leftUnread) {
    let query = supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null)
      .eq("kind", kind);
    if (plan.severity) query = query.eq("severity", plan.severity);
    if (plan.cloneId) query = query.eq("clone_id", plan.cloneId);
    const { count, error } = await query;
    if (error || count === null) return null;
    total += count;
  }
  return total;
}
