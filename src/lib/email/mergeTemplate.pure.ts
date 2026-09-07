/**
 * Merge fields — `{{first_name}}` — over a subject line and a body.
 *
 * Three rules, each of which exists because the alternative is a defect a
 * recipient sees:
 *
 * **Substitution escapes.** A body is HTML, and a contact called
 * `Smith & Sons <Trading>` substituted raw closes a tag and swallows the rest
 * of the paragraph. Worse, a list is data somebody else supplied, so an
 * unescaped merge is a way to put markup of their choosing into mail sent
 * under our domain. Escaping is done by the renderer rather than asked of the
 * caller, so no call site can forget.
 *
 * **An unknown field renders empty and is reported before the send, not
 * after.** `Hi {{firstname}},` against a list whose column is `first_name`
 * produces `Hi ,` on every message — a defect that is invisible in the editor
 * and obvious in the inbox. `missingFields` is what the campaign page checks
 * before it will start.
 *
 * **A personalised template forces one recipient per message.** `{{state}}`
 * has no single answer for forty people in one BCC line, and neither does an
 * unsubscribe link, which has to identify the person clicking it. So the
 * presence of any per-recipient field caps the batch at one — stated on the
 * page rather than discovered when forty people are addressed as `Hi ,`.
 */

/** Fields the campaign supplies, the same for everybody who receives it. */
export const CAMPAIGN_FIELDS = ["campaign_name", "sender_name", "today"] as const;

/**
 * Fields the recipient supplies. Any of these in a template means one message
 * per person.
 */
export const RECIPIENT_FIELDS = ["email", "unsubscribe_url"] as const;

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Every field a template names, in order of first appearance. */
export function findTokens(...templates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const template of templates) {
    for (const match of String(template ?? "").matchAll(TOKEN)) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * Fields a template names that nothing can supply.
 *
 * `available` is the list's column keys; the built-ins are added here so a
 * caller cannot forget one and report `unsubscribe_url` as missing.
 */
export function missingFields(tokens: string[], available: string[]): string[] {
  const known = new Set<string>([...available, ...CAMPAIGN_FIELDS, ...RECIPIENT_FIELDS]);
  return tokens.filter((token) => !known.has(token));
}

/**
 * Whether this template can only be sent to one person at a time.
 *
 * Any field that is not campaign-level is per-recipient — a column from the
 * list, the address itself, or the unsubscribe link.
 */
export function requiresOneRecipient(...templates: string[]): boolean {
  const campaignLevel = new Set<string>(CAMPAIGN_FIELDS);
  return findTokens(...templates).some((token) => !campaignLevel.has(token));
}

/** The per-recipient fields a template uses, for explaining the rule above. */
export function personalisingFields(...templates: string[]): string[] {
  const campaignLevel = new Set<string>(CAMPAIGN_FIELDS);
  return findTokens(...templates).filter((token) => !campaignLevel.has(token));
}

export type RenderContext = Record<string, string | null | undefined>;

/**
 * Render a template. `html` decides escaping, and it is the body's own format
 * — a plain-text body escaped would show `&amp;` to the reader.
 */
export function renderTemplate(
  template: string,
  context: RenderContext,
  options: { html: boolean },
): string {
  return String(template ?? "").replace(TOKEN, (_whole, name: string) => {
    const value = context[name];
    if (value == null) return "";
    return options.html ? escapeHtml(String(value)) : String(value);
  });
}

/** A short, tag-free excerpt of a body, for a list row or a log line. */
export function bodyPreview(body: string, limit = 200): string {
  const text = String(body ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
