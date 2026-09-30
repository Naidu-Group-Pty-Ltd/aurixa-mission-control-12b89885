/**
 * `extendGateTrial` against an in-memory gate that really applies its filters.
 *
 * The planner's rule is pinned in `clonePaymentGate.pure.test.ts`. What only
 * the act can get wrong is the write: that it lands only on the gate it
 * planned from, that it never touches the payment, that the history and the
 * notification say what happened — and that each refusal writes nothing. So
 * the fake below evaluates `eq`, `is` and `filter` against a stored row instead of
 * recording them, which is what lets a payment landing between the read and
 * the write actually lose the race here, the way it would against Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  gate: null as Row | null,
  events: [] as Row[],
  updates: [] as Row[],
  readError: null as { message: string } | null,
  updateError: null as { message: string; code?: string } | null,
  /** Runs between the act's read and its write — a concurrent writer. */
  beforeUpdate: null as null | (() => void),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function gates() {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    /** A filter PostgREST would have refused before running anything. */
    let refusal: { message: string; code: string } | null = null;
    /**
     * `.eq`, `.is` and `.filter` all land here, with Postgres's semantics
     * rather than JavaScript's — the act chooses its operator by whether an
     * override is present, and a fake lenient about either would pass a wrong
     * choice.
     */
    const where = (column: string, operator: string, value: unknown) => {
      if (operator === "eq") {
        // SQL's `=`: a NULL column equals nothing, NULL included. A fake
        // where `.eq(column, null)` matched a NULL would pass an act that,
        // against Postgres, updates no gate without an override.
        filters.push((r) => (r[column] ?? null) !== null && r[column] === value);
      } else if (operator === "is") {
        // `is` takes null, true or false; PostgREST refuses anything else
        // before the statement runs.
        if (value !== null && value !== true && value !== false && !refusal) {
          refusal = { message: `failed to parse filter (is.${String(value)})`, code: "PGRST100" };
        }
        filters.push((r) => (r[column] ?? null) === value);
      } else {
        // Unknown operators fail the test loudly rather than matching every row.
        throw new Error(`the fake does not evaluate the ${operator} operator`);
      }
      return b;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => {
        patch = p;
        return b;
      },
      eq: (column: string, value: unknown) => where(column, "eq", value),
      is: (column: string, value: unknown) => where(column, "is", value),
      filter: where,
      maybeSingle: async () => {
        if (refusal) return { data: null, error: refusal };
        const matches = () => db.gate !== null && filters.every((f) => f(db.gate as Row));
        if (patch === null) {
          if (db.readError) return { data: null, error: db.readError };
          return { data: matches() ? { ...db.gate } : null, error: null };
        }
        db.beforeUpdate?.();
        db.updates.push(patch);
        if (db.updateError) return { data: null, error: db.updateError };
        if (!matches()) return { data: null, error: null };
        db.gate = { ...db.gate, ...patch };
        return { data: { ...db.gate }, error: null };
      },
    };
    return b;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "clone_payment_gates") return gates();
        if (table === "clone_payment_gate_events") {
          return {
            insert: async (row: Row) => {
              db.events.push(row);
              return { error: null };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
});

const audit = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (_entry: Record<string, unknown>) => {}),
  notifyOperators: vi.fn(async (_note: Record<string, unknown>) => true),
}));
vi.mock("@/server/audit.server", () => audit);

import { extendGateTrial, type GateRow } from "./payment-gate.server";
import { trialExtensionsOf } from "@/lib/clonePaymentGate.pure";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
const CLONE = "clone-1";
const ADMIN = "admin-1";

function gate(overrides: Row = {}): Row {
  return {
    id: "gate-1",
    clone_id: CLONE,
    plan_slug: "scale",
    armed_at: at(-100),
    grace_hours: 72,
    locks_at: at(24),
    manual_override: null,
    manual_override_reason: null,
    manual_override_by: null,
    manual_override_at: null,
    paid_at: null,
    payment_source: null,
    amount_paid_cents: null,
    trial_extension_count: 0,
    trial_extended_at: null,
    trial_extended_by: null,
    trial_extension_reason: null,
    ...overrides,
  };
}

/** What the dialog saw: the gate as it stands when the call is made, unless a
 *  test says otherwise. */
const seen = () => ({
  locksAt: (db.gate?.locks_at as string | null | undefined) ?? null,
  manualOverride: (db.gate?.manual_override as "locked" | "unlocked" | null | undefined) ?? null,
});

const extend = (over: Partial<Parameters<typeof extendGateTrial>[0]> = {}) =>
  extendGateTrial({
    cloneId: CLONE,
    hours: 168,
    expected: seen(),
    reason: "Customer asked for another week to arrange payment",
    actorId: ADMIN,
    cloneName: "Acme Realty",
    ...over,
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.gate = gate();
  db.events = [];
  db.updates = [];
  db.readError = null;
  db.updateError = null;
  db.beforeUpdate = null;
  audit.writeAuditLog.mockClear();
  audit.notifyOperators.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("extendGateTrial — a running trial", () => {
  it("adds the hours to the deadline it had, and records who, when and why", async () => {
    const result = await extend();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locksAt).toBe(at(24 + 168));
    expect(result.previousLocksAt).toBe(at(24));
    expect(result.base).toBe("deadline");
    expect(result.state).toMatchObject({ status: "open", reason: "within_grace", counting: true });

    expect(db.gate).toMatchObject({
      locks_at: at(24 + 168),
      trial_extension_count: 1,
      trial_extended_at: NOW.toISOString(),
      trial_extended_by: ADMIN,
      trial_extension_reason: "Customer asked for another week to arrange payment",
    });
  });

  it("writes one trial_extended event and one audit row, and announces nothing", async () => {
    await extend();
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({
      gate_id: "gate-1",
      clone_id: CLONE,
      kind: "trial_extended",
      status_before: "open",
      status_after: "open",
      actor: "operator",
      actor_id: ADMIN,
    });
    expect(db.events[0].metadata).toMatchObject({
      hours: 168,
      base: "deadline",
      locks_at: at(192),
      previous_locks_at: at(24),
      cleared_override: null,
      extension_number: 1,
    });
    expect(audit.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(audit.writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: "clone_gate.trial_extended",
      entityId: CLONE,
      actorUserId: ADMIN,
    });
    // Moving the deadline of a workspace that was open anyway is history,
    // not news.
    expect(audit.notifyOperators).not.toHaveBeenCalled();
  });

  it("never writes a payment fact", async () => {
    await extend();
    expect(db.updates).toHaveLength(1);
    const written = Object.keys(db.updates[0]);
    for (const column of ["paid_at", "payment_source", "amount_paid_cents"]) {
      expect(written).not.toContain(column);
    }
    // Nor an override it was not asked to clear.
    expect(written).not.toContain("manual_override");
  });

  it("counts a second extension as the second", async () => {
    db.gate = gate({
      trial_extension_count: 1,
      trial_extended_at: at(-48),
      trial_extended_by: "someone-else",
      trial_extension_reason: "First week",
    });
    const result = await extend({ hours: 24 });
    expect(result.ok).toBe(true);
    expect(db.gate).toMatchObject({ trial_extension_count: 2, trial_extended_by: ADMIN });
    expect(db.events[0].metadata).toMatchObject({ extension_number: 2 });
  });
});

describe("extendGateTrial — a lapsed trial", () => {
  beforeEach(() => {
    db.gate = gate({ locks_at: at(-10) });
  });

  it("reopens from now, so the customer gets the time they were given", async () => {
    const result = await extend({ hours: 72 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locksAt).toBe(at(72));
    expect(result.base).toBe("now");
    expect(result.state).toMatchObject({ status: "open", counting: true });
    expect(db.events[0]).toMatchObject({ status_before: "locked", status_after: "open" });
  });

  it("announces the reopening, once", async () => {
    await extend({ hours: 72 });
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
    const note = audit.notifyOperators.mock.calls[0][0];
    expect(note).toMatchObject({
      kind: "clone_gate_unlocked",
      severity: "success",
      cloneId: CLONE,
      url: "/billing/gates",
    });
    expect(String(note.title)).toContain("Acme Realty");
    expect(String(note.body)).toContain("3 days");
    expect(String(note.body)).toContain("locks again by itself");
  });
});

describe("extendGateTrial — operator overrides", () => {
  it("converts an unlock back onto the clock", async () => {
    db.gate = gate({
      locks_at: at(-200),
      manual_override: "unlocked",
      manual_override_reason: "Gave them time",
      manual_override_by: "someone-else",
      manual_override_at: at(-190),
    });
    const result = await extend({ hours: 48 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clearedOverride).toBe("unlocked");
    expect(db.gate).toMatchObject({
      locks_at: at(48),
      manual_override: null,
      manual_override_reason: null,
      manual_override_by: null,
      manual_override_at: null,
    });
    expect(result.state).toMatchObject({ reason: "within_grace", counting: true });
    // Open before (held by hand), open after (on the clock): no status change.
    expect(audit.notifyOperators).not.toHaveBeenCalled();
  });

  it("refuses a lock unless lifting it is asked for, and writes nothing", async () => {
    db.gate = gate({
      manual_override: "locked",
      manual_override_reason: "Suspended pending review",
      manual_override_by: "someone-else",
      manual_override_at: at(-1),
    });
    expect(await extend()).toEqual({ ok: false, error: "operator_locked" });
    expect(db.updates).toEqual([]);
    expect(db.events).toEqual([]);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lifts a lock when asked to by name", async () => {
    db.gate = gate({
      manual_override: "locked",
      manual_override_reason: "Suspended pending review",
      manual_override_by: "someone-else",
      manual_override_at: at(-1),
    });
    const result = await extend({ liftOperatorLock: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clearedOverride).toBe("locked");
    expect(db.gate?.manual_override).toBeNull();
    expect(db.events[0]).toMatchObject({ status_before: "locked", status_after: "open" });
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
  });
});

describe("extendGateTrial — what it refuses, having written nothing", () => {
  const nothingWritten = () => {
    expect(db.updates).toEqual([]);
    expect(db.events).toEqual([]);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
    expect(audit.notifyOperators).not.toHaveBeenCalled();
  };

  it("a reason too short to be one", async () => {
    expect(await extend({ reason: "  ok  " })).toEqual({ ok: false, error: "reason_required" });
    nothingWritten();
  });

  it("a clone with no gate", async () => {
    db.gate = null;
    expect(await extend()).toEqual({ ok: false, error: "no_gate" });
    nothingWritten();
  });

  it("a gate whose read failed — never read as no gate", async () => {
    db.readError = { message: "connection reset" };
    expect(await extend()).toEqual({ ok: false, error: "connection reset" });
    nothingWritten();
  });

  it("a paid gate", async () => {
    db.gate = gate({ paid_at: at(-1), payment_source: "stripe_checkout" });
    expect(await extend()).toEqual({ ok: false, error: "already_paid" });
    nothingWritten();
  });

  it("a gate with no deadline", async () => {
    db.gate = gate({ locks_at: null, grace_hours: null });
    expect(await extend()).toEqual({ ok: false, error: "no_deadline" });
    nothingWritten();
  });

  it("an unusable number of hours", async () => {
    expect(await extend({ hours: "soon" })).toEqual({ ok: false, error: "invalid_hours" });
    nothingWritten();
  });
});

describe("extendGateTrial — only the gate the operator was shown", () => {
  // The dialog previews from the console's copy of the row, which can be a
  // minute old. These are the gaps BEFORE the act's own read, which the update
  // filters cannot see: the row the act reads is already the moved one.

  it("refuses a deadline somebody else has already moved — two operators, one ticket", async () => {
    const shown = seen();
    // The first operator's week lands while the second is still typing.
    db.gate = gate({ locks_at: at(24 + 168), trial_extension_count: 1 });
    db.gate.trial_extended_at = at(-1);
    db.gate.trial_extended_by = "admin-2";
    db.gate.trial_extension_reason = "Promised a week on the phone";
    expect(await extend({ expected: shown })).toEqual({ ok: false, error: "gate_changed" });
    expect(db.updates).toEqual([]);
    expect(db.gate).toMatchObject({ locks_at: at(192), trial_extension_count: 1 });
    expect(db.events).toEqual([]);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses when an override appeared since the dialog read the gate", async () => {
    const shown = seen();
    db.gate = gate({ manual_override: "locked", manual_override_by: "admin-2" });
    expect(await extend({ expected: shown, liftOperatorLock: true })).toEqual({
      ok: false,
      error: "gate_changed",
    });
    expect(db.updates).toEqual([]);
    expect(db.gate?.manual_override).toBe("locked");
  });

  it("writes exactly the deadline the dialog previewed when nothing has moved", async () => {
    const result = await extend({ expected: seen(), hours: 72 });
    expect(result.ok && result.locksAt).toBe(at(24 + 72));
  });
});

describe("extendGateTrial — losing a race writes nothing", () => {
  it("to a payment landing between the read and the write", async () => {
    db.beforeUpdate = () => {
      db.gate = { ...db.gate, paid_at: at(0), payment_source: "stripe_checkout" };
    };
    expect(await extend()).toEqual({ ok: false, error: "gate_changed" });
    expect(db.gate).toMatchObject({ locks_at: at(24), trial_extension_count: 0 });
    expect(db.events).toEqual([]);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("to an operator locking the gate meanwhile", async () => {
    db.beforeUpdate = () => {
      db.gate = { ...db.gate, manual_override: "locked", manual_override_by: "someone-else" };
    };
    expect(await extend()).toEqual({ ok: false, error: "gate_changed" });
    expect(db.gate?.manual_override).toBe("locked");
    expect(db.events).toEqual([]);
  });

  it("to an operator replacing the unlock it planned to clear", async () => {
    // The other branch of the override guard: an override was there when the
    // gate was read, and the write must match it exactly, not merely find one.
    db.gate = gate({
      locks_at: at(-200),
      manual_override: "unlocked",
      manual_override_reason: "Gave them time",
      manual_override_by: "someone-else",
      manual_override_at: at(-190),
    });
    db.beforeUpdate = () => {
      db.gate = { ...db.gate, manual_override: "locked", manual_override_reason: "Chargeback" };
    };
    expect(await extend()).toEqual({ ok: false, error: "gate_changed" });
    expect(db.gate).toMatchObject({ manual_override: "locked", trial_extension_count: 0 });
    expect(db.events).toEqual([]);
  });

  it("to another extension moving the deadline first", async () => {
    db.beforeUpdate = () => {
      db.gate = { ...db.gate, locks_at: at(48) };
    };
    expect(await extend()).toEqual({ ok: false, error: "gate_changed" });
    expect(db.gate?.locks_at).toBe(at(48));
    expect(db.events).toEqual([]);
  });
});

describe("extendGateTrial — before the migration has applied", () => {
  it.each(["PGRST204", "42703"])(
    "reads %s as schema_pending, having written nothing",
    async (code) => {
      db.updateError = { message: "Could not find the 'trial_extended_at' column", code };
      expect(await extend()).toEqual({ ok: false, error: "schema_pending" });
      expect(db.events).toEqual([]);
      expect(audit.writeAuditLog).not.toHaveBeenCalled();
    },
  );

  it("reads a row without the column as never extended", () => {
    const { trial_extension_count: _dropped, ...legacy } = gate();
    expect(trialExtensionsOf(legacy as unknown as GateRow)).toBe(0);
    expect(trialExtensionsOf(null)).toBe(0);
    expect(trialExtensionsOf(gate({ trial_extension_count: 3 }) as unknown as GateRow)).toBe(3);
  });

  it("extends a legacy row as its first extension", async () => {
    const { trial_extension_count: _dropped, ...legacy } = gate();
    db.gate = legacy;
    const result = await extend();
    expect(result.ok).toBe(true);
    expect(db.gate?.trial_extension_count).toBe(1);
  });
});
