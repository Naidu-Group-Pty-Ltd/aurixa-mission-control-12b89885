/**
 * The reading reaches a screen, and says four different things on it.
 *
 * Read through the source. The panel calls a server function that reads live
 * GitHub, so it is not renderable in this suite — and the two properties worth
 * pinning are not about pixels anyway. They are the two ways this class of
 * work has failed before in this fleet:
 *
 *  - a component written, documented, merged and rendered by NOTHING
 *    (`DimensionRail`, `TitleBlock`, `bd-chip` — three of them at once);
 *  - a reading that collapses "we could not check" into "you are fine", which
 *    is the defect `useAmlAccess` and `useBuilderStockMarketplaceFlag` each
 *    paid for separately.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const PANEL = "src/components/yggdrasil/backend-identity-panel.tsx";
const ROUTE = "src/routes/yggdrasil.tsx";

const panel = readFileSync(PANEL, "utf8");
const route = readFileSync(ROUTE, "utf8");

describe("the panel is mounted", () => {
  it("is imported and rendered by the Yggdrasil route", () => {
    // An unused export typechecks, lints and builds. Three components shipped
    // that way in this fleet's other repository and reached production
    // rendering nothing at all.
    expect(route).toContain("BackendIdentityPanel");
    expect(route).toMatch(/<BackendIdentityPanel\s*\/>/);
  });
});

describe("the four readings stay four", () => {
  it("draws every verdict, and only `own` in the clean colour", () => {
    // `no_backend` and `unreadable` are not findings, and they are not
    // clearances either. Colouring either of them like `own` would put a green
    // mark on the one screen whose purpose is to show this.
    const table = panel.slice(panel.indexOf("const VERDICT"), panel.indexOf("export function"));
    for (const v of ["foreign", "own", "no_backend", "unreadable"]) {
      expect(table, `${v} must be drawn`).toContain(`${v}:`);
    }
    const successLines = table.split("\n").filter((l) => l.includes("text-success"));
    expect(successLines).toHaveLength(1);
    expect(successLines[0]).toContain("own:");
  });

  it("lists everything that is not `own`, rather than findings alone", () => {
    // A clone with no backend recorded, or one that could not be read, is
    // work somebody owes. Filtering the list to `foreign` would hide both.
    expect(panel).toContain('r.reading.verdict !== "own"');
  });
});

describe("what the panel claims about its own coverage", () => {
  it("says the probe is the files that carry a pair, not the whole tree", () => {
    // Coverage travels with the answer, including the clean one — the
    // `layers=all` rule. An unqualified "every deployment reads its own
    // project" is a claim about a tree that was never walked.
    const clean = panel.slice(panel.indexOf("Every deployment reads its own project"));
    expect(clean).toContain("not the whole tree");
  });

  it("keeps the previous reading when a re-read fails", () => {
    // Blanking on error turns a lost signal into an empty panel, and an empty
    // panel looks exactly like a clean fleet.
    const handler = panel.slice(
      panel.indexOf("const run ="),
      panel.indexOf("// Everything that is not"),
    );
    expect(handler).toContain("toast.error");
    expect(handler).not.toMatch(/catch[\s\S]*setResult\(null\)/);
  });
});
