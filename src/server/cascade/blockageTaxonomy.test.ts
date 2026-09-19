import { describe, expect, it } from "vitest";
import {
  BLOCKAGE_POLICY,
  CONSECUTIVE_FAILURE_FLOOR,
  DEFERRAL_CEILING_MINUTES,
  classifyBlockages,
  isInvocationCut,
  parsePrRepo,
  type BlockageClass,
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
  blockedNotice: null,
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
      blockedNotice: {
        title: "Cascade blocked · NPC Client Dashboard · PR #200",
        body: "Cascade PR #200 on NPC Client Dashboard is failing the same way on a rebuilt head — this does not clear on its own.\n\nNot merging — 1 check(s) failing: security (failure).\n\nThe proposal carries: Open",
        createdAt: ago(120),
      },
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
      blockedNotice: {
        title: "Cascade blocked · x · PR #1",
        body: "Not merging — 1 check(s) failing: verify (failure).",
        createdAt: ago(300),
      },
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
