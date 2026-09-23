/**
 * The bundle-identity verdict as an operator reads it.
 *
 * ## Why this is in `src/lib` and not beside the probe
 *
 * It was in `src/server/hosting/deployedBundleIdentity.pure.ts`, next to the
 * judgement it describes, and the deployment card imported it from there. That
 * builds, typechecks, lints and passes 4,225 tests — and fails the production
 * build, because `@tanstack/start-plugin-core`'s import-protection plugin
 * denies every path under `src/server` to the client environment and only the BUNDLER can see
 * that. `provisioningReadinessMounted.test.ts` already records the rule for a
 * different module: "a component importing the VALUE fails the build; one
 * keeping its own copy drifts."
 *
 * So it moves rather than being copied. `deployedBundleIdentity.pure.ts`
 * re-exports it, which keeps one implementation and leaves every server-side
 * caller's import path untouched — the same shape `env.ts` and
 * `supabaseTarget.pure.ts` take in the property dashboard, for the same reason:
 * a rule that two environments both need lives where the narrower one may
 * reach it.
 *
 * ## What it is for
 *
 * The verdicts are four different facts and only one of them is a problem, so
 * a raw verdict string would put the operator in the position of deciding
 * which — the shape that made `not_required` read as `clear` elsewhere in this
 * codebase.
 *
 * **Never probed is not a pass.** `null` renders as its own line rather than as
 * silence, because a deployment nobody has read and a deployment read and found
 * correct look identical on a card that draws nothing for the first.
 */

export type BundleIdentityCardReading = {
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "destructive" | "success";
};

export function bundleIdentityReading(input: {
  verdict: string | null | undefined;
  detail?: string | null;
  checkedAt?: string | null;
}): BundleIdentityCardReading {
  const detail = (input.detail ?? "").trim();
  switch (input.verdict) {
    case "carries_own":
      return {
        label: "serving its own backend",
        detail: detail || "The deployed bundle names this clone's own Supabase project.",
        tone: "success",
      };
    case "carries_prime":
      return {
        label: "serving the PRIME's backend",
        detail:
          detail ||
          "The deployed bundle names the prime's Supabase project. Sign-ins here authenticate against another tenant's database.",
        tone: "destructive",
      };
    case "carries_both":
      return {
        label: "backend unproven",
        detail:
          detail ||
          "The bundle names this clone's project and the prime's. Which one the browser uses cannot be read off the artefact.",
        tone: "warning",
      };
    case "names_neither":
      return {
        label: "could not tell",
        detail:
          detail ||
          "Neither project appears in the assets the page names. This says what was searched, not what the deployment talks to.",
        tone: "warning",
      };
    case "unreachable":
    case "unreadable":
      return {
        label: "not readable",
        detail: detail || "The deployment could not be read. Nothing is established about it.",
        tone: "neutral",
      };
    default:
      return {
        label: "never read",
        detail:
          "Nothing has fetched this deployment's JavaScript to check which Supabase project it names. " +
          "That is not the same as having checked and found it correct.",
        tone: "neutral",
      };
  }
}

/**
 * What a bundle with no billing identity of its own actually costs.
 *
 * `fallback` means the probe read the chunk that carries the identity and found
 * the prime's built-in `npc-prime` there rather than this clone's own id — and
 * the built-in is compiled into EVERY build, so in practice `fallback` means
 * "this bundle has no identity of its own". What happens next is not one thing,
 * and the copy that said "purchases made from this workspace credit the prime"
 * was right about the three mirrored clones and wrong about the fourth, whose
 * build resolves its own backend:
 *
 * - The identity only reaches the LAST-RESORT links — `AURIXA_PRICING_URL` and
 *   `AURIXA_SAVE_CARD_URL`, used when Mission Control cannot mint an attributed
 *   one. The minted links carry `clones.billing_user_id` server-side and are
 *   right whatever the bundle holds.
 * - Which way the last-resort link fails depends on the BACKEND the build
 *   resolved, because the clone's resolver (`aurixaBillingIdentity.ts`) spends
 *   the built-in only while the build talks to the prime's project. Resolving
 *   the prime's, the link credits the prime. Resolving its own, the pairing
 *   check refuses the built-in and the link opens the pricing page
 *   browse-only — nobody is charged wrongly, and nobody can buy from it.
 *
 * So the consequence is read off the backend verdict beside it, and a verdict
 * that cannot say which project the browser uses says so rather than choosing.
 *
 * Client-safe on purpose: the card renders it and the probe records it, and a
 * sentence written twice is how the card and the event log come to disagree.
 */
export type BillingFallbackConsequence = "credits_prime" | "browse_only" | "unproven";

export function billingFallbackConsequence(
  backendVerdict: string | null | undefined,
): BillingFallbackConsequence {
  switch (backendVerdict) {
    case "carries_prime":
      return "credits_prime";
    case "carries_own":
      return "browse_only";
    default:
      return "unproven";
  }
}

/** The consequence as a clause, for a sentence that has already named the fault. */
export function billingFallbackEffect(consequence: BillingFallbackConsequence): string {
  switch (consequence) {
    case "credits_prime":
      return "the build resolves the prime's backend, so its last-resort purchase link spends the prime's identity and credits the prime";
    case "browse_only":
      return "the build resolves its own backend, so its last-resort purchase link refuses the prime's identity and opens the pricing page browse-only: nobody is charged wrongly, and nobody can buy from it";
    case "unproven":
      return "its last-resort purchase link either credits the prime or opens browse-only, depending on which backend the build resolves, and this reading cannot say which";
  }
}

/** One sentence for an operator: the fault, then what it costs. */
export function billingFallbackSentence(backendVerdict: string | null | undefined): string {
  return (
    "The served bundle carries no billing identity of its own — " +
    `${billingFallbackEffect(billingFallbackConsequence(backendVerdict))}. ` +
    "Links Mission Control mints are unaffected; this is the link a customer gets when it cannot mint one."
  );
}
