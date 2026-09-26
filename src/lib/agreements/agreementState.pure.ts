// What an agreement's status reads as on screen: the word, its colour and
// its row spine. One place, so the list and the offer page cannot describe
// the same row two ways.
import { sendClaimState } from "./subscriptionIssue.pure";

export type AgreementTone = "neutral" | "info" | "success" | "warning" | "destructive";
export type AgreementSpine = "ok" | "warn" | "bad" | "live" | "idle";

export type AgreementState = { label: string; tone: AgreementTone; spine: AgreementSpine };

const BY_STATUS: Readonly<Record<string, Omit<AgreementState, "label">>> = {
  draft: { tone: "neutral", spine: "idle" },
  sent: { tone: "info", spine: "live" },
  delivered: { tone: "info", spine: "live" },
  signed: { tone: "success", spine: "ok" },
  declined: { tone: "destructive", spine: "bad" },
  voided: { tone: "warning", spine: "warn" },
};

/**
 * A subscription draft that has been claimed for sending is not an ordinary
 * draft: either the send is still running, or it stopped part-way and
 * pressing Send on the offer page finishes it. Everything else reads its
 * status.
 */
export function agreementState(
  row: {
    document_kind: string;
    status: string;
    issued_at: string | null;
    docusign_envelope_id: string | null;
  },
  now: number,
): AgreementState {
  if (row.document_kind === "subscription" && row.status === "draft") {
    const claim = sendClaimState(row, now);
    if (claim === "in_flight") return { label: "sending", tone: "info", spine: "live" };
    if (claim === "stale") return { label: "send interrupted", tone: "warning", spine: "warn" };
  }
  return { label: row.status, ...(BY_STATUS[row.status] ?? { tone: "neutral", spine: "idle" }) };
}
