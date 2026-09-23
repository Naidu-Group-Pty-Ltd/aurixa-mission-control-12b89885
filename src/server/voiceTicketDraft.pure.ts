// Turning what a caller SAYS into the support ticket contract.
//
// The ticket pipeline (src/server/support-tickets.server.ts) demands a
// `category` from eleven values, a `breakage_vector` from seven, a subject of
// 4-160 characters and a description of at least 20. None of that is a
// question you can ask somebody on the phone. "Would you describe this as a
// partial outage or degraded performance?" is not a sentence a support agent
// should say out loud, and an assistant made to choose an enum mid-call will
// either stall or invent.
//
// So the agent collects prose and THIS module does the mapping. Two rules
// follow from that division, and both are deliberate:
//
//   1. It never refuses. An unrecognised report becomes `other` / `none`
//      rather than an error. A ticket filed in the wrong category is
//      recoverable by any operator who reads it; a report lost because the
//      caller's words did not match a keyword is not. The classifier
//      downstream re-reads the prose anyway and sets the priority itself.
//
//   2. It never invents. Nothing is written that the caller did not say. The
//      description is padded to clear the 20-character floor only by naming
//      where the report came from, which is true, rather than by embellishing
//      what was reported.
//
// Ordering inside each keyword table is significant: the first match wins, so
// the most consequential and most distinctive readings are tested first. A
// caller who says "I've been charged twice and it's really slow" has a billing
// problem, not a performance one.

import {
  BREAKAGE_VECTORS,
  TICKET_CATEGORIES,
  type BreakageVector,
  type TicketCategory,
} from "@/lib/ticket-classification";

/** What the voice tool collects. Every field is what a person would say. */
export type SpokenTicket = {
  summary?: string | null;
  detail?: string | null;
  what_is_broken?: string | null;
  since_when?: string | null;
  email?: string | null;
};

export type TicketDraft = {
  category: TicketCategory;
  breakage_vector: BreakageVector;
  subject: string;
  description: string;
};

/** The floor `SupportTicketPayloadSchema` enforces on `description`. */
export const MIN_DESCRIPTION_CHARS = 20;
const MAX_DESCRIPTION_CHARS = 5000;
const MIN_SUBJECT_CHARS = 4;
const MAX_SUBJECT_CHARS = 160;

/** Said when the caller gave too little to clear the description floor. */
export const THIN_REPORT_NOTE =
  "Reported by phone; the caller did not describe it further.";

type Rule<T> = readonly [T, readonly string[]];

// Most distinctive first. `bug` sits above `question` so "how do I fix this,
// it's broken" reads as a fault rather than an enquiry; `feature_request` and
// `question` are the last readings before `other`.
const CATEGORY_RULES: readonly Rule<TicketCategory>[] = [
  ["security_threat", ["breach", "hacked", "hacker", "phishing", "malware", "ransom",
    "unauthorised", "unauthorized", "stolen", "leaked", "compromised", "suspicious login"]],
  ["billing", ["invoice", "billing", "charged", "charge me", "double charge", "payment",
    "refund", "subscription", "credit card", "overcharg", "token balance", "out of tokens",
    "credits", "price", "plan cost"]],
  ["access", ["can't log in", "cant log in", "cannot log in", "log in", "login", "sign in",
    "password", "locked out", "permission", "access denied", "not authorised",
    "not authorized", "two factor", "2fa", "mfa"]],
  ["provider_downtime", ["provider", "third party", "third-party", "vendor", "upstream",
    "openai", "twilio", "stripe", "supabase", "google is down"]],
  ["api_outage", ["api is down", "api down", "api isn't", "api is not", "endpoint",
    "integration is down", "webhook"]],
  ["data_issue", ["wrong data", "missing data", "data unavailable", "no data", "duplicate",
    "wrong number", "wrong figure", "incorrect", "out of date", "stale"]],
  ["performance", ["slow", "sluggish", "lagging", "takes ages", "taking forever",
    "timing out", "times out", "timeout"]],
  ["bug", ["error", "broken", "not working", "doesn't work", "does not work", "won't",
    "will not", "crash", "fails", "failing", "failed", "blank page", "blank screen",
    "stuck", "frozen", "freezes"]],
  ["feature_request", ["feature request", "could you add", "can you add", "would be good if",
    "it would help if", "wish it", "suggestion", "nice to have"]],
  ["question", ["how do i", "how can i", "how would i", "what is", "what does", "where do i",
    "where is", "can i", "not sure how"]],
];

const BREAKAGE_RULES: readonly Rule<BreakageVector>[] = [
  ["full_outage", ["everything", "completely down", "totally down", "nothing works",
    "nothing is working", "can't use it at all", "cannot use it at all", "whole system",
    "entire system", "all of it"]],
  ["intermittent", ["sometimes", "comes and goes", "on and off", "now and then", "randomly",
    "intermittent", "every so often", "occasionally"]],
  ["degraded_performance", ["slow", "sluggish", "lagging", "takes ages", "taking forever",
    "delay", "timing out", "times out"]],
  ["partial_outage", ["some of", "parts of", "a few things", "several things",
    "a couple of things", "some things"]],
  ["cosmetic", ["looks wrong", "looks odd", "display", "layout", "cosmetic", "visual",
    "alignment", "formatting", "just looks"]],
  ["single_feature", ["one thing", "just the", "only the", "a single", "one page",
    "one report", "one feature", "this one"]],
];

function norm(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : ""))
    .join(" ")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch<T>(haystack: string, rules: readonly Rule<T>[]): T | null {
  for (const [value, needles] of rules) {
    for (const needle of needles) {
      if (haystack.includes(needle)) return value;
    }
  }
  return null;
}

/** Trim, collapse whitespace, and cap. Never pads, never invents. */
function clean(value: string | null | undefined, max: number): string {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function categoryFromSpeech(spoken: SpokenTicket): TicketCategory {
  return firstMatch(norm(spoken.summary, spoken.detail, spoken.what_is_broken), CATEGORY_RULES)
    ?? "other";
}

export function breakageFromSpeech(spoken: SpokenTicket): BreakageVector {
  // `what_is_broken` is the field the caller was actually asked this about, so
  // it is read on its own first; the rest of the report is the fallback.
  return firstMatch(norm(spoken.what_is_broken), BREAKAGE_RULES)
    ?? firstMatch(norm(spoken.summary, spoken.detail), BREAKAGE_RULES)
    ?? "none";
}

/**
 * Compose the payload fields the schema demands. Total by construction: every
 * input, including an empty one, yields a draft the schema accepts.
 */
export function draftTicketFromSpeech(spoken: SpokenTicket): TicketDraft {
  const summary = clean(spoken.summary, MAX_SUBJECT_CHARS);
  const detail = clean(spoken.detail, MAX_DESCRIPTION_CHARS);
  const broken = clean(spoken.what_is_broken, 400);
  const since = clean(spoken.since_when, 200);

  // A subject shorter than the floor is padded by SAYING it came from a call,
  // which is true, rather than by restating the detail as if it were a summary.
  const subject =
    summary.length >= MIN_SUBJECT_CHARS
      ? summary
      : clean(`Phone report: ${summary || "support request"}`, MAX_SUBJECT_CHARS);

  const lines = [
    detail || summary,
    broken ? `How much is affected: ${broken}` : "",
    since ? `Started: ${since}` : "",
  ].filter(Boolean);

  let description = lines.join("\n").trim();
  if (description.length < MIN_DESCRIPTION_CHARS) {
    description = [description, THIN_REPORT_NOTE].filter(Boolean).join("\n").trim();
  }

  return {
    category: categoryFromSpeech(spoken),
    breakage_vector: breakageFromSpeech(spoken),
    subject,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
  };
}

/**
 * A voice-collected address is only trusted when it parses. Reading an email
 * back over the phone is the most fragile part of this flow, so a value that
 * does not look like an address is discarded rather than sent — the caller's
 * CRM record is the better source, and the schema would reject it anyway.
 */
export function usableEmail(value: string | null | undefined): string | null {
  const raw = clean(value, 320).toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

/** Guards against drift if either enum gains a value this module cannot reach. */
export const DRAFT_CATEGORY_COVERAGE = {
  categories: TICKET_CATEGORIES,
  reachable: [...CATEGORY_RULES.map(([c]) => c), "other" as const],
  vectors: BREAKAGE_VECTORS,
  reachableVectors: [...BREAKAGE_RULES.map(([v]) => v), "none" as const],
} as const;
