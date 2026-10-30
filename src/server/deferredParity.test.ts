import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import { migrationLaneWroteDetail } from "./fleetBlockageRecord.pure";
import {
  PARITY_UNVERIFIED_PREFIX,
  PARITY_VERIFIED_LINE,
  lateParityVerdict,
  parityMismatchLine,
  paritySurplusLine,
  parityUnverifiedLine,
} from "./parityVerdict.pure";
import { PARITY_DEFERRED_REASON } from "./provisioningFinish.pure";

/** What the demo's finishing pass wrote at 02:17:42 on 30 Oct 2026. */
const DEFERRED = parityUnverifiedLine(PARITY_DEFERRED_REASON);

describe("the verdict a comparison run after the fact may write", () => {
  it("replaces the unverified line with the match", () => {
    expect(
      lateParityVerdict({ blockingIssues: [], surplusTotal: 0, cloneId: "c1", standing: DEFERRED }),
    ).toEqual({ detail: PARITY_VERIFIED_LINE, raise: false });
  });

  it("says what the clone holds beyond the prime, rather than 'verified'", () => {
    expect(
      lateParityVerdict({ blockingIssues: [], surplusTotal: 3, cloneId: "c1", standing: DEFERRED })
        .detail,
    ).toBe(paritySurplusLine(3, "c1"));
  });

  it("writes and raises a mismatch whatever stands", () => {
    for (const standing of [DEFERRED, "Synced to 20270210090000", null]) {
      expect(
        lateParityVerdict({
          blockingIssues: ["missing_tables:2"],
          surplusTotal: 0,
          cloneId: "c1",
          standing,
        }),
      ).toEqual({ detail: parityMismatchLine(["missing_tables:2"], "c1"), raise: true });
    }
  });

  it("leaves another writer's line alone when there is nothing to retract", () => {
    for (const standing of ["Synced to 20270210090000", "Backend is ready — modules added", null]) {
      expect(
        lateParityVerdict({ blockingIssues: [], surplusTotal: 0, cloneId: "c1", standing }),
      ).toEqual({ detail: null, raise: false });
    }
  });

  it("recognises the line the finishing pass writes, because both are built here", () => {
    expect(DEFERRED.startsWith(PARITY_UNVERIFIED_PREFIX)).toBe(true);
    expect(parityUnverifiedLine("timeout")).toBe(
      "Backend ready, but parity could not be verified (timeout) — it has not been compared with the prime",
    );
  });

  it("no migration lane may retract any parity sentence", () => {
    // `fleetBlockageRecord.pure.ts` keeps the lanes off every one of these, so
    // the late comparison is the only writer that replaces the unverified line.
    for (const line of [
      DEFERRED,
      parityMismatchLine(["x:1"], "c1"),
      paritySurplusLine(2, "c1"),
      PARITY_VERIFIED_LINE,
    ]) {
      expect(migrationLaneWroteDetail(line), line).toBe(false);
    }
  });
});

/* The I/O, against doubles that record what was asked and written. */
const h = vi.hoisted(() => {
  const state = {
    owed: [] as Array<Record<string, unknown>>,
    readError: null as null | { message: string },
    landed: [{ clone_id: "c1" }] as unknown[],
    reads: [] as Array<Array<[string, unknown]>>,
    updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  };
  const client = {
    from: (_table: string) => ({
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (c: string, v: unknown) => (filters.push([`eq:${c}`, v]), chain),
          is: (c: string, v: unknown) => (filters.push([`is:${c}`, v]), chain),
          not: (c: string, op: string, v: unknown) => (filters.push([`not:${c}:${op}`, v]), chain),
          order: () => chain,
          limit: async () => {
            state.reads.push(filters);
            return { data: state.readError ? null : state.owed, error: state.readError };
          },
        };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (c: string, v: unknown) => (filters.push([`eq:${c}`, v]), chain),
          is: (c: string, v: unknown) => (filters.push([`is:${c}`, v]), chain),
          select: async () => {
            state.updates.push({ patch, filters });
            return { data: state.landed, error: null };
          },
        };
        return chain;
      },
    }),
  };
  const parity = {
    prime_ref: "primeref",
    target_ref: "cloneref",
    risk_level: "low",
    blocking_issues: [] as string[],
    surplus_in_target: { total: 0 },
    summary: "matches",
  };
  return {
    state,
    client,
    parity,
    computeParity: vi.fn(async () => parity),
    writeAuditLog: vi.fn(async () => true),
    notifyOperators: vi.fn(async () => true),
  };
});
vi.mock("./handoff-parity.server", () => ({
  computeParity: h.computeParity,
  readCloneCrmMode: vi.fn(async () => null),
  readWithheldSecretNames: vi.fn(async () => []),
}));
vi.mock("./prime-backend.server", () => ({
  resolvePrimeBackendRef: vi.fn(async () => "primeref"),
  resolvePrimeSource: vi.fn(async () => null),
  fetchDeclaredEdgeFunctionSlugs: vi.fn(async () => null),
  fetchMigrationObjectIndex: vi.fn(async () => null),
}));
vi.mock("./github-app.server", () => ({ getAppOctokit: vi.fn(() => ({})) }));
vi.mock("./audit.server", () => ({
  writeAuditLog: h.writeAuditLog,
  notifyOperators: h.notifyOperators,
}));

describe("catchUpDeferredParity", () => {
  const roomy = () => Date.now() + 90_000;
  const run = async (deadlineAt = roomy()) => {
    const { catchUpDeferredParity } = await import("./deferredParity.server");
    return catchUpDeferredParity({ supabase: h.client as never, deadlineAt });
  };

  beforeEach(() => {
    h.state.owed = [{ clone_id: "c1", supabase_project_ref: "cloneref", status_detail: DEFERRED }];
    h.state.readError = null;
    h.state.landed = [{ clone_id: "c1" }];
    h.state.reads = [];
    h.state.updates = [];
    h.parity.blocking_issues = [];
    h.parity.surplus_in_target = { total: 0 };
    h.computeParity.mockReset();
    h.computeParity.mockImplementation(async () => h.parity);
    h.writeAuditLog.mockClear();
    h.notifyOperators.mockClear();
  });

  it("compares the demo's backend and replaces its unverified line, on a row nobody compared first", async () => {
    const out = await run();
    expect(h.computeParity).toHaveBeenCalledWith("primeref", "cloneref", expect.any(Object));
    expect(h.state.reads[0]).toEqual(
      expect.arrayContaining([
        ["eq:status", "ready"],
        ["is:parity_checked_at", null],
      ]),
    );
    const [write] = h.state.updates;
    expect(write.patch.status_detail).toBe(PARITY_VERIFIED_LINE);
    expect(write.patch.parity_report).toEqual(h.parity);
    expect(typeof write.patch.parity_checked_at).toBe("string");
    expect(write.filters).toEqual([
      ["eq:clone_id", "c1"],
      ["is:parity_checked_at", null],
    ]);
    expect(h.notifyOperators).not.toHaveBeenCalled();
    expect(h.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "clone_backend.parity_caught_up", entityId: "c1" }),
    );
    expect(out.checked?.detail).toBe(PARITY_VERIFIED_LINE);
  });

  it("raises a mismatch to the operators, because nobody was watching when it was found", async () => {
    h.parity.blocking_issues = ["missing_tables:2"];
    const out = await run();
    expect(h.state.updates[0].patch.status_detail).toBe(
      parityMismatchLine(["missing_tables:2"], "c1"),
    );
    expect(h.notifyOperators).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "drift_high", cloneId: "c1" }),
    );
    expect(out.checked?.raised).toBe(true);
  });

  it("starts nothing without the step's own time left", async () => {
    const out = await run(Date.now() + 5_000);
    expect(out).toEqual({
      checked: null,
      why: "this pass has no time left for a comparison",
      failed: [],
    });
    expect(h.state.reads).toEqual([]);
    expect(h.computeParity).not.toHaveBeenCalled();
  });

  it("does nothing when no backend is owed a comparison", async () => {
    h.state.owed = [];
    expect((await run()).checked).toBeNull();
    expect(h.computeParity).not.toHaveBeenCalled();
  });

  it("never reads a failed lookup as nothing owed", async () => {
    h.state.readError = { message: "timeout" };
    await expect(run()).rejects.toThrow(/could not be read: timeout/);
  });

  it("records nothing when another pass compared the backend first", async () => {
    h.state.landed = [];
    const out = await run();
    expect(out).toEqual({
      checked: null,
      why: "another pass compared this backend first",
      failed: [],
    });
    expect(h.writeAuditLog).not.toHaveBeenCalled();
    expect(h.notifyOperators).not.toHaveBeenCalled();
  });

  it("records a comparison that cannot run and compares the next backend waiting", async () => {
    // Taking only the one waiting longest would hand every pass to it.
    h.state.owed = [
      { clone_id: "paused", supabase_project_ref: "pausedref", status_detail: DEFERRED },
      { clone_id: "c1", supabase_project_ref: "cloneref", status_detail: DEFERRED },
    ];
    h.computeParity.mockImplementation((async (_prime: string, target: string) => {
      if (target === "pausedref") throw new Error("project is paused");
      return h.parity;
    }) as never);
    const out = await run();
    expect(out.failed).toEqual([{ cloneId: "paused", error: "project is paused" }]);
    expect(out.checked?.cloneId).toBe("c1");
    expect(h.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "paused", metadata: { error: "project is paused" } }),
    );
    expect(h.state.updates.map((u) => u.filters[0])).toEqual([["eq:clone_id", "c1"]]);
  });

  it("never compares the prime with itself", async () => {
    h.state.owed = [{ clone_id: "p", supabase_project_ref: "primeref", status_detail: null }];
    expect((await run()).checked).toBeNull();
    expect(h.computeParity).not.toHaveBeenCalled();
    expect(h.state.updates).toEqual([]);
  });
});

describe("both writers build the sentences in one place", () => {
  const finishing = stripComments(
    readFileSync("src/lib/backend-provisioning.functions.ts", "utf8"),
  );
  const hook = stripComments(readFileSync("src/routes/hooks.backend-catchup.tsx", "utf8"));

  it("the finishing pass spells none of them itself", () => {
    expect(finishing).not.toContain("DOES NOT MATCH the prime");
    expect(finishing).not.toContain("parity could not be verified");
    expect(finishing).not.toContain("verified against the prime");
    expect(finishing).toContain("parityUnverifiedLine(parityError)");
  });

  it("the half-hourly catch-up runs the comparison, inside its window, without failing on it", () => {
    const call = hook.indexOf("catchUpDeferredParity({ supabase: supabaseAdmin, deadlineAt })");
    expect(call).toBeGreaterThan(-1);
    // Inside a `try` whose `catch` comes after the call: a refusal is recorded
    // and the catch-up's response still goes out.
    const tryAt = hook.lastIndexOf("try {", call);
    expect(hook.slice(tryAt, call)).not.toMatch(/\}\s*catch/);
    expect(hook.slice(call)).toMatch(/^[^]*?\}\s*catch \(parityErr\)/);
    expect(hook).toMatch(/const deadlineAt = Date\.now\(\) \+ BACKEND_CATCHUP_WINDOW_MS;/);
  });
});
