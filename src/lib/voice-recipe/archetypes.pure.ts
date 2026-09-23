// Agent archetypes - the roles NPC's and Mission Control's fleets have run.
//
// A cloning plan picks archetypes; it never invents a role. Each archetype
// fixes what the recipe knows about that role - which way it dials, how it
// opens, which tools it binds by default, which NPC playbooks it carries, and
// where it sits in a squad - so a plan only has to supply the business words.
//
// Sources: Mission Control's twelve assistants (scripts/voice/fleet-prompts)
// and NPC's live fleet (npc-property-dashbord/docs/integrations/vapi).
import type { Direction, PlaybookId, ToolKey } from "./types.pure.ts";

export const ARCHETYPE_KEYS = [
  "inbound_router",
  "booking_specialist_inbound",
  "solutions_advisor_inbound",
  "support_intake",
  "outbound_booking_follow_up",
  "reminder_confirmation",
  "no_show_recovery",
  "nurture_reengagement",
  "onboarding_kickoff",
  "check_in",
] as const;
export type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

export type SquadRole = "entry" | "specialist" | "standalone";
/** VAPI firstMessageMode. Outbound agents wait so the callee speaks first. */
export type FirstMessageMode = "assistant-speaks-first" | "assistant-waits-for-user";

export interface Archetype {
  key: ArchetypeKey;
  label: string;
  direction: Direction;
  firstMessageMode: FirstMessageMode;
  squadRole: SquadRole;
  /** Tools every agent of this archetype binds. */
  defaultTools: ToolKey[];
  /** Tools a plan may add. Anything else is refused by validation. */
  optionalTools: ToolKey[];
  playbooks: PlaybookId[];
  /** What the role is for - read by the planner and shown to operators. */
  purpose: string;
  /** Where it came from. */
  provenance: string;
}

const CORE: ToolKey[] = ["resolve_contact", "get_call_context", "end_call", "kb_query"];

export const ARCHETYPES: Record<ArchetypeKey, Archetype> = {
  inbound_router: {
    key: "inbound_router",
    label: "Inbound front desk",
    direction: "inbound",
    firstMessageMode: "assistant-speaks-first",
    squadRole: "entry",
    defaultTools: [...CORE, "phone_number_inject", "squad_handoff"],
    optionalTools: ["transfer_to_human"],
    playbooks: [],
    purpose:
      "The first voice of the business. Resolves the caller, answers general questions from the knowledge base, " +
      "and hands off silently to a specialist only after the caller confirms that is what they want.",
    provenance: "MC Front Desk (Angela); NPC Inbound Agent - squad member 0 of NPC Sales Force.",
  },
  booking_specialist_inbound: {
    key: "booking_specialist_inbound",
    label: "Booking specialist (inbound)",
    direction: "inbound",
    firstMessageMode: "assistant-speaks-first",
    squadRole: "specialist",
    defaultTools: [...CORE, "check_availability", "book_appointment"],
    optionalTools: ["transfer_to_human", "reschedule_appointment", "cancel_appointment"],
    playbooks: ["tool_turn_discipline", "tool_error_handling"],
    purpose:
      "Books, moves or rebooks an appointment against real availability, usually after a handoff from the front desk.",
    provenance: "MC Review Booking (Sandra); NPC Strategy Session Inbound / IFC Inbound.",
  },
  solutions_advisor_inbound: {
    key: "solutions_advisor_inbound",
    label: "Solutions advisor (inbound)",
    direction: "inbound",
    firstMessageMode: "assistant-speaks-first",
    squadRole: "specialist",
    defaultTools: [...CORE],
    optionalTools: ["transfer_to_human", "check_availability", "book_appointment"],
    playbooks: [],
    purpose:
      "Answers deeper questions about what the business offers, from the knowledge base, and books the next step when the caller wants one.",
    provenance: "MC Solutions Advisor (Sandra).",
  },
  support_intake: {
    key: "support_intake",
    label: "Support intake",
    direction: "inbound",
    firstMessageMode: "assistant-speaks-first",
    squadRole: "specialist",
    defaultTools: [...CORE, "raise_support_ticket"],
    optionalTools: ["transfer_to_human"],
    playbooks: ["tool_error_handling"],
    purpose:
      "Takes an existing customer's problem in their own words and logs a ticket with a reference read back before the call ends.",
    provenance: "MC Support Intake (Monica).",
  },
  outbound_booking_follow_up: {
    key: "outbound_booking_follow_up",
    label: "Outbound follow-up and booking",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE, "check_availability", "book_appointment"],
    optionalTools: ["transfer_to_human"],
    playbooks: [
      "ai_transparency",
      "time_authority",
      "tool_turn_discipline",
      "kb_fallback_only",
      "objection_handling",
      "edge_cases",
      "tool_error_handling",
      "negative_sentiment_close",
    ],
    purpose:
      "Calls a new enquiry or lead back and books the first appointment, lightly persistent and never pushy.",
    provenance:
      "NPC Opt-In Follow Up (Monica), NPC Quiz Follow Up (Erica); MC Questionnaire Chaser.",
  },
  reminder_confirmation: {
    key: "reminder_confirmation",
    label: "Reminder and confirmation",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE],
    optionalTools: [
      "check_availability",
      "book_appointment",
      "reschedule_appointment",
      "cancel_appointment",
    ],
    playbooks: [
      "ai_transparency",
      "time_authority",
      "reschedule_cancel",
      "edge_cases",
      "tool_error_handling",
    ],
    purpose:
      "Confirms an upcoming appointment and handles a reschedule or cancellation when the person cannot make it.",
    provenance:
      "MC Booking Confirmation (Rita), MC Session Reminder (Sandra); NPC Discovery Call Follow-Up.",
  },
  no_show_recovery: {
    key: "no_show_recovery",
    label: "No-show recovery",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE, "check_availability", "book_appointment"],
    optionalTools: [],
    playbooks: [
      "ai_transparency",
      "time_authority",
      "objection_handling",
      "edge_cases",
      "tool_error_handling",
      "negative_sentiment_close",
    ],
    purpose: "Calls someone who missed an appointment, without blame, and rebooks it.",
    provenance: "MC No-Show Recovery (Sandra); NPC Discovery Call No-Show Follow-Up, IFC No-Show.",
  },
  nurture_reengagement: {
    key: "nurture_reengagement",
    label: "Nurture and re-engagement",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE],
    optionalTools: ["check_availability", "book_appointment"],
    playbooks: [
      "ai_transparency",
      "kb_fallback_only",
      "objection_handling",
      "edge_cases",
      "negative_sentiment_close",
    ],
    purpose:
      "A courtesy check-in with a lead that went quiet - finds out whether it is still relevant and respects the answer.",
    provenance: "MC Re-Engagement (Mary); NPC Active Nurturing (Mary).",
  },
  onboarding_kickoff: {
    key: "onboarding_kickoff",
    label: "Onboarding kickoff",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE, "check_availability", "book_appointment"],
    optionalTools: [],
    playbooks: ["ai_transparency", "time_authority", "tool_error_handling"],
    purpose: "Welcomes a new customer and books their first working session.",
    provenance: "MC Onboarding Kickoff (Sandra).",
  },
  check_in: {
    key: "check_in",
    label: "Account check-in",
    direction: "outbound",
    firstMessageMode: "assistant-waits-for-user",
    squadRole: "standalone",
    defaultTools: [...CORE],
    optionalTools: ["check_availability", "book_appointment", "raise_support_ticket"],
    playbooks: ["ai_transparency", "edge_cases", "negative_sentiment_close"],
    purpose:
      "A genuine service check-in with an existing customer; routes issues to support and never turns into a sales call.",
    provenance: "MC Account Check-In (Mary).",
  },
};
