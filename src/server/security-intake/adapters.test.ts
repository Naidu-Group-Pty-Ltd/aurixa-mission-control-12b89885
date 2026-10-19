// A partner's status change goes through the same triage rules as a person's:
// unknown words are refused, decided findings need a reason, a credential is
// only resolved as rotated, and every change is recorded on the finding.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Call = { table: string; op: string; values?: Row; filters: Array<[string, unknown]> };

const db = vi.hoisted(() => ({
  finding: null as Row | null,
  readError: null as { message: string } | null,
  updateResults: [] as Array<{
    data: Row[] | null;
    error: { code?: string; message: string } | null;
  }>,
  ticketRows: [{ id: "t1" }] as Row[],
  calls: [] as Array<{
    table: string;
    op: string;
    values?: Row;
    filters: Array<[string, unknown]>;
  }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    db.calls.push(call);
    const b: Record<string, unknown> = {
      select: () => b,
      update: (values: Row) => {
        call.op = "update";
        call.values = { ...values }; // the adapter trims and resends the same object
        return b;
      },
      insert: async (values: Row) => {
        call.op = "insert";
        call.values = values;
        return { error: null };
      },
      eq: (col: string, v: unknown) => {
        call.filters.push([col, v]);
        return b;
      },
      maybeSingle: async () => ({ data: db.finding, error: db.readError }),
      then: (resolve: (v: unknown) => void) => {
        // An awaited update(...).eq(...).select(...)
        if (table === "security_external_tickets")
          return resolve({ data: db.ticketRows, error: null });
        return resolve(db.updateResults.shift() ?? { data: [{ id: "f1" }], error: null });
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

import { IntakeStatusError, adapterFor, type IntakeSource } from "./adapters";

const source = (over: Partial<IntakeSource> = {}): IntakeSource => ({
  slug: "acme",
  name: "Acme Pentest",
  kind: "generic",
  hmac_secret: null,
  active: true,
  metadata: {},
  ...over,
});

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as IntakeStatusError;
  }
  throw new Error("expected a refusal");
};

beforeEach(() => {
  db.finding = { id: "f1", state: "open", scanner: "semgrep" };
  db.readError = null;
  db.updateResults = [];
  db.ticketRows = [{ id: "t1" }];
  db.calls = [];
});

const updates = () => db.calls.filter((c) => c.op === "update");
const events = () =>
  db.calls.filter((c) => c.table === "codex_finding_events" && c.op === "insert");

describe("a partner's status change", () => {
  it("refuses a word it does not know, without touching the finding", async () => {
    const e = await refused(adapterFor(source()).updateStatus("X-1", "maybe later", source()));
    expect(e.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it("answers 404 for a finding the partner does not own", async () => {
    db.finding = null;
    const e = await refused(adapterFor(source()).updateStatus("X-1", "fixed", source()));
    expect(e.status).toBe(404);
    // Looked up under the partner's own prefix only.
    expect(db.calls[0].filters).toContainEqual(["codex_finding_id", "acme:X-1"]);
  });

  it("treats re-sending the current status as a no-op", async () => {
    db.finding = { id: "f1", state: "dismissed", scanner: "semgrep" };
    await expect(
      adapterFor(source()).updateStatus("X-1", "accepted risk", source()),
    ).resolves.toEqual({
      changed: false,
      from: "dismissed",
      to: "dismissed",
    });
    expect(updates()).toHaveLength(0);
  });

  it("dismisses with the partner's reason, only from the state it read, and records it", async () => {
    const r = await adapterFor(source()).updateStatus(
      "X-1",
      "wont fix",
      source(),
      "Internal tool only",
    );
    expect(r).toEqual({ changed: true, from: "open", to: "dismissed" });
    const [u] = updates();
    expect(u.values).toMatchObject({ state: "dismissed", triage_reason: "Internal tool only" });
    expect(u.filters).toEqual([
      ["id", "f1"],
      ["state", "open"],
    ]);
    expect(events()[0].values).toMatchObject({
      finding_id: "f1",
      event_type: "intake.status",
      from_state: "open",
      to_state: "dismissed",
      reason: "Internal tool only",
    });
  });

  it("names the partner as the reason when it gave none", async () => {
    await adapterFor(source()).updateStatus("X-1", "false positive", source());
    expect(updates()[0].values).toMatchObject({
      state: "false_positive",
      triage_reason: "Marked false positive by Acme Pentest through the intake API.",
    });
  });

  it("will not resolve a credential on a plain 'fixed'", async () => {
    db.finding = { id: "f1", state: "open", scanner: "gitleaks" };
    const e = await refused(adapterFor(source()).updateStatus("X-1", "fixed", source()));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/rotated/);
    expect(updates()).toHaveLength(0);
  });

  it("resolves a credential the partner says was rotated", async () => {
    db.finding = { id: "f1", state: "open", scanner: "gitleaks" };
    await adapterFor(source()).updateStatus("X-1", "rotated", source());
    expect(updates()[0].values).toMatchObject({ state: "resolved", resolution: "rotated" });
  });

  it("will not move a finding whose fix PR is in flight to resolved", async () => {
    db.finding = { id: "f1", state: "pr_open", scanner: "semgrep" };
    const e = await refused(adapterFor(source()).updateStatus("X-1", "fixed", source()));
    expect(e.status).toBe(409);
  });

  it("loses to a concurrent change instead of overwriting it", async () => {
    db.updateResults = [{ data: [], error: null }];
    const e = await refused(adapterFor(source()).updateStatus("X-1", "triage", source()));
    expect(e.status).toBe(409);
    expect(events()).toHaveLength(0);
  });

  it("still works before the triage columns exist", async () => {
    db.updateResults = [
      { data: null, error: { code: "42703", message: 'column "triage_reason" does not exist' } },
      { data: [{ id: "f1" }], error: null },
    ];
    await adapterFor(source()).updateStatus("X-1", "fixed", source(), "Patched in 2.4.1");
    const [first, second] = updates();
    expect(first.values).toHaveProperty("triage_reason");
    expect(second.values).not.toHaveProperty("triage_reason");
    expect(second.values).not.toHaveProperty("resolution");
    expect(second.values).toMatchObject({ state: "resolved" });
  });
});

describe("a ticketing partner's status change", () => {
  it("updates its ticket and never the finding", async () => {
    const ticketing = source({ kind: "ticketing", slug: "jira" });
    await expect(adapterFor(ticketing).updateStatus("SEC-9", "Done", ticketing)).resolves.toEqual({
      changed: true,
      to: "Done",
    });
    expect(db.calls.map((c) => c.table)).toEqual(["security_external_tickets"]);
  });

  it("answers 404 for a ticket it never linked", async () => {
    db.ticketRows = [];
    const ticketing = source({ kind: "ticketing", slug: "jira" });
    const e = await refused(adapterFor(ticketing).updateStatus("SEC-9", "Done", ticketing));
    expect(e.status).toBe(404);
  });
});
