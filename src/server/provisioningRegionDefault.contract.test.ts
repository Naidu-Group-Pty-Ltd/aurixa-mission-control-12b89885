/**
 * Where a new clone's database is created when nobody chooses.
 *
 * The wizard and the backend queue both defaulted to `us-east-1` while the
 * signed-agreement path used `ap-southeast-2`, and three of the four live
 * clones' backends run there (measured 27 Oct 2026; the dashboard's is the
 * exception). A default is a choice made for every operator who does not
 * change it, so both are pinned to the one this business serves from.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";

const wizard = stripComments(readFileSync("src/routes/clones.new.tsx", "utf8"));
const queue = stripComments(readFileSync("src/server/backend-provisioning.server.ts", "utf8"));

describe("a new clone's backend region, when nobody chooses one", () => {
  it("is Sydney in the wizard, and Sydney is one of its choices", () => {
    expect(wizard).toContain('useState("ap-southeast-2")');
    expect(wizard).not.toContain('useState("us-east-1")');
    expect(wizard).toContain('<option value="ap-southeast-2">');
  });

  it("is Sydney in the backend queue", () => {
    const enqueue = queue.slice(
      queue.indexOf("export async function enqueueCloneBackendProvisioning"),
    );
    expect(enqueue).toMatch(/region: input\.region \|\| "ap-southeast-2"/);
  });
});
