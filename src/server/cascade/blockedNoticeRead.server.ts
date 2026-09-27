import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

export type BlockedNoticeRow = {
  id: string;
  clone_id: string | null;
  title: string;
  body: string;
  created_at: string;
  url: string | null;
};

/** Rows per request. Below PostgREST's cap, and never trusted to be it. */
export const BLOCKED_NOTICE_PAGE = 500;
/** A backlog past this is not a list to classify; the pass fails closed. */
export const MAX_BLOCKED_NOTICE_PAGES = 40;

/**
 * Every unread `cascade_blocked` notice for these clones, however many.
 *
 * PostgREST truncates a response at its `max_rows` and says nothing, so an
 * unpaged read that hit the cap would look exactly like a complete one. Every
 * notice is a standing refusal the blockage ledger reports, and one it never
 * received would lose its `ci_red` and bring back the false
 * `unreconciled_proposal` the ledger reads it to stand down.
 *
 * Paged by `id`, not by offset: a notice marked read between two pages would
 * shift an offset and push an unread one past the boundary, where a key does
 * not move. And it reads until a page comes back EMPTY rather than short, so
 * a server cap smaller than the page can never end the walk early.
 *
 * Read-only by construction: it names one table and never writes it.
 */
export async function readUnreadBlockedNotices(
  supabase: Db,
  ids: readonly string[],
): Promise<BlockedNoticeRow[]> {
  const rows: BlockedNoticeRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_BLOCKED_NOTICE_PAGES; page += 1) {
    let query = supabase
      .from("notifications")
      .select("id, clone_id, title, body, created_at, url")
      .eq("kind", "cascade_blocked")
      .is("read_at", null)
      .in("clone_id", [...ids])
      .order("id", { ascending: true })
      .limit(BLOCKED_NOTICE_PAGE);
    if (after !== null) query = query.gt("id", after);
    const res = await query;
    if (res.error) {
      throw new Error(`Could not read blocked notices: ${res.error.message}`);
    }
    const batch = (res.data ?? []) as BlockedNoticeRow[];
    if (batch.length === 0) return rows;
    rows.push(...batch);
    after = batch[batch.length - 1].id;
  }
  throw new Error(
    `Could not read blocked notices: more than ${BLOCKED_NOTICE_PAGE * MAX_BLOCKED_NOTICE_PAGES} ` +
      `are unread, which is a backlog to clear rather than a list to classify.`,
  );
}
