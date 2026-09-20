/**
 * Every cron lane that reaches the App installation consults the budget —
 * not only the ones that were taught to in the first place.
 *
 * ## What was wrong
 *
 * `githubBudget.pure.ts` was written on 16 Sep 2026, after a 5,000-call
 * window opening at 09:23 was exhausted by 09:41. Its own header names the
 * cause exactly: "one installation, one hourly budget, many spenders — and no
 * arbiter." It then gave floors to the cascade claim and to the periodic
 * scans.
 *
 * Measured 19 Sep 2026, those were still the only two that asked. FIVE other
 * scheduled lanes reached the same installation and consulted nothing:
 *
 *   backend-provisioning-drain   every minute      1,440 runs a day
 *   deployment-drain             every minute      1,440
 *   support-remediation-drain    every 2 minutes     720
 *   fleet-migration-sync         every 30 minutes     48
 *   handoff-parity-refresh       hourly               24
 *
 * Four of those came from a hand audit. `deployment-drain` did not — it was
 * found by the derivation below, on the second-busiest schedule in the system,
 * after the audit had already been called complete. That is the argument for
 * deriving the list rather than writing one down.
 *
 * So the policy protected the window from the lanes that had already been
 * taught to yield, and from nothing else. That night `fleet-migration-sync`
 * spent it, and because a quota refusal mid-pass was indistinguishable from a
 * migration the clone had rejected, `NPC Client Dashboard`, `NPC Test` and
 * `Preflight Property Group` were all moved to `failed` between 02:14 and
 * 03:34, each named after a migration it had never been sent.
 *
 * ## Why this is a source contract
 *
 * The same reason `everyRouteArms.contract.test.ts` gives: the fault is an
 * ABSENCE. Every one of these lanes keeps working correctly with the check
 * deleted — it simply stops yielding, and nothing anywhere counts that. A
 * test that exercises a lane cannot see a question it never asks.
 *
 * The list is DERIVED rather than written down, so a new lane that reaches
 * GitHub is caught the day it is added rather than the day it exhausts a
 * window.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const ROUTES = "src/routes";

/** Helpers whose presence means a module reaches the App installation. */
const GITHUB_CALLS =
  /getAppOctokit|listTreeEntries|listFilesMatchingGlobs|getFileContent|openPrimeMigrationCorpus/;

/**
 * Lanes that reach GitHub and deliberately never yield, each with the reason
 * recorded where the decision lives.
 *
 * `cascade-merge-drain` is the whole list, and `githubBudget.pure.ts` states
 * why in as many words: "The merge drain is NOT a scan — it is the actor that
 * lands finished work, its spend is a handful of calls, and it never yields."
 * A lane added here without that kind of argument beside it is a lane that
 * forgot, not a lane that decided.
 */
const EXEMPT = new Set([
  // "The merge drain is NOT a scan — it is the actor that lands finished work,
  // its spend is a handful of calls, and it never yields." — githubBudget.pure.
  "hooks.cascade-merge-drain.tsx",
  // The GitHub webhook receiver, and the one lane here that is not scheduled
  // at all. It is the EVENT that starts work rather than a job that goes
  // looking for some, so a floor could only ever drop a push rather than defer
  // it — and the cascade it fires consults the budget on its own drain tick.
  "hooks.github.tsx",
]);

/** Every `@/server/…` or `@/lib/…` module a route imports, resolved to a path. */
function importedModules(source: string): string[] {
  return [...source.matchAll(/"@\/(server|lib)\/([a-zA-Z0-9._/-]+)"/g)]
    .map((m) => `src/${m[1]}/${m[2]}`)
    .flatMap((base) => [`${base}.ts`, `${base}.tsx`])
    .filter((p) => existsSync(p));
}

/**
 * The route, plus the modules it imports directly.
 *
 * ## Detection and judgement must read the same text
 *
 * `reachesGithub` has always followed one import hop — a route that reaches
 * `openPrimeMigrationCorpus` through a server module is a GitHub lane, and it
 * would be absurd for it not to be. The ASSERTIONS did not: they read the route
 * file alone. So a lane was DETECTED through its imports and then JUDGED as
 * though it had none, and the only arrangement satisfying both is one where the
 * spend lives in a module and the guard lives in the route.
 *
 * That asymmetry has no defence, and it has a cost: moving a handler into a
 * shared module — which `/hooks/fleet-migration-sync` and
 * `/hooks/fleet-migration-drain` must do, being one lane on two cadences —
 * reads here as a lane that stopped consulting the budget.
 *
 * So both halves read the closure. This is strictly STRONGER than the old
 * assertion for every lane that kept its guard inline: the route source is part
 * of its own closure, so nothing that passed before can fail now, while a guard
 * that moves out of the route no longer moves out of the gate.
 */
function closureOf(source: string): string {
  return [source, ...importedModules(source).map((m) => readFileSync(m, "utf8"))].join("\n");
}

function reachesGithub(source: string): boolean {
  return GITHUB_CALLS.test(closureOf(source));
}

const hooks = readdirSync(ROUTES)
  .filter((f) => f.startsWith("hooks.") && f.endsWith(".tsx"))
  .map((f) => {
    const source = readFileSync(`${ROUTES}/${f}`, "utf8");
    return { file: f, source, closure: closureOf(source) };
  })
  .filter((h) => reachesGithub(h.source));

describe("every scheduled lane that spends the installation's window asks first", () => {
  it("finds the GitHub-reading lanes at all", () => {
    // If this ever reads zero the detection has broken and every assertion
    // below is vacuously true — which is the failure mode a contract test
    // over an ABSENCE is most exposed to.
    expect(hooks.length).toBeGreaterThan(4);
  });

  for (const { file, closure } of hooks) {
    it(`${file} consults the budget, or is exempt for a stated reason`, () => {
      if (EXEMPT.has(file)) {
        expect(closure).not.toContain("decideSpend");
        return;
      }
      expect(closure).toContain("decideSpend(");
      expect(closure).toContain("readGitHubRemaining()");
    });
  }

  it("the five lanes measured on 19 Sep 2026 are among them and all yield", () => {
    // Named explicitly as well as derived: the derivation is what catches the
    // NEXT lane, and these five are what it was written for.
    for (const file of [
      "hooks.backend-provisioning-drain.tsx",
      "hooks.support-remediation-drain.tsx",
      "hooks.fleet-migration-sync.tsx",
      "hooks.handoff-parity-refresh.tsx",
      // Found by the derivation above rather than by the hand audit that
      // started this, which is the argument for deriving the list: it runs
      // every minute and advances a deployment a state at a time, several of
      // those states being GitHub calls.
      "hooks.deployment-drain.tsx",
    ]) {
      const found = hooks.find((h) => h.file === file);
      expect(found, `${file} no longer detected as a GitHub lane`).toBeTruthy();
      expect(found!.closure).toContain("decideSpend(");
    }
  });

  it("a measurement yields early and an actor yields at the reserve", () => {
    // The distinction the floors exist for. A parity report postponed costs a
    // stale number; an apply postponed costs a clone sitting a migration
    // behind the prime.
    const parity = hooks.find((h) => h.file === "hooks.handoff-parity-refresh.tsx")!;
    expect(parity.closure).toMatch(/decideSpend\(\{\s*role: "scan"/);

    for (const file of [
      "hooks.backend-provisioning-drain.tsx",
      "hooks.fleet-migration-sync.tsx",
      "hooks.support-remediation-drain.tsx",
      "hooks.deployment-drain.tsx",
    ]) {
      const lane = hooks.find((h) => h.file === file)!;
      expect(lane.closure, file).toMatch(/decideSpend\(\{\s*role: "actor"/);
    }
  });
});

describe("the reclaim still runs when the window is spent", () => {
  it("backend provisioning yields the CLAIM, never the stalled-row sweep", () => {
    // `reclaimStalled` is database-only and is what terminates a stalled or
    // exhausted row and tells an operator about a job nothing ever claimed.
    // Yielding it would make a starved window look like a healthy queue —
    // which is the exact reading this whole area exists to stop.
    const src = readFileSync(`${ROUTES}/hooks.backend-provisioning-drain.tsx`, "utf8");
    expect(src.indexOf("await reclaimStalled()")).toBeLessThan(src.indexOf("decideSpend("));
  });
});
