/**
 * The modules picked for a new clone are recorded beside the plan's, never lost to them.
 *
 * `provisionCloneCore` reconciles the plan's entitlements first, which installs
 * every module the PLAN gives, and records the ticked modules after. Those went
 * in as one plain insert, so a ticked module the plan already gave failed the
 * batch on `clone_modules`' unique (clone_id, module_id) and every pick was lost
 * with it, with nothing read back (module library audit, 27 Oct 2026).
 *
 * Asserted on the source, comments stripped, as provisioning's other contracts
 * are: the path has not run in production since 19 Sep 2026.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

const core = stripComments(readFileSync("src/server/clone-provisioning.server.ts", "utf8"));
const picks = core.slice(core.indexOf("if (data.moduleIds.length > 0) {"));

describe("picked modules at provisioning", () => {
  it("are written after the plan's reconcile", () => {
    const reconcile = core.indexOf("reconcileCloneEntitlements({");
    expect(reconcile).toBeGreaterThan(-1);
    expect(core.indexOf("if (data.moduleIds.length > 0) {")).toBeGreaterThan(reconcile);
  });

  it("keep the plan's row where one is already there", () => {
    expect(picks).toMatch(
      /from\("clone_modules"\)\.upsert\([\s\S]*?\{ onConflict: "clone_id,module_id", ignoreDuplicates: true \}/,
    );
    expect(picks.slice(0, 400)).not.toMatch(/from\("clone_modules"\)\.insert\(/);
  });

  it("say so when they could not be recorded", () => {
    expect(picks).toMatch(/const \{ error: pickErr \} = await supabase\.from\("clone_modules"\)/);
    expect(picks).toMatch(/if \(pickErr\) \{[\s\S]*?from\("notifications"\)\.insert/);
  });
});
