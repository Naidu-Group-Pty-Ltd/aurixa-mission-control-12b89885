import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  D6_KEEP_AND_BILL,
  MISSION_CONTROL_LINK_SECRET,
  PLATFORM_PAID_STATUSES,
  platformCredentialRotations,
} from "./handoffCredentialPlan.pure";

/**
 * A handoff accounts for every credential Aurixa pays for (key audit S4,
 * 29 Oct 2026). Measured that day, each clone's ledger held 10 or 11 forwarded
 * keys and 2 or 3 minted ones, and the handoff plan named none of them.
 */
describe("platformCredentialRotations", () => {
  const ledger = [
    { name: "OPENAI_API_KEY", status: "inherited" },
    { name: "RESEND_API_KEY", status: "minted" },
    { name: "ANTHROPIC_API_KEY", status: "federated" },
    { name: "GOHIGHLEVEL_API_KEY_NEW", status: "set" },
    { name: "VAPI_API_KEY", status: "withheld" },
    { name: "GAMMA_API_KEY", status: "authorised_no_value" },
    { name: MISSION_CONTROL_LINK_SECRET, status: "failed" },
  ];

  it("plans a row for each name Aurixa supplied, in name order, and the link last", () => {
    expect(platformCredentialRotations(ledger).map((r) => r.key_ref)).toEqual([
      "platform.ANTHROPIC_API_KEY",
      "platform.OPENAI_API_KEY",
      "platform.RESEND_API_KEY",
      `platform.${MISSION_CONTROL_LINK_SECRET}`,
    ]);
  });

  it("leaves out what the client brought and what never reached the clone", () => {
    const refs = platformCredentialRotations(ledger).map((r) => r.key_ref);
    for (const name of ["GOHIGHLEVEL_API_KEY_NEW", "VAPI_API_KEY", "GAMMA_API_KEY"]) {
      expect(refs).not.toContain(`platform.${name}`);
    }
  });

  it("plans the Mission Control link whatever its ledger says, once", () => {
    for (const status of ["failed", "missing", "set", "inherited"]) {
      const rows = platformCredentialRotations([{ name: MISSION_CONTROL_LINK_SECRET, status }]);
      expect(rows.map((r) => r.key_ref)).toEqual([`platform.${MISSION_CONTROL_LINK_SECRET}`]);
    }
    expect(platformCredentialRotations([])).toHaveLength(1);
  });

  it("is bookkeeping that names the owner's decision, so a row closes only on evidence", () => {
    for (const row of platformCredentialRotations(ledger)) {
      expect(row.target).toBe("other");
      expect(row.hint).toContain(D6_KEEP_AND_BILL);
      expect(row.hint).toMatch(
        /with evidence that the (key is kept and billed under D6|link is kept)/,
      );
    }
  });

  /**
   * D6, decided by the owner on 30 Oct 2026: keep and bill them. A platform
   * key keeps running after handover and is billed through the usage
   * forwarder (live since 09:00 that day), and is withdrawn only when the
   * client brings its own.
   */
  it("keeps every platform key by default, and withdraws one only for the client's own value", () => {
    const keys = platformCredentialRotations(ledger).filter(
      (r) => r.key_ref !== `platform.${MISSION_CONTROL_LINK_SECRET}`,
    );
    expect(keys).toHaveLength(3);
    for (const row of keys) {
      const name = row.key_ref.slice("platform.".length);
      expect(row.hint).toContain("It stays after handover");
      expect(row.hint).toContain("By default it stays: mark this row skipped");
      expect(row.hint).toContain(
        `withdrawn only when the client supplies its own value for ${name}`,
      );
      // Nothing is offered as the default but keeping it.
      expect(row.hint).not.toMatch(/\beither\b|\bor keep\b/i);
    }
    expect(D6_KEEP_AND_BILL).toContain("billed through the usage forwarder");
  });

  it("says how each kind of key is withdrawn once the client's own value replaces it", () => {
    const hint = (status: string) => platformCredentialRotations([{ name: "K", status }])[0].hint;
    expect(hint("inherited")).toContain(
      "set theirs on the client's project, which replaces Aurixa's",
    );
    expect(hint("minted")).toContain("then revoke the minted key at the vendor");
    expect(hint("federated")).toContain("then end the federation");
  });

  it("never withdraws the Mission Control link by default, because billing reports through it", () => {
    const link = platformCredentialRotations(ledger).find(
      (r) => r.key_ref === `platform.${MISSION_CONTROL_LINK_SECRET}`,
    );
    expect(link?.hint).toContain("never withdrawn by default");
    expect(link?.hint).toContain(
      "the usage forwarder that bills the platform keys after handover reports through it",
    );
    expect(link?.hint).toContain("the client bringing its own keys does not withdraw it");
    expect(link?.hint).not.toMatch(/Revoke it/);
  });

  it("treats exactly the statuses billing calls platform-paid", () => {
    expect([...PLATFORM_PAID_STATUSES]).toEqual(["inherited", "minted", "federated"]);
  });

  it("names a duplicate once", () => {
    const rows = platformCredentialRotations([
      { name: "OPENAI_API_KEY", status: "inherited" },
      { name: "OPENAI_API_KEY", status: "inherited" },
    ]);
    expect(rows.filter((r) => r.key_ref === "platform.OPENAI_API_KEY")).toHaveLength(1);
  });
});

describe("planning a handoff", () => {
  const fns = readFileSync("src/lib/handoffs.functions.ts", "utf8");
  const plan = fns.slice(fns.indexOf("export const planStandardRotations"), fns.indexOf("export const executeSecretRotation"));

  it("adds the clone's platform credentials to the standard plan", () => {
    expect(plan).toContain("platformCredentialRotations(");
    expect(plan).toContain("...DEFAULT_ROTATION_PLAN,");
    expect(plan).toContain('.from("clone_backend_secrets")');
  });

  it("fails rather than planning without them when the ledger cannot be read", () => {
    expect(plan).toContain("if (lErr) throw new Error(");
  });
});
