/**
 * Per-clone email identity — the decisions, with no network in them.
 *
 * The dedicated-email model: a clone sends mail with its OWN Resend key,
 * scoped to its OWN verified sending domain, instead of inheriting the
 * prime's `RESEND_API_KEY`. The inherited model failed in production the
 * first time the prime's key rotated: every clone's outbound mail (OTP
 * resets, portal invites — 22 edge functions) answered `401 API key is
 * invalid`, and nothing on the clone could say why. Scoping also bounds the
 * blast radius: a leaked clone key can send as that clone alone.
 *
 * Everything here is pure so the flow's rules — what the next step is, which
 * DNS records Mission Control may write itself, when a key may be minted —
 * can each be asserted by name without Resend, Cloudflare, or a database.
 */
import type { ResendDnsRecord } from "./resend-client";
import type { SecretShellStatus } from "./backend-provisioning.server";

/** `clone_email_identities` row, as read by the flow. */
export type EmailIdentityRow = {
  id: string;
  clone_id: string;
  sending_domain: string;
  region: string;
  resend_domain_id: string | null;
  domain_status: "unprovisioned" | "pending_dns" | "verified" | "failed" | "revoked";
  dns_records: ResendDnsRecord[];
  dns_installed_via: "cloudflare" | "manual" | null;
  resend_key_id: string | null;
  key_last4: string | null;
  key_written_at: string | null;
  default_from_address: string | null;
  /**
   * When `RESEND_FROM_EMAIL` reached the clone. Separate from
   * `key_written_at` because the key used to travel alone: an identity
   * provisioned before the two were paired has a key and no address, which is
   * the state that read as finished and could not send.
   */
  from_address_written_at: string | null;
  /**
   * When an operator revoked this identity. Intent, not observation — see the
   * migration: `domain_status` is what Resend says about the domain and is
   * overwritten from Resend on every pass, so it cannot carry "we stopped
   * this on purpose". While set, nothing may mint.
   */
  revoked_at: string | null;
  last_error: string | null;
};

/** The clone facts the derivations read. */
export type CloneHostFacts = {
  slug: string;
  subdomain_fqdn: string | null;
  deploy_url: string | null;
};

// A hostname: dot-separated labels, letters/digits/hyphens, at least one dot.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

export function isValidSendingDomain(domain: string): boolean {
  return HOSTNAME.test(domain.trim().toLowerCase());
}

/**
 * The default sending domain for a clone: `send.` under the clone's own live
 * hostname. A subdomain, per Resend's own guidance, so nothing this flow does
 * ever touches the root domain's existing mail posture (a root-level SPF/MX
 * collision with a tenant's real mailbox provider is the failure this rule
 * prevents). Returns null when the clone has no resolvable host yet — the
 * operator supplies a domain explicitly in that case, and null is a refusal
 * to guess, not a default.
 */
export function deriveSendingDomain(clone: CloneHostFacts): string | null {
  const fromFqdn = clone.subdomain_fqdn?.trim().toLowerCase();
  if (fromFqdn && HOSTNAME.test(fromFqdn)) return `send.${fromFqdn}`;
  const url = clone.deploy_url?.trim();
  if (url) {
    try {
      const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
      // A *.vercel.app host is Vercel's domain, not the clone's — Resend can
      // never verify it, so it is not a usable default.
      if (HOSTNAME.test(host) && !host.endsWith(".vercel.app")) return `send.${host}`;
    } catch {
      // fall through to null
    }
  }
  return null;
}

/**
 * The address the clone's brand config should carry once the domain
 * verifies. `notifications@` mirrors the role the prime's own
 * `fromHeaderNotifications` fallback uses.
 */
export function deriveFromAddress(sendingDomain: string): string {
  return `notifications@${sendingDomain.trim().toLowerCase()}`;
}

/** Identification without storage: the only part of a token ever kept. */
export function keyLast4(token: string): string {
  return token.slice(-4);
}

// ─── DNS installation planning ───────────────────────────────────────

export type DnsInstallationPlan = {
  /** Records whose names fall inside the clone's Cloudflare zone. */
  auto: ResendDnsRecord[];
  /** Records Mission Control cannot write — shown to the operator verbatim. */
  manual: ResendDnsRecord[];
};

export type EmailDnsZone = {
  zoneId: string;
  /**
   * Known without a vendor call for the fleet zone, whose name is stored
   * beside its id. Null for a clone's own zone — the name is read from
   * Cloudflare, because nothing local records it.
   */
  zoneName: string | null;
  source: "clone" | "fleet";
};

/**
 * Which Cloudflare zone to try to write this clone's email DNS into.
 *
 * This used to be `clone.cloudflare_enabled ? clone.cloudflare_zone_id : null`
 * and nothing else, which asks the wrong question. Those two columns are set
 * by ATTACHING AN EDGE PROVIDER to a clone — the WAF/CDN wrapper written to
 * `cloudflare_clone_config` — and that table is empty on this deployment,
 * which is exactly what the Edge card means by "No edge provider attached".
 * Meanwhile every clone subdomain already lives in the FLEET zone recorded in
 * `platform_hosting_config`, and Mission Control writes records there
 * routinely (it is where `provision_subdomain` puts a clone's CNAME).
 *
 * So the default sending domain — `send.<clone-fqdn>`, whose SPF, DKIM and MX
 * records all fall inside that same fleet zone — was being handed to an
 * operator to install by hand, into a zone this platform manages and had
 * written to minutes earlier. Same DNS-versus-wrapper conflation the Edge
 * card carried; a second consumer of it.
 *
 * The clone's own zone still wins when one is genuinely attached: a tenant
 * that brought its own domain has its records in that zone, not the fleet's.
 *
 * Returning a zone is a candidacy, never a licence to write. `planDnsInstallation`
 * still decides record by record whether a name falls inside the resolved
 * zone, and anything outside it stays the operator's to install. That
 * containment check is what makes falling back to the fleet zone safe: a
 * tenant-owned sending domain resolves to the fleet zone here and then
 * installs nothing, because none of its records are inside it.
 */
export function resolveEmailDnsZone(input: {
  cloneCloudflareEnabled: boolean;
  cloneZoneId: string | null;
  fleetZoneId: string | null;
  fleetZoneName: string | null;
}): EmailDnsZone | null {
  if (input.cloneCloudflareEnabled && input.cloneZoneId) {
    return { zoneId: input.cloneZoneId, zoneName: null, source: "clone" };
  }
  if (input.fleetZoneId) {
    return {
      zoneId: input.fleetZoneId,
      zoneName: input.fleetZoneName?.trim().toLowerCase() || null,
      source: "fleet",
    };
  }
  return null;
}

/**
 * Resend's record names are RELATIVE to the registrable domain, not FQDNs.
 *
 * For the sending domain `send.npc.aurixasystems.com.au` the API answers with
 *
 *     resend._domainkey.send.npc
 *     send.send.npc            (SPF TXT and the MX, on Resend's own `send.`)
 *
 * — the same names with `.aurixasystems.com.au` cut off. Every consumer here
 * assumed a fully-qualified name: `planDnsInstallation` asks whether a name
 * ends with the zone, which is false for all three, so a domain sitting
 * squarely inside a zone Mission Control manages was handed to an operator
 * anyway. Measured on the first live provisioning run.
 *
 * The root is reconstructed from the SENDING DOMAIN rather than from a public
 * suffix list: `.com.au` is a multi-label suffix, and guessing where a name
 * ends is exactly the class of mistake that would silently write a record into
 * the wrong place. The relative name's trailing labels overlap the sending
 * domain's leading labels — `send.send.npc` ends with `send.npc`, which is
 * where `send.npc.aurixasystems.com.au` begins — so the missing labels are the
 * remainder, and nothing is inferred that the two names do not already agree
 * on.
 *
 * Returns null when no overlap exists. A name that cannot be resolved
 * confidently is one nobody should write: the caller treats it as the
 * operator's to install.
 */
export function absoluteRecordName(raw: string, sendingDomain: string): string | null {
  const n = raw.trim().toLowerCase().replace(/\.$/, "");
  const s = sendingDomain.trim().toLowerCase().replace(/\.$/, "");
  if (!n || !s) return null;
  // Already fully qualified.
  if (n === s || n.endsWith(`.${s}`)) return n;

  const nl = n.split(".");
  const sl = s.split(".");
  // Longest overlap first: a shorter one can match by coincidence (a single
  // `send` label would, and would append the wrong tail).
  for (let k = Math.min(nl.length, sl.length); k >= 1; k--) {
    if (nl.slice(nl.length - k).join(".") === sl.slice(0, k).join(".")) {
      return [...nl, ...sl.slice(k)].join(".");
    }
  }
  return null;
}

/**
 * Re-express a set of Resend records with fully-qualified names.
 *
 * Applied where the records are STORED, so the planner, the Cloudflare writer
 * and the table an operator copies from all read the same absolute names —
 * rather than each re-deriving them and one of them getting it wrong.
 */
export function withAbsoluteRecordNames(
  records: ResendDnsRecord[],
  sendingDomain: string,
): ResendDnsRecord[] {
  return records.map((r) => {
    const absolute = absoluteRecordName(r.name, sendingDomain);
    return absolute ? { ...r, name: absolute } : r;
  });
}

/**
 * Which of Resend's required records Mission Control may write itself.
 *
 * A record is auto-installable only when the clone has a Cloudflare zone AND
 * the record's fully-qualified name sits inside that zone. Anything else —
 * no zone, a tenant-owned domain, a name outside the zone — is the
 * operator's to install, and the plan says so rather than half-writing.
 */
export function planDnsInstallation(
  records: ResendDnsRecord[],
  zoneName: string | null,
): DnsInstallationPlan {
  const zone = zoneName?.trim().toLowerCase() ?? null;
  const auto: ResendDnsRecord[] = [];
  const manual: ResendDnsRecord[] = [];
  for (const r of records) {
    const name = r.name.trim().toLowerCase();
    const inZone = zone !== null && (name === zone || name.endsWith(`.${zone}`));
    (inZone ? auto : manual).push(r);
  }
  return { auto, manual };
}

// ─── Readiness — the server owns "what next" ─────────────────────────

export type EmailIdentityStepId =
  | "master_key"
  | "domain"
  | "dns"
  | "verified"
  | "key_written"
  | "sender";

export type EmailIdentityStep = {
  id: EmailIdentityStepId;
  /** done = settled; open = the one thing to do next; blocked = waiting behind the open step. */
  state: "done" | "open" | "blocked";
  detail: string;
};

export type EmailIdentityReadiness = {
  steps: EmailIdentityStep[];
  next: EmailIdentityStepId | null; // null = fully live
  live: boolean;
};

/**
 * Arrange the stored facts as an ordered path with exactly one open step.
 * Derives nothing new — every fact comes from the row and the configuration
 * flag; this only gives them an order.
 */
export function identityReadiness(
  row: EmailIdentityRow | null,
  opts: { resendConfigured: boolean },
): EmailIdentityReadiness {
  const steps: EmailIdentityStep[] = [];
  let open = false;
  const push = (id: EmailIdentityStepId, done: boolean, detail: string) => {
    const state = done ? "done" : open ? "blocked" : "open";
    if (!done) open = true;
    steps.push({ id, state, detail });
  };

  push(
    "master_key",
    opts.resendConfigured,
    opts.resendConfigured
      ? "Platform Resend master key is configured"
      : "Set RESEND_MASTER_API_KEY in Mission Control's own environment",
  );
  push(
    "domain",
    Boolean(row?.resend_domain_id),
    row?.resend_domain_id
      ? `${row.sending_domain} is registered at Resend`
      : "Register the clone's sending domain at Resend",
  );
  push(
    "dns",
    Boolean(row?.dns_installed_via),
    row?.dns_installed_via === "cloudflare"
      ? // Not necessarily the CLONE's zone — the default sending domain lands in
        // the fleet zone. `dns_installed_via` carries cloudflare-vs-manual and
        // nothing finer, so the wording must not claim which zone it was.
        "DNS records written to Cloudflare"
      : row?.dns_installed_via === "manual"
        ? "DNS records handed to the operator to install"
        : "Install the SPF, DKIM and MX records Resend requires",
  );
  push(
    "verified",
    row?.domain_status === "verified",
    row?.domain_status === "verified"
      ? "Resend has verified the domain"
      : row?.domain_status === "failed"
        ? "Verification failed — check the DNS records and re-check"
        : "Waiting for DNS to propagate; re-check to poll Resend",
  );
  push(
    "key_written",
    Boolean(row?.key_written_at),
    row?.key_written_at
      ? `Domain-scoped key (…${row.key_last4 ?? "????"}) written to the clone as RESEND_API_KEY`
      : row?.revoked_at
        ? // A revoked identity has no key by design. Saying "mint one" here
          // offers an act every path refuses, which reads as a broken page.
          "Revoked — this clone cannot send. Resume the identity to mint a new key."
        : "Mint the clone's domain-scoped sending key and write it to the clone",
  );
  // The key alone is not a working mailer. A `sending_access` key scoped to
  // this domain can send from THIS DOMAIN AND NOTHING ELSE, and the clone's
  // edge functions build their from-header from their own brand config —
  // which is empty on a fresh clone and falls back to the prime's legacy
  // address. So a clone finished the path holding a valid key it could not
  // use, and the card said "Dedicated key live". The address is written
  // alongside the key as `RESEND_FROM_EMAIL`; this step is what makes the
  // difference visible on an identity provisioned before they were paired.
  push(
    "sender",
    Boolean(row?.from_address_written_at),
    row?.from_address_written_at
      ? `Clone sends as ${row.default_from_address ?? "its verified address"} (RESEND_FROM_EMAIL)`
      : "Write the verified sender address to the clone as RESEND_FROM_EMAIL",
  );

  const next = steps.find((s) => s.state === "open")?.id ?? null;
  return { steps, next, live: next === null };
}

export type DnsProbe = { name: string; type: string };

/**
 * The records that decide whether a domain can SEND.
 *
 * Domains registered at Resend after August 2026 carry a FOURTH record: a
 * CNAME, `r<return-path>` → `send.forge.rmta.net`, a second (fallback) sending
 * host beside the SES return path the MX and SPF records describe. Resend
 * verifies each return path on its own, and a domain whose DKIM and one
 * return path are verified is `partially_verified` — it sends, without the
 * fallback.
 *
 * Measured on `send.npc-crm-independent…` on 24 Sep 2026: DKIM, MX and SPF
 * verified while the CNAME stayed `pending`, because the Cloudflare writer had
 * created it PROXIED — a proxied name answers with Cloudflare's own addresses
 * and no CNAME at all. And the gate asked about the CNAME too, so it never
 * called verify: one broken fallback record held back the records that decide
 * whether mail can be sent at all.
 *
 * So the first verification waits on these types alone. The CNAME is still
 * installed (unproxied) and still verified — after the domain can send, not
 * before.
 */
const VERIFICATION_GATE_TYPES = new Set(["TXT", "MX"]);

/**
 * The distinct (name, type) lookups that decide whether Resend's records are
 * visible in DNS yet.
 *
 * Resend answers with two records on the same name — an MX and a TXT for SPF —
 * so a naive walk asks the same question twice. Values are deliberately NOT
 * compared: Resend is the authority on whether its own DKIM key matches, and
 * re-implementing that here would mean re-implementing TXT chunk joining and
 * getting it subtly wrong. All this needs to know is whether the name exists,
 * because that is what a negative cache poisons.
 *
 * Only the sending records hold the door (see `VERIFICATION_GATE_TYPES`), and
 * once some of them have verified, only the ones that have NOT. The fallback
 * CNAME is asked about last — when it is the only record outstanding — so a
 * partially verified domain is re-checked once it can be seen, and a broken
 * fallback never delays the records that decide whether mail goes out.
 */
export function expectedDnsProbes(records: ResendDnsRecord[]): DnsProbe[] {
  const isVerified = (r: ResendDnsRecord) => (r.status ?? "").toLowerCase() === "verified";
  const gates = (r: ResendDnsRecord) => VERIFICATION_GATE_TYPES.has(r.type.trim().toUpperCase());
  const anyVerified = records.some(isVerified);
  const pending = records.filter((r) => !isVerified(r));
  const pendingSending = pending.filter(gates);
  const candidates = !anyVerified
    ? records.filter(gates)
    : pendingSending.length > 0
      ? pendingSending
      : pending;
  const seen = new Set<string>();
  const probes: DnsProbe[] = [];
  for (const r of candidates) {
    const name = r.name.trim().toLowerCase();
    const type = r.type.trim().toUpperCase();
    if (!name || !type) continue;
    const key = `${type} ${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push({ name, type });
  }
  return probes;
}

/**
 * Resend's domain status → this table's.
 *
 * `verified` means verified. So does `partially_verified`, where DKIM and one
 * of the two return paths are — Resend's own guidance is that such a domain
 * sends, only without the fallback host (see `VERIFICATION_GATE_TYPES`). This
 * used to fall through to "the DNS answer is not in yet", which made a domain
 * that could send look like one that could not, and `canMintKey` refused the
 * key the clone needed: NPC CRM Independent sat there on 24 Sep 2026.
 *
 * A partial status counts only while every DKIM record is verified. DKIM is
 * what no path can send without, so a partial status WITHOUT it — the sending
 * half failed while something else verified — is still not a working domain.
 *
 * The outstanding record is not forgotten: `domainFullyVerified` keeps the DNS
 * repair and the re-check running until every record is verified.
 */
export function mapResendDomainStatus(
  status: string,
  records: ResendDnsRecord[] = [],
): EmailIdentityRow["domain_status"] {
  const s = status.trim().toLowerCase();
  if (s === "verified") return "verified";
  if (s === "partially_verified" || s === "partially_failed") {
    const dkim = records.filter(
      (r) => /dkim/i.test(r.record ?? "") || /(^|\.)_domainkey\./i.test(r.name),
    );
    const dkimVerified =
      dkim.length > 0 && dkim.every((r) => (r.status ?? "").toLowerCase() === "verified");
    if (dkimVerified) return "verified";
    return s === "partially_failed" ? "failed" : "pending_dns";
  }
  if (s === "failure" || s === "failed") return "failed";
  // not_started | pending | temporary_failure — "the DNS answer is not in yet".
  return "pending_dns";
}

/**
 * Whether every record Resend published is verified — stricter than "can
 * send", and what decides whether the DNS repair and the re-check keep going.
 * A record with no status (an older reading) is not counted against it.
 */
export function domainFullyVerified(
  row: Pick<EmailIdentityRow, "domain_status" | "dns_records">,
): boolean {
  if (row.domain_status !== "verified") return false;
  return row.dns_records.every((r) => {
    const s = (r.status ?? "").toLowerCase();
    return s === "" || s === "verified";
  });
}

// ─── DNS record sync ─────────────────────────────────────────────────

/** A record as Cloudflare holds it — what the sync compares Resend's against. */
export type ExistingDnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean | null;
  priority?: number | null;
};

/**
 * What to do about ONE of Resend's required records.
 *
 * `action` is about the record itself; `remove` lists records at the same
 * name that CONTRADICT it — a second DKIM key under the selector, a second SPF
 * policy, an SES feedback MX for another region — and must go once the right
 * one is in place, because their mere presence breaks the check.
 */
export type DnsSyncStep = {
  record: ResendDnsRecord;
  action: "keep" | "create" | "update" | "conflict";
  /** The Cloudflare record to keep or update. */
  existingId?: string;
  /** Why an update is needed: a different value, or a proxy in front of a CNAME. */
  reason?: "stale_value" | "proxied";
  remove: string[];
  /** Set on a conflict: why nothing may be written for this record. */
  detail?: string;
};

function normHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * A TXT value as its RDATA, not as Cloudflare prints it.
 *
 * Cloudflare answers TXT content wrapped in quotes, and a long value — a DKIM
 * key — may come back as several quoted strings, which DNS concatenates. The
 * comparison is on what a resolver would hand a verifier.
 */
function normTxt(value: string): string {
  const raw = value.trim();
  const chunks = raw.match(/"((?:[^"\\]|\\.)*)"/g);
  const joined =
    chunks && chunks.length > 0 && raw.startsWith('"')
      ? chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, "$1")).join("")
      : raw;
  return joined.replace(/\s+/g, " ").trim();
}

/** Which kind of TXT a value is — a name may legitimately hold other TXT. */
function txtKind(value: string): "dkim" | "spf" | "other" {
  const v = normTxt(value);
  if (/^v=spf1(\s|$)/i.test(v)) return "spf";
  if (/^(v=DKIM1\s*;\s*)?([a-z]=[^;]*;\s*)*p=/i.test(v)) return "dkim";
  return "other";
}

/** Resend's bounce MX: an SES feedback host, in some region. */
function isSesFeedbackMx(content: string): boolean {
  return /^feedback-smtp\.[a-z0-9-]+\.amazonses\.com$/.test(normHost(content));
}

/**
 * Decide how to bring ONE required record into the zone, given what the zone
 * already holds at that name.
 *
 * ## Why this replaced "create unless an exact copy exists"
 *
 * The writer used to look for a record with the SAME value and, finding none,
 * CREATE one. That is correct exactly once. When a sending domain is
 * registered again — NPC Test's was deleted at Resend on 14 Sep 2026 and has
 * to be re-registered — Resend issues a NEW DKIM key under the SAME selector
 * name, and "create" adds a second TXT record beside the old one. A selector
 * with two keys is one no verifier can use, and the domain would never verify.
 * The same holds for SPF (two `v=spf1` records are a permanent error) and for
 * the bounce MX after a region change.
 *
 * So a record of the SAME KIND at the SAME NAME is this record's stale copy,
 * and is updated in place. Kind is decided by content, not by name: a TXT that
 * is neither DKIM nor SPF is somebody else's and is never touched. And a CNAME
 * behind Cloudflare's proxy is not the CNAME Resend asked for — it resolves to
 * Cloudflare's addresses — so a proxied one is updated too.
 *
 * Nothing here touches a name Resend did not name, and nothing touches a
 * record whose content could belong to anybody else.
 */
export function planDnsRecordSync(
  required: ResendDnsRecord,
  existingAtName: ExistingDnsRecord[],
): DnsSyncStep {
  const name = normHost(required.name);
  const type = required.type.trim().toUpperCase();
  const atName = existingAtName.filter((e) => normHost(e.name) === name);
  const sameType = atName.filter((e) => e.type.trim().toUpperCase() === type);

  if (type === "CNAME") {
    const others = atName.filter((e) => e.type.trim().toUpperCase() !== "CNAME");
    const cname = sameType[0];
    if (!cname) {
      if (others.length > 0) {
        return {
          record: required,
          action: "conflict",
          remove: [],
          detail:
            `${required.name} already holds ${[...new Set(others.map((o) => o.type))].join(", ")} ` +
            "record(s); a CNAME cannot share a name with anything, so nothing was written there",
        };
      }
      return { record: required, action: "create", remove: [] };
    }
    if (normHost(cname.content) !== normHost(required.value)) {
      return {
        record: required,
        action: "update",
        existingId: cname.id,
        reason: "stale_value",
        remove: [],
      };
    }
    if (cname.proxied) {
      return {
        record: required,
        action: "update",
        existingId: cname.id,
        reason: "proxied",
        remove: [],
      };
    }
    return { record: required, action: "keep", existingId: cname.id, remove: [] };
  }

  if (type === "MX") {
    const want = normHost(required.value);
    const exact = sameType.find((e) => normHost(e.content) === want);
    const stale = sameType.filter((e) => e !== exact && isSesFeedbackMx(e.content));
    if (exact) {
      return {
        record: required,
        action: "keep",
        existingId: exact.id,
        remove: stale.map((s) => s.id),
      };
    }
    if (stale.length > 0) {
      return {
        record: required,
        action: "update",
        existingId: stale[0].id,
        reason: "stale_value",
        remove: stale.slice(1).map((s) => s.id),
      };
    }
    return { record: required, action: "create", remove: [] };
  }

  if (type === "TXT") {
    const want = normTxt(required.value);
    const kind = txtKind(want);
    const exact = sameType.find((e) => normTxt(e.content) === want);
    // Same kind, different value: the stale copy of this record. A TXT of
    // another kind is somebody else's and is left alone.
    const contradicting =
      kind === "other" ? [] : sameType.filter((e) => e !== exact && txtKind(e.content) === kind);
    if (exact) {
      return {
        record: required,
        action: "keep",
        existingId: exact.id,
        remove: contradicting.map((c) => c.id),
      };
    }
    if (contradicting.length > 0) {
      return {
        record: required,
        action: "update",
        existingId: contradicting[0].id,
        reason: "stale_value",
        remove: contradicting.slice(1).map((c) => c.id),
      };
    }
    return { record: required, action: "create", remove: [] };
  }

  return {
    record: required,
    action: "conflict",
    remove: [],
    detail: `Unsupported record type ${required.type} for ${required.name}`,
  };
}

export type EmailSweepFacts = {
  identity:
    | (Pick<
        EmailIdentityRow,
        | "resend_domain_id"
        | "domain_status"
        | "key_written_at"
        | "from_address_written_at"
        | "revoked_at"
        | "last_error"
      > & {
        /** Not on `EmailIdentityRow` — the flow does not read it; the sweep does. */
        updated_at: string | null;
      })
    | null;
  /** For the cooling-off window; pass the run's own clock. */
  now: number;
};

export type EmailStartSkip = "already_started" | "backend_not_ready" | "over_limit";

export type EmailStartVerdict = { act: true; why: string } | { act: false; reason: EmailStartSkip };

export type EmailStartFacts = {
  /** Whether this clone already has an identity row of any kind. */
  hasIdentity: boolean;
  /** The scoped key is written INTO the clone's own Supabase project. */
  backendReady: boolean;
  /** How many starts this pass has already spent. */
  startedThisRun: number;
  limit: number;
};

/**
 * Whether to BEGIN a sending identity for a clone that has none.
 *
 * `decideEmailIdentitySweep` below refuses exactly this case — "Nothing has
 * been registered for this clone … not ours to start" — and until now nothing
 * else decided it on a schedule. The deployment drain started one at
 * `syncing_env`, a step reached only by a clone Vercel is building; every
 * manually served clone, which is all of this fleet, was left to an operator
 * pressing a button on the clone page.
 *
 * Three refusals and no more. Note what is NOT among them: a hosting project.
 * That requirement is what confined the whole feature to Vercel-built clones,
 * and the key this registers goes to the clone's Supabase project rather than
 * to its host.
 */
export function decideEmailIdentityStart(facts: EmailStartFacts): EmailStartVerdict {
  // A revoked or half-finished identity is a ROW, so it lands here as
  // `hasIdentity` and belongs to the sweep. This decides the one case the
  // sweep cannot see: no row at all.
  if (facts.hasIdentity) return { act: false, reason: "already_started" };

  // Registering a domain whose key has nowhere to be written leaves an
  // identity that can never finish, and it would be claimed by the sweep on
  // every pass thereafter.
  if (!facts.backendReady) return { act: false, reason: "backend_not_ready" };

  // Bounded per pass: registering a domain is a Resend call, and a fleet-sized
  // first run must not exhaust a worker's budget before it writes anything.
  if (facts.startedThisRun >= facts.limit) return { act: false, reason: "over_limit" };

  return { act: true, why: "no sending identity yet" };
}

export type EmailSweepSkip = "not_started" | "complete" | "cooling_off" | "revoked";

export type EmailSweepVerdict = { act: true; why: string } | { act: false; reason: EmailSweepSkip };

/**
 * How long to leave a failed identity alone. A sweep that retries a permanent
 * refusal every run turns one misconfiguration into hundreds of Resend and
 * Cloudflare calls a day and buries the real errors.
 */
export const EMAIL_SWEEP_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Whether the scheduled drain should carry this identity forward.
 *
 * **The sweep carries a decision forward; it never makes one.** Choosing a
 * sending domain picks a hostname and a region — that is recorded in the ROW,
 * by the operator's button, by provisioning, or by `reconcileEmailIdentities`
 * for a clone that has none. A clone with no row is therefore not this
 * sweep's to begin (`not_started`), and `decideEmailIdentityStart` owns that
 * case.
 *
 * ## A row whose registration FAILED is a decision, not a blank
 *
 * This used to refuse every row without a `resend_domain_id` as "not
 * started", on the theory that registering is a choice the sweep must not
 * make. But the only way a row exists without one is that a registration was
 * ATTEMPTED — `advanceEmailIdentity` writes the row and registers in the same
 * pass — and failed. The hostname and region were already chosen; retrying
 * them chooses nothing.
 *
 * Measured on NPC CRM Independent: its first registration on 19 Sep 2026 hit
 * Resend's plan limit ("You have reached the domain limit of your plan"). The
 * row was left `unprovisioned` with that error, and the drain answered
 * `not_started` for it every five minutes for five days — including after the
 * plan was upgraded — because nothing anywhere would ever try again. A clone
 * provisioned into a transient refusal stayed unable to send mail for good.
 *
 * The retry is paced by the same cooling-off window as every other failure,
 * so a refusal that persists costs one Resend call every half hour, and it is
 * still refused outright for a revoked identity.
 *
 * The drain still runs `provision` mode, which it needs: `refresh` mints
 * nothing, and a drain that polls verification without ever minting the key
 * would close no gap at all.
 */
export function decideEmailIdentitySweep(facts: EmailSweepFacts): EmailSweepVerdict {
  const id = facts.identity;

  // No identity at all: the start pass's decision, not this one's.
  if (!id) return { act: false, reason: "not_started" };

  // Somebody stopped this clone's mail on purpose. Resuming is an operator's
  // decision, exactly as starting one is.
  //
  // `canMintKey` already refuses, so this cannot mint even if it were reached
  // — but a revoked row would otherwise be carried forward on every run,
  // spending a Resend read and a Cloudflare check to be refused at the end,
  // and occupying a slot in this sweep's ordered LIMIT window for ever. The
  // query excludes them too; this is the decision saying why.
  if (id.revoked_at) return { act: false, reason: "revoked" };

  // Both halves of the credential reached the clone. Finished — rotation is a
  // separate, deliberate act.
  //
  // This used to test `key_written_at` alone, which is what let the first
  // clone sit "finished" for days holding a key scoped to a domain its
  // from-header never named. The address is the other half of the same
  // credential, so it is the other half of the finish line — and every
  // identity provisioned before the two were paired reads as unfinished here,
  // which is exactly how the drain repairs them without an operator.
  if (id.key_written_at && id.from_address_written_at) return { act: false, reason: "complete" };

  if (id.last_error && id.updated_at) {
    const since = facts.now - Date.parse(id.updated_at);
    if (Number.isFinite(since) && since >= 0 && since < EMAIL_SWEEP_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }

  // Registered once and refused, or registered and then lost at Resend (the
  // health audit clears the id of a domain Resend no longer holds). Either
  // way the domain was chosen already; see above.
  if (!id.resend_domain_id) {
    return { act: true, why: "sending domain not registered at Resend yet — registering it" };
  }

  if (id.domain_status === "verified") {
    return {
      act: true,
      why: id.key_written_at
        ? "key written, sender address not yet paired with it"
        : "domain verified, key not yet minted",
    };
  }
  return { act: true, why: `domain ${id.domain_status}, polling verification` };
}

/**
 * A key may be minted only for a VERIFIED domain that nobody has revoked.
 *
 * Resend would happily mint one before verification, and every send would then
 * 403 — refusing here converts a confusing runtime failure into a named
 * precondition.
 *
 * The revocation check is here, in the one function every mint crosses, rather
 * than in the drain — because there are THREE callers of `provision` mode and
 * two of them are automated (`email-identity-drain` and the deployment drain's
 * credential arming). Revoking with `deleteDomain: false`, which is what the
 * operator's button sends, leaves a verified domain and no key: the exact
 * shape of an identity waiting to be minted. Both drains read it that way and
 * re-minted, so a deliberate stop was undone within five minutes and the clone
 * was sending again with nobody having asked. Guarding the drain alone would
 * have left the deployment drain doing it on the next redeploy.
 */
export function canMintKey(row: EmailIdentityRow | null): { ok: boolean; reason?: string } {
  if (!row?.resend_domain_id)
    return { ok: false, reason: "The sending domain is not registered at Resend yet" };
  if (row.revoked_at) {
    return {
      ok: false,
      reason:
        "This identity was revoked — resume it explicitly to start sending again. " +
        "Nothing automated may mint a key for a clone somebody deliberately stopped.",
    };
  }
  if (row.domain_status !== "verified") {
    return {
      ok: false,
      reason: `The domain is ${row.domain_status}, not verified — a key minted now could not send`,
    };
  }
  return { ok: true };
}

// ─── Health audit ────────────────────────────────────────────────────

/**
 * How often a FINISHED identity is checked against Resend.
 *
 * The sweep stops at "complete", and until this existed nothing looked at an
 * identity again. NPC Test's domain was deleted at Resend on 14 Sep 2026 to
 * make room under the plan's domain limit; its row still read `verified`, key
 * written, sender written — complete — and the clone's key, scoped to a domain
 * that no longer existed, could send nothing. Ten days, every mail path, and
 * no reading anywhere said so.
 *
 * Hourly because a finished identity changes rarely and the audit reads the
 * whole fleet: two paginated listings from Resend per pass, plus a Cloudflare
 * read per sending name. Each check that finds something wrong acts at once.
 */
export const EMAIL_AUDIT_EVERY_MS = 60 * 60 * 1000;

/**
 * Whether this pass of the five-minute drain is the hour's audit pass.
 *
 * Derived from the clock rather than stored, so it needs no table and no
 * second cron job — `THE_CLONING_ENGINE.md` records six scheduled jobs that
 * were never scheduled at all, and a job of its own is the likeliest way for
 * this check never to run. The window is one drain interval wide, so exactly
 * one pass an hour lands in it.
 */
export function isEmailAuditPass(now: number, drainIntervalMs = 5 * 60 * 1000): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    ((now % EMAIL_AUDIT_EVERY_MS) + EMAIL_AUDIT_EVERY_MS) % EMAIL_AUDIT_EVERY_MS < drainIntervalMs
  );
}

export type EmailHealthFacts = {
  identity: Pick<
    EmailIdentityRow,
    | "resend_domain_id"
    | "resend_key_id"
    | "key_written_at"
    | "from_address_written_at"
    | "revoked_at"
  >;
  /** The domain's status as Resend's listing shows it; null when the listing does not show it. */
  listedDomainStatus: string | null;
  /** Whether the key listing was read to its end — a partial listing proves no absence. */
  keysComplete: boolean;
  /** Whether the identity's key appears in the key listing. */
  keyListed: boolean;
};

export type EmailHealthVerdict =
  | { kind: "not_audited"; reason: "revoked" | "unfinished" }
  | { kind: "healthy" }
  /** Absent from the listing. NOT yet a finding: the caller asks Resend for it by id. */
  | { kind: "domain_unlisted" }
  | { kind: "domain_degraded"; status: string }
  | { kind: "key_missing" };

/**
 * What the hourly audit concludes about one identity.
 *
 * Only a FINISHED identity is audited: an unfinished one is the sweep's, and
 * a revoked one is nobody's. The rules, in order:
 *
 * - **A domain missing from the listing is a question, not an answer.** The
 *   caller confirms it with a read by id, and only Resend's own 404 counts —
 *   a listing that was cut short must never re-register a live domain.
 * - **A domain that is no longer verified is re-driven**, not reported: the
 *   same advance that finished it re-installs DNS and re-checks.
 * - **A key that is not in a COMPLETE listing was deleted at Resend** and is
 *   minted again. An incomplete listing proves nothing, so nothing happens.
 */
export function decideEmailIdentityHealth(f: EmailHealthFacts): EmailHealthVerdict {
  const id = f.identity;
  if (id.revoked_at) return { kind: "not_audited", reason: "revoked" };
  if (!id.resend_domain_id || !id.key_written_at || !id.from_address_written_at) {
    return { kind: "not_audited", reason: "unfinished" };
  }
  if (f.listedDomainStatus === null) return { kind: "domain_unlisted" };
  const status = f.listedDomainStatus.trim().toLowerCase();
  if (status !== "verified" && status !== "partially_verified") {
    return { kind: "domain_degraded", status };
  }
  if (f.keysComplete && id.resend_key_id && !f.keyListed) return { kind: "key_missing" };
  return { kind: "healthy" };
}

/**
 * The row once Resend no longer holds the identity's domain: back to
 * registration, with DNS owed again so the new DKIM key replaces the old one.
 *
 * `resend_key_id` is deliberately KEPT while `key_written_at` is cleared. The
 * old key is scoped to a domain that no longer exists and can send nothing,
 * but it is still the one on the clone — so it is retired only after the
 * replacement has been written there, exactly as a rotation does it.
 */
export function vanishedDomainPatch() {
  return {
    resend_domain_id: null,
    domain_status: "unprovisioned" as const,
    dns_records: [] as ResendDnsRecord[],
    dns_installed_via: null,
    key_last4: null,
    key_written_at: null,
    from_address_written_at: null,
    last_error: null,
  };
}

/**
 * The row once its key is gone from Resend: nothing left to retire, so the
 * id goes too, and the key and its address are owed again as one credential.
 */
export function missingKeyPatch() {
  return {
    resend_key_id: null,
    key_last4: null,
    key_written_at: null,
    from_address_written_at: null,
    last_error: null,
  };
}

/**
 * Whether a key must be minted: none exists, or one exists that has not
 * reached the clone (the audit's vanished-domain reset leaves exactly that —
 * see `vanishedDomainPatch`). Whether one MAY be minted is `canMintKey`.
 */
export function keyOwed(row: Pick<EmailIdentityRow, "resend_key_id" | "key_written_at">): boolean {
  return !row.resend_key_id || !row.key_written_at;
}

// ─── Ledger vocabulary ───────────────────────────────────────────────

/**
 * Map a provisioning shell status onto the operator ledger's vocabulary.
 *
 * `clone_backend_secrets.status` is CHECK-constrained to
 * `missing | set | failed | inherited | authorised_no_value | withheld`,
 * while the planner also says
 * `generated`, `derived`, `skipped_platform` and `skipped_deployment_config`.
 * The provisioning ledger upsert used to write the planner's words straight
 * into the column — one `generated` row violated the constraint, Postgres
 * refused the WHOLE statement, the error was discarded, and every clone's
 * secret ledger stayed empty while the UI read "no secrets". This mapping is
 * the fix: `generated`/`derived` were set (by us), the skipped kinds are not
 * operator-facing and store as null, meaning "write no row".
 */
export function ledgerStatusForShell(
  status: SecretShellStatus,
): "missing" | "set" | "failed" | "inherited" | "authorised_no_value" | "withheld" | null {
  switch (status) {
    case "missing":
    case "set":
    case "failed":
    case "inherited":
      return status;
    case "generated":
    case "derived":
      return "set";
    case "skipped_platform":
    case "skipped_deployment_config":
      return null;
    // Operator-facing on purpose: a clone whose CAPTCHA secret has not been
    // minted yet must SHOW as missing, because until it is the login either
    // has no CAPTCHA at all or refuses everyone.
    case "tenant_scoped_pending":
      return "missing";
    // Its own reading, and its own remedy: the forward was authorised and
    // Mission Control holds no value, so the fix is on Mission Control rather
    // than on the clone. Reported as `missing` this was indistinguishable
    // from a name nobody authorised — see the migration that widened the
    // column to accept it.
    case "authorised_no_value":
      return "authorised_no_value";
    // Mission Control brokers this credential, so the clone is not owed it and
    // never will be. NOT `missing`: that word means owed, and it would have the
    // drift report and every reconcile sweep trying to deliver a credential the
    // broker exists to keep off a tenant.
    case "withheld":
      return "withheld";
  }
}

// ─── Sender alignment ────────────────────────────────────────────────

/**
 * Whether Mission Control may write the clone's brand-config sender address.
 *
 * The clone's `global_report_settings.contact_details.email` drives BOTH the
 * displayed contact address and every from-header, so overwriting it is a
 * tenant-visible change. The rule: repair a default, never override a
 * choice. An empty value or one still on the prime's legacy domain is the
 * un-made choice this flow may fill in; anything else belongs to the tenant.
 */
export function mayAlignSenderAddress(
  currentEmail: string | null | undefined,
  primeLegacyDomains: string[] = ["npcservices.com.au"],
): boolean {
  const cur = (currentEmail ?? "").trim().toLowerCase();
  if (cur.length === 0) return true;
  const at = cur.lastIndexOf("@");
  if (at < 0) return true; // not an address — a repair, not an override
  const domain = cur.slice(at + 1);
  return primeLegacyDomains.some((d) => domain === d.toLowerCase());
}
