/**
 * Every decision the lateral lane takes, asserted without a token.
 *
 * The shapes are the ones measured on 23 Sep 2026 between the two parents —
 * the reminders fix and its specs on the GoHighLevel mirror, the routing
 * layer and the native-CRM migration on the CRM-independent deployment — cut
 * down to what each rule reads.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRM_DEPENDENT_PARENT as DEP,
  CRM_INDEPENDENT_PARENT as IND,
  lateralMembrane,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import { stripComments } from "../sourceComments.pure";
import { CASCADE_BRANCH_PREFIX } from "../cascadeMergeDrain.server";
import {
  DECISION_TTL_MS,
  DECLINED_DELETION,
  EMPTY_LATERAL_LEDGER,
  EMPTY_LATERAL_MEMO,
  LATERAL_BRANCH_PREFIX,
  LATERAL_CADENCE_MINUTES,
  LATERAL_RECHECK_MS,
  ORIGIN_NEVER_TTL_MS,
  SURVIVOR_READ_CEILING,
  absentSubjects,
  decideLateral,
  decideLateralRun,
  decisionKey,
  describeLateralProposal,
  differingImportTargets,
  historyProbesFor,
  inLateralScope,
  isLateralSlot,
  judgeLateralWrites,
  lateralBranchName,
  lateralCandidates,
  lateralFingerprint,
  lateralOrigin,
  lateralSurvivorCandidates,
  nextLateralMemo,
  planLateralDeletions,
  readLateralLedger,
  readLateralMemo,
  recalledDecision,
  survivorsNeeded,
  withoutDeclined,
  SUPERSEDED_MARKER,
  LATERAL_COMMIT_PREFIX,
  isLaneOnlyProposal,
  composeLateralLedgerRow,
  compactLateralReport,
  effectiveLateralMode,
  lateralDestinations,
  proposalCarries,
  readLateralReport,
  readProposalState,
  type LateralBoundaryReport,
  type LateralDestination,
  type LateralMemo,
  type LateralSide,
} from "./lateralExchange.pure";
import { CASCADE_MAX_FILE_BYTES, type HeldPath } from "./syncExclusions.pure";

const INTO_IND = lateralMembrane(DEP, IND)!;
const INTO_DEP = lateralMembrane(IND, DEP)!;

const tree = (entries: Record<string, string>) => new Map(Object.entries(entries));
const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ─────────────────────────────────────────────────────────────────────────────

describe("the branch is not the vertical cascade's", () => {
  it("never starts with the prefix the engine, the drain and the resolver key on", () => {
    // Every one of them would treat a lateral proposal as a prime cascade:
    // force-push it with the prime's tree, merge it as the prime's delivery,
    // restate it over the head as the prime's paths.
    expect(LATERAL_BRANCH_PREFIX.startsWith(CASCADE_BRANCH_PREFIX)).toBe(false);
    expect(lateralBranchName(DEP).startsWith(CASCADE_BRANCH_PREFIX)).toBe(false);
    const resolver = stripComments(
      readFileSync("src/server/cascadeConflictMerge.server.ts", "utf8"),
    );
    const prefix = /ENGINE_BRANCH_PREFIX = "([^"]+)"/.exec(resolver)?.[1];
    expect(prefix).toBeTruthy();
    expect(lateralBranchName(IND).startsWith(prefix!)).toBe(false);
  });

  it("names one branch per origin, so each direction has its own proposal", () => {
    expect(lateralBranchName(DEP)).not.toBe(lateralBranchName(IND));
  });
});

describe("candidates: what the two parents disagree on that the prime does not hold", () => {
  const prime = tree({ "src/App.tsx": "p1", "src/shared.ts": "s1" });

  it("takes a path on one side only, or on both in different versions", () => {
    const a = tree({
      "src/App.tsx": "a-app",
      "src/lib/reminders/priority.pure.ts": "r1",
      "docs/same.md": "same",
      "docs/differs.md": "d-a",
    });
    const b = tree({
      "src/App.tsx": "b-app",
      "src/lib/crm/crmProvider.ts": "c1",
      "docs/same.md": "same",
      "docs/differs.md": "d-b",
    });
    expect(lateralCandidates({ a, b, prime })).toEqual([
      "docs/differs.md",
      "src/lib/crm/crmProvider.ts",
      "src/lib/reminders/priority.pure.ts",
    ]);
  });

  it("drops a path the prime holds now without asking its history", () => {
    // `src/App.tsx` differs between the parents, and the vertical cascade
    // already decides it on both sides. Two lanes writing one path is how a
    // cascade comes to argue with itself.
    const a = tree({ "src/App.tsx": "a" });
    const b = tree({ "src/App.tsx": "b" });
    expect(lateralCandidates({ a, b, prime })).toEqual([]);
  });

  it("drops a path no repository could hold", () => {
    const a = tree({ "src/../../etc/passwd.ts": "x", "src/ok.ts": "y" });
    expect(lateralCandidates({ a, b: tree({}), prime })).toEqual(["src/ok.ts"]);
  });
});

describe("origin: only parent-level work crosses", () => {
  const memo = {
    held: ["scripts/template-library/investmentCompass/_covermeasure.tmp.mts"],
    never: {
      "src/lib/reminders/priority.pure.ts": iso(NOW - 60_000),
      "docs/old.md": iso(NOW - ORIGIN_NEVER_TTL_MS - 1),
    },
  };

  it("remembers a path the prime once held, for ever", () => {
    // A history is append-only. A former prime file is the vertical lane's.
    expect(
      lateralOrigin("scripts/template-library/investmentCompass/_covermeasure.tmp.mts", memo, NOW),
    ).toBe("held");
  });

  it("trusts a fresh 'never held' and re-asks a stale one", () => {
    expect(lateralOrigin("src/lib/reminders/priority.pure.ts", memo, NOW)).toBe("never");
    expect(lateralOrigin("docs/old.md", memo, NOW)).toBeNull();
    expect(lateralOrigin("docs/unknown.md", memo, NOW)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("direction: which way a path moves, read from both histories", () => {
  const side = (
    repo: string,
    sha: string | null,
    history?: LateralSide["history"],
  ): LateralSide => ({
    repo,
    sha,
    history,
  });
  const walked = (versions: string[], versionsExhaustive = true) =>
    ({ kind: "prime_versions", versions, versionsExhaustive }) as const;
  const never = { kind: "never_primes" } as const;
  const path = "src/lib/reminders/priority.pure.ts";

  it("asks only the histories a decision needs, stopping where the answer is", () => {
    expect(historyProbesFor(side(DEP, "a1"), side(IND, null))).toEqual([
      { repo: IND, stopAt: "a1" },
    ]);
    expect(historyProbesFor(side(DEP, null), side(IND, "b1"))).toEqual([
      { repo: DEP, stopAt: "b1" },
    ]);
    expect(historyProbesFor(side(DEP, "a1"), side(IND, "b1"))).toEqual([
      { repo: DEP, stopAt: "b1" },
      { repo: IND, stopAt: "a1" },
    ]);
    expect(historyProbesFor(side(DEP, "a1"), side(IND, "a1"))).toEqual([]);
  });

  describe("one side holds it", () => {
    it("writes it across where the other side never held it — the reminders fix", () => {
      expect(decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null, never) })).toEqual({
        act: "write",
        path,
        from: DEP,
        to: IND,
      });
    });

    it("works the same way round from the other side", () => {
      expect(decideLateral({ path, a: side(DEP, null, never), b: side(IND, "b1") })).toMatchObject({
        act: "write",
        from: IND,
        to: DEP,
      });
    });

    it("deletes it where the other side held THIS copy and removed it", () => {
      expect(
        decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null, walked(["newer", "a1"])) }),
      ).toEqual({ act: "delete", path, on: DEP, deletedOn: IND });
    });

    it("holds it where the other side removed it and this copy is not one it held", () => {
      const d = decideLateral({
        path,
        a: side(DEP, "edited"),
        b: side(IND, null, walked(["x", "y"])),
      });
      expect(d).toMatchObject({ act: "hold", kind: "deleted_and_changed" });
    });

    it("defers a history it could not read, rather than guessing", () => {
      // Unasked and unreadable are reads that did not finish, and a read that
      // FAILED is not a fact that is ABSENT. The next pass asks again.
      expect(decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null) }).act).toBe("defer");
      expect(
        decideLateral({
          path,
          a: side(DEP, "a1"),
          b: side(IND, null, { kind: "unsettled", why: "503" }),
        }).act,
      ).toBe("defer");
    });

    it("holds, for a person, a history it read and still cannot settle", () => {
      // Unrecoverable versions and a walk that stopped short of the beginning
      // give the same answer every time they are asked. Deferring them would
      // re-walk the same commits every slot and keep the lane permanently
      // behind; held, they are named once and asked again when a copy changes.
      expect(
        decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null, walked([])) }),
      ).toMatchObject({
        act: "hold",
        kind: "undecidable",
      });
      expect(
        decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null, walked(["x"], false)) }),
      ).toMatchObject({ act: "hold", kind: "undecidable" });
    });
  });

  describe("both hold it, differently", () => {
    it("writes from the side that moved on from the other's copy", () => {
      // The dependent once held the independent's copy and changed it since;
      // the independent never held the dependent's. The dependent is ahead.
      expect(
        decideLateral({
          path,
          a: side(DEP, "a2", walked(["a2", "b1"])),
          b: side(IND, "b1", walked(["b1"])),
        }),
      ).toEqual({ act: "write", path, from: DEP, to: IND });
      expect(
        decideLateral({
          path,
          a: side(DEP, "a1", walked(["a1"])),
          b: side(IND, "b2", walked(["b2", "a1"])),
        }),
      ).toEqual({ act: "write", path, from: IND, to: DEP });
    });

    it("holds a path both changed since they last agreed, and never merges it", () => {
      const d = decideLateral({
        path,
        a: side(DEP, "a2", walked(["a2", "base"])),
        b: side(IND, "b2", walked(["b2", "base"])),
      });
      expect(d).toMatchObject({ act: "hold", kind: "both_changed" });
    });

    it("holds a path where one side went back, because no history says which change to keep", () => {
      const d = decideLateral({
        path,
        a: side(DEP, "x", walked(["x", "y"])),
        b: side(IND, "y", walked(["y", "x"])),
      });
      expect(d).toMatchObject({ act: "hold", kind: "went_back" });
    });

    it("never writes where the walk that would rule out going back did not finish", () => {
      // Moving ahead and going back differ only in whether the other side ever
      // held this copy; a walk that stopped short cannot say. That is held for
      // a person — never written, and never re-walked every slot.
      expect(
        decideLateral({
          path,
          a: side(DEP, "a2", walked(["a2", "b1"])),
          b: side(IND, "b1", walked(["b1"], false)),
        }),
      ).toMatchObject({ act: "hold", kind: "undecidable" });
      expect(
        decideLateral({
          path,
          a: side(DEP, "a2", walked(["a2"], false)),
          b: side(IND, "b2", walked(["b2"])),
        }),
      ).toMatchObject({ act: "hold", kind: "undecidable" });
    });

    it("holds a history that contradicts the tree", () => {
      // A path at a side's head with no commit that wrote it is a reading that
      // contradicts itself. Acting on a contradiction is guessing, and asking
      // again returns the same contradiction.
      expect(
        decideLateral({ path, a: side(DEP, "a1", never), b: side(IND, "b1", walked(["b1"])) }),
      ).toMatchObject({ act: "hold", kind: "undecidable" });
    });

    it("keeps only an unfinished READ as a reason to come back next slot", () => {
      // The run decision re-runs a pass while anything is deferred, so a defer
      // that can never resolve is a pass every ten minutes for ever. Every
      // defer this rule returns is one the next pass can answer differently.
      const answers = [
        decideLateral({ path, a: side(DEP, "a1"), b: side(IND, "b1") }),
        decideLateral({
          path,
          a: side(DEP, "a1", { kind: "unsettled", why: "502" }),
          b: side(IND, "b1", walked(["b1"])),
        }),
        decideLateral({
          path,
          a: side(DEP, "a2", walked(["a2"], false)),
          b: side(IND, "b2", walked(["b2"], false)),
        }),
        decideLateral({ path, a: side(DEP, "a1"), b: side(IND, null, walked(["x", "y"], false)) }),
      ];
      expect(answers.map((d) => d.act)).toEqual(["defer", "defer", "hold", "hold"]);
      for (const d of answers.filter((x) => x.act === "defer")) {
        expect(d.why).toMatch(/not been asked|could not be read|needed/);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const REMINDERS_PURE = `export type Priority = "high" | "low";\nexport function priorityOf(): Priority { return "high"; }\n`;
const REMINDERS_SPEC = `import { priorityOf } from "../priority.pure";\nimport { it } from "vitest";\nit("x", () => { priorityOf(); });\n`;
const HUB_SPEC = `import { priorityOf } from "@/lib/reminders/priority.pure";\nimport RemindersHub from "@/pages/RemindersHub";\n`;

function destination(overrides: Partial<LateralDestination> = {}): LateralDestination {
  return {
    repo: IND,
    tree: tree({ "src/pages/RemindersHub.tsx": "hub", "src/App.tsx": "app-b" }),
    scope: "mirror",
    scopeGlobs: null,
    exclusions: [],
    ...overrides,
  };
}

function judge(args: {
  paths: string[];
  texts: Record<string, string | null>;
  originTree?: Map<string, string>;
  dest?: LateralDestination;
  modes?: Record<string, string>;
  sizes?: Record<string, number>;
  destinationText?: Record<string, string | null>;
  deleting?: string[];
  survivors?: Record<string, string> | null;
  membrane?: typeof INTO_IND;
}) {
  const originTree =
    args.originTree ??
    tree({
      "src/pages/RemindersHub.tsx": "hub",
      "src/App.tsx": "app-a",
      ...Object.fromEntries(args.paths.map((p) => [p, `sha:${p}`])),
    });
  return judgeLateralWrites({
    membrane: args.membrane ?? INTO_IND,
    paths: args.paths,
    originTree,
    originModes: new Map(Object.entries(args.modes ?? {})),
    originSizes: new Map(Object.entries(args.sizes ?? {})),
    originText: new Map(Object.entries(args.texts)),
    destination: args.dest ?? destination(),
    destinationText: new Map(Object.entries(args.destinationText ?? {})),
    deletingOnDestination: new Set(args.deleting ?? []),
    destinationSurvivors: args.survivors === undefined ? {} : args.survivors,
    knownRefs: [],
  });
}

describe("may it enter: the destination's own rulebook", () => {
  it("writes the reminders fix and both of its specs together", () => {
    const j = judge({
      paths: [
        "src/lib/reminders/priority.pure.ts",
        "src/lib/reminders/__tests__/priority.spec.ts",
        "src/pages/__tests__/remindersHubPriority.spec.tsx",
      ],
      texts: {
        "src/lib/reminders/priority.pure.ts": REMINDERS_PURE,
        "src/lib/reminders/__tests__/priority.spec.ts": REMINDERS_SPEC,
        "src/pages/__tests__/remindersHubPriority.spec.tsx": HUB_SPEC,
      },
    });
    expect(j.write).toEqual([
      "src/lib/reminders/__tests__/priority.spec.ts",
      "src/lib/reminders/priority.pure.ts",
      "src/pages/__tests__/remindersHubPriority.spec.tsx",
    ]);
    expect(j.held).toEqual([]);
  });

  it("reports a path a module-scoped destination is not offered, and never holds it", () => {
    const dest = destination({ scope: "modules", scopeGlobs: ["src/lib/crm/**", "docs/**"] });
    expect(inLateralScope(dest, "docs/x.md")).toBe(true);
    expect(inLateralScope(dest, "src/lib/reminders/priority.pure.ts")).toBe(false);
    const j = judge({
      paths: ["src/lib/reminders/priority.pure.ts", "docs/x.md"],
      texts: { "src/lib/reminders/priority.pure.ts": REMINDERS_PURE, "docs/x.md": "# x" },
      dest,
    });
    expect(j.outOfScope).toEqual(["src/lib/reminders/priority.pure.ts"]);
    expect(j.write).toEqual(["docs/x.md"]);
  });

  it("applies the destination's exclusions exactly as the vertical cascade does", () => {
    const j = judge({
      paths: ["scripts/clone-backend/README.md", "docs/x.md"],
      texts: { "scripts/clone-backend/README.md": "x", "docs/x.md": "y" },
      dest: destination({
        exclusions: [
          { pattern: "scripts/clone-backend/**", reason: "protected", note: "identity" },
        ],
      }),
    });
    expect(j.held.map((h) => h.path)).toEqual(["scripts/clone-backend/README.md"]);
    expect(j.held[0].reason).toBe("protected");
    expect(j.write).toEqual(["docs/x.md"]);
  });

  it("never carries a symbolic link or a file past the read ceiling", () => {
    const j = judge({
      paths: ["docs/link.md", "public/huge.bin"],
      texts: { "docs/link.md": "../elsewhere", "public/huge.bin": null },
      modes: { "docs/link.md": "120000" },
      sizes: { "public/huge.bin": CASCADE_MAX_FILE_BYTES + 1 },
    });
    expect(j.write).toEqual([]);
    const byPath = Object.fromEntries(j.held.map((h) => [h.path, h]));
    expect(byPath["docs/link.md"].reason).toBe("protected");
    expect(byPath["public/huge.bin"].reason).toBe("oversize");
  });

  it("leaves a file it could not read unread — never written, never held", () => {
    const j = judge({ paths: ["docs/x.md"], texts: {} });
    expect(j.unread).toEqual(["docs/x.md"]);
    expect(j.write).toEqual([]);
    expect(j.held).toEqual([]);
  });

  it("refuses at the membrane what the membrane closes", () => {
    const j = judge({
      paths: ["src/components/Send.tsx"],
      texts: {
        "src/components/Send.tsx": `supabase.functions.invoke('send-ghl-message', { body: {} });`,
      },
    });
    expect(j.write).toEqual([]);
    expect(j.held[0].pattern).toContain("routed_crm_name channel closed");
  });

  it("refuses a judging workflow into a module-scoped destination, and admits it into a mirror", () => {
    const yaml = "on:\n  pull_request:\njobs:\n  verify:\n    runs-on: ubuntu-latest\n";
    const path = ".github/workflows/verify-extra.yml";
    const modules = judge({
      paths: [path],
      texts: { [path]: yaml },
      dest: destination({ scope: "modules", scopeGlobs: [".github/**"] }),
    });
    expect(modules.held.map((h) => h.pattern)).toEqual(["(content: judges the whole repository)"]);
    const mirror = judge({
      paths: [path],
      texts: { [path]: yaml },
      membrane: INTO_DEP,
      dest: destination({ repo: DEP }),
    });
    expect(mirror.write).toEqual([path]);
  });
});

describe("a spec crosses with what it asserts about, or not at all", () => {
  const spec = "src/lib/__tests__/routeExclusionGates.test.ts";
  const text = `const app = readFileSync("src/App.tsx", "utf8");`;

  it("holds a spec whose subject the two parents hold in different versions", () => {
    // Measured: the dependent's route-gate spec asserts about its own
    // `src/App.tsx`, which the independent holds in a different version —
    // and `src/App.tsx` is the prime's, so this lane can never carry it in.
    const j = judge({ paths: [spec], texts: { [spec]: text } });
    expect(j.write).toEqual([]);
    expect(j.held[0].pattern).toContain("spec channel gated on its subject");
    expect(j.held[0].note).toContain("`src/App.tsx`");
    expect(j.held[0].reason).toBe("manual_reconcile");
  });

  it("holds a spec whose subject the destination does not hold at all", () => {
    const readsDoc = `readFileSync("docs/BACKEND_ISOLATION.md", "utf8")`;
    const j = judge({
      paths: [spec],
      texts: { [spec]: readsDoc },
      originTree: tree({ [spec]: "s", "docs/BACKEND_ISOLATION.md": "doc" }),
    });
    expect(j.write).toEqual([]);
    expect(j.held[0].note).toContain("does not hold");
  });

  it("carries it when the subject is crossing beside it", () => {
    const readsDoc = `readFileSync("docs/BACKEND_ISOLATION.md", "utf8")`;
    const j = judge({
      paths: [spec, "docs/BACKEND_ISOLATION.md"],
      texts: { [spec]: readsDoc, "docs/BACKEND_ISOLATION.md": "# isolation" },
      originTree: tree({ [spec]: "s", "docs/BACKEND_ISOLATION.md": "doc" }),
    });
    expect(j.write).toEqual(["docs/BACKEND_ISOLATION.md", spec]);
  });

  it("releases the spec when its subject is held, because they travel together or not at all", () => {
    const readsDoc = `readFileSync("docs/BACKEND_ISOLATION.md", "utf8")`;
    const j = judge({
      paths: [spec, "docs/BACKEND_ISOLATION.md"],
      texts: {
        [spec]: readsDoc,
        "docs/BACKEND_ISOLATION.md": "Calls target `https://zyxwvutsrqponmlkjihg.supabase.co`.",
      },
      originTree: tree({ [spec]: "s", "docs/BACKEND_ISOLATION.md": "doc" }),
    });
    expect(j.write).toEqual([]);
    expect(j.held.map((h) => h.path).sort()).toEqual(["docs/BACKEND_ISOLATION.md", spec].sort());
  });

  it("reads a subject the spec names relative to itself", () => {
    // The shape that sent cascade #23 red: `'../../…'` named nothing the
    // subject rule could see, so the spec crossed alone.
    const relative = `readFileSync(resolve(here, "../../../docs/BACKEND_ISOLATION.md"), "utf8")`;
    const j = judge({
      paths: [spec],
      texts: { [spec]: relative },
      originTree: tree({ [spec]: "s", "docs/BACKEND_ISOLATION.md": "doc" }),
    });
    expect(j.write).toEqual([]);
    expect(j.held[0].note).toContain("`docs/BACKEND_ISOLATION.md`");
    expect(
      absentSubjects({
        specText: relative,
        specPath: spec,
        originTree: tree({ [spec]: "s", "docs/BACKEND_ISOLATION.md": "doc" }),
        destinationTree: tree({}),
        crossing: new Set(),
        deletingOnDestination: new Set(),
      }),
    ).toEqual(["docs/BACKEND_ISOLATION.md"]);
  });

  it("counts no subject the origin lacks — a spec that a path is absent is true on both sides", () => {
    expect(
      absentSubjects({
        specText: `expect(existsSync("src/components/ResponsibilityNotice.tsx")).toBe(false)`,
        originTree: tree({}),
        destinationTree: tree({}),
        crossing: new Set(),
        deletingOnDestination: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("a file crosses only where what it imports will be there", () => {
  const path = "src/lib/reminders/priority.pure.ts";
  const importer = "src/pages/RemindersBoard.tsx";

  it("holds an importer whose target the destination lacks and this delivery does not carry", () => {
    const j = judge({
      paths: [importer],
      texts: { [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";` },
      originTree: tree({ [importer]: "i", [path]: "p" }),
    });
    expect(j.write).toEqual([]);
    expect(j.held[0].pattern).toBe("(import: not on the destination)");
  });

  it("carries both when the target crosses too", () => {
    const j = judge({
      paths: [importer, path],
      texts: {
        [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";`,
        [path]: REMINDERS_PURE,
      },
      originTree: tree({ [importer]: "i", [path]: "p" }),
    });
    expect(j.write).toEqual([path, importer]);
  });

  it("holds the importer when its target is held — the fixed point", () => {
    const j = judge({
      paths: [importer, path],
      texts: {
        [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";`,
        [path]: REMINDERS_PURE,
      },
      originTree: tree({ [importer]: "i", [path]: "p" }),
      dest: destination({ exclusions: [{ pattern: path, reason: "manual_reconcile" }] }),
    });
    expect(j.write).toEqual([]);
    expect(j.held.map((h) => h.path).sort()).toEqual([importer, path].sort());
  });

  it("treats a target being deleted on the destination as absent", () => {
    const j = judge({
      paths: [importer],
      texts: { [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";` },
      originTree: tree({ [importer]: "i", [path]: "p" }),
      dest: destination({ tree: tree({ [path]: "p" }) }),
      deleting: [path],
    });
    expect(j.held[0]?.pattern).toBe("(import: not on the destination)");
  });

  it("holds an importer whose named import the destination's copy does not export", () => {
    const originTree = tree({ [importer]: "i", [path]: "p-new" });
    const dest = destination({ tree: tree({ [path]: "p-old" }) });
    const texts = {
      [importer]: `import { priorityOf, bandOf } from "@/lib/reminders/priority.pure";`,
    };
    expect(
      differingImportTargets({
        paths: [importer],
        originTree,
        originText: new Map(Object.entries(texts)),
        destinationTree: dest.tree,
      }),
    ).toEqual([path]);
    const j = judge({
      paths: [importer],
      texts,
      originTree,
      dest,
      destinationText: { [path]: "export function priorityOf() {}" },
    });
    expect(j.held[0].pattern).toBe("(import: not exported on the destination)");
    expect(j.held[0].note).toContain("`bandOf`");
  });

  it("leaves the importer unread where the destination's copy was not read", () => {
    const j = judge({
      paths: [importer],
      texts: { [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";` },
      originTree: tree({ [importer]: "i", [path]: "p-new" }),
      dest: destination({ tree: tree({ [path]: "p-old" }) }),
    });
    expect(j.unread).toEqual([importer]);
  });

  it("stays silent on a destination module it cannot enumerate", () => {
    const j = judge({
      paths: [importer],
      texts: { [importer]: `import { priorityOf } from "@/lib/reminders/priority.pure";` },
      originTree: tree({ [importer]: "i", [path]: "p-new" }),
      dest: destination({ tree: tree({ [path]: "p-old" }) }),
      destinationText: { [path]: `export * from "./elsewhere";` },
    });
    expect(j.write).toEqual([importer]);
  });
});

describe("an overwrite may not take away what the destination still uses", () => {
  const target = "src/lib/reminders/priority.pure.ts";
  const keeper = "src/pages/RemindersBoard.tsx";

  it("holds a new version that no longer exports a name the destination's own work imports", () => {
    const j = judge({
      paths: [target],
      texts: { [target]: "export function priorityOf() {}" },
      originTree: tree({ [target]: "new" }),
      dest: destination({ tree: tree({ [target]: "old", [keeper]: "k" }) }),
      survivors: { [keeper]: `import { bandOf } from "@/lib/reminders/priority.pure";` },
    });
    expect(j.write).toEqual([]);
    expect(j.held[0].pattern).toBe("(import: an export the destination still uses)");
    expect(j.held[0].note).toContain(`\`${keeper}\``);
    expect(j.held[0].note).toContain("`bandOf`");
  });

  it("carries it when the importer is being overwritten by the same delivery", () => {
    const j = judge({
      paths: [target, keeper],
      texts: {
        [target]: "export function priorityOf() {}",
        [keeper]: `import { priorityOf } from "@/lib/reminders/priority.pure";`,
      },
      originTree: tree({ [target]: "new", [keeper]: "k-new" }),
      dest: destination({ tree: tree({ [target]: "old", [keeper]: "k" }) }),
      survivors: { [keeper]: `import { bandOf } from "@/lib/reminders/priority.pure";` },
    });
    expect(j.write).toEqual([target, keeper]);
  });

  it("defers every walkable overwrite when the destination's work could not be read in full", () => {
    const j = judge({
      paths: [target, "docs/x.md"],
      texts: { [target]: "export function priorityOf() {}", "docs/x.md": "# x" },
      originTree: tree({ [target]: "new", "docs/x.md": "x" }),
      dest: destination({ tree: tree({ [target]: "old", "docs/x.md": "y" }) }),
      survivors: null,
    });
    expect(j.unread).toEqual([target]);
    // A document cannot be imported, so overwriting it can break no build.
    expect(j.write).toEqual(["docs/x.md"]);
  });

  it("reads only the destination's own work to find out", () => {
    const destinationTree = tree({
      "src/App.tsx": "app-b",
      "src/pages/RemindersHub.tsx": "hub",
      "src/lib/crm/crmProvider.ts": "crm",
      "src/lib/same.ts": "same",
      "docs/notes.md": "notes",
    });
    expect(
      lateralSurvivorCandidates({
        destinationTree,
        originTree: tree({ "src/App.tsx": "app-a", "src/lib/same.ts": "same" }),
        primeTree: tree({ "src/App.tsx": "app-p", "src/pages/RemindersHub.tsx": "hub" }),
      }),
    ).toEqual(["src/App.tsx", "src/lib/crm/crmProvider.ts"]);
    expect(SURVIVOR_READ_CEILING).toBeGreaterThanOrEqual(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("deletions", () => {
  const dest = destination({
    repo: DEP,
    scope: "mirror",
    tree: tree({ "src/lib/old.ts": "o", "scripts/keep.sh": "k" }),
    exclusions: [{ pattern: "scripts/**", reason: "protected" }],
  });

  it("keeps a path the destination's exclusions claim", () => {
    const p = planLateralDeletions({
      deletes: [{ path: "scripts/keep.sh", deletedOn: IND }],
      destination: dest,
      survivingFiles: {},
    });
    expect(p.deletes).toEqual([]);
    expect(p.kept[0].why).toContain("scripts/**");
  });

  it("withholds every deletion when the importers could not all be read", () => {
    const p = planLateralDeletions({
      deletes: [{ path: "src/lib/old.ts", deletedOn: IND }],
      destination: dest,
      survivingFiles: null,
    });
    expect(p.deletes).toEqual([]);
    expect(p.kept).toHaveLength(1);
  });

  it("keeps a deletion a surviving file still imports, and names the parent that deleted it", () => {
    const p = planLateralDeletions({
      deletes: [{ path: "src/lib/old.ts", deletedOn: IND }],
      destination: dest,
      survivingFiles: { "src/pages/Uses.tsx": `import { x } from "@/lib/old";` },
    });
    expect(p.deletes).toEqual([]);
    expect(p.kept[0].why).toContain(`\`${IND}\` removed this`);
    expect(p.kept[0].why).not.toContain("Prime removed this");
  });

  it("deletes what nothing imports", () => {
    const p = planLateralDeletions({
      deletes: [{ path: "src/lib/old.ts", deletedOn: IND }],
      destination: dest,
      survivingFiles: { "src/pages/Other.tsx": `import { y } from "@/lib/other";` },
    });
    expect(p.deletes).toEqual(["src/lib/old.ts"]);
  });

  it("keeps what a KEPT target imports — keeping is contagious", () => {
    // `outer.ts` is kept because the destination's own page imports it, and
    // `outer.ts` imports `inner.ts`. Judged once against the files staying
    // before the plan decides, `inner.ts` would read as unreferenced and go —
    // leaving the kept `outer.ts` importing a file that is not there.
    const d = destination({
      repo: DEP,
      scope: "mirror",
      tree: tree({ "src/lib/outer.ts": "o", "src/lib/inner.ts": "i", "src/pages/P.tsx": "p" }),
    });
    const p = planLateralDeletions({
      deletes: [
        { path: "src/lib/outer.ts", deletedOn: IND },
        { path: "src/lib/inner.ts", deletedOn: IND },
      ],
      destination: d,
      survivingFiles: {
        "src/pages/P.tsx": `import { outer } from "@/lib/outer";`,
        "src/lib/outer.ts": `import { inner } from "./inner";\nexport const outer = inner;`,
        "src/lib/inner.ts": `export const inner = 1;`,
      },
    });
    expect(p.deletes).toEqual([]);
    expect(p.kept.map((k) => k.path).sort()).toEqual(["src/lib/inner.ts", "src/lib/outer.ts"]);
    expect(p.kept.find((k) => k.path === "src/lib/inner.ts")!.why).toContain("src/lib/outer.ts");
  });

  it("deletes both where the only importer of one target is the other, and neither is kept", () => {
    const d = destination({
      repo: DEP,
      scope: "mirror",
      tree: tree({ "src/lib/outer.ts": "o", "src/lib/inner.ts": "i" }),
    });
    const p = planLateralDeletions({
      deletes: [
        { path: "src/lib/outer.ts", deletedOn: IND },
        { path: "src/lib/inner.ts", deletedOn: IND },
      ],
      destination: d,
      survivingFiles: {
        "src/lib/outer.ts": `import { inner } from "./inner";\nexport const outer = inner;`,
        "src/lib/inner.ts": `export const inner = 1;`,
      },
    });
    expect(p.deletes).toEqual(["src/lib/inner.ts", "src/lib/outer.ts"]);
    expect(p.kept).toEqual([]);
  });

  it("refuses a set past the cap whole, rather than a slice of it", () => {
    const deletes = Array.from({ length: 4 }, (_, i) => ({
      path: `src/lib/d${i}.ts`,
      deletedOn: IND,
    }));
    const p = planLateralDeletions({ deletes, destination: dest, survivingFiles: {}, cap: 3 });
    expect(p.deletes).toEqual([]);
    expect(p.refusal).toContain("4 file(s)");
  });

  it("reports a deletion outside a module-scoped destination's scope", () => {
    const p = planLateralDeletions({
      deletes: [{ path: "src/lib/old.ts", deletedOn: DEP }],
      destination: destination({ scope: "modules", scopeGlobs: ["docs/**"] }),
      survivingFiles: {},
    });
    expect(p.outOfScope).toEqual(["src/lib/old.ts"]);
    expect(p.deletes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("when a pass runs", () => {
  it("runs in a clock slot, so it needs no state to know it is due", () => {
    const slot = Date.parse("2026-09-23T12:00:30.000Z");
    expect(isLateralSlot(slot)).toBe(true);
    expect(isLateralSlot(slot + 60_000)).toBe(false);
    expect(isLateralSlot(slot + LATERAL_CADENCE_MINUTES * 60_000)).toBe(true);
  });

  it("fingerprints the heads in a fixed order", () => {
    expect(lateralFingerprint({ b: "2", a: "1" })).toBe("a@1|b@2");
  });

  const last = { fingerprint: "f", at: iso(NOW - 60_000), deferred: 0, paused: false };
  const ask = (over: Partial<Parameters<typeof decideLateralRun>[0]>) =>
    decideLateralRun({
      nowMs: NOW,
      force: false,
      fingerprint: "f",
      proposalsSettled: 0,
      last,
      ...over,
    });

  it("runs on an operator's word, on a first pass, and when a head moved", () => {
    expect(ask({ force: true }).run).toBe(true);
    expect(ask({ last: null }).run).toBe(true);
    expect(ask({ fingerprint: "g" }).run).toBe(true);
  });

  it("runs when a proposal was merged or declined, or work was deferred", () => {
    expect(ask({ proposalsSettled: 1 }).why).toContain("merged or declined");
    expect(ask({ last: { ...last, deferred: 2 } }).run).toBe(true);
  });

  it("does not run a pass for a proposal merely waiting on its checks", () => {
    // The reconcile before this question is what lands it. A pass here would
    // re-read three trees to learn that nothing it reads has changed.
    expect(ask({}).run).toBe(false);
  });

  it("stops for a pause, and runs anyway when an operator asks", () => {
    const paused = { ...last, paused: true };
    expect(ask({ last: paused, fingerprint: "g" })).toEqual({
      run: false,
      why: "paused by an operator",
    });
    expect(ask({ last: paused, proposalsSettled: 3 }).run).toBe(false);
    expect(ask({ last: paused, force: true }).run).toBe(true);
  });

  it("otherwise waits a day, which is what re-reads a history an earlier pass could not", () => {
    expect(ask({}).run).toBe(false);
    expect(ask({ last: { ...last, at: iso(NOW - LATERAL_RECHECK_MS) } }).run).toBe(true);
    expect(ask({ last: { ...last, at: "garbage" } }).run).toBe(true);
  });
});

describe("memory across passes", () => {
  const write = { act: "write", path: "a.ts", from: DEP, to: IND } as const;

  it("recalls a decision for the same pair of blobs until it expires", () => {
    const key = decisionKey("a.ts", "x", null);
    expect(key).toBe("a.ts|x|-");
    const memo: LateralMemo = {
      ...EMPTY_LATERAL_MEMO,
      decisions: { [key]: { at: iso(NOW - 1000), d: write } },
    };
    expect(recalledDecision(memo, key, NOW)).toEqual(write);
    expect(recalledDecision(memo, key, NOW + DECISION_TTL_MS)).toBeNull();
    expect(recalledDecision(memo, decisionKey("a.ts", "y", null), NOW)).toBeNull();
  });

  it("reads back anything, and a malformed memo is an empty one", () => {
    expect(readLateralMemo(null)).toEqual(EMPTY_LATERAL_MEMO);
    expect(readLateralMemo({ v: 2 })).toEqual(EMPTY_LATERAL_MEMO);
    const memo = readLateralMemo({
      v: 1,
      origin: { held: ["x", 3], never: { y: iso(NOW), z: 4 } },
      decisions: {
        good: { at: iso(NOW), d: write },
        defer: { at: iso(NOW), d: { act: "defer", path: "b" } },
        broken: { at: 5, d: write },
      },
    });
    expect(memo.origin.held).toEqual(["x"]);
    expect(Object.keys(memo.origin.never)).toEqual(["y"]);
    expect(Object.keys(memo.decisions)).toEqual(["good"]);
  });

  it("keeps 'held' for ever, dates 'never', and lets a held answer override it", () => {
    const previous: LateralMemo = {
      v: 1,
      origin: { held: ["h"], never: { n: iso(NOW - ORIGIN_NEVER_TTL_MS - 1), m: iso(NOW - 1) } },
      decisions: { old: { at: iso(NOW - DECISION_TTL_MS - 1), d: write } },
      declined: {},
    };
    const next = nextLateralMemo({
      previous,
      nowMs: NOW,
      originAnswers: new Map([
        ["m", "held"],
        ["fresh", "never"],
      ]),
      decisions: new Map([["k", write]]),
    });
    expect(next.origin.held).toEqual(["h", "m"]);
    expect(Object.keys(next.origin.never).sort()).toEqual(["fresh"]);
    expect(Object.keys(next.decisions)).toEqual(["k"]);
  });
});

describe("a proposal a person closed is not re-opened", () => {
  const reminders = { path: "src/lib/reminders/priority.pure.ts", sha: "r1" };
  const removal = { path: "docs/old.md", sha: DECLINED_DELETION };

  it("remembers each declined copy, path by path, where it was declined", () => {
    const memo = nextLateralMemo({
      previous: EMPTY_LATERAL_MEMO,
      nowMs: NOW,
      originAnswers: new Map(),
      decisions: new Map(),
      declines: [{ to: IND, items: [reminders, removal], url: "https://github.com/o/r/pull/9" }],
    });
    expect(memo.declined[IND]["src/lib/reminders/priority.pure.ts"]).toEqual({
      sha: "r1",
      url: "https://github.com/o/r/pull/9",
      at: iso(NOW),
    });
    expect(memo.declined[IND]["docs/old.md"].sha).toBe(DECLINED_DELETION);
    expect(memo.declined[DEP]).toBeUndefined();
  });

  it("withholds exactly the declined copy, and offers a changed one again", () => {
    const memo = nextLateralMemo({
      previous: EMPTY_LATERAL_MEMO,
      nowMs: NOW,
      originAnswers: new Map(),
      decisions: new Map(),
      declines: [{ to: IND, items: [reminders], url: "u" }],
    });
    const same = withoutDeclined({ to: IND, items: [reminders, removal], memo });
    expect(same.offer).toEqual([removal]);
    expect(same.declined.map((d) => d.path)).toEqual([reminders.path]);

    // The origin changed the file again: a new offer, and it is made.
    const changed = withoutDeclined({ to: IND, items: [{ ...reminders, sha: "r2" }], memo });
    expect(changed.offer).toHaveLength(1);
    expect(changed.declined).toEqual([]);

    // A decline on one side says nothing about the other.
    expect(withoutDeclined({ to: DEP, items: [reminders], memo }).offer).toHaveLength(1);
  });

  it("survives the round trip through the ledger, and drops a malformed entry", () => {
    const memo = readLateralMemo({
      v: 1,
      origin: { held: [], never: {} },
      decisions: {},
      declined: { [IND]: { good: { sha: "s", url: "u", at: iso(NOW) }, bad: { sha: 1 } }, junk: 7 },
    });
    expect(Object.keys(memo.declined[IND])).toEqual(["good"]);
    expect(memo.declined.junk).toBeUndefined();
  });
});

describe("the ledger row is read back tolerantly", () => {
  it("reads an empty or foreign row as the lane's first", () => {
    expect(readLateralLedger(null)).toEqual(EMPTY_LATERAL_LEDGER);
    expect(readLateralLedger({ v: 2, paused: true })).toEqual(EMPTY_LATERAL_LEDGER);
  });

  it("reads a pause only when it says true", () => {
    expect(readLateralLedger({ v: 1, paused: true }).paused).toBe(true);
    expect(readLateralLedger({ v: 1, paused: "yes" }).paused).toBe(false);
  });

  it("keeps a proposal it can name and drops one it cannot", () => {
    const state = readLateralLedger({
      v: 1,
      fingerprint: "f",
      deferred: 2,
      proposals: [
        { from: DEP, to: IND, pr: 12, url: "u", items: [{ path: "a.ts", sha: "s" }, { path: 3 }] },
        { from: DEP, to: IND, pr: "12", url: "u" },
        { from: DEP, to: IND, pr: 1.5, url: "u" },
      ],
    });
    expect(state.fingerprint).toBe("f");
    expect(state.deferred).toBe(2);
    expect(state.proposals).toEqual([
      { from: DEP, to: IND, pr: 12, url: "u", items: [{ path: "a.ts", sha: "s" }] },
    ]);
  });
});

describe("survivors are read only where something could break", () => {
  const destinationTree = tree({ "src/lib/x.ts": "1", "docs/x.md": "2" });

  it("spends nothing on a delivery that only adds files", () => {
    // Nothing on the destination imports a path it does not hold.
    expect(survivorsNeeded({ writes: ["src/lib/new.ts"], deletes: [], destinationTree })).toBe(
      false,
    );
    expect(survivorsNeeded({ writes: ["docs/x.md"], deletes: [], destinationTree })).toBe(false);
  });

  it("asks for an overwrite of source, and for any deletion", () => {
    expect(survivorsNeeded({ writes: ["src/lib/x.ts"], deletes: [], destinationTree })).toBe(true);
    expect(survivorsNeeded({ writes: [], deletes: ["docs/x.md"], destinationTree })).toBe(true);
  });
});

describe("the proposal says where it came from and what stayed behind", () => {
  const held: HeldPath[] = [
    {
      path: ".github/workflows/vcr-prune.yml",
      pattern: "(membrane)",
      reason: "manual_reconcile",
      note: "names a hosting id",
    },
    {
      path: "src/lib/crm/crmProvider.ts",
      pattern: "(membrane)",
      reason: "protected",
      note: "routing layer",
    },
  ];
  const text = describeLateralProposal({
    boundaryLabel: "NPC Client Dashboard ⇄ NPC CRM Independent",
    from: DEP,
    to: IND,
    originHead: "0123456789abcdef",
    writes: ["src/lib/reminders/priority.pure.ts"],
    deletes: [],
    held,
    conflicts: [{ path: "docs/both.md", why: "both changed it" }],
    outOfScope: [],
    keptDeletions: [],
    deletionRefusal: null,
    mode: "auto_merge",
  });

  it("names the origin and its head in the title and the commit", () => {
    expect(text.title).toBe(`Aurixa lateral · ${DEP} → ${IND} · 1 file(s)`);
    expect(text.commitMessage.split("\n")[0]).toBe(
      `chore(aurixa): lateral 1 file(s) from ${DEP}@0123456`,
    );
  });

  it("lists what needs a person and counts what never crosses quietly", () => {
    expect(text.body).toContain("`.github/workflows/vcr-prune.yml` — needs a person");
    expect(text.body).not.toContain("crmProvider.ts");
    expect(text.body).toContain("1 further file(s) never cross");
    expect(text.body).toContain("`docs/both.md` — both changed it");
  });

  it("never prints the engine's vocabulary at a reader", () => {
    expect(text.body).not.toContain("manual_reconcile");
    expect(text.body).not.toMatch(/\bprotected\b/);
  });

  it("says what closing it means, and where a lasting refusal is recorded", () => {
    expect(text.body).toContain("Closing this without merging declines these copies");
    expect(text.body).toContain("sync exclusions in Mission Control");
  });

  it("names the copies a person already declined, and when they come back", () => {
    const withDeclines = describeLateralProposal({
      boundaryLabel: "b",
      from: DEP,
      to: IND,
      originHead: "0123456789abcdef",
      writes: ["src/a.ts"],
      deletes: [],
      held: [],
      conflicts: [],
      outOfScope: [],
      keptDeletions: [],
      deletionRefusal: null,
      declined: [
        { path: "src/lib/reminders/priority.pure.ts", url: "https://github.com/o/r/pull/9" },
      ],
      mode: "pr",
    });
    expect(withDeclines.body).toContain("### Declined here before (1)");
    expect(withDeclines.body).toContain(
      "`src/lib/reminders/priority.pure.ts` — https://github.com/o/r/pull/9",
    );
    expect(withDeclines.body).toContain(`if \`${DEP}\` changes them`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a module-scoped destination: invariants widen what is sent, never what is removed", () => {
  const dests = lateralDestinations({
    repo: IND,
    tree: tree({}),
    scope: "modules",
    installedGlobs: ["src/lib/reminders/**"],
    exclusions: [],
  });

  it("offers a parent's script to be WRITTEN, because scripts/** is a repository invariant", () => {
    expect(inLateralScope(dests.writes, "scripts/check-clone-invariants.sh")).toBe(true);
    expect(inLateralScope(dests.writes, "src/lib/reminders/priority.pure.ts")).toBe(true);
  });

  it("never offers the same script to be DELETED — only the installed modules may lose a file", () => {
    // The vertical engine's own sentence, and the reason: a `scripts/**`
    // entry that also authorised deletion would put the destination's own
    // tooling in the destructive half of a pass that only needed to add.
    expect(inLateralScope(dests.deletes, "scripts/check-clone-invariants.sh")).toBe(false);
    expect(inLateralScope(dests.deletes, "src/lib/reminders/priority.pure.ts")).toBe(true);
  });

  it("offers a mirror the whole tree both ways", () => {
    const mirror = lateralDestinations({
      repo: DEP,
      tree: tree({}),
      scope: "mirror",
      installedGlobs: [],
      exclusions: [],
    });
    expect(inLateralScope(mirror.writes, "scripts/anything.sh")).toBe(true);
    expect(inLateralScope(mirror.deletes, "scripts/anything.sh")).toBe(true);
  });

  it("plans a deletion outside the installed modules as out of scope, not as a deletion", () => {
    const plan = planLateralDeletions({
      deletes: [{ path: "scripts/old.sh", deletedOn: DEP }],
      destination: { ...dests.deletes, tree: tree({ "scripts/old.sh": "x" }) },
      survivingFiles: {},
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.outOfScope).toEqual(["scripts/old.sh"]);
  });
});

describe("a paused boundary never merges", () => {
  it("proposes and leaves where the rulebook would have merged", () => {
    expect(effectiveLateralMode("auto_merge", true)).toBe("pr");
    expect(effectiveLateralMode("auto_merge", false)).toBe("auto_merge");
  });

  it("changes nothing else about the rulebook's mode", () => {
    expect(effectiveLateralMode("pr", true)).toBe("pr");
    expect(effectiveLateralMode("notify", true)).toBe("notify");
    expect(effectiveLateralMode("notify", false)).toBe("notify");
  });
});

describe("what a recorded proposal's pull request says now", () => {
  it("reads a merge as a merge, whatever its state word says", () => {
    expect(
      readProposalState({ state: "closed", merged_at: "2026-09-23T10:00:00Z", body: null }),
    ).toBe("merged");
  });

  it("reads an open pull request as open", () => {
    expect(readProposalState({ state: "open", merged_at: null, body: "x" })).toBe("open");
  });

  it("reads a person closing it as a decline", () => {
    expect(
      readProposalState({ state: "closed", merged_at: null, body: "Proposed for review" }),
    ).toBe("declined");
    expect(readProposalState({ state: "closed", merged_at: null, body: null })).toBe("declined");
  });

  it("never reads the lane's own closing as a person's decline", () => {
    // Otherwise the lane would teach itself to withhold copies nobody declined.
    expect(
      readProposalState({ state: "closed", merged_at: null, body: `body\n\n${SUPERSEDED_MARKER}` }),
    ).toBe("superseded");
    expect(SUPERSEDED_MARKER.startsWith("<!--")).toBe(true);
  });
});

describe("an open proposal that already carries the offer is left alone", () => {
  const items = [
    { path: "src/lib/reminders/priority.pure.ts", sha: "a1" },
    { path: "docs/OLD.md", sha: DECLINED_DELETION },
  ];

  it("matches on each path's resulting blob or removal, not on the tree", () => {
    expect(
      proposalCarries({
        items,
        files: [
          { filename: "src/lib/reminders/priority.pure.ts", status: "modified", sha: "a1" },
          { filename: "docs/OLD.md", status: "removed", sha: null },
        ],
        listingComplete: true,
      }),
    ).toBe(true);
  });

  it("is rebuilt when any blob differs, a path is missing or extra, or a removal became a write", () => {
    const files = (over: Partial<Record<string, { status: string; sha: string | null }>>) =>
      [
        { filename: "src/lib/reminders/priority.pure.ts", status: "modified", sha: "a1" },
        { filename: "docs/OLD.md", status: "removed", sha: null },
      ].map((f) => ({ ...f, ...(over[f.filename] ?? {}) }));
    expect(
      proposalCarries({
        items,
        files: files({ "src/lib/reminders/priority.pure.ts": { status: "modified", sha: "zz" } }),
        listingComplete: true,
      }),
    ).toBe(false);
    expect(
      proposalCarries({
        items,
        files: files({ "docs/OLD.md": { status: "modified", sha: "q" } }),
        listingComplete: true,
      }),
    ).toBe(false);
    expect(proposalCarries({ items, files: files({}).slice(0, 1), listingComplete: true })).toBe(
      false,
    );
    expect(
      proposalCarries({
        items,
        files: [...files({}), { filename: "extra.ts", status: "added", sha: "e" }],
        listingComplete: true,
      }),
    ).toBe(false);
  });

  it("never calls a listing that may have been cut short, or a rename, a match", () => {
    const exact = [
      { filename: "src/lib/reminders/priority.pure.ts", status: "modified", sha: "a1" },
      { filename: "docs/OLD.md", status: "removed", sha: null },
    ];
    expect(proposalCarries({ items, files: exact, listingComplete: false })).toBe(false);
    expect(
      proposalCarries({
        items: [{ path: "b.ts", sha: "s" }],
        files: [{ filename: "b.ts", status: "renamed", sha: "s" }],
        listingComplete: true,
      }),
    ).toBe(false);
  });
});

describe("one ledger row carries the state and the report together", () => {
  const report: LateralBoundaryReport = {
    boundary: `${DEP}~${IND}`,
    label: "x",
    outcome: "ran",
    why: "w".repeat(2_000),
    mode: "pr",
    candidates: 3,
    primeOwned: 1,
    conflicts: [],
    deferred: Array.from({ length: 200 }, (_, i) => ({ path: `p${i}`, why: "y" })),
    reconcile: [],
    directions: [
      {
        from: DEP,
        to: IND,
        outcome: "proposed",
        why: "ok",
        writes: ["a.ts"],
        deletes: [],
        held: [{ path: "h.ts", pattern: "x", reason: "manual_reconcile", note: "n".repeat(5_000) }],
        keptDeletions: [],
        deletionRefusal: null,
        outOfScope: [],
        declined: [],
        unread: [],
        pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        merge: null,
      },
    ],
    ledgerWritten: null,
  };

  it("round-trips the state the next slot decides on", () => {
    const state = {
      ...EMPTY_LATERAL_LEDGER,
      fingerprint: "f",
      deferred: 2,
      proposals: [{ from: DEP, to: IND, pr: 7, url: "u", items: [{ path: "a.ts", sha: "s" }] }],
    };
    const row = composeLateralLedgerRow({
      event: "exchange",
      state,
      report,
      trigger: "slot",
      heads: { a: "1" },
    });
    const back = readLateralLedger(row);
    expect(back.fingerprint).toBe("f");
    expect(back.deferred).toBe(2);
    expect(back.proposals).toEqual(state.proposals);
    expect(back.paused).toBe(false);
  });

  it("round-trips the report a person reads, bounded so a row never grows with a delivery", () => {
    const row = composeLateralLedgerRow({
      event: "exchange",
      state: EMPTY_LATERAL_LEDGER,
      report,
      trigger: "slot",
      heads: null,
    });
    const back = readLateralReport(JSON.parse(JSON.stringify(row)));
    expect(back).not.toBeNull();
    expect(back!.directions[0].pr?.number).toBe(7);
    expect(back!.why.length).toBeLessThanOrEqual(400);
    expect(back!.deferred.length).toBeLessThanOrEqual(60);
    expect(back!.directions[0].held[0].note!.length).toBeLessThanOrEqual(400);
    expect(compactLateralReport(report).directions[0].writes).toEqual(["a.ts"]);
  });

  it("reads a row it cannot fully parse as no report, never as half of one", () => {
    expect(readLateralReport(null)).toBeNull();
    expect(readLateralReport({ report: { boundary: "b" } })).toBeNull();
    expect(
      readLateralReport({
        report: { ...report, directions: [{ ...report.directions[0], writes: [1] }] },
      }),
    ).toBeNull();
  });

  it("keeps a pause row's state readable, so the next slot sees the pause", () => {
    const row = composeLateralLedgerRow({
      event: "paused",
      state: { ...EMPTY_LATERAL_LEDGER, paused: true },
      report: null,
      trigger: null,
      heads: null,
    });
    expect(readLateralLedger(row).paused).toBe(true);
    expect(readLateralReport(row)).toBeNull();
  });
});

describe("a proposal a person has pushed to is never rebuilt over", () => {
  it("recognises the lane's own single commit, and the proposal text writes exactly that shape", () => {
    const { commitMessage } = describeLateralProposal({
      boundaryLabel: "x",
      from: DEP,
      to: IND,
      originHead: "abcdef1234567",
      writes: ["a.ts"],
      deletes: [],
      held: [],
      conflicts: [],
      outOfScope: [],
      keptDeletions: [],
      deletionRefusal: null,
      mode: "pr",
    });
    expect(commitMessage.startsWith(LATERAL_COMMIT_PREFIX)).toBe(true);
    expect(isLaneOnlyProposal([{ message: commitMessage }])).toBe(true);
  });

  it("refuses a second commit, a merge of the base, or a stranger's single commit", () => {
    const lane = { message: `${LATERAL_COMMIT_PREFIX}1 file(s) from x@abc` };
    expect(isLaneOnlyProposal([lane, { message: "fix the check" }])).toBe(false);
    expect(
      isLaneOnlyProposal([{ message: "Merge branch 'main' into aurixa/lateral-from-x" }]),
    ).toBe(false);
    expect(
      isLaneOnlyProposal([{ message: "chore(aurixa): cascade 3 file(s) from prime@abc" }]),
    ).toBe(false);
    expect(isLaneOnlyProposal([])).toBe(false);
  });

  it("is not the vertical engine's prefix, so neither lane recognises the other's branch", () => {
    const repair = stripComments(readFileSync("src/server/cascade/proposalRepair.pure.ts", "utf8"));
    const engine = /ENGINE_COMMIT_PREFIX = "([^"]+)"/.exec(repair)?.[1];
    expect(engine).toBeTruthy();
    expect(LATERAL_COMMIT_PREFIX.startsWith(engine!)).toBe(false);
    expect(engine!.startsWith(LATERAL_COMMIT_PREFIX)).toBe(false);
  });
});
