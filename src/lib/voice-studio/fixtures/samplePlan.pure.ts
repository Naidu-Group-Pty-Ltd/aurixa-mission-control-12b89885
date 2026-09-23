// A complete, fictional cloning plan - Harbourside Dental, a two-chair
// practice - used by the tests to drive the validator, the compiler, the
// package and the deploy planner end to end without a model or a network.
import { RECIPE_BOOK_VERSION } from "../../voice-recipe/recipeBook.pure.ts";
import type { CloningPlan } from "../schemas.pure.ts";

export const SAMPLE_SOURCES: Record<string, string> = {
  "doc:1":
    "Harbourside Dental is a family dental practice in Manly. We offer check-ups and cleans, " +
    "fillings, whitening and emergency appointments. Open Monday to Friday 8am to 5pm. " +
    "New patients are welcome. Call us on 02 9977 1234.",
  "doc:2": "Booking policy: appointments are 30 minutes. Please give 24 hours notice to cancel.",
};

export function samplePlan(): CloningPlan {
  return {
    recipeVersion: RECIPE_BOOK_VERSION,
    recipeSha: "test",
    businessSlug: "harbourside_dental",
    profile: {
      businessName: "Harbourside Dental",
      industry: "Dental practice",
      oneLiner: "A family dental practice in Manly.",
      audiences: [{ name: "Families", description: "Local families booking check-ups" }],
      services: [
        {
          name: "Check-up and clean",
          description: "A routine examination and professional clean.",
          citations: [{ docId: "doc:1", locator: "", quote: "We offer check-ups and cleans" }],
        },
      ],
      timezone: "Australia/Sydney",
      hoursSummary: "Monday to Friday, 8am to 5pm",
      bookingWindow: { days: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:30", slotMinutes: 30, minNoticeHours: 24, horizonDays: 30 },
      bookingTypes: [
        { key: "check_up", label: "check-up and clean", synonyms: ["check up", "clean"], durationMinutes: 30 },
        { key: "consult", label: "new patient consult", synonyms: ["consultation"], durationMinutes: 30 },
      ],
      channels: {
        inbound: true,
        outbound: true,
        outboundCampaigns: [{ trigger: "appointment_reminder", description: "Remind patients the day before" }],
      },
      systems: [{ name: "Dental4Windows", category: "calendar", notes: "Practice management system", citations: [] }],
      humanEscalation: { available: true, hoursSummary: "Business hours" },
      pricingPolicy: "Prices are discussed at the appointment; no prices are quoted over the phone.",
      adviceRestrictions: ["clinical advice", "diagnosis"],
      complianceConstraints: ["Do not collect health information over the phone beyond the reason for the visit"],
      neverSay: ["That a treatment is painless", "That a price is guaranteed"],
      brandVoice: "Warm, local and unhurried",
      gaps: [{ question: "Is there an after-hours emergency line?", whyItMatters: "Callers in pain will ask." }],
    },
    topology: {
      agents: [
        {
          key: "front_desk",
          archetype: "inbound_router",
          personaName: "Grace",
          voice: "warm_female",
          rationale: "Every call starts with a friendly front desk.",
          outboundTrigger: null,
          tools: [
            { tool: "resolve_contact", backend: "mission_control_tenant", rationale: "" },
            { tool: "get_call_context", backend: "mission_control_tenant", rationale: "" },
            { tool: "phone_number_inject", backend: "mission_control_tenant", rationale: "" },
            { tool: "squad_handoff", backend: "vapi_native", rationale: "" },
            { tool: "transfer_to_human", backend: "make_twilio_redirect", rationale: "" },
            { tool: "end_call", backend: "vapi_native", rationale: "" },
            { tool: "kb_query", backend: "vapi_native", rationale: "" },
          ],
        },
        {
          key: "bookings",
          archetype: "booking_specialist_inbound",
          personaName: "Tom",
          voice: "warm_male",
          rationale: "Most calls are bookings.",
          outboundTrigger: null,
          tools: [
            { tool: "resolve_contact", backend: "mission_control_tenant", rationale: "" },
            { tool: "get_call_context", backend: "mission_control_tenant", rationale: "" },
            { tool: "check_availability", backend: "mission_control_tenant", rationale: "" },
            { tool: "book_appointment", backend: "mission_control_tenant", rationale: "" },
            { tool: "cancel_appointment", backend: "external_crm_custom", rationale: "Cancellations live in Dental4Windows" },
            { tool: "end_call", backend: "vapi_native", rationale: "" },
            { tool: "kb_query", backend: "vapi_native", rationale: "" },
          ],
        },
        {
          key: "reminder",
          archetype: "reminder_confirmation",
          personaName: "Ruby",
          voice: "calm_female",
          rationale: "Reduce no-shows.",
          outboundTrigger: "appointment_reminder",
          tools: [
            { tool: "resolve_contact", backend: "mission_control_tenant", rationale: "" },
            { tool: "get_call_context", backend: "mission_control_tenant", rationale: "" },
            { tool: "end_call", backend: "vapi_native", rationale: "" },
            { tool: "kb_query", backend: "vapi_native", rationale: "" },
          ],
        },
      ],
      squad: {
        name: "Harbourside Reception",
        entryAgentKey: "front_desk",
        members: [
          { agentKey: "front_desk", handoffTo: ["bookings"] },
          { agentKey: "bookings", handoffTo: [] },
        ],
        handoffIntents: [
          { intent: "book", description: "Book or move an appointment" },
          { intent: "new_patient", description: "A new patient wants to join" },
        ],
      },
      kbOutline: [{ part: "facts", headings: ["What services do you offer?"] }],
      openItems: [],
      risks: [],
    },
    agents: [
      {
        agentKey: "front_desk",
        roleTitle: "Inbound Front Desk",
        temperament: "warm, calm and genuinely helpful",
        roleSummary: ["Resolve the caller.", "Answer general questions.", "Hand off to bookings when they want an appointment."],
        notThisRole: "You are not a clinician and you do not give clinical advice.",
        firstMessage: "Hi, thanks for calling Harbourside Dental, this is Grace. How can I help?",
        openingNotes: ["Greet by first name once it is known."],
        canDo: ["Explain the services the practice offers", "Route the caller to bookings"],
        cannotDo: ["Give clinical advice", "Book appointments directly"],
        dialogues: [{ title: "Caller wants a check-up", caller: "Can I book a clean?", reply: "Of course - I'll get you through to our bookings team." }],
        extraNever: [],
        extraAlways: [],
        voicemailMessage: "Hi, it's Harbourside Dental returning your call.",
      },
      {
        agentKey: "bookings",
        roleTitle: "Bookings (Inbound)",
        temperament: "organised and friendly",
        roleSummary: ["Book the right appointment against real availability."],
        notThisRole: "You do not give clinical advice.",
        firstMessage: "Hi, it's Tom from bookings - let's find you a time.",
        openingNotes: [],
        canDo: ["Book a check-up or a new patient consult"],
        cannotDo: ["Offer times the calendar did not return"],
        dialogues: [],
        extraNever: [],
        extraAlways: [],
        voicemailMessage: "",
      },
      {
        agentKey: "reminder",
        roleTitle: "Appointment Reminder (Outbound)",
        temperament: "brief and friendly",
        roleSummary: ["Confirm tomorrow's appointment."],
        notThisRole: "You are not a sales call.",
        firstMessage: "Hi {{firstName}}, it's Ruby from Harbourside Dental about your appointment tomorrow.",
        openingNotes: [],
        canDo: ["Confirm the appointment", "Take a message if they cannot make it"],
        cannotDo: ["Discuss treatment"],
        dialogues: [],
        extraNever: [],
        extraAlways: [],
        voicemailMessage: "Hi, it's Harbourside Dental with a reminder about your appointment tomorrow.",
      },
    ],
    voiceContext: {
      identityParagraph: "**Harbourside Dental** is a family dental practice in Manly offering check-ups, fillings, whitening and emergency appointments.",
      kbWhy: "what the practice offers and who it is for",
      kbFacts: "services, hours, booking policy and location",
      factualQueryExamples: ["What services do you offer?", "What are your hours?"],
      valueTriggers: ["The caller asks whether the practice suits their family."],
      speechRules: ["Plain, friendly Australian English.", "Never read out URLs, IDs, JSON, or raw variables."],
      skepticalContext: "Some callers are nervous about the dentist.",
      skepticalLines: ["That's completely understandable - lots of people feel that way."],
      factsTitle: "Practice Facts (facts you may rely on)",
      factsParagraphs: ["Appointments are 30 minutes. Please give 24 hours notice to cancel."],
      transferDestination: "Harbourside Dental front desk team",
      followUpPromise: "I'll make sure the team gets this and calls you back.",
      adviceDomains: ["clinical advice", "diagnosis"],
      adviceDeflect: "The dentist is the right person for that at your appointment.",
      claimsNever: ["Say a treatment is painless.", "Guarantee a price."],
      pricingDiscipline: "prices are discussed at the appointment; never quote one over the phone.",
      closingLine: "Thanks for calling Harbourside Dental - take care.",
      bookingIntro: "books real appointments in the practice diary.",
      bookingIsRequest: false,
      bookingConfirmationNote: "",
      baseNever: ["Give clinical advice or a diagnosis", "Invent information, guess when unsure, or answer beyond the knowledge base and this prompt"],
      baseAlways: ["Stay calm, polite, and respectful", "Resolve the contact per Section 0A and retrieve stored context per Section 0B"],
    },
    kb: [
      {
        part: "facts",
        blocks: [
          { kind: "h1", text: "The facts", citations: [] },
          { kind: "h2", text: "What services do you offer?", citations: [] },
          {
            kind: "p",
            text: "Check-ups and cleans, fillings, whitening and emergency appointments.",
            citations: [{ docId: "doc:1", locator: "", quote: "We offer check-ups and cleans, fillings, whitening" }],
          },
        ],
      },
    ],
    issues: [],
    openItems: [],
    confidence: { score: 0, band: "low", reasons: [] },
  };
}
