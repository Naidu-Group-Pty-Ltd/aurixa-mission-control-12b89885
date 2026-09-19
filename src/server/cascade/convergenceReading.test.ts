import { describe, expect, it } from "vitest";
import {
  AUDIT_CADENCE_MINUTES,
  CONVERGENCE_ATTENTION_STATES,
  compareToLedger,
  convergenceNeedsAttention,
  MISSED_PASSES_BEFORE_STALE,
  READING_STALE_AFTER_MINUTES,
  readConvergenceForCard,
  type ObservationRow,
} from "./convergenceReading.pure";
import {
  AGREEMENT_NOTE,
  BLOCKAGE_OWNER_LABEL,
  CONVERGENCE_LABEL,
  CONVERGENCE_MEANING,
} from "@/lib/convergenceLabels";
import type { ConvergenceState } from "./convergence.pure";
import { BLOCKAGE_POLICY, type BlockageOwner } from "./blockageTaxonomy.pure";

const NOW = new Date("2026-09-18T15:00:00.000Z");

function obs(over: Partial<ObservationRow> = {}): ObservationRow {
  return {
    observedAt: "2026-09-18T14:52:00.000Z",
    state: "converged",
    owedCount: 0,
    heldCount: 7,
    oversizeHeld: 2,
    comparedCount: 8463,
    deletionCandidates: 2,
    owedSample: [],
    unchangedSince: null,
    lastConvergedAt: "2026-09-18T14:52:00.000Z",
    sloMinutes: 90,
    why: null,
    ...over,
  };
}

describe("compareToLedger", () => {
  it("names the pointer optimistic when the trees still differ and it reads level", () => {
    expect(
      compareToLedger({
        state: "stalled",
        owed: 12,
        ledger: { syncStatus: "in_sync", commitsBehind: 0 },
      }),
    ).toBe("ledger_optimistic");
  });

  it("names the pointer pessimistic when nothing is owed and it still reads behind", () => {
    expect(
      compareToLedger({
        state: "converged",
        owed: 0,
        ledger: { syncStatus: "drifted", commitsBehind: 4 },
      }),
    ).toBe("ledger_pessimistic");
  });

  it("agrees when both say level", () => {
    expect(
      compareToLedger({
        state: "converged",
        owed: 0,
        ledger: { syncStatus: "in_sync", commitsBehind: 0 },
      }),
    ).toBe("agree");
  });

  it("agrees when both say short, whatever the magnitudes", () => {
    // One commit can touch two hundred files and two hundred commits can touch
    // one. Only the direction is comparable, and a magnitude comparison here
    // would manufacture a contradiction out of two correct readings.
    expect(
      compareToLedger({
        state: "delivering",
        owed: 431,
        ledger: { syncStatus: "drifted", commitsBehind: 1 },
      }),
    ).toBe("agree");
    expect(
      compareToLedger({
        state: "delivering",
        owed: 1,
        ledger: { syncStatus: "drifted", commitsBehind: 118 },
      }),
    ).toBe("agree");
  });

  it("an unknown measurement contradicts nothing", () => {
    expect(
      compareToLedger({
        state: "unknown",
        owed: 0,
        ledger: { syncStatus: "drifted", commitsBehind: 9 },
      }),
    ).toBe("not_comparable");
  });

  it("a pointer nobody has written is not a disagreeing opinion", () => {
    expect(
      compareToLedger({
        state: "stalled",
        owed: 3,
        ledger: { syncStatus: null, commitsBehind: null },
      }),
    ).toBe("not_comparable");
  });

  it("reads `drifted` as behind even where the count is zero", () => {
    expect(
      compareToLedger({
        state: "converged",
        owed: 0,
        ledger: { syncStatus: "drifted", commitsBehind: 0 },
      }),
    ).toBe("ledger_pessimistic");
  });
});

describe("readConvergenceForCard", () => {
  it("an absent observation is never_measured, never converged", () => {
    const r = readConvergenceForCard({
      now: NOW,
      observation: null,
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    expect(r.kind).toBe("never_measured");
    // The trap: an empty read is not a clean bill of health.
    expect(JSON.stringify(r)).not.toContain("converged");
  });

  it("carries the measurement through unedited", () => {
    const r = readConvergenceForCard({
      now: NOW,
      observation: obs({ owedCount: 0, comparedCount: 8463, heldCount: 7, oversizeHeld: 2 }),
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    if (r.kind !== "measured") throw new Error("expected measured");
    expect(r.owed).toBe(0);
    expect(r.compared).toBe(8463);
    expect(r.held).toBe(7);
    expect(r.oversizeHeld).toBe(2);
    expect(r.agreement).toBe("agree");
  });

  it("is current inside the staleness window and not current outside it", () => {
    const fresh = readConvergenceForCard({
      now: NOW,
      observation: obs({
        observedAt: new Date(NOW.getTime() - READING_STALE_AFTER_MINUTES * 60_000).toISOString(),
      }),
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    const stale = readConvergenceForCard({
      now: NOW,
      observation: obs({
        observedAt: new Date(
          NOW.getTime() - (READING_STALE_AFTER_MINUTES + 1) * 60_000,
        ).toISOString(),
      }),
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    if (fresh.kind !== "measured" || stale.kind !== "measured")
      throw new Error("expected measured");
    expect(fresh.current).toBe(true);
    expect(stale.current).toBe(false);
  });

  it("a stale reading keeps its state rather than being withheld", () => {
    // Hiding the last reading because it is old leaves the card saying nothing
    // at the exact moment the audit has stopped running, which is when an
    // operator most needs to be told what was last true and when.
    const r = readConvergenceForCard({
      now: NOW,
      observation: obs({ state: "stalled", owedCount: 12, observedAt: "2026-09-18T09:00:00.000Z" }),
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    if (r.kind !== "measured") throw new Error("expected measured");
    expect(r.current).toBe(false);
    expect(r.state).toBe("stalled");
    expect(r.ageMinutes).toBe(360);
  });

  it("measures how long the current owed set has stood", () => {
    const r = readConvergenceForCard({
      now: NOW,
      observation: obs({
        state: "stalled",
        owedCount: 5,
        unchangedSince: "2026-09-18T11:30:00.000Z",
        sloMinutes: 90,
      }),
      ledger: { syncStatus: "drifted", commitsBehind: 3 },
    });
    if (r.kind !== "measured") throw new Error("expected measured");
    expect(r.unchangedMinutes).toBe(210);
    expect(r.sloMinutes).toBe(90);
  });

  it("carries the auditor's own words for an unknown rather than inventing a reason", () => {
    const r = readConvergenceForCard({
      now: NOW,
      observation: obs({ state: "unknown", why: "clone tree read was truncated" }),
      ledger: { syncStatus: "in_sync", commitsBehind: 0 },
    });
    if (r.kind !== "measured") throw new Error("expected measured");
    expect(r.why).toBe("clone tree read was truncated");
    expect(r.needsAttention).toBe(false);
    expect(r.agreement).toBe("not_comparable");
  });
});

describe("what the card is allowed to alarm on", () => {
  it("alarms on stalled and falling behind, and on nothing else", () => {
    expect(convergenceNeedsAttention("stalled")).toBe(true);
    expect(convergenceNeedsAttention("falling_behind")).toBe(true);
    expect(convergenceNeedsAttention("converged")).toBe(false);
    expect(convergenceNeedsAttention("delivering")).toBe(false);
  });

  it("never alarms on unknown — 'we could not check' is not 'you have a problem'", () => {
    expect(convergenceNeedsAttention("unknown")).toBe(false);
    expect(CONVERGENCE_ATTENTION_STATES.has("unknown")).toBe(false);
  });
});

describe("what reaches an operator's eye", () => {
  const states: ConvergenceState[] = [
    "converged",
    "delivering",
    "stalled",
    "falling_behind",
    "unknown",
  ];

  it("every state has a label and a meaning", () => {
    for (const s of states) {
      expect(CONVERGENCE_LABEL[s]?.length).toBeGreaterThan(0);
      expect(CONVERGENCE_MEANING[s]?.length).toBeGreaterThan(0);
    }
  });

  it("the vocabulary covers exactly the states the judgement can produce", () => {
    // The words live in `lib` (the client may not import a server value) and
    // the states live beside the judgement. That seam is where the two would
    // drift, so it is the seam the test stands on.
    expect(Object.keys(CONVERGENCE_LABEL).sort()).toEqual([...states].sort());
    expect(Object.keys(CONVERGENCE_MEANING).sort()).toEqual([...states].sort());
    // Every owner the taxonomy actually assigns has a sentence. The other
    // direction — a label for every value `BlockageOwner` admits — is the
    // Record's own type, enforced at compile time, which is why the table
    // carries `account_owner` although no class uses it yet.
    const inUse = new Set(Object.values(BLOCKAGE_POLICY).map((p) => p.owner as BlockageOwner));
    for (const owner of inUse) {
      expect(BLOCKAGE_OWNER_LABEL[owner], `no words for "${owner}"`).toBeTruthy();
    }
  });

  it("no rendered string carries database vocabulary", () => {
    const rendered = [
      ...Object.values(CONVERGENCE_LABEL),
      ...Object.values(CONVERGENCE_MEANING),
      ...Object.values(AGREEMENT_NOTE),
      ...Object.values(BLOCKAGE_OWNER_LABEL),
    ];
    for (const s of rendered) {
      expect(s, `"${s}" reads like an identifier`).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("the unknown reading claims nothing either way", () => {
    // A state that means "we could not complete the comparison" must not be
    // worded as a finding about the clone.
    expect(CONVERGENCE_MEANING.unknown).toMatch(/nothing is claimed/i);
  });
});

describe("the staleness threshold", () => {
  it("is derived from the audit's own cadence, not chosen separately", () => {
    expect(READING_STALE_AFTER_MINUTES).toBe(AUDIT_CADENCE_MINUTES * MISSED_PASSES_BEFORE_STALE);
  });

  it("allows more than one missed pass before it stops believing the reading", () => {
    // One slow run is not a fault. This is the same conservatism the drain's
    // stall reclaim uses, for the same reason.
    expect(MISSED_PASSES_BEFORE_STALE).toBeGreaterThan(1);
  });
});
