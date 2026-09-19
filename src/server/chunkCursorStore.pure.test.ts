import { describe, it, expect } from "vitest";
import { chunkCursorFor } from "./chunkCursorStore.pure";

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
 * The shape half. It exists to stop a resumed pass reading 41 MB twice, so
 * every rejection here has the same consequence — read the file again, which
 * is exactly what every pass did before the field existed. Nothing here can
 * make a pass WORSE than it was; it can only fail to make it better.
 */
const SHAPE = {
  header: "INSERT INTO public.template_library_entries (id, page_plan) VALUES",
  onConflict: "ON CONFLICT (id) DO UPDATE SET page_plan = excluded.page_plan;",
  tail: "",
  tupleCount: 4137,
  target: "public.template_library_entries",
};

describe("chunkCursorFor — the remembered shape", () => {
  it("carries a well-formed shape through", () => {
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 6, shape: SHAPE })).toEqual({
      migrationId: "m",
      statementsDone: 6,
      shape: SHAPE,
    });
  });

  it("carries `tail`, which a pass that dropped it would stop sending", () => {
    // `chunkSeedStatements` emits the statements after the ON CONFLICT clause
    // as a final group. A stored shape without `tail` would silently stop
    // sending them on every RESUMED pass — the half of a seed nothing
    // downstream reports missing.
    const withTail = { ...SHAPE, tail: "SELECT public.refresh_active_masters();" };
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: withTail })?.shape?.tail).toBe(
      "SELECT public.refresh_active_masters();",
    );
  });

  it("accepts the empty strings that an ordinary seed actually has", () => {
    // A length check on either of these would reject every seed with no
    // ON CONFLICT clause and nothing after it — and quietly restore the
    // double read for all of them.
    const bare = { ...SHAPE, onConflict: "", tail: "" };
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: bare })?.shape).toEqual(bare);
  });

  it("accepts a null target, which is how an unparsed table name reads", () => {
    const anon = { ...SHAPE, target: null };
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: anon })?.shape).toEqual(anon);
  });

  it("reads a cursor written before the shape existed, without a shape", () => {
    const cursor = chunkCursorFor({ migrationId: "m", statementsDone: 6 });
    expect(cursor).toEqual({ migrationId: "m", statementsDone: 6 });
    expect(cursor?.shape).toBeUndefined();
  });

  it.each([
    ["a missing header", { ...SHAPE, header: undefined }],
    ["an empty header", { ...SHAPE, header: "" }],
    ["a non-string header", { ...SHAPE, header: 7 }],
    ["a missing onConflict", { ...SHAPE, onConflict: undefined }],
    ["a non-string onConflict", { ...SHAPE, onConflict: 7 }],
    ["a missing tail", { ...SHAPE, tail: undefined }],
    ["a non-string tail", { ...SHAPE, tail: 7 }],
    ["a missing tupleCount", { ...SHAPE, tupleCount: undefined }],
    ["a fractional tupleCount", { ...SHAPE, tupleCount: 4137.5 }],
    ["a negative tupleCount", { ...SHAPE, tupleCount: -1 }],
    ["a non-null non-string target", { ...SHAPE, target: 7 }],
    ["an array", [SHAPE]],
    ["a string", "shape"],
    ["null", null],
  ])("drops %s, keeping the cursor and re-reading the file", (_what, shape) => {
    const cursor = chunkCursorFor({ migrationId: "m", statementsDone: 6, shape });
    // The POSITION survives — those statements did land, and re-sending them
    // is what the shape rejection must not cause.
    expect(cursor).toEqual({ migrationId: "m", statementsDone: 6 });
    expect(cursor?.shape).toBeUndefined();
  });
});
