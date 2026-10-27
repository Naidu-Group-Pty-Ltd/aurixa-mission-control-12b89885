/**
 * The cascade page diffs a delivery's own commit, never `previous_sha`.
 *
 * `previous_sha` is the prime commit a clone was synced to when an operator
 * started the cascade, written for the bulk card's rollback, which sets
 * `last_synced_sha` back to it (`operatorCascade.server.ts`). A clone's
 * repository does not hold the prime's commits. Measured 27 Oct 2026 on the
 * dashboard: `compare/d72032e1...5415a47` answered 404, and
 * `compare/4507dde^...4507dde` listed the 14 files its row records.
 *
 * Asserted on the source, comments stripped, as the page's other contracts are.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";

const page = stripComments(readFileSync("src/routes/cascades.$eventId.tsx", "utf8"));

describe("the cascade page's diff", () => {
  it("compares a delivery's commit with its parent", () => {
    expect(page).toContain("baseSha={`${result.commit_sha}^`}");
    expect(page).toContain("headSha={result.commit_sha}");
  });

  it("never takes a prime commit as a base in the clone's repository", () => {
    expect(page).not.toMatch(/baseSha=\{result\.previous_sha\}/);
  });
});
