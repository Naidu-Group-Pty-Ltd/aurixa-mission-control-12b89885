import { describe, it, expect } from "vitest";
import { chunkCursorFor, cursorRanPastEnd } from "./chunkCursorStore.pure";

/**
 * Every rejected shape here is a value that a bare
 * `as { migrationId: string; statementsDone: number } | null` accepted, and
 * `statementsDone` is a number of statements to SKIP — so accepting a wrong one
 * means the clone never receives them and nothing anywhere notices.
 */
describe("chunkCursorFor", () => {
  it("reads a well-formed cursor", () => {
    expect(chunkCursorFor({ migrationId: "20261202000000", statementsDone: 31 })).toEqual({
      migrationId: "20261202000000",
      statementsDone: 31,
    });
  });

  it("keeps zero, which is a real cursor and not an absent one", () => {
    // A pass refused on the first read has sent nothing and may still record
    // where it is. Coercing that to null is harmless; coercing it to skip
    // anything is not, so the distinction is kept explicit.
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 0 })).toEqual({
      migrationId: "m",
      statementsDone: 0,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", "31"],
    ["an array", [{ migrationId: "m", statementsDone: 1 }]],
    ["no migrationId", { statementsDone: 3 }],
    ["an empty migrationId", { migrationId: "", statementsDone: 3 }],
    ["a non-string migrationId", { migrationId: 20261202000000, statementsDone: 3 }],
    ["no statementsDone", { migrationId: "m" }],
    ["a string statementsDone", { migrationId: "m", statementsDone: "3" }],
    ["a fractional statementsDone", { migrationId: "m", statementsDone: 3.5 }],
    ["a negative statementsDone", { migrationId: "m", statementsDone: -1 }],
    ["NaN", { migrationId: "m", statementsDone: Number.NaN }],
    ["Infinity", { migrationId: "m", statementsDone: Number.POSITIVE_INFINITY }],
  ])("refuses %s", (_label, raw) => {
    expect(chunkCursorFor(raw)).toBeNull();
  });

  it("does not judge WHICH migration the cursor belongs to", () => {
    // `applyChunkedSeed` already compares `cursor.migrationId` to the migration
    // it is sending, and skips nothing when they differ. A second comparison
    // here is a second spelling of one rule, and the two would drift.
    expect(chunkCursorFor({ migrationId: "some-other-file", statementsDone: 9 })).toEqual({
      migrationId: "some-other-file",
      statementsDone: 9,
    });
  });
});

/**
 * A cursor past the end of the file.
 *
 * `applyChunkedSeed` skips while `index < skip`, so a cursor naming more
 * statements than the seed has skips every one of them, applies nothing, and —
 * before this — returned `stoppedEarly: false`, which the replay reads as "the
 * seed went" and answers by writing the ledger row. The clone then records a
 * version it does not hold and every later pass skips it as applied.
 */
describe("cursorRanPastEnd", () => {
  it("is true when the cursor claims more statements than the file has", () => {
    expect(cursorRanPastEnd(9000, 40)).toBe(true);
  });

  it("is FALSE on equality — that is a pass that sent the last statement and died", () => {
    // The ordinary shape of a run killed between the final statement and its
    // ledger row. Every statement really did land; calling it an error here
    // would stop the seed ever being recorded as applied.
    expect(cursorRanPastEnd(40, 40)).toBe(false);
  });

  it("is false while there is still more of the file to send", () => {
    expect(cursorRanPastEnd(2, 40)).toBe(false);
  });

  it("is false for a cursor of zero, which is not a claim about anything", () => {
    // A zero cursor is what this very guard hands back, so treating it as past
    // the end would be a loop that never sends a statement.
    expect(cursorRanPastEnd(0, 0)).toBe(false);
    expect(cursorRanPastEnd(0, 40)).toBe(false);
  });

  it("is true for a non-zero cursor against an empty walk", () => {
    expect(cursorRanPastEnd(1, 0)).toBe(true);
  });
});
