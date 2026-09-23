// Compile one agent's system prompt.
//
// The section ORDER and every tool-conditional choice mirror build() in
// scripts/voice/build-fleet-prompts.py exactly - that is what the golden test
// holds this to. What this adds beyond the Python generator is the playbooks:
// NPC-derived sections (objection handling, edge cases, AI transparency ...)
// that Mission Control's own fleet does not carry but an outbound booking agent
// for another business needs. They sit after the booking playbook and before
// the absolute rules, which always close the prompt: a prompt is read top to
// bottom, and the nearest instruction wins, so the rules that must hold
// whatever else the prompt says are the last thing the model reads.
import type { AgentSpec, CompileContext, ToolKey } from "./types.pure.ts";
import {
  absoluteRules,
  boundariesBlock,
  bookingBlock,
  canDoSection,
  closingBlock,
  contactSummary,
  contextBlock,
  dialoguesSection,
  factsSection,
  header,
  humanBlock,
  identitySection,
  kbBlock,
  mustNotSection,
  objectiveSection,
  outboundEtiquette,
  personaBlock,
  resolveBlock,
  skepticalSection,
  ticketBlock,
} from "./sections/core.pure.ts";
import { renderPlaybooks, playbookRules } from "./sections/playbooks.pure.ts";

export function compileAgentPrompt(agent: AgentSpec, ctx: CompileContext): string {
  const { business: b, toolNames: n } = ctx;
  const p = agent.persona;
  const has = (t: ToolKey) => agent.tools.includes(t);
  const outbound = agent.direction === "outbound";

  const parts: string[] = [];
  parts.push(...header(b, p, agent.roleTitle));
  parts.push("## 0. Role Priority Summary\n");
  parts.push(agent.roleSummary + "\n\n---\n");
  parts.push(agent.opening + "\n\n---\n");
  parts.push(resolveBlock(p, n));
  parts.push(contextBlock(p, n));
  parts.push(identitySection(p, b));
  parts.push(objectiveSection(agent.canDo));
  if (has("kb_query")) parts.push(kbBlock(p, b, n));
  parts.push(personaBlock(p, agent.temperament, b));
  parts.push(canDoSection(p, agent.canDo, has("raise_support_ticket") ? ticketBlock(p, n) : null));
  parts.push(mustNotSection(p, agent.cannotDo));
  parts.push(skepticalSection(b));
  parts.push(factsSection(b));
  parts.push(humanBlock(p, has("transfer_to_human"), b, n));
  parts.push(boundariesBlock(p, b));
  parts.push(closingBlock(p, outbound, b, n));
  if (outbound) parts.push(outboundEtiquette(p, b));
  parts.push(dialoguesSection(agent.dialogues));
  parts.push(contactSummary(p, n));
  if (agent.extraSections) parts.push(agent.extraSections);
  if (has("book_appointment")) parts.push(bookingBlock(p, b, n));
  if (agent.playbooks.length) parts.push(renderPlaybooks(agent, ctx));

  const { never, always } = absoluteRuleLines(agent, ctx);
  parts.push(absoluteRules(p, never, always));
  return parts.join("\n");
}

/** The absolute rules, in the order build() appends them. */
export function absoluteRuleLines(agent: AgentSpec, ctx: CompileContext): { never: string[]; always: string[] } {
  const n = ctx.toolNames;
  const has = (t: ToolKey) => agent.tools.includes(t);
  const never = [...ctx.business.absolute.baseNever];
  const always = [...ctx.business.absolute.baseAlways];
  const extraNever = [...agent.extraNever];
  const extraAlways = [...agent.extraAlways];

  if (has("raise_support_ticket")) {
    const t = n.raise_support_ticket;
    extraNever.push(
      `Invent a ticket reference, or say a report is logged before ${t} returns one`,
      "Ask the caller to choose a ticket category, a breakage type, or a severity",
      "Raise a second ticket for a problem already raised on this call",
    );
    extraAlways.push(
      `Call ${t} once the problem is described, and read the reference back`,
      "Say plainly that the report was NOT logged when the tool refuses",
    );
  }
  if (has("transfer_to_human")) {
    extraAlways.push(
      `Place ${n.transfer_to_human} in the same turn as the handover line, never on a later one`,
    );
  }
  if (has("end_call")) {
    const e = n.end_call;
    extraNever.push(
      "Say a second goodbye - the closing line is spoken once per call",
      `Answer the caller's own goodbye with another farewell instead of ${e}`,
      `Speak at all after ${e} has been called`,
      'Use a holding phrase ("hold on a sec", "one moment") in a closing turn',
    );
    extraAlways.push(
      `Call ${e} in the same turn as the closing line - never defer the hang-up to a later turn`,
    );
  }
  if (has("book_appointment")) {
    extraAlways.push(
      `Offer only slots returned by ${n.check_availability}, and pass the exact startIso as startTime when booking`,
      ctx.business.booking.afterBookingRule,
    );
  }
  if (agent.direction === "outbound") {
    extraAlways.push(
      "Respect a do-not-call request immediately and completely",
      "Leave at most one short neutral voicemail, with no sensitive details",
    );
  }
  const pb = playbookRules(agent, ctx);
  return {
    never: [...never, ...extraNever, ...pb.never],
    always: [...always, ...extraAlways, ...pb.always],
  };
}
