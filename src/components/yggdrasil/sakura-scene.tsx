/**
 * The world tree, drawn in WebGL.
 *
 * `sakuraGeometry.pure.ts` decides the SHAPE — that is where the botany and
 * every fleet fact live, and it is tested without a renderer. This file draws
 * what that module returned and does not decide anything about the tree.
 *
 * Four things it is responsible for, all of them presentation:
 *
 *  - **Growth.** Branches extend in `growthOrder`, which is depth-first
 *    pre-order, so a bough is always finished before anything grows off it.
 *    Implemented by walking each tube's `drawRange` rather than rebuilding
 *    geometry, so a forty-clone fleet animates without allocating per frame.
 *  - **Blossoms**, as one instanced mesh. A fleet of forty carries ~250
 *    clusters; that is one draw call, not 250.
 *  - **Petals**, likewise instanced, falling from the blossoms that exist.
 *  - **Selection**, by raycast, handed back through the same `onSelect` the
 *    SVG view uses — so picking a clone means the same thing in both.
 *
 * ## Colour comes from the document, never from here
 *
 * A material needs a real colour rather than a class, which is how a 3D scene
 * usually ends up with a private palette that a theme change never reaches.
 * `resolveToken` reads the CSS custom property off the live document and lets
 * the BROWSER normalise it — a temporary element is painted with the value and
 * the computed `color` read back, which works for `oklch()` and for whatever
 * syntax the tokens are rewritten in later. `THREE.Color.setStyle` parses a
 * much smaller grammar and would have silently rendered black.
 *
 * ## It degrades rather than failing
 *
 * No WebGL context means `onUnavailable` fires and the caller shows the SVG
 * instead. A blank canvas that reports nothing is the shape of a broken page;
 * a view that says which one it is and offers the other is not.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SakuraTree } from "./sakuraGeometry.pure";

interface Props {
  tree: SakuraTree;
  /** Clone id to pulse, from the page's search/highlight. */
  highlightId?: string | null;
  selectedId?: string | null;
  onSelect?: (cloneId: string | null) => void;
  /** Fires once if a WebGL context cannot be had, so the caller can fall back. */
  onUnavailable?: (reason: string) => void;
  /** Replays the growth animation when this changes. */
  growthKey?: string;
}

/** Seconds a single branch takes to extend. */
const BRANCH_GROW_SECONDS = 0.55;
/** Seconds between one branch starting and the next. */
const GROW_STAGGER = 0.045;
/** Petals in the falling system, independent of fleet size. */
const PETAL_COUNT = 190;

/**
 * A CSS custom property as a THREE colour.
 *
 * The browser does the parsing: the value is painted onto a detached element
 * and the computed `color` read back as `rgb()`. That is what makes `oklch()`
 * work — `THREE.Color.setStyle` does not parse it and returns black without
 * complaining, which is a theme silently not reaching the scene.
 */
function resolveToken(name: string, fallback: string): THREE.Color {
  const c = new THREE.Color(fallback);
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return c;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return c;
    const probe = document.createElement("span");
    probe.style.color = raw;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = /rgba?\(([^)]+)\)/.exec(computed);
    if (!m) return c;
    const [r, g, b] = m[1].split(/[, ]+/).map(Number);
    if ([r, g, b].some((n) => !Number.isFinite(n))) return c;
    c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  } catch {
    // A palette we cannot read is the fallback's job, not a reason to throw
    // away the tree.
  }
  return c;
}

/** One petal: a rounded lobe, notched at the tip the way a cherry's is. */
function petalGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.5);
  shape.bezierCurveTo(0.42, -0.24, 0.38, 0.32, 0.1, 0.48);
  // The notch. It is two curves rather than a point, because the notch is the
  // one feature that tells a cherry from a plum at a glance.
  shape.bezierCurveTo(0.04, 0.38, -0.04, 0.38, -0.1, 0.48);
  shape.bezierCurveTo(-0.38, 0.32, -0.42, -0.24, 0, -0.5);
  return new THREE.ShapeGeometry(shape, 8);
}

/**
 * A flower: five petals around a centre.
 *
 * The first render instanced a single PETAL per blossom, which at a thousand
 * instances reads as confetti caught in the branches rather than as blossom.
 * Five petals in one geometry costs five times the vertices on a mesh whose
 * instance count is unchanged — one draw call either way — and it is the
 * difference between a pink haze and a cherry tree.
 */
function flowerGeometry(): THREE.BufferGeometry {
  const petals: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const g = petalGeometry();
    g.translate(0, 0.42, 0);
    g.rotateZ((i / 5) * Math.PI * 2);
    // Cupped, so the flower catches light across its face instead of
    // disappearing edge-on every time the camera comes round.
    g.rotateX(-0.42);
    petals.push(g);
  }
  const merged = mergeGeometries(petals, false) ?? petals[0];
  for (const g of petals) if (g !== merged) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

export function SakuraScene({
  tree,
  highlightId,
  selectedId,
  onSelect,
  onUnavailable,
  growthKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  // Latest values the animation loop reads. Kept in refs so changing the
  // selection does not tear down and rebuild the scene.
  const selectedRef = useRef(selectedId);
  const highlightRef = useRef(highlightId);
  const selectRef = useRef(onSelect);
  selectedRef.current = selectedId;
  highlightRef.current = highlightId;
  selectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      setFailed(true);
      onUnavailable?.(e instanceof Error ? e.message : "WebGL is unavailable");
      return;
    }
    if (!renderer.getContext()) {
      setFailed(true);
      onUnavailable?.("WebGL is unavailable in this browser");
      return;
    }

    const reduceMotion =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, Math.max(420, host.clientHeight));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();

    const petalCol = resolveToken("--sakura-petal", "#f6c8da");
    const petalDeep = resolveToken("--sakura-petal-deep", "#e79ab9");
    const budCol = resolveToken("--sakura-bud", "#d98a76");
    const barkCol = resolveToken("--sakura-bark", "#6b5443");
    const barkSpent = resolveToken("--sakura-bark-spent", "#463a31");
    const primaryCol = resolveToken("--primary", "#7cc6e8");
    const warnCol = resolveToken("--warning", "#e0b35c");

    // ── Camera framed on the tree the geometry actually produced, so a
    //    one-clone sapling and a forty-clone canopy are both in shot without
    //    anybody choosing a number.
    const reach = Math.max(tree.height, tree.spread * 1.5, 4);
    const camera = new THREE.PerspectiveCamera(
      42,
      host.clientWidth / Math.max(420, host.clientHeight),
      0.1,
      400,
    );
    camera.position.set(reach * 0.92, tree.height * 0.62, reach * 1.35);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, tree.height * 0.45, 0);
    controls.minDistance = 2.5;
    controls.maxDistance = reach * 4;
    // Never below the ground plane: a tree seen from underneath reads as a
    // broken camera rather than as a view.
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.autoRotate = !reduceMotion;
    controls.autoRotateSpeed = 0.28;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a2e24, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(reach, tree.height * 1.7, reach * 0.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(primaryCol.getHex(), 0.85);
    rim.position.set(-reach, tree.height * 0.7, -reach);
    scene.add(rim);

    // ── Wood. One tube per branch; `drawRange` is what grows.
    const treeGroup = new THREE.Group();
    scene.add(treeGroup);

    const barkMat = new THREE.MeshStandardMaterial({
      color: barkCol,
      roughness: 0.92,
      metalness: 0.02,
    });
    const spentMat = new THREE.MeshStandardMaterial({
      color: barkSpent,
      roughness: 0.98,
      metalness: 0,
    });

    interface Limb {
      mesh: THREE.Mesh;
      total: number;
      startAt: number;
      cloneId: string;
    }
    const limbs: Limb[] = [];

    for (const b of tree.branches) {
      const path = new THREE.CatmullRomCurve3(
        b.curve.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      );
      const radial = b.depth === 0 ? 12 : Math.max(5, 9 - b.depth);
      const geo = new THREE.TubeGeometry(
        path,
        Math.max(8, b.curve.length * 3),
        b.radiusStart,
        radial,
        false,
      );
      // Taper: TubeGeometry is a constant radius, so the tip is pulled in by
      // scaling each ring toward the centreline by how far along it sits.
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const segs = Math.max(8, b.curve.length * 3);
      const ratio = b.radiusEnd / b.radiusStart;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const k = 1 + (ratio - 1) * t;
        const p = path.getPointAt(Math.min(1, t));
        for (let j = 0; j <= radial; j++) {
          const idx = i * (radial + 1) + j;
          if (idx >= pos.count) continue;
          pos.setXYZ(
            idx,
            p.x + (pos.getX(idx) - p.x) * k,
            p.y + (pos.getY(idx) - p.y) * k,
            p.z + (pos.getZ(idx) - p.z) * k,
          );
        }
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, b.syncStatus === "failed" ? spentMat : barkMat);
      mesh.userData.cloneId = b.id;
      treeGroup.add(mesh);
      limbs.push({
        mesh,
        total: geo.index ? geo.index.count : 0,
        startAt: b.growthOrder * GROW_STAGGER,
        cloneId: b.id,
      });
    }

    // ── Blossoms, instanced. Colour per instance carries the clone's status.
    const blossomGeo = flowerGeometry();
    // `vertexColors` is deliberately NOT set. An InstancedMesh takes its
    // per-instance colour from `instanceColor`, and `vertexColors: true` makes
    // the shader look for a `color` attribute on the GEOMETRY instead — which
    // this geometry does not have, so the first render drew a grey canopy on a
    // tree whose colours were all correct in the buffer.
    const blossomMat = new THREE.MeshStandardMaterial({
      roughness: 0.68,
      metalness: 0,
      side: THREE.DoubleSide,
      // A petal is thin and backlit in life. A little emissive keeps the canopy
      // legible against a dark console — tinted with the petal rather than
      // white, because white emissive desaturates the colour underneath it.
      emissive: petalCol.clone(),
      emissiveIntensity: 0.22,
    });
    const flowers = tree.blossoms.filter((b) => b.openness > 0);
    const blossomMesh = new THREE.InstancedMesh(
      blossomGeo,
      blossomMat,
      Math.max(1, flowers.length),
    );
    blossomMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // An InstancedMesh cannot be allocated at zero, so the buffer is padded to
    // one — but `count` must then be the TRUTH. Left at the padded 1, a fleet
    // with nothing in bloom drew a single unwritten instance: identity matrix,
    // unit scale, at the origin. A tree where every clone had failed rendered
    // bare, correctly, with one enormous white flower at the foot of it.
    blossomMesh.count = flowers.length;
    const branchOrder = new Map(tree.branches.map((b) => [b.id, b.growthOrder]));
    flowers.forEach((f, i) => {
      // Two pinks rather than one: a canopy of a single flat colour reads as
      // plastic, and a real cherry is deeper at the centre of each cluster.
      const c = f.syncStatus === "in_sync" ? (i % 3 === 0 ? petalDeep : petalCol) : budCol;
      blossomMesh.setColorAt(i, c);
    });
    if (blossomMesh.instanceColor) blossomMesh.instanceColor.needsUpdate = true;
    treeGroup.add(blossomMesh);

    // ── Petals. Seeded per petal so the drift is stable across renders.
    // Unlit on purpose: under a 2.4-intensity key light a standard material
    // saturates and a pink petal renders white, which is what turned the first
    // render's fall into snow.
    const petalMat = new THREE.MeshBasicMaterial({
      color: petalCol,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    const petals = new THREE.InstancedMesh(petalGeometry(), petalMat, PETAL_COUNT);
    petals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(petals);

    const petalSeed = Array.from({ length: PETAL_COUNT }, (_, i) => {
      const src = flowers.length ? flowers[i % flowers.length].position : ([0, 1, 0] as const);
      return {
        x: src[0] + ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 1.8,
        y: src[1],
        z: src[2] + ((Math.sin(i * 78.233) * 12345.6789) % 1) * 1.8,
        fall: 0.26 + ((i * 37) % 60) / 160,
        sway: 0.4 + ((i * 17) % 50) / 60,
        phase: (i * GOLDEN) % (Math.PI * 2),
        spin: 0.4 + ((i * 29) % 40) / 50,
      };
    });

    // ── Ground shadow: a soft disc, so the tree is standing on something.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(2.5, tree.spread * 1.25), 48),
      new THREE.MeshBasicMaterial({
        color: barkSpent,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.002;
    scene.add(ground);

    // ── Selection
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downAt = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      // A drag is a camera move, not a pick.
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(treeGroup.children, false)[0];
      const id = hit?.object.userData.cloneId as string | undefined;
      selectRef.current?.(id && id !== "__trunk__" ? id : null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // ── Loop
    const clock = new THREE.Clock();
    const dummy = new THREE.Object3D();
    let raf = 0;
    let disposed = false;

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const t = clock.getElapsedTime();

      for (const limb of limbs) {
        const p = reduceMotion
          ? 1
          : Math.min(1, Math.max(0, (t - limb.startAt) / BRANCH_GROW_SECONDS));
        // Eased so a branch decelerates into its final length.
        const eased = p * p * (3 - 2 * p);
        limb.mesh.visible = eased > 0;
        limb.mesh.geometry.setDrawRange(0, Math.ceil(limb.total * eased));
        const isSel = limb.cloneId === selectedRef.current;
        const isHi = limb.cloneId === highlightRef.current;
        const mat = limb.mesh.material as THREE.MeshStandardMaterial;
        if (isSel || isHi) {
          mat.emissive.copy(isSel ? primaryCol : warnCol);
          mat.emissiveIntensity = 0.32 + Math.sin(t * 3.4) * 0.14;
        }
      }

      flowers.forEach((f, i) => {
        const after = (branchOrder.get(f.branchId) ?? 0) * GROW_STAGGER + BRANCH_GROW_SECONDS;
        const p = reduceMotion ? 1 : Math.min(1, Math.max(0, (t - after) / 0.5));
        // Ease-out-back, so a blossom opens past its size and settles.
        const s = p <= 0 ? 0 : 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
        const bob = reduceMotion ? 0 : Math.sin(t * 1.3 + f.roll * 3) * 0.012;
        dummy.position.set(f.position[0], f.position[1] + bob, f.position[2]);
        dummy.rotation.set(f.roll * 1.7, f.roll, f.roll * 0.6 + (reduceMotion ? 0 : t * 0.06));
        const scl = f.scale * Math.max(0, s) * (0.6 + f.openness * 0.4);
        dummy.scale.setScalar(scl);
        dummy.updateMatrix();
        blossomMesh.setMatrixAt(i, dummy.matrix);
      });
      blossomMesh.instanceMatrix.needsUpdate = true;

      // Petals fall faster from a tree that is losing them — fleet health is
      // ambient here rather than another badge.
      const shed = reduceMotion ? 0 : 0.55 + (1 - tree.vitality) * 1.1;
      for (let i = 0; i < PETAL_COUNT; i++) {
        const s = petalSeed[i];
        const span = Math.max(1.5, s.y);
        const y = span - ((t * s.fall * shed + s.phase) % (span + 0.6));
        const drift = Math.sin(t * s.sway + s.phase) * 0.42;
        dummy.position.set(s.x + drift, y, s.z + Math.cos(t * s.sway * 0.8 + s.phase) * 0.36);
        dummy.rotation.set(t * s.spin, t * s.spin * 0.7, s.phase);
        dummy.scale.setScalar(y < 0.05 || flowers.length === 0 ? 0 : 0.075 + (i % 5) * 0.012);
        dummy.updateMatrix();
        petals.setMatrixAt(i, dummy.matrix);
      }
      petals.instanceMatrix.needsUpdate = true;

      controls.update();
      renderer.render(scene, camera);
    };
    frame();

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = Math.max(420, host.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      for (const limb of limbs) limb.mesh.geometry.dispose();
      blossomGeo.dispose();
      petals.geometry.dispose();
      blossomMat.dispose();
      petalMat.dispose();
      barkMat.dispose();
      spentMat.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
    // `growthKey` replays the animation; the tree itself rebuilds the scene.
  }, [tree, growthKey, onUnavailable]);

  if (failed) return null;
  return <div ref={hostRef} className="h-[560px] w-full" aria-hidden="true" />;
}

/** Golden angle, for petal phase spread. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
