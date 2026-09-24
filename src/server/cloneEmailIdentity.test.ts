import { describe, it, expect } from "vitest";
import {
  canMintKey,
  decideEmailIdentityHealth,
  decideEmailIdentityStart,
  domainFullyVerified,
  isEmailAuditPass,
  keyOwed,
  mapResendDomainStatus,
  missingKeyPatch,
  planDnsRecordSync,
  vanishedDomainPatch,
  EMAIL_AUDIT_EVERY_MS,
  type ExistingDnsRecord,
  deriveFromAddress,
  deriveSendingDomain,
  identityReadiness,
  isValidSendingDomain,
  keyLast4,
  ledgerStatusForShell,
  mayAlignSenderAddress,
  absoluteRecordName,
  decideEmailIdentitySweep,
  expectedDnsProbes,
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
  from_address_written_at: null,
  revoked_at: null,
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

describe("canMintKey — a revoked identity", () => {
  const verified = {
    resend_domain_id: "d-1",
    domain_status: "verified" as const,
    dns_installed_via: "cloudflare" as const,
  };

  it("refuses to mint while revoked, even on a perfectly verified domain", () => {
    // The exact shape a revoke leaves behind when `deleteDomain` is false —
    // which is what the operator's Revoke button sends. The domain really is
    // still verified at Resend, so every other precondition passes; without
    // this check both drains read the row as "waiting to be minted" and minted.
    const gate = canMintKey(row({ ...verified, revoked_at: "2026-08-31T09:00:00Z" }));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/revoked/i);
  });

  it("mints once the revocation is cleared", () => {
    expect(canMintKey(row(verified)).ok).toBe(true);
  });

  it("is where the guard lives, because three callers reach the mint", () => {
    // `provision` mode has three callers and two are automated
    // (`email-identity-drain` and the deployment drain's credential arming),
    // so a guard in the sweep alone would leave a redeploy able to undo a
    // revocation. Asserting the pure gate is asserting all three at once.
    for (const status of ["verified", "pending_dns", "failed"] as const) {
      expect(
        canMintKey(row({ ...verified, domain_status: status, revoked_at: "2026-08-31T09:00:00Z" }))
          .ok,
      ).toBe(false);
    }
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

  it("is NOT live on a key alone — the sender address is the other half", () => {
    // The state the first clone shipped in: domain registered, DNS installed,
    // Resend verified, key written and scoped to that domain — and every send
    // answering 403, because nothing had told the clone which address it may
    // send from. The card read "Dedicated key live" throughout.
    const keyOnly = identityReadiness(
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
    expect(keyOnly.next).toBe("sender");
    expect(keyOnly.live).toBe(false);
  });

  it("says a revoked identity is revoked rather than offering a mint", () => {
    // A live step whose act every path refuses reads as a broken page.
    const r = identityReadiness(
      row({
        resend_domain_id: "d-1",
        dns_installed_via: "cloudflare",
        domain_status: "verified",
        revoked_at: "2026-08-31T09:00:00Z",
      }),
      { resendConfigured: true },
    );
    expect(r.live).toBe(false);
    expect(r.steps.find((s) => s.id === "key_written")?.detail).toMatch(/revoked/i);
  });

  it("is live once both halves of the credential have reached the clone", () => {
    const r = identityReadiness(
      row({
        resend_domain_id: "d-1",
        dns_installed_via: "cloudflare",
        domain_status: "verified",
        resend_key_id: "k-1",
        key_last4: "XYZ9",
        key_written_at: "2026-08-28T10:00:00Z",
        from_address_written_at: "2026-08-28T10:00:00Z",
        default_from_address: "notifications@send.npc.aurixasystems.com.au",
      }),
      { resendConfigured: true },
    );
    expect(r.live).toBe(true);
    expect(r.next).toBeNull();
    // The address is named, so an operator can see WHICH sender is live.
    expect(r.steps.find((s) => s.id === "sender")?.detail).toContain(
      "notifications@send.npc.aurixasystems.com.au",
    );
  });
});

describe("expectedDnsProbes", () => {
  // Resend's real answer for this domain: two records share one name.
  const RECORDS: ResendDnsRecord[] = [
    {
      record: "DKIM",
      name: "resend._domainkey.send.npc.aurixasystems.com.au",
      type: "TXT",
      value: "p=...",
    },
    {
      record: "SPF",
      name: "send.send.npc.aurixasystems.com.au",
      type: "MX",
      value: "feedback",
      priority: 10,
    },
    { record: "SPF", name: "send.send.npc.aurixasystems.com.au", type: "TXT", value: "v=spf1" },
  ];

  it("asks one question per distinct name and type", () => {
    // Three records, three lookups — the shared name differs by type.
    expect(expectedDnsProbes(RECORDS)).toEqual([
      { name: "resend._domainkey.send.npc.aurixasystems.com.au", type: "TXT" },
      { name: "send.send.npc.aurixasystems.com.au", type: "MX" },
      { name: "send.send.npc.aurixasystems.com.au", type: "TXT" },
    ]);
  });

  it("collapses a genuine duplicate", () => {
    const doubled = [...RECORDS, RECORDS[1]];
    expect(expectedDnsProbes(doubled)).toHaveLength(3);
  });

  it("normalises case and whitespace so the same name is asked once", () => {
    const mixed: ResendDnsRecord[] = [
      { record: "SPF", name: "  Send.Send.NPC.aurixasystems.com.au ", type: "mx", value: "v" },
      { record: "SPF", name: "send.send.npc.aurixasystems.com.au", type: "MX", value: "v" },
    ];
    expect(expectedDnsProbes(mixed)).toEqual([
      { name: "send.send.npc.aurixasystems.com.au", type: "MX" },
    ]);
  });

  it("has nothing to ask when no records are published", () => {
    expect(expectedDnsProbes([])).toEqual([]);
  });
});

describe("decideEmailIdentitySweep", () => {
  const NOW = Date.parse("2026-08-29T10:00:00Z");
  const base = {
    resend_domain_id: "d_1",
    domain_status: "pending_dns" as const,
    key_written_at: null,
    from_address_written_at: null,
    revoked_at: null,
    last_error: null,
    updated_at: "2026-08-29T09:00:00Z",
  };

  it("never starts an identity for a clone that has none — that is the start pass's", () => {
    expect(decideEmailIdentitySweep({ identity: null, now: NOW })).toEqual({
      act: false,
      reason: "not_started",
    });
  });

  it("retries a registration that was refused — the domain was already chosen", () => {
    // NPC CRM Independent, 19 Sep 2026: the first registration hit Resend's
    // plan limit, the row was left with no domain id, and the drain answered
    // `not_started` every five minutes for five days — after the plan was
    // upgraded too. A row with no domain id is a registration that FAILED;
    // its hostname and region are in the row, so retrying chooses nothing.
    const v = decideEmailIdentitySweep({
      identity: { ...base, resend_domain_id: null, domain_status: "unprovisioned" },
      now: NOW,
    });
    expect(v.act).toBe(true);
    expect(v.act && v.why).toContain("registering");
  });

  it("paces a refused registration with the same cooling-off window", () => {
    const refused = {
      ...base,
      resend_domain_id: null,
      domain_status: "unprovisioned" as const,
      last_error: "You have reached the domain limit of your plan. Upgrade to add more.",
      updated_at: new Date(NOW - 60_000).toISOString(),
    };
    expect(decideEmailIdentitySweep({ identity: refused, now: NOW })).toEqual({
      act: false,
      reason: "cooling_off",
    });
    const later = {
      ...refused,
      updated_at: new Date(NOW - EMAIL_SWEEP_COOLDOWN_MS - 1).toISOString(),
    };
    expect(decideEmailIdentitySweep({ identity: later, now: NOW }).act).toBe(true);
  });

  it("never re-registers a domain somebody revoked and deleted", () => {
    // Revoke with `deleteDomain: true` clears the domain id — and stamps
    // `revoked_at`, which is what keeps the retry above from undoing it.
    expect(
      decideEmailIdentitySweep({
        identity: {
          ...base,
          resend_domain_id: null,
          domain_status: "revoked",
          revoked_at: "2026-08-29T09:45:00Z",
        },
        now: NOW,
      }),
    ).toEqual({ act: false, reason: "revoked" });
  });

  it("stops once BOTH the key and the sender address have reached the clone", () => {
    expect(
      decideEmailIdentitySweep({
        identity: {
          ...base,
          domain_status: "verified",
          key_written_at: "2026-08-29T09:30:00Z",
          from_address_written_at: "2026-08-29T09:30:00Z",
        },
        now: NOW,
      }),
    ).toEqual({ act: false, reason: "complete" });
  });

  it("carries a key-only identity forward so the drain repairs it unattended", () => {
    // Every identity provisioned before the key and its address were written
    // together is in this state. Testing `key_written_at` alone is what made
    // them invisible to the only thing that could fix them, and the failure is
    // unreadable from the clone — a 403 inside a catch-and-log on every mail
    // path — so waiting for somebody to notice was never going to work.
    const v = decideEmailIdentitySweep({
      identity: {
        ...base,
        domain_status: "verified",
        key_written_at: "2026-08-29T09:30:00Z",
        from_address_written_at: null,
      },
      now: NOW,
    });
    expect(v.act).toBe(true);
    expect(v.act && v.why).toContain("sender address");
  });

  it("never carries a revoked identity forward", () => {
    // Revoke with `deleteDomain: false` — the Revoke button's own call —
    // clears the key and leaves the domain verified. That is byte-for-byte the
    // state of an identity that has finished DNS and is waiting to be minted,
    // and it is what the drain read it as: it minted a fresh key and wrote it
    // to a clone somebody had deliberately stopped, within five minutes, with
    // nothing recording that it had happened.
    const v = decideEmailIdentitySweep({
      identity: {
        ...base,
        domain_status: "verified",
        key_written_at: null,
        from_address_written_at: null,
        revoked_at: "2026-08-29T09:45:00Z",
      },
      now: NOW,
    });
    expect(v).toEqual({ act: false, reason: "revoked" });
  });

  it("refuses a revoked identity before the cooling-off window is consulted", () => {
    // Ordering matters: a revoked row with a recent error must read as
    // revoked, not as "try again in thirty minutes" — the second says the
    // sweep still intends to act on it.
    const v = decideEmailIdentitySweep({
      identity: {
        ...base,
        domain_status: "verified",
        revoked_at: "2026-08-29T09:45:00Z",
        last_error: "something failed",
        updated_at: "2026-08-29T09:59:00Z",
      },
      now: NOW,
    });
    expect(v).toEqual({ act: false, reason: "revoked" });
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

/**
 * Beginning a sending identity, for the clone the sweep cannot see.
 *
 * `decideEmailIdentitySweep` refuses a clone with no registered domain in as
 * many words — "Nothing has been registered for this clone … not ours to
 * start" — and until this existed, nothing else decided it on a schedule. The
 * deployment drain started one at `syncing_env`, which opens
 * `if (!row.project_id) return`, so only a clone Vercel is building ever got
 * there. Provisioning writes `not_requested` for `manual` and `none`, and
 * `pending_platform` with no Vercel token; every clone in this fleet is served
 * manually. The result was silent in the way this programme keeps paying for:
 * clones deployed perfectly and could not send a password reset.
 */
describe("decideEmailIdentityStart", () => {
  const facts = (over: Partial<Parameters<typeof decideEmailIdentityStart>[0]> = {}) => ({
    hasIdentity: false,
    backendReady: true,
    startedThisRun: 0,
    limit: 5,
    ...over,
  });

  it("starts one for a clone that has none", () => {
    expect(decideEmailIdentityStart(facts())).toEqual({
      act: true,
      why: "no sending identity yet",
    });
  });

  /**
   * THE point of this decision. A hosting project is not among its facts at
   * all — requiring one is what confined the whole feature to Vercel-built
   * clones, and the key it registers goes to the clone's Supabase project
   * rather than to its host.
   */
  it("does not care whether the clone has a hosting project", () => {
    expect(Object.keys(facts())).not.toContain("hasProject");
  });

  it("leaves an existing identity to the sweep", () => {
    // A revoked or half-finished identity is a ROW, so it lands here as
    // `hasIdentity` and belongs to the sweep, which knows how to read its
    // state. Starting a second one would register a second domain.
    expect(decideEmailIdentityStart(facts({ hasIdentity: true }))).toEqual({
      act: false,
      reason: "already_started",
    });
  });

  it("waits for somewhere to put the key", () => {
    // Registering a domain whose key has nowhere to land leaves an identity
    // that can never finish, and the sweep would then claim it every pass.
    expect(decideEmailIdentityStart(facts({ backendReady: false }))).toEqual({
      act: false,
      reason: "backend_not_ready",
    });
  });

  it("is bounded per pass", () => {
    expect(decideEmailIdentityStart(facts({ startedThisRun: 5, limit: 5 }))).toEqual({
      act: false,
      reason: "over_limit",
    });
    expect(decideEmailIdentityStart(facts({ startedThisRun: 4, limit: 5 }))).toMatchObject({
      act: true,
    });
  });

  it("refuses an existing identity before it looks at anything else", () => {
    // Order matters: a clone that already has one must not be reported as
    // `backend_not_ready`, which reads as work outstanding.
    expect(decideEmailIdentityStart(facts({ hasIdentity: true, backendReady: false }))).toEqual({
      act: false,
      reason: "already_started",
    });
  });
});

// ─── DNS sync, partial verification and the health audit ─────────────

const DOMAIN = "send.npc-test.aurixasystems.com.au";
const DKIM_NAME = `resend._domainkey.${DOMAIN}`;
const RETURN = `send.${DOMAIN}`;
const FALLBACK = `rsend.${DOMAIN}`;
const NEW_KEY = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDnew";
const OLD_KEY = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDold";

const required = {
  dkim: { record: "DKIM", name: DKIM_NAME, type: "TXT", value: NEW_KEY },
  mx: {
    record: "SPF",
    name: RETURN,
    type: "MX",
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
  },
  spf: { record: "SPF", name: RETURN, type: "TXT", value: "v=spf1 include:amazonses.com ~all" },
  cname: { record: "SPF", name: FALLBACK, type: "CNAME", value: "send.forge.rmta.net" },
} satisfies Record<string, ResendDnsRecord>;

const cf = (over: Partial<ExistingDnsRecord> & Pick<ExistingDnsRecord, "type" | "content">) =>
  ({
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    name: DKIM_NAME,
    proxied: false,
    ...over,
  }) as ExistingDnsRecord;

describe("planDnsRecordSync", () => {
  it("creates a record the zone does not hold", () => {
    expect(planDnsRecordSync(required.dkim, [])).toMatchObject({ action: "create", remove: [] });
  });

  it("keeps an exact copy, reading the value as DNS would — quoted and chunked", () => {
    // Cloudflare prints TXT content quoted, and a long key can come back as
    // several strings that DNS concatenates.
    const half = NEW_KEY.length / 2;
    const existing = cf({
      type: "TXT",
      content: `"${NEW_KEY.slice(0, half)}" "${NEW_KEY.slice(half)}"`,
    });
    expect(planDnsRecordSync(required.dkim, [existing])).toMatchObject({
      action: "keep",
      existingId: existing.id,
    });
  });

  it("updates a re-registration's stale DKIM key in place instead of adding a second", () => {
    // The defect: "create unless an exact copy exists" put the new key BESIDE
    // the old one, and a selector holding two keys is one no verifier uses.
    const stale = cf({ type: "TXT", content: `"${OLD_KEY}"` });
    expect(planDnsRecordSync(required.dkim, [stale])).toEqual({
      record: required.dkim,
      action: "update",
      existingId: stale.id,
      reason: "stale_value",
      remove: [],
    });
  });

  it("removes a contradicting DKIM key that sits beside the right one", () => {
    const right = cf({ type: "TXT", content: NEW_KEY });
    const stale = cf({ type: "TXT", content: OLD_KEY });
    expect(planDnsRecordSync(required.dkim, [stale, right])).toMatchObject({
      action: "keep",
      existingId: right.id,
      remove: [stale.id],
    });
  });

  it("never touches a TXT record of another kind at the same name", () => {
    const other = cf({ name: RETURN, type: "TXT", content: "google-site-verification=abc" });
    const plan = planDnsRecordSync(required.spf, [other]);
    expect(plan.action).toBe("create");
    expect(plan.remove).toEqual([]);
  });

  it("replaces a second SPF policy rather than publishing two", () => {
    const stale = cf({ name: RETURN, type: "TXT", content: '"v=spf1 include:old.example ~all"' });
    expect(planDnsRecordSync(required.spf, [stale])).toMatchObject({
      action: "update",
      existingId: stale.id,
    });
  });

  it("moves the bounce MX to the region Resend now names", () => {
    const stale = cf({
      name: RETURN,
      type: "MX",
      content: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    });
    expect(planDnsRecordSync(required.mx, [stale])).toMatchObject({
      action: "update",
      existingId: stale.id,
    });
  });

  it("leaves an unrelated MX alone and adds Resend's beside it", () => {
    const theirs = cf({ name: RETURN, type: "MX", content: "mx.tenant-mail.example", priority: 5 });
    expect(planDnsRecordSync(required.mx, [theirs])).toMatchObject({
      action: "create",
      remove: [],
    });
  });

  it("takes a CNAME out from behind the proxy — a proxied name is not Resend's CNAME", () => {
    // NPC CRM Independent, 24 Sep 2026: the client proxies every CNAME by
    // default, so the fallback return path resolved to Cloudflare and never
    // verified.
    const proxied = cf({
      name: FALLBACK,
      type: "CNAME",
      content: "send.forge.rmta.net",
      proxied: true,
    });
    expect(planDnsRecordSync(required.cname, [proxied])).toMatchObject({
      action: "update",
      existingId: proxied.id,
      reason: "proxied",
    });
  });

  it("keeps an unproxied CNAME that already points at Resend", () => {
    const right = cf({ name: FALLBACK, type: "CNAME", content: "send.forge.rmta.net." });
    expect(planDnsRecordSync(required.cname, [right])).toMatchObject({ action: "keep" });
  });

  it("refuses to write a CNAME over a name that holds anything else", () => {
    const a = cf({ name: FALLBACK, type: "A", content: "203.0.113.7" });
    const plan = planDnsRecordSync(required.cname, [a]);
    expect(plan.action).toBe("conflict");
    expect(plan.detail).toContain("cannot share a name");
  });

  it("only ever judges records at the required record's own name", () => {
    const elsewhere = cf({ name: `other.${DOMAIN}`, type: "TXT", content: OLD_KEY });
    expect(planDnsRecordSync(required.dkim, [elsewhere])).toMatchObject({
      action: "create",
      remove: [],
    });
  });
});

describe("expectedDnsProbes — the fallback CNAME does not hold the door", () => {
  const all = [required.dkim, required.mx, required.spf, required.cname];

  it("waits on the sending records only, before anything has verified", () => {
    expect(
      expectedDnsProbes(all)
        .map((p) => p.type)
        .sort(),
    ).toEqual(["MX", "TXT", "TXT"]);
  });

  it("asks about what is still outstanding once some records have verified", () => {
    const partial = [
      { ...required.dkim, status: "verified" },
      { ...required.mx, status: "pending" },
      { ...required.spf, status: "verified" },
      { ...required.cname, status: "pending" },
    ];
    // The MX still decides whether mail can be sent; the CNAME waits behind it.
    expect(expectedDnsProbes(partial)).toEqual([{ name: RETURN, type: "MX" }]);
  });

  it("asks about the CNAME once it is the only record left", () => {
    const partial = [
      { ...required.dkim, status: "verified" },
      { ...required.mx, status: "verified" },
      { ...required.spf, status: "verified" },
      { ...required.cname, status: "pending" },
    ];
    expect(expectedDnsProbes(partial)).toEqual([{ name: FALLBACK, type: "CNAME" }]);
  });
});

describe("mapResendDomainStatus", () => {
  const withDkim = (status: string) => [{ ...required.dkim, status }, required.cname];

  it("maps verified to verified", () => {
    expect(mapResendDomainStatus("verified")).toBe("verified");
  });

  it("counts a partially verified domain as sendable while its DKIM is verified", () => {
    // Resend's own guidance: a partially verified domain sends, without the
    // fallback host. Reading it as "not in yet" refused NPC CRM Independent
    // its key on a domain that could send.
    expect(mapResendDomainStatus("partially_verified", withDkim("verified"))).toBe("verified");
  });

  it("does not count a partial status whose DKIM has not verified", () => {
    expect(mapResendDomainStatus("partially_verified", withDkim("pending"))).toBe("pending_dns");
    expect(mapResendDomainStatus("partially_verified", [])).toBe("pending_dns");
    expect(mapResendDomainStatus("partially_failed", withDkim("failed"))).toBe("failed");
  });

  it("accepts both spellings of failure", () => {
    expect(mapResendDomainStatus("failure")).toBe("failed");
    expect(mapResendDomainStatus("failed")).toBe("failed");
  });

  it("reads everything else as the DNS answer not being in yet", () => {
    for (const s of ["not_started", "pending", "temporary_failure", "something_new"]) {
      expect(mapResendDomainStatus(s)).toBe("pending_dns");
    }
  });
});

describe("domainFullyVerified", () => {
  it("is false while any published record is outstanding", () => {
    expect(
      domainFullyVerified({
        domain_status: "verified",
        dns_records: [
          { ...required.dkim, status: "verified" },
          { ...required.cname, status: "pending" },
        ],
      }),
    ).toBe(false);
  });

  it("is true once every record is verified, and ignores records with no status", () => {
    expect(
      domainFullyVerified({
        domain_status: "verified",
        dns_records: [{ ...required.dkim, status: "verified" }, required.mx],
      }),
    ).toBe(true);
  });

  it("is false for a domain that is not verified at all", () => {
    expect(domainFullyVerified({ domain_status: "pending_dns", dns_records: [] })).toBe(false);
  });
});

describe("decideEmailIdentityHealth", () => {
  const finished = {
    resend_domain_id: "d-1",
    resend_key_id: "k-1",
    key_written_at: "2026-09-03T16:00:25Z",
    from_address_written_at: "2026-09-03T16:00:25Z",
    revoked_at: null,
  };
  const facts = (over: Partial<Parameters<typeof decideEmailIdentityHealth>[0]> = {}) => ({
    identity: finished,
    listedDomainStatus: "verified" as string | null,
    keysComplete: true,
    keyListed: true,
    ...over,
  });

  it("leaves revoked and unfinished identities alone — they are not the audit's", () => {
    expect(
      decideEmailIdentityHealth(
        facts({ identity: { ...finished, revoked_at: "2026-09-01T00:00:00Z" } }),
      ),
    ).toEqual({ kind: "not_audited", reason: "revoked" });
    expect(
      decideEmailIdentityHealth(
        facts({ identity: { ...finished, from_address_written_at: null } }),
      ),
    ).toEqual({ kind: "not_audited", reason: "unfinished" });
  });

  it("treats a domain missing from the listing as a question, not an answer", () => {
    // NPC Test's domain was deleted at Resend. The audit asks Resend for it by
    // id, and only Resend's 404 resets anything.
    expect(decideEmailIdentityHealth(facts({ listedDomainStatus: null }))).toEqual({
      kind: "domain_unlisted",
    });
  });

  it("re-drives a domain that is no longer verified", () => {
    expect(decideEmailIdentityHealth(facts({ listedDomainStatus: "failed" }))).toEqual({
      kind: "domain_degraded",
      status: "failed",
    });
  });

  it("does not call a partially verified domain degraded — it sends", () => {
    expect(decideEmailIdentityHealth(facts({ listedDomainStatus: "partially_verified" }))).toEqual({
      kind: "healthy",
    });
  });

  it("re-mints a key that a COMPLETE listing does not contain", () => {
    expect(decideEmailIdentityHealth(facts({ keyListed: false }))).toEqual({ kind: "key_missing" });
  });

  it("concludes nothing about a key from an incomplete listing", () => {
    expect(decideEmailIdentityHealth(facts({ keyListed: false, keysComplete: false }))).toEqual({
      kind: "healthy",
    });
  });
});

describe("the vanished-domain reset", () => {
  it("owes DNS and the credential again, and keeps the old key's id to retire later", () => {
    const patch = vanishedDomainPatch();
    expect(patch).toMatchObject({
      resend_domain_id: null,
      dns_installed_via: null,
      key_written_at: null,
      from_address_written_at: null,
    });
    // Kept on purpose: the dead key is still what the clone holds, and it is
    // retired only after its replacement has been written there.
    expect(patch).not.toHaveProperty("resend_key_id");
  });

  it("makes a key owed while an unretired one is still recorded", () => {
    expect(keyOwed({ resend_key_id: "old", key_written_at: null })).toBe(true);
    expect(keyOwed({ resend_key_id: null, key_written_at: null })).toBe(true);
    expect(keyOwed({ resend_key_id: "k", key_written_at: "2026-09-03T16:00:25Z" })).toBe(false);
  });

  it("forgets a key that Resend no longer holds", () => {
    expect(missingKeyPatch()).toMatchObject({ resend_key_id: null, key_written_at: null });
  });
});

describe("isEmailAuditPass", () => {
  const hour = Date.parse("2026-09-24T05:00:00Z");
  it("is the first drain interval of each hour, and only that", () => {
    expect(isEmailAuditPass(hour)).toBe(true);
    expect(isEmailAuditPass(hour + 4 * 60_000 + 59_000)).toBe(true);
    expect(isEmailAuditPass(hour + 5 * 60_000)).toBe(false);
    expect(isEmailAuditPass(hour + EMAIL_AUDIT_EVERY_MS - 1)).toBe(false);
  });

  it("lands on exactly one five-minute pass an hour", () => {
    let hits = 0;
    for (let t = hour; t < hour + EMAIL_AUDIT_EVERY_MS; t += 5 * 60_000) {
      if (isEmailAuditPass(t + 2_000)) hits += 1;
    }
    expect(hits).toBe(1);
  });

  it("never fires on an unusable clock", () => {
    expect(isEmailAuditPass(Number.NaN)).toBe(false);
  });
});
