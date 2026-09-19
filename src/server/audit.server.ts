// Writing down that something happened, and saying so when that fails.
//
// `audit_log` and `notifications` are the two tables this platform writes to
// purely so a person can find out what it did. Both were written the same way
// everywhere — a bare `await admin.from("…").insert({…})` with the result
// dropped on the floor — which means the one failure mode that matters, the
// record not being written, is also the one nothing reports.
//
// That is not hypothetical here. Three `notification_kind` values were being
// inserted that the enum had never contained (`handoff_consent_received`,
// `github_app_access_drift`, `api_usage_settlement_failed`). Postgres refused
// every one of those inserts, the discarded error meant nobody found out, and
// the operator notification that a client had just handed over their Supabase
// PAT and signed DPA had never once arrived.
//
// The type system now catches an unknown `kind` at compile time, which closes
// that particular door. These helpers close the general one: a write that fails
// is logged with the table, the action and the driver's message, so it shows up
// in the platform logs rather than nowhere. They still do not throw — an audit
// write must not take down the operation it is recording — but "best effort" and
// "silent" are different things, and only the first one was ever intended.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type NotificationKind = Database["public"]["Enums"]["notification_kind"];
type Json = Database["public"]["Tables"]["audit_log"]["Insert"]["metadata"];

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
};

export type OperatorNotification = {
  kind: NotificationKind;
  severity?: "info" | "success" | "warning" | "error";
  title: string;
  body?: string | null;
  cloneId?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
};

/** Record an operator action. Never throws; a failed write is logged. */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const { error } = await supabaseAdmin.from("audit_log").insert({
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    actor_user_id: entry.actorUserId ?? null,
    metadata: (entry.metadata ?? {}) as Json,
  });
  if (error) {
    console.error(
      `[audit] failed to record "${entry.action}" on ${entry.entityType}:`,
      error.message,
    );
  }
}

/** Raise an operator notification. Never throws; a failed write is logged. */
/**
 * Raises one operator notification, and says whether it LANDED.
 *
 * Swallowing the insert error stays: a notification is best-effort beside the
 * act it describes, and throwing here would fail the work over its own
 * reporting. Every existing caller ignores the answer and is unchanged.
 *
 * The boolean exists because a caller that DEDUPLICATES needs it. Anything
 * asking "have we already told them about this?" must key on a delivery, and a
 * caller that cannot tell a delivered notice from a swallowed one will record
 * the failed insert as proof that an operator was informed — which is a
 * permanent silence rather than a lost message.
 */
export async function notifyOperators(input: OperatorNotification): Promise<boolean> {
  const { error } = await supabaseAdmin.from("notifications").insert({
    kind: input.kind,
    severity: input.severity ?? "info",
    title: input.title,
    body: input.body ?? null,
    clone_id: input.cloneId ?? null,
    url: input.url ?? null,
    metadata: (input.metadata ?? {}) as Json,
  });
  if (error) {
    console.error(`[notify] failed to raise "${input.kind}" (${input.title}):`, error.message);
    return false;
  }
  return true;
}
