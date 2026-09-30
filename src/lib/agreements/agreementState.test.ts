import { describe, expect, it } from "vitest";
import { agreementState } from "./agreementState.pure";
import { STALE_SEND_CLAIM_MS } from "./subscriptionIssue.pure";

const NOW = Date.parse("2026-09-25T03:00:00.000Z");
const row = (over: Partial<Parameters<typeof agreementState>[0]> = {}) => ({
  document_kind: "subscription",
  status: "draft",
  issued_at: null,
  docusign_envelope_id: null,
  ...over,
});

describe("what an agreement's status reads as", () => {
  it("reads an unclaimed draft as a draft", () => {
    expect(agreementState(row(), NOW)).toEqual({ label: "draft", tone: "neutral", spine: "idle" });
  });

  it("tells a send that is running from one that stopped part-way", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const stale = new Date(NOW - STALE_SEND_CLAIM_MS - 1).toISOString();
    expect(agreementState(row({ issued_at: fresh }), NOW).label).toBe("sending");
    expect(agreementState(row({ issued_at: stale }), NOW)).toEqual({
      label: "send interrupted",
      tone: "warning",
      spine: "warn",
    });
  });

  it("never reads an SLA's status through the subscription send claim", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    expect(agreementState(row({ document_kind: "sla", issued_at: fresh }), NOW).label).toBe(
      "draft",
    );
  });

  it("colours each lifecycle status, and an unknown one neutrally", () => {
    const out = row({ status: "sent", docusign_envelope_id: "env", issued_at: "x" });
    expect(agreementState(out, NOW)).toEqual({ label: "sent", tone: "info", spine: "live" });
    expect(agreementState(row({ status: "signed", docusign_envelope_id: "e" }), NOW).tone).toBe(
      "success",
    );
    expect(agreementState(row({ status: "declined" }), NOW).spine).toBe("bad");
    expect(agreementState(row({ status: "voided" }), NOW).tone).toBe("warning");
    expect(agreementState(row({ status: "archived" }), NOW)).toEqual({
      label: "archived",
      tone: "neutral",
      spine: "idle",
    });
  });
});
