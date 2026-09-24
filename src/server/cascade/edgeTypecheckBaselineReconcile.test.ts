import { describe, expect, it } from "vitest";
import {
  EDGE_TYPECHECK_BASELINE_PATH,
  describeKeptCounts,
  reconcileEdgeTypecheckBaseline,
} from "./edgeTypecheckBaselineReconcile.pure";

const COMMENT =
  "WP-14: per-file type-error counts for supabase/functions entry points, frozen so new errors " +
  "fail CI while the existing backlog is worked down. Regenerate with " +
  "`node scripts/security/check-edge-functions.mjs --update`. Numbers may only go down.";

/** Exactly what `check-edge-functions.mjs --update` writes. */
function baseline(files: Record<string, number>): string {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const total = Object.values(sorted).reduce((s, n) => s + n, 0);
  return `${JSON.stringify({ $comment: COMMENT, generated_total: total, files: sorted }, null, 2)}\n`;
}

const MANAGE_CI = "supabase/functions/manage-ci-assessments/index.ts";
const SHARED = "supabase/functions/_shared/agent-tools-registry.ts";
const LISTINGS = "supabase/functions/listings-cache/index.ts";
const CRM_ONLY = "supabase/functions/crm-send-message/index.ts";

describe("the Edge Function type baseline follows the files it counts", () => {
  it("is the path the gate reads", () => {
    expect(EDGE_TYPECHECK_BASELINE_PATH).toBe(
      "supabase/functions-registry/edge-typecheck-baseline.json",
    );
  });

  it("keeps the clone's count for a file the clone keeps — cascade #23, measured", () => {
    // Prime fixed manage-ci-assessments and dropped its entry. The clone's
    // copy is outside its scope, still carries four errors, and does not
    // cross — so prime's baseline read it as 0 → 4.
    const primeJson = baseline({ [SHARED]: 6, [LISTINGS]: 4 });
    const cloneJson = baseline({ [SHARED]: 6, [LISTINGS]: 4, [MANAGE_CI]: 4 });
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson,
      cloneJson,
      primeSha: new Map([
        [MANAGE_CI, "fixed"],
        [SHARED, "s"],
        [LISTINGS, "l"],
      ]),
      cloneSha: new Map([
        [MANAGE_CI, "older"],
        [SHARED, "s"],
        [LISTINGS, "l"],
      ]),
      crossing: new Set([EDGE_TYPECHECK_BASELINE_PATH]),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([{ path: MANAGE_CI, count: 4, primeCount: 0 }]);
    expect(verdict.merged).toBe(cloneJson);
    const parsed = JSON.parse(verdict.merged);
    expect(parsed.files[MANAGE_CI]).toBe(4);
    expect(parsed.generated_total).toBe(14);
  });

  it("is prime's file, byte for byte, where every counted file crosses — every mirror", () => {
    const primeJson = baseline({ [SHARED]: 5, [MANAGE_CI]: 1 });
    const cloneJson = baseline({ [SHARED]: 6, [MANAGE_CI]: 4 });
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson,
      cloneJson,
      primeSha: new Map([
        [SHARED, "new-s"],
        [MANAGE_CI, "new-m"],
      ]),
      cloneSha: new Map([
        [SHARED, "old-s"],
        [MANAGE_CI, "old-m"],
      ]),
      crossing: new Set([SHARED, MANAGE_CI, EDGE_TYPECHECK_BASELINE_PATH]),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([]);
    expect(verdict.merged).toBe(primeJson);
  });

  it("takes prime's count for a file that is the same on both sides", () => {
    // The file does not differ, so prime's count describes it as well as the
    // clone's does, and prime's is the one that moves when prime fixes it.
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: baseline({ [SHARED]: 5 }),
      cloneJson: baseline({ [SHARED]: 6 }),
      primeSha: new Map([[SHARED, "same"]]),
      cloneSha: new Map([[SHARED, "same"]]),
      crossing: new Set(),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([]);
    expect(JSON.parse(verdict.merged).files[SHARED]).toBe(5);
  });

  it("keeps the count of a function only the clone has", () => {
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: baseline({ [SHARED]: 6 }),
      cloneJson: baseline({ [SHARED]: 6, [CRM_ONLY]: 2 }),
      primeSha: new Map([[SHARED, "s"]]),
      cloneSha: new Map([
        [SHARED, "s"],
        [CRM_ONLY, "c"],
      ]),
      crossing: new Set(),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([{ path: CRM_ONLY, count: 2, primeCount: 0 }]);
    expect(JSON.parse(verdict.merged).files).toEqual({ [SHARED]: 6, [CRM_ONLY]: 2 });
  });

  it("drops the entry of a kept file the clone counts as clean", () => {
    // The clone's copy has no errors, so no entry — and prime's count, which
    // describes a different file, must not permit two on this one.
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: baseline({ [SHARED]: 6, [MANAGE_CI]: 2 }),
      cloneJson: baseline({ [SHARED]: 6 }),
      primeSha: new Map([
        [SHARED, "s"],
        [MANAGE_CI, "new"],
      ]),
      cloneSha: new Map([
        [SHARED, "s"],
        [MANAGE_CI, "old"],
      ]),
      crossing: new Set(),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([{ path: MANAGE_CI, count: 0, primeCount: 2 }]);
    expect(JSON.parse(verdict.merged).files).toEqual({ [SHARED]: 6 });
    expect(JSON.parse(verdict.merged).generated_total).toBe(6);
  });

  it("leaves prime's count on a file the clone does not hold", () => {
    const primeJson = baseline({ [SHARED]: 6, [LISTINGS]: 4 });
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson,
      cloneJson: baseline({ [SHARED]: 6 }),
      primeSha: new Map([
        [SHARED, "s"],
        [LISTINGS, "l"],
      ]),
      cloneSha: new Map([[SHARED, "s"]]),
      crossing: new Set(),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keptFromClone).toEqual([]);
    expect(verdict.merged).toBe(primeJson);
  });

  it("writes what the generator writes: sorted, summed, and stable when read back", () => {
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: baseline({ [SHARED]: 6, [LISTINGS]: 4 }),
      cloneJson: baseline({ [SHARED]: 6, [LISTINGS]: 4, [MANAGE_CI]: 4, [CRM_ONLY]: 1 }),
      primeSha: new Map([
        [SHARED, "s"],
        [LISTINGS, "l"],
        [MANAGE_CI, "new"],
      ]),
      cloneSha: new Map([
        [SHARED, "s"],
        [LISTINGS, "l"],
        [MANAGE_CI, "old"],
        [CRM_ONLY, "c"],
      ]),
      crossing: new Set(),
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const parsed = JSON.parse(verdict.merged);
    const keys = Object.keys(parsed.files);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(parsed.generated_total).toBe(15);
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(verdict.merged);
    expect(Object.keys(parsed)).toEqual(["$comment", "generated_total", "files"]);
  });
});

describe("the baseline is only rewritten in a shape it reproduces", () => {
  const good = baseline({ [SHARED]: 6 });
  const shas = {
    primeSha: new Map([[MANAGE_CI, "new"]]),
    cloneSha: new Map([[MANAGE_CI, "old"]]),
    crossing: new Set<string>(),
  };

  it("declines a file that is not JSON", () => {
    const verdict = reconcileEdgeTypecheckBaseline({ primeJson: good, cloneJson: "{", ...shas });
    expect(verdict).toEqual({ ok: false, reason: "clone's baseline is not JSON" });
  });

  it("declines a file with no files map", () => {
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: `${JSON.stringify({ generated_total: 0 }, null, 2)}\n`,
      cloneJson: good,
      ...shas,
    });
    expect(verdict.ok).toBe(false);
  });

  it("declines a count that is not a whole number", () => {
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: good,
      cloneJson: `${JSON.stringify({ generated_total: 1, files: { [MANAGE_CI]: 1.5 } }, null, 2)}\n`,
      ...shas,
    });
    expect(verdict.ok).toBe(false);
  });

  it("declines hand-formatting rather than rewrite it", () => {
    const fourSpaces = `${JSON.stringify(JSON.parse(good), null, 4)}\n`;
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: good,
      cloneJson: fourSpaces,
      ...shas,
    });
    expect(verdict.ok).toBe(false);
  });

  it("declines a duplicated key, which JSON.parse would silently drop", () => {
    const duplicated = good.replace(`"${SHARED}": 6`, `"${SHARED}": 6,\n    "${SHARED}": 7`);
    const verdict = reconcileEdgeTypecheckBaseline({
      primeJson: good,
      cloneJson: duplicated,
      ...shas,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("the pull request says which counts were kept", () => {
  it("names each file, the clone's count and prime's", () => {
    expect(
      describeKeptCounts([
        { path: MANAGE_CI, count: 4, primeCount: 0 },
        { path: CRM_ONLY, count: 2, primeCount: 0 },
      ]),
    ).toBe(
      "kept this clone's count for 2 file(s) it keeps its own version of: " +
        `\`${MANAGE_CI}\` 4 (prime's version: 0), \`${CRM_ONLY}\` 2 (prime's version: 0)`,
    );
  });
});
