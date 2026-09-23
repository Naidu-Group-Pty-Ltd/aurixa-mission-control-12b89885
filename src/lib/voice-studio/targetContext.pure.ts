// What Mission Control already knows about the client, as one citable source
// document ("ctx:target") for the planner.
//
// It is rendered as plain "Label: value" lines so a citation can quote it
// verbatim like any other document. Contact details and web addresses are
// REMOVED before rendering, not merely discouraged: a voice agent must never
// read out a person's number or email, and the validator treats any number in
// a source as quotable - so a number that never enters the source can never
// be quoted into a prompt.

export const CONTEXT_DOC_ID = "ctx:target";

const REDACT_KEYS =
  /^(email|client_email|admin_email|subject_email|mobile_number|phone|mobile|website|deploy_url|github_url|lovable_project_url|landing_page|referrer|page|url)$|_url$|_email$|_phone$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URLISH = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONEISH = /\+?\d[\d\s()-]{7,}\d/g;

/** Drop contact fields, and scrub contact-shaped text out of what remains. */
export function redactForContext(value: unknown, key = ""): unknown {
  if (key && REDACT_KEYS.test(key)) return undefined;
  if (typeof value === "string") {
    return value
      .replace(EMAIL, "[email removed]")
      .replace(URLISH, "[link removed]")
      .replace(PHONEISH, "[number removed]");
  }
  if (Array.isArray(value))
    return value.map((v) => redactForContext(v)).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactForContext(v, k);
      if (r !== undefined && r !== null && r !== "" && !(Array.isArray(r) && r.length === 0))
        out[k] = r;
    }
    return out;
  }
  return value;
}

const label = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function lines(value: unknown, indent = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === "object") {
        out.push(`${indent}${label(k)}:`);
        out.push(...lines(v, indent + "  "));
      } else {
        out.push(`${indent}${label(k)}: ${String(v)}`);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) =>
      v && typeof v === "object" ? lines(v, indent + "  ") : [`${indent}- ${String(v)}`],
    );
  }
  return [`${indent}${String(value)}`];
}

export interface TargetContext {
  kind: "clone" | "lead" | "agreement" | "prospect";
  /** Sections by heading; each is redacted before rendering. */
  sections: Record<string, unknown>;
}

/** The context as document text, or null when there is nothing worth sending. */
export function renderTargetContext(ctx: TargetContext): string | null {
  const parts: string[] = [
    "Mission Control context for this client",
    `Target kind: ${ctx.kind}`,
    "This is what the platform already holds about the client. It was entered by the client or by our staff, not written for callers.",
  ];
  let substantive = false;
  for (const [heading, raw] of Object.entries(ctx.sections)) {
    const cleaned = redactForContext(raw);
    if (cleaned === undefined || cleaned === null || cleaned === "") continue;
    if (typeof cleaned === "object" && Object.keys(cleaned as object).length === 0) continue;
    substantive = true;
    parts.push("", `## ${heading}`, ...lines(cleaned));
  }
  return substantive ? parts.join("\n") : null;
}
