import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  KNOWN_BLOCKAGE_CLASSES,
  cardBlockagesFrom,
  type CardBlockages,
} from "@/server/cascade/cardBlockages.pure";

type Db = SupabaseClient<Database>;

/** A read of the card's blockages, shaped like the PostgREST result it replaces. */
export type CardBlockagesRead =
  | { data: CardBlockages; error: null }
  | { data: null; error: { message: string } };

/**
 * Every open blockage on one clone, as the card draws it: one line per class,
 * each with the number of rows behind it.
 *
 * ## One statement, in the database
 *
 * Each reading this card tried before missed something, and review found each
 * gap in turn (PR #299):
 *
 * 1. **The six, then the 500, oldest rows.** A class whose first row fell past
 *    the cut was not drawn, and a class spanning it was undercounted.
 * 2. **A walk by `id`.** Ids are `gen_random_uuid()`, so a row opened while the
 *    walk ran could sort behind the cursor, and the empty page that ended the
 *    walk reported a partial reading as complete. No key on this table is
 *    monotonic in commit order.
 * 3. **One read with its count, then a count per class past it.** Each count
 *    was its own statement and saw its own snapshot, so a reconciliation that
 *    cleared rows between two of them could draw 501 open rows on a clone with
 *    none.
 *
 * So the card asks the database to do the folding:
 * `clone_open_blockage_groups` reads every open row on the clone in ONE
 * statement and returns one line per class, with the totals over every line.
 * Lines and totals describe one moment by construction, however many rows
 * there are and whatever cap PostgREST applies (`cardBlockages.pure.ts` reads
 * the totals to say what a cap left out).
 *
 * It names the classes this build knows, because the database cannot know
 * them: a class it does not know comes back split by detail, since its detail
 * is its sentence.
 *
 * ## Read-only, three times over
 *
 * The function is `stable`, so Postgres refuses any write from inside it. It
 * runs as the caller (`security invoker`), so the table's RLS decides what it
 * sees, as the direct read did. And it is called as a GET, which PostgREST runs
 * in a read-only transaction.
 *
 * A failed request, or an answer that contradicts itself, fails the whole
 * read. The card draws that as "could not be read", never as a shorter list.
 */
export async function readCardBlockages(supabase: Db, cloneId: string): Promise<CardBlockagesRead> {
  const { data, error } = await supabase.rpc(
    "clone_open_blockage_groups",
    { _clone_id: cloneId, _known_classes: [...KNOWN_BLOCKAGE_CLASSES] },
    { get: true },
  );
  if (error) return failed(error.message);
  if (!Array.isArray(data)) {
    // A read that returned nothing did not say that nothing is open.
    return failed("the database gave no answer for this clone's open blockages");
  }
  const answer = cardBlockagesFrom(data);
  return answer.ok ? { data: answer.blockages, error: null } : failed(answer.reason);
}

function failed(message: string): CardBlockagesRead {
  return { data: null, error: { message } };
}
