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
