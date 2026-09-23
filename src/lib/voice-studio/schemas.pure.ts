// What the planning agent may say - the output schemas for every stage.
//
// These are the contract between a model and the rest of the Studio, and they
// are written to make the unsafe answers unsayable rather than merely
// discouraged:
//
//   - archetypes, tools, backends, voices and KB parts are ENUMS generated from
//     the recipe book, so a plan cannot contain a role, tool or backend the
//     book does not have;
//   - there is no field for a URL, a phone number, an API key, a webhook or a
//     secret anywhere below - those are supplied by an operator, never read out
//     of a client's documents;
//   - citations are fields, checked afterwards against the extracted text
//     (API citations cannot be combined with structured outputs).
//
// zod/v4 because the Anthropic SDK's zodOutputFormat expects v4 schemas; the
// rest of Mission Control stays on v3 and nothing here is shared with it.
import * as z from "zod/v4";
import { ARCHETYPE_KEYS } from "../voice-recipe/archetypes.pure.ts";
import { VOICE_KEYS } from "../voice-recipe/defaults.pure.ts";
import { KB_PART_KEYS } from "../voice-recipe/kb.pure.ts";
import { BACKEND_KEYS } from "../voice-recipe/tools.pure.ts";
import { PLAYBOOK_IDS, TOOL_KEYS } from "../voice-recipe/types.pure.ts";

export const FACT_TOPICS = [
  "identity",
  "services",
  "audience",
  "pricing",
  "process",
  "hours",
  "locations",
  "booking",
  "policies",
  "compliance",
  "systems",
  "brand_voice",
  "differentiation",
  "objections",
  "faq",
  "team",
  "contact",
  "other",
] as const;

export const SYSTEM_CATEGORIES = ["crm", "calendar", "helpdesk", "telephony", "automation", "accounting", "other"] as const;

/** When an outbound agent is dialled - maps onto Mission Control's campaign triggers. */
export const OUTBOUND_TRIGGERS = [
  "new_enquiry",
  "form_incomplete",
  "appointment_booked",
  "appointment_reminder",
  "appointment_no_show",
  "lead_gone_quiet",
  "new_customer",
  "customer_at_risk",
] as const;

export const Citation = z.object({
  docId: z.string().describe("The id of the source document exactly as given, e.g. doc:3 or ctx:lead"),
  locator: z.string().describe('Where in it: "p.4", "sheet Rates row 3", "section 2", or "" if unknown'),
  quote: z.string().describe("A short verbatim quote (under 200 characters) that supports the statement"),
});
export type Citation = z.infer<typeof Citation>;

// ------------------------------------------------------------- stage 1 --

export const DocumentFacts = z.object({
  docId: z.string(),
  summary: z.string().describe("Two or three sentences: what this document is and what it tells us about the business"),
  facts: z.array(
    z.object({
      topic: z.enum(FACT_TOPICS),
      statement: z.string().describe("One fact about the business, in plain words"),
      citation: Citation,
    }),
  ),
});
export type DocumentFacts = z.infer<typeof DocumentFacts>;

// ------------------------------------------------------------- stage 2 --

export const BookingWindow = z.object({
  days: z.array(z.number().int()).describe("ISO weekdays that take bookings: 1 = Monday ... 7 = Sunday"),
  startTime: z.string().describe("First bookable time, 24h HH:MM"),
  endTime: z.string().describe("Last bookable start time, 24h HH:MM"),
  slotMinutes: z.number().int(),
  minNoticeHours: z.number().int(),
  horizonDays: z.number().int(),
});
export type BookingWindow = z.infer<typeof BookingWindow>;

export const BusinessProfile = z.object({
  businessName: z.string(),
  industry: z.string(),
  oneLiner: z.string().describe("What the business does, in one sentence a caller would understand"),
  audiences: z.array(z.object({ name: z.string(), description: z.string() })),
  services: z.array(z.object({ name: z.string(), description: z.string(), citations: z.array(Citation) })),
  timezone: z.string().describe("IANA timezone of the business, e.g. Australia/Sydney"),
  hoursSummary: z.string(),
  bookingWindow: BookingWindow.nullable().describe("Null when the documents do not establish when appointments can be booked"),
  bookingTypes: z.array(
    z.object({
      key: z.string().describe("lower_snake_case id"),
      label: z.string(),
      synonyms: z.array(z.string()),
      durationMinutes: z.number().int(),
    }),
  ),
  channels: z.object({
    inbound: z.boolean(),
    outbound: z.boolean(),
    outboundCampaigns: z.array(z.object({ trigger: z.enum(OUTBOUND_TRIGGERS), description: z.string() })),
  }),
  systems: z.array(
    z.object({
      name: z.string(),
      category: z.enum(SYSTEM_CATEGORIES),
      notes: z.string(),
      citations: z.array(Citation),
    }),
  ),
  humanEscalation: z.object({ available: z.boolean(), hoursSummary: z.string() }),
  pricingPolicy: z.string().describe("What may be said about price, from the documents; empty if nothing is published"),
  adviceRestrictions: z.array(z.string()).describe("Kinds of advice the business must not give over the phone"),
  complianceConstraints: z.array(z.string()),
  neverSay: z.array(z.string()).describe("Claims the business must never make"),
  brandVoice: z.string(),
  gaps: z.array(z.object({ question: z.string(), whyItMatters: z.string() })),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;

// ------------------------------------------------------------- stage 3 --

export const PlanTopology = z.object({
  agents: z.array(
    z.object({
      key: z.string().describe("lower_snake_case id, unique in the plan"),
      archetype: z.enum(ARCHETYPE_KEYS),
      personaName: z.string().describe("A first name the agent speaks as"),
      voice: z.enum(VOICE_KEYS),
      rationale: z.string(),
      outboundTrigger: z.enum(OUTBOUND_TRIGGERS).nullable().describe("For outbound archetypes: what causes the call"),
      tools: z.array(
        z.object({
          tool: z.enum(TOOL_KEYS),
          backend: z.enum(BACKEND_KEYS),
          rationale: z.string(),
        }),
      ),
    }),
  ),
  squad: z
    .object({
      name: z.string(),
      entryAgentKey: z.string(),
      members: z.array(z.object({ agentKey: z.string(), handoffTo: z.array(z.string()) })),
      handoffIntents: z.array(z.object({ intent: z.string().describe("lower_snake_case"), description: z.string() })),
    })
    .nullable(),
  kbOutline: z.array(z.object({ part: z.enum(KB_PART_KEYS), headings: z.array(z.string()) })),
  openItems: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      owner: z.enum(["operator", "client", "engineering"]),
    }),
  ),
  risks: z.array(z.object({ title: z.string(), detail: z.string() })),
});
export type PlanTopology = z.infer<typeof PlanTopology>;

// ------------------------------------------------------------- stage 4 --

export const AgentContent = z.object({
  agentKey: z.string(),
  roleTitle: z.string().describe('e.g. "Inbound Front Desk", "Appointment Reminder (Outbound)"'),
  temperament: z.string().describe("A short description of how this persona sounds"),
  roleSummary: z.array(z.string()).describe("The numbered duties of the role, in order of priority"),
  notThisRole: z.string().describe('One sentence on what this agent is NOT, e.g. "You are not a sales agent."'),
  firstMessage: z.string().describe("The first thing the agent says; outbound agents name the business and the reason"),
  openingNotes: z.array(z.string()).describe("How the first minute should go after the first message"),
  canDo: z.array(z.string()),
  cannotDo: z.array(z.string()),
  dialogues: z.array(z.object({ title: z.string(), caller: z.string().nullable(), reply: z.string() })),
  extraNever: z.array(z.string()),
  extraAlways: z.array(z.string()),
  voicemailMessage: z.string(),
});
export type AgentContent = z.infer<typeof AgentContent>;

/** The business's words for every slot in BusinessVoiceContext, as plain text. */
export const VoiceContextDraft = z.object({
  identityParagraph: z.string(),
  kbWhy: z.string().describe("What the knowledge base holds about why customers choose the business"),
  kbFacts: z.string().describe("What the knowledge base holds as facts"),
  factualQueryExamples: z.array(z.string()),
  valueTriggers: z.array(z.string()),
  speechRules: z.array(z.string()),
  skepticalContext: z.string(),
  skepticalLines: z.array(z.string()),
  factsTitle: z.string(),
  factsParagraphs: z.array(z.string()).describe("The only process facts an agent may state, one paragraph each"),
  transferDestination: z.string().describe('Who a transfer reaches, e.g. "Acme Dental front desk team"'),
  followUpPromise: z.string().describe("What an agent that cannot transfer promises instead"),
  adviceDomains: z.array(z.string()),
  adviceDeflect: z.string(),
  claimsNever: z.array(z.string()),
  pricingDiscipline: z.string(),
  closingLine: z.string(),
  bookingIntro: z.string(),
  bookingIsRequest: z.boolean().describe("True when a booking made on a call still has to be confirmed by the team"),
  bookingConfirmationNote: z.string(),
  baseNever: z.array(z.string()),
  baseAlways: z.array(z.string()),
});
export type VoiceContextDraft = z.infer<typeof VoiceContextDraft>;

// ------------------------------------------------------------- stage 5 --

export const KbPartDraft = z.object({
  part: z.enum(KB_PART_KEYS),
  blocks: z.array(
    z.object({
      kind: z.enum(["h1", "h2", "p", "b"]),
      text: z.string(),
      citations: z.array(Citation),
    }),
  ),
});
export type KbPartDraft = z.infer<typeof KbPartDraft>;

// ----------------------------------------------------------- the plan ----

export const PLAYBOOK_ENUM = z.enum(PLAYBOOK_IDS);

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
}

export interface OpenItem {
  title: string;
  detail: string;
  owner: "operator" | "client" | "engineering";
  source: "planner" | "validator";
}

export interface PlanConfidence {
  score: number;
  band: "high" | "medium" | "low";
  reasons: string[];
}

/** The whole plan as stored - every stage's output plus what was checked about it. */
export interface CloningPlan {
  recipeVersion: string;
  recipeSha: string;
  businessSlug: string;
  profile: BusinessProfile;
  topology: PlanTopology;
  agents: AgentContent[];
  voiceContext: VoiceContextDraft;
  kb: KbPartDraft[];
  issues: ValidationIssue[];
  openItems: OpenItem[];
  confidence: PlanConfidence;
}
