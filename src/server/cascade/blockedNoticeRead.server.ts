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
/**
 * More unread notices than this is a backlog to clear, not a list to classify,
 * and the pass fails closed. Counted in NOTICES RECEIVED, never in requests:
 * a request ceiling refuses a backlog under it whenever the server caps a page
 * below `BLOCKED_NOTICE_PAGE`, or whenever the last page is full and the empty
 * page that proves the end is one request past the ceiling.
 */
export const MAX_UNREAD_BLOCKED_NOTICES = 20_000;

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
 * It always ends. Every page either comes back empty (the end), repeats a
 * notice already received (the walk is not advancing, so its list cannot be
 * trusted), or adds at least one notice to a count that fails closed past
 * `MAX_UNREAD_BLOCKED_NOTICES`.
 *
 * Read-only by construction: it names one table and never writes it.
 */
export async function readUnreadBlockedNotices(
  supabase: Db,
  ids: readonly string[],
): Promise<BlockedNoticeRow[]> {
  const rows: BlockedNoticeRow[] = [];
  const received = new Set<string>();
  let after: string | null = null;
  for (;;) {
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
    for (const row of batch) {
      if (received.has(row.id)) {
        throw new Error(
          `Could not read blocked notices: notice ${row.id} came back twice, so the walk is not ` +
            `advancing and the list it returned cannot be trusted.`,
        );
      }
      received.add(row.id);
      rows.push(row);
    }
    if (rows.length > MAX_UNREAD_BLOCKED_NOTICES) {
      throw new Error(
        `Could not read blocked notices: more than ${MAX_UNREAD_BLOCKED_NOTICES} are unread, ` +
          `which is a backlog to clear rather than a list to classify.`,
      );
    }
    after = batch[batch.length - 1].id;
  }
}
