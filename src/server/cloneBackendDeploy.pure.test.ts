import { describe, expect, it } from "vitest";

import {
  classifyAccessToken,
  deriveDeployRoute,
  judgeTokenScope,
  type ScopeEvidence,
} from "@/server/cloneBackendDeploy.pure";

const CLONE = "plisdzywzleljorrphxv";
const PRIME = "dduzbchuswwbefdunfct";

const evidence = (over: Partial<ScopeEvidence> = {}): ScopeEvidence => ({
  tokenClass: "scoped",
  cloneProjectRef: CLONE,
  visibleProjectRefs: [CLONE],
  readsCloneProject: true,
  readsPrimeProject: false,
  primeProjectRef: PRIME,
  ...over,
});

describe("which kind of token this is", () => {
  it("reads the documented prefixes", () => {
    expect(classifyAccessToken("sbp_fc_abc123")).toBe("scoped");
    expect(classifyAccessToken("sbp_abc123")).toBe("classic");
    expect(classifyAccessToken("eyJhbGciOi...")).toBe("unrecognised");
    expect(classifyAccessToken("")).toBe("unrecognised");
  });

  it("ignores surrounding whitespace, because a paste carries it", () => {
    expect(classifyAccessToken("  sbp_fc_abc123\n")).toBe("scoped");
  });
});

describe("a classic token is refused before anything is asked of it", () => {
  it("names what it would have carried", () => {
    const v = judgeTokenScope(evidence({ tokenClass: "classic" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/every project the account can reach/);
    // Refused on the prefix alone: there is no answer a probe could give that
    // would make an account-wide token safe in a tenant's repository.
    expect(v.checks.join(" ")).toMatch(/before any network call/);
  });

  it("refuses something that is not a Supabase token at all", () => {
    const v = judgeTokenScope(evidence({ tokenClass: "unrecognised" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not a Supabase personal access token/);
  });
});

describe("enumeration is the strong evidence", () => {
  it("accepts a token that sees this clone and nothing else", () => {
    const v = judgeTokenScope(evidence());
    expect(v.ok).toBe(true);
    expect(v.checks.join(" ")).toContain(CLONE);
  });

  it("refuses a token that can see any other project", () => {
    const v = judgeTokenScope(evidence({ visibleProjectRefs: [CLONE, "someoneelse1234"] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/besides this clone's/);
  });

  it("leads with the stranger when a token sees another project instead of this one", () => {
    // Both things are wrong with this token, and the order matters: "it can
    // reach somebody else's project" is the finding an operator must act on,
    // and "it cannot reach yours" is merely why it would not have worked.
    const v = judgeTokenScope(evidence({ visibleProjectRefs: ["someoneelse1234"] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/besides this clone's/);
  });

  it("refuses a token that sees nothing at all", () => {
    const v = judgeTokenScope(evidence({ visibleProjectRefs: [] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cannot reach this clone's project/);
  });
});

describe("the fallback proves less, and says so", () => {
  const noEnumeration = { visibleProjectRefs: null } as const;

  it("accepts when it reads the clone and not the prime, and discloses the limit", () => {
    const v = judgeTokenScope(evidence({ ...noEnumeration }));
    expect(v.ok).toBe(true);
    // It must not claim more than it proved: this shows confinement against
    // the prime, not against a third project nobody asked about.
    expect(v.reason).toMatch(/rather than against every project/);
  });

  it("refuses a token that can read the prime", () => {
    const v = judgeTokenScope(evidence({ ...noEnumeration, readsPrimeProject: true }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/can read the prime's project/);
  });
});

describe("absence of evidence is not evidence of confinement", () => {
  it("refuses when the prime probe did not answer", () => {
    // The failure this prevents: a network blip reads as "it could not reach
    // the prime", which is exactly what a correctly scoped token looks like.
    const v = judgeTokenScope(evidence({ visibleProjectRefs: null, readsPrimeProject: null }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unproven/);
  });

  it("refuses when the clone probe did not answer", () => {
    const v = judgeTokenScope(evidence({ visibleProjectRefs: null, readsCloneProject: null }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unproven/);
  });

  it("refuses when there is no prime project to check against", () => {
    const v = judgeTokenScope(evidence({ visibleProjectRefs: null, primeProjectRef: null }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/confinement cannot be proven/);
  });

  it("never accepts on a scoped prefix alone", () => {
    // Every unproven shape, at once: the prefix is the cheap half of the check
    // and must never be the whole of it.
    const v = judgeTokenScope({
      tokenClass: "scoped",
      cloneProjectRef: CLONE,
      visibleProjectRefs: null,
      readsCloneProject: null,
      readsPrimeProject: null,
      primeProjectRef: null,
    });
    expect(v.ok).toBe(false);
  });
});

describe("which route is in force", () => {
  it("reports Mission Control when it is declared and no token is present", () => {
    const r = deriveDeployRoute({
      hasAccessTokenSecret: false,
      deployerVariable: "mission-control",
      projectRefVariable: null,
      hasBackendProject: true,
    });
    expect(r.kind).toBe("mission_control");
    expect(r.detail).toMatch(/No Supabase token exists in this repository/);
  });

  it("reports the clone's CI when it holds a token and a target", () => {
    const r = deriveDeployRoute({
      hasAccessTokenSecret: true,
      deployerVariable: null,
      projectRefVariable: CLONE,
      hasBackendProject: true,
    });
    expect(r.kind).toBe("clone_ci");
    expect(r.detail).toContain(CLONE);
  });

  it("calls a token with no target incomplete rather than working", () => {
    // The workflow fails closed on a missing project ref, deliberately: a
    // default there once deployed a mirror's functions into the prime.
    const r = deriveDeployRoute({
      hasAccessTokenSecret: true,
      deployerVariable: null,
      projectRefVariable: null,
      hasBackendProject: true,
    });
    expect(r.kind).toBe("clone_ci_incomplete");
  });

  it("says nothing deploys it when nothing does", () => {
    const r = deriveDeployRoute({
      hasAccessTokenSecret: false,
      deployerVariable: null,
      projectRefVariable: null,
      hasBackendProject: true,
    });
    expect(r.kind).toBe("nobody");
    expect(r.detail).toMatch(/fails on every push/);
  });

  it("never reports 'nobody' from a failed read", () => {
    // A read that FAILED is not a repository that is EMPTY. This card would
    // otherwise cry wolf on every GitHub hiccup and be ignored when it mattered.
    const r = deriveDeployRoute({
      hasAccessTokenSecret: null,
      deployerVariable: null,
      projectRefVariable: null,
      hasBackendProject: true,
    });
    expect(r.kind).toBe("unknown");
  });

  it("does not claim Mission Control deploys a clone with no project", () => {
    const r = deriveDeployRoute({
      hasAccessTokenSecret: false,
      deployerVariable: "mission-control",
      projectRefVariable: null,
      hasBackendProject: false,
    });
    expect(r.kind).toBe("mission_control");
    expect(r.detail).toMatch(/no provisioned Supabase project/);
  });
});
