import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideDeletion,
  deletionSuffixFor,
  describeDeletionPlan,
  moduleSpecifiersOf,
  planDeletions,
  withholdReferencedDeletions,
  orderDeletionCandidates,
  MAX_DELETIONS_PER_CASCADE,
  type DeletionCandidate,
  type DeletionVerdict,
} from "./deletionPropagation.pure";
import { stripNonCode } from "./heldFileStaleness.pure";

/**
 * Verbatim from the defect this was written for. Prime's `9f9abe594` rewrote
 * Compliance Home, added the new test under a new name, and deleted the old
 * one; the cascade carried six of the seven changes and the clone was left
 * running a test prime had deleted against a page prime had rewritten.
 */
const QUEUES_TEST = "src/pages/aml/__tests__/amlComplianceHomeQueues.test.tsx";
const DELETED_IN = "9f9abe594791d593f4226b3d43a0cc0487d2f4c1";
/** The blob prime held at that path immediately before the deletion. */
const PRE_IMAGE = "2994304c44de840fdd09ab1ade144d719001c235";

const candidate = (over: Partial<DeletionCandidate> = {}): DeletionCandidate => ({
  path: QUEUES_TEST,
  cloneSha: PRE_IMAGE,
  evidence: {
    kind: "removed",
    deletedIn: DELETED_IN,
    versions: [PRE_IMAGE],
    versionsExhaustive: true,
  },
  ...over,
});

describe("the bytes decide", () => {
  it("deletes a file prime removed when the clone's copy is the one prime removed", () => {
    const v = decideDeletion(candidate());
    expect(v).toEqual({ act: "delete", path: QUEUES_TEST, deletedIn: DELETED_IN });
  });

  it("keeps a file prime never had — this is the clone's own tree", () => {
    /* Nine of the thirteen clone-only paths on the client-facing mirror are
       its isolation machinery. A rule that pruned "everything prime lacks"
       would delete every one of them on its first run. */
    const v = decideDeletion(
      candidate({
        path: "scripts/clone-backend/01-transfer-schema.py",
        evidence: { kind: "never_primes" },
      }),
    );
    expect(v).toMatchObject({ act: "keep", reason: "clone_owns" });
  });

  it("keeps a file the clone has edited since prime deleted it", () => {
    const v = decideDeletion(candidate({ cloneSha: "0".repeat(40) }));
    expect(v).toMatchObject({ act: "keep", reason: "clone_edited" });
    expect((v as { why: string }).why).toMatch(/edited here/);
  });

  it("deletes a file the clone is merely STALE on, not just the last version", () => {
    /* Verbatim from the first real run. Prime revised
       PassportRecipientsPanel.tsx twice more and then removed it; the clone
       had only ever received the first of those revisions. Comparing against
       the deleted version alone called that "edited here" and would have left
       a permanent leftover on every clone in that position — which is the
       problem this whole area exists to remove. */
    const v = decideDeletion(
      candidate({
        path: "src/components/aml/PassportRecipientsPanel.tsx",
        cloneSha: "a7c1fced779d0000000000000000000000000000",
        evidence: {
          kind: "removed",
          deletedIn: "c7ca6eeedf05000000000000000000000000000",
          versions: [
            "d5f489fa4ebf000000000000000000000000000",
            "ac41c13ab1b4000000000000000000000000000",
            "a7c1fced779d0000000000000000000000000000",
          ],
          versionsExhaustive: true,
        },
      }),
    );
    expect(v.act).toBe("delete");
  });

  it("will not call it edited when the walk did not reach the beginning", () => {
    /* "Edited here" and "staler than we looked" are indistinguishable once the
       version list runs out, and only one of them is safe. */
    const v = decideDeletion(
      candidate({
        cloneSha: "0".repeat(40),
        evidence: {
          kind: "removed",
          deletedIn: DELETED_IN,
          versions: [PRE_IMAGE],
          versionsExhaustive: false,
        },
      }),
    );
    expect(v).toMatchObject({ act: "keep", reason: "unsettled" });
    expect((v as { why: string }).why).toMatch(/did not reach the beginning/);
  });

  it("keeps it when prime's history could not be read", () => {
    const v = decideDeletion(candidate({ evidence: { kind: "unsettled", why: "HTTP 502" } }));
    expect(v).toMatchObject({ act: "keep", reason: "unsettled" });
  });

  it("keeps it when no version of it could be recovered", () => {
    /* Knowing prime removed something is not knowing WHAT it removed, and
       there is nothing to compare the clone's copy against. */
    const v = decideDeletion(
      candidate({
        evidence: {
          kind: "removed",
          deletedIn: DELETED_IN,
          versions: [],
          versionsExhaustive: true,
        },
      }),
    );
    expect(v).toMatchObject({ act: "keep", reason: "unsettled" });
  });

  it("never decides on the shape of the path", () => {
    /* A `.test.ts` is not safer to delete than a `.ts`, and a rule that said
       so would be guessing about consequences it cannot see. Same evidence,
       same answer, whatever the file is called. */
    for (const path of ["src/x.ts", "src/x.test.ts", "docs/x.md", "public/logo.png"]) {
      expect(decideDeletion(candidate({ path })).act).toBe("delete");
    }
  });
});

describe("what still imports it", () => {
  const deletes: DeletionVerdict[] = [
    { act: "delete", path: "src/components/aml/AmlShellPage.tsx", deletedIn: "fe69938" },
  ];

  it("withholds a deletion a HELD file still imports", () => {
    /* `src/App.tsx` is `manual_reconcile` on the client-facing mirror: the
       cascade cannot change it, so deleting a module it imports breaks the
       clone's build and the cascade would have done it to itself. */
    const out = withholdReferencedDeletions(deletes, {
      "src/App.tsx": `import { AmlShellPage } from "./components/aml/AmlShellPage";`,
    });
    expect(out[0]).toMatchObject({ act: "keep", reason: "still_referenced" });
    expect((out[0] as { why: string }).why).toContain("src/App.tsx");
  });

  it("withholds on a default, namespace, side-effect, re-export or dynamic import", () => {
    /* The question here is "does this file need that module to exist", which
       is a blunter question than the one `namedImportsOf` answers. */
    for (const source of [
      `import Shell from "@/components/aml/AmlShellPage";`,
      `import * as Shell from "@/components/aml/AmlShellPage";`,
      `import "@/components/aml/AmlShellPage";`,
      `export * from "@/components/aml/AmlShellPage";`,
      `export { AmlShellPage } from "@/components/aml/AmlShellPage";`,
      `const m = await import("@/components/aml/AmlShellPage");`,
      `const m = require("@/components/aml/AmlShellPage");`,
    ]) {
      expect(withholdReferencedDeletions(deletes, { "src/App.tsx": source })[0]).toMatchObject({
        act: "keep",
        reason: "still_referenced",
      });
    }
  });

  it("is not fooled by a comment or a string that merely names the module", () => {
    /* `AmlShellPages.tsx` explains in a comment why `AmlShellPage` was
       deleted, and `partnerRoster.test.ts` asserts a rendered section does
       NOT contain "PassportRecipientsPanel". Neither is a build dependency,
       and treating them as one holds a deletion for ever. */
    const out = withholdReferencedDeletions(deletes, {
      "src/pages/aml/AmlShellPages.tsx":
        `/* deleted rather than unmounted, along with AmlShellPage itself */\n` +
        `// see ./components/aml/AmlShellPage\n` +
        `expect(section).not.toContain("AmlShellPage");`,
    });
    expect(out[0].act).toBe("delete");
  });

  it("leaves a deletion nothing imports alone", () => {
    const out = withholdReferencedDeletions(deletes, {
      "src/App.tsx": `import { AmlShellPages } from "./pages/aml/AmlShellPages";`,
    });
    expect(out[0].act).toBe("delete");
  });

  it("reads a bare package specifier as nothing — node_modules is not in the cascade", () => {
    expect(moduleSpecifiersOf(`import { render } from "@testing-library/react";`)).toEqual([
      "@testing-library/react",
    ]);
    expect(
      withholdReferencedDeletions(deletes, { "src/a.ts": `import x from "react";` })[0].act,
    ).toBe("delete");
  });
});

describe("which candidates get asked about first", () => {
  const primeDirs = new Set(["src/components/aml", "src/pages/aml/__tests__"]);
  const candidates = [
    { path: "scripts/clone-backend/01-transfer-schema.py" },
    { path: "src/components/aml/AmlShellPage.tsx" },
    { path: "docs/BACKEND_ISOLATION.md" },
    { path: "src/pages/aml/__tests__/amlComplianceHomeQueues.test.tsx" },
  ];

  it("puts candidates in directories prime has ahead of the clone's own trees", () => {
    /* A clone-only file in a directory prime does not have at all is almost
       certainly the clone's own; one sitting in a directory prime DOES have is
       where a deletion hides. Spending the probe budget that way means a large
       clone-owned tree never crowds a real removal out past the cap. */
    expect(orderDeletionCandidates(candidates, primeDirs).map((c) => c.path)).toEqual([
      "src/components/aml/AmlShellPage.tsx",
      "src/pages/aml/__tests__/amlComplianceHomeQueues.test.tsx",
      "docs/BACKEND_ISOLATION.md",
      "scripts/clone-backend/01-transfer-schema.py",
    ]);
  });

  it("is an order and never a verdict — the same set, whatever prime's tree looks like", () => {
    const withDirs = orderDeletionCandidates(candidates, primeDirs)
      .map((c) => c.path)
      .sort();
    const withNone = orderDeletionCandidates(candidates, new Set<string>())
      .map((c) => c.path)
      .sort();
    expect(withDirs).toEqual(withNone);
  });

  it("asks the same questions twice — ties break on the path", () => {
    expect(orderDeletionCandidates(candidates, primeDirs)).toEqual(
      orderDeletionCandidates([...candidates].reverse(), primeDirs),
    );
  });
});

describe("the bulk refusal", () => {
  const many = (n: number): DeletionVerdict[] =>
    Array.from({ length: n }, (_, i) => ({
      act: "delete" as const,
      path: `src/gone/${i}.ts`,
      deletedIn: "abc1234",
    }));

  it("applies a retirement-sized set", () => {
    /* The partner-agreement removal took out three Edge Functions and eleven
       shared modules in one change. A real retirement has to get through. */
    expect(planDeletions(many(14)).deletes).toHaveLength(14);
  });

  it("refuses a set above the cap WHOLE, never the first N of it", () => {
    /* Trimming would apply an arbitrary subset of a set we have just decided
       we do not trust, and a different subset on the next run. */
    const plan = planDeletions(many(MAX_DELETIONS_PER_CASCADE + 1));
    expect(plan.deletes).toEqual([]);
    expect(plan.refusal).toMatch(/refused/i);
    expect(deletionSuffixFor(plan)).toMatch(/REFUSED/);
  });
});

describe("what an operator is told", () => {
  it("says nothing at all when nothing was removed", () => {
    expect(deletionSuffixFor(planDeletions([]))).toBe("");
    expect(describeDeletionPlan(planDeletions([]))).toBe("");
  });

  it("keeps the clone's own files out of the report", () => {
    /* Nine clone-only paths, listed on every run, is how an operator learns
       not to read this section. */
    const plan = planDeletions([
      { act: "keep", path: "src/client-facing.d.ts", reason: "clone_owns", why: "clone's own" },
      { act: "keep", path: "src/a.ts", reason: "clone_edited", why: "edited here" },
    ]);
    const body = describeDeletionPlan(plan);
    expect(body).not.toContain("client-facing.d.ts");
    expect(body).toContain("src/a.ts");
  });

  it("names each removal in the body", () => {
    const body = describeDeletionPlan(
      planDeletions([{ act: "delete", path: QUEUES_TEST, deletedIn: DELETED_IN }]),
    );
    expect(body).toContain(QUEUES_TEST);
    expect(body).toMatch(/byte-identical/);
  });
});

describe("the rules the engine has to keep", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
  const code = stripNonCode(engine);

  it("applies the exclusion policy to deletion candidates before probing them", () => {
    /* A `protected` path is protected whatever prime's history says. Probing
       first would be harmless; deleting first would not, and the ordering is
       the thing worth pinning. */
    const partitionAt = code.indexOf("const deletionPartition = partitionCascadePaths(");
    const probeAt = code.indexOf("probeDeletions({");
    expect(partitionAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(partitionAt);
  });

  it("checks references before it plans, and plans before it writes the tree", () => {
    const withholdAt = code.indexOf("withholdReferencedDeletions(");
    const planAt = code.indexOf("planDeletions(deletionVerdicts)");
    const treeAt = code.indexOf("octokit.git.createTree(");
    expect(withholdAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(withholdAt);
    expect(treeAt).toBeGreaterThan(planAt);
  });

  it("does not report a run whose only work is a removal as already in sync", () => {
    /* `treeEntries.length === 0` was the whole test, and a cascade that only
       needed to delete something took the "Already in sync" exit. */
    expect(code).toContain("treeEntries.length === 0 && pendingDeletes.length === 0");
  });

  it("no longer promises the reader that a cascade never removes files", () => {
    expect(engine).not.toContain("a cascade never removes files");
  });

  it("finds deletions in a module-scoped clone too, bounded by its globs", () => {
    /* A module-scoped clone's section of prime is the globs of what it
       installed. Before this it only ever learned what prime HAS, so a file
       prime removed from an installed module stayed for ever. */
    expect(code).toContain("listTreeEntries(octokit, cloneRef)");
    expect(code).toContain("matchers.some((rx) => rx.test(path))");
  });

  it("re-validates the globs before letting one decide a deletion", () => {
    /* A deletion decided by an unvalidated pattern could reach outside the
       module in the one direction that destroys something. */
    const validateAt = code.indexOf("validateModuleGlobs(installedGlobs)");
    const pushAt = code.indexOf("deletionCandidates.push({ path, cloneSha: sha })", validateAt);
    expect(validateAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(validateAt);
  });

  it("refuses the deletion pass on a truncated clone tree", () => {
    /* A truncated read looks exactly like a clone holding fewer files than it
       does, which here means silently missing every deletion past the cut. */
    expect(code).toContain("if (!cloneTree.truncated)");
  });

  it("keeps the commit subject the repair path recognises", () => {
    /* `isEngineOnlyBranch` matches this prefix exactly. A subject that grew a
       deletion count would make every proposal unrepairable. */
    expect(code).toContain("`chore(aurixa): cascade ${treeEntries.length} file(s) from prime@");
  });
});
