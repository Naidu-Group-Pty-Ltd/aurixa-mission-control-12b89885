/**
 * What protects Prime's default branch, and how Mission Control tells whether
 * the ruleset GitHub holds still says it.
 *
 * ## Why it exists
 *
 * Until 18 Oct 2026 `main` had no protection at all: no branch protection, no
 * ruleset. Any token with `contents: write` could push straight to it — the
 * fix workflow's and the migration workflow's included — and fixes now merge
 * with no person reading them. The ruleset makes GitHub refuse anything that
 * is not a pull request whose two CI jobs passed, whoever asks.
 *
 * ## Who may go past it, and why each one
 *
 * - **Lovable's App.** Most of Prime is written in Lovable, and Lovable pushes
 *   to `main` directly: 66 of the first-parent commits in the 90 days to
 *   18 Oct 2026, none through a pull request. Left off the list, Lovable stops
 *   publishing. Its App id is looked up at run time from the bot account its
 *   commits carry (`LOVABLE_BOT_USER_ID`), never typed in here.
 * - **Repository admins and organisation owners.** People who can edit the
 *   ruleset itself; refusing them protects nothing and stops a person fixing
 *   `main` by hand when it matters most.
 *
 * Mission Control's own App is deliberately NOT on the list. Its fix merges
 * are unattended by policy, and GitHub refusing a merge whose checks did not
 * pass is the one gate on them that Mission Control's own code cannot get
 * wrong. Everything it lands on `main` goes through a pull request already.
 *
 * ## Mission Control adds; it never takes away
 *
 * A person may make the ruleset stricter — require a review, add a check, add
 * someone to the bypass list — and the nightly pass keeps all of it. It only
 * puts back what is missing from the list below. A ruleset a person switched
 * off (enforcement other than `active`) is left switched off and reported:
 * that is a decision, not drift.
 */

export const PRIME_RULESET_NAME = "Mission Control: protect the default branch";

/** GitHub Actions' App id: the required checks are the ones its runs report. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * The jobs in `.github/workflows/ci.yml` every change to `main` must pass, by
 * their `name:`, which is what GitHub calls the check. A contract test holds
 * this list to the workflow, and the server refuses to require a name the
 * workflow no longer has: a required check nothing reports holds every pull
 * request open forever.
 */
export const PRIME_REQUIRED_CHECKS = [
  "Typecheck · Lint · Build",
  "Lovable install (bun.lockb)",
] as const;

/**
 * Lovable's bot account. The same id has committed as both
 * `gpt-engineer-app[bot]` and `lovable-dev[bot]` — an App renamed, one
 * account — which is why the App is found from the id and never from a name.
 * A name an App gave up can be registered by anybody; the account id cannot,
 * and a name-only lookup would put whoever took it on the bypass list.
 */
export const LOVABLE_BOT_USER_ID = 159125892;

/** GitHub's fixed ids in a ruleset's bypass list. */
const ORGANIZATION_ADMIN = 1;
const REPOSITORY_ADMIN_ROLE = 5;

export type BypassActor = {
  actor_id?: number | null;
  actor_type: string;
  bypass_mode?: string;
};

export type RulesetRule = { type: string; parameters?: Record<string, unknown> };

export type Ruleset = {
  id?: number;
  name: string;
  target?: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  rules?: RulesetRule[];
  /** Absent when the caller may not see it: GitHub returns it only to a writer. */
  bypass_actors?: BypassActor[];
};

type StatusCheck = { context: string; integration_id?: number | null };

export function desiredPrimeRuleset(input: {
  lovableAppId: number;
  ownerIsOrganization: boolean;
}): Ruleset {
  return {
    name: PRIME_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          // No person reviews by policy: what is required is the pull request
          // itself, so its checks run, and nothing reaches `main` without them.
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          // Not strict: a branch need not be rebased onto every Lovable push
          // first, or no fix would ever stay mergeable for long.
          strict_required_status_checks_policy: false,
          required_status_checks: PRIME_REQUIRED_CHECKS.map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS_APP_ID,
          })),
        },
      },
    ],
    bypass_actors: [
      ...(input.ownerIsOrganization
        ? [{ actor_id: ORGANIZATION_ADMIN, actor_type: "OrganizationAdmin", bypass_mode: "always" }]
        : []),
      { actor_id: REPOSITORY_ADMIN_ROLE, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: input.lovableAppId, actor_type: "Integration", bypass_mode: "always" },
    ],
  };
}

const sameActor = (a: BypassActor, b: BypassActor) =>
  a.actor_type === b.actor_type &&
  // GitHub answers OrganizationAdmin with an id of 1 or of null; either is the one role.
  (a.actor_type === "OrganizationAdmin" || Number(a.actor_id) === Number(b.actor_id));

const actorWords = (a: BypassActor) =>
  a.actor_type === "OrganizationAdmin"
    ? "organisation owners"
    : a.actor_type === "RepositoryRole" && a.actor_id === REPOSITORY_ADMIN_ROLE
      ? "repository admins"
      : a.actor_type === "Integration"
        ? `the App ${a.actor_id}`
        : `${a.actor_type} ${a.actor_id ?? ""}`.trim();

const checksOf = (rule: RulesetRule | undefined): StatusCheck[] => {
  const list = rule?.parameters?.required_status_checks;
  return Array.isArray(list) ? (list as StatusCheck[]) : [];
};

const coversDefaultBranch = (ruleset: Ruleset, defaultBranch: string) => {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const names = ["~DEFAULT_BRANCH", `refs/heads/${defaultBranch}`];
  return (
    (include.includes("~ALL") || include.some((p) => names.includes(p))) &&
    !exclude.some((p) => names.includes(p))
  );
};

/** What the ruleset GitHub holds lacks, in words a person can act on. Empty when nothing. */
export function rulesetShortfall(
  existing: Ruleset,
  desired: Ruleset,
  defaultBranch: string,
): string[] {
  const out: string[] = [];
  if ((existing.target ?? "branch") !== "branch") {
    out.push(`it targets ${existing.target}, not branches`);
  }
  if (!coversDefaultBranch(existing, defaultBranch)) {
    out.push(`it does not cover ${defaultBranch}`);
  }
  const rules = existing.rules ?? [];
  for (const want of desired.rules ?? []) {
    const have = rules.find((r) => r.type === want.type);
    if (!have) {
      out.push(`it lacks the ${want.type.replace(/_/g, " ")} rule`);
      continue;
    }
    if (want.type !== "required_status_checks") continue;
    const haveChecks = checksOf(have);
    for (const check of checksOf(want)) {
      const match = haveChecks.find((c) => c.context === check.context);
      if (!match) out.push(`it does not require “${check.context}”`);
      else if (Number(match.integration_id) !== check.integration_id) {
        out.push(`it accepts “${check.context}” from an app other than GitHub Actions`);
      }
    }
  }
  const actors = existing.bypass_actors ?? [];
  for (const want of desired.bypass_actors ?? []) {
    const have = actors.find((a) => sameActor(a, want));
    if (!have) out.push(`${actorWords(want)} cannot bypass it`);
    else if (have.bypass_mode !== "always") {
      out.push(`${actorWords(want)} can bypass it only through pull requests`);
    }
  }
  return out;
}

/** `existing` with whatever of `desired` it lacks put back. Nothing a person added is dropped. */
export function mergedRuleset(existing: Ruleset, desired: Ruleset, defaultBranch: string): Ruleset {
  const names = ["~DEFAULT_BRANCH", `refs/heads/${defaultBranch}`];
  const include = existing.conditions?.ref_name?.include ?? [];
  const exclude = existing.conditions?.ref_name?.exclude ?? [];
  const rules: RulesetRule[] = (existing.rules ?? []).map((r) => ({ ...r }));
  for (const want of desired.rules ?? []) {
    const i = rules.findIndex((r) => r.type === want.type);
    if (i < 0) {
      rules.push(want);
      continue;
    }
    if (want.type !== "required_status_checks") continue;
    const kept = checksOf(rules[i]).filter(
      (c) => !checksOf(want).some((w) => w.context === c.context),
    );
    rules[i] = {
      ...rules[i],
      parameters: {
        ...want.parameters,
        ...rules[i].parameters,
        required_status_checks: [...kept, ...checksOf(want)],
      },
    };
  }
  const actors = (existing.bypass_actors ?? []).filter(
    (a) => !(desired.bypass_actors ?? []).some((w) => sameActor(a, w)),
  );
  return {
    name: existing.name,
    target: "branch",
    enforcement: existing.enforcement,
    conditions: {
      ref_name: {
        include:
          include.includes("~ALL") || include.some((p) => names.includes(p))
            ? include
            : [...include, "~DEFAULT_BRANCH"],
        exclude: exclude.filter((p) => !names.includes(p)),
      },
    },
    rules,
    bypass_actors: [...actors, ...(desired.bypass_actors ?? [])],
  };
}

export type ProtectionDecision =
  | { kind: "create"; body: Ruleset }
  | { kind: "update"; id: number; body: Ruleset; shortfall: string[] }
  | { kind: "current"; id: number }
  | { kind: "stand_down"; id: number; why: string }
  | { kind: "unreadable"; id: number; why: string };

export function decideProtection(
  existing: Ruleset | null,
  desired: Ruleset,
  defaultBranch: string,
): ProtectionDecision {
  if (!existing) return { kind: "create", body: desired };
  const id = existing.id ?? 0;
  if (existing.enforcement !== "active") {
    return {
      kind: "stand_down",
      id,
      why:
        `“${existing.name}” is set to ${existing.enforcement}. That is a person's decision, so ` +
        `Mission Control leaves it; set it back to Active to protect ${defaultBranch} again.`,
    };
  }
  // Only a writer is shown who may bypass. Rewriting the list without reading
  // it would drop everyone a person added to it.
  if (!Array.isArray(existing.bypass_actors)) {
    return {
      kind: "unreadable",
      id,
      why: "GitHub did not show who may bypass the ruleset, which it shows only to an App that may edit it",
    };
  }
  const shortfall = rulesetShortfall(existing, desired, defaultBranch);
  if (shortfall.length === 0) return { kind: "current", id };
  return { kind: "update", id, body: mergedRuleset(existing, desired, defaultBranch), shortfall };
}

/**
 * The required checks `ci.yml` no longer names. Read as text, not parsed: the
 * server bundle carries no YAML parser, and a job name is a single `name:`
 * line with the value quoted or not.
 */
export function missingRequiredChecks(
  ciYaml: string,
  required: readonly string[] = PRIME_REQUIRED_CHECKS,
): string[] {
  const names = new Set<string>();
  for (const m of ciYaml.matchAll(/^\s+name:\s*(.+?)\s*$/gm)) {
    names.add(m[1].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return required.filter((r) => !names.has(r));
}

/** The App behind a bot account: `lovable-dev[bot]` is the account of the App `lovable-dev`. */
export function appSlugFromBotLogin(login: unknown): string | null {
  if (typeof login !== "string") return null;
  const m = /^([a-z0-9][a-z0-9-]{0,99})\[bot\]$/i.exec(login);
  return m ? m[1].toLowerCase() : null;
}
