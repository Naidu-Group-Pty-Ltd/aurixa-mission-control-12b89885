// The recipe book as one versioned object, and its text form for the planner.
//
// serializeRecipeBook() is the planning agent's cached system prompt. It must
// be DETERMINISTIC - no timestamps, no Map iteration order, no randomness -
// because prompt caching is a byte-prefix match: any change invalidates the
// cache for every run after it. recipeBookSha() hashes that exact text, and a
// plan records the sha it was made against, so "which recipe book was this
// plan built from?" always has an answer.
import { ARCHETYPES, ARCHETYPE_KEYS } from "./archetypes.pure.ts";
import { KB_PARTS } from "./kb.pure.ts";
import { LESSONS } from "./lessons.pure.ts";
import { PLAYBOOK_PROVENANCE } from "./sections/playbooks.pure.ts";
import { BACKEND_KEYS, BACKEND_MENU, TOOL_CATALOG } from "./tools.pure.ts";
import { TOOL_KEYS } from "./types.pure.ts";
import { VOICE_PALETTE } from "./defaults.pure.ts";

/** Bump when anything that changes a compiled prompt or a plan's meaning changes. */
export const RECIPE_BOOK_VERSION = "2026.09.1";

export function serializeRecipeBook(): string {
  const out: string[] = [];
  out.push(`# Voice Agent Recipe Book v${RECIPE_BOOK_VERSION}`);
  out.push("");
  out.push(
    "This is the proven voice-agent stack: the architecture of the NPC Services fleet and Mission Control's " +
      "own fleet, which are live on real phone lines. A cloning plan is built ONLY from what is listed here. " +
      "Agents are archetypes from this book; tools are catalog tools; every tool is served by a backend from the " +
      "fixed menu. Nothing outside these lists can be proposed.",
  );
  out.push("");

  out.push("## Archetypes");
  out.push("");
  for (const key of ARCHETYPE_KEYS) {
    const a = ARCHETYPES[key];
    out.push(`### ${a.key} - ${a.label}`);
    out.push(`- Direction: ${a.direction}; squad role: ${a.squadRole}; first message: ${a.firstMessageMode}`);
    out.push(`- Purpose: ${a.purpose}`);
    out.push(`- Default tools: ${a.defaultTools.join(", ")}`);
    out.push(`- Optional tools: ${a.optionalTools.length ? a.optionalTools.join(", ") : "none"}`);
    out.push(`- Playbooks: ${a.playbooks.length ? a.playbooks.join(", ") : "none"}`);
    out.push(`- Proven on: ${a.provenance}`);
    out.push("");
  }

  out.push("## Tool catalog");
  out.push("");
  for (const key of TOOL_KEYS) {
    const t = TOOL_CATALOG[key];
    out.push(`- ${t.key} (${t.label}): ${t.purpose} Allowed backends: ${t.allowedBackends.join(", ")}.` +
      (t.requires.length ? ` Requires: ${t.requires.join(", ")}.` : ""));
  }
  out.push("");

  out.push("## Backend menu");
  out.push("");
  for (const key of BACKEND_KEYS) {
    const b = BACKEND_MENU[key];
    out.push(
      `- ${b.key} (${b.label}): ${b.description} ` +
        (b.implemented ? "Deployable." : "NOT deployable - choosing it makes the tool an open item.") +
        (b.prerequisites.length ? ` Needs from an operator: ${b.prerequisites.join(", ")}.` : ""),
    );
  }
  out.push("");

  out.push("## Knowledge base structure");
  out.push("");
  for (const p of KB_PARTS) out.push(`- ${p.key} - ${p.title}: ${p.purpose}`);
  out.push("");

  out.push("## Voices");
  out.push("");
  for (const v of VOICE_PALETTE) out.push(`- ${v.key}: ${v.label}`);
  out.push("");

  out.push("## Lessons (rules the stack enforces)");
  out.push("");
  for (const l of LESSONS) out.push(`- ${l.id}: ${l.rule} Why: ${l.why}`);
  out.push("");

  out.push("## Playbook sources");
  out.push("");
  for (const [id, sources] of Object.entries(PLAYBOOK_PROVENANCE).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`- ${id}: ${sources.map((s) => s.heading).join("; ")}`);
  }
  return out.join("\n") + "\n";
}

/** SHA-256 of the serialized book, hex. Async because WebCrypto is. */
export async function recipeBookSha(): Promise<string> {
  const bytes = new TextEncoder().encode(serializeRecipeBook());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
