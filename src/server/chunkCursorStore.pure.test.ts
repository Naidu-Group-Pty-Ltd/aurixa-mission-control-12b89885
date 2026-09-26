import { describe, it, expect } from "vitest";
import { chunkCursorFor, cursorAppliesToBody, cursorRanPastEnd } from "./chunkCursorStore.pure";

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
    expect(
      chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: withTail })?.shape?.tail,
    ).toBe("SELECT public.refresh_active_masters();");
  });

  it("accepts the empty strings that an ordinary seed actually has", () => {
    // A length check on either of these would reject every seed with no
    // ON CONFLICT clause and nothing after it — and quietly restore the
    // double read for all of them.
    const bare = { ...SHAPE, onConflict: "", tail: "" };
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: bare })?.shape).toEqual(
      bare,
    );
  });

  it("accepts a null target, which is how an unparsed table name reads", () => {
    const anon = { ...SHAPE, target: null };
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 1, shape: anon })?.shape).toEqual(
      anon,
    );
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

/**
 * The body's own identity, which is what tells a resumed pass whether the file
 * it is about to open is the one the position was taken in.
 */
describe("chunkCursorFor — the body identity", () => {
  const sha = "0f4a1c2b3d4e5f60718293a4b5c6d7e8f9001122";

  it("carries a sha through, with and without a shape", () => {
    expect(chunkCursorFor({ migrationId: "m", statementsDone: 6, bodySha: sha })).toEqual({
      migrationId: "m",
      statementsDone: 6,
      bodySha: sha,
    });
    expect(
      chunkCursorFor({ migrationId: "m", statementsDone: 6, shape: SHAPE, bodySha: sha }),
    ).toEqual({ migrationId: "m", statementsDone: 6, bodySha: sha, shape: SHAPE });
  });

  it.each([
    ["an empty string", ""],
    ["a number", 7],
    ["null", null],
    ["an array", [sha]],
    ["an object", { sha }],
  ])("drops %s rather than storing it as an identity", (_what, bodySha) => {
    // An empty string is the one worth spelling out: it would compare unequal
    // to every real sha and so refuse every cursor, which is safe and turns a
    // legitimate resume into a restart on every pass — the livelock the cursor
    // exists to end. Dropped to undefined, which is the "written before this
    // existed" reading and is handled explicitly.
    const cursor = chunkCursorFor({ migrationId: "m", statementsDone: 6, bodySha });
    expect(cursor).toEqual({ migrationId: "m", statementsDone: 6 });
    expect(cursor?.bodySha).toBeUndefined();
  });

  it("keeps the position when the identity is unreadable", () => {
    // Same rule as the shape: those statements DID land, and refusing the whole
    // cursor over an unreadable field would re-send them.
    expect(
      chunkCursorFor({ migrationId: "m", statementsDone: 6, shape: SHAPE, bodySha: 7 }),
    ).toEqual({ migrationId: "m", statementsDone: 6, shape: SHAPE });
  });
});

/**
 * A position is only a position in the body it was taken in.
 *
 * The template seed is 543 rows keyed by slug. Regenerating it rewrites
 * `schema` and `design_meta` and moves neither the header, the ON CONFLICT
 * clause, the tail nor the tuple count — so the shape check passes over a body
 * whose every value changed, and resuming into it leaves the clone holding the
 * OLD rows for the skipped prefix while the migration is recorded as applied.
 * Byte-based chunk boundaries mean rows can also fall between the prefix and
 * the remainder and never be sent at all.
 */
describe("cursorAppliesToBody", () => {
  const sha = "0f4a1c2b3d4e5f60718293a4b5c6d7e8f9001122";
  const other = "ffffffffffffffffffffffffffffffffffffffff";

  it("resumes where the body is provably the one the position was taken in", () => {
    expect(cursorAppliesToBody({ migrationId: "m", bodySha: sha }, "m", sha)).toBe(true);
  });

  it("REFUSES a position into a body that has been re-released", () => {
    // The whole finding. Same migration id, same shape, different bytes.
    expect(cursorAppliesToBody({ migrationId: "m", bodySha: other }, "m", sha)).toBe(false);
  });

  it("refuses a position taken in a different migration", () => {
    expect(cursorAppliesToBody({ migrationId: "other", bodySha: sha }, "m", sha)).toBe(false);
  });

  it("refuses a pre-identity cursor where THIS pass can name the body", () => {
    // Written before `bodySha` existed, so it cannot prove which release it is
    // into. One restart per clone, once, and the statements re-send for free
    // under the seed's own ON CONFLICT.
    expect(cursorAppliesToBody({ migrationId: "m" }, "m", sha)).toBe(false);
  });

  it("resumes on the shape alone where NOBODY can name the body", () => {
    // Exactly the behaviour that existed before this. Refusing here instead
    // would restart every pass for such a caller for ever — the livelock the
    // cursor was built to end.
    expect(cursorAppliesToBody({ migrationId: "m" }, "m", null)).toBe(true);
    expect(cursorAppliesToBody({ migrationId: "m", bodySha: sha }, "m", null)).toBe(true);
  });

  it("refuses a different migration even when nobody can name the body", () => {
    // The pre-existing check survives the unavailable reading; the identity is
    // an ADDITIONAL proof, never a replacement for the one that was there.
    expect(cursorAppliesToBody({ migrationId: "other" }, "m", null)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("refuses when there is no cursor at all (%s)", (_label, cursor) => {
    expect(cursorAppliesToBody(cursor, "m", sha)).toBe(false);
    expect(cursorAppliesToBody(cursor, "m", null)).toBe(false);
  });
});

/**
 * A cursor past the end of the file.
 *
 * `applyChunkedSeed` sends nothing before the cursor, so a cursor naming more
 * statements than the seed has sends nothing at all, applies nothing, and —
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
