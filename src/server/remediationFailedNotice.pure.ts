/**
 * When an exhausted self-healing run tells a person, and where it sends them.
 *
 * ## The defect
 *
 * A run that spends its last attempt files a `remediation_failed` notice, and
 * that was one notice per RUN. A standing fault exhausts a run, then the run
 * planned after it, then the one after that, so the inbox heard the same
 * sentence once per run for as long as the fault stood. Measured 27 Oct 2026:
 * 116 notices, all unread and all `edge_function_deploy`, from four standing
 * faults on four clones. Three were a 413 from the Management API on a bundle
 * over its size limit (`ai-dashboard-agent` on three clones,
 * `generate-investment-report` on the CRM line), and the fourth was GitHub's
 * "Not Found" on the workflow-runs read that followed. From 21 Oct they came
 * at 7 to 32 a day across the fleet, 32 on 24 Oct: about six per clone per day
 * at the peak, each saying what the last one said.
 *
 * Every one linked to `/support/tickets`, and not one had a ticket. The
 * cascade's backend sync plans its deploy runs with no ticket behind them
 * (`backendSync.server.ts`), so the link opened a queue that does not list
 * them.
 *
 * ## The rule
 *
 * **No notice is filed while an unread one stands for the same clone, the
 * same action and the same error.** Reading the notice is the acknowledgement,
 * so the next failure after it is read speaks again: the fault has outlived
 * the person who saw it. A failure that changes shape (another function,
 * another status) is a different error and speaks at once. This is
 * `cascade_blocked`'s rule (`cascade/blockedEscalation.pure.ts`): a
 * fingerprint, not a timer.
 *
 * ## The error is normalised before it is compared
 *
 * Raw equality would have kept part of the noise. The deploy lane reports
 * `all N function deploys failed: <the first failure>`, and N is the size of
 * the batch that pass happened to attempt: 1 on one pass and 2 on the next,
 * over the same 413 on the same function. Supabase's bundler names its
 * scratch directory after a UUID and a process number, so a timeout reported
 * from inside it never reads the same twice. Those, timestamps, epochs, hex
 * digests, GitHub run and job ids and attempt counters are replaced. The
 * action, the function, the status and the message are kept, because a 400 is
 * not a 413 and a second function failing is a second fault. So is a
 * migration version: it names WHICH migration failed, and the lane stops at
 * the first one, so a different version failing means the first got through.
 *
 * Replayed over the 116, the rule files 9: one per fault per clone.
 *
 * ## A read that fails files the notice
 *
 * The merge drain makes the opposite choice for `cascade_blocked`, and the
 * difference is cadence. That notice is considered on every five-minute tick,
 * so a dedupe read that failed would repeat it all day; this one is considered
 * once per exhausted run. A failed read here costs at most one duplicate,
 * while treating it as "already said" could cost the only notice of a
 * failure. A read that failed found nothing either way.
 *
 * Client-safe: pure, no imports.
 */

/**
 * The volatile parts of an error, in the order they are replaced.
 *
 * Order matters: an instant is replaced before anything could read its year
 * as an epoch, and a UUID before the hex rule could eat its first group.
 */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  // An ISO-8601 instant: 2026-10-21T07:32:25.702Z, 2026-10-21 07:32:25+00.
  [
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g,
    "<time>",
  ],
  // An HTTP date, as a response body quotes one: Mon, 27 Oct 2026 08:21:00 GMT.
  [
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
    "<time>",
  ],
  // A time of day standing alone.
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>"],
  // A UUID, and the process number Supabase's bundler glues to the one in its
  // scratch path (`user_fn_<ref>_<uuid>_4220/`).
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_\d+)?/gi, "<id>"],
  // A commit or a digest: seven or more hex characters with a digit and a
  // letter among them. A slug never qualifies (`ai-dashboard-agent` has
  // letters past `f`), and neither does a number with no letter in it.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "<sha>"],
  // An epoch in seconds or milliseconds. A migration version is fourteen
  // digits beginning `20` and is never touched.
  [/\b1\d{9}(?:\d{3})?\b/g, "<epoch>"],
  // A GitHub run, job or check-run id, in a path (`/runs/123`) or a sentence
  // (`run 123`). `workflow-runs#list-…` names no id and is left as it is.
  [/\b(runs?|jobs?|check[-_]runs?)([/ #:=]+)\d+/gi, "$1$2<n>"],
  // The size of the batch that failed, not the fault.
  [/\ball \d+ function deploys failed\b/g, "all <n> function deploys failed"],
  // An attempt counter: `attempt 3`, `attempt 3 of 30`, `attempts: 3/30`.
  [/\battempts?\b[\s:#]*\d+(?:\s*(?:\/|of)\s*\d+)?/gi, "attempt <n>"],
  // …and the same counter written the other way round: `after 4 attempts`.
  [/\b\d+(?:\s*(?:\/|of)\s*\d+)?\s+attempts?\b/gi, "<n> attempts"],
];

/**
 * How much of the normalised error the fingerprint keeps.
 *
 * What tells two faults apart sits at the front of the message (the action's
 * own words, the function, the status), and the fingerprint travels in a
 * PostgREST filter, so it is bounded rather than the whole of a 2,000-character
 * `last_error`.
 */
export const FINGERPRINT_ERROR_CHARS = 500;

/**
 * The error with its volatile parts replaced and its whitespace collapsed.
 *
 * Read from the first 2,000 characters, which is all `last_error` keeps of it
 * anyway, so a pathological message costs the patterns nothing extra.
 */
export function normaliseRemediationError(message: string): string {
  let out = message.slice(0, 2000);
  for (const [pattern, replacement] of VOLATILE) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().slice(0, FINGERPRINT_ERROR_CHARS);
}

/**
 * One stable identity for one way an action fails.
 *
 * The clone is not in it: the read that compares fingerprints is already
 * scoped to the notice's own `clone_id` column, which is where a person
 * filtering the inbox by clone reads it too.
 */
export function remediationFailureFingerprint(input: {
  actionType: string;
  error: string;
}): string {
  return `${input.actionType}:${normaliseRemediationError(input.error)}`;
}

/**
 * What the read for a standing notice returned.
 *
 * `standing` is only meaningful when the read succeeded, which is why it is
 * not on the failed shape at all: a caller cannot read a failure as "none".
 */
export type StandingNoticeRead =
  | { readonly ok: true; readonly standing: boolean }
  | { readonly ok: false; readonly error: string };

/** Whether to file the notice, and the sentence that says why. */
export function decideRemediationFailedNotice(read: StandingNoticeRead): {
  file: boolean;
  why: string;
} {
  if (!read.ok) {
    return {
      file: true,
      why: `could not read whether one already stands (${read.error}); filing, because a duplicate is cheaper than a lost failure`,
    };
  }
  if (read.standing) {
    return {
      file: false,
      why: "an unread notice already stands for this clone, action and error",
    };
  }
  return { file: true, why: "no unread notice stands for this clone, action and error" };
}

/**
 * Where the notice sends a person.
 *
 * The ticket when there is one: `/support/tickets` lists the ticket and the
 * runs it planned. Without one, the clone, whose page is where its deploys and
 * backend are read. A run with neither is the prime's own security fix, which
 * no clone page shows; it keeps the support page, where self-healing is run.
 */
export function remediationFailedUrl(input: {
  cloneId: string | null;
  ticketId: string | null;
}): string {
  if (input.ticketId) return "/support/tickets";
  if (input.cloneId) return `/clones/${input.cloneId}`;
  return "/support/tickets";
}

/** The notice a run that spent its last attempt files. */
export function describeRemediationFailure(input: {
  runId: string;
  ticketId: string | null;
  cloneId: string | null;
  actionType: string;
  error: string;
}): {
  title: string;
  body: string;
  url: string;
  metadata: { run_id: string; ticket_id: string | null; action_type: string; fingerprint: string };
} {
  return {
    title: `Self-healing failed · ${input.actionType.replace(/_/g, " ")}`,
    body: input.error.slice(0, 400),
    url: remediationFailedUrl(input),
    metadata: {
      run_id: input.runId,
      ticket_id: input.ticketId,
      action_type: input.actionType,
      fingerprint: remediationFailureFingerprint(input),
    },
  };
}
