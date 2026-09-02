/**
 * What the Aurixa GitHub App is actually PERMITTED to do on a clone's
 * repository, and what to tell an operator when it is not.
 *
 * ## Why this exists
 *
 * `declareMissionControlDeploysBackend` writes one repository variable,
 * `BACKEND_DEPLOYED_BY`, and a clone's `deploy-supabase-functions.yml` stands
 * down when it reads `mission-control` there. Measured 2 Sep 2026 on
 * `npc-client-dashboard`: Mission Control called it at 00:30:17, the variable
 * was never set, and **every one of that workflow's 31 runs has failed** — the
 * most recent re-run, forced after the call, failed identically. The gate is
 * present in the workflow and evaluated `elsewhere=false`, so the variable is
 * genuinely absent rather than misread.
 *
 * The write is best-effort by design — a clone that is otherwise healthy must
 * not be reported as failed because a variable could not be written — but its
 * result was DISCARDED at the call site, so the only trace was a line in a
 * log nobody reads. A fleet-wide capability gap looked exactly like nothing
 * happening.
 *
 * ## The rule
 *
 * **A permission we could not read is not a permission we do not hold.** A
 * failed or unavailable read answers `unknown`, never `missing`. Reporting
 * "the App lacks Variables: write" from a lost signal sends an administrator
 * to change a setting that was never wrong — the same mistake this codebase
 * already fixed in `useAmlAccess`, where a failed read was collapsed into the
 * server's own "no" and announced as a permissions decision.
 *
 * Nothing here can grant anything. A GitHub App cannot widen its own
 * permissions through any API — only the App's owner can, in the App's
 * settings, and each installation must then accept the change. So the useful
 * output is a precise instruction, not an attempted repair.
 */

/** How a repository write capability stands for one installation. */
export type CapabilityState = "granted" | "missing" | "unknown";

export type Capability = {
  readonly state: CapabilityState;
  /** The GitHub App permission that governs it, named exactly as GitHub does. */
  readonly permission: string;
  /** One line an operator reads. Never blames a permission we could not read. */
  readonly detail: string;
};

export type RepoWriteCapabilities = {
  /** Writing `BACKEND_DEPLOYED_BY`, which lets a clone's deploy check stand down. */
  readonly variables: Capability;
  /** Writing `SUPABASE_ACCESS_TOKEN`, for a clone whose own CI deploys. */
  readonly secrets: Capability;
};

/**
 * GitHub reports an installation's permissions as a map of name → access
 * level, where the levels are "read", "write" and "admin". Writing an Actions
 * variable needs `variables: write`; writing an Actions secret needs
 * `secrets: write`. They are SEPARATE permissions — an App may hold either
 * without the other, which is why they are assessed separately here rather
 * than collapsed into one "can configure repositories" answer.
 */
const WRITE_LEVELS = new Set(["write", "admin"]);

function assess(
  permissions: Readonly<Record<string, string>> | null | undefined,
  permission: string,
  whatItIsFor: string,
): Capability {
  if (!permissions) {
    return {
      state: "unknown",
      permission,
      detail:
        `Whether this installation may write ${permission} could not be read, so ` +
        "it is unknown rather than absent.",
    };
  }
  const level = permissions[permission];
  if (level && WRITE_LEVELS.has(level)) {
    return {
      state: "granted",
      permission,
      detail: `This installation may write repository ${permission}.`,
    };
  }
  return {
    state: "missing",
    permission,
    detail:
      `This installation cannot write repository ${permission}` +
      (level ? ` (it holds "${level}")` : " (the permission is not granted at all)") +
      `, so ${whatItIsFor} silently does nothing. Grant ` +
      `"${permission}: Read and write" in the GitHub App's settings, then accept ` +
      "the updated permissions on the installation — an App cannot widen its own.",
  };
}

/** Read an installation's permission map into the two capabilities that matter here. */
export function assessRepoWriteCapabilities(
  permissions: Readonly<Record<string, string>> | null | undefined,
): RepoWriteCapabilities {
  return {
    variables: assess(
      permissions,
      "variables",
      "declaring Mission Control as this repository's backend deployer",
    ),
    secrets: assess(permissions, "secrets", "placing a scoped deploy token in this repository"),
  };
}

/**
 * Why a repository has no `BACKEND_DEPLOYED_BY`, said in one line.
 *
 * The variable being absent is a fact; WHY it is absent is the thing an
 * operator needs, and there are three different answers with three different
 * remedies. Returning null means "nothing to add" — the variable is present,
 * or nobody has tried to write it yet, and inventing an explanation for that
 * is worse than staying quiet.
 */
export function explainMissingDeployerVariable(input: {
  readonly variableSet: boolean;
  readonly capabilities: RepoWriteCapabilities;
  /** The error GitHub gave the last write attempt, when one was made. */
  readonly lastWriteError?: string | null;
}): string | null {
  if (input.variableSet) return null;

  if (input.capabilities.variables.state === "missing") {
    return input.capabilities.variables.detail;
  }
  if (input.lastWriteError) {
    return `Mission Control tried to declare itself the deployer and GitHub refused: ${input.lastWriteError}`;
  }
  if (input.capabilities.variables.state === "unknown") {
    return (
      "This repository has no `BACKEND_DEPLOYED_BY`, and whether Mission Control " +
      "may write one could not be read — so which of the two is wrong is unknown."
    );
  }
  return (
    "This repository has no `BACKEND_DEPLOYED_BY`. Mission Control may write one, " +
    "so declaring it here should succeed."
  );
}
