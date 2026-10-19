import { describe, expect, it } from "vitest";
import { scanRequestAllowed } from "./codex-scan-policy";

describe("scanRequestAllowed", () => {
  it("allows the nightly scan of Prime and a person's manual scan of Prime", () => {
    expect(scanRequestAllowed({ kind: "nightly_full", targetKind: "prime" })).toEqual({ ok: true });
    expect(scanRequestAllowed({ kind: "manual", targetKind: "prime" })).toEqual({ ok: true });
  });

  it("never scans a clone, of any kind", () => {
    for (const kind of ["nightly_full", "manual", "pr_open", "post_merge_revalidate"]) {
      expect(scanRequestAllowed({ kind, targetKind: "clone" })).toEqual({
        ok: false,
        reason: "clones_not_scanned",
      });
    }
  });

  it("refuses pull request, post-merge and path scans of Prime", () => {
    for (const kind of ["pr_open", "post_merge_revalidate", "targeted_path"]) {
      const v = scanRequestAllowed({ kind, targetKind: "prime" });
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toBe(`scans_run_nightly_on_prime:${kind}`);
    }
  });
});
