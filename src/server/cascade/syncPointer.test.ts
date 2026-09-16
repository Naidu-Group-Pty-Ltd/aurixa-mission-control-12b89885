/**
 * The pointer records what a pass delivered, never what created the event.
 *
 * Measured 16 Sep 2026, 15:15: npc-test-76b3b3 merged a cascade whose tree
 * was prime@7674f46's, was stamped from the folded carrier's provenance
 * (fa292ce7, 84 commits earlier), and the drift scan read "84 commits behind
 * Prime" on a clone whose content matched prime's head outside its designed
 * exclusions. These pin the choice rule and the two writers' wiring of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { choosePointerAdvance, type PointerRow } from "./syncPointer.pure";

const row = (over: Partial<PointerRow>): PointerRow => ({
  status: "succeeded",
  delivered_sha: null,
  event: { source_sha: "aaaa", created_at: "2026-09-16T10:00:00Z" },
  ...over,
});

describe("choosePointerAdvance", () => {
  it("prefers the row's delivered head over the event's provenance", () => {
    const advance = choosePointerAdvance([
      row({ delivered_sha: "7674f46", event: { source_sha: "fa292ce", created_at: "2026-09-16T10:00:00Z" } }),
    ]);
    expect(advance).toEqual({
      sha: "7674f46",
      basis: "delivered",
      eventCreatedAt: "2026-09-16T10:00:00Z",
    });
  });

  it("falls back to provenance on a legacy row that never carried the column", () => {
    const advance = choosePointerAdvance([row({ delivered_sha: null })]);
    expect(advance).toEqual({ sha: "aaaa", basis: "provenance", eventCreatedAt: "2026-09-16T10:00:00Z" });
  });

  it("the newest EVENT wins, not the newest merge — out-of-order landings cannot walk it back", () => {
    const advance = choosePointerAdvance([
      // Listed in row-creation order; the older event's row comes first.
      row({ delivered_sha: "old", event: { source_sha: "p1", created_at: "2026-09-16T09:00:00Z" } }),
      row({ delivered_sha: "new", event: { source_sha: "p2", created_at: "2026-09-16T13:00:00Z" } }),
    ]);
    expect(advance?.sha).toBe("new");
  });

  it("a newest row with nothing usable is passed over for the next that has something", () => {
    const advance = choosePointerAdvance([
      row({ delivered_sha: null, event: { source_sha: null, created_at: "2026-09-16T13:00:00Z" } }),
      row({ delivered_sha: null, event: { source_sha: "p1", created_at: "2026-09-16T09:00:00Z" } }),
    ]);
    expect(advance).toEqual({ sha: "p1", basis: "provenance", eventCreatedAt: "2026-09-16T09:00:00Z" });
  });

  it("a delivered row on an OLDER event outranks provenance on a newer one", () => {
    /* The regression this partition exists to forbid: an event created later
       can carry provenance OLDER than what an earlier pass delivered, because
       that pass executed after the later event's creating push. Ranked by
       event recency alone, reconciling the legacy row late would walk the
       pointer backwards over an engine-stamped delivered head. */
    const advance = choosePointerAdvance([
      row({ delivered_sha: null, event: { source_sha: "p_old_label", created_at: "2026-09-16T13:00:00Z" } }),
      row({ delivered_sha: "x_delivered", event: { source_sha: "p1", created_at: "2026-09-16T09:00:00Z" } }),
    ]);
    expect(advance).toEqual({
      sha: "x_delivered",
      basis: "delivered",
      eventCreatedAt: "2026-09-16T09:00:00Z",
    });
  });

  it("an all-provenance history still advances exactly as it always did", () => {
    const advance = choosePointerAdvance([
      row({ delivered_sha: null, event: { source_sha: "p1", created_at: "2026-09-16T09:00:00Z" } }),
      row({ delivered_sha: null, event: { source_sha: "p2", created_at: "2026-09-16T13:00:00Z" } }),
    ]);
    expect(advance).toEqual({ sha: "p2", basis: "provenance", eventCreatedAt: "2026-09-16T13:00:00Z" });
  });

  it("only a succeeded row asserts content on the branch", () => {
    expect(
      choosePointerAdvance([row({ status: "skipped", delivered_sha: "x" }), row({ status: "pr_opened" })]),
    ).toBeNull();
  });

  it("no history, no advance", () => {
    expect(choosePointerAdvance([])).toBeNull();
    expect(choosePointerAdvance([row({ event: null })])).toBeNull();
  });
});

describe("the engine stamps delivery on every terminal claim about a revision", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");

  it("exactly seven verdicts carry the resolved head — a new one must decide, not inherit", () => {
    /* The seven: the in-sync/all-withheld skip, the deletions-all-withheld
       skip, the tree-identical "already proposed" skip, three `pr_opened`
       shapes, and the merged-on-green success. NOT the no-modules skip
       (nothing was compared), the clone-not-found skip, the dry run (never
       written), or any failure. */
    expect(engine.match(/delivered_sha: sourceSha,/g)).toHaveLength(7);
  });

  it("a verified no-op stamp is guarded by delivery and ungated by any proposal", () => {
    expect(engine).toContain('patch.status === "skipped" && patch.delivered_sha && !patch.pr_url');
  });

  it("the no-modules skip carries no delivery claim — nothing was compared", () => {
    const at = engine.indexOf("No installed modules — nothing to cascade");
    expect(at).toBeGreaterThan(-1);
    expect(engine.slice(at - 400, at + 400)).not.toContain("delivered_sha");
  });

  it("the already-proposed skip defers through its pr_url rather than stamping now", () => {
    const at = engine.indexOf("Already proposed — PR #");
    expect(at).toBeGreaterThan(-1);
    const patch = engine.slice(at - 200, at + 1000);
    expect(patch).toContain("pr_url: existing.url");
    expect(patch).toContain("delivered_sha: sourceSha");
  });
});

describe("the merge drain advances from the delivery, never the provenance", () => {
  const drain = readFileSync("src/server/cascadeMergeDrain.server.ts", "utf8");

  it("advanceClone selects the row's delivered head and derives through the shared rule", () => {
    expect(drain).toContain('.select("delivered_sha, cascade_events!inner(source_sha, created_at)")');
    expect(drain).toContain("choosePointerAdvance(");
  });

  it("the pointer, the redeploy and the backend range all take the chosen sha", () => {
    expect(drain).toContain("last_synced_sha: advance.sha,");
    expect(drain).toContain("sha: advance.sha,");
    expect(drain).toContain("toSha: advance.sha,");
    // The provenance spelling is gone from this file entirely: a reader who
    // finds `newest.source_sha` again has reintroduced the 84-commit lie.
    expect(drain).not.toContain("newest.source_sha");
  });
});
