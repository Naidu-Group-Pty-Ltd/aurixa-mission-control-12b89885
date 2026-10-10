import { describe, expect, it } from "vitest";
import {
  addressOf,
  custodyReadiness,
  decideCustodyStart,
  deriveVapiLoginEmail,
  extractVerification,
  isAddressedTo,
  isVapiMail,
  judgeVapiKey,
  mintVapiPassword,
  passwordMeetsPolicy,
  readingAgreesWithOrg,
  receivingMxRecords,
  VAPI_PASSWORD_LENGTH,
  type VapiCustodyRow,
} from "./cloneVapiCustody.pure";

const KEY = "0b5a1f6e-7c2d-4e8a-9f10-1a2b3c4d5e6f";
const ORG = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const AURIXA_ORG = "453f00c2-cb26-43f0-8da3-2eb13b578e15";

function seq(n: number, start = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (start + i * 37) % 256);
}

describe("the login lives on the clone's own domain", () => {
  it("is voice-agents@ on the sending domain, and nothing on a non-domain", () => {
    expect(deriveVapiLoginEmail("send.acme.aurixasystems.com.au")).toBe(
      "voice-agents@send.acme.aurixasystems.com.au",
    );
    expect(deriveVapiLoginEmail(" SEND.Acme.Example.com ")).toBe(
      "voice-agents@send.acme.example.com",
    );
    expect(deriveVapiLoginEmail("localhost")).toBeNull();
    expect(deriveVapiLoginEmail(null)).toBeNull();
  });
});

describe("the password", () => {
  it("is fixed length, carries every class and no ambiguous glyph, for many byte streams", () => {
    for (let s = 0; s < 200; s++) {
      const p = mintVapiPassword((n) => seq(n, s));
      expect(p).toHaveLength(VAPI_PASSWORD_LENGTH);
      expect(passwordMeetsPolicy(p)).toBe(true);
      expect(p).not.toMatch(/[lIO01]/);
    }
  });

  it("refuses a short byte source rather than minting a weak password", () => {
    expect(() => mintVapiPassword(() => new Uint8Array(4))).toThrow();
  });
});

describe("a key is judged before it is held", () => {
  const base = {
    key: KEY,
    orgId: ORG,
    fingerprint: "...5e6f (abcd1234)",
    aurixaKey: "11111111-2222-4333-8444-555555555555",
    aurixaOrgIds: [AURIXA_ORG],
    others: [],
  };

  it("accepts a fresh org's own key", () => {
    expect(judgeVapiKey(base)).toEqual({ ok: true });
  });

  it("refuses Aurixa's key and Aurixa's org", () => {
    expect(judgeVapiKey({ ...base, key: base.aurixaKey })).toMatchObject({
      ok: false,
      reason: "aurixa_key",
    });
    expect(judgeVapiKey({ ...base, orgId: AURIXA_ORG.toUpperCase() })).toMatchObject({
      ok: false,
      reason: "aurixa_org",
    });
  });

  it("refuses a key or an org another clone already holds", () => {
    expect(
      judgeVapiKey({
        ...base,
        others: [{ cloneId: "c2", fingerprint: base.fingerprint, orgId: null }],
      }),
    ).toMatchObject({ ok: false, reason: "key_held_elsewhere" });
    expect(
      judgeVapiKey({ ...base, others: [{ cloneId: "c2", fingerprint: "other", orgId: ORG }] }),
    ).toMatchObject({ ok: false, reason: "org_held_elsewhere" });
  });

  it("refuses something that is not a key or not an org id", () => {
    expect(judgeVapiKey({ ...base, key: "not-a-vapi-key" })).toMatchObject({ reason: "not_a_key" });
    expect(judgeVapiKey({ ...base, orgId: "my-org" })).toMatchObject({ reason: "not_an_org_id" });
  });

  it("reads an empty org as agreement, and one foreign object as disagreement", () => {
    expect(readingAgreesWithOrg(ORG, [])).toBe(true);
    expect(readingAgreesWithOrg(ORG, [{ orgId: ORG }, {}])).toBe(true);
    expect(readingAgreesWithOrg(ORG, [{ orgId: AURIXA_ORG }])).toBe(false);
  });
});

describe("the inbox", () => {
  it("opens only Vapi's (or WorkOS's) mail addressed to the login", () => {
    expect(isVapiMail({ from: "Vapi <noreply@vapi.ai>", subject: "Verify your email" })).toBe(true);
    expect(isVapiMail({ from: "no-reply@auth.workosmail.com", subject: "Your code" })).toBe(true);
    expect(isVapiMail({ from: "someone@example.com", subject: "Hello" })).toBe(false);
    expect(addressOf("Vapi <NoReply@Vapi.ai>")).toBe("noreply@vapi.ai");
    expect(
      isAddressedTo(["Voice <voice-agents@send.acme.com>"], "voice-agents@send.acme.com"),
    ).toBe(true);
    expect(isAddressedTo("voice-agents@send.acme.com", "voice-agents@send.other.com")).toBe(false);
  });

  it("extracts a code near a word that says it is one, and only Vapi links", () => {
    const got = extractVerification({
      text: "Your Vapi verification code is 482913. Call 0412345678 for help.",
      html: '<a href="https://dashboard.vapi.ai/auth/confirm?token=a&amp;x=1">Confirm</a><a href="https://evil.example.com/x">x</a>',
    });
    expect(got.codes).toEqual(["482913"]);
    expect(got.links).toEqual(["https://dashboard.vapi.ai/auth/confirm?token=a&x=1"]);
  });

  it("does not read an unrelated number as a code", () => {
    expect(extractVerification({ text: "Invoice 12345678 is attached." }).codes).toEqual([]);
  });
});

describe("readiness", () => {
  const facts = {
    resendConfigured: true,
    encryptionEnabled: true,
    emailDomain: { sendingDomain: "send.acme.com", resendDomainId: "d1", verified: true },
  };
  const row: VapiCustodyRow = {
    clone_id: "c1",
    login_email: null,
    password_set_at: null,
    sending_domain: "send.acme.com",
    receiving_enabled_at: null,
    receiving_records_installed_via: null,
    signed_up_at: null,
    vapi_org_id: null,
    key_fingerprint: null,
    key_verified_at: null,
    suspended_at: null,
    last_error: null,
  };

  it("walks the five steps in order, with exactly one open", () => {
    expect(custodyReadiness(null, { ...facts, emailDomain: null })).toMatchObject({
      status: "not_started",
      open: "email_domain",
    });
    expect(custodyReadiness(row, facts)).toMatchObject({
      status: "inbox_pending",
      open: "receiving",
    });
    const r2 = {
      ...row,
      receiving_enabled_at: "t",
      receiving_records_installed_via: "cloudflare" as const,
    };
    expect(custodyReadiness(r2, facts).open).toBe("login");
    const r3 = { ...r2, login_email: "voice-agents@send.acme.com", password_set_at: "t" };
    expect(custodyReadiness(r3, facts)).toMatchObject({
      status: "awaiting_signup",
      open: "signup",
    });
    const r4 = { ...r3, signed_up_at: "t" };
    expect(custodyReadiness(r4, facts)).toMatchObject({ status: "awaiting_key", open: "org_key" });
    const r5 = { ...r4, vapi_org_id: ORG, key_fingerprint: "f", key_verified_at: "t" };
    const done = custodyReadiness(r5, facts);
    expect(done).toMatchObject({ status: "active", open: null });
    expect(done.steps.filter((s) => s.open)).toHaveLength(0);
  });

  it("never reads a later step done while an earlier one is not", () => {
    const skipped = { ...row, vapi_org_id: ORG, key_fingerprint: "f", key_verified_at: "t" };
    const r = custodyReadiness(skipped, facts);
    expect(r.status).not.toBe("active");
    expect(r.steps.find((s) => s.id === "org_key")?.done).toBe(false);
  });

  it("is suspended whatever else is true", () => {
    expect(custodyReadiness({ ...row, suspended_at: "t" }, facts).status).toBe("suspended");
  });

  it("names a missing configuration as the blocker, not the operator", () => {
    const r = custodyReadiness(row, { ...facts, encryptionEnabled: false });
    expect(r.steps.find((s) => s.id === "receiving")?.blockedBy).toMatch(/CREDENTIALS_ENC_KEY/);
  });
});

describe("starting custody from the deployment drain", () => {
  const f = {
    hasCustodyRow: false,
    resendDomainId: "d1",
    sendingDomain: "send.acme.com",
    resendConfigured: true,
    encryptionEnabled: true,
  };
  it("starts only on a registered domain, once, with both secrets configured", () => {
    expect(decideCustodyStart(f)).toEqual({ act: true });
    expect(decideCustodyStart({ ...f, hasCustodyRow: true })).toMatchObject({
      reason: "already_started",
    });
    expect(decideCustodyStart({ ...f, resendDomainId: null })).toMatchObject({
      reason: "no_domain",
    });
    expect(decideCustodyStart({ ...f, encryptionEnabled: false })).toMatchObject({
      reason: "not_configured",
    });
  });
});

describe("the receiving MX record", () => {
  it("is the domain-root MX, never the return path's", () => {
    const recs = [
      {
        record: "SPF",
        type: "MX",
        name: "send.send.acme.com",
        value: "feedback-smtp.us-east-1.amazonses.com",
      },
      {
        record: "Receiving",
        type: "MX",
        name: "send.acme.com",
        value: "inbound-smtp.us-east-1.amazonaws.com",
      },
      { record: "DKIM", type: "TXT", name: "resend._domainkey.send.acme.com", value: "p=" },
    ];
    expect(receivingMxRecords(recs, "send.acme.com").map((r) => r.value)).toEqual([
      "inbound-smtp.us-east-1.amazonaws.com",
    ]);
  });
});
