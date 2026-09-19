/**
 * What a public application must satisfy before it is allowed to cost anything.
 *
 * `/api/public/builders/apply` is the one endpoint in Mission Control that an
 * anonymous caller can make CREATE something — an organisation on the network
 * and an email from our verified sending domain. Everything here is about the
 * distance between "a request arrived" and "we spent something on it".
 *
 * The controls are in three tiers, and it matters which is which, because
 * mistaking one for another is how a form ends up looking protected:
 *
 *  * **Boundaries.** The origin allow-list and the body cap. These refuse
 *    before anything is parsed and are the only ones a determined caller
 *    cannot simply satisfy — an Origin header is set by the browser and not
 *    by page script, so they bind every request that comes FROM A BROWSER.
 *    A non-browser client sets whatever it likes, which is precisely why the
 *    tiers below exist.
 *
 *  * **Cost raisers.** The honeypot and the minimum fill time. Both are
 *    trivially defeated by anybody who looks at the page once, and both stop
 *    the overwhelming majority of what actually hits a public form, which is
 *    generic automation that fills every input and posts immediately. They
 *    are NOT a security boundary and this module says so rather than letting
 *    a reader assume otherwise.
 *
 *    They answer to one further rule, learned the hard way on the day this
 *    shipped: **a cost raiser must never be able to refuse a real applicant,
 *    and must never leave one with no way past.** Both did. The decoy was
 *    named inside the browser autofill taxonomy, so a password manager filled
 *    it; the fill clock compared the visitor's wall clock against the
 *    server's, so a machine running fast failed it. Each is fixed at its
 *    cause below, and the page now clears the decoy on a refusal so a second
 *    attempt by a person succeeds where a naive bot's does not — a bot that
 *    does not read the error never gets there.
 *
 *  * **Ceilings.** The per-IP and global rate limits, and the network's own
 *    per-address and per-origin windows. These are the ones that hold when
 *    everything above is defeated, because they bound the WORK rather than
 *    guessing at the caller. They live outside this module because they need
 *    a database; what lives here is the decision about what to count.
 *
 * Nothing in this module validates a field. The network's `readAccessRequest`
 * is the authority on what an application may say, and a second field
 * validator in front of it is how the two come to disagree — the form
 * discloses, this refuses abuse, and the network decides.
 */

/**
 * Where the application form is allowed to be served from.
 *
 * Production origins only. `http://localhost:3000` used to sit in this list,
 * which meant every deployment shipped a development origin it could not be
 * configured out of: `allowedApplyOrigins` APPENDS to these rather than
 * replacing them, so no value of `BUILDER_APPLY_ALLOWED_ORIGINS` could ever
 * remove it. A list that cannot be narrowed is not an allow-list.
 *
 * It was never much of a hole, and it is worth being precise about why rather
 * than overstating the fix. `Origin` is the caller's own claim — a deliberate
 * attacker sends whatever header they like, with or without this entry. What
 * an origin allow-list actually stops is somebody ELSE's page posting from a
 * real browser, and against a caller who is willing to forge the header the
 * ceilings are the only control that holds. What changes here is narrower: a
 * development origin is not a production fact, and shipping one invites the
 * reading that the boundary is stronger than it is.
 *
 * Local work sets `BUILDER_APPLY_ALLOWED_ORIGINS`, which is what that variable
 * is for and what `.env.example` now shows.
 */
export const DEFAULT_APPLY_ORIGINS: readonly string[] = [
  "https://www.aurixasystems.com.au",
  "https://aurixasystems.com.au",
];

/**
 * The largest body worth parsing.
 *
 * The form's own longest field is a 2,000-character message, and the whole
 * payload is thirteen short strings. 16 KiB is roughly eight times the
 * realistic maximum, which leaves room for a long message in a multi-byte
 * script and still refuses a megabyte before `JSON.parse` sees it.
 */
export const MAX_APPLY_BODY_BYTES = 16 * 1024;

/**
 * The field no person can see and no person fills in.
 *
 * It was called `company_website`, labelled "Company website", and hidden by
 * pushing it off-screen. All three were wrong, and together they refused a
 * real applicant on 18 Sep 2026 within thirty seconds of the page opening:
 * `company` and `website` are both tokens in Chrome's autofill taxonomy, the
 * label is itself a matching signal, `autocomplete="off"` is widely ignored
 * for profile fields, and an off-screen input is autofilled where a
 * `display: none` one generally is not.
 *
 * A plausible name was chosen deliberately, so a bot skipping a field called
 * `honeypot` would still fill this one. The flip side went unnoticed: a
 * plausible name is exactly what a password manager fills. The name is now
 * outside every autofill category while still not announcing itself as a
 * trap, and the page hides it with `display: none`.
 *
 * It is still not a security boundary. What changed is that it can no longer
 * be tripped by somebody's browser being helpful.
 */
export const HONEYPOT_FIELD = "application_slot";

/**
 * Tokens a browser matches a profile field on.
 *
 * Asserted against `HONEYPOT_FIELD` by a test rather than left as advice,
 * because the next person to pick a "plausible" name will pick one of these.
 */
export const AUTOFILL_TOKENS: readonly string[] = [
  "address",
  "city",
  "company",
  "country",
  "email",
  "name",
  "organization",
  "phone",
  "postal",
  "postcode",
  "state",
  "street",
  "suburb",
  "tel",
  "title",
  "url",
  "website",
  "zip",
];

/**
 * How quickly a human could conceivably complete this form.
 *
 * Measured against the form itself: four required fields, one of them a
 * select. Three seconds is below anything a person types and above what a
 * script spends.
 *
 * **It is measured by the page's own monotonic clock, never by comparing two
 * wall clocks.** The first version sent `rendered_at` as an ISO timestamp
 * from the browser and subtracted it from the server's `Date.now()` — two
 * independent clocks, so a machine running half a minute fast made a form
 * that had been open for twenty seconds look like one submitted instantly.
 * That is not a rare configuration, and it refused a real applicant with no
 * way past it.
 *
 * `performance.now()` counts from the page's own load, so both ends of the
 * subtraction come from one clock and skew cannot exist. The value is still
 * supplied by the client and still forgeable: this raises the cost of naive
 * automation and is relied on for nothing.
 */
export const MIN_FILL_SECONDS = 3;

/**
 * And the other end: a form open for half a day is a stale tab, not a session.
 *
 * Refusing it is not about abuse. It is that the page's copy, its option list
 * and the account state behind it have all moved on.
 */
export const MAX_FILL_HOURS = 12;

/** Per-IP burst ceiling, per minute. */
export const APPLY_PER_IP_PER_MINUTE = 3;

/**
 * Global ceiling, per minute, across every caller.
 *
 * The backstop for the case the per-IP limit cannot answer: many addresses,
 * a few requests each. Set well above any real minute on a form of this kind
 * and far below what a botnet would want, so it is invisible in normal
 * operation and decisive in the only situation it exists for.
 */
export const APPLY_GLOBAL_PER_MINUTE = 40;

export type ApplyGuardRefusal =
  | "forbidden_origin"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_payload"
  | "submission_rejected";

export type ApplyGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ApplyGuardRefusal; readonly status: number };

/** Trailing slashes differ between browsers; compare the normalised form. */
export function normaliseOrigin(origin: string | null | undefined): string {
  return typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
}

export function allowedApplyOrigins(extra: string | null | undefined): string[] {
  const configured = (extra ?? "")
    .split(",")
    .map((value) => normaliseOrigin(value))
    .filter(Boolean);
  return [...DEFAULT_APPLY_ORIGINS, ...configured];
}

export function originIsAllowed(origin: string | null | undefined, extra?: string | null): boolean {
  const normalised = normaliseOrigin(origin);
  // An absent Origin is refused rather than trusted. Every browser sends one
  // on a cross-origin POST, so the requests this drops are the ones that did
  // not come from a page at all.
  if (!normalised) return false;
  return allowedApplyOrigins(extra).includes(normalised);
}

/**
 * The cost-raising checks, over a body that has already parsed.
 *
 * Every refusal here answers the SAME code and the same status as the
 * others. That is deliberate: telling a caller which trap they tripped is
 * telling them what to change, and there is no honest reader of this answer
 * — a real applicant cannot trip any of them.
 */
export function readApplyHeuristics(body: Record<string, unknown>): ApplyGuardVerdict {
  const decoy = body[HONEYPOT_FIELD];
  if (typeof decoy === "string" && decoy.trim().length > 0) {
    return { ok: false, error: "submission_rejected", status: 422 };
  }

  // How long the page says it was open, by its own clock. Anything that is
  // not a plain finite non-negative number is UNKNOWN and accepted: a cost
  // raiser must never refuse on data it cannot trust, and this one has
  // already refused somebody real once.
  const elapsed = body.elapsed_ms;
  if (typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0) {
    const seconds = elapsed / 1000;
    if (seconds < MIN_FILL_SECONDS) {
      return { ok: false, error: "submission_rejected", status: 422 };
    }
    if (seconds > MAX_FILL_HOURS * 3600) {
      return { ok: false, error: "submission_rejected", status: 422 };
    }
  }

  return { ok: true };
}

/**
 * The fields that travel on to the network, and nothing else.
 *
 * An allow-list rather than a delete-list: the honeypot, the timestamp and
 * anything else a caller invents must not reach a function that writes rows,
 * and a list of what to REMOVE is a list somebody has to remember to extend.
 */
export const APPLY_FIELDS = [
  "legal_name",
  "trading_name",
  "org_type",
  "abn",
  "acn",
  "contact_name",
  "contact_email",
  "contact_phone",
  "website",
  "suburb",
  "state",
  "postcode",
  "message",
] as const;

/**
 * The longest each field may be.
 *
 * The network trims to its own limits and the columns are `text`, so this is
 * not about storage — it is that a 50,000-character `suburb` inside a body
 * small enough to pass the cap is still a row nobody wants and a log line
 * nobody can read.
 */
const FIELD_LIMIT: Record<string, number> = { message: 2000 };
const DEFAULT_FIELD_LIMIT = 200;

export function projectApplyFields(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of APPLY_FIELDS) {
    const value = body[field];
    if (typeof value !== "string") continue;
    out[field] = value.slice(0, FIELD_LIMIT[field] ?? DEFAULT_FIELD_LIMIT);
  }
  return out;
}

/**
 * Whether a Turnstile token must be presented.
 *
 * The SECRET decides, never a site key and never a flag. A deployment that
 * holds the secret requires a token and verifies it — fail closed. One that
 * does not holds a form with no CAPTCHA, which is the state this shipped in,
 * and minting the pair later turns the control on with no code change.
 *
 * The inverse — requiring a token whenever a site key happens to be
 * published — is what makes a CAPTCHA that cannot be verified look like one
 * that can.
 */
export function turnstileRequired(secret: string | null | undefined): boolean {
  return typeof secret === "string" && secret.trim().length > 0;
}
