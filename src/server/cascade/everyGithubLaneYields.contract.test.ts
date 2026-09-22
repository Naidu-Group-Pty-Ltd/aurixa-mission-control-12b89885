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
import { stripComments } from "@/server/sourceComments.pure";

const ROUTES = "src/routes";

/** Helpers whose presence means a module reaches the App installation. */
const GITHUB_CALLS =
  /getAppOctokit|listTreeEntries|listFilesMatchingGlobs|getFileContent|openPrimeMigrationCorpus|copyBlobByStream/;

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
/**
 * How many import hops the closure walks.
 *
 * ## Why not one
 *
 * One hop was the whole of this gate until 20 Sep 2026, and two scheduled
 * lanes reached the installation just past it:
 *
 *     hooks.codex-nightly.tsx
 *       → codex-scheduling.server.ts        (no GitHub call here)
 *         → codex-security-client.server.ts (getAppOctokit)
 *
 * `hooks.codex-sweep.tsx` reaches the same module the same way. Neither
 * consulted the budget, and neither is light: the sweep runs `*&#47;10 * * * *`
 * and re-dispatches up to fifty stranded jobs a run, while the nightly fans
 * out one `workflow_dispatch` per enabled clone — "a 40-clone fleet used to
 * serialize 40 round-trips to GitHub", in the scheduling module's own words.
 *
 * ## The reason that is worth more than the two lanes
 *
 * At one hop, a lane here became visible by being FIXED and invisible by
 * being BROKEN.
 *
 * The guard imports `readGitHubRemaining`, and that module calls
 * `getAppOctokit` — so adding the guard puts a `GITHUB_CALLS` token inside
 * the route's own one-hop closure and the lane starts being detected.
 * Measured both ways on 20 Sep 2026: before the guards, one hop found
 * thirteen lanes and neither codex lane among them; after, fifteen. Delete a
 * guard again and the lane drops back out of the set — and a lane that is not
 * detected is not judged, so the gate would have gone green on its removal.
 *
 * Two hops break that circularity: `codex-scheduling.server.ts` reaches
 * `codex-security-client.server.ts`, so the lane is detected on what it
 * SPENDS rather than on what it imports to yield. "Detection must not depend
 * on the guard" is asserted below rather than left as reasoning.
 *
 * ## Why two, and not three
 *
 * Measured against the merged base, by varying only this number — identical
 * with comments stripped, so none of it rests on prose:
 *
 *     depth 1   13 lanes   0 unguarded
 *     depth 2   15 lanes   2 unguarded   ← codex-nightly, codex-sweep
 *     depth 3   15 lanes   2 unguarded
 *     depth 4   15 lanes   2 unguarded
 *
 * It CONVERGES at two, so a deeper walk finds nothing and only widens what
 * each lane is judged on. Both of those two are guarded now, so the
 * population at this depth is empty — and the number is a constant rather
 * than a literal so the next person can re-measure it the same way.
 *
 * Deepening is safe in the same direction the closure itself was: a route's
 * own source and its direct imports are still part of the set, so no lane
 * that passed at one hop can fail at two. What changes is that a lane can no
 * longer hide its spend one module further out.
 */
const IMPORT_DEPTH = 2;

/**
 * Modules whose text is left OUT of every closure.
 *
 * These are the machinery of yielding, not of spending, and including them
 * breaks the gate in both directions at once:
 *
 * **Detection.** `readGitHubRemaining` calls `getAppOctokit`, so a guarded
 * lane carries a `GITHUB_CALLS` token purely because it yields. At one hop
 * that made a lane become visible by being FIXED and invisible by being
 * BROKEN — measured 20 Sep 2026, thirteen lanes before the codex guards went
 * in and fifteen after — and an undetected lane is an unjudged one, so the
 * gate would have gone green on a guard's removal.
 *
 * **Judgement.** `githubBudget.pure.ts` declares `export function
 * decideSpend(`, so once the walk reached it the assertion below was
 * satisfied by the DEFINITION. Every guard could be deleted and this gate
 * stayed green — proved by planting exactly that. It is the same
 * definition-versus-call trap the fleet drain's ordering test paid for.
 *
 * Reading the allowance is also not spending it: `/rate_limit` costs no quota.
 * A lane that only asks how much is left is not a lane this gate is about.
 *
 * ## And a comment is not a call
 *
 * The closure is read through `stripComments` for the same reason, and it
 * took two findings to see. `githubUsageMeter.ts` names `getAppOctokit` in a
 * sentence, so importing the lane-NAMER made a route read as a GitHub lane.
 * And a route header explaining where its own GitHub call lives contains the
 * same token — so the two codex lanes, once documented, detected themselves
 * on their own documentation, and the depth below stopped being observable.
 *
 * Measured with the exclusion applied, both ways:
 *
 *                       depth 1                 depth 2
 *     comments read     15 lanes, codex seen    15 lanes, codex seen
 *     comments stripped 13 lanes, codex UNSEEN  15 lanes, codex seen
 *
 * Only the stripped reading can tell the depths apart, which is what makes
 * the constant above testable rather than merely chosen.
 */
const SPEND_NEUTRAL = /githubAllowance\.server|githubUsageMeter|githubBudget\.pure/;

function closureOf(source: string): string {
  const seen = new Set<string>();
  let frontier = importedModules(source).filter((m) => !SPEND_NEUTRAL.test(m));
  // ONE strip call site, so the assertion below covers the whole walk: a
  // synthetic source proves the root is judged as code, and every hop is
  // judged by the same expression.
  const parts: string[] = [];
  const admit = (text: string) => parts.push(stripComments(text));
  admit(source);
  for (let hop = 0; hop < IMPORT_DEPTH; hop++) {
    const next: string[] = [];
    for (const m of frontier) {
      if (seen.has(m)) continue;
      seen.add(m);
      const text = readFileSync(m, "utf8");
      admit(text);
      next.push(...importedModules(text).filter((x) => !SPEND_NEUTRAL.test(x)));
    }
    frontier = next;
  }
  return parts.join("\n");
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
      /*
        The CALL, and the refusal it feeds.

        `toContain("decideSpend(")` was satisfied by the definition once the
        walk reached `githubBudget.pure.ts` — every guard in the system could
        be deleted with this gate still green. The module is out of the
        closure now, and the shape asserted is the one all eleven guarded
        lanes write:

            const spend = decideSpend({ role: "…", remaining: await readGitHubRemaining() });
            if (!spend.proceed) { … }     // ten lanes
            if (spend.proceed) { … }      // hooks.cascade-drain.tsx

        A decision nothing reads is not a guard, so the VERDICT is asserted
        too — `decideSpend` with its result dropped is exactly the shape a
        mention-only assertion cannot tell from a working one. Asserted as
        `spend.proceed` rather than one of the two branch spellings: the
        property is that the answer is read, and pinning `!` would have been
        pinning a phrasing that ten of eleven lanes happen to share.
      */
      expect(closure).toMatch(/decideSpend\(\{\s*role:/);
      expect(closure).toContain("readGitHubRemaining()");
      expect(closure).toMatch(/spend\.proceed/);
    });
  }

  it("the closure judges code, so a lane cannot detect itself on its own documentation", () => {
    /*
      A header explaining WHERE a route's GitHub call lives contains the same
      token the detector looks for, and both codex routes now carry exactly
      such a header. Read as text, they detect themselves — which is how the
      depth above stopped being observable and a planted `IMPORT_DEPTH = 1`
      went green.

      Asserted on a synthetic source with no imports, so it exercises the one
      strip call site the whole walk goes through rather than a fixture that
      happens to agree today.
    */
    const documented = [
      "// The getAppOctokit this lane spends lives two modules away.",
      "/* openPrimeMigrationCorpus is reached through the scheduler. */",
      "const x = 1;",
    ].join("\n");
    expect(
      GITHUB_CALLS.test(documented),
      "the fixture must look like a lane before stripping",
    ).toBe(true);
    expect(GITHUB_CALLS.test(closureOf(documented))).toBe(false);

    // And real code is still seen.
    expect(GITHUB_CALLS.test(closureOf("const o = getAppOctokit();"))).toBe(true);
  });

  it("a lane is detected on what it SPENDS, never on what it imports to yield", () => {
    /*
      The exclusion above, asserted rather than trusted.

      Every detected lane must still read as one with the budget machinery
      out of its closure — which is what `closureOf` now does, so this checks
      the rule held rather than re-deriving it. At one hop the two codex
      lanes fail it: their only `GITHUB_CALLS` token came from the guard.
    */
    for (const { file, closure } of hooks) {
      // The DEFINITION must be out of scope, or the guard assertion above is
      // satisfied by `githubBudget.pure.ts` declaring the function. Checked
      // on the declaration rather than on the module path, because a path is
      // a string that appears in every importer's text.
      expect(
        closure,
        `${file}'s closure carries decideSpend's own declaration, so a definition can satisfy the guard assertion`,
      ).not.toContain("export function decideSpend(");
      expect(
        closure,
        `${file} is only detected as a GitHub lane because it consults the budget`,
      ).toMatch(GITHUB_CALLS);
    }
  });

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
      // And the two the derivation could not see either, until it walked a
      // second hop (#234). Named here for the same reason the five are: the
      // derivation catches the next lane, and these are what it was widened
      // for.
      "hooks.codex-nightly.tsx",
      "hooks.codex-sweep.tsx",
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
