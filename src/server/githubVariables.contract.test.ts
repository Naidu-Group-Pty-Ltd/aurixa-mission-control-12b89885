import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKEND_DEPLOYER_MISSION_CONTROL,
  BACKEND_DEPLOYER_VARIABLE,
  validateVariableName,
} from "@/server/github-variables.server";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("a variable is not a secret, and this file writes only variables", () => {
  it("never seals, encrypts or names a token", () => {
    /*
      The whole point of the design this belongs to is that no credential
      travels outward. `BACKEND_DEPLOYED_BY` is a name — "who deploys this
      project" — and the moment this module learns to write a key it stops
      being the safe half of that decision.
    */
    const bare = stripComments(read("src/server/github-variables.server.ts"));
    expect(bare).not.toMatch(/sealedBox|encrypted_value|public-key/);
    expect(bare).not.toMatch(/SUPABASE_ACCESS_TOKEN|API_KEY|SECRET/);
    expect(bare).not.toMatch(/actions\/secrets/);
  });

  it("refuses the names GitHub refuses, rather than discovering them at 422", () => {
    expect(validateVariableName("BACKEND_DEPLOYED_BY")).toBeNull();
    expect(validateVariableName("_private")).toBeNull();
    expect(validateVariableName("")).toBeTruthy();
    expect(validateVariableName("9LIVES")).toBeTruthy();
    expect(validateVariableName("HAS-DASH")).toBeTruthy();
    expect(validateVariableName("GITHUB_TOKEN")).toBeTruthy();
    expect(validateVariableName("github_anything")).toBeTruthy();
  });

  it("creates first and updates on 409, so two passes agree", () => {
    // GitHub offers no upsert. A read-then-write would let one of two
    // concurrent provisioning passes decide on a stale answer.
    const bare = stripComments(read("src/server/github-variables.server.ts"));
    expect(bare).toContain("POST /repos/{owner}/{repo}/actions/variables");
    expect(bare).toContain("PATCH /repos/{owner}/{repo}/actions/variables/{name}");
    expect(bare).toContain("if (status !== 409) throw e;");
  });
});

describe("the value both ends must agree on", () => {
  it("is the literal the clone workflows accept", () => {
    /*
      This constant and the workflow's `if [ "${DEPLOYER:-}" = "mission-control" ]`
      are a literal at each end, in two different repositories, and neither can
      read the other. Pinning it here and pinning it there is the most that can
      be done — a change on either side then fails its own test rather than
      silently making a clone's deploy check go red again with no explanation.

      The mirrored dashboards carry the same assertion against their own
      workflow file (`backendDeployerVariable.spec.ts`).
    */
    expect(BACKEND_DEPLOYER_VARIABLE).toBe("BACKEND_DEPLOYED_BY");
    expect(BACKEND_DEPLOYER_MISSION_CONTROL).toBe("mission-control");
  });
});

describe("provisioning declares it for every clone", () => {
  const provisioning = stripComments(read("src/server/clone-provisioning.server.ts"));

  it("asks on both provisioning methods, not just the one that gets secrets", () => {
    // The Codex secret sync is gated on `method !== "clone"`. A forked clone
    // and a created one are both deployed by Mission Control, so gating this
    // the same way would leave half the fleet failing a check on every push.
    const at = provisioning.indexOf("declareMissionControlDeploysBackend");
    expect(at).toBeGreaterThan(-1);
    const guard = provisioning.slice(provisioning.lastIndexOf("if (", at), at);
    expect(guard).not.toContain('data.method !== "clone"');
  });

  it("cannot fail provisioning", () => {
    // The consequence of not writing it is a red deploy check on that
    // repository — loud and recoverable. Failing the whole provision instead
    // would trade a visible warning for an unusable clone.
    expect(provisioning).toContain("if (!declared.ok) {");
    expect(provisioning).not.toMatch(/throw new Error\([^)]*declareMissionControl/);
  });
});
