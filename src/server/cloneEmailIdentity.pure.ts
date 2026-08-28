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

export type EmailIdentityStepId = "master_key" | "domain" | "dns" | "verified" | "key_written";

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
      ? "DNS records written to the clone's Cloudflare zone"
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

  const next = steps.find((s) => s.state === "open")?.id ?? null;
  return { steps, next, live: next === null };
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
