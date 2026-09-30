/**
 * The provisioning wizard asks which CRM a clone runs, and the answer reaches
 * provisioning.
 *
 * A CRM choice is a choice of PARENT: provisioning copies the new repository
 * from that line's parent clone and records it as the parent's child
 * (`crmLineage.pure.ts`). Everything that makes the choice mean something is
 * on the server, and every way of losing it is an ABSENCE in the page — a
 * payload that no longer carries the field provisions from the prime, a
 * default that chooses for the operator provisions on whichever line was
 * typed first, and a preflight still pointed at the prime checks a repository
 * nothing is copied from. Each of those renders, builds and submits. So the
 * wiring is asserted as source, with comments removed so a sentence about a
 * call cannot stand in for the call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const WIZARD = stripComments(
  readFileSync(join(__dirname, "..", "routes", "clones.new.tsx"), "utf8"),
);
const READ = stripComments(
  readFileSync(join(__dirname, "..", "lib", "crm-lineage.functions.ts"), "utf8"),
);

describe("the choice is the operator's", () => {
  it("starts with nothing chosen", () => {
    expect(WIZARD).toMatch(/useState<CrmMode \| null>\(null\)/);
  });

  it("offers both lines, in the vocabulary the server spells them in", () => {
    expect(WIZARD).toContain("CRM_MODES.map(");
    expect(WIZARD).toContain("CRM_MODE_COPY[mode]");
  });

  it("will not select a line the server would refuse", () => {
    // The tile stays focusable (its refusal is written inside it) and its
    // click does nothing.
    expect(WIZARD).toMatch(/if \(usable\) setCrmMode\(mode\)/);
    expect(WIZARD).toContain("aria-disabled={!usable}");
  });
});

describe("the choice reaches provisioning", () => {
  it("refuses to submit without one, before the preflight spends anything", () => {
    const submit = WIZARD.slice(WIZARD.indexOf("const submit = async"));
    const refusal = submit.indexOf("if (!crmMode)");
    const preflight = submit.indexOf("await runPreflight()");
    expect(refusal).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(refusal);
  });

  it("sends it with the provision", () => {
    const call = WIZARD.slice(WIZARD.indexOf("await provision({"));
    const payloadEnd = call.indexOf("});");
    expect(call.slice(0, payloadEnd)).toMatch(/\bcrmMode,/);
  });

  it("reads the lines through the judge provisioning refuses with", () => {
    expect(READ).toContain('"@/lib/_server-shims/crmLineage.server"');
    expect(READ).toContain("readCrmLineageRoots(context.supabase)");
    expect(READ).toContain("requireAdmin");
  });
});

describe("the preflight checks the repository the clone is copied from", () => {
  it("is pointed at the chosen parent, never at the prime", () => {
    const preflight = WIZARD.slice(WIZARD.indexOf("const runPreflight = async"));
    const body = preflight.slice(0, preflight.indexOf("setPreflight(res)"));
    expect(body).toContain("crmParent?.githubOwner");
    expect(body).toContain("crmParent?.githubRepo");
    expect(body).not.toContain("prime?.github_repo");
    // Provisioning flags a parent as a template itself; the preflight is told
    // so an unflagged parent is not reported as a failure.
    expect(body).toMatch(
      /templateFlagSetByProvisioning:\s*method === "template" && crmParent !== null/,
    );
  });

  it("re-runs when the chosen parent changes", () => {
    const deps = WIZARD.slice(WIZARD.indexOf("runPreflight();\n    }, 400);"));
    const list = deps.slice(0, deps.indexOf("]);"));
    expect(list).toContain("crmParent?.githubOwner");
    expect(list).toContain("crmParent?.githubRepo");
  });
});
