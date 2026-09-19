/**
 * What a convergence reading is called on screen.
 *
 * ## Why this is in `lib` and not beside the judgement
 *
 * `src/server/**` is denied to the client environment — the build's
 * import-protection plugin refuses it, and rightly: a component that can
 * import a server module can import its dependencies too. The judgement
 * (`convergenceReading.pure.ts`) stays there because only the server makes it.
 * The words stay here because only the client draws them.
 *
 * The seam is worth stating rather than merely obeying. A reading that crosses
 * to the browser crosses as DATA — a state, a count, a timestamp — and the
 * sentence built from it is presentation. Keeping the sentence out of the
 * server module is what stops the server module growing an opinion about
 * layout, and keeping the state vocabulary in one place is what stops the two
 * drifting: a test asserts these tables cover exactly the states the judgement
 * can produce, no more and no fewer.
 *
 * ## The rule the strings themselves answer to
 *
 * **Database vocabulary never reaches an operator.** `falling_behind` is not a
 * phrase, `machinery` is not an explanation, and a test refuses any rendered
 * string that reads like an identifier.
 */
import type { ConvergenceState, LedgerAgreement } from "@/server/cascade/convergenceReading.types";
import type { BlockageOwner } from "@/server/cascade/blockageTaxonomy.types";

export const CONVERGENCE_LABEL: Record<ConvergenceState, string> = {
  converged: "Converged",
  delivering: "Delivering",
  stalled: "Stalled",
  falling_behind: "Falling behind",
  unknown: "Not measured",
};

export const CONVERGENCE_MEANING: Record<ConvergenceState, string> = {
  converged: "The two trees hold the same content everywhere the cascade may write.",
  delivering: "Content is still owed and the set is moving, which is what delivery looks like.",
  stalled: "The same content has been owed for longer than a delivery window.",
  falling_behind:
    "Content has been owed continuously across several delivery windows without once reaching zero.",
  unknown: "The comparison could not be completed, so nothing is claimed either way.",
};

/**
 * What to say when the measurement and the pointer disagree.
 *
 * `agree` and `not_comparable` have no entry because neither is worth a
 * sentence — the first is the ordinary case and the second is the absence of a
 * comparison, and a note under both would be noise on every healthy clone.
 */
export const AGREEMENT_NOTE: Record<
  Exclude<LedgerAgreement, "agree" | "not_comparable">,
  string
> = {
  ledger_optimistic:
    "The pointer reads level while the repositories still differ. The measurement is the one taken from the repositories.",
  ledger_pessimistic:
    "The repositories already hold the same content; the pointer has not caught up yet.",
};

/**
 * Who clears a blockage, in words.
 *
 * What an operator needs from `owner` is whether waiting will fix it and, if
 * not, whose move it is. `machinery` and `prime_author` answer that question
 * only to somebody who has read the taxonomy.
 */
export const BLOCKAGE_OWNER_LABEL: Record<BlockageOwner, string> = {
  machinery: "clears itself",
  operator: "needs an operator",
  prime_author: "needs a change in prime",
  account_owner: "needs the account owner",
};
