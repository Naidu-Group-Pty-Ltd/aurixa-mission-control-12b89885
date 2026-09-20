import { describe, it, expect } from "vitest";
import {
  resolveCascadeSource,
  orderByLineageDepth,
  describeLineageHold,
  LINEAGE_HOLD_RETRY_MS,
  type ParentCloneRow,
} from "./cloneCascadeSource.pure";
import { FOLD_MAX_ATTEMPTS } from "./eventFold.pure";

const PRIME_SHA = "abc1234def5678";

const PARENT: ParentCloneRow = {
  id: "parent-id",
  name: "npc-client-dashboard",
  github_owner: "Naidu-Group-Pty-Ltd",
  github_repo: "npc-client-dashboard",
  default_branch: "main",
  last_synced_sha: PRIME_SHA,
};

function resolve(over: Partial<Parameters<typeof resolveCascadeSource>[0]> = {}) {
  return resolveCascadeSource({
    followsLineage: true,
    parentCloneId: PARENT.id,
    parent: PARENT,
    parentReadFailed: false,
    primeSha: PRIME_SHA,
    ...over,
  });
}

describe("resolveCascadeSource", () => {
  describe("with the switch off, nothing has changed", () => {
    it("reads prime even for a clone with a recorded parent", () => {
      expect(resolve({ followsLineage: false })).toEqual({ kind: "prime" });
    });

    it("reads prime even when the parent row could not be read", () => {
      // Off means off. No hold, no new failure mode, no behaviour the fleet
      // did not have before either migration existed.
      expect(resolve({ followsLineage: false, parent: null, parentReadFailed: true })).toEqual({
        kind: "prime",
      });
    });
  });

  it("reads prime when no parent is recorded", () => {
    // NULL is a recorded statement — 'this clone receives from prime' — and
    // is what every clone says until somebody says otherwise.
    expect(resolve({ parentCloneId: null, parent: null })).toEqual({ kind: "prime" });
  });

  it("reads the parent's default branch once the parent carries this prime commit", () => {
    expect(resolve()).toEqual({
      kind: "parent",
      parentId: "parent-id",
      ref: {
        owner: "Naidu-Group-Pty-Ltd",
        repo: "npc-client-dashboard",
        branch: "main",
      },
      label: "npc-client-dashboard",
    });
  });

  it("names the repository when the parent row carries no name", () => {
    const decision = resolve({ parent: { ...PARENT, name: null } });
    expect(decision).toMatchObject({ label: "Naidu-Group-Pty-Ltd/npc-client-dashboard" });
  });

  describe("holds rather than delivering the wrong tree", () => {
    it("holds while the parent still carries an older prime commit", () => {
      const decision = resolve({ parent: { ...PARENT, last_synced_sha: "0000111222333" } });

      expect(decision.kind).toBe("hold");
      expect(decision.kind === "hold" && decision.why).toContain("0000111");
      expect(decision.kind === "hold" && decision.why).toContain("abc1234");
    });

    it("holds while the parent has never delivered anything", () => {
      const decision = resolve({ parent: { ...PARENT, last_synced_sha: null } });
      expect(decision.kind).toBe("hold");
    });

    it("holds — never falls back to prime — when the parent read FAILED", () => {
      // The rule this repository keeps paying for. Prime's whole tree into a
      // clone configured for a filtered subset is the destructive outcome.
      const decision = resolve({ parent: null, parentReadFailed: true });

      expect(decision.kind).toBe("hold");
      expect(decision.kind === "hold" && decision.why).toMatch(/read that failed/i);
    });

    it("holds when the recorded parent names a row that does not exist", () => {
      const decision = resolve({ parent: null, parentReadFailed: false });
      expect(decision.kind).toBe("hold");
      expect(decision.kind === "hold" && decision.why).toContain("parent-id");
    });

    it("holds when the parent has no default branch to read", () => {
      for (const branch of [null, "", "   "]) {
        const decision = resolve({ parent: { ...PARENT, default_branch: branch } });
        expect(decision.kind).toBe("hold");
      }
    });
  });

  it("never resolves to prime for a clone whose parent is unusable", () => {
    // The property behind every hold above, stated once: with lineage on, a
    // clone that HAS a parent either reads that parent or reads nothing.
    const unusable = [
      { parent: null, parentReadFailed: true },
      { parent: null, parentReadFailed: false },
      { parent: { ...PARENT, last_synced_sha: null } },
      { parent: { ...PARENT, last_synced_sha: "older" } },
      { parent: { ...PARENT, default_branch: null } },
    ];

    for (const over of unusable) {
      expect(resolve(over).kind).not.toBe("prime");
    }
  });
});

describe("orderByLineageDepth", () => {
  const row = (id: string, parent: string | null) => ({ id, parent_clone_id: parent });

  it("puts parents before their children", () => {
    const ordered = orderByLineageDepth([
      row("preflight", "client-dashboard"),
      row("crm-independent", null),
      row("npc-test", "client-dashboard"),
      row("client-dashboard", null),
    ]);

    const ids = ordered.map((r) => r.id);
    expect(ids.indexOf("client-dashboard")).toBeLessThan(ids.indexOf("preflight"));
    expect(ids.indexOf("client-dashboard")).toBeLessThan(ids.indexOf("npc-test"));
  });

  it("orders a three-level chain root-first", () => {
    const ordered = orderByLineageDepth([
      row("grandchild", "child"),
      row("child", "root"),
      row("root", null),
    ]);

    expect(ordered.map((r) => r.id)).toEqual(["root", "child", "grandchild"]);
  });

  it("treats a clone whose parent is not in this pass as a root", () => {
    // It is not waiting on anything HERE, so sinking it behind work it does
    // not depend on would delay it for nothing.
    const ordered = orderByLineageDepth([row("orphan", "absent-parent"), row("root", null)]);

    expect(ordered.map((r) => r.id)).toEqual(["orphan", "root"]);
  });

  it("keeps input order within a depth, so a budgeted pass resumes where it stopped", () => {
    const ordered = orderByLineageDepth([row("a", null), row("b", null), row("c", null)]);
    expect(ordered.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("does not loop on a cycle the database should have refused", () => {
    const ordered = orderByLineageDepth([row("a", "b"), row("b", "a")]);
    expect(ordered.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns every row it was given, whatever the shape", () => {
    const rows = [
      row("preflight", "client-dashboard"),
      row("client-dashboard", null),
      row("orphan", "gone"),
      row("loop", "loop"),
    ];
    expect(orderByLineageDepth(rows)).toHaveLength(rows.length);
  });
});

describe("describeLineageHold", () => {
  const sentence = (over: Partial<Parameters<typeof describeLineageHold>[0]> = {}) =>
    describeLineageHold({
      held: 2,
      done: 1,
      total: 4,
      firstReason: "npc-test: Parent npc-client-dashboard carries prime@0000111.",
      until: "2026-09-20T09:35:00.000Z",
      ...over,
    });

  it("says what is waiting, how much got through, and when it may run again", () => {
    const s = sentence();
    expect(s).toContain("2 clones are held");
    expect(s).toContain("1 of 4 clone(s) done");
    expect(s).toContain("2026-09-20T09:35:00Z");
    expect(s).toContain("npc-client-dashboard");
  });

  it("agrees with itself about one held clone", () => {
    expect(sentence({ held: 1 })).toContain("1 clone is held");
  });

  it("never reads as a completion or a failure", () => {
    // The event is `pending`. A summary that said either would be a claim
    // about work that has not happened.
    expect(sentence()).not.toMatch(/\b(completed|failed|delivered)\b/i);
  });
});

describe("the pace a hold waits at", () => {
  it("is long enough that a pull request open overnight cannot exhaust the event", () => {
    // The drain spends an attempt per claim and refunds a deferral, so this
    // is belt and braces — but the number still has to be a pace rather than
    // a spin. At a one-minute tick, an 8-hour wait is ~480 claims; at this
    // pace it is ~96.
    const claimsInEightHours = (8 * 60 * 60 * 1000) / LINEAGE_HOLD_RETRY_MS;
    expect(claimsInEightHours).toBeLessThan(120);
    expect(LINEAGE_HOLD_RETRY_MS).toBeGreaterThan(FOLD_MAX_ATTEMPTS * 60 * 1000);
  });

  it("is short enough that a merge is picked up within a few minutes", () => {
    expect(LINEAGE_HOLD_RETRY_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
