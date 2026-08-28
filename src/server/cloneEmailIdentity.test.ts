import { describe, it, expect } from "vitest";
import {
  canMintKey,
  deriveFromAddress,
  deriveSendingDomain,
  identityReadiness,
  isValidSendingDomain,
  keyLast4,
  ledgerStatusForShell,
  mayAlignSenderAddress,
  planDnsInstallation,
  type EmailIdentityRow,
} from "./cloneEmailIdentity.pure";
import type { ResendDnsRecord } from "./resend-client";

const row = (over: Partial<EmailIdentityRow> = {}): EmailIdentityRow => ({
  id: "i-1",
  clone_id: "c-1",
  sending_domain: "send.npc.aurixasystems.com.au",
  region: "us-east-1",
  resend_domain_id: null,
  domain_status: "unprovisioned",
  dns_records: [],
  dns_installed_via: null,
  resend_key_id: null,
  key_last4: null,
  key_written_at: null,
  default_from_address: null,
  last_error: null,
  ...over,
});

describe("deriveSendingDomain", () => {
  it("prefers the clone's own fqdn, under a send. subdomain", () => {
    expect(
      deriveSendingDomain({
        slug: "npc",
        subdomain_fqdn: "npc.aurixasystems.com.au",
        deploy_url: "https://npc-client.vercel.app",
      }),
    ).toBe("send.npc.aurixasystems.com.au");
  });

  it("falls back to the deploy URL's host", () => {
    expect(
      deriveSendingDomain({
        slug: "npc",
        subdomain_fqdn: null,
        deploy_url: "https://npc.example.com/x",
      }),
    ).toBe("send.npc.example.com");
  });

  it("never proposes a vercel.app host — Resend could not verify it", () => {
    expect(
      deriveSendingDomain({
        slug: "npc",
        subdomain_fqdn: null,
        deploy_url: "https://npc.vercel.app",
      }),
    ).toBeNull();
  });

  it("refuses to guess when the clone has no host at all", () => {
    expect(deriveSendingDomain({ slug: "npc", subdomain_fqdn: null, deploy_url: null })).toBeNull();
  });
});

describe("sending domain and address shapes", () => {
  it("accepts hostnames and refuses everything else", () => {
    expect(isValidSendingDomain("send.npc.aurixasystems.com.au")).toBe(true);
    expect(isValidSendingDomain("https://send.npc.com")).toBe(false);
    expect(isValidSendingDomain("no-dots")).toBe(false);
    expect(isValidSendingDomain("bad domain.com")).toBe(false);
  });

  it("builds the notifications address on the sending domain", () => {
    expect(deriveFromAddress("Send.NPC.Example.COM")).toBe("notifications@send.npc.example.com");
  });

  it("keeps only the last four characters of a token", () => {
    expect(keyLast4("re_abc123XYZ9")).toBe("XYZ9");
  });
});

describe("planDnsInstallation", () => {
  const records: ResendDnsRecord[] = [
    { record: "SPF", name: "send.npc.aurixasystems.com.au", type: "TXT", value: "v=spf1 …" },
    {
      record: "SPF",
      name: "send.npc.aurixasystems.com.au",
      type: "MX",
      value: "feedback-smtp…",
      priority: 10,
    },
    {
      record: "DKIM",
      name: "resend._domainkey.send.npc.aurixasystems.com.au",
      type: "TXT",
      value: "p=…",
    },
  ];

  it("auto-installs only names inside the clone's zone", () => {
    const plan = planDnsInstallation(records, "aurixasystems.com.au");
    expect(plan.auto).toHaveLength(3);
    expect(plan.manual).toHaveLength(0);
  });

  it("hands everything to the operator when there is no zone", () => {
    const plan = planDnsInstallation(records, null);
    expect(plan.auto).toHaveLength(0);
    expect(plan.manual).toHaveLength(3);
  });

  it("does not treat a suffix collision as zone membership", () => {
    // `evilaurixasystems.com.au` ends with the zone STRING but is not in it.
    const plan = planDnsInstallation(
      [{ record: "SPF", name: "send.evilaurixasystems.com.au", type: "TXT", value: "x" }],
      "aurixasystems.com.au",
    );
    expect(plan.auto).toHaveLength(0);
    expect(plan.manual).toHaveLength(1);
  });
});

describe("identityReadiness", () => {
  it("opens on the master key before anything else", () => {
    const r = identityReadiness(null, { resendConfigured: false });
    expect(r.next).toBe("master_key");
    expect(r.live).toBe(false);
    // Exactly one open step; the rest are blocked behind it.
    expect(r.steps.filter((s) => s.state === "open")).toHaveLength(1);
  });

  it("walks domain → dns → verified → key in order", () => {
    expect(identityReadiness(row(), { resendConfigured: true }).next).toBe("domain");
    expect(
      identityReadiness(row({ resend_domain_id: "d-1" }), { resendConfigured: true }).next,
    ).toBe("dns");
    expect(
      identityReadiness(
        row({ resend_domain_id: "d-1", dns_installed_via: "manual", domain_status: "pending_dns" }),
        { resendConfigured: true },
      ).next,
    ).toBe("verified");
    expect(
      identityReadiness(
        row({
          resend_domain_id: "d-1",
          dns_installed_via: "cloudflare",
          domain_status: "verified",
        }),
        { resendConfigured: true },
      ).next,
    ).toBe("key_written");
  });

  it("is live only when the key has been written to the clone", () => {
    const r = identityReadiness(
      row({
        resend_domain_id: "d-1",
        dns_installed_via: "cloudflare",
        domain_status: "verified",
        resend_key_id: "k-1",
        key_last4: "XYZ9",
        key_written_at: "2026-08-28T10:00:00Z",
      }),
      { resendConfigured: true },
    );
    expect(r.live).toBe(true);
    expect(r.next).toBeNull();
  });
});

describe("canMintKey", () => {
  it("refuses before the domain exists, with the reason", () => {
    const v = canMintKey(row());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not registered/);
  });

  it("refuses an unverified domain — a key minted now could not send", () => {
    const v = canMintKey(row({ resend_domain_id: "d-1", domain_status: "pending_dns" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/pending_dns/);
  });

  it("permits a verified domain", () => {
    expect(canMintKey(row({ resend_domain_id: "d-1", domain_status: "verified" })).ok).toBe(true);
  });
});

describe("ledgerStatusForShell", () => {
  it("passes the ledger's own vocabulary through", () => {
    expect(ledgerStatusForShell("missing")).toBe("missing");
    expect(ledgerStatusForShell("set")).toBe("set");
    expect(ledgerStatusForShell("failed")).toBe("failed");
    expect(ledgerStatusForShell("inherited")).toBe("inherited");
  });

  it("records generated and derived secrets as set — they were, by us", () => {
    expect(ledgerStatusForShell("generated")).toBe("set");
    expect(ledgerStatusForShell("derived")).toBe("set");
  });

  it("stores no row for the skipped kinds — they are not operator-facing", () => {
    expect(ledgerStatusForShell("skipped_platform")).toBeNull();
    expect(ledgerStatusForShell("skipped_deployment_config")).toBeNull();
  });

  it("never emits a value the column's CHECK constraint refuses", () => {
    const allowed = new Set(["missing", "set", "failed", "inherited"]);
    const all = [
      "set",
      "missing",
      "failed",
      "inherited",
      "generated",
      "skipped_platform",
      "skipped_deployment_config",
      "derived",
    ] as const;
    for (const s of all) {
      const mapped = ledgerStatusForShell(s);
      if (mapped !== null) expect(allowed.has(mapped)).toBe(true);
    }
  });
});

describe("mayAlignSenderAddress", () => {
  it("repairs an empty value", () => {
    expect(mayAlignSenderAddress(null)).toBe(true);
    expect(mayAlignSenderAddress("  ")).toBe(true);
  });

  it("repairs the prime's legacy domain — an un-made choice", () => {
    expect(mayAlignSenderAddress("admin@npcservices.com.au")).toBe(true);
  });

  it("never overrides a tenant's own configured domain", () => {
    expect(mayAlignSenderAddress("hello@tenant-brand.com.au")).toBe(false);
  });
});
