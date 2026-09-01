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
 * The distinct (name, type) lookups that decide whether Resend's records are
 * visible in DNS yet.
 *
 * Resend answers with two records on the same name — an MX and a TXT for SPF —
 * so a naive walk asks the same question twice. Values are deliberately NOT
 * compared: Resend is the authority on whether its own DKIM key matches, and
 * re-implementing that here would mean re-implementing TXT chunk joining and
 * getting it subtly wrong. All this needs to know is whether the name exists,
 * because that is what a negative cache poisons.
 */
export function expectedDnsProbes(records: ResendDnsRecord[]): DnsProbe[] {
  const seen = new Set<string>();
  const probes: DnsProbe[] = [];
  for (const r of records) {
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

export type EmailSweepFacts = {
  identity:
    | (Pick<
        EmailIdentityRow,
        | "resend_domain_id"
        | "domain_status"
        | "key_written_at"
        | "from_address_written_at"
        | "last_error"
      > & {
        /** Not on `EmailIdentityRow` — the flow does not read it; the sweep does. */
        updated_at: string | null;
      })
    | null;
  /** For the cooling-off window; pass the run's own clock. */
  now: number;
};

export type EmailSweepSkip = "not_started" | "complete" | "cooling_off";

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
 * **The drain ADVANCES an identity; it never STARTS one.** Registering a
 * sending domain picks a hostname and a region and creates a resource at
 * Resend — an operator's decision, not a sweep's. A sweep that started them
 * would register a domain for every clone that lacks one, at the moment the
 * feature was switched on.
 *
 * That rule is enforced structurally rather than by care: the drain acts only
 * on a row that ALREADY has `resend_domain_id`, and `advanceEmailIdentity`
 * creates a domain only when that field is null. So the skip below is what
 * makes it safe to hand the drain the same `provision` mode the operator's
 * button uses — which it needs, because `refresh` deliberately mints nothing,
 * and a drain that polls verification forever without ever minting the key is
 * exactly the gap this exists to close.
 */
export function decideEmailIdentitySweep(facts: EmailSweepFacts): EmailSweepVerdict {
  const id = facts.identity;

  // Nothing has been registered for this clone. See above: not ours to start.
  if (!id?.resend_domain_id) return { act: false, reason: "not_started" };

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
 * A key may be minted only for a VERIFIED domain. Resend would happily mint
 * one earlier, and every send would then 403 — refusing here converts a
 * confusing runtime failure into a named precondition.
 */
export function canMintKey(row: EmailIdentityRow | null): { ok: boolean; reason?: string } {
  if (!row?.resend_domain_id)
    return { ok: false, reason: "The sending domain is not registered at Resend yet" };
  if (row.domain_status !== "verified") {
    return {
      ok: false,
      reason: `The domain is ${row.domain_status}, not verified — a key minted now could not send`,
    };
  }
  return { ok: true };
}

// ─── Ledger vocabulary ───────────────────────────────────────────────

/**
 * Map a provisioning shell status onto the operator ledger's vocabulary.
 *
 * `clone_backend_secrets.status` is CHECK-constrained to
 * `missing | set | failed | inherited`, while the planner also says
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
): "missing" | "set" | "failed" | "inherited" | null {
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
