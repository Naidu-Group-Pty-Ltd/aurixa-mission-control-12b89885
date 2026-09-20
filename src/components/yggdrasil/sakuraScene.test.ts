/**
 * What only a render could find.
 *
 * Every assertion here is a defect that typechecked, linted, passed the
 * geometry suite, and was still wrong on screen. They are pinned at the source
 * because the thing they are about — what WebGL draws — is not reachable from
 * a unit test, and the alternative is trusting that nobody puts them back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SCENE = readFileSync("src/components/yggdrasil/sakura-scene.tsx", "utf8");
const ROUTE = readFileSync("src/routes/yggdrasil.tsx", "utf8");
const TOOLBAR = readFileSync("src/components/yggdrasil/yggdrasil-toolbar.tsx", "utf8");

describe("the canopy is rendered by something", () => {
  // The rule this repository already holds for server exports, applied to the
  // view: a component nothing mounts is not shipped, it is merely written.
  it("is mounted by the route", () => {
    expect(ROUTE).toContain("YggdrasilCanopy");
    expect(ROUTE).toMatch(/<YggdrasilCanopy/);
  });

  it("is lazy, so the WebGL renderer is not in every page's bundle", () => {
    expect(ROUTE).toMatch(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\("@\/components\/yggdrasil\/yggdrasil-canopy"/);
  });

  it("can be switched away from", () => {
    // The diagram carries range-select and comparison; the canopy does not.
    // Losing the toggle would take those away to gain a look.
    expect(TOOLBAR).toContain("Canopy");
    expect(TOOLBAR).toContain("Diagram");
    expect(ROUTE).toContain("<YggdrasilTree");
  });
});

describe("instanced meshes say how many instances they have", () => {
  it("does not pad the blossom count", () => {
    // An InstancedMesh cannot be allocated at zero, so the BUFFER is padded to
    // one. Leaving `count` at that padding drew a single unwritten instance —
    // identity matrix, unit scale, at the origin — so a fleet where every clone
    // had failed rendered bare, correctly, with one enormous white flower at
    // the foot of the trunk.
    expect(SCENE).toContain("blossomMesh.count = flowers.length;");
    expect(SCENE).not.toMatch(/blossomMesh\.count\s*=\s*Math\.max\(/);
  });
});

describe("per-instance colour reaches the shader", () => {
  it("does not set vertexColors on the blossom material", () => {
    // `vertexColors: true` points the shader at a `color` attribute on the
    // GEOMETRY. An InstancedMesh takes its per-instance colour from
    // `instanceColor` instead, so with both set the canopy rendered grey on a
    // tree whose colour buffer was entirely correct.
    const block = SCENE.slice(SCENE.indexOf("const blossomMat"), SCENE.indexOf("const flowers"));
    expect(block).not.toContain("vertexColors");
  });

  it("writes the colours through setColorAt and flags the buffer", () => {
    expect(SCENE).toContain("blossomMesh.setColorAt(");
    expect(SCENE).toContain("instanceColor.needsUpdate = true");
  });
});

describe("colour is the document's, not the component's", () => {
  it("resolves the tokens rather than naming colours", () => {
    for (const token of [
      "--sakura-petal",
      "--sakura-petal-deep",
      "--sakura-bud",
      "--sakura-bark",
      "--sakura-bark-spent",
    ]) {
      expect(SCENE).toContain(token);
    }
  });

  it("lets the browser parse the value", () => {
    // `THREE.Color.setStyle` does not parse `oklch()`, which is what every
    // token in this theme is written in, and returns black without complaining.
    // Painting the value onto an element and reading back the computed `color`
    // works for whatever syntax the tokens are rewritten in later.
    expect(SCENE).toContain("getComputedStyle");
    expect(SCENE).not.toContain(".setStyle(");
  });

  it("carries a fallback for every token it reads", () => {
    const calls = [...SCENE.matchAll(/resolveToken\(\s*"(--[a-z-]+)"\s*,\s*"([^"]+)"/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const [, , fallback] of calls) expect(fallback).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("it degrades rather than failing", () => {
  it("reports an unavailable context instead of leaving a blank rectangle", () => {
    expect(SCENE).toContain("onUnavailable");
    expect(SCENE).toMatch(/WebGL is unavailable/);
  });

  it("honours prefers-reduced-motion", () => {
    expect(SCENE).toContain("prefers-reduced-motion");
    // Growth, bob, spin and auto-rotate all answer to it — a tree that keeps
    // turning is the one thing on this page that cannot be looked away from.
    expect(SCENE).toContain("autoRotate = !reduceMotion");
  });

  it("disposes what it allocated", () => {
    for (const call of ["renderer.dispose()", "controls.dispose()", "geometry.dispose()"]) {
      expect(SCENE).toContain(call);
    }
  });
});

describe("a drag is not a pick", () => {
  it("measures pointer travel before treating an up as a selection", () => {
    // Without this every camera orbit that ended over a branch selected it.
    expect(SCENE).toMatch(/Math\.hypot\(e\.clientX - downAt\.x, e\.clientY - downAt\.y\) > \d+/);
  });

  it("never selects the trunk", () => {
    // The prime is not a clone and has no panel to open.
    expect(SCENE).toContain('id !== "__trunk__"');
  });
});
