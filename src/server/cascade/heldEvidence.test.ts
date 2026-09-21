import { describe, it, expect } from "vitest";
import {
  decideHoldRelease,
  describeHoldReleases,
  holdReleaseSuffixFor,
  MAX_HOLD_RELEASE_PROBES,
  type HeldPathEvidence,
  type HoldRelease,
} from "./heldEvidence.pure";
import type { HeldPath } from "./syncExclusions.pure";

/**
 * Verbatim from the state this was written for: on the two September 2026
 * mirrors, `src/lib/clientFacing.ts` was byte-identical to the version prime
 * held at fa6bed0d — no clone work anywhere in it — while the seeded hold
 * described another repository's divergence and froze it forever.
 */
const CLIENT_FACING = "src/lib/clientFacing.ts";
const CLONE_BLOB = "e7bbbba0e7bbbba0e7bbbba0e7bbbba0e7bbbba0";
const OLDER_BLOB = "1111111111111111111111111111111111111111";
const PRIME_HEAD_BLOB = "2222222222222222222222222222222222222222";

const held = (over: Partial<HeldPath> = {}): HeldPath => ({
  path: CLIENT_FACING,
  pattern: CLIENT_FACING,
  reason: "manual_reconcile",
  note: "Clone hides a strict superset of prime's paths.",
  ...over,
});

const primeVersions = (versions: string[], versionsExhaustive = true): HeldPathEvidence => ({
  kind: "prime_versions",
  versions,
  versionsExhaustive,
});

describe("evidence releases a vacuous hold", () => {
  it("releases when the clone's blob is a version prime itself held", () => {
    const verdict = decideHoldRelease({
      held: held(),
      cloneSha: CLONE_BLOB,
      evidence: primeVersions([PRIME_HEAD_BLOB, CLONE_BLOB, OLDER_BLOB]),
      approved: false,
    });
    expect(verdict.act).toBe("release");
    if (verdict.act === "release") expect(verdict.basis).toBe("unedited");
  });

  it("holds when the clone's blob matches no prime version (edited here)", () => {
    const verdict = decideHoldRelease({
      held: held(),
      cloneSha: "feedfacefeedfacefeedfacefeedfacefeedface",
      evidence: primeVersions([PRIME_HEAD_BLOB, CLONE_BLOB]),
      approved: false,
    });
    expect(verdict.act).toBe("hold");
    if (verdict.act === "hold") expect(verdict.why).toContain("work done here");
  });

  it("holds when the walk ran out before the history did", () => {
    const verdict = decideHoldRelease({
      held: held(),
      cloneSha: "feedfacefeedfacefeedfacefeedfacefeedface",
      evidence: primeVersions([PRIME_HEAD_BLOB], false),
      approved: false,
    });
    expect(verdict.act).toBe("hold");
    if (verdict.act === "hold") expect(verdict.why).toContain("did not reach the beginning");
  });
});

describe("a failed read is not evidence", () => {
  it("holds on unsettled evidence and names the failure", () => {
    const verdict = decideHoldRelease({
      held: held(),
      cloneSha: CLONE_BLOB,
      evidence: { kind: "unsettled", why: "HTTP 502" },
      approved: false,
    });
    expect(verdict.act).toBe("hold");
    if (verdict.act === "hold") expect(verdict.why).toContain("HTTP 502");
  });

  it("holds when nothing was probed at all", () => {
    expect(
      decideHoldRelease({ held: held(), cloneSha: CLONE_BLOB, evidence: null, approved: false })
        .act,
    ).toBe("hold");
  });

  it("holds when prime has never touched the path", () => {
    expect(
      decideHoldRelease({
        held: held(),
        cloneSha: CLONE_BLOB,
        evidence: { kind: "never_primes" },
        approved: false,
      }).act,
    ).toBe("hold");
  });

  it("holds when the clone has no copy at the path", () => {
    expect(
      decideHoldRelease({
        held: held(),
        cloneSha: null,
        evidence: primeVersions([CLONE_BLOB]),
        approved: false,
      }).act,
    ).toBe("hold");
  });
});

describe("protected is never released", () => {
  const protectedHold = held({
    path: "src/integrations/supabase/env.ts",
    pattern: "src/integrations/supabase/env.ts",
    reason: "protected",
  });

  it("refuses on perfect evidence", () => {
    const verdict = decideHoldRelease({
      held: protectedHold,
      cloneSha: CLONE_BLOB,
      evidence: primeVersions([CLONE_BLOB]),
      approved: false,
    });
    expect(verdict.act).toBe("hold");
  });

  it("refuses even a recorded approval — an approval releases judgement, never identity", () => {
    const verdict = decideHoldRelease({
      held: protectedHold,
      cloneSha: CLONE_BLOB,
      evidence: primeVersions([CLONE_BLOB]),
      approved: true,
    });
    expect(verdict.act).toBe("hold");
    if (verdict.act === "hold") expect(verdict.why).toContain("identity");
  });
});

describe("an operator approval releases what evidence cannot", () => {
  it("releases an edited manual_reconcile path when approved", () => {
    // The App.tsx case: a hand-merged hybrid matches no prime version even
    // when every line of it is prime's, so only a person can decide.
    const verdict = decideHoldRelease({
      held: held({ path: "src/App.tsx", pattern: "src/App.tsx" }),
      cloneSha: "feedfacefeedfacefeedfacefeedfacefeedface",
      evidence: primeVersions([PRIME_HEAD_BLOB, CLONE_BLOB]),
      approved: true,
    });
    expect(verdict.act).toBe("release");
    if (verdict.act === "release") expect(verdict.basis).toBe("approved");
  });

  it("releases on approval even when the history was unreadable", () => {
    const verdict = decideHoldRelease({
      held: held(),
      cloneSha: null,
      evidence: { kind: "unsettled", why: "HTTP 502" },
      approved: true,
    });
    expect(verdict.act).toBe("release");
  });

  it("reads the approval before the missing copy, and holds without one", () => {
    // The two answer different questions, and the order below is the whole
    // statement of it. The evidence route asks whether this clone's copy is
    // unmodified prime content and with no copy cannot be asked; an approval
    // is a person deciding prime's copy should stand here, which on a path
    // the clone lacks reads as "create it" and loses nothing of this clone's.
    //
    // Pinned because the header claimed the opposite — that a missing copy
    // "always holds" — while this file had asserted a release since it was
    // written. A rule stated twice is how the two come to disagree.
    const missing = { held: held(), cloneSha: null, evidence: null };
    expect(decideHoldRelease({ ...missing, approved: true }).act).toBe("release");

    const unapproved = decideHoldRelease({ ...missing, approved: false });
    expect(unapproved.act).toBe("hold");
    if (unapproved.act === "hold") expect(unapproved.why).toContain("no copy at this path");
  });

  it("still refuses identity on a path the clone does not hold, approval or not", () => {
    // The guard that actually keeps a NEW file's arrival the content rules'
    // business is `protected`, not the missing copy — so it is the one that
    // has to survive an approval.
    const verdict = decideHoldRelease({
      held: held({ path: "src/integrations/supabase/env.ts", reason: "protected" }),
      cloneSha: null,
      evidence: null,
      approved: true,
    });
    expect(verdict.act).toBe("hold");
    if (verdict.act === "hold") expect(verdict.why).toContain("identity");
  });
});

describe("what a person reads", () => {
  const releases: HoldRelease[] = [
    {
      act: "release",
      path: CLIENT_FACING,
      basis: "unedited",
      why: "byte-identical to a version prime itself held",
    },
    { act: "release", path: "src/App.tsx", basis: "approved", why: "operator approval" },
    { act: "hold", path: "src/lib/other.ts", why: "edited here" },
  ];

  it("describes only the releases, naming the basis of each", () => {
    const body = describeHoldReleases(releases);
    expect(body).toContain(CLIENT_FACING);
    expect(body).toContain("released on evidence");
    expect(body).toContain("released by a recorded operator approval");
    expect(body).not.toContain("src/lib/other.ts");
  });

  it("counts only releases in the summary suffix, and says nothing for none", () => {
    expect(holdReleaseSuffixFor(releases)).toBe(" · 2 hold(s) released");
    expect(holdReleaseSuffixFor([{ act: "hold", path: "x", why: "y" }])).toBe("");
  });
});

describe("the probe ceiling exists and is small", () => {
  it("is bounded — overflow stays held, which is yesterday's behaviour", () => {
    expect(MAX_HOLD_RELEASE_PROBES).toBeGreaterThan(0);
    expect(MAX_HOLD_RELEASE_PROBES).toBeLessThanOrEqual(16);
  });
});
