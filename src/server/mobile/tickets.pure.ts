/**
 * Gateway links, grant references and activation tickets.
 *
 * A link is `https://mobile.aurixasystems.com.au/a/<grant_ref>#t=<ticket>`.
 * The ticket rides in the FRAGMENT, which a browser never sends to a server, so
 * it reaches no access log, no CDN log and no Referer header. A GET of the
 * path is a preview and consumes nothing (Draft 02: GET/HEAD never consume a
 * credential). The ticket is spent by one POST to `/api/public/mobile/claim`,
 * and the spend is one conditional UPDATE — never a read followed by a write.
 *
 * Only hashes are stored. A ticket is 32 random bytes; a grant ref is public
 * (it names the grant, it authorises nothing on its own).
 */

import { MOBILE_GATEWAY_ORIGIN } from "./portals.pure";

export const GRANT_REF_PREFIX = "mga_";
export const TICKET_PREFIX = "mgt_";
export const CLONE_CREDENTIAL_PREFIX = "mmc_";
export const DOWNLOAD_TICKET_PREFIX = "mdt_";

export const TICKET_LIFETIME_MS = {
  magic_link: 15 * 60_000,
  provisioned_url: 48 * 3_600_000,
} as const;

export type TicketKind = keyof typeof TICKET_LIFETIME_MS;

export const DOWNLOAD_TICKET_LIFETIME_MS = 10 * 60_000;

const B64URL = /^[A-Za-z0-9_-]+$/;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(
  prefix: string,
  bytes = 32,
  rng: (n: number) => Uint8Array = defaultRng,
): string {
  return `${prefix}${base64url(rng(bytes))}`;
}

function defaultRng(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A grant ref is 16 random bytes — unguessable, but not a secret. */
export function newGrantRef(rng?: (n: number) => Uint8Array): string {
  return randomToken(GRANT_REF_PREFIX, 16, rng);
}

export function newActivationTicket(rng?: (n: number) => Uint8Array): string {
  return randomToken(TICKET_PREFIX, 32, rng);
}

export function newDownloadTicket(rng?: (n: number) => Uint8Array): string {
  return randomToken(DOWNLOAD_TICKET_PREFIX, 32, rng);
}

export function newCloneMobileCredential(rng?: (n: number) => Uint8Array): string {
  return randomToken(CLONE_CREDENTIAL_PREFIX, 32, rng);
}

/** The prefix an operator sees beside a stored credential. */
export function credentialDisplayPrefix(credential: string): string {
  return credential.slice(0, CLONE_CREDENTIAL_PREFIX.length + 8);
}

function shapeOk(
  value: unknown,
  prefix: string,
  minBody: number,
  maxBody: number,
): value is string {
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length >= minBody && body.length <= maxBody && B64URL.test(body);
}

export const isGrantRef = (v: unknown): v is string => shapeOk(v, GRANT_REF_PREFIX, 20, 32);
export const isActivationTicket = (v: unknown): v is string => shapeOk(v, TICKET_PREFIX, 40, 64);
export const isDownloadTicket = (v: unknown): v is string =>
  shapeOk(v, DOWNLOAD_TICKET_PREFIX, 40, 64);
export const isCloneMobileCredential = (v: unknown): v is string =>
  shapeOk(v, CLONE_CREDENTIAL_PREFIX, 40, 64);

/** SHA-256, lowercase hex — the same encoding `hashApiKey` stores. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ticketExpiry(kind: TicketKind, issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + TICKET_LIFETIME_MS[kind]);
}

export function buildGatewayLink(
  grantRef: string,
  ticket: string,
  origin = MOBILE_GATEWAY_ORIGIN,
): string {
  if (!isGrantRef(grantRef)) throw new Error("buildGatewayLink: not a grant ref");
  if (!isActivationTicket(ticket)) throw new Error("buildGatewayLink: not a ticket");
  return `${origin}/a/${grantRef}#t=${ticket}`;
}

export type ParsedGatewayLink = { grantRef: string; ticket: string | null };

/**
 * Reads a link the app was opened with. The ticket is optional: a link
 * without one (a bookmark, a forwarded preview) still names the grant.
 */
export function parseGatewayLink(
  raw: string,
  origin = MOBILE_GATEWAY_ORIGIN,
): ParsedGatewayLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const m = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
  if (!m || !isGrantRef(m[1])) return null;
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  const t = params.get("t");
  return { grantRef: m[1], ticket: isActivationTicket(t) ? t : null };
}

export type TicketRow = {
  expires_at: string;
  consumed_at: string | null;
  consumed_install_id: string | null;
};

export type TicketState = "valid" | "expired" | "used" | "used_by_this_install";

/**
 * A ticket already spent by the SAME installation is a retry of a claim whose
 * answer was lost; it is reported distinctly so the caller can re-issue the
 * assertion for the bound device rather than call it theft.
 */
export function ticketState(row: TicketRow, now: Date, installId: string | null): TicketState {
  if (row.consumed_at) {
    return installId && row.consumed_install_id === installId ? "used_by_this_install" : "used";
  }
  return Date.parse(row.expires_at) <= now.getTime() ? "expired" : "valid";
}
