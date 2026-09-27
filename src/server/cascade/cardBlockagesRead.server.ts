import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { BLOCKAGE_POLICY } from "@/server/cascade/blockageTaxonomy.pure";
import {
  groupCardBlockages,
  type CardBlockages,
  type ClassTally,
  type OpenBlockageRow,
} from "@/server/cascade/cardBlockages.pure";

type Db = SupabaseClient<Database>;

/** Rows per request. Below PostgREST's cap, and never trusted to be it. */
export const CARD_BLOCKAGE_PAGE = 500;

/**
 * How many open rows one render of the card will walk before it asks the
 * database to count by class instead. Counted in ROWS RECEIVED, never in
 * requests, so a server cap below the page cannot shorten the walk.
 *
 * It bounds the read and never what the card says. Every open row is read up
 * to here; past here every class the taxonomy knows is counted exactly. The
 * largest class on any clone is `prime_ledger_hole`, fed by at most fifty
 * notes (`PRIME_LEDGER_HOLE_NOTE_CAP`) and the few holes held migrations name
 * — 52 rows on the CRM independent on 27 Sep 2026 — so a clone reaches this
 * only through something new.
 */
export const CARD_BLOCKAGE_ROW_CEILING = 2_000;

const ROW_COLUMNS = "id, class, owner, detail, first_seen_at, self_heals";

/** A read of the card's blockages, shaped like the PostgREST result it replaces. */
export type CardBlockagesRead =
  | { data: CardBlockages; error: null }
  | { data: null; error: { message: string } };

/**
 * Every open blockage on one clone, as the card draws it: one line per class,
 * each with the number of rows behind it.
 *
 * ## Why it walks, and how
 *
 * The card read the six oldest open rows, and the first version of this
 * change the oldest 500. Either way a class whose first row fell past the
 * cut was not drawn and a class spanning it was undercounted, while the card
 * claimed to list every open class. PostgREST also truncates a response at its `max_rows` without
 * saying so, so an unpaged read that hit the cap would look complete.
 *
 * So it walks by `id`, as `readUnreadBlockedNotices` does, for the reasons
 * that module paid for. A key does not move when a row is cleared between two
 * pages, where an offset would push a row past the boundary. It reads until a
 * page comes back EMPTY rather than short, so a server cap smaller than the
 * page cannot end the walk early. And a page that repeats a row fails the
 * read, because a walk that is not advancing cannot be trusted and must not
 * loop. The order of the walk does not matter to the card: the grouping dates
 * each class by its oldest row whatever order the rows arrive in.
 *
 * ## Past the ceiling
 *
 * A render that has received `CARD_BLOCKAGE_ROW_CEILING` rows stops walking
 * and asks the database for two things. The first is the number of open rows.
 * The second is, for each class the taxonomy knows, the number of its open
 * rows and when the oldest was first seen. Every known class is then drawn
 * with its true count, however many rows it has. What no count by class can
 * reach is a class this build does not know, and that shows as rows the lines
 * leave out; the card says how many.
 *
 * A failed request, or a count the database did not give, fails the whole
 * read. The card draws that as "could not be read", never as a shorter list.
 * Read-only by construction: it names one table and never writes it.
 */
export async function readCardBlockages(supabase: Db, cloneId: string): Promise<CardBlockagesRead> {
  const rows: OpenBlockageRow[] = [];
  const received = new Set<string>();
  let after: string | null = null;
  for (;;) {
    let query = supabase
      .from("clone_sync_blockages")
      .select(ROW_COLUMNS)
      .eq("clone_id", cloneId)
      .is("cleared_at", null)
      .order("id", { ascending: true })
      .limit(CARD_BLOCKAGE_PAGE);
    if (after !== null) query = query.gt("id", after);
    const res = await query;
    if (res.error) return failed(res.error.message);
    const batch = (res.data ?? []) as OpenBlockageRow[];
    if (batch.length === 0) {
      // The end of the walk: every open row was read, and the lines count them all.
      return {
        data: { groups: groupCardBlockages(rows), total: rows.length, counted: rows.length },
        error: null,
      };
    }
    for (const row of batch) {
      if (received.has(row.id)) {
        return failed(
          `blockage ${row.id} came back twice, so the walk is not advancing and what it ` +
            `returned cannot be trusted`,
        );
      }
      received.add(row.id);
      rows.push(row);
    }
    if (rows.length >= CARD_BLOCKAGE_ROW_CEILING) return countByClass(supabase, cloneId, rows);
    after = batch[batch.length - 1].id;
  }
}

async function countByClass(
  supabase: Db,
  cloneId: string,
  walked: readonly OpenBlockageRow[],
): Promise<CardBlockagesRead> {
  const classes = Object.keys(BLOCKAGE_POLICY);
  const open = () =>
    supabase
      .from("clone_sync_blockages")
      .select("first_seen_at", { count: "exact" })
      .eq("clone_id", cloneId)
      .is("cleared_at", null);
  const [all, ...perClass] = await Promise.all([
    open().limit(1),
    ...classes.map((cls) =>
      open().eq("class", cls).order("first_seen_at", { ascending: true }).limit(1),
    ),
  ]);
  if (all.error) return failed(all.error.message);
  if (all.count === null) return failed("the database did not count this clone's open blockages");

  const tallies = new Map<string, ClassTally>();
  let counted = 0;
  for (const [i, res] of perClass.entries()) {
    const cls = classes[i];
    if (res.error) return failed(res.error.message);
    if (res.count === null) {
      return failed(`the database did not count this clone's open ${cls} rows`);
    }
    const firstSeenAt = res.data?.[0]?.first_seen_at ?? null;
    if (res.count > 0 && firstSeenAt === null) {
      return failed(`the database counted ${res.count} open ${cls} rows and returned none of them`);
    }
    tallies.set(cls, { count: res.count, firstSeenAt });
    counted += res.count;
  }
  // The walk is still the only reading of a class the taxonomy does not know.
  counted += walked.filter((r) => !tallies.has(r.class)).length;
  return {
    data: {
      groups: groupCardBlockages(walked, tallies),
      // The counts are separate statements a moment apart; the lines never
      // claim more than the total, and the total never less than the lines.
      total: Math.max(all.count, counted),
      counted,
    },
    error: null,
  };
}

function failed(message: string): CardBlockagesRead {
  return { data: null, error: { message } };
}
