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
const vocabulary = stripComments(
  readFileSync("src/components/yggdrasil/membraneVocabulary.ts", "utf8"),
);
const lists = stripComments(readFileSync("src/components/yggdrasil/membrane-lists.tsx", "utf8"));
const lateralBand = stripComments(
  readFileSync("src/components/yggdrasil/lateral-band.tsx", "utf8"),
);
const lateralPanel = stripComments(
  readFileSync("src/components/yggdrasil/lateral-detail-panel.tsx", "utf8"),
);

const MEMBRANE_MODULES = [
  "src/lib/cascade/membrane/ionSpecies.pure.ts",
  "src/lib/cascade/membrane/membrane.pure.ts",
  "src/lib/cascade/membrane/fleetMembranes.pure.ts",
  "src/lib/cascade/membrane/lateralMembranes.pure.ts",
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
  it("draws its channels and organs with the one list both membrane panels share", () => {
    // Written twice, the two panels drift: the day a species is labelled in
    // one and not the other — or one learns to print a glob — an operator is
    // shown two different rules for one channel. So each panel RENDERS the
    // shared list, and neither keeps a copy of the words it prints.
    for (const src of [panel, lateralPanel]) {
      expect(src).toContain('from "./membrane-lists"');
      expect(src).toContain("<MembraneChannelList");
      expect(src).toContain("<MembraneStandingList");
      expect(src).not.toContain("CHANNEL_WORD");
      expect(src).not.toContain("SPECIES_LABEL");
    }
    expect(lists).toContain('from "./membraneVocabulary"');
  });

  it("prints the state as a word beside every channel", () => {
    // Every row prints the word, and the word is printed in one place — the
    // mark the lateral band's key names a state with too.
    expect(lists).toContain("<ChannelStateWord state={channel.state}");
    expect(lists).toContain("{CHANNEL_WORD[state]}");
    expect(vocabulary).toContain('open: "Open"');
    expect(vocabulary).toContain('closed: "Closed"');
    expect(vocabulary).toContain('gated: "Gated"');
  });

  it("never prints the engine's own vocabulary for a hold", () => {
    // The clones' rule, from `partnerRoster.pure.ts`: database vocabulary
    // never reaches the operator.
    expect(lists).toContain("REASON_LABEL[channel.reason]");
    expect(lists).toContain("SPECIES_LABEL[channel.species]");
    expect(vocabulary).toContain('manual_reconcile: "Held for a person to reconcile"');
  });

  it("cannot fall back to the identifier when a species is added", () => {
    // Exhaustive by TYPE, not by a `??`. `Record<string, string>` plus
    // `?? channel.species` compiles for ever and prints `routed_crm_name` at
    // an operator the day a new species lands; `Record<IonSpeciesName, …>`
    // fails the typecheck instead — which is exactly what happened when the
    // lateral boundary added four.
    expect(vocabulary).toContain("Record<IonSpeciesName, string>");
    expect(vocabulary).toContain('Record<IonChannel["reason"], string>');
    for (const src of [panel, lists, lateralPanel]) {
      expect(src).not.toContain("?? channel.species");
      expect(src).not.toContain("?? channel.reason");
    }
  });

  // A third assertion was written here and removed rather than patched: a
  // regex over JSX braces cannot tell a rendered field from a React `key`,
  // and it fired on `key={`${channel.species}:${channel.within}`}` — correct
  // code. A guard that cries wolf teaches people to dismiss it, which is the
  // reason `templateFormatFit` answers `unknown` rather than guessing. The
  // two assertions above close the class by TYPE, where nothing has to be
  // recognised at all.

  it("names the organs that already run at this boundary", () => {
    expect(lists).toContain("standing.map");
    expect(panel).toContain("<MembraneStandingList standing={membrane.standing}");
    expect(lateralPanel).toContain("<MembraneStandingList standing={boundary.standing}");
  });

  it("keeps a press on a panel from panning the diagram behind it", () => {
    // The canvas starts a pan on a pointer-down anywhere inside it and
    // captures the pointer, so a drag on a panel's scrollbar moved the tree.
    for (const src of [panel, lateralPanel]) {
      expect(src).toContain("onPointerDown={(e) => e.stopPropagation()}");
    }
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
    for (const src of [tree, band, panel, layout, lists, lateralBand, lateralPanel]) {
      expect(src).not.toContain("@/server/cascade/membrane/");
    }
    expect(tree).toContain("@/lib/cascade/membrane/fleetMembranes.pure");
    expect(layout).toContain('from "@/lib/cascade/membrane/lateralMembranes.pure"');
  });

  it("reaches the lateral lane only through its server functions", () => {
    // A browser may import a `*.functions.ts` module, and nothing else under
    // `src/server/`: the functions are RPC stubs on the client, while the
    // module behind them holds the GitHub installation. Types erase.
    const serverLines = lateralPanel.split("\n").filter((l) => l.includes("@/server/"));
    expect(serverLines.length).toBeGreaterThan(0);
    for (const line of serverLines) {
      expect(line).toMatch(/"@\/server\/lateral-exchange\.functions"|^\s*import\s+type\s/);
    }
    for (const src of [tree, layout, lateralBand, lists]) {
      expect(src).not.toMatch(/from "@\/server\//);
    }
  });
});

describe("the diagram draws the boundary between the two parents", () => {
  it("imports the lateral band and renders it", () => {
    expect(tree).toContain('from "./lateral-band"');
    expect(tree).toContain("<LateralBand");
  });

  it("draws one per boundary the layout found, keyed on the boundary", () => {
    // Keyed on the boundary's own id, which names the two parents — never a
    // position in a list that a resize re-runs.
    const at = tree.indexOf("layout.laterals.map(");
    expect(at).toBeGreaterThan(-1);
    const block = tree.slice(at, at + 500);
    expect(block).toContain("<LateralBand");
    expect(block).toContain("key={lateral.boundary.id}");
    expect(block).toContain("toward={layout.trunkNode}");
  });

  it("draws it AFTER the branches and BEFORE the nodes, as the vertical bands are", () => {
    // After every branch so it is not buried under one; before every node so
    // the arch runs INTO the two nodes it joins rather than over them.
    const branches = tree.indexOf("<TreeBranchPath");
    const lateral = tree.indexOf("<LateralBand");
    const nodes = tree.indexOf("<TreeNodeCircle");
    expect(lateral).toBeGreaterThan(branches);
    expect(nodes).toBeGreaterThan(lateral);
  });

  it("finds the two parents by REPOSITORY, as a membrane is keyed", () => {
    // A node's id is a clone uuid and its name a display label; neither is
    // what the lateral registry declares, and matching on either would draw
    // no arch while looking exactly like a fleet with no lateral boundary.
    const at = layout.indexOf("export function lateralsFor");
    expect(at).toBeGreaterThan(-1);
    const block = layout.slice(at, at + 900);
    expect(block).toContain("FLEET_LATERALS");
    expect(block).toContain("node.githubRepo");
    expect(block).toContain("boundary.sides");
    expect(layout).toContain("laterals: lateralsFor(allNodes)");
  });

  it("mounts the detail panel the band's click opens, in the same slot as a membrane's", () => {
    expect(tree).toContain('from "./lateral-detail-panel"');
    const at = tree.indexOf("<LateralDetailPanel");
    expect(at).toBeGreaterThan(-1);
    const block = tree.slice(at - 200, at + 300);
    expect(block).toContain("selectedLateralBoundary &&");
    expect(block).toContain("setSelectedLateral(null)");
    // One slot between the two kinds of membrane: opening either closes the
    // other, so one panel never opens on top of the other.
    const lateralSelect = tree.slice(tree.indexOf("const handleLateralSelect"));
    expect(lateralSelect.slice(0, 300)).toContain("setSelectedEdge(null)");
    const membraneSelect = tree.slice(tree.indexOf("const handleMembraneSelect"));
    expect(membraneSelect.slice(0, 300)).toContain("setSelectedLateral(null)");
  });

  it("gives the band a reachable name and a keyboard", () => {
    expect(lateralBand).toContain('role="button"');
    expect(lateralBand).toContain("tabIndex={0}");
    expect(lateralBand).toContain("aria-label=");
    const at = lateralBand.indexOf("onKeyDown");
    expect(at).toBeGreaterThan(-1);
    const block = lateralBand.slice(at, at + 400);
    expect(block).toContain('e.key !== "Enter"');
    expect(block).toContain('e.key !== " "');
    expect(block).toContain("onSelect(boundary)");
  });

  it("draws each lane's rule as a SHAPE, not only a hue", () => {
    const at = lateralBand.indexOf('state === "closed" || state === "gated"');
    expect(at).toBeGreaterThan(-1);
    const block = lateralBand.slice(at, at + 900);
    expect(block).toContain("<rect");
    expect(block).toContain("strokeDasharray");
  });

  it("draws each lane by the way the band was turned, never by a fixed side", () => {
    // Fixed `dir={1}` / `dir={-1}` points every lane the wrong way the day the
    // layout draws the independent parent on the left.
    expect(lateralBand).toContain("placement.bSign");
    expect(lateralBand).not.toMatch(/dir=\{-?1\}/);
  });
});

describe("the lateral panel speaks to an operator", () => {
  it("translates every word the lane uses internally, exhaustively by type", () => {
    for (const type of [
      "LateralBoundaryOutcome",
      "LateralDirectionOutcome",
      "LateralMode",
      "LateralReconcileState",
    ]) {
      expect(lateralPanel).toContain(`Record<${type}, string>`);
    }
  });

  it("never reports a refusal, or a failed read, as a boundary nothing has crossed", () => {
    // `audit_log` refuses a reader without the operator role. Rendered as an
    // empty lane, that refusal is the confident-empty reading this product
    // keeps paying for.
    expect(lateralPanel).toContain('{ kind: "forbidden" }');
    const forbidden = lateralPanel.indexOf('ledger.kind === "forbidden"');
    const failed = lateralPanel.indexOf('ledger.kind === "failed"');
    const empty = lateralPanel.indexOf("No exchange has run");
    expect(forbidden).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(Math.max(forbidden, failed));
  });

  it("offers no action on a boundary whose state it could not read", () => {
    // A pause button that does not know whether it is paused offers the wrong one.
    expect(lateralPanel).toContain('const mayAct = ledger.kind === "ready"');
    expect(lateralPanel).toContain("{mayAct ? (");
  });

  it("asks twice before a run, and says on the button what the run may do", () => {
    const ask = lateralPanel.indexOf("setConfirmRun(true)");
    const confirm = lateralPanel.indexOf("{confirmRun ? (");
    const run = lateralPanel.indexOf('act("run")');
    expect(confirm).toBeGreaterThan(-1);
    // The run is reachable only inside the confirmation branch.
    expect(run).toBeGreaterThan(confirm);
    expect(ask).toBeGreaterThan(run);
    expect(lateralPanel.split('act("run")').length - 1).toBe(1);
    expect(lateralPanel).toContain('{busy === "run" ? "Running…" : runWarning}');
  });
});

describe("a selected clone says which boundaries it sits between", () => {
  it("names the boundary BESIDE it, both ways, keyed on the repository", () => {
    expect(nodePanel).toContain('from "@/lib/cascade/membrane/lateralMembranes.pure"');
    expect(nodePanel).toContain("lateralsTouching(node.githubRepo)");
    expect(nodePanel).toContain("<LateralLine");
    const at = nodePanel.indexOf("function LateralLine");
    expect(at).toBeGreaterThan(-1);
    const block = nodePanel.slice(at, at + 900);
    // Two directions, counted separately: the CRM line runs opposite ways.
    expect(block).toContain("boundary.toward[repo]");
    expect(block).toContain("boundary.toward[other]");
  });

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
