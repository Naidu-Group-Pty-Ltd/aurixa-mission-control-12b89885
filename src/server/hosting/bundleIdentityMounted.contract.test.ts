/**
 * The provisioner asks the artefact, wakes what it queued, applies the plan it
 * was given, and keeps the answer to "can anybody sign in".
 *
 * ## Why these are source contracts and not unit tests
 *
 * Every one of them is an ABSENCE. `verifyCloneBundleIdentity` is a correct
 * function with a passing spec and zero effect until something calls it;
 * `wakeDormantDeployments` leaves a queue exactly as dormant as it found it;
 * `reconcileCloneEntitlements` not being called looks like a clone on a plan
 * whose modules simply were not picked; and a discarded `AdminSeedReport`
 * looks like a clone that provisioned fine. Nothing in the gate can see any of
 * it — an unused export typechecks, lints and builds, which is the lesson the
 * builder portal paid for with three components that had no call sites.
 *
 * ## What each one is holding
 *
 * Measured 19 Sep 2026: three of the four live clones served a bundle pointed
 * at the PRIME's Supabase project while every signal this pipeline held was
 * green, because each was telling the truth about a different thing — the
 * variables WERE set, the sync DID run, the build DID succeed. Nothing fetched
 * the JavaScript and asked which project it names.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");


/** Every module under `src/` that pushes an environment variable to the host. */
function writersOfHostEnv(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
        // Both the transport and the step that drives it: a new module could
        // otherwise escape by reaching for the provider adapter instead.
        if (/\.upsertEnv\s*\(|\.syncEnv\s*\(/.test(src)) out.push(rel);
      }
    }
  };
  walk("src");
  return out;
}

const DRAIN = stripComments(read("src", "routes", "hooks.deployment-drain.tsx"));
const TURNSTILE = stripComments(read("src", "server", "turnstile-identity.server.ts"));
const PROVISION = stripComments(read("src", "server", "clone-provisioning.server.ts"));
const BACKEND_FN = stripComments(read("src", "lib", "backend-provisioning.functions.ts"));

describe("the deployed bundle is read", () => {
  it("at the moment a deployment goes live", () => {
    const onLive = DRAIN.slice(DRAIN.indexOf("async function onLive"));
    const body = onLive.slice(0, onLive.indexOf("async function finalize"));
    // The CALL, not the name. Deleting the call leaves the dynamic import
    // destructuring the identifier, so a `toContain` on the name passes over a
    // step that no longer happens — found by planting exactly that.
    expect(body).toMatch(/await\s+verifyCloneBundleIdentity\s*\(/);
  });

  it("and again on a sweep of its own, so a build that arrived another way is still read", () => {
    expect(DRAIN).toContain("async function sweepBundleIdentity");
    // Called, not merely declared — the whole point of this file.
    expect(DRAIN).toMatch(/await sweepBundleIdentity\(\)/);
  });

  it("on a cadence of its own rather than the build sweep's", () => {
    // They answer different questions: one asks the provider what it thinks
    // the build did, the other asks the artefact what it says. A bundle can
    // need re-reading when no provider state changed at all.
    expect(DRAIN).toContain("BUNDLE_SWEEP_INTERVAL_HOURS");
    expect(DRAIN).toMatch(/bundle_checked_at/);
  });
});

describe("the verdict reaches an operator", () => {
  it("the deployment card renders the reading", () => {
    // A verdict recorded in a column nobody draws is the same as no verdict.
    // This codebase has shipped three components and twenty-eight CSS classes
    // with no call site; the rule it wrote afterwards is that a thing is not
    // shipped until something renders it.
    const CARD = stripComments(read("src", "components", "clone-deployment-card.tsx"));
    expect(CARD).toMatch(/bundleIdentityReading\s*\(/);
    expect(CARD).toContain("bundle_identity");
  });

  /**
   * The reading has to live where a component may import it.
   *
   * `@tanstack/start-plugin-core`'s import-protection plugin denies every path
   * under `src/server` to the client environment, and ONLY the bundler can see
   * that: the first version of this card imported the reading from
   * `@/server/hosting/deployedBundleIdentity.pure`, which typechecked, linted
   * and passed 4,225 tests — and failed the production build with
   * `[import-protection] Import denied in client environment`.
   *
   * `provisioningReadinessMounted.test.ts` already records the rule for a
   * different module: "a component importing the VALUE fails the build; one
   * keeping its own copy drifts." Stated here as well, because the build is
   * a 25-second bundle in CI and this is a grep — and because the copy is the
   * tempting repair.
   */
  it("imports the reading from a module the client bundle may reach", () => {
    const CARD = stripComments(read("src", "components", "clone-deployment-card.tsx"));
    const importLine = CARD.split("\n").find((l) => l.includes("bundleIdentityReading"));
    expect(importLine).toBeDefined();
    expect(importLine).not.toMatch(/from\s+["']@\/server\//);
    expect(CARD).toContain('from "@/lib/bundleIdentityReading.pure"');
  });

  it("keeps one implementation of it, re-exported rather than copied", () => {
    const SERVER = stripComments(read("src", "server", "hosting", "deployedBundleIdentity.pure.ts"));
    // The server module must not carry its own copy: two readings of one
    // verdict is how a card and an audit row come to disagree about what a
    // deployment is doing.
    expect(SERVER).not.toMatch(/export function bundleIdentityReading/);
    expect(SERVER).toMatch(
      /export \{ bundleIdentityReading \} from "@\/lib\/bundleIdentityReading\.pure"/,
    );
  });

  it("and draws it for a deployment that has never been probed", () => {
    const CARD = stripComments(read("src", "components", "clone-deployment-card.tsx"));
    const at = CARD.indexOf("bundleIdentityReading");
    const around = CARD.slice(Math.max(0, at - 900), at + 200);
    // Gated on the deployment existing and not being declined — NOT on the
    // verdict being present, which would hide exactly the state this exists
    // to make visible.
    expect(around).not.toMatch(/deployment\.bundle_identity\s*&&/);
  });
});

describe("a VITE_ value written outside syncing_env invalidates the digest", () => {
  it("publishSiteKey nulls env_digest after it writes", () => {
    const fn = TURNSTILE.slice(TURNSTILE.indexOf("async function publishSiteKey"));
    const body = fn.slice(0, fn.indexOf("\nexport type ProvisionResult"));
    expect(body).toContain("upsertEnv");
    // `env_digest` is a claim about what the NEXT build's environment will
    // hold, and `syncing_env` skips its push when the digest matches. A write
    // from out here makes that claim false, so the claim goes.
    expect(body).toMatch(/env_digest:\s*null/);
  });

  it("and EVERY writer answers the same question, found rather than listed", () => {
    // The rule is about a class, so the scan is over the class. A new module
    // that pushes an environment variable to the host and says nothing about
    // `env_digest` leaves the next build free to skip its own sync and inherit
    // whatever the project happens to hold — which is the failure this whole
    // file exists for, and it would be invisible again.
    //
    // Two exemptions, both named rather than pattern-matched. The drain's
    // `syncing_env` is what SETS the digest, and `vercel-provider` is the
    // transport that step writes through — the digest is computed by its
    // caller, which is the drain. Anything else is out-of-band by definition.
    const SETS_THE_DIGEST = [
      "src/routes/hooks.deployment-drain.tsx",
      "src/server/hosting/vercel-provider.ts",
    ];
    const offenders: string[] = [];
    for (const rel of writersOfHostEnv()) {
      if (SETS_THE_DIGEST.includes(rel)) continue;
      const src = stripComments(read(...rel.split("/")));
      if (!/env_digest/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: a scan that found no writers would pass for the wrong reason.
    expect(writersOfHostEnv().length).toBeGreaterThan(2);
  });
});

describe("a queued deployment starts itself", () => {
  it("the drain wakes what was asked for and could not be attempted", () => {
    expect(DRAIN).toContain("async function wakeDormantDeployments");
    expect(DRAIN).toMatch(/await wakeDormantDeployments\(\)/);
  });

  it("and decides what to wake with the narrow predicate, not the dormancy reading", () => {
    // `isDormant` groups `not_requested` with `pending_platform`. Waking the
    // first deploys something an operator declined.
    expect(DRAIN).toContain("wakesWhenProviderConfigured");
    const wake = DRAIN.slice(DRAIN.indexOf("async function wakeDormantDeployments"));
    const body = wake.slice(0, wake.indexOf("async function reclaimStalled"));
    expect(body).not.toContain("isDormant");
  });
});

describe("the plan the operator picked is applied", () => {
  it("provisioning reconciles entitlements at creation", () => {
    // The 2-minute drain claims `plan_change_events`, which provisioning has
    // never written — so the wizard was the one route that skipped this while
    // the agreement path did it at creation.
    // Anchored on the call and on a word boundary: `toContain` on the bare
    // name is satisfied by `reconcileCloneEntitlementsSomethingElse`, which is
    // what planting a rename proved.
    expect(PROVISION).toMatch(/await\s+reconcileCloneEntitlements\s*\(\s*\{/);
  });

  it("and a failure there is reported rather than thrown", () => {
    const at = PROVISION.indexOf("reconcileCloneEntitlements");
    const around = PROVISION.slice(at, at + 1600);
    expect(around).toMatch(/notifications/);
    // A clone with a repository and a backend is worth keeping even when its
    // entitlement set did not resolve; one that threw after the repo existed
    // has to be unpicked by hand.
    expect(around).not.toMatch(/throw new Error\(\s*`Clone/);
  });
});

describe("whether anybody can sign in is kept", () => {
  it("the finalising update persists the admin seed report", () => {
    expect(BACKEND_FN).toMatch(/admin_seed:\s*asJson\(result\.adminSeed\)/);
  });

  it("and a pass that did not seed leaves the previous reading alone", () => {
    // A repair pass deliberately does not touch a tenant's credential, so
    // `adminSeed` is null there. Writing null would erase a true reading with
    // the absence of a new one.
    expect(BACKEND_FN).toMatch(/result\.adminSeed\s*\?\s*\{\s*admin_seed/);
  });
});

/**
 * `judgeWait` can be exactly right and the wait still fail at six hours,
 * because the parameter that carries the dependency is OPTIONAL — a step that
 * never passes one keeps the elapsed-time reading, silently. That is the same
 * class as `statusSince: row.status_since` in `deploymentState.test.ts`: both
 * arguments type-check whatever you hand them, so the call site is asserted
 * rather than the function.
 *
 * The step that matters is the one whose dependency runs for hours. Asserted
 * on the `syncing_env` backend wait alone, because naming every wait would be
 * a rule about the shape of the file rather than about this defect.
 */
describe("the wait on a clone's backend names what it is waiting on", () => {
  /**
   * The whole `syncing_env` branch that gives up and waits: from the line that
   * decides the dependency to the `};` closing the wait it returns. Sliced as
   * one region because the decision and the use are the pair being asserted —
   * reading only the returned object cannot tell a dependency that was earned
   * from one that was assumed.
   */
  const backendWait = (() => {
    const open = DRAIN.indexOf("const dependency: WaitDependency | null");
    expect(open).toBeGreaterThan(-1);
    const anchor = DRAIN.indexOf("Waiting for the clone's Supabase backend", open);
    expect(anchor).toBeGreaterThan(-1);
    return DRAIN.slice(open, DRAIN.indexOf("};", anchor) + 2);
  })();

  it("passes a dependency, so elapsed time is not the only signal", () => {
    expect(backendWait).toMatch(/dependency,?\s*\n?\s*\}/);
  });

  it("names no dependency at all when there is no backend row", () => {
    // The case this rule is most dangerous in. The New Clone wizard enqueues
    // the backend from the BROWSER, after `provisionClone` has returned, so an
    // interrupted submit leaves a clone that will never have one and nothing
    // that knows one was asked for. Reading that as "progressing" waits for it
    // for ever — strictly worse than the six-hour failure the dependency was
    // added to prevent. A reading has to be earned by observing something.
    expect(backendWait).toMatch(/=\s*backend\s*\n?\s*\?/);
    expect(backendWait).toMatch(/:\s*null;/);
  });

  it("reads the dependency's state from the backend row, never from a constant", () => {
    // A hard-coded "progressing" would make this wait immortal: a failed
    // backend would be waited on for ever.
    expect(backendWait).toMatch(
      /state:\s*backend\.status\s*===\s*"failed"\s*\?\s*"terminal"\s*:\s*"progressing"/,
    );
  });

  it("hands what the step said straight to judgeWait", () => {
    const call = DRAIN.slice(DRAIN.indexOf("judgeWait({"));
    expect(call.slice(0, call.indexOf("})"))).toMatch(/dependency:\s*outcome\.dependency/);
  });

  it("says a blocked deployment is blocked, in different words from a stall", () => {
    // Two failures with one sentence sends an operator to the wrong remedy:
    // "stuck" means look at this deployment, "blocked" means look at the
    // backend.
    expect(DRAIN).toContain('error_message: blocked ? "blocked_dependency" : "stuck"');
    expect(DRAIN).toMatch(/has given up, so this deployment cannot proceed/);
  });
});
