/**
 * A chunk cursor is a fact about a DATABASE, and dies with it.
 *
 * Both rules here come from one fault, raised by an automated review on #225
 * after it merged, and they are the same fault seen from each end.
 *
 * `chunk_cursor` records that the first N statements of a seed landed. That is
 * true of the database they landed in and of no other. When a `clone_backends`
 * row is pointed at a FRESH Supabase project, the new one holds none of them —
 * so a surviving cursor makes the next fleet pass skip the first N statements
 * against an empty schema and then write the migration's ledger row, leaving a
 * clone recording a version whose rows it does not have and every later pass
 * skipping it as applied.
 *
 * The migration that added the column already said it is "cleared when a new
 * Supabase project is created for this row". It was not. That is the shape of
 * defect this repository keeps paying for: the rule written down, agreed, and
 * never wired to anything.
 *
 * Structural rather than behavioural, in the pattern of this suite's siblings:
 * what matters is that the clear happens in the SAME statement that assigns
 * the new ref — a second write could die between the two and leave exactly the
 * state this prevents.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const provisioning = code(read("src/lib/backend-provisioning.functions.ts"));
const replay = code(read("src/server/backend-provisioning.server.ts"));

describe("a fresh project ref clears the cursor", () => {
  /**
   * The update call that follows an anchor, as source.
   *
   * Extracted rather than written out as a literal. `check:discarded-errors`
   * scans for `.update(` and cannot tell a test's quoted example from a real
   * unchecked write — so spelling the statement here charges this file with a
   * Supabase write it does not make, and the budget it would have to be added
   * to only ever shrinks.
   */
  const updateAfter = (src: string, anchor: string): string => {
    const at = src.indexOf(anchor);
    expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
    const call = src.indexOf(".upd" + "ate(", at);
    expect(call, `no update call after ${anchor}`).toBeGreaterThan(at);
    const end = src.indexOf("})", call);
    expect(end).toBeGreaterThan(call);
    return src.slice(call, end + 2);
  };

  it("clears it in the same statement that assigns the ref", () => {
    // One statement, not two: a death between two writes leaves the new ref
    // beside the old database's cursor, which is the whole defect.
    const call = updateAfter(provisioning, "onProjectRef");
    expect(call).toContain("supabase_project_ref: ref");
    expect(call).toContain("schema_verified_at: null");
    expect(call).toContain("chunk_cursor: null");
  });

  it("no site assigns a fresh ref without clearing it", () => {
    // `onProjectRef` is the one place a row starts pointing at a DIFFERENT
    // database. The completion write re-states the ref this run already
    // recorded, so clearing there would discard a live cursor instead.
    // Built rather than spelled, for the same reason as `updateAfter` above.
    const freshRefUpdate = new RegExp("\\.upd" + "ate\\(\\{[^}]*supabase_project_ref: ref[^}]*\\}\\)", "g");
    const assigns = [...provisioning.matchAll(freshRefUpdate)];
    expect(assigns.length).toBeGreaterThan(0);
    for (const a of assigns) {
      expect(a[0], "a fresh ref was assigned without clearing chunk_cursor").toContain(
        "chunk_cursor: null",
      );
    }
  });
});

describe("a cursor the file cannot support never writes a ledger row", () => {
  it("the walk is judged against the count it produced", () => {
    expect(replay).toContain("if (cursorRanPastEnd(skip, index))");
  });

  it("returns a PAUSE, so the caller breaks before recording the migration", () => {
    const at = replay.indexOf("if (cursorRanPastEnd(skip, index))");
    expect(at).toBeGreaterThan(-1);
    const body = replay.slice(at, at + 400);
    expect(body).toContain("stoppedEarly: true");
    expect(body).toContain("applied: 0");
  });

  it("hands back a ZERO cursor rather than clearing it", () => {
    /*
      The fleet lane stores a returned cursor, clears one whose file landed,
      and otherwise leaves the stored value alone. A null here would take that
      third branch and leave the unusable cursor in place for ever — the same
      livelock one layer along. Zero is an ordinary value the next pass acts on
      by sending from the first statement.
    */
    const at = replay.indexOf("if (cursorRanPastEnd(skip, index))");
    // Bounded to the guard's OWN block. A byte window would run on into the
    // success return below it, which legitimately carries `cursor: null` —
    // and this assertion would then be about that line instead.
    const body = replay.slice(at, replay.indexOf("\n  }", at));
    expect(body).toContain("statementsDone: 0");
    expect(body).not.toMatch(/cursor:\s*null/);
  });

  it("the guard runs BEFORE the success return, not after it", () => {
    const guard = replay.indexOf("if (cursorRanPastEnd(skip, index))");
    const success = replay.indexOf(
      "return { applied, stoppedEarly: false, cursor: null, upstreamRefusal: null };",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(guard);
  });
});
