/**
 * Which clones a cascade fired from `/cascades` reaches.
 *
 * ## What this replaces
 *
 * The page worked its targets out as
 * `scope === "tagged" && selectedTags.length > 0 ? tagFilteredClones : clones`.
 * Read the other way round, that line says every scope except "By tag with a
 * tag chosen" is the whole fleet. "Manual select" had no picker at all, so it
 * was always the whole fleet, and "By tag" with no tag chosen was the whole
 * fleet too. The button counted the targets honestly, which is how a control
 * labelled as narrowing could fire at every tenant with nothing on the page
 * being untrue. The result rows were armed in the browser from that same list,
 * so nothing between the click and the GitHub App ever saw the scope the
 * operator had chosen.
 *
 * ## The rule
 *
 * **A scope that narrows never widens.** "All clones" is the only scope that
 * reaches the whole fleet. An empty or absent selection under "By tag" or
 * "Manual select" reaches nothing, so it is refused rather than read as "all".
 *
 * The page draws its count from this function and the server decides from it,
 * so the number on the button and the rows the server arms are one answer.
 *
 * Client-safe: pure. It lives in `src/lib` because the route reads it, and a
 * client module may not import from `src/server/**`.
 */

export const CASCADE_SCOPES = ["all", "tagged", "selected"] as const;
export type CascadeScope = (typeof CASCADE_SCOPES)[number];

/** A clone, as much of it as targeting reads. */
export type FleetClone = { id: string; tags?: readonly string[] | null };

export type CascadeSelection = {
  scope: CascadeScope;
  /** The tags chosen under "By tag". No other scope reads them. */
  tags?: readonly string[] | null;
  /** The clones picked under "Manual select". No other scope reads them. */
  cloneIds?: readonly string[] | null;
};

export type CascadeTargets =
  | { ok: true; cloneIds: string[] }
  | {
      ok: false;
      /** One sentence for the operator, shown beside the disabled button. */
      reason: string;
    };

/** "1 clone", "3 clones". */
export function countClones(n: number): string {
  return `${n} clone${n === 1 ? "" : "s"}`;
}

/** Trimmed, blank-free and de-duplicated, in first-seen order. */
function distinct(values: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function refuse(reason: string): CascadeTargets {
  return { ok: false, reason };
}

/**
 * The clones this selection reaches, in fleet order, or why it reaches none.
 *
 * Fleet order rather than pick order, so a manual pick and the same clones
 * reached by "All clones" arm their rows identically.
 */
export function resolveCascadeTargets(
  selection: CascadeSelection,
  fleet: readonly FleetClone[],
): CascadeTargets {
  switch (selection.scope) {
    case "all": {
      if (fleet.length === 0) return refuse("There are no clones in the fleet to cascade to.");
      return { ok: true, cloneIds: fleet.map((c) => c.id) };
    }
    case "tagged": {
      const tags = distinct(selection.tags);
      if (tags.length === 0) {
        return refuse(
          "No tag is chosen. By tag reaches only clones carrying a chosen tag, so with none chosen it reaches nothing.",
        );
      }
      const wanted = new Set(tags);
      const ids = fleet.filter((c) => (c.tags ?? []).some((t) => wanted.has(t))).map((c) => c.id);
      if (ids.length === 0) {
        return refuse(`No clone carries ${tags.map((t) => `#${t}`).join(" or ")}.`);
      }
      return { ok: true, cloneIds: ids };
    }
    case "selected": {
      const picked = distinct(selection.cloneIds);
      if (picked.length === 0) {
        return refuse(
          "No clone is picked. Manual select reaches only the clones picked, so with none picked it reaches nothing.",
        );
      }
      // A pick the fleet no longer holds is refused, not dropped: the count the
      // operator confirmed included it, and firing at the rest would make that
      // count untrue after the fact.
      const known = new Set(fleet.map((c) => c.id));
      const missing = picked.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return refuse(
          `${countClones(missing.length)} picked ${missing.length === 1 ? "is" : "are"} no longer in the fleet. Clear the selection and pick again.`,
        );
      }
      const wanted = new Set(picked);
      return { ok: true, cloneIds: fleet.filter((c) => wanted.has(c.id)).map((c) => c.id) };
    }
    default: {
      const scope: never = selection.scope;
      return refuse(`"${String(scope)}" is not a scope a cascade can be fired at.`);
    }
  }
}

/**
 * The same answer, held to the count the operator confirmed.
 *
 * The confirmation names a number of clones. If the fleet changed between the
 * page drawing that number and the server arming rows (a clone tagged, added
 * or deleted in the meantime), the server would reach a different set from the
 * one the operator agreed to. A count that no longer matches is refused, and
 * the operator is asked to confirm again against the fleet as it stands.
 */
export function confirmCascadeTargets(
  targets: CascadeTargets,
  confirmedCount: number,
): CascadeTargets {
  if (!targets.ok) return targets;
  if (targets.cloneIds.length !== confirmedCount) {
    return refuse(
      `This page showed ${countClones(confirmedCount)}, and the same selection now reaches ${countClones(targets.cloneIds.length)}. Reload the page and confirm again.`,
    );
  }
  return targets;
}
