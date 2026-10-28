/**
 * The pin check the cascade engine's pre-flight and both pin pages read
 * (`validateClonePins` calls it). Each pin is reported with the commit its
 * entry records, an approved entry without one is refused, and a failed read
 * of the entries is said to have failed rather than read as deleted entries.
 */
import { describe, expect, it } from "vitest";
import { STATEMENT_TIMEOUT, createLibraryFakeDb, type Row } from "./testing/libraryFakes";
import { validateClonePinsServer } from "./library-validation.server";

const CRM = "282695be-0000-4000-8000-000000000002";
const NCD = "e40b1d34-0000-4000-8000-000000000001";
const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";

const entry = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  slug: id,
  name: id,
  entry_file: `src/routes/${id}.tsx`,
  version: 2,
  approval_status: "approved",
  file_paths: [`src/${id}/**`],
  source_commit_sha: COMMIT,
  ...overrides,
});

function fleet(entries: Row[]) {
  return createLibraryFakeDb({
    clone_library_pins: [
      { id: "p1", clone_id: CRM, slug: "aml", version: 2, library_entry_id: "aml" },
      { id: "p2", clone_id: NCD, slug: "crm", version: 2, library_entry_id: "crm" },
    ],
    module_library: entries,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder this module uses
const check = (db: ReturnType<typeof fleet>) => validateClonePinsServer(db as any, [CRM, NCD]);

describe("checking clones' pins", () => {
  it("reports, per pin, the commit its entry was approved at", async () => {
    const answer = await check(fleet([entry("aml"), entry("crm")]));
    expect(answer).toMatchObject({ ok: true, issues: [], checked: 2 });
    expect(answer.pins).toEqual([
      { cloneId: CRM, slug: "aml", version: 2, libraryEntryId: "aml", commitSha: COMMIT },
      { cloneId: NCD, slug: "crm", version: 2, libraryEntryId: "crm", commitSha: COMMIT },
    ]);
  });

  it("refuses a pin on an approved entry that records no commit", async () => {
    const answer = await check(fleet([entry("aml", { source_commit_sha: null }), entry("crm")]));
    expect(answer.issues).toEqual([
      {
        cloneId: CRM,
        slug: "aml",
        version: 2,
        severity: "error",
        reason: "Approved entry records no commit",
      },
    ]);
    expect(answer.pins.map((p) => p.commitSha)).toEqual([null, COMMIT]);
  });

  it("says a failed read of the entries failed, and never that they were deleted", async () => {
    const db = fleet([entry("aml"), entry("crm")]);
    db.failures.set("module_library.select", STATEMENT_TIMEOUT);
    const answer = await check(db);
    expect(answer.ok).toBe(true);
    expect(answer.issues.map((i) => i.reason)).toEqual([
      "Library entry could not be read: canceling statement due to statement timeout",
      "Library entry could not be read: canceling statement due to statement timeout",
    ]);
    expect(answer.issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("still refuses a pin whose entry is gone or no longer approved", async () => {
    const answer = await check(fleet([entry("crm", { approval_status: "rejected" })]));
    expect(answer.issues.map((i) => `${i.slug}: ${i.reason}`)).toEqual([
      "aml: Library entry was deleted",
      "crm: Entry is now rejected",
    ]);
  });

  it("answers an error, not an empty fleet, when the pins cannot be read", async () => {
    const db = fleet([]);
    db.failures.set("clone_library_pins.select", STATEMENT_TIMEOUT);
    const answer = await check(db);
    expect(answer).toMatchObject({
      ok: false,
      checked: 0,
      error: "canceling statement due to statement timeout",
    });
  });
});
