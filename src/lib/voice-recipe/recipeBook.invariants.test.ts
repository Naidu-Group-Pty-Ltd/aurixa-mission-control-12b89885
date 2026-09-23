// Properties the recipe book must keep however it grows.
import { describe, expect, it } from "vitest";
import { ARCHETYPES, ARCHETYPE_KEYS } from "./archetypes.pure";
import { compileAgentPrompt } from "./compiler.pure";
import { LESSONS } from "./lessons.pure";
import { RECIPE_BOOK_VERSION, recipeBookSha, serializeRecipeBook } from "./recipeBook.pure";
import { PLAYBOOK_PROVENANCE } from "./sections/playbooks.pure";
import { BACKEND_MENU, TOOL_CATALOG, isDeployable, vapiToolPayload } from "./tools.pure";
import {
  DEFAULT_TOOL_NAMES,
  PLAYBOOK_IDS,
  TOOL_KEYS,
  type AgentSpec,
  type BusinessVoiceContext,
} from "./types.pure";

/** A business whose every slot says only "Placeholder" - anything else in a prompt came from the book. */
const PLACEHOLDER: BusinessVoiceContext = {
  businessName: "Placeholder Co",
  productionTag: "Production - Mission Control voice fleet",
  identityParagraph: "Placeholder Co does placeholder work.",
  kb: {
    materials: "- placeholder",
    factualQueries: '"placeholder?"',
    valueTriggers: "- placeholder",
  },
  speechRules: "- placeholder",
  skeptical: { context: "Placeholder.", quotes: ['> "placeholder"'] },
  facts: { title: "Placeholder facts", body: "Placeholder." },
  transferDestination: "Placeholder team",
  humanFollowUpQuote: '> "placeholder"',
  boundaries: {
    adviceDomains: "placeholder advice",
    adviceDeflectQuote: '> "placeholder"',
    claimsDiscipline: "- placeholder",
    pricingDiscipline: "Placeholder.",
  },
  closingQuote: '> "placeholder"',
  booking: {
    intro: "{persona} books placeholders.",
    timezoneNote: "Placeholder.",
    successExpectation: "placeholder.",
    finalityBoundary: "Placeholder.",
    afterBookingRule: "Placeholder",
  },
  absolute: { baseNever: ["Placeholder"], baseAlways: ["Placeholder"] },
};

function agentFor(key: (typeof ARCHETYPE_KEYS)[number]): AgentSpec {
  const a = ARCHETYPES[key];
  return {
    key,
    name: "Placeholder Agent",
    persona: "Pat",
    temperament: "placeholder",
    direction: a.direction,
    tools: [...a.defaultTools, ...a.optionalTools],
    roleTitle: "Placeholder Role",
    roleSummary: "Placeholder.",
    opening: "## 0.1 Opening Behaviour\n\nPlaceholder.",
    canDo: ["placeholder"],
    cannotDo: ["placeholder"],
    extraSections: null,
    dialogues: [{ title: "Placeholder", caller: "placeholder", reply: "placeholder" }],
    extraNever: [],
    extraAlways: [],
    playbooks: a.playbooks,
  };
}

describe("recipe book invariants", () => {
  it("no section carries another business's words", () => {
    for (const key of ARCHETYPE_KEYS) {
      const prompt = compileAgentPrompt(agentFor(key), {
        business: PLACEHOLDER,
        toolNames: DEFAULT_TOOL_NAMES,
      });
      expect(prompt, key).not.toMatch(
        /\b(Aurixa|NPC|Naidu|Angela|Sandra|Monica|Erica|Rita|Mary|Sydney)\b|strategic review/i,
      );
    }
  });

  it("absolute rules close every prompt", () => {
    for (const key of ARCHETYPE_KEYS) {
      const prompt = compileAgentPrompt(agentFor(key), {
        business: PLACEHOLDER,
        toolNames: DEFAULT_TOOL_NAMES,
      });
      const last = prompt.lastIndexOf("\n# ");
      expect(prompt.slice(last), key).toMatch(/^\n# 15\. Absolute Rules/);
    }
  });

  it("every archetype binds end_call and can reach a deployable backend for each default tool", () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      expect(a.defaultTools, key).toContain("end_call");
      for (const t of a.defaultTools) {
        expect(
          TOOL_CATALOG[t].allowedBackends.some((b) => isDeployable(t, b)),
          `${key}/${t}`,
        ).toBe(true);
      }
    }
  });

  it("outbound archetypes wait for the callee; inbound ones speak first", () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      expect(a.firstMessageMode).toBe(
        a.direction === "outbound" ? "assistant-waits-for-user" : "assistant-speaks-first",
      );
    }
  });

  it("transfer never uses VAPI's native transfer (TRANSFER_NATIVE_FAILS)", () => {
    expect(TOOL_CATALOG.transfer_to_human.allowedBackends).toEqual(["make_twilio_redirect"]);
  });

  it("an unimplemented backend is never deployable", () => {
    for (const t of TOOL_KEYS) {
      for (const b of Object.values(BACKEND_MENU)) {
        if (!b.implemented) expect(isDeployable(t, b.key)).toBe(false);
      }
    }
  });

  it("tool payloads carry placeholders, never a URL or a secret", () => {
    const ctx = {
      names: DEFAULT_TOOL_NAMES,
      businessName: "Placeholder Co",
      transferDestination: "the Placeholder team",
      bookingTypeLabels: ["consult"],
      bookingWindowSpoken: "Slots are 30 minutes.",
      handoffIntents: ["book"],
    };
    for (const t of TOOL_KEYS) {
      for (const b of TOOL_CATALOG[t].allowedBackends) {
        const p = vapiToolPayload(t, b, ctx);
        if (!p) continue;
        const s = JSON.stringify(p);
        expect(s, `${t}/${b}`).not.toMatch(/https?:\/\//);
      }
    }
  });

  it("every playbook records where it came from, and lessons have unique ids", () => {
    for (const id of PLAYBOOK_IDS) expect(PLAYBOOK_PROVENANCE[id].length, id).toBeGreaterThan(0);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
  });

  it("the serialized book is deterministic and versioned", async () => {
    expect(serializeRecipeBook()).toBe(serializeRecipeBook());
    expect(serializeRecipeBook()).toContain(`v${RECIPE_BOOK_VERSION}`);
    expect(await recipeBookSha()).toMatch(/^[0-9a-f]{64}$/);
  });
});
