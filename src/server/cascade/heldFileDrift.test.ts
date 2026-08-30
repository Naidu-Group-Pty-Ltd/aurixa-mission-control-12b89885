import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideDriftReport, driftFingerprint, planHeldFileDrift } from "./heldFileDrift.pure";
import { findMissingHeldReferences } from "./heldFileStaleness.pure";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "src/server/cascade/__fixtures__", name), "utf8");

/** The clone's tree, near enough: the module the held file imports from. */
const CLONE_TREE = new Set(["src/App.tsx", "src/pages/aml/AmlShellPages.tsx"]);

describe("planning a sweep against the real files", () => {
  const primeApp = fixture("App.prime.txt");
  const cloneApp = fixture("App.clone-before.txt");

  it("names the one module worth reading, and the one symbol to look for", () => {
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: primeApp,
        cloneSource: cloneApp,
        clonePaths: CLONE_TREE,
      }),
    ).toEqual([
      {
        heldPath: "src/App.tsx",
        target: "src/pages/aml/AmlShellPages.tsx",
        symbols: ["AmlAustracReportDraft"],
      },
    ]);
  });

  it("plans nothing once the clone has been reconciled", () => {
    const repaired = cloneApp.replace(
      "AmlAustracReporting, AmlRecords",
      "AmlAustracReporting, AmlAustracReportDraft, AmlRecords",
    );
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: primeApp,
        cloneSource: repaired,
        clonePaths: CLONE_TREE,
      }),
    ).toEqual([]);
  });

  it("hands the fetch list to the guard, which makes the same finding", () => {
    // The plan decides what to READ. The finding still comes out of the
    // function the cascade uses, over the content actually fetched — so the
    // sweep and the cascade cannot come to two different conclusions.
    const plan = planHeldFileDrift({
      heldPath: "src/App.tsx",
      primeSource: primeApp,
      cloneSource: cloneApp,
      clonePaths: CLONE_TREE,
    });
    const fetched = Object.fromEntries(
      plan.map((p) => [p.target, fixture("AmlShellPages.withDraft.txt")]),
    );
    expect(
      findMissingHeldReferences({
        heldFilesClone: { "src/App.tsx": cloneApp },
        heldFilesPrime: { "src/App.tsx": primeApp },
        cascadedFiles: fetched,
      }),
    ).toEqual([
      {
        heldPath: "src/App.tsx",
        cascadedPath: "src/pages/aml/AmlShellPages.tsx",
        missing: ["AmlAustracReportDraft"],
      },
    ]);
  });
});

describe("what the plan refuses to ask for", () => {
  it("says nothing about a module the clone does not have at all", () => {
    // Ordinary cascade lag: the module is on its way, and the cascade's own
    // guard will speak when it lands. Reporting it here would turn every
    // in-flight cascade into an operator notification.
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: 'import { Brand } from "./pages/New";',
        cloneSource: "",
        clonePaths: new Set(["src/App.tsx"]),
      }),
    ).toEqual([]);
  });

  it("resolves an alias and a relative path to the same module", () => {
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: 'import { A } from "./pages/Shell";',
        cloneSource: 'import { A } from "@/pages/Shell";',
        clonePaths: new Set(["src/pages/Shell.tsx"]),
      }),
    ).toEqual([]);
  });

  it("picks the candidate the clone actually holds", () => {
    // `./pages/Shell` could be five files. The tree says which one, so the
    // fetch is one call rather than a walk down the extension list.
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: 'import { A } from "./pages/Shell";',
        cloneSource: "",
        clonePaths: new Set(["src/pages/Shell/index.ts"]),
      })[0].target,
    ).toBe("src/pages/Shell/index.ts");
  });

  it("ignores a bare package import", () => {
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: 'import { useState } from "react";',
        cloneSource: "",
        clonePaths: new Set(["src/App.tsx"]),
      }),
    ).toEqual([]);
  });

  it("counts an unresolvable clone-side import as satisfied", () => {
    // The safe direction. A false silence costs one run; a false claim sends
    // an operator to fix a file that is already right.
    expect(
      planHeldFileDrift({
        heldPath: "src/App.tsx",
        primeSource: 'import { A } from "@/pages/Shell";',
        cloneSource: 'import { A } from "@/pages/Shell";',
        clonePaths: new Set(["src/pages/Shell.tsx"]),
      }),
    ).toEqual([]);
  });

  it("merges two imports of the same module into one read", () => {
    const plan = planHeldFileDrift({
      heldPath: "src/App.tsx",
      primeSource: 'import { A } from "./m";\nimport type { B } from "./m";',
      cloneSource: "",
      clonePaths: new Set(["src/m.ts"]),
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].symbols).toEqual(["A", "B"]);
  });
});

describe("the fingerprint", () => {
  const ref = (heldPath: string, cascadedPath: string, missing: string[]) => ({
    heldPath,
    cascadedPath,
    missing,
  });

  it("is empty for a clone that owes nothing", () => {
    expect(driftFingerprint([])).toBe("");
  });

  it("does not change when the imports are merely reordered", () => {
    const a = [ref("src/App.tsx", "src/m.ts", ["A", "B"])];
    const b = [ref("src/App.tsx", "src/m.ts", ["B", "A"])];
    expect(driftFingerprint(a)).toBe(driftFingerprint(b));
  });

  it("does not change when the findings arrive in a different order", () => {
    const a = [ref("src/App.tsx", "src/m.ts", ["A"]), ref("src/b.ts", "src/n.ts", ["C"])];
    expect(driftFingerprint(a)).toBe(driftFingerprint([...a].reverse()));
  });

  it("changes when a symbol is added to an existing gap", () => {
    expect(driftFingerprint([ref("src/App.tsx", "src/m.ts", ["A"])])).not.toBe(
      driftFingerprint([ref("src/App.tsx", "src/m.ts", ["A", "B"])]),
    );
  });

  it("changes when the same symbols come from a different module", () => {
    expect(driftFingerprint([ref("src/App.tsx", "src/m.ts", ["A"])])).not.toBe(
      driftFingerprint([ref("src/App.tsx", "src/n.ts", ["A"])]),
    );
  });
});

describe("deciding whether this run is news", () => {
  const gap = [{ heldPath: "src/App.tsx", cascadedPath: "src/m.ts", missing: ["A"] }];

  it("says nothing at all about a clone that was clean and still is", () => {
    // Almost every clone on almost every run. A sweep that files a row each
    // time is a sweep whose rows nobody reads.
    expect(decideDriftReport({ previous: null, findings: [] })).toEqual({
      fingerprint: "",
      record: false,
      notify: false,
    });
  });

  it("records and announces a gap the first time it is seen", () => {
    const d = decideDriftReport({ previous: null, findings: gap });
    expect(d.record).toBe(true);
    expect(d.notify).toBe(true);
  });

  it("stays silent while the same gap goes unfixed", () => {
    const first = decideDriftReport({ previous: null, findings: gap });
    const again = decideDriftReport({ previous: first.fingerprint, findings: gap });
    expect(again).toEqual({ fingerprint: first.fingerprint, record: false, notify: false });
  });

  it("records the clearance without interrupting anyone", () => {
    const before = driftFingerprint(gap);
    expect(decideDriftReport({ previous: before, findings: [] })).toEqual({
      fingerprint: "",
      record: true,
      notify: false,
    });
  });

  it("announces a regression, because the clearance reset what was observed", () => {
    // The comparison is against the last OBSERVED state, never the last
    // ANNOUNCED one. A gap that appeared, was fixed and came back has a
    // recorded clearance in between, so it is a change again.
    const cleared = decideDriftReport({ previous: driftFingerprint(gap), findings: [] });
    const back = decideDriftReport({ previous: cleared.fingerprint, findings: gap });
    expect(back.notify).toBe(true);
  });

  it("announces a gap that grew", () => {
    const grown = [{ heldPath: "src/App.tsx", cascadedPath: "src/m.ts", missing: ["A", "B"] }];
    expect(decideDriftReport({ previous: driftFingerprint(gap), findings: grown }).notify).toBe(
      true,
    );
  });
});
