import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  D6_KEEP_AND_BILL,
  MISSION_CONTROL_LINK_SECRET,
  PLATFORM_PAID_STATUSES,
  platformCredentialRotations,
} from "./handoffCredentialPlan.pure";
import { integrationLedgerStatus, tenantSecretRefusal } from "./integrationSecretBroker.pure";

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
        `withdrawn only when the client enters its own value for ${name} on the clone's Integrations page`,
      );
      // Nothing is offered as the default but keeping it.
      expect(row.hint).not.toMatch(/\beither\b|\bor keep\b/i);
    }
    expect(D6_KEEP_AND_BILL).toContain("billed through the usage forwarder");
  });

  /**
   * The broker (`/api/public/integrations/secrets`) records a client's own
   * value `set`, which billing rates `byok`: that record is what stops the
   * recharge. A value set straight on the client's project bypasses it, and
   * the ledger keeps reading Aurixa's.
   */
  it("sends the client's own value through the Integrations page, never onto the project", () => {
    const hint = (status: string) =>
      platformCredentialRotations([{ name: "PERPLEXITY_API_KEY", status }])[0].hint;
    for (const status of PLATFORM_PAID_STATUSES) {
      expect(hint(status)).toContain(
        "enters its own value for PERPLEXITY_API_KEY on the clone's Integrations page. Mission Control's broker writes it and records it as the client's own (`set`), and that record is what stops the recharge.",
      );
      expect(hint(status)).toContain(
        "Never set it directly on the client's project: that bypasses the record, so the client's own calls go on being recharged as Aurixa's",
      );
      expect(hint(status)).not.toMatch(/set theirs|on the client's project, which replaces/);
    }
    expect(hint("inherited")).toContain(
      "The client's value then replaces Aurixa's on the project; record the clone's ledger reading `set` as evidence.",
    );
    expect(hint("minted")).toContain(
      "Once the clone's ledger reads `set`, revoke Aurixa's minted key at the vendor",
    );
    expect(hint("federated")).toContain("Once the clone's ledger reads `set`, end the federation");
  });

  it("promises the record the broker actually makes over each kind of platform key", () => {
    for (const existing of PLATFORM_PAID_STATUSES) {
      expect(integrationLedgerStatus({ unchanged: false, existing, isPlatformValue: false })).toBe(
        "set",
      );
    }
  });

  /**
   * Measured 30 Oct 2026: every clone's ledger carries these thirteen
   * platform rows, and the broker refuses one of them (`AIRTABLE_TABLE_NAME`,
   * the fleet's shared Listings configuration). A hint sending the client to
   * the Integrations page for it would send it to a page that answers no.
   */
  it("never sends anyone to the Integrations page for a name the broker refuses", () => {
    const measured = [
      ["AIRTABLE_TABLE_NAME", "inherited"],
      ["ANTHROPIC_API_KEY", "inherited"],
      ["DIDIT_FACE_MATCH_THRESHOLD", "inherited"],
      ["DIDIT_LIVENESS_THRESHOLD", "inherited"],
      ["DIDIT_WEBHOOK_SECRET", "inherited"],
      ["DIDIT_WORKFLOW_ID", "inherited"],
      ["FIRECRAWL_API_KEY", "inherited"],
      ["GITHUB_APP_ID", "inherited"],
      ["LOVABLE_API_KEY", "inherited"],
      ["OPENAI_API_KEY", "minted"],
      ["OPENROUTER_API_KEY", "minted"],
      ["PERPLEXITY_API_KEY", "inherited"],
      ["RESEND_API_KEY", "minted"],
    ].map(([name, status]) => ({ name, status }));
    const rows = platformCredentialRotations(measured).filter(
      (r) => r.key_ref !== `platform.${MISSION_CONTROL_LINK_SECRET}`,
    );
    expect(rows).toHaveLength(13);
    const refused: string[] = [];
    for (const row of rows) {
      const name = row.key_ref.slice("platform.".length);
      const accepted = tenantSecretRefusal(name) === null;
      if (!accepted) refused.push(name);
      expect(row.hint.includes("on the clone's Integrations page. Mission Control's broker")).toBe(
        accepted,
      );
      expect(row.hint.includes(`The client cannot bring its own value for ${name}`)).toBe(
        !accepted,
      );
      expect(row.hint).toContain(D6_KEEP_AND_BILL);
      expect(row.hint).toContain("By default it stays: mark this row skipped");
    }
    expect(refused).toEqual(["AIRTABLE_TABLE_NAME"]);
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
  const plan = fns.slice(
    fns.indexOf("export const planStandardRotations"),
    fns.indexOf("export const executeSecretRotation"),
  );

  it("adds the clone's platform credentials to the standard plan", () => {
    expect(plan).toContain("platformCredentialRotations(");
    expect(plan).toContain("...DEFAULT_ROTATION_PLAN,");
    expect(plan).toContain('.from("clone_backend_secrets")');
  });

  it("fails rather than planning without them when the ledger cannot be read", () => {
    expect(plan).toContain("if (lErr) throw new Error(");
  });
});
