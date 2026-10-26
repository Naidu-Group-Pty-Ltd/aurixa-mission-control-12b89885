import { describe, expect, it } from "vitest";
import {
  decideAcrossBases,
  decideVariantMerge,
  matchLines,
  MAX_AGREEING_BASES,
  MAX_VARIANT_MERGES,
  orderVariantMergeCandidates,
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
    // The commit's own names are the candidates; the older reconcile is not
    // one of them, because the true base is the newest reconcile's.
    expect(
      variantBaseFrom([
        { sha: "c2", message: "Land the cascades at prime@278cdc3 and prime@1A39B32" },
        { sha: "c1", message: "Reconcile at prime@e02572f" },
      ]),
    ).toEqual({ kind: "ambiguous", primeRevisions: ["278cdc3", "1a39b32"], commit: "c2" });
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

describe("the verdict when the reconcile names several prime revisions", () => {
  // Nine lines, so a change on line 2, line 5 and line 8 are three separate
  // hunks: the merge (rightly) reads changes on ADJACENT lines as one hunk,
  // and a hunk both sides changed differently is a conflict.
  const nine = (over: Record<number, string> = {}) =>
    lines(...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((x, i) => over[i + 1] ?? x));
  // Two candidate bases that differ on line 5: the true base is one of them.
  const X = { revision: "a".repeat(40), text: nine() };
  const Y = { revision: "b".repeat(40), text: nine({ 5: "5y" }) };
  const commit = "c2c2c2c2c2";

  it("writes where every base gives the same merge", () => {
    const ours = nine({ 2: "2o", 5: "5y" });
    const theirs = nine({ 5: "5y", 8: "8t" });
    const merged = nine({ 2: "2o", 5: "5y", 8: "8t" });
    const v = decideAcrossBases({ commit, bases: [X, Y], ours, theirs });
    expect(v).toMatchObject({ act: "write", text: merged });
    // Each base, on its own, gives that same text.
    for (const base of [X, Y]) {
      expect(decideVariantMerge({ base, ours, theirs })).toMatchObject({
        act: "write",
        text: merged,
      });
    }
    // The base it reports is a full revision, as the ledger requires.
    if (v.act === "write") expect(v.base).toBe(X.revision);
  });

  it("is current where every base finds nothing owed", () => {
    const ours = nine({ 2: "2o", 5: "5y" });
    const theirs = nine({ 5: "5y" });
    expect(decideAcrossBases({ commit, bases: [X, Y], ours, theirs })).toEqual({
      act: "current",
      base: X.revision,
    });
  });

  it("holds where the bases disagree on the result, each merge clean", () => {
    const ours = nine({ 2: "2o" });
    const theirs = nine({ 5: "5y" });
    // Against X prime changed line 5 and the line did not: the merge takes 5y.
    // Against Y the line changed 5 back and prime did not: the line's copy stands.
    expect(decideVariantMerge({ base: X, ours, theirs })).toMatchObject({
      act: "write",
      text: nine({ 2: "2o", 5: "5y" }),
    });
    expect(decideVariantMerge({ base: Y, ours, theirs }).act).toBe("current");
    const v = decideAcrossBases({ commit, bases: [X, Y], ours, theirs });
    expect(v.act).toBe("hold");
    if (v.act === "hold") {
      expect(v.why).toContain("different result");
      expect(v.why).toContain("c2c2c2c");
      expect(v.transient).toBeUndefined();
    }
  });

  it("holds where any one base conflicts, and says which", () => {
    const ours = nine({ 2: "2o", 5: "5o" });
    const theirs = nine({ 5: "5y", 8: "8t" });
    // Against Y the line changed 5 and prime did not, so it merges cleanly;
    // against X both changed 5, differently.
    expect(decideVariantMerge({ base: Y, ours, theirs }).act).toBe("write");
    expect(decideVariantMerge({ base: X, ours, theirs }).act).toBe("hold");
    const v = decideAcrossBases({ commit, bases: [X, Y], ours, theirs });
    expect(v.act).toBe("hold");
    if (v.act === "hold") expect(v.why).toContain("prime@aaaaaaa");
  });

  it("holds where any base's copy is missing", () => {
    const ours = nine({ 2: "2o", 5: "5y" });
    const theirs = nine({ 5: "5y", 8: "8t" });
    const v = decideAcrossBases({
      commit,
      bases: [X, { revision: Y.revision, text: null }],
      ours,
      theirs,
    });
    expect(v.act).toBe("hold");
  });

  it(`holds past ${MAX_AGREEING_BASES} bases without merging`, () => {
    const many = Array.from({ length: MAX_AGREEING_BASES + 1 }, (_, i) => ({
      revision: String(i).repeat(40),
      text: lines("a"),
    }));
    const v = decideAcrossBases({ commit, bases: many, ours: lines("a"), theirs: lines("a") });
    expect(v.act).toBe("hold");
    if (v.act === "hold") expect(v.why).toContain(String(MAX_AGREEING_BASES));
  });

  it("is exactly the single-base verdict for one base", () => {
    const ours = nine({ 2: "2o" });
    for (const theirs of [nine({ 8: "8t" }), nine({ 2: "2t" }), nine()]) {
      expect(decideAcrossBases({ commit, bases: [X], ours, theirs })).toEqual(
        decideVariantMerge({ base: X, ours, theirs }),
      );
    }
    expect(decideAcrossBases({ commit, bases: [], ours, theirs: ours })).toEqual(
      decideVariantMerge({ base: null, ours, theirs: ours }),
    );
  });
});

describe("which held paths a pass merges first", () => {
  it("offers function entrypoints first, then source, then the rest, stably", () => {
    const held = [
      ".github/workflows/ci.yml",
      "scripts/security/check-ghl-message-authz.mjs",
      "src/pages/CallLogs.tsx",
      "supabase/functions/_shared/clients/noteWords.pure.ts",
      "supabase/functions/ai-dashboard-agent/index.ts",
      "CLAUDE.md",
      "supabase/functions/request-lead-magnet/index.ts",
    ].map((path) => ({ path }));
    expect(orderVariantMergeCandidates(held).map((h) => h.path)).toEqual([
      "supabase/functions/ai-dashboard-agent/index.ts",
      "supabase/functions/request-lead-magnet/index.ts",
      "src/pages/CallLogs.tsx",
      "supabase/functions/_shared/clients/noteWords.pure.ts",
      ".github/workflows/ci.yml",
      "scripts/security/check-ghl-message-authz.mjs",
      "CLAUDE.md",
    ]);
  });

  it("asks about every held path #104 carried, the agent included", () => {
    // Twenty-six held on #104, the agent twenty-second in list order.
    expect(MAX_VARIANT_MERGES).toBeGreaterThanOrEqual(26);
  });
});

describe("a history that begins at the clone's first commit", () => {
  it("is based on that copy where nothing names a revision", () => {
    expect(
      variantBaseFrom([
        { sha: "c2", message: "Close the line's last reach into GoHighLevel" },
        { sha: "c1", message: "Initial commit", root: true, date: "2026-09-19T05:20:40Z" },
      ]),
    ).toEqual({ kind: "mirror", commit: "c1", date: "2026-09-19T05:20:40Z" });
  });

  it("prefers any commit that names a revision, however old", () => {
    expect(
      variantBaseFrom([
        { sha: "c3", message: "an edit" },
        { sha: "c2", message: "Reconcile at prime@e02572f" },
        { sha: "c1", message: "Initial commit", root: true, date: "2026-09-19T05:20:40Z" },
      ]),
    ).toEqual({ kind: "named", primeRevision: "e02572f", commit: "c2" });
  });

  it("is no base where the walk stopped short of the first commit, or it has no date", () => {
    expect(
      variantBaseFrom([
        { sha: "c2", message: "an edit" },
        { sha: "c1", message: "older" },
      ]),
    ).toEqual({
      kind: "none",
    });
    expect(variantBaseFrom([{ sha: "c1", message: "Initial commit", root: true }])).toEqual({
      kind: "none",
    });
  });
});
