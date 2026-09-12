import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The sweep's four rules, exercised against stubbed primitives.
 *
 * The point of each case is a failure mode this platform has already paid
 * for once: a failed read reported as a clean project, a delete the API
 * accepted but did not perform, and a sweep that could reach the prime.
 */
const listCalls: string[] = [];
const deleteCalls: { ref: string; names: readonly string[] }[] = [];

let heldSequence: string[][] = [];
let listShouldFail = false;
let deleteShouldFail = false;
let targetThrows: Error | null = null;

vi.mock("./backend-provisioning.server", () => ({
  deleteCloneSecretValues: async (ref: string, names: readonly string[]) => {
    deleteCalls.push({ ref, names });
    return deleteShouldFail ? { ok: false, error: "secrets API 500" } : { ok: true };
  },
}));

vi.mock("./cloneAllowedOrigins.server", () => ({
  CloneSecretTargetError: class extends Error {
    reason = "refused";
  },
  resolveCloneSecretTarget: async (_db: unknown, cloneId: string) => {
    if (targetThrows) throw targetThrows;
    return { cloneId, cloneName: "clone", projectRef: "cloneref000000000000" };
  },
}));

beforeEach(() => {
  listCalls.length = 0;
  deleteCalls.length = 0;
  ledgerWrites.length = 0;
  heldSequence = [];
  listShouldFail = false;
  deleteShouldFail = false;
  targetThrows = null;
  process.env.SB_MGMT_API_TOKEN = "sbp_test";
  vi.stubGlobal("fetch", async (url: string) => {
    listCalls.push(String(url));
    if (listShouldFail) return { ok: false, status: 503, text: async () => "upstream" } as never;
    const names = heldSequence.shift() ?? [];
    return { ok: true, json: async () => names.map((n) => ({ name: n })) } as never;
  });
});
afterEach(() => vi.unstubAllGlobals());

const ledgerWrites: unknown[] = [];
const fakeDb = {
  from: () => ({
    upsert: async (rows: unknown) => {
      ledgerWrites.push(rows);
      return { error: null };
    },
  }),
};

async function sweep() {
  const m = await import("./cloneProhibitedSecrets.server");
  return m.sweepCloneProhibitedSecrets(fakeDb as never, "clone-1", "NPC Client Dashboard");
}

describe("a failed read is never a clean project", () => {
  it("reports unreadable, and deletes nothing", async () => {
    listShouldFail = true;
    const out = await sweep();
    expect(out.state).toBe("unreadable");
    expect(deleteCalls).toHaveLength(0);
  });

  it("an unreadable RE-read after a delete is not a success", async () => {
    heldSequence = [["SB_MANAGEMENT_ACCESS_TOKEN"]];
    const m = await import("./cloneProhibitedSecrets.server");
    // first list succeeds, the re-read fails
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      if (n === 1)
        return { ok: true, json: async () => [{ name: "SB_MANAGEMENT_ACCESS_TOKEN" }] } as never;
      return { ok: false, status: 503, text: async () => "gone" } as never;
    });
    const out = await m.sweepCloneProhibitedSecrets(fakeDb as never, "c", "clone");
    expect(out.state).toBe("unreadable");
  });
});

describe("deletion is bounded by the policy", () => {
  it("removes only the prohibited names and leaves everything else", async () => {
    heldSequence = [
      ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SB_MANAGEMENT_ACCESS_TOKEN", "OPENAI_API_KEY"],
      ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"],
    ];
    const out = await sweep();
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].names).toEqual(["SB_MANAGEMENT_ACCESS_TOKEN"]);
    expect(out).toMatchObject({ state: "removed", names: ["SB_MANAGEMENT_ACCESS_TOKEN"] });
  });

  it("a clean project is not written to at all", async () => {
    heldSequence = [["SUPABASE_URL", "OPENAI_API_KEY"]];
    const out = await sweep();
    expect(out.state).toBe("clean");
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("asserted by effect", () => {
  it("a delete the API accepted but did not perform is still_present", async () => {
    heldSequence = [["SB_MANAGEMENT_ACCESS_TOKEN"], ["SB_MANAGEMENT_ACCESS_TOKEN"]];
    const out = await sweep();
    expect(out).toMatchObject({ state: "still_present" });
  });

  it("a failed delete is reported with its error", async () => {
    heldSequence = [["SB_MANAGEMENT_ACCESS_TOKEN"]];
    deleteShouldFail = true;
    const out = await sweep();
    expect(out).toMatchObject({ state: "delete_failed" });
  });
});

describe("it can never reach the prime", () => {
  it("a refused target is skipped, never swept", async () => {
    targetThrows = new Error("refusing: this ref is the prime's");
    const out = await sweep();
    expect(out.state).toBe("skipped");
    expect(deleteCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
  });
});

describe("the removal is left in the ledger", () => {
  it("stamps withheld — a permitted value the forward path already refuses on", async () => {
    heldSequence = [["SB_MANAGEMENT_ACCESS_TOKEN"], []];
    await sweep();
    expect(ledgerWrites).toHaveLength(1);
    expect(ledgerWrites[0]).toEqual([
      {
        clone_id: "clone-1",
        name: "SB_MANAGEMENT_ACCESS_TOKEN",
        status: "withheld",
        last_set_at: null,
      },
    ]);
  });

  it("a clean clone writes nothing to the ledger", async () => {
    heldSequence = [["SUPABASE_URL"]];
    await sweep();
    expect(ledgerWrites).toHaveLength(0);
  });

  it("a ledger failure never un-does the removal", async () => {
    heldSequence = [["SB_MANAGEMENT_ACCESS_TOKEN"], []];
    const m = await import("./cloneProhibitedSecrets.server");
    const brokenDb = { from: () => ({ upsert: async () => ({ error: { message: "denied" } }) }) };
    const out = await m.sweepCloneProhibitedSecrets(brokenDb as never, "c", "clone");
    expect(out.state).toBe("removed");
  });
});
