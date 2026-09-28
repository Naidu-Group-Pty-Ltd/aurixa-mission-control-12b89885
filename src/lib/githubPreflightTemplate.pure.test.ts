import { describe, expect, it } from "vitest";
import {
  judgeTemplateSource,
  sameGithubAccount,
  type TemplateSourceFacts,
} from "./githubPreflightTemplate.pure";

const facts = (over: Partial<TemplateSourceFacts> = {}): TemplateSourceFacts => ({
  method: "template",
  accessible: true,
  isTemplate: true,
  flagSetByProvisioning: false,
  inTargetAccount: true,
  administrationPermission: false,
  ...over,
});

describe("the prime path is unchanged", () => {
  it("passes a flagged template", () => {
    expect(judgeTemplateSource(facts())).toEqual({
      ok: true,
      willBeMarked: false,
      unmarkable: false,
    });
  });

  it("still fails an unflagged prime, which nothing marks", () => {
    // Administration is irrelevant: provisioning never flags the prime.
    for (const administrationPermission of [false, true]) {
      expect(judgeTemplateSource(facts({ isTemplate: false, administrationPermission }))).toEqual({
        ok: false,
        willBeMarked: false,
        unmarkable: false,
      });
    }
  });

  it("fails a template the installation cannot read", () => {
    expect(judgeTemplateSource(facts({ accessible: false, isTemplate: null })).ok).toBe(false);
  });

  it("asks nothing of a fork or a registered clone", () => {
    for (const method of ["fork", "clone", undefined] as const) {
      expect(judgeTemplateSource(facts({ method, accessible: false, isTemplate: false }))).toEqual({
        ok: true,
        willBeMarked: false,
        unmarkable: false,
      });
    }
  });
});

describe("a CRM parent, which provisioning flags itself", () => {
  const parent = (over: Partial<TemplateSourceFacts> = {}) =>
    facts({ flagSetByProvisioning: true, ...over });

  it("passes unflagged where the App can flag it, and says it will", () => {
    expect(
      judgeTemplateSource(parent({ isTemplate: false, administrationPermission: true })),
    ).toEqual({ ok: true, willBeMarked: true, unmarkable: false });
  });

  it("fails unflagged where the App provably cannot flag it", () => {
    // Same account, so the installation read is the one provisioning must use,
    // and it lacks Administration: write. Provisioning would refuse; the
    // wizard says so first.
    expect(
      judgeTemplateSource(parent({ isTemplate: false, administrationPermission: false })),
    ).toEqual({ ok: false, willBeMarked: false, unmarkable: true });
  });

  it("leaves a parent in another account to provisioning rather than guessing", () => {
    // The installation read belongs to a different account; its permissions
    // say nothing about the parent's.
    expect(
      judgeTemplateSource(
        parent({ isTemplate: false, inTargetAccount: false, administrationPermission: false }),
      ),
    ).toEqual({ ok: true, willBeMarked: true, unmarkable: false });
  });

  it("marks nothing already flagged", () => {
    expect(judgeTemplateSource(parent({ administrationPermission: false }))).toEqual({
      ok: true,
      willBeMarked: false,
      unmarkable: false,
    });
  });

  it("still fails a parent the installation cannot read", () => {
    // Flagging a repository the App cannot see is not a step provisioning
    // can take; an unreadable source is a failure whoever set it up.
    expect(
      judgeTemplateSource(
        parent({ accessible: false, isTemplate: null, administrationPermission: true }),
      ).ok,
    ).toBe(false);
  });
});

describe("sameGithubAccount", () => {
  it("compares logins as GitHub does", () => {
    expect(sameGithubAccount("Naidu-Group-Pty-Ltd", "naidu-group-pty-ltd")).toBe(true);
    expect(sameGithubAccount("@Naidu-Group-Pty-Ltd ", "Naidu-Group-Pty-Ltd")).toBe(true);
    expect(sameGithubAccount("Naidu-Group-Pty-Ltd", "a-client-org")).toBe(false);
  });

  it("never equates two missing owners", () => {
    expect(sameGithubAccount(null, "")).toBe(false);
    expect(sameGithubAccount(undefined, undefined)).toBe(false);
  });
});
