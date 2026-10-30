import { describe, expect, it } from "vitest";
import {
  COMPARE_FILE_CEILING,
  describeProtectedChanges,
  protectedOwnCopies,
  readComparison,
  type ProtectedChanges,
} from "./protectedChanges.pure";
import {
  DEFAULT_MIRROR_EXCLUSIONS,
  partitionCascadePaths,
  type HeldPath,
} from "./syncExclusions.pure";

const row = (path: string, note: string | null = null): HeldPath => ({
  path,
  pattern: path,
  reason: "protected",
  note,
});

describe("protectedOwnCopies — the holds the question is about", () => {
  it("is the paths a protected exclusion row withheld, as the partition holds them", () => {
    const { held } = partitionCascadePaths(
      [".gitleaks.toml", "vite.config.ts", "src/App.tsx", "src/a.ts"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    // `src/App.tsx` is `manual_reconcile` and is named under "Needs a human".
    expect(protectedOwnCopies(held, new Set(), new Set()).map((h) => h.path)).toEqual([
      ".gitleaks.toml",
      "vite.config.ts",
    ]);
  });

  it("leaves out a boundary the engine composed: prime-only, another line's, a kept spec", () => {
    const held: HeldPath[] = [
      {
        path: "docs/tutorial-audit/x.csv",
        pattern: "(prime-only: tutorial-programme)",
        reason: "protected",
        note: null,
      },
      {
        path: "src/lib/agent/__tests__/a.spec.ts",
        pattern: "(crm-line kept: src/lib/agent/__tests__/**)",
        reason: "protected",
        note: null,
      },
      {
        path: "src/x.ts",
        pattern: "(another deployment's own: src/x.ts)",
        reason: "protected",
        note: null,
      },
      row("vercel.json"),
    ];
    expect(protectedOwnCopies(held, new Set(), new Set()).map((h) => h.path)).toEqual([
      "vercel.json",
    ]);
  });

  it("leaves out what a reconcile decided and what is already named for a person", () => {
    const held = [row("supabase/config.toml"), row(".gitleaks.toml"), row("vercel.json")];
    expect(
      protectedOwnCopies(held, new Set(["supabase/config.toml"]), new Set([".gitleaks.toml"])).map(
        (h) => h.path,
      ),
    ).toEqual(["vercel.json"]);
  });

  it("names a path once, however many holds it has", () => {
    const held = [row("vercel.json"), row("vercel.json")];
    expect(protectedOwnCopies(held, new Set(), new Set())).toHaveLength(1);
  });
});

describe("readComparison — what the file list can and cannot say", () => {
  const candidates = [row(".gitleaks.toml"), row("vite.config.ts")];

  it("names the candidates the list names, a rename's old name included", () => {
    const read = readComparison({
      candidates,
      files: ["scripts/security/check-security-gate-negatives.mjs", ".gitleaks.toml"],
      truncated: false,
    });
    expect(read.changed.map((h) => h.path)).toEqual([".gitleaks.toml"]);
    expect(read.unseen).toEqual([]);
  });

  it("vouches for nothing it does not name once the list reached its ceiling", () => {
    const files = Array.from({ length: COMPARE_FILE_CEILING }, (_, i) => `f${i}.ts`);
    const read = readComparison({
      candidates,
      files: [...files, ".gitleaks.toml"],
      truncated: true,
    });
    expect(read.changed.map((h) => h.path)).toEqual([".gitleaks.toml"]);
    expect(read.unseen.map((h) => h.path)).toEqual(["vite.config.ts"]);
  });
});

describe("describeProtectedChanges — the proposal's section", () => {
  const base = "6dbda6107aab22f00cf81e2b03f44bbf2df735c3";
  const head = "ca5009825aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pc = (over: Partial<ProtectedChanges>): ProtectedChanges => ({
    base,
    head,
    changed: [],
    notAsked: [],
    why: null,
    ...over,
  });

  it("names each changed path with why the clone keeps it, and the range", () => {
    const text = describeProtectedChanges(
      pc({ changed: [row(".gitleaks.toml", "Allowlists THIS deployment's own key.")] }),
    );
    expect(text).toContain("between prime@6dbda61 and prime@ca50098");
    expect(text).toContain("- `.gitleaks.toml` — Allowlists THIS deployment's own key.");
  });

  it("says a question it could not ask was not asked, and never unchanged", () => {
    const text = describeProtectedChanges(
      pc({ notAsked: [row("vite.config.ts")], why: "the comparison could not be read (502)" }),
    );
    expect(text).toContain("could not be asked: the comparison could not be read (502)");
    expect(text).toContain("Not asked is not unchanged.");
    expect(text).toContain("- `vite.config.ts`");
  });

  it("is empty when prime changed none of them, so the section is left out", () => {
    expect(describeProtectedChanges(pc({}))).toBe("");
    expect(describeProtectedChanges(null)).toBe("");
  });
});
