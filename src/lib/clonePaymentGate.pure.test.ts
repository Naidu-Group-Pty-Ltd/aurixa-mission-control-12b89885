import { describe, expect, it } from "vitest";
import {
  computeLocksAt,
  describeTrialExtensionRefusal,
  formatRemaining,
  GATE_DEFAULT_HOURS,
  GATE_EVENT_KINDS,
  GATE_MAX_HOURS,
  gateEligibility,
  gateEventLabel,
  gateFactsOf,
  gateTone,
  describeGateReason,
  isOnExtendedTrial,
  normaliseExtensionHours,
  normaliseGraceHours,
  planTrialExtension,
  resolveGateState,
  TRIAL_EXTENSION_PRESET_DAYS,
  trialExtensionsOf,
  type GateFacts,
  type TrialExtensionRefusal,
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

describe("planTrialExtension", () => {
  const HOUR = 60 * 60 * 1000;
  const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString();
  const refusalOf = (plan: ReturnType<typeof planTrialExtension>) =>
    plan.ok ? null : plan.refusal;

  it("adds the time to a trial that is still running — the customer keeps what they had", () => {
    const plan = planTrialExtension(facts({ locksAt: at(24) }), { hours: 48 }, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.locksAt).toBe(at(72));
    expect(plan.previousLocksAt).toBe(at(24));
    expect(plan.base).toBe("deadline");
    expect(plan.before.reason).toBe("within_grace");
    expect(plan.after.reason).toBe("within_grace");
    expect(plan.clearsOverride).toBeNull();
  });

  it("reopens a lapsed trial and measures the time from NOW, not from the old deadline", () => {
    // Seven more days means seven days the customer can use. Measured from a
    // deadline five days behind them it would be two.
    const plan = planTrialExtension(facts({ locksAt: at(-5 * 24) }), { hours: 7 * 24 }, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.before.status).toBe("locked");
    expect(plan.before.reason).toBe("grace_expired");
    expect(plan.base).toBe("now");
    expect(plan.locksAt).toBe(at(7 * 24));
    expect(plan.after.status).toBe("open");
    expect(plan.after.counting).toBe(true);
    expect(plan.after.msRemaining).toBe(7 * 24 * HOUR);
  });

  it("a deadline exactly now has lapsed — the resolver already reads it as locked", () => {
    const plan = planTrialExtension(facts({ locksAt: NOW.toISOString() }), { hours: 24 }, NOW);
    expect(plan.ok && plan.base).toBe("now");
    expect(plan.ok && plan.before.reason).toBe("grace_expired");
  });

  it("closes again BY ITSELF at the new deadline — nothing to remember to lock", () => {
    // The whole point of the act. The manual routine it replaces was unlock,
    // then remember to lock; this leaves nothing for anybody to remember.
    const plan = planTrialExtension(facts({ locksAt: at(-1) }), { hours: 72 }, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const written = facts({ locksAt: plan.locksAt });
    expect(resolveGateState(written, NOW)).toEqual(plan.after);
    const justBefore = new Date(Date.parse(plan.locksAt) - 1);
    const atDeadline = new Date(plan.locksAt);
    expect(resolveGateState(written, justBefore).status).toBe("open");
    expect(resolveGateState(written, atDeadline).status).toBe("locked");
    expect(resolveGateState(written, atDeadline).reason).toBe("grace_expired");
  });

  it("only ever moves a deadline later, and always leaves the gate open and counting", () => {
    const deadlines = [-24 * 30, -72, -1, 0, 1, 23, 72, 24 * 60];
    const extensions = [1, 5, 24, 72, 7 * 24, 30 * 24];
    for (const d of deadlines) {
      for (const h of extensions) {
        const plan = planTrialExtension(facts({ locksAt: at(d) }), { hours: h }, NOW);
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        const moved = Date.parse(plan.locksAt);
        expect(moved).toBeGreaterThan(Date.parse(at(d)));
        expect(moved).toBe(Math.max(NOW.getTime(), Date.parse(at(d))) + h * HOUR);
        expect(plan.after.status).toBe("open");
        expect(plan.after.reason).toBe("within_grace");
        expect(plan.after.counting).toBe(true);
      }
    }
  });

  it("hands an operator's UNLOCK back to the clock — the routine this replaces", () => {
    // The trial ran out, somebody unlocked it by hand, and somebody would have
    // had to remember to lock it again. Extending clears the unlock.
    const plan = planTrialExtension(
      facts({ manualOverride: "unlocked", locksAt: at(-48) }),
      { hours: 72 },
      NOW,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.before.reason).toBe("operator_unlocked");
    expect(plan.clearsOverride).toBe("unlocked");
    expect(plan.base).toBe("now");
    expect(plan.after.reason).toBe("within_grace");
  });

  it("never lifts an operator's LOCK as a side effect", () => {
    const locked = facts({ manualOverride: "locked", locksAt: at(-48) });
    expect(refusalOf(planTrialExtension(locked, { hours: 72 }, NOW))).toBe("operator_locked");
    expect(refusalOf(planTrialExtension(locked, { hours: 72, liftOperatorLock: false }, NOW))).toBe(
      "operator_locked",
    );
  });

  it("lifts an operator's lock only when that is asked for by name", () => {
    const plan = planTrialExtension(
      facts({ manualOverride: "locked", locksAt: at(-48) }),
      { hours: 72, liftOperatorLock: true },
      NOW,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.before.status).toBe("locked");
    expect(plan.clearsOverride).toBe("locked");
    expect(plan.after.status).toBe("open");
  });

  it("refuses a paid gate, whatever an operator has done to it", () => {
    // The resolver ranks the override above the payment; the trial does not.
    // Once the money landed there is no trial left to extend.
    for (const manualOverride of [null, "unlocked", "locked"] as const) {
      const plan = planTrialExtension(
        facts({ manualOverride, paidAt: at(-1), locksAt: at(-24) }),
        { hours: 24, liftOperatorLock: true },
        NOW,
      );
      expect(refusalOf(plan)).toBe("already_paid");
    }
  });

  it("refuses a gate with no deadline — putting one on a clock is a Window act", () => {
    expect(refusalOf(planTrialExtension(facts({ locksAt: null }), { hours: 24 }, NOW))).toBe(
      "no_deadline",
    );
    expect(
      refusalOf(
        planTrialExtension(
          facts({ manualOverride: "unlocked", locksAt: null }),
          { hours: 24 },
          NOW,
        ),
      ),
    ).toBe("no_deadline");
  });

  it("an unparseable deadline is no deadline, exactly as the resolver reads it", () => {
    const plan = planTrialExtension(facts({ locksAt: "not-a-date" }), { hours: 24 }, NOW);
    expect(refusalOf(plan)).toBe("no_deadline");
  });

  it("refuses the prime and every clone that pre-dates gating", () => {
    expect(refusalOf(planTrialExtension(null, { hours: 24 }, NOW))).toBe("no_gate");
  });

  it("refuses an extension that is not a whole number of hours in range", () => {
    for (const hours of ["", " ", "soon", 0, -24, 1.5, GATE_MAX_HOURS + 1]) {
      const plan = planTrialExtension(facts({ locksAt: at(24) }), { hours }, NOW);
      expect(refusalOf(plan)).toBe("invalid_hours");
    }
  });

  it("refuses rather than clamps a deadline more than a year away", () => {
    const running = facts({ locksAt: at(8000) });
    expect(refusalOf(planTrialExtension(running, { hours: 761 }, NOW))).toBe("beyond_maximum");
    // Exactly a year from now is the longest honest window, and allowed.
    const plan = planTrialExtension(running, { hours: 760 }, NOW);
    expect(plan.ok && plan.locksAt).toBe(at(GATE_MAX_HOURS));
  });

  it("is a pure function of the facts and the request", () => {
    const f = facts({ locksAt: at(-3) });
    expect(planTrialExtension(f, { hours: "72" }, NOW)).toEqual(
      planTrialExtension(f, { hours: 72 }, NOW),
    );
  });

  describe("planned only from the gate the operator was shown", () => {
    const seen = { locksAt: at(24), manualOverride: null };

    it("plans as usual when the gate is still the one previewed", () => {
      const plan = planTrialExtension(
        facts({ locksAt: at(24) }),
        { hours: 168, expected: seen },
        NOW,
      );
      expect(plan.ok && plan.locksAt).toBe(at(192));
    });

    it("refuses when somebody moved the deadline since — two operators, one ticket", () => {
      // The first operator's week is already on the gate; the second one's
      // preview said "from the old deadline", so it is not what would be written.
      const plan = planTrialExtension(
        facts({ locksAt: at(192) }),
        { hours: 168, expected: seen },
        NOW,
      );
      expect(refusalOf(plan)).toBe("gate_changed");
    });

    it("refuses when an override appeared or went since", () => {
      expect(
        refusalOf(
          planTrialExtension(
            facts({ locksAt: at(24), manualOverride: "locked" }),
            { hours: 24, liftOperatorLock: true, expected: seen },
            NOW,
          ),
        ),
      ).toBe("gate_changed");
      expect(
        refusalOf(
          planTrialExtension(
            facts({ locksAt: at(24) }),
            { hours: 24, expected: { locksAt: at(24), manualOverride: "unlocked" } },
            NOW,
          ),
        ),
      ).toBe("gate_changed");
    });

    it("compares instants, not spellings — the same deadline written two ways is the same", () => {
      const iso = "2026-09-02T12:00:00.000Z";
      const plan = planTrialExtension(
        facts({ locksAt: "2026-09-02T12:00:00+00:00" }),
        { hours: 24, expected: { locksAt: iso, manualOverride: null } },
        NOW,
      );
      expect(plan.ok).toBe(true);
    });

    it("says the payment landed rather than that something changed", () => {
      const plan = planTrialExtension(
        facts({ locksAt: at(24), paidAt: at(-1) }),
        { hours: 24, expected: seen },
        NOW,
      );
      expect(refusalOf(plan)).toBe("already_paid");
    });

    it("a gate that lost its deadline since is a changed gate, not a missing clock", () => {
      const plan = planTrialExtension(facts({ locksAt: null }), { hours: 24, expected: seen }, NOW);
      expect(refusalOf(plan)).toBe("gate_changed");
    });
  });
});

describe("normaliseExtensionHours", () => {
  it("has no blank-means-none: extending by nothing is not an extension", () => {
    expect(normaliseExtensionHours("")).toEqual({ ok: false, error: "required" });
    expect(normaliseExtensionHours(null)).toEqual({ ok: false, error: "required" });
    expect(normaliseExtensionHours(undefined)).toEqual({ ok: false, error: "required" });
  });

  it("otherwise follows the window's own rule", () => {
    expect(normaliseExtensionHours(" 72 ")).toEqual({ ok: true, hours: 72 });
    expect(normaliseExtensionHours("soon").ok).toBe(false);
    expect(normaliseExtensionHours(0).ok).toBe(false);
    expect(normaliseExtensionHours(1.5).ok).toBe(false);
    expect(normaliseExtensionHours(GATE_MAX_HOURS + 1).ok).toBe(false);
  });

  it("every preset the dialog offers is an extension the server accepts", () => {
    for (const days of TRIAL_EXTENSION_PRESET_DAYS) {
      expect(normaliseExtensionHours(days * 24)).toEqual({ ok: true, hours: days * 24 });
    }
  });
});

describe("describeTrialExtensionRefusal", () => {
  it("says something specific for every refusal, the planner's and the server's", () => {
    const codes: Array<TrialExtensionRefusal | "reason_required" | "schema_pending"> = [
      "no_gate",
      "already_paid",
      "no_deadline",
      "operator_locked",
      "invalid_hours",
      "beyond_maximum",
      "reason_required",
      "gate_changed",
      "schema_pending",
    ];
    const sentences = codes.map(describeTrialExtensionRefusal);
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      expect(s).not.toMatch(/was refused \(/);
    }
    expect(new Set(sentences).size).toBe(codes.length);
  });

  it("shows an unknown code as itself rather than swallowing it", () => {
    expect(describeTrialExtensionRefusal("connection reset")).toContain("connection reset");
  });
});

describe("the event vocabulary", () => {
  it("names each kind once, and carries the extension act", () => {
    expect(new Set(GATE_EVENT_KINDS).size).toBe(GATE_EVENT_KINDS.length);
    expect(GATE_EVENT_KINDS).toContain("trial_extended");
  });

  it("does not call a window change an extension — it may have shortened one", () => {
    expect(gateEventLabel("extended")).toBe("window changed");
    expect(gateEventLabel("trial_extended")).toBe("trial extended");
    expect(gateEventLabel("some_future_kind")).toBe("some future kind");
  });
});

describe("reading a stored gate", () => {
  const row = {
    manual_override: null as string | null,
    paid_at: null as string | null,
    locks_at: "2026-09-04T12:00:00.000Z" as string | null,
  };

  it("no row is no gate", () => {
    expect(gateFactsOf(null)).toBeNull();
    expect(gateFactsOf(undefined)).toBeNull();
  });

  it("projects the three columns the resolver reads, and nothing else", () => {
    expect(
      gateFactsOf({ ...row, manual_override: "unlocked", paid_at: "2026-09-02T00:00:00Z" }),
    ).toEqual({
      manualOverride: "unlocked",
      paidAt: "2026-09-02T00:00:00Z",
      locksAt: "2026-09-04T12:00:00.000Z",
    });
    expect(gateFactsOf({ ...row, manual_override: "locked" })?.manualOverride).toBe("locked");
  });

  it("reads a word the column does not allow as no override — as the resolver would", () => {
    const f = gateFactsOf({ ...row, manual_override: "paused" });
    expect(f?.manualOverride).toBeNull();
    // The preview and the resolver agree on what such a row IS.
    expect(resolveGateState(f, NOW).reason).toBe("within_grace");
  });

  it("the dialog's preview and the act plan from the same reading of the same row", () => {
    // What the browser holds and what the server re-reads are the same row;
    // one reader means one plan.
    const lapsed = { ...row, locks_at: "2026-08-30T12:00:00.000Z", manual_override: "unlocked" };
    const a = planTrialExtension(gateFactsOf(lapsed), { hours: 72 }, NOW);
    const b = planTrialExtension(gateFactsOf({ ...lapsed }), { hours: "72" }, NOW);
    expect(a).toEqual(b);
    expect(a.ok && a.clearsOverride).toBe("unlocked");
  });
});

describe("trialExtensionsOf", () => {
  it("counts the extensions a row records", () => {
    expect(trialExtensionsOf({ trial_extension_count: 2 })).toBe(2);
  });

  it("reads a row from before the migration as never extended, not as NaN", () => {
    // Code ships separately from the migration, so the field can be absent.
    expect(trialExtensionsOf({})).toBe(0);
    expect(trialExtensionsOf(null)).toBe(0);
    expect(trialExtensionsOf(undefined)).toBe(0);
    expect(trialExtensionsOf({ trial_extension_count: null })).toBe(0);
    expect(trialExtensionsOf({ trial_extension_count: "3" })).toBe(0);
    expect(trialExtensionsOf({ trial_extension_count: Number.NaN })).toBe(0);
    expect(trialExtensionsOf({ trial_extension_count: -1 })).toBe(0);
  });
});

describe("isOnExtendedTrial", () => {
  it("is an unpaid gate somebody has given more time", () => {
    expect(isOnExtendedTrial({ gate: { trial_extension_count: 1 }, state: { paid: false } })).toBe(
      true,
    );
  });

  it("is never a paid gate, however often it was extended — there is no trial left", () => {
    expect(isOnExtendedTrial({ gate: { trial_extension_count: 3 }, state: { paid: true } })).toBe(
      false,
    );
  });

  it("is never a gate that was not extended, nor a clone with no gate", () => {
    expect(isOnExtendedTrial({ gate: { trial_extension_count: 0 }, state: { paid: false } })).toBe(
      false,
    );
    expect(isOnExtendedTrial({ gate: {}, state: { paid: false } })).toBe(false);
    expect(isOnExtendedTrial({ gate: null, state: { paid: false } })).toBe(false);
  });
});
