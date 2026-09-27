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

/**
 * How many open rows the card's one read asks for. Below PostgREST's cap, and
 * never trusted to be it: whether the read carried everything is decided by
 * the count that comes back with it, never by how many rows arrived.
 *
 * The largest class on any clone is `prime_ledger_hole`, fed by at most fifty
 * notes (`PRIME_LEDGER_HOLE_NOTE_CAP`) and the few holes held migrations name
 * — 52 rows on the CRM independent on 27 Sep 2026 — so a clone has more open
 * rows than this only through something new.
 */
export const CARD_BLOCKAGE_READ_LIMIT = 500;

/** A read of the card's blockages, shaped like the PostgREST result it replaces. */
export type CardBlockagesRead =
  | { data: CardBlockages; error: null }
  | { data: null; error: { message: string } };

/**
 * Every open blockage on one clone, as the card draws it: one line per class,
 * each with the number of rows behind it.
 *
 * ## One statement, and the count that comes with it
 *
 * The card read the six oldest open rows, and the first version of this
 * change the oldest 500. Either way a class whose first row fell past the cut
 * was not drawn and a class spanning it was undercounted, while the card
 * claimed to list every open class.
 *
 * Paging does not settle it either. A walk by `id` misses any row opened
 * while it runs: ids are `gen_random_uuid()`, so a new row can sort behind the
 * cursor, and the empty page that ends the walk then reports a partial reading
 * as complete. No key closes that. `created_at` is taken when the inserting
 * statement starts rather than when it commits, and the ledger opens rows with
 * an old `first_seen_at` on purpose.
 *
 * So the card reads once. PostgREST computes an exact count in the same
 * statement as the rows it returns, so the two describe one moment. When the
 * count is no more than the rows returned, that one statement carried every
 * open row: a complete and consistent reading, whatever PostgREST's cap was.
 * That is every clone today.
 *
 * ## When one statement cannot carry them
 *
 * The card asks the database for one count per class the taxonomy knows, with
 * each class's oldest row. A count and its oldest row are one statement, so
 * every known class is drawn with its true count, however many rows it has. A
 * class this build does not know is drawn from the rows the first read
 * carried. The rest of its rows cannot be counted by class, so the card says
 * how many rows it leaves out.
 *
 * A failed request, or a count the database did not give, fails the whole
 * read. The card draws that as "could not be read", never as a shorter list.
 * Read-only by construction: it names one table and never writes it.
 */
export async function readCardBlockages(supabase: Db, cloneId: string): Promise<CardBlockagesRead> {
  const first = await supabase
    .from("clone_sync_blockages")
    .select("id, class, owner, detail, first_seen_at, self_heals", { count: "exact" })
    .eq("clone_id", cloneId)
    .is("cleared_at", null)
    .order("first_seen_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(CARD_BLOCKAGE_READ_LIMIT);
  if (first.error) return failed(first.error.message);
  if (first.count === null) {
    return failed("the database did not count this clone's open blockages");
  }
  const rows = (first.data ?? []) as OpenBlockageRow[];
  if (first.count <= rows.length) {
    // The statement that returned these rows counted no more: every open row is here.
    return {
      data: { groups: groupCardBlockages(rows), total: rows.length, counted: rows.length },
      error: null,
    };
  }
  return countByClass(supabase, cloneId, rows);
}

async function countByClass(
  supabase: Db,
  cloneId: string,
  carried: readonly OpenBlockageRow[],
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
  if (all.count === null) {
    return failed("the database did not count this clone's open blockages");
  }

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
  // The first read is still the only reading of a class the taxonomy does not know.
  counted += carried.filter((r) => !tallies.has(r.class)).length;
  return {
    data: {
      groups: groupCardBlockages(carried, tallies),
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
