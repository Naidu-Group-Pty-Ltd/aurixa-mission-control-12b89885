/**
 * What a module-scoped clone has installed, with its library pins honoured,
 * and a delivery's summary naming the commit each pinned entry was approved at
 * (D19). The files a pin scopes are still read from the prime's head, so the
 * commit is what tells a reader which detection the scope came from.
 */
import { describe, expect, it } from "vitest";
import { STATEMENT_TIMEOUT, createLibraryFakeDb, type Row } from "../testing/libraryFakes";
import { readInstalledGlobs } from "./installedGlobs.server";

const CLONE = "282695be-0000-4000-8000-000000000002";
const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";

function fleet(entry: Partial<Row> = {}) {
  return createLibraryFakeDb({
    modules: [
      { id: "m-checkout", slug: "checkout", name: "Checkout", file_globs: ["src/checkout/**"] },
      { id: "m-aml", slug: "aml", name: "AML", file_globs: ["src/aml/**"] },
    ],
    clone_modules: [
      { id: "cm1", clone_id: CLONE, module_id: "m-checkout" },
      { id: "cm2", clone_id: CLONE, module_id: "m-aml" },
    ],
    clone_library_pins: [
      { id: "p1", clone_id: CLONE, slug: "checkout", version: 3, library_entry_id: "e3" },
    ],
    module_library: [
      {
        id: "e3",
        slug: "checkout",
        name: "Checkout",
        entry_file: "src/routes/checkout.tsx",
        version: 3,
        approval_status: "approved",
        file_paths: ["src/checkout/v3/**", "supabase/functions/checkout-api/**"],
        source_commit_sha: COMMIT,
        ...entry,
      },
    ],
  });
}

describe("a pinned module's scope", () => {
  it("is the entry's files, and the summary names the commit it was approved at", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder this module uses
    const installed = await readInstalledGlobs(fleet() as any, CLONE);
    expect(installed.globs).toEqual([
      "src/checkout/v3/**",
      "supabase/functions/checkout-api/**",
      "src/aml/**",
    ]);
    expect(installed.pinSummary).toBe("pins: checkout@v3 (prime@4f1c2d3)");
    expect(installed.failed).toBeNull();
  });

  it("says when the pinned entry records no commit, rather than leaving it out", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder this module uses
    const installed = await readInstalledGlobs(fleet({ source_commit_sha: null }) as any, CLONE);
    expect(installed.pinSummary).toBe("pins: checkout@v3 (no commit recorded)");
  });

  it("falls back to the live globs, and says the read failed, when the entries cannot be read", async () => {
    const db = fleet();
    db.failures.set("module_library.select", STATEMENT_TIMEOUT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder this module uses
    const installed = await readInstalledGlobs(db as any, CLONE);
    expect(installed.globs).toEqual(["src/checkout/**", "src/aml/**"]);
    expect(installed.pinSummary).toBeNull();
    expect(installed.failed).toBe("module_library: canceling statement due to statement timeout");
  });
});
