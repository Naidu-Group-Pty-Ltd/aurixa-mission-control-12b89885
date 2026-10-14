/**
 * Unsubscribing, behind both kinds of link a campaign message can carry.
 *
 * A message to ONE contact carries that contact's own token (`?t=`), good for
 * exactly one address: the page names it and one click removes it.
 *
 * A message to SEVERAL contacts cannot — forty people in one BCC line cannot
 * share one person's link — so it carries the campaign's shared token
 * (`?c=`), and the reader types the address the message reached them at. Two
 * rules make that safe to put in front of anybody holding the email:
 *
 * - **Only an address the campaign has is removed.** The token says which
 *   campaign; the address must be one of its recipients. A forwarded copy, or
 *   somebody typing addresses at random, removes nobody else from anything.
 * - **The answer is the same either way.** "If that address received this
 *   email, it has been removed" — so the page cannot be used to learn who is
 *   on a list.
 *
 * Both write the one register the bounce scan writes to, so an unsubscribe
 * stops every campaign, now and later, and pending sends stop immediately.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { emailKey } from "@/lib/email/emailAddress.pure";

/** Both token kinds are 64 hex characters as minted; a little latitude either side. */
const TOKEN_SHAPE = /^[a-f0-9]{16,128}$/i;

/** A token as it arrived, or null when it cannot be one. */
export function readLinkToken(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return value && TOKEN_SHAPE.test(value) ? value.toLowerCase() : null;
}

export type UnsubscribeTarget = { email: string; email_key: string; campaign_id: string };

/**
 * Put an address on the register and stop its pending sends in every
 * campaign. False when the register write failed — the caller must not say
 * the address was removed.
 */
export async function suppressAddress(target: UnsubscribeTarget, detail: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("email_suppressions").upsert(
    {
      email_key: target.email_key,
      email: target.email,
      reason: "unsubscribed",
      detail,
      source: "unsubscribe_link",
      campaign_id: target.campaign_id,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "email_key" },
  );
  if (error) {
    console.error("[email] unsubscribe write failed:", error.message);
    return false;
  }

  // Every campaign, immediately — including ones this person has not been
  // mailed by yet.
  const { error: stopError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "suppressed", suppressed_reason: "unsubscribed" })
    .eq("email_key", target.email_key)
    .eq("status", "pending");
  if (stopError) {
    console.error("[email] could not stop pending sends after unsubscribe:", stopError.message);
  }
  return true;
}

/** The campaign a shared link names, or null when it names none. */
export async function campaignForLink(token: string): Promise<{ id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("id")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  if (error) {
    console.error("[email] shared unsubscribe lookup failed:", error.message);
    return null;
  }
  return (data as { id: string } | null) ?? null;
}

export type SharedLinkOutcome =
  /** Done, or nothing to do — deliberately the same answer to the reader. */
  { kind: "accepted"; address: string } | { kind: "invalid_address" } | { kind: "failed" };

/**
 * A reader of a campaign's message, through its shared link, asking to stop.
 * Removes the address only if the campaign has it, and answers `accepted`
 * whether it did or not.
 */
export async function unsubscribeThroughCampaign(
  campaignId: string,
  typed: string,
): Promise<SharedLinkOutcome> {
  const key = emailKey(typed);
  if (!key) return { kind: "invalid_address" };

  const { data, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("email, email_key, campaign_id")
    .eq("campaign_id", campaignId)
    .eq("email_key", key)
    .maybeSingle();
  if (error) {
    console.error("[email] shared unsubscribe recipient lookup failed:", error.message);
    return { kind: "failed" };
  }
  const recipient = data as UnsubscribeTarget | null;
  if (!recipient) return { kind: "accepted", address: key };

  const done = await suppressAddress(
    recipient,
    "requested through the campaign's shared unsubscribe link",
  );
  return done ? { kind: "accepted", address: key } : { kind: "failed" };
}
