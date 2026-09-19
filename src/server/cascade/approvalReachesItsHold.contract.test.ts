import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { approvableHeld, reportableHeld, oversizeHold } from "./syncExclusions.pure";
import type { HeldPath } from "./syncExclusions.pure";

const engine = readFileSync(new URL("../cascade-engine.server.ts", import.meta.url), "utf8");
const card = readFileSync(
  new URL("../../components/cascade-dryrun-card.tsx", import.meta.url),
  "utf8",
);
/*
  LINE COMMENTS ONLY, DELIBERATELY.

  Stripping block comments by regex took 123,872 characters of
  `cascade-engine.server.ts` down to 62,955 — roughly half the file — because
  something in it opens a `/*` the pattern then runs past. A stripper that
  deletes the code it was meant to search reports "the rule is broken" about a
  file that obeys it, which is the worst answer a contract test can give.

  Line comments cannot swallow code, so they are safe to remove, and they are
  the thing worth removing: a commented-out call must not satisfy an assertion
  about a call. The patterns below are specific enough that prose would not
  contain them by accident.
*/
const stripLineComments = (s: string) => s.replace(/\/\/[^\n]*/g, " ");

const DIVERGED: HeldPath = {
  path: "src/App.tsx",
  pattern: "src/App.tsx",
  reason: "manual_reconcile",
  note: null,
};
const HUGE = oversizeHold("supabase/migrations/seed.sql", 41_671_969, 8 * 1024 * 1024);

/**
 * An approval must be offered only where an approval can be honoured.
 *
 * `oversizeHold` returned `manual_reconcile`, so a 41 MB seed appeared in
 * `needsReconcile`, the dry-run card drew "Approve prime's copy for held
 * path(s)…" over it, and `approveCascadePaths` wrote a fourteen-day row. But
 * `decideHoldRelease` filters `partition.held` some four hundred lines BEFORE
 * an oversize hold is pushed into it, so the approval could never reach one.
 * The operator approved, was told it had worked, and the next cascade held the
 * same file again — on every cascade, for ever.
 *
 * The two files it held are the v13 and v14 template-library seeds, which is
 * why all three cascading clones run seed **v12** against prime's **v14**.
 */
describe("the set an approval is offered over is the set it can release", () => {
  it("a divergence is both reportable and approvable", () => {
    expect(reportableHeld([DIVERGED])).toHaveLength(1);
    expect(approvableHeld([DIVERGED])).toHaveLength(1);
  });

  it("a ceiling is reportable and NOT approvable", () => {
    // Reported, because the file differs upstream and is not travelling, and
    // dropping it from the list restores the silence the reporting rule
    // exists to end. Not approvable, because no decision discharges a byte
    // count.
    expect(reportableHeld([HUGE])).toHaveLength(1);
    expect(approvableHeld([HUGE])).toHaveLength(0);
  });

  it("approvable is a subset of reportable, always", () => {
    const mixed = [DIVERGED, HUGE, { ...DIVERGED, path: "x", reason: "protected" as const }];
    const reportable = new Set(reportableHeld(mixed).map((h) => h.path));
    for (const h of approvableHeld(mixed)) {
      expect(reportable.has(h.path), `${h.path} offered but not reported`).toBe(true);
    }
  });

  it("the engine releases exactly the approvable set, by name", () => {
    // Through the shared helper rather than an inline `=== "manual_reconcile"`.
    // The release filter and the card's offer are the two ends that drifted,
    // and one name is what stops them drifting again.
    const bare = stripLineComments(engine);
    expect(bare).toMatch(/const releasable\s*=\s*approvableHeld\(/);
    // And the inline literal it replaced is gone, so the two ends cannot go
    // back to spelling the same rule twice.
    expect(bare).not.toMatch(/const releasable\s*=\s*partition\.held\.filter/);
  });

  it("the card draws its approval over the approvable set and never the whole list", () => {
    const bare = stripLineComments(card);
    // The offer's `paths` prop must not be the unfiltered `needsReconcile`.
    expect(bare).not.toMatch(/kind="overwrite"[\s\S]{0,400}paths=\{impact\.needsReconcile\}/);
    expect(bare).toMatch(/paths=\{approvable\}/);
    // And the excluded set is derived from what the server published, not
    // guessed from a path shape.
    expect(bare).toContain("impact.oversizePaths");
  });

  it("the server publishes which held paths are the ceiling's", () => {
    // Without this the card has nothing to exclude BY: an approval dialog is
    // drawn over paths, and a path carries no reason.
    const bare = stripLineComments(engine);
    expect(bare).toMatch(/oversizePaths:\s*needsReconcile\.filter/);
  });
});
