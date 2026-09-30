// The recipe book's vocabulary.
//
// Everything in src/lib/voice-recipe/ is PURE and imports only relative `.ts`
// files, so the same modules run under Vite (the app, vitest) and under plain
// `node --experimental-strip-types` (scripts/voice/*.mjs). Nothing here may
// import through the `@/` alias, touch the network or read the environment,
// and it must stay STRIP-SAFE TypeScript - no enums, namespaces or parameter
// properties - because Node erases types rather than compiling them.
//
// Two kinds of text meet in a prompt, and this module keeps them apart:
//
//   - METHOD text is how a voice agent behaves - resolve the contact before
//     anything else, say the closing line and call the end-call tool in the
//     same turn, never read a variable aloud. It was learned on NPC's live
//     fleet and carried into Mission Control's own. It lives in sections/*
//     and is the same for every business.
//   - BUSINESS text is what a particular business says - its name, what it
//     does, what it must never claim, what its bookings mean. It lives in a
//     BusinessVoiceContext and is the only thing that changes between clients.
//
// The golden test compiles Mission Control's own twelve agents from
// fleet-spec.json + AURIXA_CONTEXT and must reproduce the committed prompts byte
// for byte; that is what proves the split loses nothing.

/** Every tool a recipe can bind, by catalog key (not by its VAPI name). */
export const TOOL_KEYS = [
  "resolve_contact",
  "get_call_context",
  "phone_number_inject",
  "check_availability",
  "book_appointment",
  "cancel_appointment",
  "reschedule_appointment",
  "raise_support_ticket",
  "transfer_to_human",
  "end_call",
  "kb_query",
  "squad_handoff",
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

/**
 * The name a prompt uses for each tool. VAPI tool names are per deployment -
 * Mission Control's own fleet calls its transfer `transfer_to_human_mc` and its
 * knowledge base `aurixa_knowledge` - so the prompt never hard-codes them.
 */
export type ToolNames = Record<ToolKey, string>;

export const DEFAULT_TOOL_NAMES: ToolNames = {
  resolve_contact: "resolve_contact",
  get_call_context: "get_call_context",
  phone_number_inject: "phoneNumber_inject",
  check_availability: "check_availability",
  book_appointment: "book_appointment",
  cancel_appointment: "cancel_appointment",
  reschedule_appointment: "reschedule_appointment",
  raise_support_ticket: "raise_support_ticket",
  transfer_to_human: "transfer_to_human",
  end_call: "end_call_tool",
  kb_query: "knowledge_base",
  squad_handoff: "handoff_to_assistant",
};

export type Direction = "inbound" | "outbound";

export interface Dialogue {
  title: string;
  /** What the caller says; null when the example opens with the agent. */
  caller: string | null;
  reply: string;
  /** Markdown appended after the response (rare). */
  after?: string | null;
}

/**
 * Optional playbooks distilled from NPC's live outbound prompts. They are not
 * part of Mission Control's own fleet (so the golden test does not cover them)
 * and each carries provenance to the NPC heading it was taken from.
 */
export const PLAYBOOK_IDS = [
  "ai_transparency",
  "kb_fallback_only",
  "time_authority",
  "tool_turn_discipline",
  "objection_handling",
  "edge_cases",
  "tool_error_handling",
  "negative_sentiment_close",
  "reschedule_cancel",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

/** One agent, fully specified - what the compiler turns into a system prompt. */
export interface AgentSpec {
  key: string;
  /** The assistant's name in VAPI. Also how squad members hand off by name. */
  name: string;
  persona: string;
  temperament: string;
  direction: Direction;
  tools: ToolKey[];
  roleTitle: string;
  /** Markdown under "## 0. Role Priority Summary". */
  roleSummary: string;
  /** Markdown for section 0.1 (starts with its own heading). */
  opening: string;
  canDo: string[];
  cannotDo: string[];
  /** Business-written sections placed before the booking playbook (e.g. squad routing). */
  extraSections: string | null;
  dialogues: Dialogue[];
  /** Agent-specific absolute rules, listed before the tool-conditional ones. */
  extraNever: string[];
  extraAlways: string[];
  playbooks: PlaybookId[];
}

/** A pre-wrapped Markdown quote block, e.g. `> "Thanks - ..."`. */
export type QuoteMd = string;

/**
 * Everything a prompt says that belongs to ONE business. Every string is
 * Markdown and is inserted verbatim - wrap it the way it should read.
 */
export interface BusinessVoiceContext {
  businessName: string;
  /** One paragraph: what the business is, as the agent may say it. */
  identityParagraph: string;
  kb: {
    /** Bullet list naming what the knowledge base holds. */
    materials: string;
    /** The factual example questions, as one quoted run of text. */
    factualQueries: string;
    /** Bullet list of the value moments that must trigger a query first. */
    valueTriggers: string;
  };
  /** Bullet list for "4.1 Speech Style Rules". */
  speechRules: string;
  skeptical: {
    /** The opening sentence(s) naming what callers are wary of. */
    context: string;
    quotes: QuoteMd[];
  };
  /** Section 8: the only process facts the agent may state. */
  facts: { title: string; body: string };
  /** "the Aurixa Systems team" - who a transfer reaches. */
  transferDestination: string;
  /** Section 9 when the agent cannot transfer: the honest follow-up promise. */
  humanFollowUpQuote: QuoteMd;
  boundaries: {
    /** "financial advice, investment advice, ... or compliance advice", wrapped. */
    adviceDomains: string;
    adviceDeflectQuote: QuoteMd;
    /** Paragraph + bullets: claims this business must never make. */
    claimsDiscipline: string;
    /** Paragraph: how prices may be discussed. */
    pricingDiscipline: string;
  };
  closingQuote: QuoteMd;
  booking: {
    /** Paragraph naming the bookable session types, duration and window. */
    intro: string;
    /** Sentence(s) naming the booking timezone. */
    timezoneNote: string;
    /** The `success = true` bullet body (what to say a booking means). */
    successExpectation: string;
    /** The 14.4 bullet on finality. */
    finalityBoundary: string;
    /** The absolute "always" rule every booking agent carries about what a booking means. */
    afterBookingRule: string;
    /**
     * The optional parts below are for a booking tool that answers more than
     * "booked" or "slot taken" - Mission Control's own, on Cal.com. Each is
     * absent for every other business, and an absent part renders the section
     * exactly as it was before the part existed, so a fleet built for a client
     * is unchanged by them.
     */
    /** Paragraph after the timezone note in 14.2: what to do when availability cannot be read. */
    availabilityFailure?: string;
    /** Paragraph opening 14.3, before the tool call. */
    beforeBooking?: string;
    /** Bullets appended to the booking tool's argument list in 14.3. */
    extraArguments?: string;
    /** The outcome bullets after `success = true`, replacing the default `slot_taken` bullet. */
    otherOutcomes?: string;
  };
  absolute: {
    baseNever: string[];
    baseAlways: string[];
  };
  /** The heading line under the title - where the prompt was built. */
  productionTag: string;
}

/** Everything the compiler needs besides the agent. */
export interface CompileContext {
  business: BusinessVoiceContext;
  toolNames: ToolNames;
}
