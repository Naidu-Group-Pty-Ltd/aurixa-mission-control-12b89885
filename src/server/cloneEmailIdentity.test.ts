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
  absoluteRecordName,
  decideEmailIdentitySweep,
  EMAIL_SWEEP_COOLDOWN_MS,
  planDnsInstallation,
  resolveEmailDnsZone,
  withAbsoluteRecordNames,
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

describe("absoluteRecordName", () => {
  // Verbatim from the first live provisioning run: Resend answered with these
  // three names for sending domain send.npc.aurixasystems.com.au, and all
  // three were handed to the operator because none ends with the zone.
  const S = "send.npc.aurixasystems.com.au";

  it("restores the registrable domain Resend strips", () => {
    expect(absoluteRecordName("resend._domainkey.send.npc", S)).toBe(
      "resend._domainkey.send.npc.aurixasystems.com.au",
    );
    expect(absoluteRecordName("send.send.npc", S)).toBe("send.send.npc.aurixasystems.com.au");
  });

  it("leaves an already fully-qualified name alone", () => {
    expect(absoluteRecordName(S, S)).toBe(S);
    expect(absoluteRecordName(`resend._domainkey.${S}`, S)).toBe(`resend._domainkey.${S}`);
  });

  it("resolves a bare relative apex to the sending domain itself", () => {
    expect(absoluteRecordName("send.npc", S)).toBe(S);
  });

  it("takes the LONGEST overlap, not the first plausible one", () => {
    // A single trailing `send` label also matches the sending domain's first
    // label; appending from there would produce
    // send.send.npc.npc.aurixasystems.com.au — a real record in the wrong place.
    expect(absoluteRecordName("send.send.npc", S)).toBe("send.send.npc.aurixasystems.com.au");
  });

  it("tolerates a trailing dot and mixed case", () => {
    expect(absoluteRecordName("Send.Send.NPC.", S)).toBe("send.send.npc.aurixasystems.com.au");
  });

  it("refuses a name that shares nothing with the sending domain", () => {
    // Fail closed: an unresolvable name is the operator's to install, never
    // something to write into a zone on a guess.
    expect(absoluteRecordName("mail.example.org", S)).toBeNull();
    expect(absoluteRecordName("", S)).toBeNull();
  });

  it("makes the records land inside the zone, which is the whole point", () => {
    const raw: ResendDnsRecord[] = [
      { record: "DKIM", name: "resend._domainkey.send.npc", type: "TXT", value: "p=..." },
      { record: "SPF", name: "send.send.npc", type: "MX", value: "feedback", priority: 10 },
      { record: "SPF", name: "send.send.npc", type: "TXT", value: "v=spf1" },
    ];
    const plan = planDnsInstallation(withAbsoluteRecordNames(raw, S), "aurixasystems.com.au");
    expect(plan.auto).toHaveLength(3);
    expect(plan.manual).toHaveLength(0);
  });

  it("without the rewrite every record is handed over — the measured defect", () => {
    const raw: ResendDnsRecord[] = [
      { record: "DKIM", name: "resend._domainkey.send.npc", type: "TXT", value: "p=..." },
      { record: "SPF", name: "send.send.npc", type: "MX", value: "feedback", priority: 10 },
    ];
    const plan = planDnsInstallation(raw, "aurixasystems.com.au");
    expect(plan.auto).toHaveLength(0);
    expect(plan.manual).toHaveLength(2);
  });

  it("leaves an unresolvable name untouched rather than dropping it", () => {
    const raw: ResendDnsRecord[] = [
      { record: "X", name: "mail.example.org", type: "TXT", value: "v" },
    ];
    expect(withAbsoluteRecordNames(raw, S)[0].name).toBe("mail.example.org");
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

describe("resolveEmailDnsZone", () => {
  const FLEET = {
    fleetZoneId: "34f9a6100c3f7074e4feda43975a9c10",
    fleetZoneName: "aurixasystems.com.au",
  };

  it("falls back to the fleet zone when no edge provider is attached to the clone", () => {
    // The regression this exists for: `cloudflare_enabled` is the WAF/CDN
    // wrapper attachment, which is false on every clone in the fleet, so the
    // default sending domain's records were handed to an operator to install
    // by hand into a zone Mission Control writes to routinely.
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: false,
      cloneZoneId: null,
      ...FLEET,
    });
    expect(zone).toEqual({
      zoneId: FLEET.fleetZoneId,
      zoneName: "aurixasystems.com.au",
      source: "fleet",
    });
  });

  it("prefers the clone's own zone when one is genuinely attached", () => {
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: true,
      cloneZoneId: "clone-zone",
      ...FLEET,
    });
    expect(zone).toEqual({ zoneId: "clone-zone", zoneName: null, source: "clone" });
  });

  it("ignores a stale zone id when the attachment flag is off", () => {
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: false,
      cloneZoneId: "stale-zone",
      ...FLEET,
    });
    expect(zone?.source).toBe("fleet");
  });

  it("resolves to nothing when neither a clone zone nor a fleet zone exists", () => {
    expect(
      resolveEmailDnsZone({
        cloneCloudflareEnabled: false,
        cloneZoneId: null,
        fleetZoneId: null,
        fleetZoneName: null,
      }),
    ).toBeNull();
  });

  it("treats a blank fleet zone name as unknown rather than as an empty zone", () => {
    // An empty string would match nothing in planDnsInstallation's suffix
    // test, which is right, but null says "ask Cloudflare" and is honest.
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: false,
      cloneZoneId: null,
      fleetZoneId: "z",
      fleetZoneName: "   ",
    });
    expect(zone).toEqual({ zoneId: "z", zoneName: null, source: "fleet" });
  });

  it("resolving a zone is candidacy, not licence — containment still decides", () => {
    // A tenant-owned sending domain resolves to the fleet zone and then
    // installs nothing, because none of its records sit inside it. This is
    // the property that makes the fleet fallback safe.
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: false,
      cloneZoneId: null,
      ...FLEET,
    });
    const tenantRecords: ResendDnsRecord[] = [
      { record: "DKIM", name: "resend._domainkey.send.tenant.example", type: "TXT", value: "v" },
      { record: "SPF", name: "send.tenant.example", type: "TXT", value: "v" },
    ];
    const plan = planDnsInstallation(tenantRecords, zone!.zoneName);
    expect(plan.auto).toHaveLength(0);
    expect(plan.manual).toHaveLength(2);
  });

  it("writes the default sending domain's records, which are inside the fleet zone", () => {
    const zone = resolveEmailDnsZone({
      cloneCloudflareEnabled: false,
      cloneZoneId: null,
      ...FLEET,
    });
    const records: ResendDnsRecord[] = [
      {
        record: "DKIM",
        name: "resend._domainkey.send.npc.aurixasystems.com.au",
        type: "TXT",
        value: "v",
      },
      { record: "SPF", name: "send.npc.aurixasystems.com.au", type: "MX", value: "feedback" },
    ];
    const plan = planDnsInstallation(records, zone!.zoneName);
    expect(plan.auto).toHaveLength(2);
    expect(plan.manual).toHaveLength(0);
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

describe("decideEmailIdentitySweep", () => {
  const NOW = Date.parse("2026-08-29T10:00:00Z");
  const base = {
    resend_domain_id: "d_1",
    domain_status: "pending_dns" as const,
    key_written_at: null,
    last_error: null,
    updated_at: "2026-08-29T09:00:00Z",
  };

  it("never starts an identity that has no domain registered", () => {
    // The invariant the drain's safety rests on: `advanceEmailIdentity`
    // creates a domain only when `resend_domain_id` is null, so refusing here
    // is what makes it safe to hand the drain `provision` mode.
    expect(decideEmailIdentitySweep({ identity: null, now: NOW })).toEqual({
      act: false,
      reason: "not_started",
    });
    expect(
      decideEmailIdentitySweep({ identity: { ...base, resend_domain_id: null }, now: NOW }),
    ).toEqual({ act: false, reason: "not_started" });
  });

  it("stops once the key has reached the clone", () => {
    expect(
      decideEmailIdentitySweep({
        identity: { ...base, key_written_at: "2026-08-29T09:30:00Z" },
        now: NOW,
      }),
    ).toEqual({ act: false, reason: "complete" });
  });

  it("polls verification while the domain is pending", () => {
    const v = decideEmailIdentitySweep({ identity: base, now: NOW });
    expect(v.act).toBe(true);
  });

  it("mints once the domain is verified and no key exists yet", () => {
    const v = decideEmailIdentitySweep({
      identity: { ...base, domain_status: "verified" },
      now: NOW,
    });
    expect(v).toEqual({ act: true, why: "domain verified, key not yet minted" });
  });

  it("leaves a failed identity alone for the cooling-off window", () => {
    const justFailed = {
      ...base,
      last_error: "Cloudflare unreachable",
      updated_at: new Date(NOW - 60_000).toISOString(),
    };
    expect(decideEmailIdentitySweep({ identity: justFailed, now: NOW })).toEqual({
      act: false,
      reason: "cooling_off",
    });
  });

  it("retries a failed identity once the window has passed", () => {
    const stale = {
      ...base,
      last_error: "Cloudflare unreachable",
      updated_at: new Date(NOW - EMAIL_SWEEP_COOLDOWN_MS - 1000).toISOString(),
    };
    expect(decideEmailIdentitySweep({ identity: stale, now: NOW }).act).toBe(true);
  });

  it("does not cool off an identity that has no error", () => {
    // A healthy identity mid-propagation was updated seconds ago; the window
    // is for FAILURES, and applying it here would stall every normal run.
    const fresh = { ...base, updated_at: new Date(NOW - 1000).toISOString() };
    expect(decideEmailIdentitySweep({ identity: fresh, now: NOW }).act).toBe(true);
  });

  it("acts rather than stalls when the timestamp is unusable", () => {
    const bad = { ...base, last_error: "boom", updated_at: "not-a-date" };
    expect(decideEmailIdentitySweep({ identity: bad, now: NOW }).act).toBe(true);
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
