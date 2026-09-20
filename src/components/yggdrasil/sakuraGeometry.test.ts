/**
 * The geometry is the data, so these assert botany rather than pixels.
 *
 * Every one of these failed at least once while the module was being written,
 * which is the only reason to keep them: the first build drew a bare pole for a
 * fleet of forty — `buildHierarchy` files the prime's children under `__root__`
 * while the branch drawn for it is `__trunk__`, so the lookup found nothing and
 * every other number still looked plausible.
 */
import { describe, expect, it } from "vitest";
import {
  BRANCHING_EXPONENT,
  buildSakuraTree,
  opennessFor,
  type SakuraBranch,
} from "./sakuraGeometry.pure";
import type { Clone } from "@/lib/queries";

function fleet(spec: Array<[string, string | null, string?]>): Clone[] {
  return spec.map(([id, parent, status], i) => ({
    id,
    name: id,
    slug: id,
    tags: [],
    sync_status: status ?? "in_sync",
    github_repo: id,
    github_owner: "o",
    commits_behind: 0,
    parent_clone_id: parent,
    created_at: new Date(1700000000000 + i * 1000).toISOString(),
  })) as unknown as Clone[];
}

const flat = (n: number, status?: string) =>
  fleet(Array.from({ length: n }, (_, i) => [`c${i}`, null, status]));

const trunkOf = (bs: SakuraBranch[]) => bs.find((b) => b.id === "__trunk__");

describe("the fleet reaches the drawing", () => {
  it("draws a branch for the prime and one for every clone", () => {
    const t = buildSakuraTree(flat(12));
    expect(t.branches).toHaveLength(13);
    expect(trunkOf(t.branches)).toBeDefined();
  });

  it("gives the trunk the children buildHierarchy filed under __root__", () => {
    // The defect this module shipped with for its first build: a fleet of
    // forty drawn as a single pole, because `__trunk__` and `__root__` are
    // different keys and only one of them has children.
    const t = buildSakuraTree(flat(5));
    expect(t.branches.filter((b) => b.parentId === "__trunk__")).toHaveLength(5);
    expect(trunkOf(t.branches)?.subtreeSize).toBe(5);
  });

  it("draws nothing at all for an empty fleet but still stands", () => {
    const t = buildSakuraTree([]);
    expect(t.branches).toHaveLength(1);
    expect(t.blossoms).toHaveLength(0);
    expect(t.vitality).toBe(1);
  });

  it("carries the recorded depth, not an invented one", () => {
    const t = buildSakuraTree(
      fleet([
        ["a", null],
        ["b", "a"],
        ["c", "b"],
      ]),
    );
    expect(t.branches.map((b) => b.depth).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("da Vinci's rule — the tree grows because it carries more", () => {
  it("thickens the trunk as the fleet grows", () => {
    const r = [1, 3, 12, 40].map((n) => buildSakuraTree(flat(n)).trunkRadius);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
  });

  it("thickens it by the measured exponent, not linearly", () => {
    // Linear growth would make a fleet of 40 forty times the girth of one.
    // The pipe model makes it 40^(1/2.3) ≈ 5.0, which is why a large fleet is
    // a tree rather than a column.
    const one = buildSakuraTree(flat(1)).trunkRadius;
    const forty = buildSakuraTree(flat(40)).trunkRadius;
    expect(forty / one).toBeCloseTo(Math.pow(40, 1 / BRANCHING_EXPONENT), 5);
  });

  it("makes a bough that carries more thicker than its siblings", () => {
    const t = buildSakuraTree(
      fleet([
        ["heavy", null],
        ["light", null],
        ...Array.from({ length: 6 }, (_, i) => [`h${i}`, "heavy"] as [string, string]),
      ]),
    );
    const heavy = t.branches.find((b) => b.id === "heavy");
    const light = t.branches.find((b) => b.id === "light");
    expect(heavy?.radiusStart).toBeGreaterThan(light?.radiusStart ?? Infinity);
  });

  it("steps the radius down at a fork", () => {
    const t = buildSakuraTree(
      fleet([
        ["a", null],
        ["b", "a"],
        ["c", "a"],
      ]),
    );
    const a = t.branches.find((br) => br.id === "a") as SakuraBranch;
    expect(a.radiusEnd).toBeLessThan(a.radiusStart);
  });
});

describe("branches leave ALONG the parent, not from its tip", () => {
  it("spreads siblings over distinct heights", () => {
    const t = buildSakuraTree(flat(12));
    const kids = t.branches.filter((b) => b.parentId === "__trunk__");
    const heights = new Set(kids.map((k) => k.curve[0][1].toFixed(3)));
    // Twelve siblings sharing six heights is the clustering that interpolating
    // along the centreline exists to remove; anything near 12 is a tree.
    expect(heights.size).toBeGreaterThanOrEqual(kids.length - 1);
  });

  it("gives exactly one leader, and puts it at the tip", () => {
    const t = buildSakuraTree(flat(8));
    const kids = t.branches.filter((b) => b.parentId === "__trunk__");
    const leaders = kids.filter((k) => k.isLeader);
    expect(leaders).toHaveLength(1);
    const highest = Math.max(...kids.map((k) => k.curve[0][1]));
    expect(leaders[0].curve[0][1]).toBeCloseTo(highest, 6);
  });

  it("makes the biggest subtree the leader, so the trunk line follows the fleet", () => {
    const t = buildSakuraTree(
      fleet([
        ["small", null],
        ["big", null],
        ...Array.from({ length: 5 }, (_, i) => [`b${i}`, "big"] as [string, string]),
      ]),
    );
    const leader = t.branches.filter((b) => b.parentId === "__trunk__").find((b) => b.isLeader);
    expect(leader?.id).toBe("big");
  });
});

describe("nothing here is random", () => {
  it("draws the same fleet identically every time", () => {
    const a = buildSakuraTree(flat(9));
    const b = buildSakuraTree(flat(9));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("draws two structurally identical fleets differently", () => {
    // Variation is seeded from the clone's own id, so the picture is stable
    // per fleet without every fleet of the same shape being the same tree.
    const a = buildSakuraTree(
      fleet([
        ["x", null],
        ["y", null],
      ]),
    );
    const b = buildSakuraTree(
      fleet([
        ["p", null],
        ["q", null],
      ]),
    );
    expect(JSON.stringify(a.branches)).not.toBe(JSON.stringify(b.branches));
  });

  it("grows parents strictly before children", () => {
    const t = buildSakuraTree(
      fleet([
        ["a", null],
        ["b", "a"],
        ["c", "b"],
      ]),
    );
    const order = new Map(t.branches.map((b) => [b.id, b.growthOrder]));
    for (const b of t.branches) {
      if (b.parentId) expect(order.get(b.parentId)).toBeLessThan(b.growthOrder);
    }
  });
});

describe("a blossom is a statement about a clone", () => {
  it("keeps the three readings apart", () => {
    // `failed` is BARE, not a paler pink. Collapsing the two onto one scale is
    // how a red state comes to read as an amber one.
    expect(opennessFor("failed")).toBe(0);
    expect(opennessFor("behind")).toBeGreaterThan(0);
    expect(opennessFor("behind")).toBeLessThan(opennessFor("in_sync"));
    expect(opennessFor("in_sync")).toBe(1);
  });

  it("gives an unrecognised status a reading of its own", () => {
    const u = opennessFor("something-this-build-has-never-heard-of");
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(opennessFor("behind"));
  });

  it("puts no blossom on a failed clone", () => {
    const t = buildSakuraTree(
      fleet([
        ["ok", null, "in_sync"],
        ["bad", null, "failed"],
      ]),
    );
    expect(t.blossoms.filter((b) => b.branchId === "bad")).toHaveLength(0);
    expect(t.blossoms.filter((b) => b.branchId === "ok").length).toBeGreaterThan(0);
  });

  it("never flowers the trunk", () => {
    // The prime is not a clone. A cluster on it would put a sync status on
    // something that has none.
    const t = buildSakuraTree(flat(6));
    expect(t.blossoms.filter((b) => b.branchId === "__trunk__")).toHaveLength(0);
  });

  it("reports vitality as the fraction in sync", () => {
    expect(buildSakuraTree(flat(4, "in_sync")).vitality).toBe(1);
    expect(buildSakuraTree(flat(4, "failed")).vitality).toBe(0);
    expect(
      buildSakuraTree(
        fleet([
          ["a", null, "in_sync"],
          ["b", null, "failed"],
        ]),
      ).vitality,
    ).toBe(0.5);
  });
});

describe("the drawing cannot be broken by a bad row", () => {
  it("does not hang on a lineage cycle", () => {
    const t = buildSakuraTree(
      fleet([
        ["a", "b"],
        ["b", "a"],
      ]),
    );
    expect(t.branches.length).toBeGreaterThan(0);
  });

  it("stands a clone whose parent was filtered away on the trunk", () => {
    // The status filter runs before layout, so a visible clone whose parent is
    // not in the visible set must not vanish with it.
    const t = buildSakuraTree(fleet([["orphan", "missing-parent"]]));
    expect(t.branches.find((b) => b.id === "orphan")?.parentId).toBe("__trunk__");
  });

  it("never grows a branch downward", () => {
    const t = buildSakuraTree(flat(30));
    for (const b of t.branches) {
      expect(b.curve[b.curve.length - 1][1]).toBeGreaterThanOrEqual(b.curve[0][1] - 0.001);
    }
  });

  it("reports a height and a spread the camera can frame", () => {
    const t = buildSakuraTree(flat(20));
    expect(t.height).toBeGreaterThan(0);
    expect(t.spread).toBeGreaterThan(0);
    expect(Number.isFinite(t.height)).toBe(true);
  });
});
