import { describe, expect, it } from "vitest";
import {
  decideVariantMerge,
  matchLines,
  primeRevisionNamedBy,
  threeWayMerge,
  variantBaseFrom,
} from "./variantMerge.pure";

const lines = (...xs: string[]) => xs.join("\n") + "\n";

describe("the base is read off the line's own history", () => {
  it("takes the one prime revision a reconcile or a statement commit names", () => {
    expect(
      primeRevisionNamedBy("Reconcile the CRM's agent at prime@e02572f: Aurixa publishes"),
    ).toBe("e02572f");
    expect(primeRevisionNamedBy("chore(aurixa): cascade 258 file(s) from prime@6C2180A")).toBe(
      "6c2180a",
    );
    expect(
      primeRevisionNamedBy("Land the cascade at prime@6c2180a (#104); prime@6c2180a again"),
    ).toBe("6c2180a");
  });

  it("refuses a message naming two revisions, and one naming none", () => {
    expect(primeRevisionNamedBy("Land the cascades at prime@278cdc3 and prime@1a39b32")).toBeNull();
    expect(primeRevisionNamedBy("Withhold the agent's note copy on the CRM line")).toBeNull();
    expect(primeRevisionNamedBy("prime@abc")).toBeNull(); // too short to be a revision
  });

  it("walks past the line's own edits to the newest commit that names a base", () => {
    const base = variantBaseFrom([
      { sha: "c3", message: "Report the voice agents' calls on this line" },
      { sha: "c2", message: "Reconcile the cascade at prime@6c2180a (#104) on the CRM line" },
      { sha: "c1", message: "Reconcile the CRM's agent at prime@e02572f" },
    ]);
    expect(base).toEqual({ kind: "named", primeRevision: "6c2180a", commit: "c2" });
  });

  it("stops at an ambiguous commit rather than reaching past it to an older base", () => {
    expect(
      variantBaseFrom([
        { sha: "c2", message: "Land the cascades at prime@278cdc3 and prime@1a39b32" },
        { sha: "c1", message: "Reconcile at prime@e02572f" },
      ]),
    ).toEqual({ kind: "ambiguous", commit: "c2" });
    expect(variantBaseFrom([{ sha: "c1", message: "an edit" }])).toEqual({ kind: "none" });
  });
});

describe("the matcher", () => {
  it("matches increasing pairs and leaves changed lines unmatched", () => {
    const m = matchLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(Array.from(m)).toEqual([0, -1, 2, 3]);
  });

  it("anchors on unique lines when the rest repeats", () => {
    const a = ["}", "}", "function one() {", "}", "}"];
    const b = ["}", "function one() {", "}", "}", "}"];
    const m = Array.from(matchLines(a, b));
    expect(m[2]).toBe(1); // the unique line is matched to itself
    for (let i = 1; i < m.length; i++)
      if (m[i] >= 0 && m[i - 1] >= 0) expect(m[i]).toBeGreaterThan(m[i - 1]);
  });
});

describe("the three-way merge", () => {
  const base = lines(
    "import a;",
    "",
    "function calendar() {",
    "  return ghl();",
    "}",
    "",
    "function notes() {",
    "  return 1;",
    "}",
  );

  it("keeps the line's change and brings prime's, when they touch different hunks", () => {
    const ours = base.replace("return ghl();", "return crmCalendar();");
    const theirs = base
      .replace("return 1;", "return 2;")
      .replace("import a;", "import a;\nimport b;");
    const m = threeWayMerge(base, ours, theirs);
    expect(m).toMatchObject({ clean: true });
    if (!m.clean) return;
    expect(m.text).toBe(
      lines(
        "import a;",
        "import b;",
        "",
        "function calendar() {",
        "  return crmCalendar();",
        "}",
        "",
        "function notes() {",
        "  return 2;",
        "}",
      ),
    );
    expect(m.fromClone).toBe(1);
    expect(m.fromPrime).toBe(2);
  });

  it("is a conflict when both changed the same hunk differently — and then writes nothing", () => {
    const ours = base.replace("return ghl();", "return crmCalendar();");
    const theirs = base.replace("return ghl();", "return liveCalendar();");
    expect(threeWayMerge(base, ours, theirs)).toEqual({ clean: false, conflicts: 1 });
  });

  it("takes an identical change once", () => {
    const both = base.replace("return 1;", "return 3;");
    const m = threeWayMerge(base, both, both);
    expect(m).toMatchObject({ clean: true, text: both });
  });

  it("round-trips the ending: a file without a final newline keeps none", () => {
    const b = "a\nb\nc";
    const m = threeWayMerge(b, "a\nB\nc", "a\nb\nc\nd");
    expect(m).toEqual({ clean: true, text: "a\nB\nc\nd", fromPrime: 1, fromClone: 1 });
  });

  it("keeps an insertion at the very start and one at the very end", () => {
    const m = threeWayMerge("x\ny\n", "top\nx\ny\n", "x\ny\nbottom\n");
    expect(m).toMatchObject({ clean: true, text: "top\nx\ny\nbottom\n" });
  });

  it("is a conflict when both sides insert different lines at the same place", () => {
    expect(threeWayMerge("x\ny\n", "x\nours\ny\n", "x\ntheirs\ny\n")).toEqual({
      clean: false,
      conflicts: 1,
    });
  });
});

describe("the verdict for one held path", () => {
  const base = lines("a", "b", "c", "d", "e");
  const ours = lines("a", "B (line)", "c", "d", "e");

  it("writes the merge where prime moved", () => {
    const v = decideVariantMerge({
      base: { revision: "36fae6b4", text: base },
      ours,
      theirs: lines("a", "b", "c", "d", "E (prime)"),
    });
    expect(v).toEqual({
      act: "write",
      text: lines("a", "B (line)", "c", "d", "E (prime)"),
      base: "36fae6b4",
      fromPrime: 1,
      fromClone: 1,
    });
  });

  it("is current — nothing owed — where everything prime changed is already in the line's copy", () => {
    const theirs = lines("a", "b", "c", "D", "e");
    const ours2 = lines("a", "B (line)", "c", "D", "e");
    expect(
      decideVariantMerge({ base: { revision: "36fae6b4", text: base }, ours: ours2, theirs }),
    ).toEqual({
      act: "current",
      base: "36fae6b4",
    });
  });

  it("holds without a base, without a base copy, and on a conflict", () => {
    expect(decideVariantMerge({ base: null, ours, theirs: base }).act).toBe("hold");
    expect(
      decideVariantMerge({ base: { revision: "36fae6b4", text: null }, ours, theirs: base }).act,
    ).toBe("hold");
    const v = decideVariantMerge({
      base: { revision: "36fae6b4", text: base },
      ours,
      theirs: lines("a", "b (prime)", "c", "d", "e"),
    });
    expect(v).toMatchObject({ act: "hold" });
    if (v.act === "hold") expect(v.why).toContain("prime@36fae6b");
  });
});
