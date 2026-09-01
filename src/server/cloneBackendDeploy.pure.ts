/**
 * Who deploys a clone's Supabase backend, and whether a token offered for the
 * job is safe to put in its repository.
 *
 * There are two lawful routes and this module is the one place that names
 * them. **Mission Control** deploys with the credential it already holds, on
 * the cascade that delivers the code — the default, and the one that puts no
 * key in any clone. **The clone's own CI** deploys with a token in its own
 * repository, which is what a tenant's engineers need when they push directly
 * rather than waiting for a cascade.
 *
 * ## Why a token is judged rather than accepted
 *
 * Supabase's own documentation, on the kind of token this used to mean:
 *
 *   "Classic tokens carry your account's full access. That means every
 *    permission, on every organization and every project you belong to today,
 *    and on every one you create or join in the future. A classic token
 *    created a year ago can touch a project you created today."
 *
 * One of those in a clone repository is fleet-wide database administration,
 * reachable by anyone who can run a workflow there. A SCOPED token
 * (`sbp_fc…`) narrows to chosen projects and permissions, and that is the only
 * kind this platform will place.
 *
 * The prefix is not the check, though — it is the cheap first half of it. A
 * token is scoped to whatever its creator chose, and "scoped" says nothing
 * about scoped TO WHAT. So the real question is asked of the API: what can
 * this token actually see? A token that can enumerate a project other than
 * this clone's is refused however it is spelled.
 *
 * ## The rule that carries the whole thing
 *
 * **Absence of evidence is not evidence of confinement.** A probe that errors,
 * times out, or cannot be run at all leaves the token unproven, and unproven
 * is refused. The cost of refusing a good token is that somebody pastes it
 * again; the cost of accepting an unproven one is every tenant's database.
 */

export type TokenClass = "scoped" | "classic" | "unrecognised";

/**
 * Which kind of Supabase personal access token this is, by its prefix.
 *
 * Documented rather than guessed: scoped tokens "start with `sbp_fc`", and the
 * classic ones this platform refuses start with `sbp_`. Anything else is not a
 * Supabase personal access token at all — a project API key, a database
 * password, or a paste accident — and is refused before it reaches the network.
 */
export function classifyAccessToken(token: string): TokenClass {
  const t = token.trim();
  if (t.startsWith("sbp_fc")) return "scoped";
  if (t.startsWith("sbp_")) return "classic";
  return "unrecognised";
}

export type ScopeEvidence = {
  readonly tokenClass: TokenClass;
  /** This clone's Supabase project. The only one a token may reach. */
  readonly cloneProjectRef: string;
  /**
   * Every project ref the token could enumerate, or `null` where it could not
   * enumerate at all — a token may legitimately be scoped without the
   * permission that lists projects.
   */
  readonly visibleProjectRefs: readonly string[] | null;
  /** Direct read of the clone's project. `null` when the probe did not answer. */
  readonly readsCloneProject: boolean | null;
  /**
   * Direct read of the PRIME's project — the highest-value thing a leaked
   * clone token could reach. `null` when unprobed or unanswered.
   */
  readonly readsPrimeProject: boolean | null;
  /** Absent where the prime records no backend project. */
  readonly primeProjectRef: string | null;
};

export type ScopeVerdict = {
  readonly ok: boolean;
  /** One line an operator reads on the card. */
  readonly reason: string;
  /** Every check that ran, in the order it ran, for the audit row. */
  readonly checks: readonly string[];
};

const refuse = (reason: string, checks: string[]): ScopeVerdict => ({
  ok: false,
  reason,
  checks,
});

/**
 * Decide whether a token may be placed in this clone's repository.
 *
 * Pure over evidence already gathered, so the decision can be tested without a
 * network and the probing code has nothing to decide.
 */
export function judgeTokenScope(evidence: ScopeEvidence): ScopeVerdict {
  const checks: string[] = [];

  if (evidence.tokenClass === "unrecognised") {
    return refuse("This is not a Supabase personal access token — those begin `sbp_`.", [
      ...checks,
      "prefix: unrecognised",
    ]);
  }
  if (evidence.tokenClass === "classic") {
    return refuse(
      "This is a classic token. It carries every permission on every project the " +
        "account can reach, including projects created later, so placing it in a " +
        "clone repository would put the whole fleet behind one repo's access. " +
        "Create a scoped token (`sbp_fc…`) limited to this project.",
      [...checks, "prefix: classic — refused before any network call"],
    );
  }
  checks.push("prefix: scoped (sbp_fc)");

  // Enumeration is the strongest available evidence: it answers "what can this
  // see" directly rather than by asking about the projects we happened to
  // think of.
  if (evidence.visibleProjectRefs !== null) {
    const strangers = evidence.visibleProjectRefs.filter((ref) => ref !== evidence.cloneProjectRef);
    checks.push(`enumerated ${evidence.visibleProjectRefs.length} project(s)`);
    if (strangers.length > 0) {
      return refuse(
        `This token can reach ${strangers.length} project(s) besides this clone's ` +
          `(${strangers.slice(0, 3).join(", ")}${strangers.length > 3 ? ", …" : ""}). ` +
          "Scope it to this project alone.",
        checks,
      );
    }
    if (!evidence.visibleProjectRefs.includes(evidence.cloneProjectRef)) {
      return refuse(
        "This token cannot reach this clone's project, so it could not deploy it.",
        checks,
      );
    }
    checks.push(`confined to ${evidence.cloneProjectRef}`);
    return { ok: true, reason: "Scoped to this clone's project and nothing else.", checks };
  }

  // Enumeration unavailable. Fall back to the pairwise probe — can it read
  // this clone, and can it read the prime — which is weaker (it proves nothing
  // about a THIRD project) and so is only accepted with both answers present.
  checks.push("could not enumerate projects — fell back to direct reads");

  if (evidence.readsCloneProject !== true) {
    return refuse(
      evidence.readsCloneProject === false
        ? "This token cannot reach this clone's project, so it could not deploy it."
        : "The check could not reach the Supabase API, so this token is unproven. " +
            "An unproven token is refused rather than placed.",
      checks,
    );
  }
  checks.push("reads this clone's project");

  if (!evidence.primeProjectRef) {
    return refuse(
      "There is no recorded prime project to check this token against, so its " +
        "confinement cannot be proven. An unproven token is refused rather than placed.",
      [...checks, "no prime project ref on record"],
    );
  }
  if (evidence.readsPrimeProject === null) {
    return refuse(
      "The check against the prime's project did not answer, so this token is " +
        "unproven. An unproven token is refused rather than placed.",
      [...checks, "prime probe did not answer"],
    );
  }
  if (evidence.readsPrimeProject) {
    return refuse(
      "This token can read the prime's project. A token placed in a clone " +
        "repository must reach that clone and nothing else.",
      [...checks, "reads the prime's project — refused"],
    );
  }

  checks.push("cannot read the prime's project");
  return {
    ok: true,
    reason:
      "Reaches this clone's project and not the prime's. Note that projects " +
      "could not be enumerated, so this proves confinement against the prime " +
      "rather than against every project.",
    checks,
  };
}

export type DeployRouteKind =
  | "mission_control"
  | "clone_ci"
  | "clone_ci_incomplete"
  | "nobody"
  | "unknown";

export type DeployRoute = {
  readonly kind: DeployRouteKind;
  readonly label: string;
  readonly detail: string;
};

/**
 * Which route is in force, derived from the repository's own configuration.
 *
 * Derived and never stored, for the reason this codebase has already recorded
 * about gates that depend on a worker: a stored answer is one nothing has to
 * keep true. GitHub reports which secrets and variables a repository holds
 * (names only, never values), so the route can simply be read off the thing
 * that decides it — the workflow reads the same two names.
 */
export function deriveDeployRoute(inputs: {
  /** `null` when the repository's configuration could not be read. */
  readonly hasAccessTokenSecret: boolean | null;
  readonly deployerVariable: string | null;
  readonly projectRefVariable: string | null;
  readonly hasBackendProject: boolean;
}): DeployRoute {
  // A read that FAILED is not a repository that is EMPTY. Reporting "nobody
  // deploys this" from a lost signal is the kind of false alarm that gets a
  // card ignored, and the opposite mistake is worse still.
  if (inputs.hasAccessTokenSecret === null) {
    return {
      kind: "unknown",
      label: "Could not be read",
      detail:
        "GitHub did not answer for this repository's Actions configuration, so " +
        "which route is in force is unknown rather than absent.",
    };
  }

  if (inputs.hasAccessTokenSecret) {
    if (!inputs.projectRefVariable) {
      return {
        kind: "clone_ci_incomplete",
        label: "This repository's CI — but incomplete",
        detail:
          "A deploy token is set, but `SUPABASE_PROJECT_REF` is not. The workflow " +
          "fails closed on that, deliberately: a default there once deployed a " +
          "mirror's functions into the prime's production on every push.",
      };
    }
    return {
      kind: "clone_ci",
      label: "This repository's CI",
      detail:
        `Its workflow deploys to ${inputs.projectRefVariable} with the scoped token ` +
        "in its own Actions secrets. Mission Control still queues a catch-up on " +
        "cascade, and the two are idempotent.",
    };
  }

  if (inputs.deployerVariable === "mission-control") {
    return {
      kind: "mission_control",
      label: "Mission Control",
      detail: inputs.hasBackendProject
        ? "Deployed with Mission Control's own credential on the cascade that " +
          "delivers the code. No Supabase token exists in this repository."
        : "Declared, but this clone has no provisioned Supabase project yet, so " +
          "there is nothing to deploy into.",
    };
  }

  return {
    kind: "nobody",
    label: "Nothing",
    detail:
      "No deploy token in this repository and nothing declaring another deployer, " +
      "so its deploy check fails on every push that touches a function — which is " +
      "the state telling you the functions did not ship.",
  };
}
