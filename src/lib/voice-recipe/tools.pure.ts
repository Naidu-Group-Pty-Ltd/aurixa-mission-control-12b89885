// The tool catalog and the fixed backend menu.
//
// A cloning plan binds tools by CATALOG KEY and chooses, per tool, one backend
// from BACKEND_MENU. The planner is a model and the menu is how it is kept
// honest: its output schema is an enum of these keys, so it cannot invent a
// backend, and a backend that is not implemented - or needs something the
// client has not supplied - becomes an open item for a person rather than a
// tool that silently does nothing on a live call.
//
// Tool parameters and descriptions are lifted from
// scripts/voice/create-vapi-org-tools.py, which defines Mission Control's own
// live tools; the business-specific phrases in those descriptions are slots.
// Secrets never appear in a payload built here - only placeholders
// ({{secret:...}}) that the deployer substitutes in memory at push time.
import type { ToolKey, ToolNames } from "./types.pure.ts";

export const BACKEND_KEYS = [
  "vapi_native",
  "mission_control_tenant",
  "make_twilio_redirect",
  "external_crm_custom",
  "make_scenario_custom",
] as const;
export type BackendKey = (typeof BACKEND_KEYS)[number];

export interface BackendDef {
  key: BackendKey;
  label: string;
  description: string;
  /** Deploy can build this backend's tools. False => the tool becomes an open item. */
  implemented: boolean;
  /** Values an operator must supply before deploy (never a model). */
  prerequisites: string[];
}

export const BACKEND_MENU: Record<BackendKey, BackendDef> = {
  vapi_native: {
    key: "vapi_native",
    label: "VAPI built-in",
    description:
      "Runs inside VAPI itself: ending the call, the knowledge-base query, squad handoff.",
    implemented: true,
    prerequisites: [],
  },
  mission_control_tenant: {
    key: "mission_control_tenant",
    label: "Mission Control (per client)",
    description:
      "Served by Mission Control's per-client voice webhook: contact resolution, call context, availability, " +
      "booking and support tickets, stored against this client only.",
    implemented: true,
    prerequisites: [],
  },
  make_twilio_redirect: {
    key: "make_twilio_redirect",
    label: "Make + Twilio redirect",
    description:
      "NPC's proven transfer: a Make scenario redirects the live Twilio parent call to an escalation number. " +
      "VAPI's native transferCall failed on a live call and is deliberately not offered.",
    implemented: true,
    prerequisites: ["make_transfer_hook_url", "escalation_number"],
  },
  external_crm_custom: {
    key: "external_crm_custom",
    label: "Client's own CRM (custom build)",
    description:
      "The client keeps contacts or bookings in a system of their own (GoHighLevel, HubSpot, a practice-management " +
      "system). Needs an integration built for that system before it can be deployed.",
    implemented: false,
    prerequisites: [],
  },
  make_scenario_custom: {
    key: "make_scenario_custom",
    label: "Bespoke Make scenario",
    description: "Anything that needs its own automation built first.",
    implemented: false,
    prerequisites: [],
  },
};

export type ToolKind = "function" | "endCall" | "query" | "handoff";

export interface ToolDef {
  key: ToolKey;
  label: string;
  kind: ToolKind;
  allowedBackends: BackendKey[];
  /** Deployable on mission_control_tenant yet? (cancel/reschedule are not.) */
  tenantImplemented: boolean;
  /** One line a planner (and an operator) reads to decide whether to bind it. */
  purpose: string;
  /** Tools this one only makes sense alongside. */
  requires: ToolKey[];
}

export const TOOL_CATALOG: Record<ToolKey, ToolDef> = {
  resolve_contact: {
    key: "resolve_contact",
    label: "Resolve contact",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: true,
    purpose:
      "Find or create the caller's contact from their phone number at the start of every call.",
    requires: [],
  },
  get_call_context: {
    key: "get_call_context",
    label: "Get call context",
    kind: "function",
    allowedBackends: ["mission_control_tenant"],
    tenantImplemented: true,
    purpose:
      "Read what is already known about this call - identity and confirmed intent - including across a squad handoff.",
    requires: ["resolve_contact"],
  },
  phone_number_inject: {
    key: "phone_number_inject",
    label: "Package caller context",
    kind: "function",
    allowedBackends: ["mission_control_tenant"],
    tenantImplemented: true,
    purpose:
      "Store the confirmed intent and the caller's reason right before a squad handoff, so the specialist starts informed.",
    requires: ["resolve_contact", "squad_handoff"],
  },
  check_availability: {
    key: "check_availability",
    label: "Check availability",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: true,
    purpose: "Return real open slots for a booking type within the business's booking window.",
    requires: ["resolve_contact"],
  },
  book_appointment: {
    key: "book_appointment",
    label: "Book appointment",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: true,
    purpose: "Book one slot that check_availability returned.",
    requires: ["check_availability", "resolve_contact"],
  },
  cancel_appointment: {
    key: "cancel_appointment",
    label: "Cancel appointment",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: false,
    purpose: "Cancel an existing appointment after the caller confirms.",
    requires: ["resolve_contact"],
  },
  reschedule_appointment: {
    key: "reschedule_appointment",
    label: "Reschedule appointment",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: false,
    purpose: "Move an existing appointment to a new returned slot.",
    requires: ["check_availability", "resolve_contact"],
  },
  raise_support_ticket: {
    key: "raise_support_ticket",
    label: "Raise support ticket",
    kind: "function",
    allowedBackends: ["mission_control_tenant", "external_crm_custom"],
    tenantImplemented: true,
    purpose: "Log a customer's problem and read a reference back before the call ends.",
    requires: ["resolve_contact"],
  },
  transfer_to_human: {
    key: "transfer_to_human",
    label: "Transfer to a human",
    kind: "function",
    allowedBackends: ["make_twilio_redirect"],
    tenantImplemented: false,
    purpose: "Put the caller through to a person, said and placed in the same turn.",
    requires: [],
  },
  end_call: {
    key: "end_call",
    label: "End call",
    kind: "endCall",
    allowedBackends: ["vapi_native"],
    tenantImplemented: false,
    purpose: "Hang up in the same turn as the closing line. Every agent binds it.",
    requires: [],
  },
  kb_query: {
    key: "kb_query",
    label: "Knowledge base",
    kind: "query",
    allowedBackends: ["vapi_native"],
    tenantImplemented: false,
    purpose: "Answer factual and value questions from the business's knowledge base.",
    requires: [],
  },
  squad_handoff: {
    key: "squad_handoff",
    label: "Squad handoff",
    kind: "handoff",
    allowedBackends: ["vapi_native"],
    tenantImplemented: false,
    purpose: "Hand the caller silently to a specialist assistant in the same squad.",
    requires: [],
  },
};

/** Is (tool, backend) something deploy can actually build? */
export function isDeployable(tool: ToolKey, backend: BackendKey): boolean {
  const t = TOOL_CATALOG[tool];
  if (!t.allowedBackends.includes(backend)) return false;
  if (!BACKEND_MENU[backend].implemented) return false;
  if (backend === "mission_control_tenant" && !t.tenantImplemented) return false;
  return true;
}

// ----------------------------------------------------------- VAPI payloads --

/** Placeholders the deployer replaces in memory. A stored package never holds a secret. */
export const SECRET_REF = {
  tenantWebhookUrl: "{{config:tenant_webhook_url}}",
  tenantWebhookSecret: "{{secret:tenant_webhook}}",
  makeTransferUrl: "{{secret:make_transfer_url}}",
} as const;

export interface ToolPayloadContext {
  names: ToolNames;
  businessName: string;
  /** "a human on the Acme team" - who a transfer reaches. */
  transferDestination: string;
  /** Booking types as spoken, for the availability/booking descriptions. */
  bookingTypeLabels: string[];
  /** "Monday to Friday 9:00 am to 5:00 pm Sydney time ..." */
  bookingWindowSpoken: string;
  /** Intents a router may hand off with (phone_number_inject). */
  handoffIntents: string[];
}

const tenantServer = () => ({
  url: SECRET_REF.tenantWebhookUrl,
  secret: SECRET_REF.tenantWebhookSecret,
});

/**
 * The org-level VAPI tool a (tool, backend) pair deploys as, or null when the
 * tool is not an org tool (kb_query is inline, squad_handoff is squad config,
 * and an undeployable pair has no payload at all).
 */
export function vapiToolPayload(
  tool: ToolKey,
  backend: BackendKey,
  c: ToolPayloadContext,
): Record<string, unknown> | null {
  if (!isDeployable(tool, backend)) return null;
  const n = c.names;
  switch (tool) {
    case "resolve_contact":
      return fn(
        n.resolve_contact,
        tenantServer(),
        "Resolve the caller against the contact list by their phone number. " +
          "Call this silently at the start of every conversation. The caller's phone " +
          "number is supplied automatically; never provide it manually. If it returns " +
          "contactState NEEDS_NAME, ask the caller for their full name once, then call " +
          "it again with the name fields only. A valid contactId means the caller is " +
          "resolved; a new contact is created automatically when a name is supplied for " +
          "an unknown number.",
        {
          type: "object",
          required: [],
          properties: {
            full_name: { type: "string", description: "The caller's full name, if they gave it" },
            first_name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string", description: "The caller's email address, if they gave it" },
          },
        },
      );
    case "get_call_context":
      return fn(
        n.get_call_context,
        tenantServer(),
        "Fetch the stored context for this call: who the caller is (contactId, " +
          "firstName, fullName, phone), their confirmed intent, and whether they were " +
          "already resolved earlier in the call or by another assistant. Call it " +
          `silently once after the final ${n.resolve_contact} attempt.`,
        { type: "object", required: [], properties: {} },
      );
    case "phone_number_inject":
      return fn(
        n.phone_number_inject,
        tenantServer(),
        "Package the caller's context before transferring them to a specialist " +
          "assistant. Call this once, silently, right before a squad transfer, passing " +
          "the confirmed intent and the caller's own words for why they called.",
        {
          type: "object",
          required: [],
          properties: {
            confirmedIntent: {
              type: "string",
              description: `One of: ${c.handoffIntents.join(", ")}`,
            },
            callerReason: {
              type: "string",
              description: "The caller's own words for why they called",
            },
          },
        },
      );
    case "check_availability":
      return fn(
        n.check_availability,
        tenantServer(),
        `Get real open slots from the ${c.businessName} calendar. ${c.bookingWindowSpoken} ` +
          "Pass the booking type in the caller's words; if the type is ambiguous the " +
          "tool returns a clarification question to ask.",
        {
          type: "object",
          required: ["booking_intent_text"],
          properties: {
            booking_intent_text: {
              type: "string",
              description: `What is being booked, in the caller's words (${c.bookingTypeLabels.join(", ")})`,
            },
            preferred_date_text: {
              type: "string",
              description: "The caller's preferred day, if any",
            },
          },
        },
      );
    case "book_appointment":
      return fn(
        n.book_appointment,
        tenantServer(),
        `Book one of the slots returned by ${n.check_availability}. Pass the exact ` +
          "startIso value of the chosen slot as startTime. The caller must be resolved " +
          `first (${n.resolve_contact}).`,
        {
          type: "object",
          required: ["booking_intent_text", "startTime"],
          properties: {
            booking_intent_text: { type: "string", description: "The booking type" },
            startTime: {
              type: "string",
              description: "The exact startIso value of the chosen slot",
            },
            notes: {
              type: "string",
              description: `Anything worth noting for the ${c.businessName} team`,
            },
          },
        },
      );
    case "raise_support_ticket":
      return fn(
        n.raise_support_ticket,
        tenantServer(),
        "Lodge a support ticket for the caller. Call this once the caller has " +
          "described the problem - do not ask them to choose a category or a severity. " +
          "Returns a reference number to read back to the caller. If it returns " +
          "needs_email, ask for their email address, repeat it back, then call again.",
        {
          type: "object",
          required: ["summary", "detail"],
          properties: {
            summary: {
              type: "string",
              description: "One line naming the problem, in the caller's own words",
            },
            detail: {
              type: "string",
              description:
                "What the caller said: what they were doing, what happened, any error wording they read out",
            },
            what_is_broken: {
              type: "string",
              description: "How much is affected, in the caller's words",
            },
            since_when: { type: "string", description: "When it started, in the caller's words" },
            email: {
              type: "string",
              description: "Only when the caller volunteers or confirms an email address.",
            },
          },
        },
      );
    case "transfer_to_human":
      // Mirrors transfer_to_human_mc: SILENT non-blocking request-start (the
      // prompt makes the assistant say its own line in the same turn), and a
      // request-failed that keeps the caller on the line instead of dropping them.
      return {
        type: "function",
        async: false,
        server: { url: SECRET_REF.makeTransferUrl, timeoutSeconds: 20 },
        messages: [
          { type: "request-start", content: "", blocking: false },
          {
            type: "request-failed",
            content:
              "Sorry, I could not connect you through just now. I can keep helping " +
              "here, or the team will pick up if you call back on this number.",
            endCallAfterSpokenEnabled: false,
          },
        ],
        function: {
          name: n.transfer_to_human,
          description:
            `Transfer the caller to ${c.transferDestination}. Use when the caller clearly ` +
            "asks for a person, or when their need is outside what this assistant can do. " +
            "This does not perform a native Vapi transfer: it asks Make to redirect the " +
            "active Twilio call to the escalation line.",
          parameters: {
            type: "object",
            required: ["transferReason"],
            properties: {
              transferReason: {
                type: "string",
                description: "Short reason for the transfer request.",
              },
              callerContext: {
                type: "string",
                description:
                  "Brief context about the call so far, so the person who picks up knows what the caller wants.",
              },
            },
          },
        },
      };
    case "end_call":
      return {
        type: "endCall",
        function: {
          name: n.end_call,
          description:
            "Hang up. Call this in the SAME turn as the spoken goodbye, never in a later " +
            "one: the assistant only gets another turn when the caller speaks, and a caller " +
            "who has just been said goodbye to has no reason to.",
        },
      };
    default:
      // kb_query is an inline tool on each assistant; squad_handoff is squad
      // configuration; cancel/reschedule are not deployable yet.
      return null;
  }
}

function fn(
  name: string,
  server: Record<string, unknown>,
  description: string,
  parameters: Record<string, unknown>,
) {
  return { type: "function", async: false, server, function: { name, description, parameters } };
}

/** The inline query tool VAPI keeps on each assistant, pointing at the KB file. */
export function inlineKbTool(
  name: string,
  businessName: string,
  fileId: string,
): Record<string, unknown> {
  return {
    type: "query",
    function: { name },
    knowledgeBases: [
      {
        provider: "google",
        name,
        description: `Official ${businessName} knowledge base: what the business does, for whom, how it differs, and the facts callers ask about.`,
        fileIds: [fileId],
      },
    ],
  };
}
