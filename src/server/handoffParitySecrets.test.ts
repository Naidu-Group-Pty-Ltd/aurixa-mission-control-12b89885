/**
 * A credential a clone is supposed to lack is not a gap in its parity.
 *
 * See `diffSecrets`' own header for the measured reading this pins: a clone
 * whose schema matched the prime object for object, reported as
 * `risk_level: blocking` for `missing_secrets:58` — among them three
 * credentials the platform's own documents say must never travel, and one
 * that a sweep in this same codebase exists to REMOVE from a clone.
 */
import { describe, it, expect } from "vitest";
import { diffSecrets } from "./handoff-parity.server";

type SnapshotLike = Parameters<typeof diffSecrets>[0];

function snap(names: string[]): SnapshotLike {
  return { secretSet: new Set(names) } as unknown as SnapshotLike;
}

describe("diffSecrets", () => {
  it("still reports an ordinary vendor key the clone should have", () => {
    const d = diffSecrets(snap(["OPENAI_API_KEY", "RESEND_API_KEY"]), snap(["OPENAI_API_KEY"]));
    expect(d.missing_in_target).toEqual(["RESEND_API_KEY"]);
    expect(d.withheld_by_policy).toEqual([]);
  });

  it("never calls a management credential missing — a sweep exists to remove it", () => {
    const d = diffSecrets(snap(["SB_MANAGEMENT_ACCESS_TOKEN"]), snap([]));
    expect(d.missing_in_target).toEqual([]);
    expect(d.withheld_by_policy).toEqual(["SB_MANAGEMENT_ACCESS_TOKEN"]);
  });

  it("never calls a ledger-withheld credential missing", () => {
    // The three on the measured clone: an Airtable PAT carries its whole base
    // scope, and a Didit key carries its application's session list.
    const withheld = new Set(["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "DIDIT_API_KEY"]);
    const d = diffSecrets(
      snap(["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "DIDIT_API_KEY", "RESEND_API_KEY"]),
      snap([]),
      withheld,
    );
    expect(d.missing_in_target).toEqual(["RESEND_API_KEY"]);
    expect(d.withheld_by_policy).toEqual(["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN", "DIDIT_API_KEY"]);
  });

  it("judges by class even with no ledger to read, so an unreadable ledger is not a wrong verdict", () => {
    const d = diffSecrets(snap(["SB_MANAGEMENT_ACCESS_TOKEN", "RESEND_API_KEY"]), snap([]));
    expect(d.withheld_by_policy).toEqual(["SB_MANAGEMENT_ACCESS_TOKEN"]);
    expect(d.missing_in_target).toEqual(["RESEND_API_KEY"]);
  });

  it("leaves the counts describing the projects, not the verdict", () => {
    // `prime_count` / `target_count` are what each project HOLDS. Netting the
    // withheld out of them would make two honest numbers disagree with the
    // Secrets page beside them.
    const d = diffSecrets(snap(["A_SECRET", "SB_MANAGEMENT_ACCESS_TOKEN"]), snap(["A_SECRET"]));
    expect(d.prime_count).toBe(2);
    expect(d.target_count).toBe(1);
  });

  it("still reports a clone-only secret as extra", () => {
    const d = diffSecrets(snap([]), snap(["TENANT_OWN_KEY"]));
    expect(d.extra_in_target).toEqual(["TENANT_OWN_KEY"]);
  });
});
