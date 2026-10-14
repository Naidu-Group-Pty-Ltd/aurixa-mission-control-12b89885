/**
 * Whether a sending domain is set up to be believed: SPF, DKIM, DMARC and MX,
 * read from public DNS and judged for a Microsoft 365 sender.
 *
 * Warmup earns a mailbox a reputation; authentication is what lets a receiver
 * attach that reputation to the domain at all. Mail that fails it is junked
 * or refused whatever its history, and since 2024 Gmail and Yahoo — and since
 * 2025 Outlook.com — expect SPF, DKIM and a DMARC record from anyone sending
 * in volume. None of it is visible from inside Microsoft 365: a tenant sends
 * perfectly well with no DKIM and no DMARC, and the cost only shows up as
 * placement. So it is checked here, from DNS, the way a receiver sees it.
 *
 * Pure: the answers arrive as arguments (`dns.server.ts` fetches them), so
 * every verdict below is tested against real records.
 *
 * What DNS cannot show, and is said so rather than guessed:
 *
 * - **Whether DKIM signing is switched ON.** Microsoft 365 needs the two
 *   selector CNAMEs published AND signing enabled in Microsoft Defender; DNS
 *   shows only the first.
 * - **What SPF's includes expand to.** Their own lookups count towards SPF's
 *   limit of ten; only the top level is counted here.
 */

/** One answer from a DNS-over-HTTPS JSON response. `type`: 1 A, 5 CNAME, 15 MX, 16 TXT, 28 AAAA. */
export type DnsAnswer = { name?: string; type: number; data: string };

/**
 * A DNS lookup's outcome. `rcode` 0 is NOERROR (possibly with no answers), 3
 * is NXDOMAIN — the name does not exist. `error` is a lookup that did not
 * complete, which says nothing about the record.
 */
export type DnsLookup =
  | { ok: true; rcode: number; answers: DnsAnswer[] }
  | { ok: false; error: string };

export type CheckName = "spf" | "dkim" | "dmarc" | "mx";
/** `unknown` is a lookup that failed: no evidence either way. */
export type Severity = "ok" | "warn" | "bad" | "unknown";

export type AuthFinding = {
  check: CheckName;
  severity: Severity;
  /** What is true, in a sentence. */
  summary: string;
  /** What to change, or null when nothing needs to. */
  fix: string | null;
  /** The record as published, when there is one. */
  record: string | null;
};

export type DomainAuthReport = {
  domain: string;
  checkedAt: string;
  verdict: Severity;
  findings: AuthFinding[];
};

/** Microsoft 365's SPF include. */
export const MICROSOFT_SPF_INCLUDE = "spf.protection.outlook.com";
/** SPF allows ten DNS-querying terms; more is a permanent error at the receiver. */
const SPF_LOOKUP_LIMIT = 10;

/** The domain part of an address, lowercased, or null. */
export function domainOf(address: string | null | undefined): string | null {
  const at = String(address ?? "")
    .trim()
    .lastIndexOf("@");
  if (at < 1) return null;
  const domain = String(address)
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

/**
 * A TXT record's text. DNS-over-HTTPS returns it quoted, and a long record as
 * several quoted strings that a receiver reads joined with nothing between.
 */
export function txtValue(data: string): string {
  const chunks = String(data ?? "").match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return String(data ?? "").trim();
  return chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

function txtRecords(lookup: DnsLookup): string[] {
  if (!lookup.ok) return [];
  return lookup.answers.filter((a) => a.type === 16).map((a) => txtValue(a.data));
}

const unknown = (check: CheckName, what: string, lookup: DnsLookup): AuthFinding => ({
  check,
  severity: "unknown",
  summary: `${what} could not be looked up just now (${lookup.ok ? "no answer" : lookup.error})`,
  fix: null,
  record: null,
});

// ── SPF ──────────────────────────────────────────────────────────────────────

export function judgeSpf(domain: string, lookup: DnsLookup): AuthFinding {
  if (!lookup.ok) return unknown("spf", "SPF", lookup);
  const records = txtRecords(lookup).filter((txt) => /^v=spf1(\s|$)/i.test(txt.trim()));
  const fixRecord = `v=spf1 include:${MICROSOFT_SPF_INCLUDE} -all`;
  if (records.length === 0) {
    return {
      check: "spf",
      severity: "bad",
      summary: "no SPF record — receivers cannot tell that Microsoft 365 may send for this domain",
      fix: `Publish a TXT record on ${domain}: ${fixRecord}`,
      record: null,
    };
  }
  if (records.length > 1) {
    return {
      check: "spf",
      severity: "bad",
      summary: `${records.length} SPF records — more than one is a permanent error, so SPF fails for every message`,
      fix: `Merge them into one TXT record on ${domain} that includes ${MICROSOFT_SPF_INCLUDE}`,
      record: records.join(" | "),
    };
  }
  const record = records[0].trim();
  const terms = record.split(/\s+/).slice(1);
  const lower = terms.map((term) => term.toLowerCase());
  if (!lower.some((term) => term.replace(/^[+?~-]/, "") === `include:${MICROSOFT_SPF_INCLUDE}`)) {
    return {
      check: "spf",
      severity: "bad",
      summary: "SPF does not authorise Microsoft 365, so mail sent from these mailboxes fails it",
      fix: `Add include:${MICROSOFT_SPF_INCLUDE} to the SPF record on ${domain}`,
      record,
    };
  }
  const all = lower.find((term) => /^[+?~-]?all$/.test(term));
  if (all === "+all" || all === "all") {
    return {
      check: "spf",
      severity: "bad",
      summary:
        "SPF ends in +all, which authorises every server on the internet to send as this domain",
      fix: "End the SPF record with -all (or ~all) instead",
      record,
    };
  }
  // Mechanisms and modifiers that cost a DNS lookup at the receiver.
  const lookups = lower.filter((term) =>
    /^[+?~-]?(include:|a($|[:/])|mx($|[:/])|ptr|exists:)|^redirect=/.test(term),
  ).length;
  if (lookups > SPF_LOOKUP_LIMIT) {
    return {
      check: "spf",
      severity: "bad",
      summary: `SPF needs at least ${lookups} DNS lookups; receivers stop at ${SPF_LOOKUP_LIMIT} and fail it`,
      fix: "Remove includes for services that no longer send for this domain",
      record,
    };
  }
  if (!all || all === "?all") {
    return {
      check: "spf",
      severity: "warn",
      summary:
        "SPF authorises Microsoft 365 but ends neutral, so it does not say other senders are not allowed",
      fix: "End the SPF record with -all (or ~all)",
      record,
    };
  }
  return {
    check: "spf",
    severity: "ok",
    summary: `authorises Microsoft 365 (${all})${lookups > 1 ? `, with ${lookups} includes or lookups at the top level` : ""}`,
    fix: null,
    record,
  };
}

// ── DKIM ─────────────────────────────────────────────────────────────────────

/**
 * Microsoft 365 publishes DKIM as two CNAMEs, `selector1._domainkey` and
 * `selector2._domainkey`, pointing into Microsoft (the older
 * `….onmicrosoft.com` form or the newer `….dkim.mail.microsoft`). Both are
 * needed: Microsoft rotates between them, and a missing second selector breaks
 * signing at the first rotation.
 */
export function judgeDkim(domain: string, selector1: DnsLookup, selector2: DnsLookup): AuthFinding {
  const target = (lookup: DnsLookup) =>
    lookup.ok
      ? (lookup.answers.find((a) => a.type === 5 || a.type === 16)?.data ?? null)
      : undefined;
  const one = target(selector1);
  const two = target(selector2);
  if (one === undefined && two === undefined) {
    return unknown("dkim", "DKIM", selector1.ok ? selector2 : selector1);
  }
  const fix =
    "In Microsoft Defender → Email & collaboration → Policies → Email authentication settings → DKIM, choose this domain, publish the two CNAME records it shows, then enable signing";
  if (!one && !two) {
    return {
      check: "dkim",
      severity: "bad",
      summary:
        "no DKIM selectors are published — Microsoft 365 signs this domain's mail as its onmicrosoft.com domain instead, which DMARC does not accept as this domain",
      fix,
      record: null,
    };
  }
  if (!one || !two) {
    return {
      check: "dkim",
      severity: "warn",
      summary: `only ${one ? "selector1" : "selector2"} is published — signing breaks when Microsoft rotates to the other`,
      fix,
      record: (one ?? two ?? "").replace(/\.$/, ""),
    };
  }
  return {
    check: "dkim",
    severity: "ok",
    summary:
      "both Microsoft 365 selectors are published (DNS cannot show whether signing is switched on — Microsoft Defender's DKIM page does)",
    fix: null,
    record: `selector1 → ${one.replace(/\.$/, "")}; selector2 → ${two.replace(/\.$/, "")}`,
  };
}

// ── DMARC ────────────────────────────────────────────────────────────────────

/** `v=DMARC1; p=none; rua=mailto:x` → `{ v: "DMARC1", p: "none", rua: "mailto:x" }`, keys lowercased. */
export function dmarcTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    tags[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return tags;
}

export function judgeDmarc(domain: string, lookup: DnsLookup): AuthFinding {
  if (!lookup.ok) return unknown("dmarc", "DMARC", lookup);
  const records = txtRecords(lookup).filter((txt) => /^v=DMARC1\s*(;|$)/i.test(txt.trim()));
  const starter = `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}`;
  if (records.length === 0) {
    return {
      check: "dmarc",
      severity: "bad",
      summary:
        "no DMARC record — Gmail, Yahoo and Outlook.com expect one from anyone sending in volume, and without it anybody can send as this domain unchallenged",
      fix: `Publish a TXT record on _dmarc.${domain}: ${starter}`,
      record: null,
    };
  }
  if (records.length > 1) {
    return {
      check: "dmarc",
      severity: "bad",
      summary: `${records.length} DMARC records — receivers ignore DMARC entirely when there is more than one`,
      fix: `Keep exactly one TXT record on _dmarc.${domain}`,
      record: records.join(" | "),
    };
  }
  const record = records[0].trim();
  const tags = dmarcTags(record);
  const policy = (tags.p ?? "").toLowerCase();
  if (!["none", "quarantine", "reject"].includes(policy)) {
    return {
      check: "dmarc",
      severity: "bad",
      summary:
        "the DMARC record has no valid policy (p=none, quarantine or reject), so receivers ignore it",
      fix: `Replace it with: ${starter}`,
      record,
    };
  }
  if (!tags.rua) {
    return {
      check: "dmarc",
      severity: "warn",
      summary: `p=${policy} with no reporting address — nobody is told when mail claiming to be this domain fails authentication`,
      fix: `Add rua=mailto:dmarc-reports@${domain} (or a DMARC reporting service's address) to the record on _dmarc.${domain}`,
      record,
    };
  }
  return {
    check: "dmarc",
    severity: "ok",
    summary:
      policy === "none"
        ? "p=none, with reports — meets mailbox providers' requirement; move to quarantine once the reports show only your own mail"
        : `p=${policy}, with reports`,
    fix: null,
    record,
  };
}

// ── MX ───────────────────────────────────────────────────────────────────────

export function judgeMx(domain: string, lookup: DnsLookup): AuthFinding {
  if (!lookup.ok) return unknown("mx", "MX", lookup);
  const hosts = lookup.answers
    .filter((a) => a.type === 15)
    .map((a) => a.data.trim().split(/\s+/).pop()?.replace(/\.$/, "") ?? "")
    .filter(Boolean);
  if (hosts.length === 0 || hosts.every((host) => host === "" || host === ".")) {
    return {
      check: "mx",
      severity: "bad",
      summary:
        "this domain publishes no mail server — replies and bounces cannot reach it, and many receivers distrust mail from a domain that cannot receive any",
      fix: `Publish the MX record Microsoft 365 shows for ${domain} in the admin centre's Domains page`,
      record: null,
    };
  }
  const microsoft = hosts.some((host) => host.endsWith(".mail.protection.outlook.com"));
  return {
    check: "mx",
    severity: "ok",
    summary: microsoft ? "receives mail in Microsoft 365" : `receives mail at ${hosts[0]}`,
    fix: null,
    record: hosts.join(", "),
  };
}

// ── Together ─────────────────────────────────────────────────────────────────

const RANK: Record<Severity, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 };

/** The worst severity among findings. */
export function worstOf(findings: { severity: Severity }[]): Severity {
  return findings.reduce<Severity>(
    (worst, finding) => (RANK[finding.severity] > RANK[worst] ? finding.severity : worst),
    "ok",
  );
}

export function judgeDomain(input: {
  domain: string;
  checkedAt: string;
  spf: DnsLookup;
  dmarc: DnsLookup;
  dkim1: DnsLookup;
  dkim2: DnsLookup;
  mx: DnsLookup;
}): DomainAuthReport {
  const findings = [
    judgeSpf(input.domain, input.spf),
    judgeDkim(input.domain, input.dkim1, input.dkim2),
    judgeDmarc(input.domain, input.dmarc),
    judgeMx(input.domain, input.mx),
  ];
  return { domain: input.domain, checkedAt: input.checkedAt, verdict: worstOf(findings), findings };
}

// ── Does a recipient's domain take mail at all? ───────────────────────────────

/** `yes`, `no`, or `unknown` when DNS could not be asked. */
export type MailDomainVerdict = { accepts: "yes" | "no" | "unknown"; detail: string };

/**
 * Whether mail to a domain can be delivered at all: it exists, and has an MX
 * — or, with none, an address record, which RFC 5321 treats as an implicit
 * MX. A "null MX" (`0 .`, RFC 7505) is the domain saying it takes no mail.
 *
 * Every failure to ask is `unknown`, never `no`: a resolver that timed out is
 * no evidence that a customer's domain is dead.
 */
export function judgeMailDomain(mx: DnsLookup, address: DnsLookup | null): MailDomainVerdict {
  if (!mx.ok) return { accepts: "unknown", detail: `MX lookup failed: ${mx.error}` };
  if (mx.rcode === 3) return { accepts: "no", detail: "the domain does not exist" };
  if (mx.rcode !== 0) return { accepts: "unknown", detail: `MX lookup answered rcode ${mx.rcode}` };
  const hosts = mx.answers
    .filter((a) => a.type === 15)
    .map((a) => a.data.trim().split(/\s+/).pop() ?? "");
  if (hosts.length > 0) {
    if (hosts.every((host) => host === "." || host === "")) {
      return { accepts: "no", detail: "the domain publishes a null MX: it accepts no mail" };
    }
    return { accepts: "yes", detail: "has a mail server" };
  }
  if (!address) return { accepts: "unknown", detail: "no MX; address not checked" };
  if (!address.ok) return { accepts: "unknown", detail: `address lookup failed: ${address.error}` };
  if (address.answers.some((a) => a.type === 1 || a.type === 28)) {
    return { accepts: "yes", detail: "no MX, but an address record, which serves as one" };
  }
  return { accepts: "no", detail: "the domain has no mail server" };
}

const CHECK_LABELS: Record<CheckName, string> = {
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  mx: "MX",
};

/**
 * A report's problems as readiness warnings, worst first: one sentence each,
 * what is wrong and what to change. A lookup that failed says nothing here —
 * it is not a problem with the domain.
 */
export function authWarnings(report: DomainAuthReport): string[] {
  const rank: Record<Severity, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  return report.findings
    .filter((finding) => finding.severity === "bad" || finding.severity === "warn")
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .map(
      (finding) =>
        `${report.domain} ${CHECK_LABELS[finding.check]}: ${finding.summary}${finding.fix ? ` — ${finding.fix}` : ""}`,
    );
}
