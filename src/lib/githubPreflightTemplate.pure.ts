/**
 * Whether the repository a new clone is copied FROM can be copied from.
 *
 * `createUsingTemplate` needs its source flagged as a template repository, and
 * answers an unflagged one with 404 — "Not Found" is how that endpoint reports
 * it. The prime carries the flag. A CRM line's PARENT clone need not:
 * provisioning flags it itself (`ensureTemplateRepository`) immediately before
 * the copy, so for a parent an unflagged repository is a step still to happen
 * rather than a failure — unless the flag provably cannot be set.
 *
 * Provably, because a GitHub App has exactly one installation per account.
 * Provisioning can only reach a parent through the installation on the
 * parent's own account, so where the parent lives in the account the clone is
 * being created in, the installation the preflight read IS that one and its
 * permissions settle the question: marking a repository as a template needs
 * Administration: write. A parent in any other account cannot be judged from
 * here and is left to provisioning, which refuses by name before it creates
 * anything.
 *
 * The prime path is unchanged: it never sets the flag, so an unflagged prime
 * is still a failure the operator has to fix by hand.
 */

export interface TemplateSourceFacts {
  method: "fork" | "template" | "clone" | undefined;
  /** Whether the installation could read the source; null when not checked. */
  accessible: boolean | null;
  /** The source's `is_template`; null when it was not read. */
  isTemplate: boolean | null;
  /** The source is a CRM parent, which provisioning flags itself. */
  flagSetByProvisioning: boolean;
  /** The source lives in the account whose installation the preflight read. */
  inTargetAccount: boolean;
  /** That installation holds Administration: write. */
  administrationPermission: boolean;
}

export interface TemplateSourceVerdict {
  ok: boolean;
  /** Unflagged, and provisioning will flag it before the copy. */
  willBeMarked: boolean;
  /** Unflagged, and the App provably cannot flag it. */
  unmarkable: boolean;
}

export function judgeTemplateSource(facts: TemplateSourceFacts): TemplateSourceVerdict {
  if (facts.method !== "template") return { ok: true, willBeMarked: false, unmarkable: false };

  const unflagged = facts.isTemplate === false;
  const unmarkable =
    unflagged &&
    facts.flagSetByProvisioning &&
    facts.inTargetAccount &&
    !facts.administrationPermission;
  const willBeMarked = unflagged && facts.flagSetByProvisioning && !unmarkable;

  return {
    ok: facts.accessible !== false && (!unflagged || willBeMarked),
    willBeMarked,
    unmarkable,
  };
}

/** GitHub logins compare case-insensitively, and an operator may type the `@`. */
export function sameGithubAccount(a: string | null | undefined, b: string | null | undefined) {
  const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/^@/, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}
