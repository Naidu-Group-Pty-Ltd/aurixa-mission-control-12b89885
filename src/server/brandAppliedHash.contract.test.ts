/**
 * A brand applied a moment ago is not drifted.
 *
 * Drift is "the profile changed since it was applied": the drift scan, the
 * drift check and the branding page all compare an assignment's
 * `applied_config_hash` with its profile's `config_hash`. The apply recorded the
 * hash of the CLONE's bundle instead — the profile's asset URLs rewritten to
 * the clone's mirrored copies, and its overrides layered on — which never
 * equals the profile's once the profile carries an asset. Measured on
 * `tutorial-demo-orrimere-c158c7`, 30 Oct 2026: applied at 02:30:11, marked
 * drifted by the scan at 02:30:19, with six marks mirrored.
 *
 * A source contract, as the apply is I/O from end to end; what is pinned is
 * which hash goes where.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

const apply = stripComments(readFileSync("src/server/branding.server.ts", "utf8"));
const drift = stripComments(readFileSync("src/server/branding/drift.ts", "utf8"));

describe("what an apply records as applied", () => {
  it("reads the profile's own hash with the profile", () => {
    expect(apply).toMatch(
      /\.from\("clone_brand_profiles"\)\s*\.select\("[^"]*\bconfig_hash\b[^"]*"\)/,
    );
  });

  it("records the profile's hash on the assignment, the one the drift readers compare", () => {
    expect(apply).toMatch(/applied_config_hash: profile\.config_hash \?\? finalHash/);
    expect(apply).not.toMatch(/applied_config_hash: finalHash\b/);
    // And the drift scan still compares it with the profile's hash.
    expect(drift).toMatch(/profileHash !== r\.applied_config_hash/);
  });

  it("keeps the clone's own hash where it describes the clone", () => {
    expect(apply).toMatch(/config_hash: finalHash,/);
    expect(apply).toMatch(/buildApplySql\(\{[\s\S]{0,200}config_hash: finalHash/);
  });
});
