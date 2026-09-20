import { describe, it, expect } from "vitest";
import {
  IDENTITY_PROBE_PATHS,
  isIdentityDrift,
  probePathsAreShipped,
  readBackendIdentity,
  type ProbedFile,
} from "./backendIdentityReading.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";

const PRIME = "dduzbchuswwbefdunfct";
const OWN = "umrtusxohxjxzodxorim";
const PARENT = "plisdzywzleljorrphxv";

const embed = (ref: string) =>
  ["<script>", `  var SUPABASE_URL = 'https://${ref}.supabase.co';`, "</script>"].join("\n");

const read = (path: string, content: string): ProbedFile => ({ path, kind: "read", content });

describe("readBackendIdentity", () => {
  it("is `own` when every file read names this deployment", () => {
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [read(IDENTITY_PROBE_PATHS[0], embed(OWN))],
    });
    expect(r.verdict).toBe("own");
    expect(r.findings).toEqual([]);
    expect(isIdentityDrift(r)).toBe(false);
  });

  it("is `foreign` when a shipped file names somebody else, and says who", () => {
    // The state all three clones were in on 20 Sep 2026.
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [read("public/lead-magnet-embed.html", embed(PRIME))],
    });
    expect(r.verdict).toBe("foreign");
    expect(r.findings).toEqual([{ path: "public/lead-magnet-embed.html", foreignRefs: [PRIME] }]);
    expect(r.summary).toContain(PRIME);
    expect(r.summary).toContain(OWN);
    expect(isIdentityDrift(r)).toBe(true);
  });

  it("finds a PARENT's project, not merely the prime's", () => {
    // With lineage routing on, the value that nearly reached these files was a
    // sibling deployment's. A reading that only knew the prime's ref would
    // have gone green at the moment the defect got worse.
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [read("src/integrations/supabase/env.ts", embed(PARENT))],
    });
    expect(r.verdict).toBe("foreign");
    expect(r.findings[0].foreignRefs).toEqual([PARENT]);
  });

  it("reports an unreadable repository as `unreadable`, never as `own`", () => {
    // "We could not check" is not "you do not have it". A lost signal that
    // rendered clean would put a green mark on the one screen built to show
    // this.
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [
        read("src/integrations/supabase/env.ts", embed(OWN)),
        { path: "public/lead-magnet-embed.html", kind: "error", message: "502" },
      ],
    });
    expect(r.verdict).toBe("unreadable");
    expect(r.summary).toContain("public/lead-magnet-embed.html");
    // And it is not a finding either — nothing was found to be wrong.
    expect(r.findings).toEqual([]);
    expect(isIdentityDrift(r)).toBe(false);
  });

  it("lets a real finding outrank an unreadable sibling file", () => {
    // Something known to be wrong is more useful than the fact that something
    // else could not be checked.
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [
        read("public/lead-magnet-embed.html", embed(PRIME)),
        { path: "src/integrations/supabase/env.ts", kind: "error", message: "502" },
      ],
    });
    expect(r.verdict).toBe("foreign");
  });

  it("reports a clone with no recorded backend as `no_backend`, never as `own`", () => {
    const r = readBackendIdentity({
      ownRef: null,
      files: [read("public/lead-magnet-embed.html", embed(PRIME))],
    });
    expect(r.verdict).toBe("no_backend");
    // It still says whose database those files name, because that is the fact
    // an operator acts on.
    expect(r.summary).toContain(PRIME);
  });

  it("does not turn an absent file into a finding", () => {
    // A repository that does not carry the embed ships nobody's database from
    // it. Absence is not evidence either way.
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [{ path: "public/lead-magnet-embed.html", kind: "absent" }],
    });
    expect(r.verdict).toBe("own");
    expect(r.findings).toEqual([]);
  });

  it("carries its coverage on every reading, including the clean one", () => {
    // An answer that did not say what it looked at reads as a statement about
    // the whole repository, which it is not.
    const clean = readBackendIdentity({
      ownRef: OWN,
      files: IDENTITY_PROBE_PATHS.map((p) => read(p, embed(OWN))),
    });
    expect(clean.paths).toEqual([...IDENTITY_PROBE_PATHS]);
  });

  it("names every foreign project in one file, not just the first", () => {
    const mixed = [embed(PRIME), embed(PARENT)].join("\n");
    const r = readBackendIdentity({
      ownRef: OWN,
      files: [read("public/lead-magnet-embed.html", mixed)],
    });
    expect(new Set(r.findings[0].foreignRefs)).toEqual(new Set([PRIME, PARENT]));
  });
});

describe("what the probe covers", () => {
  it("probes only paths the cascade would also hold", () => {
    // A path reported as drift that no cascade guard protects is a finding
    // with no remedy.
    expect(probePathsAreShipped()).toBe(true);
  });

  it("probes paths the exclusion policy already names as identity", () => {
    // The two instruments must agree about WHICH files are identity. If a
    // probe path were not on the mirror policy, the standing reading would
    // report drift on a file the next cascade is free to overwrite.
    const patterns = new Set(DEFAULT_MIRROR_EXCLUSIONS.map((e) => e.pattern));
    for (const p of IDENTITY_PROBE_PATHS) {
      expect(patterns, `${p} must be an excluded path`).toContain(p);
    }
  });
});
