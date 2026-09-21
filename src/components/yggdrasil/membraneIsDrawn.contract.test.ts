/**
 * A COMPONENT IS NOT SHIPPED UNTIL SOMETHING RENDERS IT.
 *
 * This is the clones' own rule, and it is here because the fleet has paid for
 * it twice in a row. The builder portal shipped `DimensionRail`, `TitleBlock`
 * and `bd-chip` — written, documented, merged and deployed with ZERO call
 * sites, across nineteen pages that mounted the shell and none that passed an
 * `aside`. Then the same thing happened one layer down, in the stylesheet
 * where `builderPortalUiMounted.spec.ts` could not look: seventeen unmounted
 * `.bd-*` rules landed and eleven more were already on `main`. An unused
 * export typechecks, lints and builds, and so does dead CSS.
 *
 * So the mounting is asserted on the SOURCE. Every assertion below was proven
 * non-vacuous by removing the thing it names and watching it fail.
 *
 * It asserts POSITION as well as presence, because a membrane drawn in the
 * wrong layer is a membrane the operator cannot click: the nodes are painted
 * with a glow filter and a band underneath one is a band nobody reaches.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../../server/sourceComments.pure";

const tree = stripComments(readFileSync("src/components/yggdrasil/yggdrasil-tree.tsx", "utf8"));
const layout = stripComments(readFileSync("src/components/yggdrasil/use-tree-layout.ts", "utf8"));
const band = stripComments(readFileSync("src/components/yggdrasil/membrane-band.tsx", "utf8"));
const panel = stripComments(
  readFileSync("src/components/yggdrasil/membrane-detail-panel.tsx", "utf8"),
);
const nodePanel = stripComments(
  readFileSync("src/components/yggdrasil/node-detail-panel.tsx", "utf8"),
);

const MEMBRANE_MODULES = [
  "src/lib/cascade/membrane/ionSpecies.pure.ts",
  "src/lib/cascade/membrane/membrane.pure.ts",
  "src/lib/cascade/membrane/fleetMembranes.pure.ts",
];

describe("the diagram draws the membranes", () => {
  it("imports the band and renders it", () => {
    expect(tree).toContain('from "./membrane-band"');
    expect(tree).toContain("<MembraneBand");
  });

  it("draws one per branch rather than one per clone", () => {
    // A membrane is a property of an EDGE. Keying it on a node would give the
    // two children of `npc-client-dashboard` one membrane between them.
    const at = tree.indexOf("layout.branches.map((branch) => ({");
    expect(at).toBeGreaterThan(-1);
    const block = tree.slice(at, at + 400);
    expect(block).toContain("resolveMembrane(branch.fromRepo, branch.toRepo)");
  });

  it("draws them AFTER the branches and BEFORE the nodes", () => {
    const branches = tree.indexOf("<TreeBranchPath");
    const bands = tree.indexOf("<MembraneBand");
    const nodes = tree.indexOf("<TreeNodeCircle");
    expect(branches).toBeGreaterThan(-1);
    expect(bands).toBeGreaterThan(branches);
    expect(nodes).toBeGreaterThan(bands);
  });

  it("keys the selection on the edge, never on the branch index", () => {
    // A resize re-runs the layout and a clone arriving re-orders it. An index
    // would move an open panel onto a different boundary without saying so.
    expect(tree).toContain("`${branch.fromRepo}->${branch.toRepo}`");
    expect(tree).toContain("selectedEdge === edge");
    expect(tree).not.toContain("selectedMembraneIndex");
  });

  it("mounts the detail panel the band's click opens", () => {
    expect(tree).toContain('from "./membrane-detail-panel"');
    expect(tree).toContain("<MembraneDetailPanel");
    const at = tree.indexOf("<MembraneDetailPanel");
    const block = tree.slice(at - 200, at + 300);
    expect(block).toContain("selectedMembrane &&");
    expect(block).toContain("setSelectedEdge(null)");
  });
});

describe("the layout carries what a membrane is keyed on", () => {
  it("puts both repositories on every branch", () => {
    expect(layout).toContain("fromRepo: string;");
    expect(layout).toContain("toRepo: string;");
    expect(layout).toContain("fromRepo: parentNode.githubRepo");
    expect(layout).toContain("toRepo: node.githubRepo");
  });

  it("gives the trunk the prime's own repository", () => {
    // The trunk stands for the prime, and a branch leaving it carries
    // `fromRepo` from this node. An empty string here resolves every root
    // edge to the default membrane, which is the failure that looks healthy.
    expect(layout).toContain('from "@/lib/cascade/membrane/fleetMembranes.pure"');
    expect(layout).toContain("githubRepo: PRIME_REPO");
  });
});

describe("the band survives a reader who cannot separate the colours", () => {
  it("draws a closed channel as a SHAPE, not only a hue", () => {
    // `--primary` and `--warning` are both gold in this product's dark theme.
    // The plug is a rect that is present or absent, so greyscale keeps it.
    const at = band.indexOf('channel.state === "open" ?');
    expect(at).toBeGreaterThan(-1);
    const block = band.slice(at, at + 900);
    expect(block).toContain("<rect");
    expect(block).toContain("strokeDasharray");
  });

  it("gives the whole band a reachable name", () => {
    expect(band).toContain('role="button"');
    expect(band).toContain("aria-label=");
    expect(band).toContain("tabIndex={0}");
  });

  it("is operable by keyboard, having claimed to be a control", () => {
    // An SVG `<g>` gets none of a real `<button>`'s behaviour for free.
    // `role` plus `tabIndex` and no key handler is a control a keyboard can
    // reach and cannot operate — worse than one it cannot reach at all.
    expect(band).toContain("onKeyDown");
    const at = band.indexOf("onKeyDown");
    const block = band.slice(at, at + 400);
    expect(block).toContain('e.key !== "Enter"');
    expect(block).toContain('e.key !== " "');
    expect(block).toContain("onSelect(membrane)");
  });
});

describe("the panel speaks to an operator", () => {
  it("prints the state as a word beside every channel", () => {
    expect(panel).toContain("CHANNEL_WORD");
    expect(panel).toContain('open: "Open"');
    expect(panel).toContain('closed: "Closed"');
    expect(panel).toContain('gated: "Gated"');
  });

  it("never prints the engine's own vocabulary for a hold", () => {
    // The clones' rule, from `partnerRoster.pure.ts`: database vocabulary
    // never reaches the operator.
    expect(panel).toContain("REASON_LABEL");
    expect(panel).toContain('manual_reconcile: "Held for a person to reconcile"');
  });

  it("cannot fall back to the identifier when a species is added", () => {
    // Exhaustive by TYPE, not by a `??`. `Record<string, string>` plus
    // `?? channel.species` compiles for ever and prints `routed_crm_name` at
    // an operator the day a sixth species lands; `Record<IonSpeciesName, …>`
    // fails the typecheck instead.
    expect(panel).toContain("Record<IonSpeciesName, string>");
    expect(panel).toContain('Record<IonChannel["reason"], string>');
    expect(panel).not.toContain("?? channel.species");
    expect(panel).not.toContain("?? channel.reason");
  });

  // A third assertion was written here and removed rather than patched: a
  // regex over JSX braces cannot tell a rendered field from a React `key`,
  // and it fired on `key={`${channel.species}:${channel.within}`}` — correct
  // code. A guard that cries wolf teaches people to dismiss it, which is the
  // reason `templateFormatFit` answers `unknown` rather than guessing. The
  // two assertions above close the class by TYPE, where nothing has to be
  // recognised at all.

  it("names the organs that already run at this boundary", () => {
    expect(panel).toContain("membrane.standing.map");
  });
});

describe("the registry stays reachable from a browser", () => {
  /**
   * The rule the BUILD found and `tsc` could not.
   *
   * TanStack Start refuses a route whose import chain reaches `src/server/**`
   * for a value, and it is right to: that root is allowed to grow an I/O
   * dependency tomorrow, so the boundary is the path rather than the current
   * contents. `npx tsc --noEmit` passed clean on the very commit
   * `npx vite build` refused. A rollup stack trace four frames deep is a poor
   * way to learn this, so it is named here as well — cheaply, and with the
   * reason attached.
   */
  it.each(MEMBRANE_MODULES)("%s imports no server module for a value", (path) => {
    const src = stripComments(readFileSync(path, "utf8"));
    for (const line of src.split("\n")) {
      if (!line.includes("@/server/")) continue;
      // A type-only import erases before the bundler sees it, which is how
      // `membrane.pure.ts` legitimately reaches the engine's HeldPath.
      expect(line).toMatch(/^\s*import\s+type\s/);
    }
  });

  it.each(MEMBRANE_MODULES)("%s reaches nothing that is not itself client-safe", (path) => {
    const src = stripComments(readFileSync(path, "utf8"));
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      const isTypeOnly = new RegExp(
        `import\\s+type[^"]*from\\s+"${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ).test(src);
      if (isTypeOnly) continue;
      // Either a sibling in this directory, or a module that has declared
      // itself client-safe. `@/lib/module-globs` says so in its own header.
      expect(spec === "@/lib/module-globs" || spec.startsWith("./")).toBe(true);
    }
  });

  it("the diagram reads the registry from lib, never from the server root", () => {
    for (const src of [tree, band, panel, layout]) {
      expect(src).not.toContain("@/server/cascade/membrane/");
    }
    expect(tree).toContain("@/lib/cascade/membrane/fleetMembranes.pure");
  });
});

describe("a selected clone says which boundaries it sits between", () => {
  it("renders membranesTouching rather than exporting it into nothing", () => {
    // The rule again, on the one export that had no caller: an unused export
    // typechecks, lints and builds. `membranesTouching` is the only primitive
    // that answers "what filters reach THIS deployment", and a node panel
    // silent about it says a clone receives whatever the prime sends.
    expect(nodePanel).toContain('from "@/lib/cascade/membrane/fleetMembranes.pure"');
    expect(nodePanel).toContain("membranesTouching(node.githubRepo)");
    expect(nodePanel).toContain("membranes.inbound");
    expect(nodePanel).toContain("membranes.outbound.map");
  });

  it("keys it on the repository, because that is what a membrane is keyed on", () => {
    // `node.id` is a clone uuid and `node.name` is a display label; neither
    // resolves any edge, and both would render an empty section under every
    // node while looking exactly like a fleet with no membranes.
    expect(nodePanel).not.toContain("membranesTouching(node.id)");
    expect(nodePanel).not.toContain("membranesTouching(node.name)");
  });

  it("names what is refused, not how many organs run", () => {
    // Every membrane in this fleet carries the same nine standing organs, so
    // a count of them prints the same number under every node and
    // distinguishes nothing.
    const at = nodePanel.indexOf("function MembraneLine");
    expect(at).toBeGreaterThan(-1);
    const block = nodePanel.slice(at, at + 900);
    expect(block).toContain('c.state === "closed"');
    expect(block).toContain('c.state === "gated"');
    expect(block).not.toContain("standing.length");
  });

  it("states the prime's absent inbound edge rather than drawing nothing", () => {
    // A blank area reads as a broken panel. The prime having no boundary
    // above it is a fact about the fleet.
    expect(nodePanel).toContain("this is the fleet's source");
  });
});
