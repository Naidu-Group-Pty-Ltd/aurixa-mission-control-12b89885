import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";

/**
 * An auditor that can move the pointer it audits is not an auditor.
 *
 * The whole value of this reading is that it is independent of the machinery
 * it measures: every OTHER answer to "is this clone in sync" derives from
 * `last_synced_sha`, which the merge drain writes, so a wrong actor produces a
 * reading wrong in the same direction. The 84-commit lie of 16 Sep 2026 is
 * that failure, and the fix made the pointer honest without making anything
 * check it.
 *
 * Independence is a source-level property, and the way it goes wrong is
 * somebody adding one convenient write. So it is asserted by source position
 * rather than by reading the code and trusting it — the same thing
 * `dryRunBoundary.test.ts` does for the rehearsal, for the same reason.
 */
const audit = stripNonCode(readFileSync("src/server/convergenceAudit.server.ts", "utf8"));
const hook = stripNonCode(readFileSync("src/routes/hooks.cascade-audit.tsx", "utf8"));
const pure = readFileSync("src/server/cascade/convergence.pure.ts", "utf8");
const engine = stripNonCode(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
const pumped = stripNonCode(readFileSync("src/server/cascade/pumpedPaths.pure.ts", "utf8"));

/** Tables whose contents ARE the thing being audited. */
const AUDITED_TABLES = ["cascade_events", "cascade_results", "clones"];
/** Anything that changes a row. */
const MUTATORS = [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("];

describe("the auditor writes nothing it measures", () => {
  it("names no audited table beside a mutator", () => {
    for (const table of AUDITED_TABLES) {
      for (const mutator of MUTATORS) {
        /* `.from("clones")` followed by a mutator anywhere in the same
           statement. Crude on purpose: a rule that is easy to satisfy by
           accident is one that stops holding. */
        const pattern = new RegExp(
          `from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,240}?\\${mutator.replace(/[.()]/g, "\\$&")}`,
        );
        expect(pattern.test(audit), `convergenceAudit must never ${mutator} on ${table}`).toBe(
          false,
        );
      }
    }
  });

  it("writes to exactly one table, its own", () => {
    const written = [
      ...audit.matchAll(/from\(\s*["']([a-z_]+)["']\s*\)\s*\n?\s*\.(insert|update|upsert|delete)/g),
    ].map((m) => m[1]);
    expect([...new Set(written)]).toEqual(["clone_convergence_observations"]);
  });

  it("requests no cascade and merges nothing", () => {
    for (const forbidden of [
      "createCascadeForAllClones",
      "executeCascade",
      "processClone",
      "drainCascadeMerges",
      "pulls.merge",
      "git.createRef",
      "git.createCommit",
      "git.createTree",
      "createBlob",
    ]) {
      expect(audit.includes(forbidden), `auditor must not reach ${forbidden}`).toBe(false);
    }
  });

  /*
    Step 1 of the shipping order is write-only on purpose: a wrong reading
    costs nothing while it runs beside the existing signals. The escalation
    that replaces `drift_high` reads this table and ships separately, once a
    week of observations has shown the reading agrees with reality.
  */
  it("notifies nobody yet", () => {
    for (const source of [audit, hook]) {
      expect(source.includes("notifyOperators")).toBe(false);
      expect(source.includes("notifications")).toBe(false);
    }
  });

  it("fetches no blob — a tree read answers the question", () => {
    /* A blob SHA is a hash of the content, which is what makes comparing a
       tree of several thousand files affordable at two calls. Reading content
       here would put the auditor on the cascade's own cost curve. */
    expect(audit.includes("getFileContent")).toBe(false);
    expect(audit.includes("listTreeEntries")).toBe(true);
  });

  it("yields to the cascade below the scan floor", () => {
    expect(hook).toContain("decideSpend");
    expect(hook).toContain('role: "scan"');
  });
});

describe("one implementation of what the cascade owes", () => {
  /*
    The auditor's entire job is to be the independent check on the engine. It
    can only do that while both sides ask the same question — two
    implementations of "what the cascade owes" is how they come to agree on
    nothing, which is the `globToRegex` lesson with more at stake.
  */
  it("reads through the engine's own partition rather than its own", () => {
    expect(pure).toContain('from "./syncExclusions.pure"');
    expect(pure).toContain("partitionCascadePaths(");
    /* No private glob matcher. */
    expect(pure.includes("globToRegex")).toBe(false);
    expect(pure.includes("new RegExp")).toBe(false);
  });

  it("asks the engine's own mode rule, with the modes the same listings returned", () => {
    expect(pure).toContain('import { executableBitDiffers } from "./treeDelivery.pure";');
    expect(pure).toContain("executableBitDiffers(path, input.primeModes ?? null");
    expect(audit).toContain("primeModes: primeTree.modes,");
    expect(audit).toContain("cloneModes: cloneTree.modes,");
  });

  it("is fail-closed on an unreadable exclusion policy", () => {
    expect(audit).toContain("requireExclusions");
  });

  /*
    THE PATHS THE ENGINE COMPOSES ARE ONE LIST, AND IT IS THE ENGINE'S.

    The engine kept its own set of the files its pumps write per clone, and
    the auditor had none, so it compared them by blob identity and read them
    as owed on every mirror from 8 Oct to 27 Oct 2026. A second copy here
    would drift the same way: a pump added to one list and not the other is
    owed for ever.
  */
  it("reads the paths the engine composes from the list the engine itself uses", () => {
    expect(pure).toContain('import { PUMPED_PATHS } from "./pumpedPaths.pure";');
    expect(pure).toContain("PUMPED_PATHS.has(path)");
    expect(engine).toContain('import { PUMPED_PATHS } from "./cascade/pumpedPaths.pure";');
    expect(engine).not.toMatch(/const PUMPED_PATHS\s*=/);
    expect(engine).toContain("if (PUMPED_PATHS.has(path)) return");
  });

  it("restates no path: the list is built from the reconcilers' own exports", () => {
    // A string literal naming a file would be a second spelling of a path a
    // reconciler already owns.
    expect(pumped).not.toMatch(/["'][^"'\n]+\.(json|ts|toml|yml)["']/);
  });
});

describe("a reading names the commits it compared", () => {
  /*
    Both columns were written null on every row from the day the table was
    created, although the tree read returns the head it listed. A reading that
    cannot be tied to its two commits cannot be checked by hand.
  */
  it("writes both heads, from the same reads that listed the trees", () => {
    expect(audit).toContain("const primeSha = primeTree?.headSha ?? null;");
    expect(audit).toContain("cloneSha = cloneTree.headSha;");
    const measured = audit.slice(
      audit.indexOf("const reading = judgeConvergence({ now: new Date()"),
    );
    expect(measured).toMatch(/primeSha,\s*cloneSha,/);
    // Null now means "not read" and nothing else.
    expect(audit).not.toContain("primeSha: null");
  });
});

describe("the tick files an audit row only for news", () => {
  /*
    The CRM independent is not a mirror, so the auditor declines it on every
    tick, and `unknown > 0` alone filed an audit row 96 times a day. A read
    that FAILED is still news; a clone declined by design is the same fact
    every tick, and its observation row already says so.
  */
  it("does not count a clone declined by design as a failed reading", () => {
    expect(audit).toContain("{ outOfScope: true }");
    expect(audit).toContain("if (outcome.outOfScope) report.outOfScope += 1;");
    expect(hook).toContain("report.unknown > report.outOfScope");
    expect(hook).not.toContain("report.unknown > 0");
  });
});
