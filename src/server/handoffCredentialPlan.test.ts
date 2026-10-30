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
 * The names a billable rate covers, as `api_provider_rates` read on 30 Oct
 * 2026: every key on every clone's plan, and none of the settings or the
 * shared secret beside them.
 */
const BILLED = new Set([
  "ANTHROPIC_API_KEY",
  "FIRECRAWL_API_KEY",
  "LOVABLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "RESEND_API_KEY",
]);

const planOf = (ledger: Array<{ name: string; status: string }>, billed = BILLED) =>
  platformCredentialRotations(ledger, billed);

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
    expect(planOf(ledger).map((r) => r.key_ref)).toEqual([
      "platform.ANTHROPIC_API_KEY",
      "platform.OPENAI_API_KEY",
      "platform.RESEND_API_KEY",
      `platform.${MISSION_CONTROL_LINK_SECRET}`,
    ]);
  });

  it("leaves out what the client brought and what never reached the clone", () => {
    const refs = planOf(ledger).map((r) => r.key_ref);
    for (const name of ["GOHIGHLEVEL_API_KEY_NEW", "VAPI_API_KEY", "GAMMA_API_KEY"]) {
      expect(refs).not.toContain(`platform.${name}`);
    }
  });

  it("plans the Mission Control link whatever its ledger says, once", () => {
    for (const status of ["failed", "missing", "set", "inherited"]) {
      const rows = planOf([{ name: MISSION_CONTROL_LINK_SECRET, status }]);
      expect(rows.map((r) => r.key_ref)).toEqual([`platform.${MISSION_CONTROL_LINK_SECRET}`]);
    }
    expect(planOf([])).toHaveLength(1);
  });

  it("is bookkeeping, so every row closes only on the operator's evidence", () => {
    for (const row of planOf(ledger)) {
      expect(row.target).toBe("other");
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
  it("keeps every billed key by default, and withdraws one only for the client's own value", () => {
    const keys = planOf(ledger).filter(
      (r) => r.key_ref !== `platform.${MISSION_CONTROL_LINK_SECRET}`,
    );
    expect(keys).toHaveLength(3);
    for (const row of keys) {
      const name = row.key_ref.slice("platform.".length);
      expect(row.hint).toContain(`It stays after handover (${D6_KEEP_AND_BILL}).`);
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
    const hint = (status: string) => planOf([{ name: "PERPLEXITY_API_KEY", status }])[0].hint;
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

  it("never sends anyone to the Integrations page for a billed name the broker refuses", () => {
    const [row] = planOf(
      [{ name: "AIRTABLE_TOKEN", status: "inherited" }],
      new Set(["AIRTABLE_TOKEN"]),
    );
    expect(tenantSecretRefusal("AIRTABLE_TOKEN")).not.toBeNull();
    expect(row.hint).toContain("The client cannot bring its own value for AIRTABLE_TOKEN");
    expect(row.hint).not.toContain("on the clone's Integrations page. Mission Control's broker");
  });

  it("never withdraws the Mission Control link by default, because billing reports through it", () => {
    const link = planOf(ledger).find(
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
    const rows = planOf([
      { name: "OPENAI_API_KEY", status: "inherited" },
      { name: "OPENAI_API_KEY", status: "inherited" },
    ]);
    expect(rows.filter((r) => r.key_ref === "platform.OPENAI_API_KEY")).toHaveLength(1);
  });
});

/**
 * Measured 30 Oct 2026: every clone's ledger carries these thirteen platform
 * rows. Seven are keys a billable rate covers; five are settings and one is a
 * secret every clone shares, and no rate bills any of those six. Each stays on
 * the plan, because the handover record names everything Aurixa supplied, and
 * none of the six may say it is billed.
 */
describe("what Aurixa supplied that nothing bills", () => {
  const MEASURED = [
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
  const SETTINGS = [
    "AIRTABLE_TABLE_NAME",
    "DIDIT_FACE_MATCH_THRESHOLD",
    "DIDIT_LIVENESS_THRESHOLD",
    "DIDIT_WORKFLOW_ID",
    "GITHUB_APP_ID",
  ];
  const hints = new Map(
    planOf(MEASURED).map((r) => [r.key_ref.slice("platform.".length), r.hint] as const),
  );
  const BILLED_SAYS = /kept and billed|billed through the usage forwarder|recharge/;

  it("keeps all thirteen on the plan", () => {
    expect([...hints.keys()].filter((n) => n !== MISSION_CONTROL_LINK_SECRET)).toEqual(
      MEASURED.map((m) => m.name),
    );
  });

  it("says a billed key is billed, and sends its client's own value through the broker", () => {
    for (const name of BILLED) {
      expect(hints.get(name)).toContain(D6_KEEP_AND_BILL);
      expect(hints.get(name)).toContain(
        "on the clone's Integrations page. Mission Control's broker",
      );
    }
  });

  it("says a setting is a setting, that nothing bills it, and that nothing is withdrawn", () => {
    for (const name of SETTINGS) {
      const hint = hints.get(name) ?? "";
      expect(hint).toContain(`${name} is a setting Aurixa supplied, not a credential:`);
      expect(hint).toContain("Nothing is billed on it.");
      expect(hint).toContain("At handover nothing is withdrawn:");
      expect(hint).toContain("Mark this row skipped, with evidence that the setting is kept.");
      expect(hint).not.toContain(D6_KEEP_AND_BILL);
      expect(hint).not.toMatch(BILLED_SAYS);
      expect(hint).not.toContain("enters its own value");
    }
    // Each says what it is.
    expect(hints.get("AIRTABLE_TABLE_NAME")).toContain(
      "every fleet pass keeps it in step with Mission Control's own, and the clone's Integrations page refuses it",
    );
    expect(hints.get("DIDIT_WORKFLOW_ID")).toContain(
      "the hosted-flow workflow of the fleet's shared Didit application",
    );
    expect(hints.get("GITHUB_APP_ID")).toContain(
      "what the app may reach is decided by its installation, never by its id",
    );
  });

  it("says the shared secret is shared fleet-wide, under audit item D3, and not billed", () => {
    const hint = hints.get("DIDIT_WEBHOOK_SECRET") ?? "";
    expect(hint).toContain(
      "DIDIT_WEBHOOK_SECRET is a secret shared by every clone, not one of this clone's own: it signs Didit's callbacks",
    );
    expect(hint).toContain(
      "so the client holds the value every other clone uses too: record that on this row",
    );
    expect(hint).toContain("Whether each clone gets its own is audit item D3");
    expect(hint).toContain("Nothing is billed on it.");
    expect(hint).not.toContain(D6_KEEP_AND_BILL);
    expect(hint).not.toMatch(BILLED_SAYS);
  });

  it("says what it can of a value no rate bills and nobody has named", () => {
    const [row] = planOf([{ name: "GOOGLE_MAPS_API_KEY", status: "inherited" }]);
    expect(row.hint).toContain(
      "GOOGLE_MAPS_API_KEY is a value Aurixa supplied that no rate bills: it has no billable row in api_provider_rates",
    );
    expect(row.hint).toContain(
      "the client may bring its own on the clone's Integrations page, never directly on the project",
    );
    expect(row.hint).not.toContain(D6_KEEP_AND_BILL);
    expect(row.hint).not.toMatch(/kept and billed|billed through/);
  });

  it("takes what is billed from the rate table alone", () => {
    // A setting a billable rate covered would be billed, and say so: the rate is the record.
    const [row] = planOf(
      [{ name: "GITHUB_APP_ID", status: "inherited" }],
      new Set(["GITHUB_APP_ID"]),
    );
    expect(row.hint).toContain(D6_KEEP_AND_BILL);
    // And a key no rate covers does not say it is billed.
    const [unrated] = planOf([{ name: "OPENAI_API_KEY", status: "minted" }], new Set());
    expect(unrated.hint).not.toContain(D6_KEEP_AND_BILL);
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

  it("reads what is billed from the rate table, and fails rather than guess", () => {
    const rates = plan.indexOf('.from("api_provider_rates")');
    expect(rates).toBeGreaterThan(-1);
    expect(plan.slice(rates, rates + 200)).toContain('.eq("is_billable", true)');
    expect(plan).toContain("if (rErr) throw new Error(");
    expect(plan.indexOf("platformCredentialRotations(")).toBeGreaterThan(rates);
  });
});
