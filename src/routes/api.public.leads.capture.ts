import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqualStr } from "@/server/cron-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  cleanLeadText,
  dedupeKeyFor,
  parseSubmission,
  type LeadStage,
  type ParsedLead,
  type ParsedStageUpdate,
} from "@/server/lead-capture.server";

/**
 * POST /api/public/leads/capture
 *
 * Priority-access funnel ingest — the tie-up between the Aurixa Systems
 * landing page and Mission Control. It accepts all three stages of the
 * funnel, told apart by the payload's `submissionType`:
 *
 *   Stage 1  Priority Access Application      → creates the lead
 *   Stage 2  Business Readiness Questionnaire → updates it
 *   Stage 3  Strategic Review booking         → updates it
 *
 * Stage 2 and Stage 3 find their lead by the public application reference
 * (`AX-XXXXXXXXXX`) issued at Stage 1, falling back to the applicant's email.
 * A stage submission whose applicant we have never seen still lands, as its
 * own row — an orphan booking an operator can act on beats a booking nobody
 * ever hears about.
 *
 * Two delivery paths feed each stage:
 *
 *  1. Browser dual-write: the site fires its Make.com webhook (→ Airtable)
 *     and, on success, also posts the same payload here (fire-and-forget,
 *     CORS-gated to the site's origins).
 *  2. Make.com forward: an HTTP module in the scenario posts the payload
 *     server-to-server with the `x-lead-capture-secret` header.
 *
 * Both paths can deliver the same submission; the dedupe key (hash of stage +
 * email + submittedAt) collapses them into a single row and a single
 * notification, which reaches operators live via Supabase realtime (bell +
 * /leads page + browser push).
 *
 * Auth model:
 *  - A request carrying a valid LEAD_CAPTURE_SECRET is always trusted.
 *  - Otherwise the request must come from an allow-listed browser Origin and
 *    passes strict validation plus per-IP and global rate limits.
 */

// Production origins only. `allowedOrigins()` APPENDS
// `LEAD_CAPTURE_ALLOWED_ORIGINS` to this list rather than replacing it, so a
// development origin left here is one no deployment can configure out. Local
// work sets that variable; see `.env.example`.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.aurixasystems.com.au",
  "https://aurixasystems.com.au",
];

// Unauthenticated-path rate limits (secret-bearing requests bypass these).
const PER_IP_LIMIT = 8; // submissions per IP per 10 minutes
const PER_IP_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_LIMIT = 300; // submissions per hour across all IPs
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

function allowedOrigins(): string[] {
  const extra = (process.env.LEAD_CAPTURE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && allowedOrigins().includes(origin.replace(/\/+$/, ""));
  return {
    "Access-Control-Allow-Origin": allowed ? origin! : DEFAULT_ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-lead-capture-secret, x-application-id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function hasValidSecret(request: Request): boolean {
  const secret = process.env.LEAD_CAPTURE_SECRET;
  if (!secret) return false;
  const header = request.headers.get("x-lead-capture-secret") ?? "";
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return (
    (header.length > 0 && timingSafeEqualStr(header, secret)) ||
    (bearer.length > 0 && timingSafeEqualStr(bearer, secret))
  );
}

async function checkLeadRateLimits(ip: string | null): Promise<{ ok: boolean; reason?: string }> {
  const globalSince = new Date(Date.now() - GLOBAL_WINDOW_MS).toISOString();
  const { count: globalCount } = await supabaseAdmin
    .from("waitlist_leads")
    .select("id", { count: "exact", head: true })
    .gte("created_at", globalSince);
  if ((globalCount ?? 0) >= GLOBAL_LIMIT) return { ok: false, reason: "global_rate_limited" };

  if (ip) {
    const ipSince = new Date(Date.now() - PER_IP_WINDOW_MS).toISOString();
    const { count: ipCount } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", ipSince)
      .contains("metadata", { ip });
    if ((ipCount ?? 0) >= PER_IP_LIMIT) return { ok: false, reason: "rate_limited" };
  }
  return { ok: true };
}

type Channel = "make_webhook" | "website";

/** What the `metadata` jsonb column accepts. */
type JsonRecord = { [key: string]: Json };

// Best effort — the lead row is the source of truth; a failed notification or
// audit entry must not fail (and re-trigger) the webhook delivery.
async function fanOutLeadCaptured(leadId: string, lead: ParsedLead, channel: Channel) {
  const entity = lead.entity_name
    ? `${lead.entity_name}${lead.entity_classification ? ` (${lead.entity_classification.replace(/_/g, " ")})` : ""}`
    : "Unknown entity";
  const volume = lead.transaction_volume ? ` · volume ${lead.transaction_volume}` : "";
  try {
    await supabaseAdmin.from("notifications").insert({
      kind: "lead_captured",
      severity: "success",
      title: `New waitlist lead: ${lead.first_name} ${lead.last_name}`,
      body: `${entity} · ${lead.email}${volume}`,
      url: "/leads",
      metadata: {
        lead_id: leadId,
        application_id: lead.application_id,
        email: lead.email,
        entity_classification: lead.entity_classification,
        transaction_volume: lead.transaction_volume,
        source: lead.source,
        stage: 1,
        channel,
      },
    });
  } catch (err) {
    console.error("lead_captured notification insert failed", err);
  }
  try {
    await supabaseAdmin.from("audit_log").insert({
      action: "lead.captured",
      entity_type: "waitlist_lead",
      entity_id: leadId,
      metadata: {
        email: lead.email,
        application_id: lead.application_id,
        source: lead.source,
        stage: 1,
        channel,
      },
    });
  } catch (err) {
    console.error("lead.captured audit insert failed", err);
  }
}

/**
 * Stage 2 / Stage 3 are the moments a lead stops being a name on a list, so
 * they get their own notification rather than folding into Stage 1's.
 */
async function fanOutStageAdvanced(
  leadId: string,
  update: ParsedStageUpdate,
  channel: Channel,
  orphaned: boolean,
) {
  const who = [update.first_name, update.last_name].filter(Boolean).join(" ") || update.email;
  const detail =
    update.stage === 2
      ? [update.columns.stage2_next_step, update.columns.stage2_investment]
          .filter(Boolean)
          .join(" · ")
      : [update.columns.stage3_session_start, update.columns.stage3_time_zone]
          .filter(Boolean)
          .join(" · ");
  const title = update.stage === 2 ? `Stage 2 complete: ${who}` : `Stage 3 review booked: ${who}`;

  try {
    await supabaseAdmin.from("notifications").insert({
      kind: update.stage === 2 ? "lead_stage_two" : "lead_stage_three",
      severity: update.stage === 3 ? "success" : "info",
      title,
      // An orphan means the Stage 1 row never arrived — the operator needs to
      // know that, because it points at a broken upstream delivery, not at a
      // new applicant.
      body: [update.email, detail, orphaned ? "no matching Stage 1 application" : ""]
        .filter(Boolean)
        .join(" · "),
      url: "/leads",
      metadata: {
        lead_id: leadId,
        application_id: update.application_id,
        email: update.email,
        stage: update.stage,
        orphaned,
        source: update.source,
        channel,
      },
    });
  } catch (err) {
    console.error("lead stage notification insert failed", err);
  }
  try {
    await supabaseAdmin.from("audit_log").insert({
      action: `lead.stage_${update.stage}`,
      entity_type: "waitlist_lead",
      entity_id: leadId,
      metadata: {
        email: update.email,
        application_id: update.application_id,
        orphaned,
        channel,
      },
    });
  } catch (err) {
    console.error("lead stage audit insert failed", err);
  }
}

/**
 * Finds the applicant a Stage 2 / Stage 3 submission belongs to.
 *
 * The application reference is the real key. Email is a fallback for
 * submissions made before references existed, or where the applicant reached
 * the stage without one — it can be wrong (shared inboxes), so it only ever
 * matches the most recent lead and never overwrites a reference we hold.
 */
async function findLeadForStage(update: ParsedStageUpdate) {
  if (update.application_id) {
    const { data } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id, stage, metadata")
      .eq("application_id", update.application_id)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabaseAdmin
    .from("waitlist_leads")
    .select("id, stage, metadata")
    .eq("email", update.email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export const Route = createFileRoute("/api/public/leads/capture")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) }),

      POST: async ({ request }) => {
        const origin = request.headers.get("origin");
        const trusted = hasValidSecret(request);

        if (!trusted) {
          // Browser path: only accept posts from the landing site's origins.
          const normalizedOrigin = (origin ?? "").replace(/\/+$/, "");
          if (!normalizedOrigin || !allowedOrigins().includes(normalizedOrigin)) {
            return json({ ok: false, error: "forbidden_origin" }, 403, origin);
          }
        }

        let payload: Record<string, unknown>;
        try {
          const parsed: unknown = await request.json();
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return json({ ok: false, error: "invalid_payload" }, 400, origin);
          }
          payload = parsed as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400, origin);
        }

        const submission = parseSubmission(payload);
        if ("error" in submission) {
          return json({ ok: false, error: submission.error }, 422, origin);
        }

        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        if (!trusted) {
          const rl = await checkLeadRateLimits(ip);
          if (!rl.ok) return json({ ok: false, error: rl.reason }, 429, origin);
        }

        const channel: Channel = trusted ? "make_webhook" : "website";
        const requestMetadata: JsonRecord = {
          channel,
          ...(ip ? { ip } : {}),
          user_agent: cleanLeadText(request.headers.get("user-agent"), 400) || null,
        };

        return submission.stage === 1
          ? captureStageOne(submission.lead, requestMetadata, channel, origin)
          : advanceStage(submission.update, requestMetadata, channel, origin);
      },
    },
  },
});

async function captureStageOne(
  lead: ParsedLead,
  requestMetadata: JsonRecord,
  channel: Channel,
  origin: string | null,
): Promise<Response> {
  const dedupe_key = dedupeKeyFor(lead, 1);
  const { data: inserted, error } = await supabaseAdmin
    .from("waitlist_leads")
    .insert({ ...lead, stage: 1, dedupe_key, metadata: requestMetadata })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation on dedupe_key or application_id → the same
    // submission already arrived via the other delivery path. That's success.
    if (error.code === "23505") {
      return json({ ok: true, duplicate: true }, 200, origin);
    }
    console.error("waitlist_leads insert failed", error);
    return json({ ok: false, error: "storage_failed" }, 500, origin);
  }

  await fanOutLeadCaptured(inserted.id, lead, channel);

  return json({ ok: true, lead_id: inserted.id, stage: 1, duplicate: false }, 201, origin);
}

async function advanceStage(
  update: ParsedStageUpdate,
  requestMetadata: JsonRecord,
  channel: Channel,
  origin: string | null,
): Promise<Response> {
  const existing = await findLeadForStage(update);
  const dedupe_key = dedupeKeyFor(update, update.stage);

  // Already recorded via the other delivery path.
  if (dedupe_key) {
    const { data: seen } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id")
      .eq("stage_dedupe_key", dedupe_key)
      .maybeSingle();
    if (seen) return json({ ok: true, duplicate: true, lead_id: seen.id }, 200, origin);
  }

  if (existing) {
    const { error } = await supabaseAdmin
      .from("waitlist_leads")
      .update({
        ...update.columns,
        // The furthest stage reached, never a step backwards: a Stage 2
        // correction arriving after Stage 3 must not un-book the review.
        stage: Math.max(Number(existing.stage ?? 1), update.stage) as LeadStage,
        stage_dedupe_key: dedupe_key,
        // Keep the reference if this stage supplied one we did not have.
        ...(update.application_id ? { application_id: update.application_id } : {}),
        metadata: {
          ...((existing.metadata as JsonRecord | null) ?? {}),
          [`stage${update.stage}`]: {
            ...requestMetadata,
            source: update.source,
            page: update.page,
          },
        },
      })
      .eq("id", existing.id);

    if (error) {
      console.error("waitlist_leads stage update failed", error);
      return json({ ok: false, error: "storage_failed" }, 500, origin);
    }

    await fanOutStageAdvanced(existing.id, update, channel, false);
    return json(
      { ok: true, lead_id: existing.id, stage: update.stage, matched: true },
      200,
      origin,
    );
  }

  // No Stage 1 row to attach to. Record it anyway: a strategic review that
  // nobody knows about is the worst outcome available here.
  const { data: inserted, error } = await supabaseAdmin
    .from("waitlist_leads")
    .insert({
      application_id: update.application_id,
      first_name: update.first_name || "Unknown",
      last_name: update.last_name,
      email: update.email,
      source: update.source,
      page: update.page,
      submitted_at: update.submitted_at,
      stage: update.stage,
      stage_dedupe_key: dedupe_key,
      ...update.columns,
      metadata: { ...requestMetadata, orphaned_stage: update.stage },
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return json({ ok: true, duplicate: true }, 200, origin);
    console.error("waitlist_leads orphan stage insert failed", error);
    return json({ ok: false, error: "storage_failed" }, 500, origin);
  }

  await fanOutStageAdvanced(inserted.id, update, channel, true);
  return json({ ok: true, lead_id: inserted.id, stage: update.stage, matched: false }, 201, origin);
}
