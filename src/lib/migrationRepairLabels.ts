/**
 * What a re-run reading and a repair are called on screen.
 *
 * ## Why this is in `lib` and not beside the judgement
 *
 * `convergenceLabels.ts` states the seam and it holds here unchanged:
 * `src/server/**` is denied to the client environment, the judgement stays
 * there because only the server makes it, and the words stay here because only
 * the client draws them. A reading crosses to the browser as DATA — a word, a
 * count, a line number — and the sentence built from it is presentation.
 *
 * ## Why it is shared rather than written on each page
 *
 * Because it is drawn on two. `/prime-migrations` lists the withheld set with
 * a re-run chip on every row, and `/prime` draws the same chip beside the one
 * migration an operator opened. Two tables would eventually disagree, and the
 * disagreement would be invisible — both would be plausible and neither would
 * name its source. This repository has already paid for that with a literal at
 * each end of an event name.
 *
 * ## The rule the strings answer to
 *
 * **Database vocabulary never reaches an operator.** `fails_loudly` is not a
 * phrase and `rewrites_data` is not an explanation, and a test refuses any
 * rendered string here that reads like an identifier.
 */
import type { IdempotencyReading } from "@/server/primeMigrationDiagnosis.pure";
import type { SafetyTone } from "@/server/primeHealth.pure";
import type { RemedyOutcome, RepairKind, RefusalKind } from "@/server/primeMigrationRemedy.pure";

/** What a second run of the file would do. */
export const RERUN_WORDS: Record<IdempotencyReading, string> = {
  rerunnable: "changes nothing",
  fails_loudly: "stops on its own",
  rewrites_data: "writes rows again",
  unreadable: "not measured",
};

/**
 * `fails_loudly` is drawn NEUTRAL rather than red.
 *
 * It is the mild outcome: the file stops at the first statement that creates
 * something already there, having written nothing. Colouring it like the one
 * that duplicates rows is what makes eleven chips unreadable — the badge rule
 * the partner roster was rewritten under.
 */
export const RERUN_TONE: Record<IdempotencyReading, SafetyTone> = {
  rerunnable: "ok",
  fails_loudly: "idle",
  rewrites_data: "bad",
  unreadable: "idle",
};

/** What a repair plan came to. */
export const REMEDY_WORDS: Record<RemedyOutcome, string> = {
  healed: "can be made re-runnable",
  improved: "can be improved, not healed",
  nothing_to_do: "needs nothing",
  no_repair: "needs a person",
  unreadable: "not measured",
  unproven: "withdrawn",
};

/**
 * `improved` is amber, not green.
 *
 * A file that keeps an unguarded INSERT after every policy in it is guarded is
 * still a file that duplicates rows on a second run. Drawing it like a healed
 * one is the `needs_a_trial_run` mistake: a promise nobody made.
 */
export const REMEDY_TONE: Record<RemedyOutcome, SafetyTone> = {
  healed: "ok",
  improved: "warn",
  nothing_to_do: "ok",
  no_repair: "idle",
  unreadable: "idle",
  unproven: "bad",
};

/** What each repair changes, as a noun an operator can scan a column of. */
export const REPAIR_WORDS: Record<RepairKind, string> = {
  table: "table",
  index: "index",
  schema: "schema",
  sequence: "sequence",
  extension: "extension",
  materialized_view: "materialized view",
  view: "view",
  function: "function",
  column: "column",
  enum_value: "type value",
  policy: "access policy",
  trigger: "trigger",
  constraint: "constraint",
  bare_drop: "removal",
};

/** Why a statement was left alone, as a short label beside the full reason. */
export const REFUSAL_WORDS: Record<RefusalKind, string> = {
  insert: "rows written",
  type: "type",
  publication: "publication",
  role: "role",
  unrecognised: "not recognised",
  not_located: "not found in the file",
};
