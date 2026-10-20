/**
 * A bundle's digest changes exactly when what the deploy sends changes.
 *
 * Both directions matter and fail differently. A digest that misses a change
 * lets the lane skip a bundle a tenant is owed, silently. A digest that
 * changes when nothing sent changed re-owes bundles for nothing — which, at
 * one bundle a pass, is the restart this digest exists to stop.
 */
import { describe, expect, it } from "vitest";
import { BUNDLE_DIGEST_VERSION, bundleDigest, changedBundles } from "./functionBundleDigest.pure";

const base = {
  slug: "listings-cache",
  entrypointPath: "listings-cache/index.ts",
  importMapPath: null,
  verifyJwt: false,
  files: [
    { path: "listings-cache/index.ts", sha: "1111" },
    { path: "_shared/airtableListing.pure.ts", sha: "2222" },
  ],
};

describe("bundleDigest", () => {
  it("is 40 hex digits and the same for the same bundle", () => {
    const d = bundleDigest(base);
    expect(d).toMatch(/^[0-9a-f]{40}$/);
    expect(bundleDigest({ ...base, files: [...base.files] })).toBe(d);
  });

  it("ignores the order the files arrive in", () => {
    // The entrypoint is named in the deploy's metadata, so a file appearing
    // earlier in the tree changes nothing that runs.
    expect(bundleDigest({ ...base, files: [...base.files].reverse() })).toBe(bundleDigest(base));
  });

  it("changes when any file's content changes", () => {
    const changed = {
      ...base,
      files: [base.files[0], { path: "_shared/airtableListing.pure.ts", sha: "3333" }],
    };
    expect(bundleDigest(changed)).not.toBe(bundleDigest(base));
  });

  it("changes when a file is added, removed or moved", () => {
    const added = { ...base, files: [...base.files, { path: "_shared/cors.ts", sha: "4444" }] };
    const removed = { ...base, files: [base.files[0]] };
    const moved = {
      ...base,
      files: [base.files[0], { path: "_shared/listings/airtableListing.pure.ts", sha: "2222" }],
    };
    for (const variant of [added, removed, moved]) {
      expect(bundleDigest(variant)).not.toBe(bundleDigest(base));
    }
  });

  it("changes with every other field the deploy sends", () => {
    const d = bundleDigest(base);
    expect(bundleDigest({ ...base, slug: "listings-cache-2" })).not.toBe(d);
    expect(bundleDigest({ ...base, entrypointPath: "listings-cache/main.ts" })).not.toBe(d);
    expect(bundleDigest({ ...base, importMapPath: "import_map.json" })).not.toBe(d);
    expect(bundleDigest({ ...base, verifyJwt: true })).not.toBe(d);
  });

  it("names its own version, so a change to what it covers stops old ledgers matching", () => {
    expect(BUNDLE_DIGEST_VERSION).toMatch(/^bundle-digest\/\d+$/);
  });
});

describe("changedBundles", () => {
  it("names added, removed and changed bundles, sorted", () => {
    const before = new Map([
      ["alpha", "a1"],
      ["beta", "b1"],
      ["gone", "g1"],
    ]);
    const after = new Map([
      ["beta", "b2"],
      ["alpha", "a1"],
      ["new", "n1"],
    ]);
    expect(changedBundles(before, after)).toEqual(["beta", "gone", "new"]);
  });

  it("is empty where nothing changed", () => {
    const same = new Map([["alpha", "a1"]]);
    expect(changedBundles(same, new Map(same))).toEqual([]);
  });
});
