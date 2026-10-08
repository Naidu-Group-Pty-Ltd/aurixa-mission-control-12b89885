import { describe, expect, it } from "vitest";
import {
  artefactLocation,
  canonicalJson,
  decideUpdate,
  inRollout,
  rolloutBucket,
  selectRelease,
  selectReleaseForInstall,
  validateDescriptor,
  type CandidateRelease,
} from "./releaseDescriptor.pure";

const HEX = "a".repeat(64);
const android = {
  descriptor_version: 1,
  portal: "command-centre",
  platform: "android",
  environment: "production",
  channel: "stable",
  version: "1.2.3",
  build_number: 42,
  source_sha: "abcdef1",
  content_sha256: HEX,
  signing_cert_sha256: "b".repeat(64),
  size_bytes: 30_000_000,
  min_supported_build: 40,
};

describe("validateDescriptor", () => {
  it("accepts a well-formed Android descriptor", () => {
    const r = validateDescriptor(android);
    expect(r.ok).toBe(true);
  });

  it("names every defect", () => {
    const r = validateDescriptor({
      ...android,
      version: "1.2",
      build_number: 0,
      content_sha256: "x",
      portal: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a floor above the release's own build", () => {
    expect(validateDescriptor({ ...android, min_supported_build: 43 }).ok).toBe(false);
  });

  it("refuses an iOS release that carries an artefact or lacks its Apple link", () => {
    const ios = {
      ...android,
      platform: "ios",
      content_sha256: null,
      signing_cert_sha256: null,
      size_bytes: null,
    };
    expect(validateDescriptor(ios).ok).toBe(false);
    expect(
      validateDescriptor({ ...ios, apple_custom_app_url: "https://apps.apple.com/au/app/x/id1" })
        .ok,
    ).toBe(true);
    expect(
      validateDescriptor({
        ...ios,
        content_sha256: HEX,
        apple_custom_app_url: "https://apps.apple.com/x",
      }).ok,
    ).toBe(false);
  });
});

describe("artefactLocation", () => {
  it("derives the bucket and path from the descriptor", () => {
    const r = validateDescriptor(android);
    if (!r.ok) throw new Error("bad fixture");
    expect(artefactLocation(r.descriptor)).toEqual({
      bucket: "mobile-releases-command-centre",
      path: `production/android/1.2.3+42/${HEX}/artifact`,
    });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("is independent of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe("rollout", () => {
  it("is deterministic and only ever widens", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `install-${i}`);
    const at = (p: number) => new Set(ids.filter((id) => inRollout("rel-1", id, p, false)));
    const ten = at(10);
    const fifty = at(50);
    for (const id of ten) expect(fifty.has(id)).toBe(true);
    expect(rolloutBucket("rel-1", "install-1")).toBe(rolloutBucket("rel-1", "install-1"));
    expect(at(100).size).toBe(500);
    expect(at(0).size).toBe(0);
    expect(fifty.size).toBeGreaterThan(175);
    expect(fifty.size).toBeLessThan(325);
  });
  it("a paused rollout admits nobody", () => {
    expect(inRollout("rel-1", "install-1", 100, true)).toBe(false);
  });
});

const scope = {
  portal: "command-centre",
  platform: "android",
  environment: "production",
  channel: "stable",
} as const;
function rel(over: Partial<CandidateRelease>): CandidateRelease {
  return {
    id: "r",
    ...scope,
    state: "promoted",
    build_number: 10,
    min_supported_build: null,
    critical: false,
    rollout_percentage: 100,
    rollout_paused: false,
    ...over,
  };
}

describe("selection and update decision", () => {
  it("takes the highest promoted build in scope", () => {
    const s = selectRelease(
      [
        rel({ id: "a", build_number: 10 }),
        rel({ id: "b", build_number: 12 }),
        rel({ id: "c", build_number: 13, state: "approved" }),
      ],
      scope,
      "i",
    );
    expect(s.target?.id).toBe("b");
  });

  it("rolls back through a higher build number", () => {
    const s = selectRelease(
      [
        rel({ id: "bad", build_number: 12, state: "withdrawn" }),
        rel({ id: "fix", build_number: 13 }),
      ],
      scope,
      "i",
    );
    expect(decideUpdate(12, s)).toBe("available");
    expect(s.target?.id).toBe("fix");
  });

  it("requires a critical release and anything under the floor", () => {
    expect(
      decideUpdate(10, selectRelease([rel({ build_number: 11, critical: true })], scope, "i")),
    ).toBe("required");
    expect(
      decideUpdate(
        10,
        selectRelease([rel({ build_number: 12, min_supported_build: 11 })], scope, "i"),
      ),
    ).toBe("required");
    expect(decideUpdate(12, selectRelease([rel({ build_number: 12 })], scope, "i"))).toBe("none");
  });

  it("offers a device under the floor a release that clears it even outside the cohort", () => {
    const releases = [
      rel({ id: "floor", build_number: 12, min_supported_build: 11, rollout_percentage: 0 }),
    ];
    expect(selectRelease(releases, scope, "i").target).toBeNull();
    const s = selectReleaseForInstall(releases, scope, "i", 10);
    expect(s.target?.id).toBe("floor");
    expect(decideUpdate(10, s)).toBe("required");
  });

  it("never offers a lower build", () => {
    expect(decideUpdate(20, selectRelease([rel({ build_number: 12 })], scope, "i"))).toBe("none");
  });
});
