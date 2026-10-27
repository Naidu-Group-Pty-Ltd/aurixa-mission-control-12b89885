import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  confirmCascadeTargets,
  resolveCascadeTargets,
  type CascadeScope,
  type FleetClone,
} from "./cascadeTargets.pure";

const FLEET: FleetClone[] = [
  { id: "ncd", tags: ["crm", "au"] },
  { id: "crm", tags: ["crm"] },
  { id: "pre", tags: ["au"] },
  { id: "tst", tags: null },
];

describe("a scope that narrows never widens", () => {
  it("All clones reaches every clone, in fleet order", () => {
    expect(resolveCascadeTargets({ scope: "all" }, FLEET)).toEqual({
      ok: true,
      cloneIds: ["ncd", "crm", "pre", "tst"],
    });
  });

  it("All clones ignores a selection left over from another scope", () => {
    const out = resolveCascadeTargets({ scope: "all", tags: ["au"], cloneIds: ["pre"] }, FLEET);
    expect(out.ok && out.cloneIds).toEqual(["ncd", "crm", "pre", "tst"]);
  });

  /*
    The defect this closes. `cascades.tsx:200` read an empty tag list as the
    whole fleet, and "Manual select" had no picker, so both fired at every
    clone. Every empty spelling of a selection must reach nothing.
  */
  it("By tag with no tag chosen reaches nothing, however the emptiness is spelt", () => {
    for (const tags of [[], null, undefined, ["", "  "]]) {
      const out = resolveCascadeTargets({ scope: "tagged", tags }, FLEET);
      expect(out.ok, `tags=${JSON.stringify(tags)}`).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/No tag is chosen/);
    }
  });

  it("Manual select with nothing picked reaches nothing, however the emptiness is spelt", () => {
    for (const cloneIds of [[], null, undefined, ["", " "]]) {
      const out = resolveCascadeTargets({ scope: "selected", cloneIds }, FLEET);
      expect(out.ok, `cloneIds=${JSON.stringify(cloneIds)}`).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/No clone is picked/);
    }
  });

  it("no narrowing scope ever answers with the whole fleet for an empty selection", () => {
    for (const scope of ["tagged", "selected"] as CascadeScope[]) {
      const out = resolveCascadeTargets({ scope }, FLEET);
      expect(out.ok).toBe(false);
    }
  });
});

describe("By tag", () => {
  it("reaches only clones carrying a chosen tag", () => {
    expect(resolveCascadeTargets({ scope: "tagged", tags: ["crm"] }, FLEET)).toEqual({
      ok: true,
      cloneIds: ["ncd", "crm"],
    });
  });

  it("reaches a clone carrying ANY of the chosen tags, once", () => {
    expect(resolveCascadeTargets({ scope: "tagged", tags: ["crm", "au", "crm"] }, FLEET)).toEqual({
      ok: true,
      cloneIds: ["ncd", "crm", "pre"],
    });
  });

  it("refuses a tag no clone carries, naming it", () => {
    const out = resolveCascadeTargets({ scope: "tagged", tags: ["nz"] }, FLEET);
    expect(out).toEqual({ ok: false, reason: "No clone carries #nz." });
  });
});

describe("Manual select", () => {
  /* The acceptance line: firing at one picked clone arms exactly one row. */
  it("reaches exactly the one clone picked", () => {
    expect(resolveCascadeTargets({ scope: "selected", cloneIds: ["pre"] }, FLEET)).toEqual({
      ok: true,
      cloneIds: ["pre"],
    });
  });

  it("reaches the picked clones in fleet order, each once", () => {
    expect(
      resolveCascadeTargets({ scope: "selected", cloneIds: ["tst", "ncd", "tst"] }, FLEET),
    ).toEqual({ ok: true, cloneIds: ["ncd", "tst"] });
  });

  /*
    Dropping the stale pick and firing at the rest would reach a set the
    operator never confirmed.
  */
  it("refuses a pick the fleet no longer holds rather than dropping it", () => {
    const out = resolveCascadeTargets({ scope: "selected", cloneIds: ["ncd", "gone"] }, FLEET);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^1 clone picked is no longer in the fleet/);
  });
});

describe("the count the operator confirmed", () => {
  it("passes when the server reaches the number the page showed", () => {
    const out = confirmCascadeTargets(
      resolveCascadeTargets({ scope: "tagged", tags: ["au"] }, FLEET),
      2,
    );
    expect(out).toEqual({ ok: true, cloneIds: ["ncd", "pre"] });
  });

  it("refuses when the fleet moved between the confirmation and the fire", () => {
    const out = confirmCascadeTargets(resolveCascadeTargets({ scope: "all" }, FLEET), 3);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe(
        "This page showed 3 clones, and the same selection now reaches 4 clones. Reload the page and confirm again.",
      );
    }
  });

  it("passes a refusal through unchanged", () => {
    const refused = resolveCascadeTargets({ scope: "selected", cloneIds: [] }, FLEET);
    expect(confirmCascadeTargets(refused, 0)).toBe(refused);
  });
});

it("refuses a scope it does not know rather than guessing", () => {
  const out = resolveCascadeTargets({ scope: "everyone" as CascadeScope }, FLEET);
  expect(out.ok).toBe(false);
});

it("refuses an empty fleet even for All clones", () => {
  expect(resolveCascadeTargets({ scope: "all" }, []).ok).toBe(false);
});

/*
  The page used to arm the result rows itself, from the list it had just
  widened. The rows are armed by the server now, from this module's answer, so
  the browser must not be writing them.
*/
describe("the /cascades page fires through the server", () => {
  const page = readFileSync("src/routes/cascades.tsx", "utf8");

  it("draws its targets from this module", () => {
    expect(page).toContain("resolveCascadeTargets");
  });

  it("applies a template's selection whole, so an empty one clears the picks before it", () => {
    // Kept when the template's list was empty, the earlier picks made Fire
    // reach clones the template never named (Codex, on #370).
    const apply = page.slice(page.indexOf("onApply={(v: CascadeTemplateValue)"));
    const search = apply.slice(0, apply.indexOf("replace: true"));
    expect(search).toContain('tags: v.tags.join(",")');
    expect(search).toContain('picked: v.cloneIds.join(",")');
    expect(search).not.toMatch(/v\.(tags|cloneIds)\.length > 0/);
  });

  it("no longer falls back to the whole fleet", () => {
    expect(page).not.toMatch(/\?\s*tagFilteredClones\s*:\s*clones/);
  });

  it("arms no result rows and creates no event from the browser", () => {
    expect(page).not.toMatch(/from\("cascade_results"\)\s*\.insert/);
    expect(page).not.toMatch(/from\("cascade_events"\)\s*\.insert/);
  });
});
