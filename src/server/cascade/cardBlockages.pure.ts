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
 * ## The database folds the rows, in one statement
 *
 * The lines come from `clone_open_blockage_groups`
 * (`20260927100000_clone_open_blockage_groups.sql`): every open row on the
 * clone, one line per class, each with its count and its oldest row, and on
 * every line the totals over all lines. It is one statement, so the lines and
 * the totals describe one moment. Every reading this card tried before it was
 * either cut short or assembled from statements that saw different moments.
 *
 * PostgREST caps an answer and says nothing when it does. The lines of a class
 * this build knows come first, and there are few of them, so a cap can only cut
 * lines of a class it does not know. The totals were counted before the cap,
 * so `total - counted` is exactly the rows the lines that arrived leave out,
 * and the card says so.
 *
 * ## A class the taxonomy no longer knows
 *
 * A row can outlive its class. The card falls back to the row's own detail
 * for its sentence, and two such rows need not say the same thing. So the
 * database splits such a class by detail, and one row's words are never drawn
 * over another's.
 *
 * ## An answer that contradicts itself is not drawn
 *
 * One statement computes the totals once, so every line carries the same pair,
 * and a whole answer's lines add up to its total. An answer that breaks either
 * rule is not something this module understands, and drawing it would put a
 * number on the card nobody measured. It is refused, and the card draws the
 * refusal as "could not be read", never as a shorter list.
 */
import {
  BLOCKAGE_POLICY,
  type BlockageClass,
  type BlockageOwner,
} from "@/server/cascade/blockageTaxonomy.pure";

/** Every class this build knows, as the database is told them. */
export const KNOWN_BLOCKAGE_CLASSES: readonly string[] = Object.keys(BLOCKAGE_POLICY);

/** One line of `clone_open_blockage_groups`, as PostgREST returns it. */
export type OpenBlockageLine = {
  class: string;
  /** Null on a class the caller named as known; that class's rows' detail otherwise. */
  detail: string | null;
  /** The oldest row's owner. A known class takes its owner from the taxonomy instead. */
  owner: string;
  /** The oldest row's flag. A known class takes its flag from the taxonomy instead. */
  self_heals: boolean;
  open_count: number;
  oldest_first_seen_at: string;
  /** Every open row on the clone, counted before any cap. The same on every line. */
  total_open: number;
  /** Every line of the answer, counted before any cap. The same on every line. */
  total_lines: number;
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

/** What the card is handed: its lines, and how much of the ledger they cover. */
export type CardBlockages = {
  /** One line per open class, oldest class first. */
  groups: CardBlockageGroup[];
  /** Every open row on this clone. */
  total: number;
  /**
   * How many of those rows the lines count. Below `total` only when PostgREST
   * cut the answer, which can only cut lines of a class this build does not
   * know: the card says how many rows that leaves out.
   */
  counted: number;
};

/** The database's answer read as the card draws it, or why it cannot be. */
export type CardBlockagesAnswer =
  | { ok: true; blockages: CardBlockages }
  | { ok: false; reason: string };

/**
 * The lines of one `clone_open_blockage_groups` answer, one per class, oldest
 * class first.
 *
 * A known class takes its owner, self-heal flag and sentence from the
 * taxonomy, the one source the sentence already comes from, so a line cannot
 * pair one policy's words with another's owner. An unknown class keeps the
 * line's own values, because nothing else describes it.
 */
export function cardBlockagesFrom(lines: readonly OpenBlockageLine[]): CardBlockagesAnswer {
  if (lines.length === 0) {
    // No line means no open row: a cap never leaves an answer empty.
    return { ok: true, blockages: { groups: [], total: 0, counted: 0 } };
  }

  const { total_open: total, total_lines: totalLines } = lines[0];
  if (!isCount(total) || !isCount(totalLines)) {
    return refused("the answer's totals are not counts");
  }

  const groups = new Map<string, CardBlockageGroup>();
  let counted = 0;
  for (const line of lines) {
    if (line.total_open !== total || line.total_lines !== totalLines) {
      return refused("the answer's lines disagree about its totals");
    }
    if (!isCount(line.open_count) || line.open_count === 0) {
      return refused(`a ${line.class} line stands for no rows`);
    }
    counted += line.open_count;

    const policy = policyOf(line.class);
    if (!policy && !line.detail) {
      // The detail is the only sentence an unknown class has, and the card
      // never draws a class name in its place.
      return refused(`a line of a class this build does not know came back without its words`);
    }
    const key = policy ? line.class : `${line.class}:${line.detail}`;
    const group = groups.get(key);
    if (group) {
      // One class the database split, drawn once: the defect this card had.
      group.count += line.open_count;
      if (earlier(line.oldest_first_seen_at, group.firstSeenAt)) {
        group.firstSeenAt = line.oldest_first_seen_at;
      }
      continue;
    }
    groups.set(key, {
      key,
      cls: line.class as BlockageClass,
      owner: policy ? policy.owner : (line.owner as BlockageOwner),
      what: policy ? policy.what : (line.detail as string),
      count: line.open_count,
      firstSeenAt: line.oldest_first_seen_at,
      selfHeals: policy ? policy.selfHeals : line.self_heals,
    });
  }

  if (lines.length > totalLines || counted > total) {
    return refused("the answer's lines claim more than its totals");
  }
  if (lines.length === totalLines && counted !== total) {
    // Every line arrived, so the lines are every open row.
    return refused("the answer's lines do not add up to its total");
  }

  return {
    ok: true,
    blockages: {
      groups: [...groups.values()].sort(
        (a, b) => order(a.firstSeenAt) - order(b.firstSeenAt) || a.key.localeCompare(b.key),
      ),
      total,
      counted,
    },
  };
}

/** Whether the taxonomy knows this class, as a guard rather than a cast. */
function isKnownBlockageClass(cls: string): cls is BlockageClass {
  return Object.prototype.hasOwnProperty.call(BLOCKAGE_POLICY, cls);
}

function policyOf(cls: string) {
  return isKnownBlockageClass(cls) ? BLOCKAGE_POLICY[cls] : undefined;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function refused(reason: string): CardBlockagesAnswer {
  return { ok: false, reason };
}

/** A start for sorting: an unreadable one sorts last rather than first. */
function order(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function earlier(a: string, b: string): boolean {
  return order(a) < order(b);
}
