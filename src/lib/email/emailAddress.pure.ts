/**
 * One reading of an email address, used by everything in this feature.
 *
 * The whole scheduler turns on being able to say "these two rows are the same
 * person". `Bob@Example.COM `, `bob@example.com` and `"Bob" <BOB@example.com>`
 * are one address, and a feature whose dedupe cannot see that mails somebody
 * three times from one spreadsheet. So identity is `emailKey()` — lowercased,
 * unwrapped, trimmed — and it is the column every uniqueness constraint,
 * suppression lookup and quota count is asked about. `email` (as written) is
 * kept beside it only to be rendered back.
 *
 * Validation here is deliberately conservative rather than RFC-complete.
 * RFC 5322 permits quoted local parts, comments and bare IP literals, none of
 * which appear in a marketing list and all of which are more likely to be a
 * mangled cell than a real mailbox. What matters is the failure direction: a
 * rejected address is reported as invalid, on screen, next to its row number,
 * and can be corrected — an accepted-but-wrong address is a bounce, and a
 * bounce is a deliverability cost paid against the sending domain.
 */

/** RFC 5321 §4.5.3.1 — the wire limits, which are what a receiver enforces. */
export const MAX_LOCAL_LENGTH = 64;
export const MAX_ADDRESS_LENGTH = 254;

/**
 * `Display Name <addr@host>` and `<addr@host>`, which is how an address
 * arrives when a CRM exports a "contact" column rather than an "email" one.
 */
const ANGLE_WRAPPED = /^[^<>]*<\s*([^<>\s]+)\s*>$/;

/** Characters RFC 5322 allows unquoted in a local part. */
const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;

/** A DNS label: alphanumeric, inner hyphens, at most 63 octets. */
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Strip a display name, angle brackets, surrounding quotes and stray
 * whitespace, returning the bare address as written. Case is preserved — this
 * is the "as spelled" reading, not the identity.
 */
export function unwrapAddress(raw: string): string {
  let value = String(raw ?? "").trim();
  // A cell copied out of Outlook routinely arrives wrapped in quotes.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  const angled = ANGLE_WRAPPED.exec(value);
  if (angled) value = angled[1].trim();
  // `mailto:` prefixes survive a copy out of a web page.
  if (/^mailto:/i.test(value)) value = value.slice(7).trim();
  return value;
}

/**
 * The identity of an address: what every unique index, suppression lookup and
 * dedupe is keyed on.
 *
 * The domain is lowercased because DNS is case-insensitive. The LOCAL part is
 * lowercased too, and that is a decision rather than an oversight: SMTP says a
 * local part is case-sensitive, essentially no provider treats it that way,
 * and the failure directions are not comparable — folding case can at worst
 * suppress one duplicate send, while not folding it mails `Bob@x.com` and
 * `bob@x.com` separately, which is the defect this whole module exists to stop.
 */
export function emailKey(raw: string): string | null {
  const address = unwrapAddress(raw);
  if (!isValidAddress(address)) return null;
  return address.toLowerCase();
}

/** Whether a bare (already unwrapped) address is one we will send to. */
export function isValidAddress(address: string): boolean {
  if (!address || address.length > MAX_ADDRESS_LENGTH) return false;
  if (/[\s,;<>()[\]\\"]/.test(address)) return false;

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  // Dot-separated atoms is the whole of the unquoted grammar.
  if (!local.split(".").every((atom) => LOCAL_ATOM.test(atom))) return false;

  if (domain.length > 253) return false;
  const labels = domain.split(".");
  // A single-label domain is a local hostname, never a public mailbox, and a
  // list that carries one is a list whose export lost the domain.
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  // A TLD is letters. `1.2.3.4` and `example.123` are not deliverable here.
  const tld = labels[labels.length - 1];
  if (!/^[A-Za-z]{2,63}$/.test(tld)) return false;

  return true;
}

/** Convenience over `emailKey` for call sites that only want the answer. */
export function isValidEmail(raw: string): boolean {
  return emailKey(raw) !== null;
}

/** The domain of an address, lowercased. Null when the address is not one. */
export function emailDomain(raw: string): string | null {
  const key = emailKey(raw);
  return key ? key.slice(key.lastIndexOf("@") + 1) : null;
}

/**
 * Every address in a block of free text, deduplicated, in order of appearance.
 *
 * This is how a delivery-status report gives up which mailbox failed: the
 * machine-readable part names it as `Final-Recipient: rfc822; a@b.com`, and
 * where a sender is not standards-compliant the only copy is in the prose. The
 * scan is deliberately greedy and the caller decides which of the results
 * matter — see `bounceReport.pure.ts`, which will not suppress an address the
 * campaign never sent to.
 */
const LOOSE_ADDRESS =
  /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?/g;

export function extractAddresses(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of String(text).matchAll(LOOSE_ADDRESS)) {
    // A trailing dot or hyphen belongs to the sentence, not the address.
    const candidate = match[0].replace(/[.-]+$/, "");
    const key = emailKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
