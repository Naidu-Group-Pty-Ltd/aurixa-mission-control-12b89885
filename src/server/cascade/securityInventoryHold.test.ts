import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SECURITY_INVENTORY_PATH, securityInventoryHold } from "./securityInventoryHold.pure";
import { REPOSITORY_INVARIANTS } from "./repositoryInvariants.pure";
import { approvableHeld, reportableHeld } from "./syncExclusions.pure";
import { stripComments } from "../sourceComments.pure";

describe("whether prime's security baseline may be written over a clone's", () => {
  it("lets it travel to a mirror, exactly as it does today", () => {
    // The invariant carries it for a reason that stays: without the baseline
    // beside the functions it describes, a clone that receives a new function
    // goes red on a file the cascade itself wrote.
    expect(securityInventoryHold([])).toBeNull();
  });

  it("withholds it from a clone that owns functions prime has never analysed", () => {
    const held = securityInventoryHold(["crm-send-message", "crm-calendar"]);
    expect(held).not.toBeNull();
    expect(held?.path).toBe(SECURITY_INVENTORY_PATH);
  });

  it("names the functions, and the one command that settles it", () => {
    // A hold an operator cannot act on is the "Needs a human" section saying
    // a human is needed and not what for.
    const held = securityInventoryHold(["crm-send-message", "crm-calendar"]);
    expect(held?.note).toContain("crm-calendar, crm-send-message");
    expect(held?.note).toContain("npm run security:inventory");
  });

  it("counts each function once and reports them in a stable order", () => {
    const a = securityInventoryHold(["b", "a", "b"]);
    const b = securityInventoryHold(["a", "b"]);
    expect(a?.note).toBe(b?.note);
    expect(a?.note).toContain("owns 2 edge function(s)");
  });

  it("is a decision a person can take, so it is reported and approvable", () => {
    // `protected` would be silent — `reportableHeld` filters it out — and a
    // baseline that quietly stopped arriving is the failure mode this hold is
    // meant to make visible.
    const held = securityInventoryHold(["crm-calendar"]);
    expect(held).not.toBeNull();
    expect(reportableHeld([held!])).toHaveLength(1);
    expect(approvableHeld([held!])).toHaveLength(1);
  });

  it("holds the path the invariant list carries, so the two cannot drift", () => {
    expect(REPOSITORY_INVARIANTS.some((i) => i.pattern === SECURITY_INVENTORY_PATH)).toBe(true);
  });
});

describe("how the engine uses it", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("decides it AFTER both reconciles, because they are the evidence", () => {
    // Asked before them, `cloneOwnedFunctions` is empty and the hold never
    // fires — a control that is present, reachable and always answers no.
    const config = engine.indexOf("reconcileConfigToml({");
    const registry = engine.indexOf("reconcileSecurityRegistry({");
    const hold = engine.indexOf("securityInventoryHold(cloneOwnedFunctions)");
    expect(config).toBeGreaterThan(-1);
    expect(registry).toBeGreaterThan(config);
    expect(hold).toBeGreaterThan(registry);
  });

  it("removes prime's copy from the tree rather than only reporting it", () => {
    const at = engine.indexOf("securityInventoryHold(cloneOwnedFunctions)");
    const block = engine.slice(at, at + 600);
    expect(block).toContain("dropFromTree(SECURITY_INVENTORY_PATH)");
    expect(block).toContain("partition.held.push(inventoryHold)");
    expect(block).toContain("needsReconcile.push(inventoryHold)");
  });

  it("names the path in one place", () => {
    expect(SECURITY_INVENTORY_PATH).toBe("docs/security/SECURITY_INVENTORY.json");
    expect(engine).not.toContain('"docs/security/SECURITY_INVENTORY.json"');
  });
});

describe("the generated matrix travels with the registry that generates it", () => {
  it("is a repository invariant", () => {
    // Its inputs are the section registries, which are inside module globs.
    // They cascade and the document does not, so the clone's committed copy
    // describes routing the cascaded code no longer performs and
    // `sectionOwnershipMatrix.spec.ts` fails on the difference.
    const entry = REPOSITORY_INVARIANTS.find(
      (i) => i.pattern === "docs/reports/SECTION_OWNERSHIP_MATRIX.md",
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain("sectionOwnershipMatrix.spec.ts");
  });
});
