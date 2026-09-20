/**
 * The clone tree is READ, never guessed.
 *
 * `buildHierarchy` replaced an inference over `tags[0]` + `created_at`. These
 * pin the properties that inference could not hold, and the two that the
 * replacement must not lose.
 */

import { describe, it, expect } from "vitest";
import { buildHierarchy, lineageDepth } from "./use-tree-layout";
import type { Clone } from "@/lib/queries";

/** Only the fields `buildHierarchy` reads; the rest of `Clone` is irrelevant here. */
function clone(id: string, parent: string | null, createdAt: string): Clone {
  return {
    id,
    parent_clone_id: parent,
    created_at: createdAt,
    tags: [],
  } as unknown as Clone;
}

/** The fleet as the operator's worktree diagram records it, 20 Sep 2026. */
const PRIME_CHILD_A = clone("client-dashboard", null, "2026-04-01T00:00:00Z");
const PRIME_CHILD_B = clone("crm-independent", null, "2026-09-19T00:00:00Z");
const GRANDCHILD_A = clone("preflight", "client-dashboard", "2026-06-01T00:00:00Z");
const GRANDCHILD_B = clone("npc-test", "client-dashboard", "2026-07-01T00:00:00Z");

const FLEET = [PRIME_CHILD_A, PRIME_CHILD_B, GRANDCHILD_A, GRANDCHILD_B];

describe("buildHierarchy", () => {
  it("draws the recorded tree: two clones off prime, two under the CRM-dependent one", () => {
    const map = buildHierarchy(FLEET);

    expect(map.get("__root__")).toEqual(["client-dashboard", "crm-independent"]);
    expect(map.get("client-dashboard")).toEqual(["preflight", "npc-test"]);
    expect(map.get("crm-independent")).toBeUndefined();
  });

  it("puts every clone on the trunk when nobody has recorded a parent", () => {
    // The state of the fleet before the column existed, and of any clone
    // nobody has classified. A flat fan is the honest drawing of "unknown",
    // where the old inference would have invented a root from a shared tag.
    const flat = FLEET.map((c) => ({ ...c, parent_clone_id: null }) as Clone);
    const map = buildHierarchy(flat);

    expect(map.get("__root__")).toHaveLength(4);
    for (const c of flat) expect(map.get(c.id)).toBeUndefined();
  });

  it("keeps a child visible when its parent is filtered out of the view", () => {
    // The status filter runs BEFORE layout. Filtering to "behind" must not
    // blank a clone that IS behind because its in-sync parent was filtered
    // away — the child stands on the trunk instead of vanishing with it.
    const map = buildHierarchy([GRANDCHILD_A, GRANDCHILD_B]);

    expect(map.get("__root__")).toEqual(["preflight", "npc-test"]);
  });

  it("supports depth beyond two, which the tag inference could not express", () => {
    const greatGrandchild = clone("deep", "preflight", "2026-08-01T00:00:00Z");
    const map = buildHierarchy([...FLEET, greatGrandchild]);

    expect(map.get("client-dashboard")).toContain("preflight");
    expect(map.get("preflight")).toEqual(["deep"]);
  });

  it("orders siblings oldest-first so the tree does not reshuffle between renders", () => {
    const shuffled = [GRANDCHILD_B, PRIME_CHILD_B, GRANDCHILD_A, PRIME_CHILD_A];

    expect(buildHierarchy(shuffled).get("client-dashboard")).toEqual(["preflight", "npc-test"]);
    expect(buildHierarchy(shuffled).get("__root__")).toEqual([
      "client-dashboard",
      "crm-independent",
    ]);
  });

  describe("a bad row cannot hang the render", () => {
    it("treats a clone that is its own parent as a root", () => {
      const selfParented = clone("loop", "loop", "2026-05-01T00:00:00Z");
      const map = buildHierarchy([selfParented]);

      expect(map.get("__root__")).toEqual(["loop"]);
    });

    it("treats a two-row cycle as roots rather than recursing forever", () => {
      // The database refuses this (`trg_clones_parent_acyclic`). The render
      // must not DEPEND on the database having been right: the worst a bad
      // row may do is draw in the wrong place.
      const a = clone("a", "b", "2026-05-01T00:00:00Z");
      const b = clone("b", "a", "2026-05-02T00:00:00Z");
      const map = buildHierarchy([a, b]);

      expect(map.get("__root__")).toEqual(["a", "b"]);
    });
  });
});

describe("lineageDepth", () => {
  it("counts the recorded tree, not the tag groups", () => {
    // Two clones on the trunk, two under one of them: two levels of clones.
    // The old reading counted distinct first-tags, which on this fleet is 0.
    expect(lineageDepth(FLEET)).toBe(2);
  });

  it("is 1 for a flat fan, whatever the tags say", () => {
    // The state of every fleet before anybody records a parent. The old
    // reading gave the number of distinct first-tags, which on this input is
    // 2 — a depth the tree does not have.
    const flat = [
      { ...clone("a", null, "2026-01-01T00:00:00Z"), tags: ["alpha"] } as Clone,
      { ...clone("b", null, "2026-02-01T00:00:00Z"), tags: ["beta"] } as Clone,
    ];
    expect(lineageDepth(flat)).toBe(1);
  });

  it("is 0 for no clones — there is no tree, so there is no trunk to count", () => {
    expect(lineageDepth([])).toBe(0);
  });

  it("does not move when somebody edits a tag", () => {
    // The property the old reading could not hold. `tags` is a cascade
    // TARGETING field, so a number derived from it changed the picture's
    // claim about lineage whenever somebody re-targeted a cascade.
    const retagged = FLEET.map((c) => ({ ...c, tags: ["something-else"] }) as Clone);
    expect(lineageDepth(retagged)).toBe(lineageDepth(FLEET));
  });

  it("terminates on a cycle the database would have refused", () => {
    // `buildHierarchy` already drops a cycle onto the trunk; this asserts the
    // depth walk cannot recurse forever even if that ever stopped being true.
    const cyclic = [
      clone("x", "y", "2026-01-01T00:00:00Z"),
      clone("y", "x", "2026-01-02T00:00:00Z"),
    ];
    expect(lineageDepth(cyclic)).toBe(1);
  });
});
