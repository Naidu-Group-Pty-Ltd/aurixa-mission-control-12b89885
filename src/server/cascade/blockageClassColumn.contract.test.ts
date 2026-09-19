/**
 * The column decides.
 *
 * `clone_sync_blockages.class` is CHECK-constrained. A class the code can
 * spell and the column cannot is not a type error and not a lint error — it
 * is a write Postgres rejects at runtime, on a path whose whole job is to
 * make an invisible condition visible. From inside the function that shape is
 * indistinguishable from a write nobody attempted.
 *
 * This repository has paid for that twice already, both recorded in the
 * prime's own guidance: `client_reminders.reminder_type` (the AML kinds had
 * to be added to the column "or every write would have been rejected there
 * while looking, from the function, exactly like a write nobody attempted"),
 * and `template_library_entries.category`, where 50 masters were refused by
 * Postgres mid-apply after 290 rows had been written.
 *
 * So the taxonomy and the constraint are checked against each other here,
 * from the migration that last wrote the constraint — the same file an
 * operator would read to know what the column takes.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** The class list from the LAST migration that writes the constraint. */
function constraintClasses(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    if (/add\s+constraint\s+clone_sync_blockages_class_check/i.test(sql)) latest = sql;
  }
  if (latest === null) return [];
  // The `check (...)` body of that constraint, and the quoted words in it.
  const body = /add\s+constraint\s+clone_sync_blockages_class_check[\s\S]*?;/i.exec(latest);
  if (!body) return [];
  return [...body[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe("the blockage taxonomy and its column cannot drift", () => {
  it("finds a constraint to judge at all", () => {
    // A scan that finds nothing passes every comparison below vacuously.
    expect(constraintClasses().length).toBeGreaterThan(0);
  });

  it("takes exactly the classes the code can spell", () => {
    expect(constraintClasses()).toEqual(Object.keys(BLOCKAGE_POLICY).sort());
  });

  it("names the class this contract was written for", () => {
    // Pinning one member keeps the pair above from being satisfied by two
    // empty sets if both the union and the constraint were ever gutted.
    expect(constraintClasses()).toContain("prime_ledger_hole");
    expect(BLOCKAGE_POLICY).toHaveProperty("prime_ledger_hole");
  });
});
