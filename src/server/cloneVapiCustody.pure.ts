/**
 * Custody of a clone's own Vapi organisation — the decisions, with no I/O.
 *
 * ## Why every clone has its own org
 *
 * A Vapi private key is scoped to an ORGANISATION and reaches everything in
 * it: every assistant, tool, squad, phone number, call and recording. While
 * the CRM-independent agents lived in Aurixa's own org (org B), no clone could
 * be given a key without being handed every other tenant's agents and the
 * prime's — which is why the clone's Call Logs page has never had agent names
 * or recording re-signing. One org per clone makes the scope of a key exactly
 * one tenant, the way `clone_email_identities` made a Resend key one tenant's.
 *
 * ## Why Aurixa holds it
 *
 * The owner's rule (11 Oct 2026): the tenant never gets into its Vapi org.
 * Aurixa operates every tenant's agents, so Mission Control holds the login,
 * the password and the private key — encrypted, never returned to a browser
 * except the password on an audited reveal — and builds the stack in the org
 * itself (`voice-stack.server.ts`).
 *
 * ## Why one step is a person's
 *
 * Vapi publishes no API to create an account or an organisation: its OpenAPI
 * document declares `CreateOrgDTO` and `CreateTokenDTO` and publishes no route
 * for either, and its dashboard signs people in through WorkOS. So the account
 * is created once, by an operator, with the login Mission Control minted — on
 * an address only this clone's domain receives, whose mail Mission Control
 * reads back so the verification code is on the operator's screen. Everything
 * before that step and everything after it is automatic. (OPEN_QUESTIONS.md B3.)
 *
 * ## The rules
 *
 * - **The login is the clone's own address.** `voice-agents@<sending domain>`,
 *   on the domain provisioning already gave the clone. Never an Aurixa
 *   mailbox: an account on a shared inbox is one password reset away from
 *   belonging to whoever reads that inbox.
 * - **A key is judged before it is held.** It must read as a Vapi key, must
 *   not be Aurixa's own, must not be a key another clone already holds, and
 *   its org must not be another clone's. A key in the wrong org builds one
 *   tenant's agents inside another tenant's org — the failure this whole
 *   module exists to prevent.
 * - **Only Vapi's own mail is opened.** The inbox is the clone's domain, and
 *   other mail can arrive there. A verification code or sign-in link is
 *   extracted only from mail that reads as Vapi's (or WorkOS's, which signs
 *   Vapi's users in), and only links to those hosts are shown.
 *
 * Pure: tested beside it.
 */

import type { VapiCustodyStatus } from "@/lib/voiceStack.pure";

/** The local part of every clone's Vapi login. Distinct from `notifications@`. */
export const VAPI_LOGIN_LOCAL_PART = "voice-agents";

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** The clone's Vapi login address, on its own sending domain. Null on a domain that is not one. */
export function deriveVapiLoginEmail(sendingDomain: string | null | undefined): string | null {
  const d = (sendingDomain ?? "").trim().toLowerCase();
  if (!HOSTNAME.test(d)) return null;
  return `${VAPI_LOGIN_LOCAL_PART}@${d}`;
}

// ─── The password ────────────────────────────────────────────────────────

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGIT = "23456789"; // no 0, 1
const SYMBOL = "-_.!@#%+=";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

export const VAPI_PASSWORD_LENGTH = 28;

/**
 * Mint a password from random bytes. Pure given its byte source, so the rule
 * is testable: every class present, no ambiguous glyph, fixed length.
 *
 * `bytes(n)` must return `n` uniformly random bytes. Modulo bias over a
 * 77-glyph alphabet is under one part in three — irrelevant at 28 characters
 * (well over 160 bits).
 */
export function mintVapiPassword(bytes: (n: number) => Uint8Array): string {
  const raw = bytes(VAPI_PASSWORD_LENGTH + 4);
  if (raw.length < VAPI_PASSWORD_LENGTH + 4) throw new Error("not enough random bytes");
  const chars: string[] = [];
  for (let i = 0; i < VAPI_PASSWORD_LENGTH; i++) chars.push(ALL[raw[i] % ALL.length]);
  // Guarantee each class at four positions chosen by the trailing bytes, so a
  // sign-up form that demands one of each never refuses it.
  const classes = [LOWER, UPPER, DIGIT, SYMBOL];
  for (let c = 0; c < classes.length; c++) {
    const pos = (raw[VAPI_PASSWORD_LENGTH + c] % 7) + c * 7; // four disjoint windows of 7
    chars[pos] = classes[c][raw[pos] % classes[c].length];
  }
  return chars.join("");
}

export function passwordMeetsPolicy(p: string): boolean {
  return (
    p.length >= 16 &&
    [...LOWER].some((c) => p.includes(c)) &&
    [...UPPER].some((c) => p.includes(c)) &&
    [...DIGIT].some((c) => p.includes(c)) &&
    [...SYMBOL].some((c) => p.includes(c))
  );
}

// ─── The key ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v.trim());
}

export type KeyJudgementFacts = {
  key: string;
  orgId: string;
  /** Fingerprint of `key` (`fingerprintOf`). */
  fingerprint: string;
  /** Mission Control's own VAPI_API_KEY, when set. */
  aurixaKey: string | null;
  /** Aurixa's own org ids (org B, and any other Aurixa holds). */
  aurixaOrgIds: readonly string[];
  /** What every OTHER clone holds. */
  others: readonly { cloneId: string; fingerprint: string | null; orgId: string | null }[];
};

export type KeyJudgement =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_a_key"
        | "not_an_org_id"
        | "aurixa_key"
        | "aurixa_org"
        | "key_held_elsewhere"
        | "org_held_elsewhere";
      message: string;
    };

/**
 * May this key be held as this clone's? Refuses by name, before any network
 * call: the probe that follows proves the key WORKS, never that it is the
 * right org's.
 */
export function judgeVapiKey(f: KeyJudgementFacts): KeyJudgement {
  const key = f.key.trim();
  const orgId = f.orgId.trim().toLowerCase();
  if (!isUuid(key))
    return {
      ok: false,
      reason: "not_a_key",
      message: "A Vapi private key is a UUID; this is not one.",
    };
  if (!isUuid(orgId))
    return {
      ok: false,
      reason: "not_an_org_id",
      message: "The organisation id is a UUID (Vapi dashboard → Org Settings); this is not one.",
    };
  if (f.aurixaKey && f.aurixaKey.trim() === key)
    return {
      ok: false,
      reason: "aurixa_key",
      message:
        "This is Mission Control's own Vapi key. A clone's agents are built in the clone's own org, never in Aurixa's.",
    };
  if (f.aurixaOrgIds.map((o) => o.toLowerCase()).includes(orgId))
    return {
      ok: false,
      reason: "aurixa_org",
      message: "That organisation is Aurixa's own. Create the org under the clone's own login.",
    };
  const sameKey = f.others.find((o) => o.fingerprint && o.fingerprint === f.fingerprint);
  if (sameKey)
    return {
      ok: false,
      reason: "key_held_elsewhere",
      message: "Another clone already holds this key. One org per clone: create this clone's own.",
    };
  const sameOrg = f.others.find((o) => o.orgId && o.orgId.toLowerCase() === orgId);
  if (sameOrg)
    return {
      ok: false,
      reason: "org_held_elsewhere",
      message: "Another clone's agents already live in that organisation. One org per clone.",
    };
  return { ok: true };
}

/**
 * Whether objects read back with the key belong to the org the operator named.
 * A fresh org has none, so an empty reading is agreement; any object carrying
 * a DIFFERENT `orgId` is not.
 */
export function readingAgreesWithOrg(
  orgId: string,
  objects: readonly { orgId?: unknown }[],
): boolean {
  const want = orgId.trim().toLowerCase();
  return objects.every((o) => typeof o.orgId !== "string" || o.orgId.toLowerCase() === want);
}

// ─── The inbox ───────────────────────────────────────────────────────────

const VAPI_HOSTS = ["vapi.ai", "workos.com", "workosmail.com", "authkit.app"];

function hostIsVapi(host: string): boolean {
  const h = host.toLowerCase();
  return VAPI_HOSTS.some((v) => h === v || h.endsWith(`.${v}`));
}

/** The address part of a From header: `Vapi <noreply@vapi.ai>` → `noreply@vapi.ai`. */
export function addressOf(from: string | null | undefined): string | null {
  if (!from) return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from);
  return m ? m[1].toLowerCase() : null;
}

/** Whether a message reads as Vapi's (or WorkOS's, which signs Vapi users in). */
export function isVapiMail(msg: {
  from: string | null | undefined;
  subject: string | null | undefined;
}): boolean {
  const addr = addressOf(msg.from);
  if (addr) {
    const host = addr.slice(addr.lastIndexOf("@") + 1);
    if (hostIsVapi(host)) return true;
  }
  return /\bvapi\b/i.test(msg.subject ?? "") || /\bvapi\b/i.test(msg.from ?? "");
}

/** Whether a received message was sent TO this login (any of to / received_for). */
export function isAddressedTo(to: string[] | string | null | undefined, login: string): boolean {
  const want = login.trim().toLowerCase();
  const list = Array.isArray(to) ? to : typeof to === "string" ? [to] : [];
  return list.some((t) => (addressOf(t) ?? t.trim().toLowerCase()) === want);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}

export type VerificationArtifacts = { codes: string[]; links: string[] };

/**
 * The verification code(s) and sign-in link(s) in one of Vapi's messages.
 *
 * A code is a 6–8 digit run within 80 characters of a word that says it is
 * one. A link is kept only if its host is Vapi's or WorkOS's — a link to
 * anywhere else in a mail on this address is not shown, whatever it says.
 */
export function extractVerification(content: {
  text?: string | null;
  html?: string | null;
}): VerificationArtifacts {
  const text = `${content.text ?? ""}\n${content.html ? stripHtml(content.html) : ""}`;
  const codes = new Set<string>();
  const near = /(code|verify|verification|one[- ]time|otp|passcode|sign[- ]in)/i;
  for (const m of text.matchAll(/\b(\d{6,8})\b/g)) {
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - 80), at + m[0].length + 80);
    if (near.test(window)) codes.add(m[1]);
  }
  const links = new Set<string>();
  const hrefs = [
    ...(content.html
      ? [...content.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
      : []),
    ...[...text.matchAll(/https:\/\/[^\s"'<>)]+/g)].map((m) => m[0]),
  ];
  for (const raw of hrefs) {
    try {
      const u = new URL(raw.replace(/&amp;/g, "&"));
      if (u.protocol === "https:" && hostIsVapi(u.hostname)) links.add(u.toString());
    } catch {
      // not a URL
    }
  }
  return { codes: [...codes].slice(0, 5), links: [...links].slice(0, 5) };
}

// ─── Readiness ───────────────────────────────────────────────────────────

/** `clone_vapi_custody` row, as the rules read it. */
export type VapiCustodyRow = {
  clone_id: string;
  login_email: string | null;
  password_set_at: string | null;
  sending_domain: string | null;
  receiving_enabled_at: string | null;
  receiving_records_installed_via: "cloudflare" | "manual" | null;
  signed_up_at: string | null;
  vapi_org_id: string | null;
  key_fingerprint: string | null;
  key_verified_at: string | null;
  suspended_at: string | null;
  last_error: string | null;
};

export type CustodyFacts = {
  resendConfigured: boolean;
  encryptionEnabled: boolean;
  /** The clone's email identity: its sending domain, and whether Resend verified it. */
  emailDomain: {
    sendingDomain: string | null;
    resendDomainId: string | null;
    verified: boolean;
  } | null;
};

export type CustodyStepId = "email_domain" | "receiving" | "login" | "signup" | "org_key";

export type CustodyStep = {
  id: CustodyStepId;
  title: string;
  done: boolean;
  open: boolean;
  blockedBy: string | null;
  detail: string;
};

export type CustodyReadiness = {
  status: VapiCustodyStatus;
  steps: CustodyStep[];
  /** The one step a person or the drain should act on now. */
  open: CustodyStepId | null;
};

const STEP_TITLES: Record<CustodyStepId, string> = {
  email_domain: "The clone's sending domain is verified",
  receiving: "The domain receives mail",
  login: "The Vapi login is minted",
  signup: "An operator signs up and creates the org",
  org_key: "The org's private key is verified and held",
};

export function custodyReadiness(row: VapiCustodyRow | null, f: CustodyFacts): CustodyReadiness {
  const domainOk = Boolean(f.emailDomain?.verified && f.emailDomain.resendDomainId);
  const receivingOk = Boolean(row?.receiving_enabled_at && row.receiving_records_installed_via);
  const loginOk = Boolean(row?.login_email && row.password_set_at);
  const signupOk = Boolean(row?.signed_up_at);
  const keyOk = Boolean(row?.key_verified_at && row.vapi_org_id && row.key_fingerprint);

  const configBlock = !f.resendConfigured
    ? "RESEND_MASTER_API_KEY is not set on Mission Control"
    : !f.encryptionEnabled
      ? "CREDENTIALS_ENC_KEY is not set on Mission Control, so no login can be stored"
      : null;

  const raw: Omit<CustodyStep, "open">[] = [
    {
      id: "email_domain",
      title: STEP_TITLES.email_domain,
      done: domainOk,
      blockedBy: f.emailDomain
        ? null
        : "The clone has no email identity yet (its email panel starts one)",
      detail: f.emailDomain?.sendingDomain
        ? `Sending domain ${f.emailDomain.sendingDomain}${domainOk ? " is verified" : " is not verified yet"}.`
        : "The login lives on the clone's own sending domain.",
    },
    {
      id: "receiving",
      title: STEP_TITLES.receiving,
      done: receivingOk,
      blockedBy: configBlock,
      detail: receivingOk
        ? `Receiving is on; its MX record is in place (${row?.receiving_records_installed_via}).`
        : "Resend's receiving is turned on for the domain and its MX record installed, so Vapi's verification mail can be read here.",
    },
    {
      id: "login",
      title: STEP_TITLES.login,
      done: loginOk,
      blockedBy: configBlock,
      detail: row?.login_email
        ? `Login ${row.login_email}. The password is held encrypted and shown only on an audited reveal.`
        : "A login on the clone's own address and a strong password, held encrypted.",
    },
    {
      id: "signup",
      title: STEP_TITLES.signup,
      done: signupOk,
      blockedBy: null,
      detail:
        "Vapi publishes no sign-up API. Sign up at dashboard.vapi.ai with the login, use the code from the inbox below, and create one organisation named after the clone.",
    },
    {
      id: "org_key",
      title: STEP_TITLES.org_key,
      done: keyOk,
      blockedBy: configBlock,
      detail: keyOk
        ? `Org ${row?.vapi_org_id}, key ${row?.key_fingerprint}.`
        : "Paste the org id and its PRIVATE key. The key is refused if it is Aurixa's, another clone's, or reads another org's objects.",
    },
  ];
  // Done is cumulative: a later step cannot read done while an earlier is not.
  let allBefore = true;
  const steps: CustodyStep[] = raw.map((s) => {
    const done = allBefore && s.done;
    allBefore = done;
    return { ...s, done, open: false };
  });
  const firstOpen = steps.find((s) => !s.done);
  if (firstOpen) firstOpen.open = true;

  let status: VapiCustodyStatus;
  if (row?.suspended_at) status = "suspended";
  else if (!firstOpen) status = "active";
  else if (firstOpen.id === "email_domain") status = "not_started";
  else if (firstOpen.id === "receiving" || firstOpen.id === "login")
    status = row ? "inbox_pending" : "not_started";
  else if (firstOpen.id === "signup") status = "awaiting_signup";
  else status = "awaiting_key";

  return { status, steps, open: firstOpen?.id ?? null };
}

/**
 * Whether the deployment drain should START custody for a clone. Like the
 * email identity it is started by provisioning and advanced by a sweep; it is
 * never started on a clone whose sending domain has not been registered,
 * because the login lives on that domain.
 */
export function decideCustodyStart(f: {
  hasCustodyRow: boolean;
  resendDomainId: string | null;
  sendingDomain: string | null;
  resendConfigured: boolean;
  encryptionEnabled: boolean;
}): { act: true } | { act: false; reason: "already_started" | "no_domain" | "not_configured" } {
  if (f.hasCustodyRow) return { act: false, reason: "already_started" };
  if (!f.resendDomainId || !deriveVapiLoginEmail(f.sendingDomain))
    return { act: false, reason: "no_domain" };
  if (!f.resendConfigured || !f.encryptionEnabled) return { act: false, reason: "not_configured" };
  return { act: true };
}

/** MX records among a domain's records that are not the sending path's own (`send.` return path). */
export function receivingMxRecords<T extends { type: string; name: string; record?: string }>(
  records: readonly T[],
  sendingDomain: string,
): T[] {
  const root = sendingDomain.trim().toLowerCase();
  return records.filter((r) => {
    if (r.type.toUpperCase() !== "MX") return false;
    const name = r.name.trim().toLowerCase().replace(/\.$/, "");
    // Resend lists names relative OR absolute; the receiving MX sits at the
    // domain's root, the sending MX one label below it on the return path.
    const isRoot = name === "" || name === "@" || name === root;
    const label = (r.record ?? "").toLowerCase();
    return isRoot || label.includes("receiv") || label.includes("inbound");
  });
}
