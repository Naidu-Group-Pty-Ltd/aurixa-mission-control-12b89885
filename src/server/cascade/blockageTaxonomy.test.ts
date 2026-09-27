import { describe, expect, it } from "vitest";
import {
  BLOCKAGE_POLICY,
  CONSECUTIVE_FAILURE_FLOOR,
  DEFERRAL_CEILING_MINUTES,
  classifyBlockages,
  isInvocationCut,
  parsePrRepo,
  pullRequestKey,
  refusalFingerprint,
  refusalRepoElsewhere,
  standingRefusals,
  type BlockageClass,
  type BlockedNotice,
  type CloneBlockageFacts,
} from "./blockageTaxonomy.pure";
import { MAX_ATTEMPTS, STALL_MINUTES } from "./drainLimits.pure";

const NOW = new Date("2026-09-18T12:00:00Z");
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();

const facts = (over: Partial<CloneBlockageFacts> = {}): CloneBlockageFacts => ({
  cloneId: "c1",
  label: "NPC Client Dashboard",
  syncScope: "mirror",
  exclusionCount: 22,
  repoFullName: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
  convergence: { state: "converged", owedCount: 0, owedFingerprint: null, unchangedSince: null },
  openProposals: [],
  events: [],
  consecutiveFailures: 0,
  blockedNotices: [],
  primeLedgerHoles: [],
  sloMinutes: 90,
  ...over,
});

const ev = (over: Partial<CloneBlockageFacts["events"][number]> = {}) => ({
  id: "e1",
  status: "completed",
  attempts: 0,
  requiresApproval: false,
  approvedAt: null,
  nextAttemptAt: null,
  workerStartedAt: null,
  resultStatus: "succeeded",
  resultSummary: null,
  resultError: null,
  updatedAt: ago(10),
  ...over,
});

const classes = (f: CloneBlockageFacts) =>
  classifyBlockages(f, NOW)
    .map((b) => b.cls)
    .sort();

/**
 * A clone that is short of something.
 *
 * Most classes describe a delivery that went wrong, and the taxonomy
 * deliberately reports none of those against a CONVERGED clone — a later pass
 * supersedes a failed one entirely, so they are history. The tests for those
 * classes therefore have to start from a clone that is actually stalled.
 */
const stalled = (over: Partial<CloneBlockageFacts> = {}) =>
  facts({
    convergence: {
      state: "stalled",
      owedCount: 7,
      owedFingerprint: "7:beef",
      unchangedSince: ago(200),
    },
    ...over,
  });

describe("the policy table", () => {
  /*
    A proposal going red because prime shipped something the clone's checks
    refuse is the system working. Nothing retries it, rebuilds it hoping for a
    different answer, or merges it. This is pinned rather than trusted because
    the whole design turns on it.
  */
  it("ci_red can never be self-healing, and is nobody's but the author's", () => {
    expect(BLOCKAGE_POLICY.ci_red.selfHeals).toBe(false);
    expect(BLOCKAGE_POLICY.ci_red.owner).toBe("prime_author");
  });

  it("nothing a person must decide is ever self-healing", () => {
    for (const [cls, policy] of Object.entries(BLOCKAGE_POLICY)) {
      if (policy.owner !== "machinery") {
        expect(policy.selfHeals, `${cls} is owned by ${policy.owner} and must not self-heal`).toBe(
          false,
        );
      }
    }
  });

  it("every class carries an operator-readable line with no database vocabulary", () => {
    for (const [cls, policy] of Object.entries(BLOCKAGE_POLICY)) {
      expect(policy.what.length, cls).toBeGreaterThan(20);
      /* No snake_cased identifiers: the roster test's rule, applied again. */
      expect(policy.what, cls).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });

  it("unclassified is owned by a person and never heals itself", () => {
    expect(BLOCKAGE_POLICY.unclassified.owner).toBe("operator");
    expect(BLOCKAGE_POLICY.unclassified.selfHeals).toBe(false);
  });
});

describe("a converging clone is not blocked", () => {
  it("finds nothing on a healthy record", () => {
    expect(classifyBlockages(facts(), NOW)).toEqual([]);
  });

  it("finds nothing while a delivery is in flight inside the window", () => {
    const f = facts({
      convergence: {
        state: "delivering",
        owedCount: 12,
        owedFingerprint: "12:abc",
        unchangedSince: ago(20),
      },
      openProposals: [
        {
          resultId: "r1",
          prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/9",
          prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
          createdAt: ago(20),
        },
      ],
      events: [ev({ status: "running", workerStartedAt: ago(2), resultStatus: "pushing" })],
    });
    expect(classifyBlockages(f, NOW)).toEqual([]);
  });
});

describe("the 43-row fault", () => {
  /*
    Measured 18 Sep 2026: 43 rows recorded against lavan96/npc-client-dashboard
    while the clone's record reads Naidu-Group-Pty-Ltd/... The repository moved
    owners, the rows kept the old URL, and the drain has skipped them every
    five minutes for three weeks, silently.
  */
  it("names a proposal recorded against a repository the clone no longer has", () => {
    const f = facts({
      openProposals: [27, 28, 44].map((n) => ({
        resultId: `r${n}`,
        prUrl: `https://github.com/lavan96/npc-client-dashboard/pull/${n}`,
        prRepo: "lavan96/npc-client-dashboard",
        createdAt: ago(60 * 24 * 21),
      })),
    });
    const found = classifyBlockages(f, NOW);
    expect(found.map((b) => b.cls)).toEqual(["repo_retargeted"]);
    expect(found[0].detail).toContain("3 proposal record(s)");
    expect(found[0].detail).toContain("lavan96/npc-client-dashboard");
    /* One blockage for one wrong repository, not one per row. */
    expect(found[0].fingerprint).toBe("repo_retargeted:lavan96/npc-client-dashboard");
    expect(found[0].selfHeals).toBe(true);
  });

  it("a matching repository is not retargeted, however old", () => {
    const f = facts({
      openProposals: [
        {
          resultId: "r1",
          prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/9",
          prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
          createdAt: ago(60 * 24 * 21),
        },
      ],
    });
    expect(classes(f)).toEqual(["unreconciled_proposal"]);
  });

  it("is case-insensitive about the owner", () => {
    const f = facts({
      repoFullName: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
      openProposals: [
        {
          resultId: "r1",
          prUrl: "https://github.com/naidu-group-pty-ltd/npc-client-dashboard/pull/9",
          prRepo: "naidu-group-pty-ltd/npc-client-dashboard",
          createdAt: ago(10),
        },
      ],
    });
    expect(classes(f)).toEqual([]);
  });
});

describe("events that will never move again", () => {
  it("names a retired delivery", () => {
    const f = stalled({
      events: [ev({ status: "failed", attempts: MAX_ATTEMPTS, resultStatus: "queued" })],
    });
    const found = classifyBlockages(f, NOW);
    expect(found.map((b) => b.cls)).toEqual(["attempts_exhausted"]);
    expect(found[0].detail).toContain(`${MAX_ATTEMPTS} attempt(s)`);
  });

  it("a failure with attempts left is not exhausted", () => {
    const f = stalled({
      events: [ev({ status: "failed", attempts: MAX_ATTEMPTS - 1, resultStatus: "queued" })],
    });
    expect(classes(f)).toEqual(["unclassified"]);
  });

  /*
    `partial` is terminal: some clones landed, this one failed, and the record
    settled. Nothing retries this clone's part.
  */
  it("names a clone dropped by a partial delivery", () => {
    const f = stalled({ events: [ev({ status: "partial", resultStatus: "failed" })] });
    expect(classes(f)).toEqual(["partial_clone_dropped"]);
  });

  it("a partial that succeeded for this clone is not a blockage", () => {
    const f = stalled({ events: [ev({ status: "partial", resultStatus: "succeeded" })] });
    expect(classes(f)).toEqual(["unclassified"]);
  });

  it("names an unapproved gate, owned by a person", () => {
    const f = stalled({
      events: [ev({ status: "pending", requiresApproval: true, resultStatus: "queued" })],
    });
    const found = classifyBlockages(f, NOW);
    expect(found[0].cls).toBe("approval_pending");
    expect(found[0].owner).toBe("operator");
    expect(found[0].selfHeals).toBe(false);
  });

  it("an approved gate is not a blockage", () => {
    const f = stalled({
      events: [
        ev({
          status: "pending",
          requiresApproval: true,
          approvedAt: ago(5),
          resultStatus: "queued",
        }),
      ],
    });
    expect(classes(f)).toEqual(["unclassified"]);
  });

  it("names a deferral parked past any provider reset", () => {
    const far = new Date(NOW.getTime() + (DEFERRAL_CEILING_MINUTES + 30) * 60_000).toISOString();
    const f = stalled({
      events: [ev({ status: "pending", nextAttemptAt: far, resultStatus: "queued" })],
    });
    expect(classes(f)).toEqual(["deferred_far_future"]);
  });

  it("an ordinary rate-limit deferral is not a blockage", () => {
    const soon = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    const f = stalled({
      events: [ev({ status: "pending", nextAttemptAt: soon, resultStatus: "queued" })],
    });
    expect(classes(f)).toEqual(["unclassified"]);
  });

  it("names a claim stuck past the stall window", () => {
    const f = stalled({
      events: [
        ev({ status: "running", workerStartedAt: ago(STALL_MINUTES + 5), resultStatus: "pushing" }),
      ],
    });
    expect(classes(f)).toEqual(["event_stuck_running"]);
  });
});

describe("a pass that does not fit", () => {
  /*
    pg_net stops waiting at 60,000 ms and does not stop the isolate, so the
    row carries either the engine's own pause or the platform's abandonment
    message, depending which wrote first. Both are the same event.
  */
  it("recognises both halves of one event", () => {
    expect(
      isInvocationCut("Paused at the invocation budget — 483 of 597 file(s) prepared", null),
    ).toBe(true);
    expect(
      isInvocationCut(
        null,
        "Sorry, your request timed out.  It's likely that your input was too large",
      ),
    ).toBe(true);
    expect(isInvocationCut("Opened a pull request", null)).toBe(false);
  });

  it("is only a blockage while the clone still owes something", () => {
    const cut = ev({
      status: "failed",
      attempts: 1,
      resultStatus: "failed",
      resultError: "Sorry, your request timed out.",
    });
    /* Converged: the pass was cut and the work landed anyway. */
    expect(classes(facts({ events: [cut] }))).toEqual([]);
    /* And the gate, not just the owed-count guard, keeps it out. */
    expect(BLOCKAGE_POLICY.invocation_cut.conditionedOnDivergence).toBe(true);
    /* Still owed: the pass is not fitting. */
    const f = facts({
      events: [cut],
      convergence: {
        state: "stalled",
        owedCount: 300,
        owedFingerprint: "300:aaa",
        unchangedSince: ago(200),
      },
    });
    expect(classes(f)).toContain("invocation_cut");
  });
});

describe("failure that accumulates", () => {
  it("counts a run of failures as one standing condition", () => {
    const f = stalled({ consecutiveFailures: CONSECUTIVE_FAILURE_FLOOR });
    const found = classifyBlockages(f, NOW);
    expect(found.map((b) => b.cls)).toEqual(["consecutive_failures"]);
    expect(found[0].fingerprint).toBe("consecutive_failures");
  });

  it("stays quiet below the floor", () => {
    expect(classes(stalled({ consecutiveFailures: CONSECUTIVE_FAILURE_FLOOR - 1 }))).toEqual([
      "unclassified",
    ]);
  });
});

describe("the gate's verdict is read, never re-derived", () => {
  it("names the checks the drain said were failing", () => {
    const f = facts({
      convergence: {
        state: "stalled",
        owedCount: 40,
        owedFingerprint: "40:x",
        unchangedSince: ago(200),
      },
      blockedNotices: [
        {
          title: "Cascade blocked · NPC Client Dashboard · PR #200",
          body: "Cascade PR #200 on NPC Client Dashboard is failing the same way on a rebuilt head — this does not clear on its own.\n\nNot merging — 1 check(s) failing: security (failure).\n\nThe proposal carries: Open",
          createdAt: ago(120),
          prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/200",
        },
      ],
    });
    const found = classifyBlockages(f, NOW);
    expect(found.map((b) => b.cls)).toEqual(["ci_red"]);
    expect(found[0].detail).toContain("security (failure)");
    expect(found[0].owner).toBe("prime_author");
    expect(found[0].selfHeals).toBe(false);
    /* A real cause was found, so the unclassified rule must NOT also fire. */
    expect(found).toHaveLength(1);
  });
});

describe("a proposal the drain has refused is not an unreconciled one", () => {
  /*
    The reading on 27 Sep 2026: NPC Client Dashboard #264 carried `ci_red`
    AND `unreconciled_proposal`. The drain reads it every five minutes and
    refuses it on the same failing check — the unread notice is that read —
    so "its record is behind, the machinery will heal it" was false, about a
    failure only prime's author can clear.
  */
  const PR264 = "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264";
  const notice264: BlockedNotice = {
    title: "Cascade blocked · NPC Client Dashboard · PR #264",
    body: "Cascade PR #264 on NPC Client Dashboard is failing the same way on a rebuilt head — this does not clear on its own.\n\nNot merging — 1 check(s) failing: verify (failure).",
    createdAt: ago(60 * 14),
    prUrl: PR264,
  };
  const open264 = {
    resultId: "r264",
    prUrl: PR264,
    prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
    createdAt: ago(60 * 15),
  };

  it("reports the refusal alone, not a second finding about the same pull request", () => {
    const f = stalled({ openProposals: [open264], blockedNotices: [notice264] });
    expect(classes(f)).toEqual(["ci_red"]);
  });

  it("reproduces the double finding when the notice's pull request is not read", () => {
    // The shape before the ledger carried the notice's URL: the same facts,
    // with nothing saying which pull request the notice names.
    const f = stalled({ openProposals: [open264], blockedNotices: [{ ...notice264, prUrl: null }] });
    expect(classes(f)).toEqual(["ci_red", "unreconciled_proposal"]);
  });

  it("matches the pull request, not the spelling of its URL", () => {
    const f = stalled({
      openProposals: [open264],
      blockedNotices: [
        {
          ...notice264,
          prUrl: "https://github.com/naidu-group-pty-ltd/NPC-Client-Dashboard/pull/264/checks",
        },
      ],
    });
    expect(classes(f)).toEqual(["ci_red"]);
  });

  it("stands down for the refused pull request only — another stale proposal is still reported", () => {
    const stale = {
      resultId: "r250",
      prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/250",
      prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
      createdAt: ago(60 * 30),
    };
    const found = classifyBlockages(
      stalled({
        openProposals: [open264, stale],
        blockedNotices: [notice264],
      }),
      NOW,
    );
    expect(found.map((b) => b.fingerprint).sort()).toEqual([
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #264",
      `unreconciled_proposal:${stale.prUrl}`,
    ]);
  });

  it("the same number in another repository is another pull request", () => {
    const f = stalled({
      openProposals: [open264],
      blockedNotices: [
        { ...notice264, prUrl: "https://github.com/Naidu-Group-Pty-Ltd/preflight-property-group/pull/264" },
      ],
    });
    expect(classes(f)).toEqual(["ci_red", "unreconciled_proposal"]);
  });

  it("a proposal whose URL does not parse is never stood down by a notice", () => {
    const f = stalled({
      openProposals: [{ ...open264, prUrl: null, prRepo: null }],
      blockedNotices: [notice264],
    });
    expect(classes(f)).toEqual(["ci_red", "unreconciled_proposal"]);
  });

  it("on a converged clone the refused proposal is history, like the refusal itself", () => {
    // `ci_red` is conditioned on divergence and drops against a converged
    // clone; the proposal it explains is the same history, not a standing
    // fault left over for somebody to chase.
    const f = facts({ openProposals: [open264], blockedNotices: [notice264] });
    expect(classifyBlockages(f, NOW)).toEqual([]);
  });

  it("still reports a proposal nobody has refused and nothing has reconciled", () => {
    // A proposal whose checks never report raises no notice at all; the stale
    // record is then the only trace, and it must stay.
    const f = facts({ openProposals: [open264] });
    expect(classes(f)).toEqual(["unreconciled_proposal"]);
  });
});

describe("every refused pull request keeps its own finding", () => {
  /*
    Codex's reading of the first cut: the ledger kept the NEWEST notice per
    clone for `ci_red` while every notice's URL stood `unreconciled_proposal`
    down, so a clone with two refused pull requests reported the newest and
    said nothing at all about the older one. One finding each, now.
  */
  const url = (n: number) => `https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/${n}`;
  const notice = (n: number, minsAgo: number, why = "verify (failure)"): BlockedNotice => ({
    title: `Cascade blocked · NPC Client Dashboard · PR #${n}`,
    body: `Cascade PR #${n} on NPC Client Dashboard is failing the same way on a rebuilt head — this does not clear on its own.\n\nNot merging — 1 check(s) failing: ${why}.`,
    createdAt: ago(minsAgo),
    prUrl: url(n),
  });
  const proposal = (n: number, minsAgo: number) => ({
    resultId: `r${n}`,
    prUrl: url(n),
    prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard",
    createdAt: ago(minsAgo),
  });

  it("two refused pull requests are two ci_red findings, and neither is called unreconciled", () => {
    const found = classifyBlockages(
      stalled({
        openProposals: [proposal(250, 60 * 40), proposal(264, 60 * 15)],
        // Newest first, as the ledger reads them.
        blockedNotices: [notice(264, 60 * 14), notice(250, 60 * 30)],
      }),
      NOW,
    );
    expect(found.map((b) => b.fingerprint).sort()).toEqual([
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #250",
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #264",
    ]);
    expect(found.every((b) => b.owner === "prime_author" && !b.selfHeals)).toBe(true);
  });

  it("every proposal the refusals stand down is named by a ci_red finding", () => {
    const notices = [notice(264, 60), notice(250, 120), notice(233, 240)];
    const found = classifyBlockages(
      stalled({
        openProposals: [proposal(233, 60 * 50), proposal(250, 60 * 40), proposal(264, 60 * 30)],
        blockedNotices: notices,
      }),
      NOW,
    );
    const ciRed = found.filter((b) => b.cls === "ci_red").map((b) => b.fingerprint);
    for (const n of [233, 250, 264]) {
      expect(ciRed).toContain(`ci_red:Cascade blocked · NPC Client Dashboard · PR #${n}`);
    }
    expect(found.some((b) => b.cls === "unreconciled_proposal")).toBe(false);
  });

  it("one pull request refused twice is one finding, carrying the newest verdict and the first refusal's start", () => {
    const found = classifyBlockages(
      stalled({
        openProposals: [proposal(264, 60 * 15)],
        // The failure changed shape, so the drain raised a second notice and
        // left the first unread. Given oldest first on purpose: the order the
        // facts arrive in must not decide which verdict is current.
        blockedNotices: [notice(264, 60 * 14, "security (failure)"), notice(264, 30, "verify (failure)")],
      }),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0].cls).toBe("ci_red");
    expect(found[0].detail).toContain("verify (failure)");
    expect(found[0].detail).not.toContain("security (failure)");
    // Refused since the first unread notice, whichever verdict is current.
    expect(found[0].since).toBe(ago(60 * 14));
  });

  it("a notice with no URL and one with a URL for the same pull request open one row, not two", () => {
    const found = classifyBlockages(
      stalled({
        openProposals: [proposal(264, 60 * 15)],
        blockedNotices: [notice(264, 30), { ...notice(264, 60 * 14), prUrl: null }],
      }),
      NOW,
    );
    expect(found.map((b) => b.fingerprint)).toEqual([
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #264",
    ]);
  });
});

describe("a refusal in another repository is its own finding", () => {
  /*
    Codex's reading of the fingerprint guard: the title names the clone and
    the pull request's NUMBER, and a clone re-pointed since still holds
    unread notices from its old repository — the drain can judge only the
    clone's own, so it leaves them. The old repository's #42 and the new
    one's #42 had one title, so the guard reported one and dropped the other.
  */
  const own = "Naidu-Group-Pty-Ltd/npc-client-dashboard";
  const old = "Naidu-Group-Pty-Ltd/npc-client-dashboard-legacy";
  const refusal = (repo: string, n: number, minsAgo: number): BlockedNotice => ({
    title: `Cascade blocked · NPC Client Dashboard · PR #${n}`,
    body: `Cascade PR #${n} on NPC Client Dashboard is failing the same way on a rebuilt head.\n\nNot merging.`,
    createdAt: ago(minsAgo),
    prUrl: `https://github.com/${repo}/pull/${n}`,
  });

  it("one number in two repositories is two ci_red findings", () => {
    const found = classifyBlockages(
      stalled({ blockedNotices: [refusal(own, 42, 30), refusal(old, 42, 60 * 24 * 9)] }),
      NOW,
    );
    expect(found.map((b) => b.fingerprint).sort()).toEqual([
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #42",
      "ci_red:Cascade blocked · NPC Client Dashboard · PR #42 · naidu-group-pty-ltd/npc-client-dashboard-legacy",
    ]);
    expect(found.every((b) => b.cls === "ci_red")).toBe(true);
  });

  it("says where the other repository's refusal is, and why it stands", () => {
    const found = classifyBlockages(stalled({ blockedNotices: [refusal(old, 42, 90)] }), NOW);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain(`This pull request is in ${old}, which NPC Client Dashboard no longer cascades to`);
    expect(found[0].detail).toContain("Not merging.");
  });

  /*
    The rows already open carry the title as their identity. A refusal in the
    clone's own repository must keep it byte for byte, or the first pass after
    this ships would clear every standing ci_red row and open it again with
    today as its start.
  */
  it("a refusal in the clone's own repository keeps the fingerprint it has always had", () => {
    for (const repo of [own, own.toLowerCase(), own.toUpperCase()]) {
      const found = classifyBlockages(stalled({ blockedNotices: [refusal(repo, 264, 30)] }), NOW);
      expect(found.map((b) => b.fingerprint), repo).toEqual([
        "ci_red:Cascade blocked · NPC Client Dashboard · PR #264",
      ]);
      expect(found[0].detail.startsWith("Cascade PR #264")).toBe(true);
    }
  });
});

describe("refusalFingerprint", () => {
  const r = (prUrl: string | null): BlockedNotice => ({
    title: "Cascade blocked · X · PR #7",
    body: "",
    createdAt: "2026-09-27T00:00:00Z",
    prUrl,
  });

  it("is the title for the clone's own repository, compared without case", () => {
    expect(refusalFingerprint(r("https://github.com/O/R/pull/7"), "o/r")).toBe("ci_red:Cascade blocked · X · PR #7");
    expect(refusalRepoElsewhere(r("https://github.com/O/R/pull/7"), "o/r")).toBeNull();
  });

  it("names the repository for any other", () => {
    expect(refusalFingerprint(r("https://github.com/O/Old/pull/7"), "o/r")).toBe(
      "ci_red:Cascade blocked · X · PR #7 · o/old",
    );
    expect(refusalRepoElsewhere(r("https://github.com/O/Old/pull/7"), "o/r")).toBe("O/Old");
  });

  it("names the repository when the clone record names none", () => {
    expect(refusalFingerprint(r("https://github.com/o/r/pull/7"), null)).toBe("ci_red:Cascade blocked · X · PR #7 · o/r");
  });

  it("is the title when the URL does not parse, since nothing else names the repository", () => {
    for (const url of [null, "", "https://github.com/o/r/issues/7"]) {
      expect(refusalFingerprint(r(url), "o/r")).toBe("ci_red:Cascade blocked · X · PR #7");
      expect(refusalRepoElsewhere(r(url), "o/r")).toBeNull();
    }
  });
});

describe("the classifier never reports one identity twice", () => {
  /*
    The ledger keys its open set on the fingerprint. Two detections with one
    fingerprint open two rows, and every later pass sees only one of them —
    the other would stand open for ever.
  */
  it("two open records of one pull request are one unreconciled finding", () => {
    const pr = "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/250";
    const found = classifyBlockages(
      facts({
        openProposals: [
          { resultId: "rA", prUrl: pr, prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard", createdAt: ago(600) },
          { resultId: "rB", prUrl: pr, prRepo: "Naidu-Group-Pty-Ltd/npc-client-dashboard", createdAt: ago(300) },
        ],
      }),
      NOW,
    );
    expect(found.map((b) => b.fingerprint)).toEqual([`unreconciled_proposal:${pr}`]);
  });

  /*
    Codex's reading of the first-wins guard: the facts list repeats in no
    particular order, so keeping whichever came first could date a row from
    its NEWER evidence. A repeated identity dates from the earliest.
  */
  it("two open records of one pull request date from the older, whichever is listed first", () => {
    const pr = "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/250";
    const repo = "Naidu-Group-Pty-Ltd/npc-client-dashboard";
    for (const order of ["newer first", "older first"] as const) {
      const newer = { resultId: "rB", prUrl: pr, prRepo: repo, createdAt: ago(300) };
      const older = { resultId: "rA", prUrl: pr, prRepo: repo, createdAt: ago(600) };
      const found = classifyBlockages(
        facts({ openProposals: order === "newer first" ? [newer, older] : [older, newer] }),
        NOW,
      );
      expect(found, order).toHaveLength(1);
      expect(found[0].since, order).toBe(ago(600));
      // Its words name the same start, rather than contradicting it.
      expect(found[0].detail, order).toContain(ago(600));
    }
  });

  it("a notice with no URL older than one with a URL: one row, dated from the older", () => {
    const found = classifyBlockages(
      stalled({
        blockedNotices: [
          {
            title: "Cascade blocked · NPC Client Dashboard · PR #9",
            body: "Newest verdict.",
            createdAt: ago(10),
            prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/9",
          },
          {
            title: "Cascade blocked · NPC Client Dashboard · PR #9",
            body: "Older verdict.",
            createdAt: ago(900),
            prUrl: null,
          },
        ],
      }),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0].since).toBe(ago(900));
    expect(found[0].detail).toContain("Newest verdict.");
  });

  it("an unreadable start never displaces a readable one", () => {
    const pr = "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/250";
    const repo = "Naidu-Group-Pty-Ltd/npc-client-dashboard";
    const found = classifyBlockages(
      facts({
        openProposals: [
          { resultId: "rA", prUrl: pr, prRepo: repo, createdAt: ago(600) },
          { resultId: "rB", prUrl: pr, prRepo: repo, createdAt: "not a date" },
        ],
      }),
      NOW,
    );
    expect(found.map((b) => b.since)).toEqual([ago(600)]);
  });

  it("no fingerprint repeats across a busy clone", () => {
    const found = classifyBlockages(
      stalled({
        exclusionCount: 0,
        blockedNotices: [
          {
            title: "Cascade blocked · NPC Client Dashboard · PR #9",
            body: "Not merging.",
            createdAt: ago(10),
            prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/9",
          },
          {
            title: "Cascade blocked · NPC Client Dashboard · PR #9",
            body: "Not merging, again.",
            createdAt: ago(5),
            prUrl: null,
          },
        ],
        primeLedgerHoles: [
          { version: "20261219040000", heldCount: 2, firstHeld: "20261219050000" },
        ],
      }),
      NOW,
    );
    const fps = found.map((b) => b.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});

describe("standingRefusals", () => {
  const n = (pr: number | null, createdAt: string, title = `Cascade blocked · X · PR #${pr}`): BlockedNotice => ({
    title,
    body: "",
    createdAt,
    prUrl: pr === null ? null : `https://github.com/o/r/pull/${pr}`,
  });

  it("keeps the newest notice per pull request, newest first, whatever order it is given", () => {
    const a = n(1, "2026-09-27T01:00:00Z");
    const b = n(2, "2026-09-27T02:00:00Z");
    const c = n(1, "2026-09-27T03:00:00Z");
    for (const input of [[a, b, c], [c, b, a], [b, a, c]]) {
      expect(standingRefusals(input)).toEqual([c, b]);
    }
  });

  it("keys a notice with no URL on its title, so it still counts once", () => {
    const x = n(null, "2026-09-27T01:00:00Z", "Cascade blocked · X · PR #7");
    const y = n(null, "2026-09-27T02:00:00Z", "Cascade blocked · X · PR #7");
    const z = n(null, "2026-09-27T03:00:00Z", "Cascade blocked · X · PR #8");
    expect(standingRefusals([x, y, z])).toEqual([z, y]);
  });

  it("an unreadable date sorts last rather than breaking the order", () => {
    const good = n(1, "2026-09-27T01:00:00Z");
    const bad = n(2, "not a date");
    expect(standingRefusals([bad, good])).toEqual([good, bad]);
  });

  it("nothing to stand on is nothing", () => {
    expect(standingRefusals([])).toEqual([]);
  });
});

describe("pullRequestKey", () => {
  it("names one pull request however the URL is written", () => {
    const key = "naidu-group-pty-ltd/npc-client-dashboard#264";
    for (const url of [
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264",
      "https://github.com/naidu-group-pty-ltd/npc-client-dashboard/pull/264/",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264/files",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264?w=1",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264#issuecomment-1",
    ]) {
      expect(pullRequestKey(url), url).toBe(key);
    }
  });

  it("returns null rather than guessing", () => {
    for (const url of [
      null,
      "",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/issues/264",
      "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/264abc",
    ]) {
      expect(pullRequestKey(url)).toBeNull();
    }
  });

  it("keeps two pull requests two", () => {
    expect(pullRequestKey("https://github.com/o/r/pull/26")).not.toBe(
      pullRequestKey("https://github.com/o/r/pull/264"),
    );
  });
});

describe("the rule that makes an incomplete taxonomy sound", () => {
  /*
    The auditor says this clone is not converging. If nothing else can say
    why, the absence IS the finding — owned by a person, never self-healed,
    and named as a gap rather than left as silence.
  */
  it("reports a stall nothing explains, as its own finding", () => {
    const f = facts({
      convergence: {
        state: "stalled",
        owedCount: 7,
        owedFingerprint: "7:beef",
        unchangedSince: ago(200),
      },
    });
    const found = classifyBlockages(f, NOW);
    expect(found.map((b) => b.cls)).toEqual(["unclassified"]);
    expect(found[0].owner).toBe("operator");
    expect(found[0].selfHeals).toBe(false);
    expect(found[0].detail).toContain("no known condition explains it");
  });

  it("reports a clone falling behind that nothing explains", () => {
    const f = facts({
      convergence: {
        state: "falling_behind",
        owedCount: 300,
        owedFingerprint: "300:c0de",
        unchangedSince: ago(30),
      },
    });
    expect(classes(f)).toEqual(["unclassified"]);
  });

  it("never fires when something else already explained it", () => {
    const f = facts({
      convergence: {
        state: "stalled",
        owedCount: 7,
        owedFingerprint: "7:beef",
        unchangedSince: ago(200),
      },
      events: [ev({ status: "failed", attempts: MAX_ATTEMPTS, resultStatus: "queued" })],
    });
    expect(classes(f)).toEqual(["attempts_exhausted"]);
  });

  /*
    Delivering is not a stall. A clone inside its window with nothing else
    wrong must produce no finding at all — this is the 1,253-false-alarm rule
    holding one layer up.
  */
  it("never fires on a clone that is merely delivering", () => {
    const f = facts({
      convergence: {
        state: "delivering",
        owedCount: 7,
        owedFingerprint: "7:beef",
        unchangedSince: ago(5),
      },
    });
    expect(classes(f)).toEqual([]);
  });

  it("never fires when the auditor could not read the clone", () => {
    const f = facts({
      convergence: { state: "unknown", owedCount: 0, owedFingerprint: null, unchangedSince: null },
    });
    expect(classes(f)).toEqual([]);
  });
});

describe("parsePrRepo", () => {
  it("reads owner and repo out of a pull request URL", () => {
    expect(parsePrRepo("https://github.com/lavan96/npc-client-dashboard/pull/27")).toBe(
      "lavan96/npc-client-dashboard",
    );
  });

  it("answers null rather than guessing", () => {
    expect(parsePrRepo(null)).toBeNull();
    expect(parsePrRepo("https://example.com/not-a-pr")).toBeNull();
  });
});

describe("several conditions at once", () => {
  it("reports each one separately rather than picking a winner", () => {
    const f = stalled({
      syncScope: "mirror",
      exclusionCount: 0,
      consecutiveFailures: CONSECUTIVE_FAILURE_FLOOR + 2,
      events: [
        ev({ id: "e1", status: "failed", attempts: MAX_ATTEMPTS, resultStatus: "queued" }),
        ev({ id: "e2", status: "pending", requiresApproval: true, resultStatus: "queued" }),
      ],
    });
    expect(classes(f)).toEqual([
      "approval_pending",
      "attempts_exhausted",
      "consecutive_failures",
      "policy_unseeded",
    ]);
    /* Two events of the same class stay two findings, keyed by event. */
    const ids = classifyBlockages(f, NOW).map((b) => b.fingerprint);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the class list and the policy table cannot drift", () => {
  it("every class has a policy", () => {
    const declared: BlockageClass[] = [
      "policy_unseeded",
      "repo_retargeted",
      "unreconciled_proposal",
      "attempts_exhausted",
      "partial_clone_dropped",
      "approval_pending",
      "deferred_far_future",
      "event_stuck_running",
      "invocation_cut",
      "consecutive_failures",
      "ci_red",
      "prime_ledger_hole",
      "unclassified",
    ];
    expect(Object.keys(BLOCKAGE_POLICY).sort()).toEqual([...declared].sort());
  });
});

describe("a delivery that went wrong costs nothing once the clone holds everything", () => {
  /*
    A commit cascade delivers prime's head at run time, so a later pass
    supersedes a failed one entirely. Reporting retired events against a
    converged clone would fill a list of open problems with history — which is
    how the notification channel came to hold 2,459 unread rows.
  */
  it("reports no delivery failure against a converged clone", () => {
    const f = facts({
      convergence: {
        state: "converged",
        owedCount: 0,
        owedFingerprint: null,
        unchangedSince: null,
      },
      consecutiveFailures: CONSECUTIVE_FAILURE_FLOOR + 5,
      events: [
        ev({ id: "e1", status: "failed", attempts: MAX_ATTEMPTS, resultStatus: "queued" }),
        ev({ id: "e2", status: "partial", resultStatus: "failed" }),
        ev({ id: "e3", status: "pending", requiresApproval: true, resultStatus: "queued" }),
        ev({
          id: "e4",
          status: "running",
          workerStartedAt: ago(STALL_MINUTES + 5),
          resultStatus: "pushing",
        }),
      ],
      blockedNotices: [
        {
          title: "Cascade blocked · x · PR #1",
          body: "Not merging — 1 check(s) failing: verify (failure).",
          createdAt: ago(300),
          prUrl: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/1",
        },
      ],
    });
    expect(classifyBlockages(f, NOW)).toEqual([]);
  });

  /*
    The standing faults are exempt: they are wrong right now whatever today's
    convergence says, and will be wrong for the next cascade too. This is the
    43-row fault — the clone is converged and those records are still a lie.
  */
  it("still reports a standing fault against a converged clone", () => {
    const f = facts({
      convergence: {
        state: "converged",
        owedCount: 0,
        owedFingerprint: null,
        unchangedSince: null,
      },
      exclusionCount: 0,
      openProposals: [
        {
          resultId: "r27",
          prUrl: "https://github.com/lavan96/npc-client-dashboard/pull/27",
          prRepo: "lavan96/npc-client-dashboard",
          createdAt: ago(60 * 24 * 21),
        },
      ],
    });
    /* One row, one blockage, and the SPECIFIC one: a proposal recorded against
       the wrong repository is not additionally reported as merely stale. The
       remedy differs, and two findings about one row is how a list of open
       problems doubles in length without gaining information. */
    expect(classes(f)).toEqual(["policy_unseeded", "repo_retargeted"]);
  });

  it("the standing faults are exactly the four that survive convergence", () => {
    const standing = Object.entries(BLOCKAGE_POLICY)
      .filter(([, p]) => !p.conditionedOnDivergence)
      .map(([cls]) => cls)
      .sort();
    // `prime_ledger_hole` joins them for the same reason as the other three:
    // it is wrong right now whatever today's convergence says, and it will
    // hold the NEXT migration too. A clone that happens to be level today is
    // still one the prime cannot advance tomorrow.
    expect(standing).toEqual([
      "policy_unseeded",
      "prime_ledger_hole",
      "repo_retargeted",
      "unreconciled_proposal",
    ]);
  });
});

describe("a migration the prime merged and never ran", () => {
  /** The measured reading on npc-client-dashboard, 19 Sep 2026. */
  const heldBehindBuilderRanking = facts({
    syncScope: "scoped",
    exclusionCount: 22,
    primeLedgerHoles: [
      {
        version: "20261202090000",
        heldCount: 3,
        firstHeld: "20261203000000_seed_template_library_v14_tier_separation.sql",
      },
    ],
  });

  it("reports the hole against a clone nothing else says is blocked", () => {
    // Both affected clones read `status: ready` with `migration_blocked_at`
    // NULL and a converged auditor reading. That is the state this class
    // exists to make visible.
    expect(classes(heldBehindBuilderRanking)).toEqual(["prime_ledger_hole"]);
  });

  it("names the prime version, the count behind it, and who clears it", () => {
    const [found] = classifyBlockages(heldBehindBuilderRanking, NOW);
    expect(found.detail).toContain("20261202090000");
    expect(found.detail).toContain("3 migration(s) wait behind it");
    expect(found.detail).toContain("20261203000000_seed_template_library_v14_tier_separation.sql");
    // The remedy is on the prime and it is a person's. The one thing an
    // operator must not be invited to do is stamp the ledger instead.
    expect(found.detail).toContain("prime runs that file");
    expect(found.owner).toBe("operator");
    expect(found.selfHeals).toBe(false);
  });

  it("is one blockage per hole, never one per migration held behind it", () => {
    // Three held migrations behind one unapplied file is one condition with
    // one remedy. Three rows would be three findings about the same file.
    expect(classifyBlockages(heldBehindBuilderRanking, NOW)).toHaveLength(1);
  });

  it("fingerprints on the version, so it is stable across passes and clears itself", () => {
    const [found] = classifyBlockages(heldBehindBuilderRanking, NOW);
    expect(found.fingerprint).toBe("prime_ledger_hole:20261202090000");
    // Same hole, a later pass, one more migration piled up behind it: the
    // same row, not a second one.
    const later = classifyBlockages(
      facts({
        syncScope: "scoped",
        primeLedgerHoles: [{ version: "20261202090000", heldCount: 4, firstHeld: "x.sql" }],
      }),
      NOW,
    );
    expect(later[0].fingerprint).toBe(found.fingerprint);
  });

  it("separates two holes, because they are two files to dispatch", () => {
    const two = classifyBlockages(
      facts({
        syncScope: "scoped",
        primeLedgerHoles: [
          { version: "20261202090000", heldCount: 3, firstHeld: "a.sql" },
          { version: "20261204000000", heldCount: 1, firstHeld: "b.sql" },
        ],
      }),
      NOW,
    );
    expect(two.map((b) => b.fingerprint)).toEqual([
      "prime_ledger_hole:20261202090000",
      "prime_ledger_hole:20261204000000",
    ]);
  });

  it("says nothing about a clone whose last pass was held behind nothing", () => {
    expect(classes(facts({ syncScope: "scoped" }))).toEqual([]);
  });
});
