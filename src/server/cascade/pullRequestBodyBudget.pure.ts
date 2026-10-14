/**
 * Keeps a cascade pull request's description inside GitHub's limit.
 *
 * ## Why this exists
 *
 * GitHub refuses a pull request body longer than 65,536 characters, and it
 * refuses the whole request: `pulls.create` answers 422 "body is too long" and
 * no pull request exists. The cascade body lists every file it synchronizes,
 * one line each, so its length grows with how far behind a clone is. On
 * 13 Oct 2026 `preflight-property-group` was far enough behind that the list
 * alone passed the limit, the cascade result was written `failed` with
 * "Could not open a cascade pull request", and the clone could not be synced
 * at all. `npc-test-76b3b3` is the same distance behind and would have failed
 * the same way.
 *
 * ## The rule
 *
 * Only the file list is ever shortened. Every other section of the body says
 * something the commit does not: a held file this cascade breaks, wiring a
 * held file is missing, paths that need a human. The file list says nothing
 * the commit message does not, because the commit message lists every path
 * the commit writes or deletes. So the list is cut, and says so and how many
 * it left out; the sections around it are kept whole.
 *
 * A body that fits is returned byte for byte as before. Only when the sections
 * around the list are themselves too long is the body cut at a line, with a
 * note saying it was cut, because a pull request with a shortened description
 * is recoverable and no pull request at all is not.
 *
 * ## Why bytes
 *
 * GitHub's limit is in characters, and the body is measured here in UTF-8
 * bytes, which is never fewer. Measuring the larger number keeps the answer
 * under the limit however GitHub counts a character, at the cost of a list a
 * few lines shorter where it carries non-ASCII paths.
 */

/** GitHub's own limit on a pull request body, in characters. */
export const GITHUB_PR_BODY_LIMIT = 65_536;

/**
 * The budget a body is held to, in UTF-8 bytes. Below the limit by enough to
 * leave room for anything GitHub itself adds, and for an estimate of a
 * character count that a byte count can only overstate.
 */
export const PR_BODY_BUDGET_BYTES = 60_000;

/** Said in place of the files a shortened list leaves out. */
export const omittedFilesLine = (omitted: number): string =>
  `- …and ${omitted} more file(s); the full list is in this commit's message.`;

/** Said at the foot of a body that had to be cut as a whole. */
export const BODY_CUT_NOTE =
  "_This description was cut at GitHub's length limit. The commit message lists every file this cascade carries._";

const encoder = new TextEncoder();
const bytesOf = (s: string): number => encoder.encode(s).length;

export type FittedBody = {
  body: string;
  /** How many list items were left out of the body (0 when none were). */
  omittedItems: number;
  /** True when the sections around the list had to be cut as well. */
  cutWhole: boolean;
};

/**
 * The longest prefix of `text`, cut at a line, that fits in `room` bytes.
 * A single line longer than `room` is never split, so the answer may be "".
 */
const prefixByLines = (text: string, room: number): string => {
  if (room <= 0) return "";
  if (bytesOf(text) <= room) return text;
  const lines = text.split("\n");
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const cost = bytesOf(line) + (kept > 0 ? 1 : 0);
    if (used + cost > room) break;
    used += cost;
    kept += 1;
  }
  return lines.slice(0, kept).join("\n");
};

/**
 * Assembles `head`, the list `items` (joined with newlines) and `tail`, keeping
 * the result within `budgetBytes`. See the module header for which part gives
 * way first and why.
 */
export function fitPullRequestBody(args: {
  head: string;
  items: readonly string[];
  tail: string;
  budgetBytes?: number;
}): FittedBody {
  const budget = args.budgetBytes ?? PR_BODY_BUDGET_BYTES;
  const { head, items, tail } = args;

  const whole = head + items.join("\n") + tail;
  if (bytesOf(whole) <= budget) return { body: whole, omittedItems: 0, cutWhole: false };

  // The list gives way first. The note is priced at the largest count it can
  // state, so adding it can never push the body back over.
  const fixed = bytesOf(head) + bytesOf(tail);
  const noteCost = bytesOf(omittedFilesLine(items.length)) + 1;
  const room = budget - fixed - noteCost;
  if (room >= 0) {
    let used = 0;
    let kept = 0;
    for (const item of items) {
      const cost = bytesOf(item) + (kept > 0 ? 1 : 0);
      if (used + cost > room) break;
      used += cost;
      kept += 1;
    }
    const omitted = items.length - kept;
    const list =
      items.slice(0, kept).join("\n") + (kept > 0 ? "\n" : "") + omittedFilesLine(omitted);
    return { body: head + list + tail, omittedItems: omitted, cutWhole: false };
  }

  // Even an empty list leaves the body too long, so the body itself is cut at
  // a line, after the list has been reduced to its note.
  const reduced = head + omittedFilesLine(items.length) + tail;
  const note = `\n\n${BODY_CUT_NOTE}`;
  const kept = prefixByLines(reduced, budget - bytesOf(note));
  return { body: kept + note, omittedItems: items.length, cutWhole: true };
}
