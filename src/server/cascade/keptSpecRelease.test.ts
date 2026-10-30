import { describe, expect, it } from "vitest";
import {
  describeKeptSpecsLeftBehind,
  isCrmLineKeptHold,
  treeAfterDelivery,
  whatKeptSpecLacks,
} from "./keptSpecRelease.pure";
import type { TreeIndex } from "./importClosure.pure";
import { CRM_LINE_KEPT_HOLD_PREFIX, partitionCascadePaths } from "./syncExclusions.pure";

const tree = (...paths: string[]) => new Map(paths.map((p) => [p, `sha:${p}`]));

const VOICE_SPEC = "src/lib/agent/__tests__/aurixaVoice.spec.ts";
const TRANSCRIPT_SPEC = "src/lib/agent/__tests__/transcriptQuality.spec.ts";
const PARITY_SPEC = "src/lib/agent/__tests__/marketNews.spec.tsx";

// The shapes the incident's two specs and a parity-register spec are written in
// (prime@f0c9a35): a relative import with its extension, a named file read
// from disk, and an `@/` import of the module the line removed.
const VOICE_TEXT = [
  `import { readFileSync } from 'node:fs';`,
  `import { describe, expect, it } from 'vitest';`,
  `import { AURIXA_VOICES } from '../../../../supabase/functions/_shared/voice/aurixaVoice.pure.ts';`,
  `const src = read('supabase/functions/agent-speech/index.ts');`,
].join("\n");
const TRANSCRIPT_TEXT = [
  `import { transcriptionAttempts } from '../../../../supabase/functions/_shared/voice/transcriptQuality.pure';`,
  `const FUNCTION = readFileSync(resolve(ROOT, 'supabase/functions/voice-to-text/index.ts'), 'utf8');`,
].join("\n");
const PARITY_TEXT = [
  `// parityRegister is named in this comment, which is not an import.`,
  `import { PARITY_REGISTER } from "@/lib/agent/parityRegister";`,
  `import { askAgent } from "../askAgent";`,
].join("\n");

// The line's tree after the delivery: the voice code crossed, the parity
// register is gone (b2809b77), the agent module the third spec imports is there.
const LINE = tree(
  "supabase/functions/_shared/voice/aurixaVoice.pure.ts",
  "supabase/functions/_shared/voice/transcriptQuality.pure.ts",
  "supabase/functions/agent-speech/index.ts",
  "supabase/functions/voice-to-text/index.ts",
  "src/lib/agent/askAgent.ts",
  VOICE_SPEC,
  TRANSCRIPT_SPEC,
  PARITY_SPEC,
);

// Prime's tree: all of that, the parity register, and the GoHighLevel code the
// line does not carry.
const PRIME = new Map([
  ...LINE,
  ...tree(
    "src/lib/agent/parityRegister.ts",
    "supabase/functions/sync-ghl-pipelines/index.ts",
    "src/lib/agent/fresh.ts",
  ),
]);

describe("isCrmLineKeptHold — the line's kept-tree hold and no other", () => {
  it("reads the spelling the partition writes", () => {
    const [kept] = partitionCascadePaths([VOICE_SPEC], [], {
      crmMode: "independent",
      fromAnotherLine: true,
    }).held;
    expect(kept.pattern.startsWith(CRM_LINE_KEPT_HOLD_PREFIX)).toBe(true);
    expect(isCrmLineKeptHold(kept)).toBe(true);
  });

  it("is false of a variant, a left-behind hold and an exclusion row", () => {
    expect(isCrmLineKeptHold({ pattern: "(crm-line variant: src/pages/CallLogs.tsx)" })).toBe(
      false,
    );
    expect(
      isCrmLineKeptHold({
        pattern: "(membrane: prime→clone · spec channel: left behind by its subject)",
      }),
    ).toBe(false);
    expect(isCrmLineKeptHold({ pattern: ".gitleaks.toml" })).toBe(false);
  });
});

describe("treeAfterDelivery — the clone as the delivery leaves it", () => {
  it("keeps what the clone holds, adds what the delivery writes, drops what it removes", () => {
    const after = treeAfterDelivery({
      clone: tree("a.ts", "gone.ts"),
      writes: ["new.ts", "a.ts"],
      removes: new Set(["gone.ts"]),
    });
    expect([...after.keys()].sort()).toEqual(["a.ts", "new.ts"]);
    // A file the clone already holds keeps its own sha; the write does not invent one.
    expect(after.get("a.ts")).toBe("sha:a.ts");
  });

  it("never brings back a file the delivery both writes and removes", () => {
    const after = treeAfterDelivery({
      clone: tree(),
      writes: ["x.ts"],
      removes: new Set(["x.ts"]),
    });
    expect(after.has("x.ts")).toBe(false);
  });
});

describe("whatKeptSpecLacks — can prime's copy run on the line?", () => {
  const lacks = (specPath: string, primeText: string, present: TreeIndex = LINE) =>
    whatKeptSpecLacks({ specPath, primeText, prime: PRIME, present });

  it("needs nothing for the incident's two specs: both may travel", () => {
    expect(lacks(VOICE_SPEC, VOICE_TEXT)).toEqual([]);
    expect(lacks(TRANSCRIPT_SPEC, TRANSCRIPT_TEXT)).toEqual([]);
  });

  it("judges an extensionless import by where it resolves, and names it as prime does", () => {
    const text = `import { t } from '../../../../supabase/functions/_shared/voice/transcriptQuality.pure';`;
    expect(lacks(TRANSCRIPT_SPEC, text)).toEqual([]);
    expect(lacks(TRANSCRIPT_SPEC, text, tree())).toEqual([
      "supabase/functions/_shared/voice/transcriptQuality.pure.ts",
    ]);
  });

  it("names the parity register for a spec that imports it, which stays the line's", () => {
    expect(lacks(PARITY_SPEC, PARITY_TEXT)).toEqual(["src/lib/agent/parityRegister.ts"]);
  });

  it("reads a relative import of the removed module the same way", () => {
    expect(lacks(PARITY_SPEC, `import { PARITY_REGISTER } from "../parityRegister";`)).toEqual([
      "src/lib/agent/parityRegister.ts",
    ]);
  });

  it("names a file the spec reads that prime holds and the line does not", () => {
    const text = `const src = read('supabase/functions/sync-ghl-pipelines/index.ts');`;
    expect(lacks(VOICE_SPEC, text)).toEqual(["supabase/functions/sync-ghl-pipelines/index.ts"]);
  });

  it("is never kept back by an import line a spec asserts about as text", () => {
    // `distribution.spec.ts` (prime@f0c9a35) checks the panel's own import,
    // which read from the spec's directory is `src/supabase/…`. Replayed on
    // cascade PR #160, that alone was listed as a reason to keep the spec.
    const text = [
      `expect(PANEL).toContain("from '../../../supabase/functions/_shared/voice/aurixaVoice.pure.ts';");`,
      `expect(AUTHZ).toContain("from './agentLibrary/access.pure.ts'");`,
    ].join("\n");
    expect(lacks(VOICE_SPEC, text, tree())).toEqual([]);
  });

  it("counts what the delivery writes, and not what it removes", () => {
    const text = `import { x } from "@/lib/agent/fresh";\nconst s = read('supabase/functions/agent-speech/index.ts');`;
    const after = treeAfterDelivery({
      clone: LINE,
      writes: ["src/lib/agent/fresh.ts"],
      removes: new Set(["supabase/functions/agent-speech/index.ts"]),
    });
    expect(lacks(VOICE_SPEC, text, after)).toEqual(["supabase/functions/agent-speech/index.ts"]);
  });

  it("ignores packages and node built-ins, which no clone tree holds", () => {
    const text = `import { describe } from "vitest";\nimport { readFileSync } from "node:fs";`;
    expect(lacks(VOICE_SPEC, text, tree())).toEqual([]);
  });
});

describe("describeKeptSpecsLeftBehind — the proposal's list", () => {
  it("names each spec, what crossed and what prime's copy lacks, in path order", () => {
    const text = describeKeptSpecsLeftBehind([
      {
        spec: PARITY_SPEC,
        touchedBy: ["src/lib/agent/askAgent.ts"],
        lacks: ["src/lib/agent/parityRegister.ts"],
      },
      {
        spec: "src/lib/agent/__tests__/a.spec.ts",
        touchedBy: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        lacks: ["src/lib/agent/parityRegister.ts"],
      },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("`src/lib/agent/__tests__/a.spec.ts`");
    expect(lines[0]).toContain("`a.ts`, `b.ts`, `c.ts` and 2 more");
    expect(lines[1]).toContain(`\`${PARITY_SPEC}\``);
    expect(lines[1]).toContain("needs `src/lib/agent/parityRegister.ts`");
    expect(lines[1]).toContain("updated here");
  });

  it("is empty for none, so the section is left out", () => {
    expect(describeKeptSpecsLeftBehind([])).toBe("");
  });
});
