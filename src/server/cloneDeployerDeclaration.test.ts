/**
 * A declaration that is standing state rather than an act — and the two ways
 * making it automatic could go wrong: writing on a reading nobody has, and
 * hammering a repository it may never write.
 */
import { describe, expect, it } from "vitest";
import {
  DECLARED_DEPLOYER,
  planDeployerDeclaration,
  sweepIsNoteworthy,
  type DeclarationSweep,
} from "./cloneDeployerDeclaration.pure";
import { assessRepoWriteCapabilities } from "./githubAppCapability.pure";

// GitHub's key for the permission the settings page calls "Variables".
const caps = (variables: string | null) =>
  assessRepoWriteCapabilities(variables === null ? null : { actions_variables: variables });

const plan = (variableValue: string | null | undefined, variables: string | null = "write") =>
  planDeployerDeclaration({ repo: "owner/repo", variableValue, capabilities: caps(variables) });

describe("the switch is on, so a repository that disagrees is written", () => {
  it("declares where the variable is unset", () => {
    expect(plan(null)).toEqual({ act: "declare", repo: "owner/repo" });
  });

  it("declares where the variable says something else", () => {
    // "An unrecognised name is not evidence that anybody deploys" — the
    // workflow's own words. A stale value leaves the check red.
    expect(plan("someone-else").act).toBe("declare");
  });

  it("writes nothing where the repository already says it", () => {
    /*
      What makes a half-hourly job affordable. A settled fleet costs one
      variable listing per clone and no write at all.
    */
    expect(plan(DECLARED_DEPLOYER)).toEqual({ act: "already", repo: "owner/repo" });
  });
});

describe("a read that failed is not a variable that is absent", () => {
  it("answers unknown, and does not declare", () => {
    /*
      `listRepoVariables` answers null when GitHub could not be asked. Writing
      on that basis touches a repository whose state nobody knows — and would
      do it every half hour, for as long as the read stayed broken.
    */
    const out = plan(undefined);
    expect(out.act).toBe("unknown");
    expect(out.act === "unknown" && out.why).toMatch(/unknown rather than absent/i);
  });

  it("stays unknown even where the permission is granted", () => {
    // Being allowed to write says nothing about whether a write is needed.
    expect(plan(undefined, "write").act).toBe("unknown");
  });
});

describe("a permission it does not hold is named, not attempted", () => {
  it("reports why instead of writing", () => {
    const out = plan(null, "read");
    expect(out.act).toBe("cannot");
    expect(out.act === "cannot" && out.why.length).toBeGreaterThan(10);
  });

  it("still attempts when the permission could not be READ", () => {
    /*
      The rule the capability module exists for: a permission that could not
      be read answers `unknown`, never `missing`. Refusing to try on an
      unreadable permission would strand every clone behind a lost signal, and
      GitHub's own refusal is a better diagnostic than our guess.
    */
    expect(caps(null).variables.state).toBe("unknown");
    expect(plan(null, null).act).toBe("declare");
  });

  it("an already-declared repository is not reported as blocked", () => {
    // Nothing is owed, so a missing permission is irrelevant to it.
    expect(plan(DECLARED_DEPLOYER, "read").act).toBe("already");
  });
});

describe("a quiet pass says nothing", () => {
  const empty: DeclarationSweep = {
    permission: "granted",
    held: [],
    considered: 0,
    declared: [],
    already: 0,
    cannot: [],
    unknown: [],
    failed: [],
  };

  it("a fleet that already agrees files no audit row", () => {
    // A job that writes an identical row every half hour is one people stop
    // reading — and this one settles by design.
    expect(sweepIsNoteworthy({ ...empty, considered: 12, already: 12 })).toBe(false);
  });

  it("but a write, a refusal, an unreadable repo or a failure does", () => {
    expect(sweepIsNoteworthy({ ...empty, declared: ["a/b"] })).toBe(true);
    expect(sweepIsNoteworthy({ ...empty, cannot: [{ repo: "a/b", why: "x" }] })).toBe(true);
    expect(sweepIsNoteworthy({ ...empty, unknown: [{ repo: "a/b", why: "x" }] })).toBe(true);
    expect(sweepIsNoteworthy({ ...empty, failed: [{ repo: "a/b", error: "x" }] })).toBe(true);
  });
});

describe("a permission it does not hold is named ahead of a read that failed", () => {
  it("says which it is, rather than the vaguer of the two", () => {
    /*
      Found by watching the first live pass, 2 Sep 2026: all three clone
      repositories reported `unknown` — "GitHub did not answer" — because
      `listRepoVariables` answers null for a 403 exactly as it does for an
      outage, and the old order asked about the reading first. The message
      that names the remedy was unreachable precisely when it was the one
      needed.
    */
    const out = plan(undefined, "read");
    expect(out.act).toBe("cannot");
  });

  it("and still refuses to write in either case", () => {
    // Reordering must cost nothing in safety: both outcomes leave the
    // repository alone, so only the sentence an operator reads changes.
    for (const caps of ["read", null] as const) {
      expect(plan(undefined, caps).act).not.toBe("declare");
    }
  });

  it("an unreadable PERMISSION still falls through to the attempt", () => {
    // `unknown` is never `missing`: refusing on a lost signal would strand
    // every clone, and GitHub's own refusal is the better diagnostic.
    expect(plan(null, null).act).toBe("declare");
  });

  it("a repository that already agrees is unaffected by either", () => {
    // Nothing is owed, so no permission question arises.
    expect(plan(DECLARED_DEPLOYER, "read").act).toBe("already");
    expect(plan(DECLARED_DEPLOYER, null).act).toBe("already");
  });
});

describe("the value written is the one the workflow accepts", () => {
  it("matches the workflow's literal comparison", () => {
    /*
      The clone's gate is `[ "${DEPLOYER:-}" = "mission-control" ]`. Any other
      spelling leaves the check red while every surface here reports it
      declared.
    */
    expect(DECLARED_DEPLOYER).toBe("mission-control");
  });
});
