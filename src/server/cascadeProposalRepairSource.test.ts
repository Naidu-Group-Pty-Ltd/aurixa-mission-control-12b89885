/**
 * A repair asks where the clone reads from BEFORE it counts an attempt.
 *
 * The repair records its attempt before it rebuilds, so a crashing rebuild
 * still counts and the loop guard still guards. A routed child whose parent
 * has not taken the promised prime commit has not crashed — it is waiting —
 * and counting the wait would spend the proposal's three repairs on another
 * clone's merge queue, after which the drain resolves the conflict by merge
 * commit on every tick rather than rebuilding it once the parent is ready.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeAuditLog = vi.fn(async () => undefined);
const notifyOperators = vi.fn(async () => undefined);
vi.mock("./audit.server", () => ({ writeAuditLog, notifyOperators }));

const prepareProposalRebuild = vi.fn();
const regenerateCloneProposal = vi.fn();
vi.mock("./cascade-engine.server", () => ({ prepareProposalRebuild, regenerateCloneProposal }));

const { repairConflictedProposal, SOURCE_NOT_READY, PROPOSAL_REPAIR_ACTION } =
  await import("./cascadeProposalRepair.server");

const ENGINE_COMMIT = {
  commit: { message: "chore(aurixa): cascade 17 file(s) from CD@fc01e33" },
  author: { login: "aurixa-mission-control[bot]" },
};

/** Supabase double: `audit_log` history, one cascade event, one result row. */
function fakeSupabase(history: Array<{ metadata: unknown }>) {
  const updates: unknown[] = [];
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      limit: async () => ({ data: table === "audit_log" ? history : [], error: null }),
      maybeSingle: async () => ({
        data: table === "cascade_events" ? { source_sha: "a".repeat(40), mode: "pr" } : null,
        error: null,
      }),
      update: (patch: unknown) => {
        updates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    };
    return q;
  };
  return { client: { from } as never, updates };
}

const octokit = {
  pulls: { listCommits: async () => ({ data: [ENGINE_COMMIT] }) },
} as never;

const args = (supabase: never) => ({
  supabase,
  octokit,
  clone: { id: "nt", label: "NPC Test", owner: "Naidu-Group-Pty-Ltd", repo: "npc-test-76b3b3" },
  prNumber: 42,
  mergeable: false,
  eventId: "evt",
});

beforeEach(() => {
  writeAuditLog.mockClear();
  notifyOperators.mockClear();
  prepareProposalRebuild.mockReset();
  regenerateCloneProposal.mockReset();
});

describe("a repair whose source is not ready", () => {
  it("holds without counting an attempt, rebuilding, or paging anybody", async () => {
    prepareProposalRebuild.mockResolvedValue({
      kind: "hold",
      why: "Parent NPC Client Dashboard carries prime@ccccccc; this pass delivers prime@aaaaaaa.",
    });
    const sb = fakeSupabase([]);

    const outcome = await repairConflictedProposal(args(sb.client));

    expect(outcome).toMatchObject({ act: "hold", reason: SOURCE_NOT_READY });
    expect(regenerateCloneProposal).not.toHaveBeenCalled();
    // Recorded as a hold, never as a `regenerate` — which is what the counter counts.
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0]).toEqual([
      expect.objectContaining({
        action: PROPOSAL_REPAIR_ACTION,
        metadata: expect.objectContaining({ act: "hold", reason: SOURCE_NOT_READY }),
      }),
    ]);
    // The drain resolves a held conflict by itself; there is nothing to page about.
    expect(notifyOperators).not.toHaveBeenCalled();
    expect(sb.updates).toEqual([]);
  });

  it("says it once, not on every five-minute tick", async () => {
    prepareProposalRebuild.mockResolvedValue({ kind: "hold", why: "waiting" });
    const sb = fakeSupabase([{ metadata: { pr: 42, act: "hold", reason: SOURCE_NOT_READY } }]);

    const outcome = await repairConflictedProposal(args(sb.client));

    expect(outcome).toMatchObject({ act: "hold", reason: SOURCE_NOT_READY });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("a repair whose source is ready", () => {
  it("counts the attempt, then rebuilds from exactly what was prepared", async () => {
    const rebuild = {
      source: {
        kind: "read",
        ref: { owner: "Naidu-Group-Pty-Ltd", repo: "npc-client-dashboard", branch: "main" },
        sha: "b".repeat(40),
        provenance: { label: "NPC Client Dashboard", deliveredSha: "a".repeat(40) },
      },
      clone: { id: "nt" },
    };
    prepareProposalRebuild.mockResolvedValue({ kind: "ready", rebuild });
    regenerateCloneProposal.mockResolvedValue({ status: "opened" });
    const sb = fakeSupabase([]);

    const outcome = await repairConflictedProposal(args(sb.client));

    expect(outcome).toMatchObject({ act: "regenerate" });
    expect(regenerateCloneProposal).toHaveBeenCalledWith(
      expect.objectContaining({ rebuild, mode: "pr" }),
    );
    // Counted BEFORE the rebuild, and it names where the rebuild reads.
    const regenerateRow = writeAuditLog.mock.calls
      .map((c) => (c as unknown as [{ metadata: Record<string, unknown> }])[0])
      .find((row) => row.metadata.act === "regenerate");
    expect(regenerateRow?.metadata.read_from).toBe("Naidu-Group-Pty-Ltd/npc-client-dashboard");
    expect(writeAuditLog.mock.invocationCallOrder[0]).toBeLessThan(
      regenerateCloneProposal.mock.invocationCallOrder[0],
    );
    expect(sb.updates).toEqual([{ status: "opened" }]);
  });

  it("asks where the clone reads from before it counts anything", async () => {
    prepareProposalRebuild.mockResolvedValue({ kind: "hold", why: "waiting" });
    await repairConflictedProposal(args(fakeSupabase([]).client));
    prepareProposalRebuild.mockResolvedValue({
      kind: "ready",
      rebuild: {
        source: { kind: "read", ref: { owner: "o", repo: "r", branch: "main" }, sha: "s" },
        clone: {},
      },
    });
    regenerateCloneProposal.mockResolvedValue({});
    writeAuditLog.mockClear();
    await repairConflictedProposal(args(fakeSupabase([]).client));
    expect(prepareProposalRebuild.mock.invocationCallOrder.at(-1)).toBeLessThan(
      writeAuditLog.mock.invocationCallOrder[0],
    );
  });
});
