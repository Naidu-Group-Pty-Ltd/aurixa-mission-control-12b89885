// The recipe book IS the proven stack - measured, not asserted.
//
// build-fleet-prompts.py generates Mission Control's twelve live assistant
// prompts and writes the agent data it used to fleet-spec.json. This compiles
// that data through the TypeScript recipe book with Mission Control's own
// business context and requires every prompt to come out byte for byte. A
// section that drifts on either side fails here, so the Voice Cloning Studio
// can never quietly build clients a different prompt from the one that runs.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "./compiler.pure";
import { AURIXA_CONTEXT, AURIXA_TOOL_NAMES, agentFromFleetSpec, type FleetSpecAgent } from "./fixtures/aurixa.pure";

const DIR = join(process.cwd(), "scripts/voice/fleet-prompts");
const spec = JSON.parse(readFileSync(join(DIR, "fleet-spec.json"), "utf8")) as {
  agents: Record<string, FleetSpecAgent>;
};

describe("recipe book reproduces Mission Control's fleet", () => {
  const keys = Object.keys(spec.agents);

  it("covers every generated prompt", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(keys.slice().sort()).toEqual(files);
    expect(keys.length).toBe(12);
  });

  for (const key of keys) {
    it(`${key}.md is byte-identical`, () => {
      const want = readFileSync(join(DIR, `${key}.md`), "utf8");
      const got = compileAgentPrompt(agentFromFleetSpec(key, spec.agents[key]), {
        business: AURIXA_CONTEXT,
        toolNames: AURIXA_TOOL_NAMES,
      });
      if (got !== want) {
        // Point at the first differing line rather than dumping 30 KB.
        const g = got.split("\n");
        const w = want.split("\n");
        const i = g.findIndex((line, idx) => line !== w[idx]);
        throw new Error(
          `${key}: first difference at line ${i + 1}\n  want: ${JSON.stringify(w[i])}\n  got:  ${JSON.stringify(g[i])}`,
        );
      }
      expect(got).toBe(want);
    });
  }
});
