// How a settled stage-email row reads on screen.
//
// Pure and shared rather than local to the page, because a test that wants to
// know what an operator would SEE for a given row has otherwise to copy this
// out — and two copies of one rule is how the row and the page come to say
// different things about the same send.
import type { Database } from "@/integrations/supabase/types";

type StageEmailRow = Database["public"]["Tables"]["lead_stage_emails"]["Row"];

/**
 * Who a stage email actually reached, said in one line.
 *
 * `to_address` holds the FIRST recipient and nothing else, so on an internal
 * notification going to five people it renders one address — which reads as
 * "one person was told". The count is what the operator needs.
 *
 * `mailbox_fallback` is the one source worth naming here: it means the team
 * list was not configured and only the sending mailbox was told. It is drawn
 * from the row rather than from the current environment, because the row is
 * the record of what happened and the environment is only what would happen
 * next — and the settle rewrites both fields to the send that occurred, so a
 * row re-resolved at send time reads as the five it reached rather than the
 * one it was raised for.
 */
export function recipientReading(
  row: Pick<StageEmailRow, "recipients" | "to_address" | "recipient_source">,
): string | null {
  const list = Array.isArray(row.recipients) ? row.recipients.filter(Boolean) : [];
  const head = list[0] ?? row.to_address;
  if (!head) return null;
  const more = list.length > 1 ? ` +${list.length - 1}` : "";
  const note = row.recipient_source === "mailbox_fallback" ? " · sending mailbox only" : "";
  return `${head}${more}${note}`;
}
