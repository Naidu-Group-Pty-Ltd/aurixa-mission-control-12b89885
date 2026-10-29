/**
 * A Stage 1 application that arrives again under a reference we already hold
 * (docs/LEAD_EMAILS.md, "Address corrections").
 *
 * Either it is the same application delivered twice — the answer is
 * `duplicate`, as it always was — or it is the applicant correcting the
 * address they mistyped, from the website's confirmation screen. A correction
 * re-addresses the lead and moves its applicant emails to the next address
 * generation, so the Stage 1 email is owed again, at the address they meant:
 *
 *   - the lead's Stage 1 answers are what the applicant sent now;
 *   - an applicant email still waiting for the old address is settled
 *     `skipped`, superseded; one already sent keeps saying where it went;
 *   - every questionnaire link minted for the old address stops opening — it
 *     was mailed to somebody who is not the applicant;
 *   - it is audited and the team is told, from and to.
 *
 * The caller then raises the stage emails as for any new application.
 *
 * Only the browser that made the application may correct it: the 201 that
 * accepted it carried a one-time token (`mintCorrectionToken`), whose hash is
 * kept on the lead, and the correction presents it. The reference alone is
 * printed in the email that went to the mistyped address.
 */
import crypto from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { dedupeKeyFor, type ParsedLead } from "@/server/lead-capture.server";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { timingSafeEqualStr } from "@/server/cron-auth.server";
import {
  decideAddressCorrection,
  REFUSAL_TEXT,
  SUPERSEDED_REASON,
  type CorrectionRefusal,
} from "@/server/leadAddressCorrection.pure";

type JsonRecord = { [key: string]: Json };

export type StageOneConflict =
  /** The same application, delivered again. Nothing changes. */
  | { kind: "duplicate"; leadId: string | null }
  | {
      kind: "corrected";
      leadId: string;
      from: string;
      to: string;
      generation: number;
      superseded: number;
      linksRevoked: number;
    }
  | { kind: "refused"; leadId: string; reason: CorrectionRefusal }
  /** Mission Control could not tell which, or could not write it. Never "duplicate". */
  | { kind: "unavailable"; error: string };

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** Where the correction token's hash is kept: the lead's own metadata. */
export const CORRECTION_TOKEN_KEY = "correction_token_sha256";

/** The token the applying browser is handed, and the hash the lead keeps. */
export function mintCorrectionToken(): { token: string; sha256: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, sha256: sha256(token) };
}

function presentsToken(metadata: unknown, token: string | null): boolean {
  const stored = (metadata as Record<string, unknown> | null)?.[CORRECTION_TOKEN_KEY];
  if (typeof stored !== "string" || !token || token.length > 128) return false;
  return timingSafeEqualStr(sha256(token), stored);
}

const minutesBetween = (from: string | null | undefined, to: number) => {
  const at = Date.parse(from ?? "");
  return Number.isFinite(at) ? Math.max(0, Math.round((to - at) / 60_000)) : null;
};

export async function resolveStageOneConflict(input: {
  lead: ParsedLead;
  channel: string;
  /** What the website sent back of the token its 201 carried. */
  correctionToken: string | null;
  /** A request carrying LEAD_CAPTURE_SECRET speaks for the funnel itself. */
  trusted: boolean;
  now?: number;
}): Promise<StageOneConflict> {
  // Two corrections racing each other: the one whose update lost is decided
  // again against the lead as the winner left it, rather than told it landed.
  const first = await attemptResolution(input);
  return first.kind === "raced" ? normalise(await attemptResolution(input)) : first;
}

const normalise = (result: StageOneConflict | { kind: "raced"; leadId: string }) =>
  result.kind === "raced"
    ? ({
        kind: "unavailable",
        error: "the lead changed twice while this correction was read",
      } as const)
    : result;

async function attemptResolution(input: {
  lead: ParsedLead;
  channel: string;
  correctionToken: string | null;
  trusted: boolean;
  now?: number;
}): Promise<StageOneConflict | { kind: "raced"; leadId: string }> {
  const { lead, channel } = input;
  const now = input.now ?? Date.now();
  // Without a reference the conflict was the dedupe key: the same submission.
  if (!lead.application_id) return { kind: "duplicate", leadId: null };

  const { data: existing, error: readError } = await supabaseAdmin
    .from("waitlist_leads")
    .select("*")
    .eq("application_id", lead.application_id)
    .maybeSingle();
  // A failed read is not a duplicate: answering one would tell the website a
  // correction landed that nobody looked at.
  if (readError) return { kind: "unavailable", error: readError.message };
  if (!existing) return { kind: "duplicate", leadId: null };

  const decision = decideAddressCorrection(
    existing,
    {
      email: lead.email,
      submittedAt: lead.submitted_at,
      verified: input.trusted || presentsToken(existing.metadata, input.correctionToken),
    },
    now,
  );
  if (decision.kind === "same_address" || decision.kind === "stale") {
    return { kind: "duplicate", leadId: existing.id };
  }

  const who = `${existing.application_id} (${[existing.first_name, existing.last_name].filter(Boolean).join(" ")}${existing.entity_name ? `, ${existing.entity_name}` : ""})`;

  if (decision.kind === "refused" && decision.reason === "unverified") {
    // Somebody holding the reference, not the applicant's browser: recorded,
    // and nothing else. The team is not told — a notice per attempt is a
    // notice anybody could raise — and the route rate limits the attempts.
    await writeAuditLog({
      actorUserId: null,
      action: "lead.address_correction_refused",
      entityType: "waitlist_lead",
      entityId: existing.id,
      metadata: { application_id: existing.application_id, reason: decision.reason, channel },
    });
    return { kind: "refused", leadId: existing.id, reason: decision.reason };
  }

  if (decision.kind === "refused") {
    await writeAuditLog({
      actorUserId: null,
      action: "lead.address_correction_refused",
      entityType: "waitlist_lead",
      entityId: existing.id,
      metadata: {
        application_id: existing.application_id,
        from: decision.from,
        to: decision.to,
        reason: decision.reason,
        channel,
      },
    });
    await notifyOperators({
      kind: "lead_address_correction_refused",
      severity: "warning",
      title: "An applicant could not correct their email address",
      body: `${who} asked to change their address from ${decision.from} to ${decision.to}, and it was not changed: ${REFUSAL_TEXT[decision.reason]}. Their emails still go to ${decision.from}; reach them at ${decision.to} if it is theirs.`,
      url: "/leads",
      metadata: {
        lead_id: existing.id,
        application_id: existing.application_id,
        from: decision.from,
        to: decision.to,
        reason: decision.reason,
      },
    });
    return { kind: "refused", leadId: existing.id, reason: decision.reason };
  }

  // The application as the applicant now sends it. `source` and `page` say how
  // the lead first reached us, and the reference is the key it was found by.
  const { application_id: _reference, source: _source, page: _page, ...answers } = lead;
  const previous = (existing.metadata as JsonRecord | null) ?? {};
  const history = Array.isArray(previous.email_corrections) ? previous.email_corrections : [];
  const at = new Date(now).toISOString();

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("waitlist_leads")
    .update({
      ...answers,
      dedupe_key: dedupeKeyFor(lead, 1),
      applicant_email_generation: decision.generation,
      metadata: {
        ...previous,
        email_corrections: [
          ...history,
          { from: decision.from, to: decision.to, at, channel, generation: decision.generation },
        ],
      },
    })
    .eq("id", existing.id)
    // The generation read above: two corrections racing each other cannot
    // both move the lead on. The one that lost is decided again.
    .eq("applicant_email_generation", decision.generation - 1)
    .select("id");
  if (updateError) return { kind: "unavailable", error: updateError.message };
  if (!updated?.length) return { kind: "raced", leadId: existing.id };

  // Only a WAITING email is settled here. One the dispatcher holds right now
  // finishes and says where it went; if it is re-claimed later, the dispatcher
  // finds its generation is no longer the lead's and settles it the same way.
  const { data: superseded, error: supersedeError } = await supabaseAdmin
    .from("lead_stage_emails")
    .update({ status: "skipped", reason: SUPERSEDED_REASON })
    .eq("lead_id", existing.id)
    .eq("audience", "applicant")
    .eq("status", "pending")
    .lt("generation", decision.generation)
    .select("id");
  if (supersedeError) {
    console.error(
      "[lead-address-correction] could not settle superseded emails:",
      supersedeError.message,
    );
  }

  const { data: revoked, error: revokeError } = await supabaseAdmin
    .from("lead_questionnaire_links")
    .update({ expires_at: at })
    .eq("lead_id", existing.id)
    .gt("expires_at", at)
    .select("id");
  if (revokeError) {
    console.error(
      "[lead-address-correction] could not close the old questionnaire links:",
      revokeError.message,
    );
  }

  const result: StageOneConflict = {
    kind: "corrected",
    leadId: existing.id,
    from: decision.from,
    to: decision.to,
    generation: decision.generation,
    superseded: superseded?.length ?? 0,
    linksRevoked: revoked?.length ?? 0,
  };

  await writeAuditLog({
    actorUserId: null,
    action: "lead.address_corrected",
    entityType: "waitlist_lead",
    entityId: existing.id,
    metadata: {
      application_id: existing.application_id,
      from: decision.from,
      to: decision.to,
      generation: decision.generation,
      superseded: result.superseded,
      links_revoked: result.linksRevoked,
      // Said rather than implied: a failed write here is not "none".
      ...(supersedeError ? { supersede_error: supersedeError.message } : {}),
      ...(revokeError ? { revoke_error: revokeError.message } : {}),
      channel,
    },
  });
  const minutes = minutesBetween(existing.created_at, now);
  await notifyOperators({
    kind: "lead_address_corrected",
    severity: revokeError ? "warning" : "info",
    title: `An applicant corrected their email address: ${[existing.first_name, existing.last_name].filter(Boolean).join(" ") || existing.application_id}`,
    body: [
      `${who} changed their address from ${decision.from} to ${decision.to}${minutes === null ? "" : `, ${minutes} minute${minutes === 1 ? "" : "s"} after applying`}.`,
      "The Stage 1 email goes to the new address.",
      revokeError
        ? `The questionnaire link sent to ${decision.from} could NOT be closed (${revokeError.message}).`
        : "The questionnaire link sent to the old address no longer opens.",
    ].join(" "),
    url: "/leads",
    metadata: {
      lead_id: existing.id,
      application_id: existing.application_id,
      from: decision.from,
      to: decision.to,
      generation: decision.generation,
    },
  });
  return result;
}
