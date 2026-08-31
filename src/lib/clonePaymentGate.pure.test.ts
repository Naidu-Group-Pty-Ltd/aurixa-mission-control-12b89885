import { describe, expect, it } from "vitest";
import {
  computeLocksAt,
  formatRemaining,
  GATE_DEFAULT_HOURS,
  gateEligibility,
  gateTone,
  describeGateReason,
  normaliseGraceHours,
  resolveGateState,
  type GateFacts,
} from "./clonePaymentGate.pure";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  manualOverride: null,
  paidAt: null,
  locksAt: null,
  ...over,
});

describe("resolveGateState", () => {
  it("no row is open and says it is not gated — the prime and every existing clone", () => {
    const s = resolveGateState(null, NOW);
    expect(s.status).toBe("open");
    expect(s.reason).toBe("not_gated");
    expect(s.counting).toBe(false);
  });

  it("locks once the window has closed with no payment", () => {
    const s = resolveGateState(facts({ locksAt: "2026-09-01T11:59:59.000Z" }), NOW);
    expect(s.status).toBe("locked");
    expect(s.reason).toBe("grace_expired");
    expect(s.msRemaining).toBe(0);
  });

  it("stays open inside the window and counts down", () => {
    const s = resolveGateState(facts({ locksAt: "2026-09-02T12:00:00.000Z" }), NOW);
    expect(s.status).toBe("open");
    expect(s.reason).toBe("within_grace");
    expect(s.counting).toBe(true);
    expect(s.msRemaining).toBe(24 * 60 * 60 * 1000);
  });

  it("a captured payment opens a window that has already expired", () => {
    const s = resolveGateState(
      facts({ locksAt: "2026-08-01T00:00:00.000Z", paidAt: "2026-08-15T00:00:00.000Z" }),
      NOW,
    );
    expect(s.status).toBe("open");
    expect(s.reason).toBe("paid");
    expect(s.paid).toBe(true);
    // Paid is not a countdown: nothing is owed, so nothing is running out.
    expect(s.counting).toBe(false);
  });

  it("an operator unlock outranks an expired window AND non-payment", () => {
    const s = resolveGateState(
      facts({ manualOverride: "unlocked", locksAt: "2026-08-01T00:00:00.000Z" }),
      NOW,
    );
    expect(s.status).toBe("open");
    expect(s.reason).toBe("operator_unlocked");
    expect(s.paid).toBe(false);
  });

  it("an operator lock outranks a captured payment", () => {
    const s = resolveGateState(
      facts({ manualOverride: "locked", paidAt: "2026-08-15T00:00:00.000Z" }),
      NOW,
    );
    expect(s.status).toBe("locked");
    expect(s.reason).toBe("operator_locked");
    // Still records that they paid — the lock suspends access, it does not
    // erase the money.
    expect(s.paid).toBe(true);
  });

  it("no deadline means open and unpaid, and nothing closes it", () => {
    const s = resolveGateState(facts({ locksAt: null }), NOW);
    expect(s.status).toBe("open");
    expect(s.reason).toBe("no_deadline");
    expect(s.counting).toBe(false);
  });

  it("is a pure function of the facts — the same inputs never disagree", () => {
    const f = facts({ locksAt: "2026-09-03T00:00:00.000Z" });
    expect(resolveGateState(f, NOW)).toEqual(resolveGateState(f, NOW));
  });

  it("an unparseable timestamp is treated as absent, not as zero", () => {
    // Date.parse("nonsense") is NaN; read as an epoch it would be 1970 and lock
    // every gate that carries a malformed row.
    const s = resolveGateState(facts({ locksAt: "not-a-date" }), NOW);
    expect(s.status).toBe("open");
    expect(s.reason).toBe("no_deadline");
  });

  it("locks exactly at the deadline, not a millisecond after", () => {
    const s = resolveGateState(facts({ locksAt: NOW.toISOString() }), NOW);
    expect(s.status).toBe("locked");
  });

  it("every reason has a tone and a sentence", () => {
    const cases: GateFacts[] = [
      facts({ manualOverride: "unlocked" }),
      facts({ manualOverride: "locked" }),
      facts({ paidAt: NOW.toISOString() }),
      facts({}),
      facts({ locksAt: "2026-09-02T12:00:00.000Z" }),
      facts({ locksAt: "2026-08-02T12:00:00.000Z" }),
    ];
    for (const f of [null, ...cases]) {
      const s = resolveGateState(f, NOW);
      expect(describeGateReason(s).length).toBeGreaterThan(10);
      expect(["neutral", "success", "warning", "danger"]).toContain(gateTone(s));
    }
  });

  it("an open gate inside its window is never toned as success", () => {
    // A debt with a deadline on it is a warning. Colouring it green is how an
    // operator scrolls past the clone that is about to lock.
    const s = resolveGateState(facts({ locksAt: "2026-09-02T12:00:00.000Z" }), NOW);
    expect(gateTone(s)).toBe("warning");
  });
});

describe("computeLocksAt", () => {
  it("adds the window to the arm time", () => {
    expect(computeLocksAt("2026-09-01T00:00:00.000Z", GATE_DEFAULT_HOURS)).toBe(
      "2026-09-04T00:00:00.000Z",
    );
  });
  it("null hours means no deadline", () => {
    expect(computeLocksAt(NOW, null)).toBeNull();
  });
  it("an unparseable arm time yields no deadline rather than 1970", () => {
    expect(computeLocksAt("nonsense", 72)).toBeNull();
  });

  it("a non-finite window yields no deadline rather than THROWING", () => {
    // `new Date(NaN).toISOString()` throws a RangeError. The caller that would
    // hit it is provisioning, where an operator typing letters into the window
    // field would take out the arming step and leave a paid clone silently
    // ungated — a gate somebody asked for and did not get.
    expect(computeLocksAt(NOW, Number("soon"))).toBeNull();
    expect(computeLocksAt(NOW, Number.POSITIVE_INFINITY)).toBeNull();
    expect(() => computeLocksAt(NOW, Number.NaN)).not.toThrow();
  });
});

describe("normaliseGraceHours", () => {
  it("accepts a whole number of hours", () => {
    expect(normaliseGraceHours(48)).toEqual({ ok: true, hours: 48 });
    expect(normaliseGraceHours(" 24 ")).toEqual({ ok: true, hours: 24 });
  });
  it("treats blank as an explicit no-deadline", () => {
    expect(normaliseGraceHours("")).toEqual({ ok: true, hours: null });
    expect(normaliseGraceHours(null)).toEqual({ ok: true, hours: null });
  });
  it("refuses rather than silently falling back to the default", () => {
    expect(normaliseGraceHours("soon").ok).toBe(false);
    expect(normaliseGraceHours(0).ok).toBe(false);
    expect(normaliseGraceHours(-5).ok).toBe(false);
    expect(normaliseGraceHours(1.5).ok).toBe(false);
    expect(normaliseGraceHours(9000).ok).toBe(false);
  });
});

describe("gateEligibility", () => {
  it("a paid tier is eligible", () => {
    expect(gateEligibility({ planSlug: "growth", amountDueCents: 86000 })).toEqual({
      eligible: true,
      planSlug: "growth",
      amountDueCents: 86000,
    });
  });
  it("no plan is not eligible — this is the prime", () => {
    expect(gateEligibility({ planSlug: null, amountDueCents: 86000 })).toEqual({
      eligible: false,
      reason: "no_plan",
    });
  });
  it("a zero-price plan is not eligible", () => {
    expect(gateEligibility({ planSlug: "starter", amountDueCents: 0 })).toEqual({
      eligible: false,
      reason: "free_plan",
    });
  });
  it("an unresolvable price fails OPEN, never closed", () => {
    // Gating a workspace that may owe nothing is an outage; leaving one ungated
    // is a row the console lists for an operator to arm.
    expect(gateEligibility({ planSlug: "growth", amountDueCents: null })).toEqual({
      eligible: false,
      reason: "unknown_price",
    });
  });
});

describe("formatRemaining", () => {
  it("reads coarsely above an hour", () => {
    expect(formatRemaining(72 * 60 * 60 * 1000)).toBe("3 days");
    expect(formatRemaining(50 * 60 * 60 * 1000)).toBe("2 days 2 hours");
    expect(formatRemaining(3 * 60 * 60 * 1000)).toBe("3 hours");
    expect(formatRemaining(90 * 60 * 1000)).toBe("1 hour");
    expect(formatRemaining(12 * 60 * 1000)).toBe("12 minutes");
    expect(formatRemaining(30_000)).toBe("less than a minute");
    expect(formatRemaining(0)).toBe("none");
    expect(formatRemaining(null)).toBeNull();
  });
});
