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
 *
 * ## A class the database counted
 *
 * The card reads its rows in one statement (`cardBlockagesRead.server.ts`).
 * When that statement cannot carry every open row, the reader asks the
 * database to count each known class instead, and those counts are handed in
 * as `tallies`. A counted class is whole, so its line is the count and nothing
 * the first read carried of it is added again. A class the database counted at
 * zero draws no line, even if the first read, which ran before, carried a row
 * of it.
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

/**
 * The database's own count of one known class's open rows on a clone, and
 * when the oldest of them was first seen. `firstSeenAt` is null only when
 * nothing is open.
 */
export type ClassTally = { count: number; firstSeenAt: string | null };

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

/** What the card is handed: its lines, and how much of the ledger they cover. */
export type CardBlockages = {
  /** One line per open class, oldest class first. */
  groups: CardBlockageGroup[];
  /** Every open row on this clone. */
  total: number;
  /**
   * How many of those rows the lines count. Below `total` only when rows of
   * a class this build does not know lay past what one read could carry,
   * which is the one thing a count by class cannot reach: the card says how
   * many.
   */
  counted: number;
};

/**
 * Every open row, one line per class, oldest class first.
 *
 * A known class takes its owner, self-heal flag and sentence from the
 * taxonomy, the one source the sentence already comes from, so a line cannot
 * pair one policy's words with another's owner. An unknown class keeps the
 * row's own values, because nothing else describes it.
 *
 * A class in `tallies` is drawn from its count and never from its rows.
 */
export function groupCardBlockages(
  rows: readonly OpenBlockageRow[],
  tallies?: ReadonlyMap<string, ClassTally>,
): CardBlockageGroup[] {
  const groups = new Map<string, CardBlockageGroup>();
  // Only a class the taxonomy knows can be drawn from a count, so only its
  // rows are set aside for one.
  const counted = new Set<string>();
  for (const [cls, tally] of tallies ?? []) {
    const policy = policyOf(cls);
    if (!policy) continue;
    counted.add(cls);
    if (tally.count <= 0) continue;
    groups.set(cls, {
      key: cls,
      cls: cls as BlockageClass,
      owner: policy.owner,
      what: policy.what,
      count: tally.count,
      // Never empty while the count is above zero: the reader refuses a
      // count with no oldest row. An empty start would sort last.
      firstSeenAt: tally.firstSeenAt ?? "",
      selfHeals: policy.selfHeals,
    });
  }
  for (const row of rows) {
    // Counted whole by the database; its rows would count it twice.
    if (counted.has(row.class)) continue;
    const cls = row.class as BlockageClass;
    const policy = policyOf(row.class);
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

/** Whether the taxonomy knows this class, as a guard rather than a cast. */
function isKnownBlockageClass(cls: string): cls is BlockageClass {
  return Object.prototype.hasOwnProperty.call(BLOCKAGE_POLICY, cls);
}

function policyOf(cls: string) {
  return isKnownBlockageClass(cls) ? BLOCKAGE_POLICY[cls] : undefined;
}

/** A start for sorting: an unreadable one sorts last rather than first. */
function order(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function earlier(a: string, b: string): boolean {
  return order(a) < order(b);
}
