/**
 * What the attempt ceiling actually measures.
 *
 * `claimOne` refuses an event at MAX_ATTEMPTS, and the terminal write in
 * `drainOne` runs only when a CLAIM comes back empty-handed — a tick the
 * platform kills returns nothing at all. Three kills and the event is a
 * zombie: `pending` for ever, claimable by nothing, foldable by nothing
 * (a carrier past the ceiling stands nothing down), and reported nowhere.
 * Measured 16 Sep 2026 at 09:23: the first post-window tick was cut by the
 * 60-second isolate limit mid-probe, spent its attempt, and left no trace
 * but a claim the reclaim would clear ten minutes later.
 *
 * The ceiling exists to stop a pass that LEARNS NOTHING from being retried
 * for ever — not to stop a convergence that happens to be advancing through
 * kills. The rows say which is which: every pass flushes settled evidence
 * and prepared blobs onto its result rows as it goes, and settles each row it
 * finishes, so a killed tick that progressed leaves a fresh write behind it,
 * and one that learned nothing leaves the rows exactly as old as the previous
 * pass left them.
 *
 * ## "A fresh write" is progress kept, never the row being touched
 *
 * This read the newest `updated_at` across the event's rows, and that is not
 * a ledger write: the engine marks a row `pushing` before any work, and a
 * trigger stamps `updated_at` on every write. So a pass cut before it learned
 * anything read exactly like one cut mid-convergence, and was refunded.
 * Measured 20 Oct 2026 (F21 in the 19 Oct hand-over): five events for the CRM
 * line sat at attempts 3 and cycled — claim, cut at 60 s, the stall reclaim,
 * the refund, the next claim — while the line completed no pass after 17 Oct,
 * because its rows were never written again after the `pushing` mark.
 *
 * So the judgement reads `progressed_at`, which a pass writes in exactly the
 * two places the drain already counts as progress for a pass that RETURNED
 * (`done > 0 || progressed` in `drainOne`): a ledger flush holding an entry
 * the pass did not start with (`ledgerGrew`, by identity), and a row's
 * settlement out of the queue. A pass killed after it finished one clone
 * advanced the event exactly as much as one that returned; only the ledger
 * half would have retired it. The claim cannot move the column, a pass that
 * re-did old work cannot move it, and a row no pass has kept anything on is
 * NULL — "nothing kept", which is a verdict, unlike a read that failed.
 *
 * So an exhausted event is judged by its progress, not its counter:
 *
 *  - **Progress kept recently → refund one attempt.** The passes are
 *    converging; the counter is measuring platform kills, not futility. A
 *    ledger is finite (bounded by the candidate and file counts) and a row
 *    settles once, so this cannot loop for ever: progress stops, and the
 *    next look retires.
 *  - **None, or none lately → retire, visibly.** Mark it failed where the
 *    operator lever (Cascade now) can be pulled on purpose, and raise the
 *    notification — a row sitting quiet is the September freeze's shape.
 *  - **Nothing to read → leave it alone.** A failed read is not a verdict,
 *    here as everywhere; the next tick looks again.
 *
 * ## A retirement says what the passes delivered, not what they did not
 *
 * The summary was one fixed sentence — "No pass completed within 3 attempts
 * and the last one kept nothing" — written whatever the rows held. Measured
 * 21 Oct 2026: two retired events had DELIVERED. 302d58ff had opened the
 * client dashboard's pull request (#395, merged green) before its CRM pass was
 * cut every tick and the clones queued behind it starved; fb302fd5 had
 * delivered NPC Test #238 and Preflight #238 and found the client dashboard
 * already in sync, and never reached the CRM. Both read "failed" with a
 * sentence saying nothing had happened, so the operator was told to re-run
 * work that had already landed.
 *
 * The status stays `failed`, deliberately — this changes the sentence, not the
 * verdict. The head redelivery re-asks a head that failed automatically
 * (`failed` or `partial`, never a reviewer's rejection), and the blockage
 * taxonomy names a clone's part `attempts_exhausted` only on a `failed` event
 * at the ceiling: an event with a clone still owed IS unfinished. Nor is the
 * sentence the last word. When a row moves after the retirement — a proposal
 * the passes opened merges — the merge drain's recount rewrites the summary as
 * its counts line, and the carrier settlement keeps that line honest (`never
 * reached`, never `completed`): the recount says how many, this says which.
 * `composeRetirementSummary` is read from the rows as the passes
 * left them, before the terminaliser settles the ones no pass reached, and it
 * groups them by what each row asserts: only `succeeded` asserts content on
 * the clone's branch (`syncPointer.pure.ts`), a `skipped` row carrying a
 * delivered head and no pull request is the engine's verified no-op, and a row
 * naming a pull request is a proposal. Anything still `queued`, `pushing`, or
 * spelled in a way this build has never heard of is "not finished" — the
 * conservative reading, because a row cannot be claimed delivered by a word
 * nobody wrote. Where the rows cannot be read, or there are none, the fixed
 * sentence stands: a failed read is not a verdict here either.
 */

export type ExhaustedEventVerdict =
  | { act: "refund"; why: string }
  | { act: "retire"; why: string }
  | { act: "leave"; why: string };

/**
 * How recently progress must have been kept to count as "this event is still
 * getting somewhere". Deliberately wider than the 10-minute stall reclaim: a
 * killed tick's last write is at least that old by the time the reclaim
 * releases its claim and this judgement can see the event at all — a window
 * narrower than the reclaim would retire every kill, progressing or not. And
 * narrower than two reclaims: progress the attempt BEFORE the last one kept
 * is twenty minutes old by then, so only the last attempt's progress refunds.
 */
export const EXHAUSTED_PROGRESS_WINDOW_MS = 15 * 60_000;

/**
 * The column a pass stamps when it keeps progress (a grown ledger, a settled
 * row), and the one this judgement reads. Named once: a literal at each end is
 * how the writer and the reader come to disagree.
 */
export const PROGRESS_COLUMN = "progressed_at";

export function decideExhaustedEvent(input: {
  attempts: number;
  maxAttempts: number;
  /**
   * Newest `progressed_at` across the event's result rows: the last time a
   * pass KEPT progress on one. Null where no row has one.
   */
  lastProgressAt: string | null;
  /** The rows could not be read. A failed read is not a verdict. */
  readFailed: boolean;
  nowMs: number;
}): ExhaustedEventVerdict {
  if (input.attempts < input.maxAttempts) {
    return { act: "leave", why: "under the ceiling — the ordinary claim path owns it" };
  }
  if (input.readFailed) {
    return { act: "leave", why: "the rows could not be read, and a failed read is no verdict" };
  }
  if (input.lastProgressAt === null) {
    return {
      act: "retire",
      why: "no pass on this event kept anything it did not start with",
    };
  }
  const keptAt = Date.parse(input.lastProgressAt);
  if (!Number.isFinite(keptAt)) {
    return { act: "leave", why: "the progress timestamp is unreadable; the next tick looks again" };
  }
  if (input.nowMs - keptAt <= EXHAUSTED_PROGRESS_WINDOW_MS) {
    return {
      act: "refund",
      why: "the last pass kept progress before it was cut — converging, not failing",
    };
  }
  return { act: "retire", why: "three passes and nothing kept lately" };
}

/** The operator's lever, the last sentence of every retirement. */
const RETIREMENT_LEVER = `The queue will not claim this event again; "Cascade now" runs prime's head fresh.`;

function nothingKeptLead(maxAttempts: number): string {
  return (
    `No pass completed within ${maxAttempts} attempts and the last one kept nothing — ` +
    `the ticks that spent them were cut before they could report.`
  );
}

/**
 * The summary a retired event carries when its rows say nothing better:
 * naming the lever rather than the mystery.
 */
export function retirementSummary(maxAttempts: number): string {
  return `${nothingKeptLead(maxAttempts)} ${RETIREMENT_LEVER}`;
}

/** A result row as the retirement reads it, before the unreached ones are settled. */
export type RetiringRow = {
  clone_name: string | null;
  status: string;
  /** The prime head a pass delivered or found already present. */
  delivered_sha: string | null;
  pr_url: string | null;
};

type RetiringGroup = "delivered" | "inSync" | "proposed" | "skipped" | "failed" | "unfinished";

/** In the order the sentence names them: what landed first, what is owed last. */
const RETIRING_GROUPS: ReadonlyArray<{ group: RetiringGroup; label: string }> = [
  { group: "delivered", label: "Delivered" },
  { group: "inSync", label: "Already in sync" },
  { group: "proposed", label: "Proposed" },
  { group: "skipped", label: "Skipped" },
  { group: "failed", label: "Failed" },
  { group: "unfinished", label: "Not finished" },
];

function retiringGroupOf(row: RetiringRow): RetiringGroup {
  switch (row.status) {
    case "succeeded":
      return "delivered";
    case "pr_opened":
      return "proposed";
    case "failed":
      return "failed";
    case "skipped":
      // A skip naming a pull request is the engine's "already proposed"; one
      // carrying a delivered head and no pull request is its verified no-op.
      if (row.pr_url) return "proposed";
      if (row.delivered_sha) return "inSync";
      return "skipped";
    default:
      // `queued`, `pushing`, and any status this build has never heard of.
      return "unfinished";
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function cloneList(rows: readonly RetiringRow[]): string {
  const named = rows
    .map((r) => r.clone_name?.trim() ?? "")
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b, "en"));
  const unnamed = rows.length - named.length;
  if (unnamed === 1) named.push("an unnamed clone");
  if (unnamed > 1) named.push(`${unnamed} unnamed clones`);
  return joinNames(named);
}

/**
 * The summary a retired event carries, read from what its passes left on the
 * rows. `rows` is null where they could not be read, and the fixed sentence
 * stands then — as it does where there are none.
 */
export function composeRetirementSummary(input: {
  maxAttempts: number;
  rows: readonly RetiringRow[] | null;
}): string {
  const rows = input.rows ?? [];
  if (rows.length === 0) return retirementSummary(input.maxAttempts);

  const parts = RETIRING_GROUPS.map(({ group, label }) => {
    const members = rows.filter((r) => retiringGroupOf(r) === group);
    return members.length > 0 ? `${label}: ${cloneList(members)}.` : null;
  }).filter((part): part is string => part !== null);

  const unfinished = rows.filter((r) => retiringGroupOf(r) === "unfinished").length;
  const lead =
    unfinished === rows.length
      ? nothingKeptLead(input.maxAttempts)
      : unfinished > 0
        ? `Retired after ${input.maxAttempts} attempts, part-way through.`
        : `Retired after ${input.maxAttempts} attempts, with every clone's row settled.`;

  return [lead, ...parts, RETIREMENT_LEVER].join(" ");
}
