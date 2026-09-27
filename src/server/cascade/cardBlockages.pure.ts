/**
 * The open blockages a clone's sync card lists: every class, once, with how
 * many rows stand behind it.
 *
 * ## Why grouped, and why every class
 *
 * The card read the six OLDEST open rows and drew each one's class sentence.
 * Measured on 27 Sep 2026, that did two things wrong.
 *
 * - **It drew one sentence six times and said nothing about the rest.** The
 *   CRM independent held 52 open `prime_ledger_hole` rows, one per version.
 *   The card drew the same class sentence six times and never said there were
 *   forty-six more. A reader could not tell six from fifty-two.
 * - **A class that opened later could not appear at all.** Ordered oldest
 *   first and cut at six, every row after the sixth was invisible whatever its
 *   class. A red cascade PR (`ci_red`), the blockage most worth an operator's
 *   attention on the day it opens, would have been row 53 on that clone. The
 *   card that exists to say why a clone is not converging would have shown
 *   six copies of an old reason and hidden the new one.
 *
 * The card never draws a row's own detail. It draws the taxonomy's sentence
 * for the class, so two rows of one class are the same line said twice. One
 * line per class, with the number of rows behind it, loses nothing the card
 * showed and shows every class that is open. The rows themselves, each with
 * its own detail, are on the prime page's per-clone comparison.
 *
 * ## A class the taxonomy no longer knows
 *
 * A row can outlive its class. The card falls back to the row's own detail
 * for its sentence, and two such rows need not say the same thing. So they
 * are grouped by class AND detail, and one row's words are never drawn over
 * another's.
 */
import {
  BLOCKAGE_POLICY,
  type BlockageClass,
  type BlockageOwner,
} from "@/server/cascade/blockageTaxonomy.pure";

/** An open `clone_sync_blockages` row, as the card's read selects it. */
export type OpenBlockageRow = {
  id: string;
  class: string;
  owner: string;
  detail: string;
  first_seen_at: string;
  self_heals: boolean;
};

/** One line on the card: a class that is open, and how much of it. */
export type CardBlockageGroup = {
  /** A stable key for the line, unique within one card. */
  key: string;
  cls: BlockageClass;
  owner: BlockageOwner;
  /** The taxonomy's own operator prose. Never the class name. */
  what: string;
  /** How many open rows this line stands for. */
  count: number;
  /** When the OLDEST of them was first seen. */
  firstSeenAt: string;
  selfHeals: boolean;
};

/**
 * Every open row, one line per class, oldest class first.
 *
 * A known class takes its owner, self-heal flag and sentence from the
 * taxonomy, the one source the sentence already comes from, so a line cannot
 * pair one policy's words with another's owner. An unknown class keeps the
 * row's own values, because nothing else describes it.
 */
export function groupCardBlockages(rows: readonly OpenBlockageRow[]): CardBlockageGroup[] {
  const groups = new Map<string, CardBlockageGroup>();
  for (const row of rows) {
    const cls = row.class as BlockageClass;
    const policy = Object.prototype.hasOwnProperty.call(BLOCKAGE_POLICY, cls)
      ? BLOCKAGE_POLICY[cls]
      : undefined;
    const key = policy ? row.class : `${row.class}:${row.detail}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        cls,
        owner: policy ? policy.owner : (row.owner as BlockageOwner),
        what: policy ? policy.what : row.detail,
        count: 1,
        firstSeenAt: row.first_seen_at,
        selfHeals: policy ? policy.selfHeals : row.self_heals,
      });
      continue;
    }
    group.count += 1;
    if (earlier(row.first_seen_at, group.firstSeenAt)) group.firstSeenAt = row.first_seen_at;
  }
  return [...groups.values()].sort(
    (a, b) => order(a.firstSeenAt) - order(b.firstSeenAt) || a.key.localeCompare(b.key),
  );
}

/** A start for sorting: an unreadable one sorts last rather than first. */
function order(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function earlier(a: string, b: string): boolean {
  return order(a) < order(b);
}
