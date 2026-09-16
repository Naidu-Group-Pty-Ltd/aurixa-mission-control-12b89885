// Voice operations — the heavy lifting behind the webhook, the drain and the
// dispatcher. Route files are shells; everything with a consequence is here.
//
// Three pure functions (normalizePhone, applyQuietHours, computeScheduledAt)
// are exported for tests: they are the scheduling brain the Make scenarios
// never had, and a wrong shift here dials a client at 3am.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { CALL_INTENTS } from "@/lib/voice-vocab";

type VoiceTriggerType = Database["public"]["Enums"]["voice_trigger_type"];
type CampaignRule = Database["public"]["Tables"]["voice_campaign_rules"]["Row"];
type OutboundJob = Database["public"]["Tables"]["voice_outbound_jobs"]["Row"];

const VAPI_BASE = "https://api.vapi.ai";

/* ------------------------------ pure helpers ------------------------------ */

/** Digits-plus-leading-plus. `0412 345 678` and `+61412345678` compare equal on the last 9. */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const kept = raw.replace(/[^\d+]/g, "");
  return kept.startsWith("+") ? "+" + kept.slice(1).replace(/\D/g, "") : kept.replace(/\D/g, "");
}

/**
 * The E.164 form a telephony provider will accept, for the dial boundary only.
 *
 * `normalizePhone` deliberately does NOT do this: it is the matching function,
 * and `phonesMatch` compares the last nine digits precisely so that
 * `0412 345 678` and `+61412345678` are the same person. Rewriting its output
 * would also change `voice_blacklist.normalized_number` comparisons and the
 * stored `voice_call_context.normalized_phone`, which is a much larger blast
 * radius than the problem.
 *
 * The problem is narrow and real: `dispatchOne` sends `customer.number` to
 * VAPI verbatim, so a contact stored as `(02) 8609-3299` dials as
 * `0286093299` — which has no country code and is rejected. The rejection
 * surfaces as a retried then failed job and an operator push, never as a
 * validation error naming the number.
 *
 * **An unrecognised shape is passed through untouched.** Guessing a country
 * code for a number this does not recognise would dial a stranger; letting
 * the provider refuse it keeps the failure honest and attributable.
 */
export function toE164AU(raw: string | null | undefined): string {
  const n = normalizePhone(raw);
  if (!n) return "";
  if (n.startsWith("+")) return n;
  // 0412345678 / 0286093299 — a national number with the trunk prefix.
  if (/^0\d{9}$/.test(n)) return "+61" + n.slice(1);
  // 61412345678 — the country code already present, the plus lost in storage.
  if (/^61\d{9}$/.test(n)) return "+" + n;
  return n;
}

/** True when two numbers agree on their last nine digits (AU national significance). */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a).replace(/\D/g, "");
  const nb = normalizePhone(b).replace(/\D/g, "");
  if (na.length < 8 || nb.length < 8) return false;
  return na.slice(-9) === nb.slice(-9);
}

export type QuietHours = {
  timezone?: string;
  start?: string; // "HH:MM"
  end?: string; // "HH:MM"
  days?: number[]; // JS getDay() convention: 0 = Sunday
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = WEEKDAY_INDEX[get("weekday")] ?? 0;
  // "24" appears for midnight in some ICU versions; normalise to 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { day, minutes: hour * 60 + minute };
}

function parseHHMM(value: string | undefined, fallback: number): number {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return fallback;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Shift a time forward until it lands inside the calling window. Stepping in
 * five-minute increments avoids reconstructing zoned wall-clock timestamps by
 * hand (the classic DST bug); at most a week is scanned.
 */
export function applyQuietHours(date: Date, quiet: QuietHours | null | undefined): Date {
  if (!quiet) return date;
  const tz = quiet.timezone ?? "Australia/Sydney";
  const startMin = parseHHMM(quiet.start, 8 * 60);
  const endMin = parseHHMM(quiet.end, 20 * 60);
  const days = quiet.days && quiet.days.length > 0 ? quiet.days : [1, 2, 3, 4, 5, 6];
  if (endMin <= startMin) return date;

  const stepMs = 5 * 60 * 1000;
  const maxSteps = (7 * 24 * 60) / 5;
  let candidate = date;
  for (let i = 0; i <= maxSteps; i++) {
    let parts: { day: number; minutes: number };
    try {
      parts = zonedParts(candidate, tz);
    } catch {
      return date; // an invalid timezone must never block a dial
    }
    if (days.includes(parts.day) && parts.minutes >= startMin && parts.minutes < endMin) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + stepMs);
  }
  return date;
}

/**
 * When a job should dial: the rule's anchor (trigger event or appointment
 * start) plus its offset, no earlier than now, shifted into the quiet-hours
 * window. Returns the expiry too, since it hangs off the same anchor.
 */
export function computeScheduledAt(
  rule: Pick<
    CampaignRule,
    "schedule_anchor" | "delay_seconds" | "anchor_offset_seconds" | "expiry_seconds" | "quiet_hours"
  >,
  opts: { now?: Date; eventAt?: Date; appointmentAt?: Date | null },
): { scheduledAt: Date; expiresAt: Date | null } {
  const now = opts.now ?? new Date();
  const eventAt = opts.eventAt ?? now;
  let base: Date;
  if (rule.schedule_anchor === "appointment" && opts.appointmentAt) {
    base = new Date(opts.appointmentAt.getTime() + rule.anchor_offset_seconds * 1000);
  } else {
    base = new Date(eventAt.getTime() + rule.delay_seconds * 1000);
  }
  if (base.getTime() < now.getTime()) base = now;
  const shifted = applyQuietHours(base, rule.quiet_hours as QuietHours | null);
  const expiresAt =
    rule.expiry_seconds != null ? new Date(shifted.getTime() + rule.expiry_seconds * 1000) : null;
  return { scheduledAt: shifted, expiresAt };
}

/** One live job per (trigger, subject, anchor) — the dedupe unique index key. */
export function buildDedupeKey(
  trigger: VoiceTriggerType,
  subjectId: string,
  anchorIso?: string | null,
): string {
  return anchorIso ? `${trigger}:${subjectId}:${anchorIso}` : `${trigger}:${subjectId}`;
}

/** The canonical variable set every Make scenario passed to VAPI. */
export function buildVariableValues(input: {
  fullName?: string | null;
  firstName?: string | null;
  phone: string;
  contactId?: string | null;
  defaults?: Record<string, unknown>;
  extras?: Record<string, unknown>;
  now?: Date;
}): Record<string, unknown> {
  const now = input.now ?? new Date();
  const fullName = input.fullName ?? "";
  const firstName = input.firstName ?? (fullName ? fullName.split(/\s+/)[0] : "");
  const values: Record<string, unknown> = {
    fullName,
    firstName,
    phone: input.phone,
    contactId: input.contactId ?? "",
    currentDate: now.toISOString(),
    currentDateUnix: Math.floor(now.getTime() / 1000),
    ...(input.defaults ?? {}),
    ...(input.extras ?? {}),
  };
  // Templates in variable_defaults use {fullName} / {firstName} placeholders.
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string") {
      values[k] = v.replaceAll("{fullName}", fullName).replaceAll("{firstName}", firstName);
    }
  }
  return values;
}

/* -------------------------------- VAPI API -------------------------------- */

export async function vapiFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new Error("vapi_api_key_not_configured");
  return fetch(`${VAPI_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/* ----------------------------- outbound enqueue ---------------------------- */

export type EnqueueOutboundInput = {
  triggerType: VoiceTriggerType;
  phone: string;
  fullName?: string | null;
  firstName?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  journeyId?: string | null;
  appointmentId?: string | null;
  appointmentAt?: Date | null;
  extras?: Record<string, unknown>;
  createdBy?: string | null;
  /** Manual jobs may name an assistant directly instead of using the rule's. */
  assistantId?: string | null;
  scheduledAtOverride?: Date | null;
  /**
   * Stage-guarded chaser: the dispatcher cancels the job if the journey has
   * left this stage by the time it comes due.
   */
  onlyInStage?: string | null;
};

export type EnqueueOutcome =
  | { queued: true; jobId: string; scheduledAt: string }
  | { queued: false; reason: string };

/**
 * The only place an outbound call is created. Rules gate it, quiet hours
 * shape it, the dedupe index makes double-triggering harmless.
 */
export async function enqueueOutboundForTrigger(
  input: EnqueueOutboundInput,
): Promise<EnqueueOutcome> {
  const phone = normalizePhone(input.phone);
  if (!phone || phone.replace(/\D/g, "").length < 8) {
    return { queued: false, reason: "invalid_phone" };
  }

  const { data: rule, error: ruleError } = await supabaseAdmin
    .from("voice_campaign_rules")
    .select("*")
    .eq("trigger_type", input.triggerType)
    .maybeSingle();
  if (ruleError) throw ruleError;
  if (!rule) return { queued: false, reason: "no_rule" };
  if (!rule.is_enabled) return { queued: false, reason: "rule_disabled" };

  const assistantId = input.assistantId ?? rule.vapi_assistant_id;
  if (!assistantId) return { queued: false, reason: "no_assistant" };

  if (input.journeyId) {
    const { data: journey, error } = await supabaseAdmin
      .from("crm_client_journeys")
      .select("do_not_call")
      .eq("id", input.journeyId)
      .maybeSingle();
    if (error) throw error;
    if (journey?.do_not_call) return { queued: false, reason: "do_not_call" };
  }

  const { data: blocked, error: blockError } = await supabaseAdmin
    .from("voice_blacklist")
    .select("id")
    .eq("is_active", true)
    .eq("normalized_number", phone)
    .maybeSingle();
  if (blockError) throw blockError;
  if (blocked) return { queued: false, reason: "blacklisted" };

  const { scheduledAt, expiresAt } =
    input.scheduledAtOverride != null
      ? { scheduledAt: input.scheduledAtOverride, expiresAt: null }
      : computeScheduledAt(rule, {
          appointmentAt: input.appointmentAt ?? null,
        });

  const subject = input.journeyId ?? input.contactId ?? phone;
  const anchorIso = input.appointmentAt ? input.appointmentAt.toISOString() : null;
  const dedupeKey = buildDedupeKey(input.triggerType, subject, anchorIso);

  const variableValues = buildVariableValues({
    fullName: input.fullName,
    firstName: input.firstName,
    phone,
    contactId: input.contactId,
    defaults: (rule.variable_defaults ?? {}) as Record<string, unknown>,
    extras: input.extras,
  });

  const { data: job, error: insertError } = await supabaseAdmin
    .from("voice_outbound_jobs")
    .insert({
      trigger_type: input.triggerType,
      campaign_rule_id: rule.id,
      account_id: input.accountId ?? null,
      contact_id: input.contactId ?? null,
      journey_id: input.journeyId ?? null,
      appointment_id: input.appointmentId ?? null,
      phone,
      vapi_assistant_id: assistantId,
      vapi_phone_number_id: rule.vapi_phone_number_id,
      scheduled_at: scheduledAt.toISOString(),
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      variable_values: variableValues as Json,
      max_attempts: rule.max_attempts,
      dedupe_key: dedupeKey,
      created_by: input.createdBy ?? null,
      metadata: (input.onlyInStage ? { only_in_stage: input.onlyInStage } : {}) as Json,
    })
    .select("id, scheduled_at")
    .single();

  if (insertError) {
    // 23505 on the partial unique index: an identical job is already live.
    if (insertError.code === "23505") return { queued: false, reason: "duplicate" };
    throw insertError;
  }
  return { queued: true, jobId: job.id, scheduledAt: job.scheduled_at };
}

/* ----------------------------- dispatcher sweep ---------------------------- */

const DISPATCH_BATCH = 15;
const DISPATCH_LOOKAHEAD_MS = 90_000;

export async function dispatchDueOutboundJobs(): Promise<{
  dispatched: number;
  failed: number;
  expired: number;
  skipped: number;
}> {
  const nowIso = new Date().toISOString();
  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  const { data: expiredRows, error: expireError } = await supabaseAdmin
    .from("voice_outbound_jobs")
    .update({ status: "expired", last_error: "expired_before_dispatch" })
    .eq("status", "pending")
    .lt("expires_at", nowIso)
    .select("id");
  if (expireError) console.error("[voice] expiry sweep failed:", expireError.message);
  const expired = expiredRows?.length ?? 0;

  const { data: due, error: dueError } = await supabaseAdmin
    .from("voice_outbound_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at", new Date(Date.now() + DISPATCH_LOOKAHEAD_MS).toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(DISPATCH_BATCH);
  if (dueError) throw dueError;

  for (const job of due ?? []) {
    // Optimistic claim: whoever flips pending->dispatching owns the job.
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({ status: "dispatching", attempts: job.attempts + 1 })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id");
    if (claimError) {
      console.error(`[voice] claim failed for job ${job.id}:`, claimError.message);
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // lost the race

    const outcome = await dispatchOne({ ...job, attempts: job.attempts + 1 });
    if (outcome === "dispatched") dispatched += 1;
    else if (outcome === "failed") failed += 1;
    else skipped += 1;
  }

  return { dispatched, failed, expired, skipped };
}

async function dispatchOne(job: OutboundJob): Promise<"dispatched" | "failed" | "retry"> {
  // Stage-guarded chasers: if the journey moved past the stage that queued
  // this job (the lead did the thing), the call is moot — cancel, not dial.
  const onlyInStage = (job.metadata as Record<string, unknown> | null)?.only_in_stage;
  if (typeof onlyInStage === "string" && job.journey_id) {
    const { data: journey, error: journeyError } = await supabaseAdmin
      .from("crm_client_journeys")
      .select("stage_key")
      .eq("id", job.journey_id)
      .maybeSingle();
    if (journeyError) console.error("[voice] stage-guard read failed:", journeyError.message);
    if (journey && journey.stage_key !== onlyInStage) {
      const { error } = await supabaseAdmin
        .from("voice_outbound_jobs")
        .update({ status: "canceled", last_error: `stage_moved_to_${journey.stage_key}` })
        .eq("id", job.id);
      if (error) console.error("[voice] stage-guard cancel failed:", error.message);
      return "retry";
    }
  }

  // The blacklist can change between enqueue and dial; re-check at the wire.
  const { data: blocked, error: blockError } = await supabaseAdmin
    .from("voice_blacklist")
    .select("id")
    .eq("is_active", true)
    .eq("normalized_number", normalizePhone(job.phone))
    .maybeSingle();
  if (blockError) console.error("[voice] blacklist re-check failed:", blockError.message);
  if (blocked) {
    const { error } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({ status: "canceled", last_error: "blacklisted" })
      .eq("id", job.id);
    if (error) console.error("[voice] cancel update failed:", error.message);
    return "retry";
  }

  const scheduled = new Date(job.scheduled_at);
  const body: Record<string, unknown> = {
    assistantId: job.vapi_assistant_id,
    // E.164 at the wire, never in storage — see toE164AU. The stored phone
    // stays whatever matching wants it to be.
    customer: { number: toE164AU(job.phone) || job.phone },
    assistantOverrides: { variableValues: job.variable_values ?? {} },
  };
  if (job.vapi_phone_number_id) body.phoneNumberId = job.vapi_phone_number_id;
  // VAPI rejects a schedulePlan without earliestAt, and the dispatcher only
  // claims jobs whose scheduled_at has already passed — so a due-now job must
  // dial immediately with NO schedulePlan (expiry is enforced by the sweep
  // above, not by latestAt). Only a genuinely future job schedules, and then
  // latestAt may ride along.
  if (scheduled.getTime() > Date.now() + 5_000) {
    const schedulePlan: Record<string, string> = { earliestAt: scheduled.toISOString() };
    if (job.expires_at) schedulePlan.latestAt = new Date(job.expires_at).toISOString();
    body.schedulePlan = schedulePlan;
  }

  try {
    const res = await vapiFetch("/call", { method: "POST", body: JSON.stringify(body) });
    const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: unknown };
    if (!res.ok || !payload.id) {
      throw new Error(`vapi_call_failed_${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    const { error } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({
        status: "dispatched",
        vapi_call_id: payload.id,
        dispatched_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", job.id);
    if (error) console.error("[voice] dispatch update failed:", error.message);
    return "dispatched";
  } catch (err) {
    const message = (err as Error).message;
    if (job.attempts >= job.max_attempts) {
      const { error } = await supabaseAdmin
        .from("voice_outbound_jobs")
        .update({ status: "failed", last_error: message })
        .eq("id", job.id);
      if (error) console.error("[voice] fail update failed:", error.message);
      await notifyOperators({
        kind: "voice_outbound_failed",
        severity: "error",
        title: "Outbound voice call could not be placed",
        body: `${job.trigger_type} call to ${job.phone} failed after ${job.attempts} attempt(s): ${message}`,
        url: "/voice/outbound",
        metadata: { job_id: job.id, trigger_type: job.trigger_type },
      });
      return "failed";
    }
    const retryDelay = await retryDelaySecondsFor(job);
    const { error } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({
        status: "pending",
        last_error: message,
        scheduled_at: new Date(Date.now() + retryDelay * 1000).toISOString(),
      })
      .eq("id", job.id);
    if (error) console.error("[voice] retry update failed:", error.message);
    return "retry";
  }
}

async function retryDelaySecondsFor(job: OutboundJob): Promise<number> {
  if (!job.campaign_rule_id) return 900;
  const { data } = await supabaseAdmin
    .from("voice_campaign_rules")
    .select("retry_delay_seconds")
    .eq("id", job.campaign_rule_id)
    .maybeSingle();
  return data?.retry_delay_seconds ?? 900;
}

/* ------------------------------- drain sweep ------------------------------- */

const DRAIN_BATCH = 20;
const EVENT_MAX_ATTEMPTS = 5;
const STALE_CALL_MINUTES = 30;
const RETRYABLE_OUTCOMES = new Set(["no-answer", "busy", "timeout", "error"]);

export async function processVoiceCallEvents(): Promise<{
  processed: number;
  errored: number;
  staleClosed: number;
}> {
  const { data: events, error } = await supabaseAdmin
    .from("voice_call_events")
    .select("*")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(DRAIN_BATCH);
  if (error) throw error;

  let processed = 0;
  let errored = 0;
  for (const event of events ?? []) {
    try {
      if (event.event_type === "end-of-call-report") {
        await enrichEndOfCall(event.payload as Record<string, unknown>);
      }
      const { error: doneError } = await supabaseAdmin
        .from("voice_call_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", event.id);
      if (doneError) console.error("[voice] event ack failed:", doneError.message);
      processed += 1;
    } catch (err) {
      errored += 1;
      const attempts = event.attempts + 1;
      const parked = attempts >= EVENT_MAX_ATTEMPTS;
      const { error: markError } = await supabaseAdmin
        .from("voice_call_events")
        .update({
          attempts,
          last_error: (err as Error).message,
          // Parking still stamps processed_at so a poison event cannot wedge
          // the queue; last_error keeps the story.
          processed_at: parked ? new Date().toISOString() : null,
        })
        .eq("id", event.id);
      if (markError) console.error("[voice] event error mark failed:", markError.message);
    }
  }

  const staleClosed = await closeStaleCalls();
  return { processed, errored, staleClosed };
}

async function closeStaleCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("voice_calls")
    .update({ call_status: "ended", call_outcome: "stale-timeout" })
    .in("call_status", ["queued", "ringing", "in-progress"])
    .lt("created_at", cutoff)
    .select("id");
  if (error) {
    console.error("[voice] stale close failed:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

type VapiMessage = Record<string, any>;

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

async function enrichEndOfCall(payload: Record<string, unknown>): Promise<void> {
  const message: VapiMessage = asRecord(payload.message);
  const call = asRecord(message.call);
  const artifact = asRecord(message.artifact);
  const vapiCallId: string | undefined = call.id ?? message.callId;
  if (!vapiCallId) throw new Error("end_of_call_without_call_id");

  const phone: string | null =
    asRecord(message.customer).number ?? asRecord(call.customer).number ?? null;
  const endedReason: string | null = message.endedReason ?? call.endedReason ?? null;
  const startedAt: string | null = message.startedAt ?? call.startedAt ?? null;
  const endedAt: string | null = message.endedAt ?? call.endedAt ?? null;
  const durationSeconds: number | null =
    typeof message.durationSeconds === "number"
      ? Math.round(message.durationSeconds)
      : startedAt && endedAt
        ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
        : null;
  const cost: number | null = typeof message.cost === "number" ? message.cost : null;
  const transcript: string | null = message.transcript ?? artifact.transcript ?? null;
  const summary: string | null = message.summary ?? asRecord(message.analysis).summary ?? null;
  const recordingUrl: string | null =
    message.recordingUrl ?? artifact.recordingUrl ?? asRecord(artifact.recording).url ?? null;
  const artifactMessages: unknown =
    artifact.messagesOpenAIFormatted ?? artifact.messages ?? message.messages ?? null;

  const callType: string = call.type ?? "";
  const direction: "inbound" | "outbound" =
    callType === "outboundPhoneCall" ? "outbound" : "inbound";

  const assistantId: string | null = asRecord(message.assistant).id ?? call.assistantId ?? null;
  let agentName: string | null = asRecord(message.assistant).name ?? null;
  if (!agentName && assistantId) {
    const { data: agent } = await supabaseAdmin
      .from("voice_agents")
      .select("name")
      .eq("vapi_assistant_id", assistantId)
      .maybeSingle();
    agentName = agent?.name ?? null;
  }

  const squadId: string | null = call.squadId ?? asRecord(message.squad).id ?? null;
  let squadName: string | null = asRecord(message.squad).name ?? null;
  if (!squadName && squadId) {
    const { data: squad } = await supabaseAdmin
      .from("voice_squads")
      .select("name")
      .eq("vapi_squad_id", squadId)
      .maybeSingle();
    squadName = squad?.name ?? null;
  }
  const isSquadCall = Boolean(squadId) || direction === "inbound";

  // Context written by the inbound tools during the call is the best identity
  // source; a phone match against the CRM is the fallback.
  const { data: context } = await supabaseAdmin
    .from("voice_call_context")
    .select("contact_id, account_id, full_name, first_name, confirmed_intent")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();

  let contactId: string | null = context?.contact_id ?? null;
  let accountId: string | null = context?.account_id ?? null;
  let customerName: string | null = context?.full_name ?? null;
  if (!contactId && phone) {
    const matched = await findContactByPhone(phone);
    if (matched) {
      contactId = matched.id;
      accountId = matched.account_id;
      customerName =
        customerName ?? [matched.first_name, matched.last_name].filter(Boolean).join(" ");
    }
  }

  const analysis = await analyzeTranscript(transcript, summary, isSquadCall);
  if (!customerName && analysis?.customerName) customerName = analysis.customerName;

  const structured = asRecord(message.analysis).structuredData;
  const { data: existing } = await supabaseAdmin
    .from("voice_calls")
    .select("id, metadata, tags, account_id, contact_id")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();

  const mergedMetadata: Record<string, unknown> = {
    ...asRecord(existing?.metadata),
    endedReason,
    type: callType,
    aiAnalyzed: Boolean(analysis),
    orgId: message.orgId ?? call.orgId ?? null,
  };

  const row = {
    vapi_call_id: vapiCallId,
    agent_id: assistantId,
    agent_name: agentName,
    phone_number: phone,
    customer_name: customerName,
    call_direction: direction,
    call_status: "ended" as const,
    call_outcome: endedReason ?? "completed",
    call_intent: context?.confirmed_intent ?? analysis?.callIntent ?? null,
    is_squad_call: isSquadCall,
    squad_id: squadId,
    squad_name: squadName,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    cost,
    transcript,
    artifact_messages: (artifactMessages ?? null) as Json,
    summary,
    sentiment: analysis?.sentiment ?? null,
    key_topics: analysis?.keyTopics ?? null,
    action_items: analysis?.actionItems ?? null,
    ai_recommendations: analysis?.aiRecommendations ?? null,
    negative_sentiment_moment: (analysis?.negativeSentimentMoment ?? null) as Json,
    root_cause_category: analysis?.rootCauseCategory ?? null,
    escalation_severity: analysis?.escalationSeverity ?? null,
    recovery_priority: analysis?.recoveryPriority ?? null,
    recording_url: recordingUrl,
    structured_data_multi: (Array.isArray(structured) ? structured : []) as Json,
    account_id: accountId ?? existing?.account_id ?? null,
    contact_id: contactId ?? existing?.contact_id ?? null,
    metadata: mergedMetadata as Json,
  };

  const { error: upsertError } = await supabaseAdmin
    .from("voice_calls")
    .upsert(row, { onConflict: "vapi_call_id" });
  if (upsertError) throw upsertError;

  const { data: saved, error: savedError } = await supabaseAdmin
    .from("voice_calls")
    .select("id")
    .eq("vapi_call_id", vapiCallId)
    .single();
  if (savedError) throw savedError;

  if (row.account_id) {
    const { error: activityError } = await supabaseAdmin.from("crm_activities").insert({
      account_id: row.account_id,
      contact_id: row.contact_id,
      kind: "call",
      title: `${direction === "inbound" ? "Inbound" : "Outbound"} voice call · ${row.call_outcome}`,
      body: summary ?? null,
      occurred_at: startedAt ?? new Date().toISOString(),
      actor_label: agentName ?? "Voice agent",
      entity_type: "voice_call",
      entity_id: saved.id,
      metadata: { vapi_call_id: vapiCallId, duration_seconds: durationSeconds, cost } as Json,
    });
    if (activityError) console.error("[voice] activity write failed:", activityError.message);
  }

  if (row.contact_id) {
    const { data: journey } = await supabaseAdmin
      .from("crm_client_journeys")
      .select("id, calls_total")
      .eq("contact_id", row.contact_id)
      .maybeSingle();
    if (journey) {
      const { error: journeyError } = await supabaseAdmin
        .from("crm_client_journeys")
        .update({
          last_call_at: endedAt ?? new Date().toISOString(),
          last_call_outcome: row.call_outcome,
          calls_total: journey.calls_total + 1,
        })
        .eq("id", journey.id);
      if (journeyError) console.error("[voice] journey update failed:", journeyError.message);
    }
  }

  await evaluateAlertRules(saved.id, {
    outcome: row.call_outcome,
    sentiment: row.sentiment,
    intent: row.call_intent,
    durationSeconds,
    cost,
    escalationSeverity: row.escalation_severity,
    phone,
    customerName,
  });

  await reconcileOutboundJob(vapiCallId, endedReason);
}

export async function findContactByPhone(phone: string): Promise<{
  id: string;
  account_id: string;
  first_name: string;
  last_name: string | null;
} | null> {
  const digits = normalizePhone(phone).replace(/\D/g, "");
  if (digits.length < 8) return null;
  const last9 = digits.slice(-9);
  const { data, error } = await supabaseAdmin
    .from("crm_contacts")
    .select("id, account_id, first_name, last_name, phone")
    .not("phone", "is", null)
    .ilike("phone", `%${last9}`)
    .limit(5);
  if (error) {
    console.error("[voice] contact lookup failed:", error.message);
    return null;
  }
  return (data ?? []).find((c) => phonesMatch(c.phone, phone)) ?? null;
}

/* ------------------------------- alert rules ------------------------------- */

async function evaluateAlertRules(
  callId: string,
  facts: {
    outcome: string | null;
    sentiment: string | null;
    intent: string | null;
    durationSeconds: number | null;
    cost: number | null;
    escalationSeverity: number | null;
    phone: string | null;
    customerName: string | null;
  },
): Promise<void> {
  const { data: rules, error } = await supabaseAdmin
    .from("voice_alert_rules")
    .select("*")
    .eq("is_enabled", true);
  if (error) {
    console.error("[voice] alert rule read failed:", error.message);
    return;
  }

  for (const rule of rules ?? []) {
    let hit = false;
    const v = rule.condition_value;
    switch (rule.condition_type) {
      case "outcome":
        hit = (facts.outcome ?? "") === v;
        break;
      case "sentiment":
        hit = (facts.sentiment ?? "") === v;
        break;
      case "intent":
        hit = (facts.intent ?? "") === v;
        break;
      case "duration_gt":
        hit = facts.durationSeconds != null && facts.durationSeconds > Number(v);
        break;
      case "duration_lt":
        hit = facts.durationSeconds != null && facts.durationSeconds < Number(v);
        break;
      case "cost_gt":
        hit = facts.cost != null && facts.cost > Number(v);
        break;
      case "escalation_gte":
        hit = facts.escalationSeverity != null && facts.escalationSeverity >= Number(v);
        break;
    }
    if (!hit) continue;

    const who = facts.customerName ?? facts.phone ?? "unknown caller";
    const message = `${rule.name}: call with ${who} matched ${rule.condition_type}=${v}`;
    const { error: histError } = await supabaseAdmin.from("voice_alert_history").insert({
      rule_id: rule.id,
      call_id: callId,
      rule_name: rule.name,
      message,
      is_positive: rule.is_positive,
    });
    if (histError) console.error("[voice] alert history write failed:", histError.message);
    if (rule.notify_operators) {
      await notifyOperators({
        kind: "voice_call_flagged",
        severity: rule.is_positive ? "success" : "warning",
        title: `Call alert: ${rule.name}`,
        body: message,
        url: "/voice/calls",
        metadata: { call_id: callId, rule_id: rule.id },
      });
    }
  }
}

/* ------------------------ outbound job reconciliation ---------------------- */

const OUTCOME_CATEGORY_RETRYABLE = (outcome: string | null): boolean => {
  if (!outcome) return false;
  const o = outcome.toLowerCase();
  if (o === "customer-did-not-answer" || o === "no-answer") return true;
  if (o === "customer-busy" || o === "busy") return true;
  if (o.includes("error") || o === "failed") return true;
  return RETRYABLE_OUTCOMES.has(o);
};

async function reconcileOutboundJob(vapiCallId: string, endedReason: string | null): Promise<void> {
  const { data: job, error } = await supabaseAdmin
    .from("voice_outbound_jobs")
    .select("*")
    .eq("vapi_call_id", vapiCallId)
    .eq("status", "dispatched")
    .maybeSingle();
  if (error) {
    console.error("[voice] outbound reconcile read failed:", error.message);
    return;
  }
  if (!job) return;

  if (OUTCOME_CATEGORY_RETRYABLE(endedReason) && job.attempts < job.max_attempts) {
    const retryDelay = await retryDelaySecondsFor(job);
    const priorCalls = Array.isArray(asRecord(job.metadata).attempt_calls)
      ? (asRecord(job.metadata).attempt_calls as string[])
      : [];
    const { error: retryError } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({
        status: "pending",
        vapi_call_id: null,
        scheduled_at: new Date(Date.now() + retryDelay * 1000).toISOString(),
        last_error: `retrying_after_${endedReason}`,
        metadata: { ...asRecord(job.metadata), attempt_calls: [...priorCalls, vapiCallId] } as Json,
      })
      .eq("id", job.id);
    if (retryError) console.error("[voice] outbound retry failed:", retryError.message);
    return;
  }

  const { error: doneError } = await supabaseAdmin
    .from("voice_outbound_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      last_error: null,
      metadata: { ...asRecord(job.metadata), final_outcome: endedReason } as Json,
    })
    .eq("id", job.id);
  if (doneError) console.error("[voice] outbound complete failed:", doneError.message);
}

/* --------------------------- optional LLM analysis ------------------------- */

type TranscriptAnalysis = {
  customerName: string | null;
  sentiment: "positive" | "neutral" | "negative" | "mixed" | null;
  keyTopics: string[] | null;
  actionItems: string[] | null;
  callIntent: string | null;
  rootCauseCategory: string | null;
  escalationSeverity: number | null;
  aiRecommendations: string[] | null;
  negativeSentimentMoment: Record<string, unknown> | null;
  recoveryPriority: number | null;
};

const SENTIMENTS = new Set(["positive", "neutral", "negative", "mixed"]);

/**
 * The intent vocabulary is `voice-vocab.ts`'s, imported rather than restated.
 *
 * It was restated, and the two copies disagreed. The analyser asked the model
 * for the NPC set — `discovery_booking`, `strategy_booking`, `finance_consult`,
 * `general_inquiry` — while `CALL_INTENTS` had already moved to the Aurixa
 * funnel and `/voice/calls` builds its filter from that. So six of the seven
 * options in that filter could never match a row, and every stored intent
 * except `general_inquiry` was a value the page could neither label nor find.
 *
 * An unrecognised intent is stored as NULL rather than verbatim: a model is
 * being asked to pick from a list, and a value outside it is a failure to
 * answer the question, not a new category. Absent beats invented.
 */
const INTENT_SET = new Set<string>(CALL_INTENTS);

/**
 * Post-call analysis, only when OPENAI_API_KEY is configured. Absent a key the
 * call is stored with `aiAnalyzed: false` and no sentiment — an honest blank
 * beats a guessed clear.
 */
async function analyzeTranscript(
  transcript: string | null,
  summary: string | null,
  isSquadCall: boolean,
): Promise<TranscriptAnalysis | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !transcript || transcript.trim().length < 40) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_ANALYSIS_MODEL || "gpt-5.1-chat-latest",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You analyse voice call transcripts for Aurixa Systems, a B2B provider of governed AI " +
              "operating platforms for Australian property, finance and advisory firms. Callers are " +
              "applying for priority access, completing a Business Readiness Questionnaire, booking or " +
              "attending a strategic review, discussing platform capability or pricing, or raising " +
              "support. Reply with ONLY a JSON object with keys: " +
              "customerName (string|null — the CUSTOMER's spoken name, never the agent's, null if not stated), " +
              'sentiment ("positive"|"neutral"|"negative"|"mixed"), keyTopics (string[] max 5), ' +
              `actionItems (string[] max 5), callIntent (exactly one of ${CALL_INTENTS.join(", ")}; ` +
              "use general_inquiry when none of the others fits rather than inventing a value), " +
              "rootCauseCategory (string|null — only for negative calls: pricing_objection, service_complaint, agent_confusion, long_hold_time, unresolved_query, technical_issue, miscommunication, customer_frustration, wrong_transfer, information_gap), " +
              "escalationSeverity (1-5|null — only for negative calls), aiRecommendations (string[] max 3|null), " +
              "negativeSentimentMoment (object|null with quote and context), recoveryPriority (1-5|null).",
          },
          {
            role: "user",
            content: `Squad call: ${isSquadCall}\nSummary: ${summary ?? "(none)"}\n\nTranscript:\n${transcript.slice(0, 24_000)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[voice] transcript analysis HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as Record<string, any>;

    let customerName: string | null =
      typeof parsed.customerName === "string" ? parsed.customerName.trim() : null;
    // A "name" that is mostly digits is a phone number the model echoed back.
    if (customerName && customerName.replace(/[\d\s+()-]/g, "").length < 2) customerName = null;

    const clampScale = (v: unknown): number | null =>
      typeof v === "number" && v >= 1 && v <= 5 ? Math.round(v) : null;
    const strArray = (v: unknown, max: number): string[] | null =>
      Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, max) : null;

    return {
      customerName,
      sentiment: SENTIMENTS.has(parsed.sentiment) ? parsed.sentiment : null,
      keyTopics: strArray(parsed.keyTopics, 5),
      actionItems: strArray(parsed.actionItems, 5),
      callIntent:
        typeof parsed.callIntent === "string" && INTENT_SET.has(parsed.callIntent)
          ? parsed.callIntent
          : null,
      rootCauseCategory:
        typeof parsed.rootCauseCategory === "string" ? parsed.rootCauseCategory : null,
      escalationSeverity: clampScale(parsed.escalationSeverity),
      aiRecommendations: strArray(parsed.aiRecommendations, 3),
      negativeSentimentMoment:
        parsed.negativeSentimentMoment && typeof parsed.negativeSentimentMoment === "object"
          ? parsed.negativeSentimentMoment
          : null,
      recoveryPriority: clampScale(parsed.recoveryPriority),
    };
  } catch (err) {
    console.error("[voice] transcript analysis failed:", (err as Error).message);
    return null;
  }
}

/* ----------------------------- live-call control --------------------------- */

/** End a live call. Uses the call's monitor controlUrl when present, else the API. */
export async function killLiveCall(
  vapiCallId: string,
  opts?: { announce?: string | null },
): Promise<{ result: "terminated" | "already-ended" | "failed"; detail?: string }> {
  try {
    const res = await vapiFetch(`/call/${vapiCallId}`, { method: "GET" });
    if (!res.ok) return { result: "failed", detail: `lookup_${res.status}` };
    const call = (await res.json()) as Record<string, any>;
    if (call.status === "ended") return { result: "already-ended" };
    const controlUrl: string | undefined = call.monitor?.controlUrl;
    if (!controlUrl) return { result: "failed", detail: "no_control_url" };
    const payload = opts?.announce
      ? { type: "say", message: opts.announce, endCallAfterSpoken: true }
      : { type: "end-call" };
    const kill = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!kill.ok) return { result: "failed", detail: `control_${kill.status}` };
    return { result: "terminated" };
  } catch (err) {
    return { result: "failed", detail: (err as Error).message };
  }
}

/** Blacklist enforcement on a live inbound call. */
export async function enforceBlacklist(
  vapiCallId: string,
  phone: string,
): Promise<"clean" | "killed" | "kill_failed"> {
  const normalized = normalizePhone(phone);
  if (!normalized) return "clean";
  const { data: entry, error } = await supabaseAdmin
    .from("voice_blacklist")
    .select("*")
    .eq("is_active", true)
    .eq("normalized_number", normalized)
    .maybeSingle();
  if (error) {
    console.error("[voice] blacklist read failed:", error.message);
    return "clean";
  }
  if (!entry) return "clean";

  const { error: hitError } = await supabaseAdmin
    .from("voice_blacklist")
    .update({ hit_count: entry.hit_count + 1, last_hit_at: new Date().toISOString() })
    .eq("id", entry.id);
  if (hitError) console.error("[voice] blacklist hit update failed:", hitError.message);

  const outcome = await killLiveCall(vapiCallId, {
    announce: entry.kill_mode === "announce" ? (entry.announce_message ?? null) : null,
  });

  const { error: callError } = await supabaseAdmin
    .from("voice_calls")
    .update({ call_status: "ended", call_outcome: "blacklisted" })
    .eq("vapi_call_id", vapiCallId);
  if (callError) console.error("[voice] blacklist call update failed:", callError.message);

  await notifyOperators({
    kind: "voice_blacklist_hit",
    severity: "warning",
    title: "Blacklisted number called in",
    body: `${entry.phone_number} (${entry.category}) — call ${outcome.result}.`,
    url: "/voice/calls",
    metadata: { vapi_call_id: vapiCallId, blacklist_id: entry.id },
  });
  await writeAuditLog({
    action: "voice_blacklist_kill",
    entityType: "voice_call",
    entityId: null,
    metadata: { vapi_call_id: vapiCallId, result: outcome.result, detail: outcome.detail },
  });
  return outcome.result === "terminated" ? "killed" : "kill_failed";
}

/** Re-sign a recording URL by re-reading the call from VAPI (R2 URLs expire). */
export async function freshRecordingUrl(vapiCallId: string): Promise<string | null> {
  try {
    const res = await vapiFetch(`/call/${vapiCallId}`, { method: "GET" });
    if (!res.ok) return null;
    const call = (await res.json()) as Record<string, any>;
    return call.artifact?.recordingUrl ?? call.recordingUrl ?? null;
  } catch {
    return null;
  }
}
