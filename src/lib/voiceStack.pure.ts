/**
 * A CLONE'S VOICE AGENTS — the vocabulary every surface shares.
 *
 * Each clone answers its phone with a voice-agent stack: Make.com scenarios
 * that do the work (availability, booking, contacts, call context), Vapi tools
 * that call those scenarios, assistants that use the tools, and a squad that
 * hands calls between the assistants. Which stack a clone gets is decided by
 * its CRM LINE, exactly as its code is:
 *
 *   dependent    the GoHighLevel stack. Its scenarios read and write the
 *                tenant's own GoHighLevel location, so a dependent clone's
 *                stack cannot be built without that location's API key.
 *   independent  the native stack. Its scenarios keep contacts, call context
 *                and bookings in the stack's own Make data stores, and book
 *                into the tenant's Outlook or Google calendar once connected.
 *
 * A stack is COPIED from its line's template, and the template is the stack of
 * the line's HEAD clone — the same clone every cascade on that line comes
 * through. So the voice tree has the shape Yggdrasil draws: prime, then the
 * two line heads, then every clone under the head it was created from. When a
 * clone moves line (the CRM conversion), its voice stack moves with it.
 *
 * Every clone's stack lives in that clone's OWN Vapi organisation. The org is
 * created on the clone's own Resend address and held by Aurixa: the tenant
 * never sees the login or the key (`clone_vapi_custody`).
 *
 * Client-safe on purpose: the clone page, the Yggdrasil panel and the server
 * all read these words, so none of them can describe a state the others spell
 * differently.
 */

import type { CrmMode } from "./crmMode.pure";

// ─── The stack ───────────────────────────────────────────────────────────

export const VOICE_STACK_STATUSES = [
  /** Something the stack needs is missing; the reasons say what. */
  "awaiting_requirements",
  /** Everything is in place; the drain will start building. */
  "ready",
  /** Objects are being created in Make and Vapi, step by step. */
  "provisioning",
  /** Built, and waiting on a tenant's own grant (an OAuth connection) to go live. */
  "awaiting_connections",
  /** Every object read back and matched what was written. */
  "live",
  /** A step failed; retried on a back-off, then an operator is told. */
  "failed",
  /** Stopped on purpose (its clone moved line, or an operator parked it). Nothing deleted. */
  "parked",
] as const;

export type VoiceStackStatus = (typeof VOICE_STACK_STATUSES)[number];

export function isVoiceStackStatus(v: unknown): v is VoiceStackStatus {
  return typeof v === "string" && (VOICE_STACK_STATUSES as readonly string[]).includes(v);
}

/** Statuses the drain still has work in. */
export const ACTIVE_VOICE_STACK_STATUSES: readonly VoiceStackStatus[] = [
  "ready",
  "provisioning",
  "awaiting_connections",
  "failed",
];

export const VOICE_STACK_STATUS_COPY: Record<
  VoiceStackStatus,
  { label: string; tone: "neutral" | "busy" | "good" | "warn" | "bad" }
> = {
  awaiting_requirements: { label: "Waiting on requirements", tone: "warn" },
  ready: { label: "Ready to build", tone: "neutral" },
  provisioning: { label: "Building", tone: "busy" },
  awaiting_connections: { label: "Built — waiting on a connection", tone: "warn" },
  live: { label: "Live", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  parked: { label: "Parked", tone: "neutral" },
};

// ─── What each line needs ────────────────────────────────────────────────

export type LineRequirement =
  | "vapi_org"
  | "ghl_api_key"
  | "ghl_location"
  | "ghl_oauth"
  | "identity_replacements"
  | "call_log_target";

export const LINE_REQUIREMENTS: Record<CrmMode, readonly LineRequirement[]> = {
  // A dependent stack's scenarios talk to the tenant's GoHighLevel. The API key
  // and its location are ALWAYS required: they are verified against
  // GoHighLevel, written to the stack's own CFG for the scenarios that call
  // GoHighLevel over HTTP, and they are what an OAuth grant for Make's
  // GoHighLevel modules is checked against.
  dependent: [
    "vapi_org",
    "ghl_api_key",
    "ghl_location",
    "ghl_oauth",
    "identity_replacements",
    "call_log_target",
  ],
  // An independent stack needs nothing from a CRM. The calendar and mailbox
  // are connected afterwards, by the tenant, through voice automation.
  independent: ["vapi_org", "identity_replacements", "call_log_target"],
};

export const LINE_REQUIREMENT_COPY: Record<LineRequirement, { title: string; detail: string }> = {
  vapi_org: {
    title: "The clone's own Vapi organisation",
    detail:
      "Created on the clone's own Resend address and held by Aurixa. Its private key is verified with a real read before anything is built in it.",
  },
  ghl_api_key: {
    title: "GoHighLevel API key",
    detail:
      "The tenant location's private-integration token. Verified against GoHighLevel, stored encrypted, and written into the stack's own CFG record for the scenarios that call GoHighLevel over HTTP.",
  },
  ghl_location: {
    title: "GoHighLevel location",
    detail:
      "The location the key belongs to. The key is refused unless GoHighLevel confirms it reads this location.",
  },
  ghl_oauth: {
    title: "GoHighLevel connection in Make",
    detail:
      "Make's GoHighLevel modules authenticate with a Location OAuth grant, not an API key. The tenant authorises it once; it is accepted only for the same location the key reads. The stack is built before this and goes live after it.",
  },
  identity_replacements: {
    title: "The tenant's business details",
    detail:
      "The template's agents speak as the line head's business. Every name, site and number on the template's deny-list must be replaced before an assistant is created in the tenant's org.",
  },
  call_log_target: {
    title: "The clone's own Call Logs page",
    detail:
      "Every assistant reports its calls to this clone's vapi-call-webhook. The shared secret is minted here and written to both halves, so the pair always agrees.",
  },
};

// ─── Custody of the clone's Vapi organisation ────────────────────────────

export const VAPI_CUSTODY_STATUSES = [
  /** No login yet: the clone has no verified sending domain to receive on. */
  "not_started",
  /** Receiving is being turned on for the clone's domain. */
  "inbox_pending",
  /** The login is minted; an operator signs up with it once (Vapi has no signup API). */
  "awaiting_signup",
  /** Signed up and an org exists; waiting for its private key. */
  "awaiting_key",
  /** The key is verified and held. Stacks can be built in this org. */
  "active",
  /** Stopped by an operator. Nothing is built in a suspended org. */
  "suspended",
] as const;

export type VapiCustodyStatus = (typeof VAPI_CUSTODY_STATUSES)[number];

export function isVapiCustodyStatus(v: unknown): v is VapiCustodyStatus {
  return typeof v === "string" && (VAPI_CUSTODY_STATUSES as readonly string[]).includes(v);
}

export const VAPI_CUSTODY_STATUS_COPY: Record<
  VapiCustodyStatus,
  { label: string; tone: "neutral" | "busy" | "good" | "warn" | "bad" }
> = {
  not_started: { label: "Not started", tone: "neutral" },
  inbox_pending: { label: "Setting up the inbox", tone: "busy" },
  awaiting_signup: { label: "Waiting for sign-up", tone: "warn" },
  awaiting_key: { label: "Waiting for the org key", tone: "warn" },
  active: { label: "Active", tone: "good" },
  suspended: { label: "Suspended", tone: "bad" },
};

/**
 * One line for a clone's voice stack, for a tree node or a list row. A line
 * head is the template its line is copied from and has no status of its own;
 * `none` is a clone on a line whose stack has not been opened yet.
 */
export function describeVoiceLine(input: {
  crmMode: CrmMode | string | null | undefined;
  role: "template" | "stack" | "none";
  status: VoiceStackStatus | string | null | undefined;
}): string {
  const line =
    input.crmMode === "dependent"
      ? "GoHighLevel voice line"
      : input.crmMode === "independent"
        ? "Native voice line"
        : null;
  if (!line) return "No CRM line recorded, so no voice line";
  if (input.role === "template") return `${line} · template for every clone on it`;
  if (input.role === "none" || !input.status) return `${line} · not provisioned yet`;
  const copy = isVoiceStackStatus(input.status)
    ? VOICE_STACK_STATUS_COPY[input.status].label
    : input.status;
  return `${line} · ${copy}`;
}
