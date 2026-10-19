// What protects Mission Control's own default branch: the ruleset it asks for,
// what it puts back when the one GitHub holds has drifted, what it keeps that
// a person added, and what it refuses to touch.
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECKS,
  RULESET_NAME,
  appSlugFromBotLogin,
  decideProtection,
  desiredRuleset,
  mergedRuleset,
  missingRequiredChecks,
  rulesetShortfall,
  type Ruleset,
} from "./missionControlBranchProtection.pure";

const LOVABLE = 4242;
const desired = desiredRuleset({ lovableAppId: LOVABLE, ownerIsOrganization: true });
const clone = (r: Ruleset): Ruleset => JSON.parse(JSON.stringify(r));
const held = (change?: (r: Ruleset) => void): Ruleset => {
  const r = { ...clone(desired), id: 7 };
  change?.(r);
  return r;
};

describe("the ruleset Mission Control asks for", () => {
  it("allows pull requests only, with both CI jobs from GitHub Actions required", () => {
    expect(desired).toMatchObject({
      name: RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    });
    expect(desired.rules?.map((r) => r.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
    const pr = desired.rules?.find((r) => r.type === "pull_request");
    // No person reviews by policy; the pull request is what makes CI run.
    expect(pr?.parameters?.required_approving_review_count).toBe(0);
    const checks = desired.rules?.find((r) => r.type === "required_status_checks");
    expect(checks?.parameters?.required_status_checks).toEqual(
      REQUIRED_CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })),
    );
    expect(checks?.parameters?.strict_required_status_checks_policy).toBe(false);
  });

  it("lets Lovable and admins past it, and not Mission Control's own App", () => {
    expect(desired.bypass_actors).toEqual([
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: LOVABLE, actor_type: "Integration", bypass_mode: "always" },
    ]);
    // The only App on the list is Lovable's: Mission Control's unattended
    // merges have to pass the checks like anybody's.
    expect(desired.bypass_actors?.filter((a) => a.actor_type === "Integration")).toHaveLength(1);
  });

  it("leaves organisation owners off for a repository a person owns", () => {
    const personal = desiredRuleset({ lovableAppId: LOVABLE, ownerIsOrganization: false });
    expect(personal.bypass_actors?.map((a) => a.actor_type)).toEqual([
      "RepositoryRole",
      "Integration",
    ]);
  });
});

describe("deciding what to do with the ruleset GitHub holds", () => {
  it("creates it when there is none", () => {
    expect(decideProtection(null, desired, "main")).toEqual({ kind: "create", body: desired });
  });

  it("does nothing when it says everything", () => {
    expect(decideProtection(held(), desired, "main")).toEqual({ kind: "current", id: 7 });
    // GitHub answers OrganizationAdmin with a null id as often as with 1.
    const nullOwner = held(
      (r) => (r.bypass_actors![0] = { ...r.bypass_actors![0], actor_id: null }),
    );
    expect(decideProtection(nullOwner, desired, "main").kind).toBe("current");
  });

  it("leaves a ruleset a person switched off alone, and says how to undo it", () => {
    for (const enforcement of ["disabled", "evaluate"]) {
      const d = decideProtection(
        held((r) => (r.enforcement = enforcement)),
        desired,
        "main",
      );
      expect(d.kind).toBe("stand_down");
      expect(d.kind === "stand_down" && d.why).toMatch(/person's decision.*Active/);
    }
  });

  it("will not rewrite a bypass list it was not shown", () => {
    const d = decideProtection(
      held((r) => delete r.bypass_actors),
      desired,
      "main",
    );
    expect(d.kind).toBe("unreadable");
  });

  it.each([
    ["a rule removed", (r: Ruleset) => r.rules!.splice(2, 1), /lacks the pull request rule/],
    [
      "a required check removed",
      (r: Ruleset) => {
        const p = r.rules![3].parameters!;
        p.required_status_checks = (p.required_status_checks as unknown[]).slice(0, 1);
      },
      /does not require “Lovable install \(bun\.lockb\)”/,
    ],
    [
      "a check accepted from any app",
      (r: Ruleset) => {
        const p = r.rules![3].parameters!;
        p.required_status_checks = REQUIRED_CHECKS.map((context) => ({ context }));
      },
      /from an app other than GitHub Actions/,
    ],
    [
      "Lovable taken off the bypass list",
      (r: Ruleset) => r.bypass_actors!.pop(),
      new RegExp(`the App ${LOVABLE} cannot bypass it`),
    ],
    [
      "Lovable let past only through pull requests",
      (r: Ruleset) => (r.bypass_actors![2].bypass_mode = "pull_request"),
      /only through pull requests/,
    ],
    [
      "main excluded",
      (r: Ruleset) => (r.conditions!.ref_name!.exclude = ["refs/heads/main"]),
      /does not cover main/,
    ],
  ])("puts back %s", (_what, drift, said) => {
    const d = decideProtection(held(drift), desired, "main");
    expect(d.kind).toBe("update");
    if (d.kind !== "update") return;
    expect(d.shortfall.join("; ")).toMatch(said);
    // What it writes back is whole again.
    expect(rulesetShortfall(d.body, desired, "main")).toEqual([]);
  });

  it("keeps everything a person added", () => {
    const stricter = held((r) => {
      r.rules!.push({ type: "required_linear_history" });
      r.rules![2].parameters!.required_approving_review_count = 1;
      const p = r.rules![3].parameters!;
      p.strict_required_status_checks_policy = true;
      p.required_status_checks = [
        ...(p.required_status_checks as unknown[]),
        { context: "e2e", integration_id: 99 },
      ];
      r.bypass_actors!.push({ actor_id: 12, actor_type: "Team", bypass_mode: "pull_request" });
      r.conditions!.ref_name!.include!.push("refs/heads/release/*");
      // ...and one thing of ours removed, so there is something to put back.
      r.rules!.splice(0, 1);
    });
    const d = decideProtection(stricter, desired, "main");
    expect(d.kind).toBe("update");
    if (d.kind !== "update") return;
    const body = d.body;
    expect(body.rules?.map((r) => r.type).sort()).toEqual(
      [
        "deletion",
        "non_fast_forward",
        "pull_request",
        "required_linear_history",
        "required_status_checks",
      ].sort(),
    );
    expect(
      body.rules?.find((r) => r.type === "pull_request")?.parameters
        ?.required_approving_review_count,
    ).toBe(1);
    const checks = body.rules?.find((r) => r.type === "required_status_checks")?.parameters;
    expect(checks?.strict_required_status_checks_policy).toBe(true);
    expect(checks?.required_status_checks).toContainEqual({ context: "e2e", integration_id: 99 });
    expect(body.bypass_actors).toContainEqual({
      actor_id: 12,
      actor_type: "Team",
      bypass_mode: "pull_request",
    });
    expect(body.conditions?.ref_name?.include).toContain("refs/heads/release/*");
    expect(body.enforcement).toBe("active");
  });

  it("names the default branch back in when a person narrowed it away", () => {
    const narrowed = held((r) => (r.conditions = { ref_name: { include: ["refs/heads/dev"] } }));
    const merged = mergedRuleset(narrowed, desired, "main");
    expect(merged.conditions?.ref_name?.include).toEqual(["refs/heads/dev", "~DEFAULT_BRANCH"]);
  });
});

describe("the checks it requires are jobs ci.yml has", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const doc = loadYaml(ci) as {
    on: Record<string, unknown>;
    jobs: Record<string, { name?: string }>;
  };

  it("names exactly the jobs in .github/workflows/ci.yml", () => {
    // A required check nothing reports holds every pull request open. Renaming
    // a job in ci.yml without updating REQUIRED_CHECKS fails here first.
    const names = Object.values(doc.jobs).map((j) => j.name);
    for (const check of REQUIRED_CHECKS) expect(names).toContain(check);
    expect(missingRequiredChecks(ci)).toEqual([]);
  });

  it("runs where the protection needs it to", () => {
    // On every pull request, so a person's or an App's PR can merge; and on
    // dispatch, because a fix PR opened by a workflow token starts no workflow
    // and the merge lane starts this one itself.
    expect(doc.on).toHaveProperty("pull_request");
    expect(doc.on).toHaveProperty("workflow_dispatch");
  });

  it("reads job names quoted or not, and notices one renamed", () => {
    const yaml =
      'jobs:\n  a:\n    name: "Typecheck · Lint · Build"\n  b:\n    name: Lovable install\n';
    expect(missingRequiredChecks(yaml)).toEqual(["Lovable install (bun.lockb)"]);
  });
});

describe("the App behind a bot account", () => {
  it("is the login without [bot], and nothing else", () => {
    expect(appSlugFromBotLogin("lovable-dev[bot]")).toBe("lovable-dev");
    expect(appSlugFromBotLogin("gpt-engineer-app[bot]")).toBe("gpt-engineer-app");
    expect(appSlugFromBotLogin("lavan96")).toBeNull();
    expect(appSlugFromBotLogin("evil/../x[bot]")).toBeNull();
    expect(appSlugFromBotLogin(undefined)).toBeNull();
  });
});
