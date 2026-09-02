/**
 * Keeping `BACKEND_DEPLOYED_BY` declared on every clone repository.
 *
 * ## Why this is standing state and not an act
 *
 * A clone's own `deploy-supabase-functions.yml` stands down only on a POSITIVE
 * assertion: the repository variable `BACKEND_DEPLOYED_BY` saying, in as many
 * words, that somebody else deploys. Without it the job goes red on every push
 * that touches a function — which is correct on the prime, where nothing else
 * deploys, and is noise on a clone, where Mission Control already did.
 *
 * That variable used to be written on provisioning, on cascade, and by a
 * button an operator had to find. So a clone whose write was refused — the
 * App lacked `variables: write` until somebody granted it — had no way back
 * except waiting for the next cascade or remembering to click. A declaration
 * nothing keeps true is one that drifts, and its drift shows up as a red check
 * that everybody learns to ignore.
 *
 * So it is reconciled on a schedule instead: the desired state is a constant,
 * and a pass writes only where the repository disagrees with it.
 *
 * ## Why there is no "off"
 *
 * The workflow's own gate reads:
 *
 *     if [ -n "${TOKEN:-}" ]; then ready=true; else ready=false; fi
 *     if [ "${DEPLOYER:-}" = "mission-control" ]; then elsewhere=true; ...
 *
 * and the stand-down step requires `ready != 'true' && elsewhere == 'true'`.
 * The variable is therefore consulted ONLY where the repository holds no
 * deploy token of its own. A tenant whose CI has a scoped token deploys
 * exactly as it would have, declared or not — so keeping this on everywhere
 * cannot suppress anybody's own pipeline, and there is no second position for
 * the switch to be in.
 *
 * `deriveDeployRoute` agrees from the other side: a token outranks the
 * variable when it reports which route is actually in force.
 */

import type { CapabilityState, RepoWriteCapabilities } from "./githubAppCapability.pure";

/** The one value the clone workflow accepts, restated where the plan is made. */
export const DECLARED_DEPLOYER = "mission-control";

export type DeclarationPlan =
  /** The repository already says it; nothing to write. */
  | { readonly act: "already"; readonly repo: string }
  /** It does not, and Mission Control may write it. */
  | { readonly act: "declare"; readonly repo: string }
  /**
   * It does not, and writing would fail. Named rather than attempted: a
   * refusal repeated every half hour is noise, and the reason is what an
   * operator needs.
   */
  | { readonly act: "cannot"; readonly repo: string; readonly why: string }
  /**
   * The repository's variables could not be read at all, so whether it is
   * declared is UNKNOWN. Never written on that basis — a blind write is how a
   * broken read turns into a repository nobody meant to touch.
   */
  | { readonly act: "unknown"; readonly repo: string; readonly why: string };

export function planDeployerDeclaration(input: {
  readonly repo: string;
  /**
   * The variable's current value, `null` where it is unset, and `undefined`
   * where the read FAILED. A failed read is not an absent variable.
   */
  readonly variableValue: string | null | undefined;
  readonly capabilities: RepoWriteCapabilities;
}): DeclarationPlan {
  // Read succeeded and the repository already says it: nothing is owed, so no
  // permission question arises.
  if (input.variableValue === DECLARED_DEPLOYER) return { act: "already", repo: input.repo };

  /*
    A permission we KNOW is absent is named before a read that failed, because
    the absent permission is usually WHY it failed.

    Measured on the first live pass, 2 Sep 2026: all three clone repositories
    reported `unknown` — "GitHub did not answer" — and the message that names
    the remedy was unreachable, because `listRepoVariables` answers null for a
    403 exactly as it does for an outage, and the old order asked about the
    reading first. Both outcomes refuse to write, so the order costs nothing
    in safety and decides only which sentence an operator reads: one of them
    can be acted on and the other cannot.

    A permission that could not be READ still answers `unknown`, never
    `missing` — the rule this capability module exists for — so it falls
    through to the attempt below and GitHub's own refusal becomes the
    diagnostic.
  */
  if (input.capabilities.variables.state === "missing") {
    return {
      act: "cannot",
      repo: input.repo,
      why: input.capabilities.variables.detail,
    };
  }

  if (input.variableValue === undefined) {
    return {
      act: "unknown",
      repo: input.repo,
      why: "GitHub did not answer for this repository's Actions variables, so whether it is declared is unknown rather than absent.",
    };
  }

  return { act: "declare", repo: input.repo };
}

export type DeclarationSweep = {
  /**
   * What the App installation's own permission read said about `variables`.
   *
   * On the sweep rather than only in each plan, because the first live pass
   * reported three repositories as `unknown` and there was no way, from the
   * outside, to tell "the App may not read variables" from "GitHub was having
   * a moment". Those need different actions and the audit row is where an
   * operator looks.
   */
  permission: CapabilityState;
  /**
   * Every permission the installation's token actually carries, as
   * `name:level`, sorted — or `null` when the read failed.
   *
   * Names only; a permission map holds no secret. Recorded because the
   * reconcile of 2 Sep 2026 reported `permission: "missing"` three times over
   * after the organisation owner had, by their account, accepted the updated
   * permissions — and a row that says only "missing" cannot tell "the
   * acceptance never reached this installation" from "the App's own permission
   * set was never widened". The list the token carries settles which, from the
   * audit row, without anybody minting a token by hand.
   */
  held: string[] | null;
  considered: number;
  declared: string[];
  already: number;
  cannot: Array<{ repo: string; why: string }>;
  unknown: Array<{ repo: string; why: string }>;
  failed: Array<{ repo: string; error: string }>;
};

/**
 * Whether a pass is worth recording.
 *
 * A settled fleet reaches this every half hour with nothing but `already`, and
 * a job that files an identical row each time is one people stop reading. A
 * write, a refusal, an unreadable repository or a failed write is worth
 * saying; agreement is not.
 */
export function sweepIsNoteworthy(sweep: DeclarationSweep): boolean {
  return (
    sweep.declared.length > 0 ||
    sweep.cannot.length > 0 ||
    sweep.unknown.length > 0 ||
    sweep.failed.length > 0
  );
}
