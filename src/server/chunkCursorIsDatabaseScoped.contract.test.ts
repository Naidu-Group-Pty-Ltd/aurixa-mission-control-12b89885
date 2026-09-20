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
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (src: string): string =>
  stripComments(src);

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
    // `onProjectRef` is where a row FIRST points at a different database.
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

  /**
   * The whole object literal of the `.update({ … })` call containing an
   * anchor, by matching braces rather than by counting bytes.
   *
   * Neither sibling helper can read the completion write: it nests four
   * conditional spreads and the parity report, so `updateAfter`'s first `})`
   * lands inside the first spread, and a fixed window lands wherever this
   * file's comments happen to leave it. A window that drifts is how an
   * assertion comes to pass about nothing, which this suite has paid for
   * twice already. Comments are stripped by `code()` before this runs, so the
   * only braces it counts are real ones.
   */
  const updateObjectContaining = (src: string, anchor: string): string => {
    const at = src.indexOf(anchor);
    expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
    const open = src.lastIndexOf(".upd" + "ate({", at);
    expect(open, `no update call around ${anchor}`).toBeGreaterThan(-1);
    let depth = 0;
    let i = src.indexOf("{", open);
    for (; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(depth, `unbalanced braces from ${anchor}`).toBe(0);
    return src.slice(open, i + 1);
  };

  /*
    AND THE SECOND WRITER OF THE REF, WHICH THE FIRST VERSION OF THIS FILE
    ARGUED DID NOT NEED IT.

    It said the completion write "re-states the ref this run already
    recorded, so clearing there would discard a live cursor instead". That is
    true only when `onProjectRef` SUCCEEDED, and its failure is deliberately
    not fatal — a paid project exists by then, so the run logs and carries on.
    On that path the completion write is the first to persist the new ref, and
    it persisted it beside the dead cursor.

    Raised by review on the commit that added the rule above. Worth recording
    as the shape rather than the instance: a guard placed at "the one place
    that does X" is only as good as the claim that it is the one place, and
    that claim is what goes stale.
  */
  it("the completion write clears a cursor from a database this run replaced", () => {
    const call = updateObjectContaining(provisioning, "supabase_project_ref: result.projectRef");
    expect(call).toContain("chunk_cursor: null");
  });

  it("and only when the ref actually changed, so a repair keeps its resume point", () => {
    // Unconditional would be safe for correctness and wrong as a rule: the
    // cursor dies with the DATABASE, not with a provisioning run. A repair
    // that keeps the same project keeps a live fleet resume point, and
    // clearing it re-sends a 40 MB seed from statement 1 for nothing.
    const call = updateObjectContaining(provisioning, "supabase_project_ref: result.projectRef");
    expect(call).toContain("result.projectRef !== existingRow?.supabase_project_ref");
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
