// Changes made IN Cal.com, carried back to Mission Control.
//
// Every Cal.com invitation carries reschedule and cancel links, and the host
// can move a booking in Cal.com directly. None of that passes through the
// booking tools, so without this the CRM row, the reminder call queued
// against it and the operators would all go on believing the old time. A
// reminder rung for a cancelled review is the visible failure; the invisible
// one is a no-show call to somebody who moved their session a week ago.
//
// Configure in Cal.com: Settings → Developer → Webhooks → New, subscriber URL
// https://mission-control.aurixasystems.com.au/api/public/hooks/calcom,
// triggers Booking Created / Rescheduled / Cancelled / Rejected / No-show
// updated, and a secret stored here as CALCOM_WEBHOOK_SECRET.
//
// Rules:
//  - No secret configured → 503 on every delivery, never an unauthenticated
//    receiver: a forged "cancelled" would withdraw a real reminder.
//  - Every write is a compare-and-set against the state it was read in, so a
//    change Mission Control made itself (the voice agent moving a booking,
//    which Cal.com then reports back) is applied once, and its consequences —
//    the reminder moved, the operators told — happen once.
//  - A booking no CRM row mirrors is answered 200, and a change to one of the
//    Aurixa sessions still raises a notice. A Stage 3 review lives in Airtable,
//    so its notice asks an operator to bring the record there into line; any
//    other (booked on Cal.com's own link, or moved on a call — the voice
//    agent writes nothing for a booking it did not make) is named as outside
//    the CRM, as `noteCreated` named it when it was booked.
import type { Database, Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";
import {
  CALCOM_SESSION_LABEL,
  kindForEventTypeSlug,
  parseCalcomWebhook,
  readCalcomMirror,
  spokenSlot,
  verifyCalcomSignature,
  type CalcomMirror,
  type CalcomWebhookEvent,
} from "@/server/calcom.pure";
import { STAGE3_BOOKING_SOURCE } from "@/server/strategicReview.pure";

export type WebhookResponse = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown> = {}): WebhookResponse => ({
  status: 200,
  body: { ok: true, ...body },
});

type AppointmentStatus = Database["public"]["Enums"]["crm_appointment_status"];

type MirrorRow = {
  id: string;
  status: AppointmentStatus;
  starts_at: string;
  metadata: Json;
  mirror: CalcomMirror;
};

/** The CRM row mirroring a Cal.com booking uid, or null. Throws on a failed read. */
async function rowForUid(uid: string | null): Promise<MirrorRow | null> {
  if (!uid) return null;
  const { data, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, status, starts_at, metadata")
    .eq("metadata->calcom->>uid", uid)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mirror lookup failed: ${error.message}`);
  if (!data) return null;
  const mirror = readCalcomMirror(data.metadata);
  return mirror ? { ...data, mirror } : null;
}

function metadataWith(
  row: MirrorRow,
  mirror: CalcomMirror,
  extra: Record<string, unknown> = {},
): Json {
  const base =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return { ...base, ...extra, calcom: mirror } as unknown as Json;
}

/**
 * Made on the Stage 3 page, which stamps its bookings. Read from the stamp
 * alone: the strategic-review event type can also be booked on its own Cal.com
 * link, and a review booked there has no Airtable record to bring into line.
 */
function isStageThree(event: CalcomWebhookEvent): boolean {
  return event.metadata.source === STAGE3_BOOKING_SOURCE;
}

function whoBooked(event: CalcomWebhookEvent): string {
  return event.attendeeName || event.attendeeEmails[0] || "Somebody";
}

/**
 * A change to one of the Aurixa sessions that no CRM row mirrors and the
 * Stage 3 page did not make. `noteCreated` told the operators when it was
 * booked, so they are told when it changes; a booking of any other event type
 * on the account is not ours to report.
 */
async function noteOutsideCrm(
  event: CalcomWebhookEvent,
  change: "cancelled" | "moved",
): Promise<WebhookResponse> {
  const kind = kindForEventTypeSlug(event.eventTypeSlug);
  if (!kind) return ok({ unmatched: true });
  const label = CALCOM_SESSION_LABEL[kind];
  const at = (iso: string | null) => (iso ? `${spokenSlot(new Date(iso))} (Sydney time)` : null);
  const detail =
    change === "cancelled"
      ? `${at(event.start) ?? "It"} was cancelled in Cal.com` +
        (event.cancellationReason ? ` — "${event.cancellationReason.slice(0, 300)}"` : "") +
        "."
      : `Moved ${event.previousStart ? `from ${at(event.previousStart)} ` : ""}to ${at(event.start)} ` +
        "in Cal.com, which has sent the updated invitation.";
  await notifyOperators({
    kind: "crm_appointment_changed",
    severity: change === "cancelled" ? "warning" : "info",
    title: `${whoBooked(event)} ${change} their ${label}`,
    body:
      `${detail} It has no CRM record, so no reminder call was queued for it.` +
      (event.attendeeEmails[0] ? ` Attendee: ${event.attendeeEmails[0]}.` : ""),
    url: "/crm",
    metadata: {
      calcom_uid: event.uid,
      previous_calcom_uid: event.previousUid,
      event_type: event.eventTypeSlug,
    },
  });
  return ok({ applied: "notice" });
}

function stageThreeWho(event: CalcomWebhookEvent): string {
  const reference = event.metadata.applicationId ? ` (${event.metadata.applicationId})` : "";
  return `${event.attendeeName || event.attendeeEmails[0] || "An applicant"}${reference}`;
}

const LIVE = new Set<AppointmentStatus>(["scheduled", "confirmed"]);

/**
 * Runs a consequence of a write that has already landed. A failure here is
 * logged and reported in the answer, not turned into a 500: the row is
 * already moved, so Cal.com's retry would find nothing to do and the
 * consequence would still not run — a 500 would only claim otherwise.
 */
async function consequence(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    console.error(`[calcom-webhook] ${label} failed:`, (err as Error).message);
    return false;
  }
}

/**
 * The compare-and-set matched nothing: the row changed between the read and
 * the write — the voice agent moving it, or a second delivery of this same
 * change. Whoever wrote first ran the consequences; this delivery must not
 * run them again, nor claim it applied anything.
 */
function lostRace(appointmentId: string): WebhookResponse {
  return ok({ appointment_id: appointmentId, already: "changed_concurrently" });
}

async function applyCancellation(event: CalcomWebhookEvent): Promise<WebhookResponse> {
  if (event.supersededByReschedule) {
    // The old half of a reschedule. The RESCHEDULED delivery carries the move.
    return ok({ ignored: "superseded_by_reschedule" });
  }
  const row = await rowForUid(event.uid);
  if (row) {
    if (!LIVE.has(row.status)) return ok({ already: row.status });
    const { data: updated, error } = await supabaseAdmin
      .from("crm_appointments")
      .update({
        status: "canceled",
        metadata: metadataWith(
          row,
          { ...row.mirror, status: "cancelled" },
          { cancellation_reason: event.cancellationReason },
        ),
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id");
    if (error) throw new Error(`cancellation write failed: ${error.message}`);
    if ((updated ?? []).length === 0) return lostRace(row.id);
    const consequences = await consequence("cancellation consequences", async () => {
      const { onAppointmentChangedInCalendar } = await import("@/server/crm-journey.server");
      await onAppointmentChangedInCalendar(row.id, {
        status: "canceled",
        reason: event.cancellationReason,
      });
    });
    return ok({ appointment_id: row.id, applied: "canceled", consequences });
  }
  if (isStageThree(event)) {
    await notifyOperators({
      kind: "lead_stage_three",
      severity: "warning",
      title: `${stageThreeWho(event)} cancelled their strategic review`,
      body:
        `${event.start ? `${spokenSlot(new Date(event.start))} (Sydney time)` : "The review"} was ` +
        `cancelled in Cal.com${event.cancellationReason ? ` — "${event.cancellationReason.slice(0, 300)}"` : ""}. ` +
        "Its Strategic Review Bookings record in Airtable still shows the booking.",
      url: "/leads",
      metadata: { calcom_uid: event.uid, application_id: event.metadata.applicationId ?? null },
    });
    return ok({ applied: "stage3_notice" });
  }
  return noteOutsideCrm(event, "cancelled");
}

async function applyReschedule(event: CalcomWebhookEvent): Promise<WebhookResponse> {
  if (!event.uid || !event.start) return ok({ ignored: "incomplete" });
  // Already applied — Mission Control made this move itself and wrote the
  // new uid before Cal.com reported it.
  const current = await rowForUid(event.uid);
  if (current) return ok({ already: "applied", appointment_id: current.id });

  const row = await rowForUid(event.previousUid);
  if (row) {
    if (!LIVE.has(row.status)) return ok({ already: row.status });
    const mirror: CalcomMirror = {
      ...row.mirror,
      uid: event.uid,
      status: "accepted",
      previousUids: [...new Set([...row.mirror.previousUids, row.mirror.uid])].slice(-10),
    };
    const { data: updated, error } = await supabaseAdmin
      .from("crm_appointments")
      .update({
        starts_at: event.start,
        ends_at: event.end ?? new Date(Date.parse(event.start) + 30 * 60_000).toISOString(),
        metadata: metadataWith(row, mirror),
      })
      .eq("id", row.id)
      .eq("starts_at", row.starts_at)
      .select("id");
    if (error) throw new Error(`reschedule write failed: ${error.message}`);
    if ((updated ?? []).length === 0) return lostRace(row.id);
    const consequences = await consequence("reschedule consequences", async () => {
      const { onAppointmentRescheduled } = await import("@/server/crm-journey.server");
      await onAppointmentRescheduled(row.id, row.starts_at, "calcom");
    });
    return ok({ appointment_id: row.id, applied: "rescheduled", consequences });
  }
  if (isStageThree(event)) {
    const from = event.previousStart ? `from ${spokenSlot(new Date(event.previousStart))} ` : "";
    await notifyOperators({
      kind: "lead_stage_three",
      severity: "info",
      title: `${stageThreeWho(event)} moved their strategic review`,
      body:
        `Moved ${from}to ${spokenSlot(new Date(event.start))} (Sydney time) in Cal.com. ` +
        "Cal.com has sent the updated invitation; the Strategic Review Bookings record in Airtable " +
        "may still show the earlier time.",
      url: "/leads",
      metadata: {
        calcom_uid: event.uid,
        previous_calcom_uid: event.previousUid,
        application_id: event.metadata.applicationId ?? null,
      },
    });
    return ok({ applied: "stage3_notice" });
  }
  return noteOutsideCrm(event, "moved");
}

async function applyNoShow(event: CalcomWebhookEvent): Promise<WebhookResponse> {
  // Only a mark of absence moves anything; clearing one is the host fixing a
  // mis-click, and the no-show call it might have queued is theirs to cancel.
  if (event.attendeeNoShow !== true) return ok({ ignored: "not_absent" });
  const row = await rowForUid(event.uid);
  if (!row) return ok({ unmatched: true });
  if (!LIVE.has(row.status)) return ok({ already: row.status });
  const { data: updated, error } = await supabaseAdmin
    .from("crm_appointments")
    .update({ status: "no_show" })
    .eq("id", row.id)
    .eq("status", row.status)
    .select("id");
  if (error) throw new Error(`no-show write failed: ${error.message}`);
  if ((updated ?? []).length === 0) return lostRace(row.id);
  const consequences = await consequence("no-show consequences", async () => {
    const { onAppointmentChangedInCalendar } = await import("@/server/crm-journey.server");
    await onAppointmentChangedInCalendar(row.id, { status: "no_show" });
  });
  return ok({ appointment_id: row.id, applied: "no_show", consequences });
}

/**
 * A booking made somewhere other than the voice tools or the Stage 3 page —
 * on the hidden event type's own Cal.com link, or by the host. The CRM does
 * not hold it, so an operator is told it exists.
 */
async function noteCreated(event: CalcomWebhookEvent): Promise<WebhookResponse> {
  const source = event.metadata.source;
  if (source === "voice_agent" || source === STAGE3_BOOKING_SOURCE) return ok({ ignored: "ours" });
  const kind = kindForEventTypeSlug(event.eventTypeSlug);
  if (!kind) return ok({ ignored: "not_an_aurixa_event_type" });
  await notifyOperators({
    kind: "crm_appointment_booked",
    severity: "info",
    title: `${whoBooked(event)} booked directly in Cal.com`,
    body:
      `${event.start ? `${spokenSlot(new Date(event.start))} (Sydney time)` : "A session"}, booked on ` +
      `the ${event.eventTypeSlug} event type rather than through the voice agent or the Stage 3 ` +
      `page, so it has no CRM record.${event.attendeeEmails[0] ? ` Attendee: ${event.attendeeEmails[0]}.` : ""}`,
    url: "/crm",
    metadata: { calcom_uid: event.uid, event_type: event.eventTypeSlug },
  });
  return ok({ applied: "notice" });
}

/**
 * One delivery, verified and applied. Never throws. A failed READ or WRITE is
 * a 500, because nothing has changed yet and a retry can still apply it.
 */
export async function handleCalcomWebhook(
  rawBody: string,
  signature: string | null,
): Promise<WebhookResponse> {
  const secret = (process.env.CALCOM_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return { status: 503, body: { ok: false, error: "webhook_not_configured" } };
  if (!verifyCalcomSignature(rawBody, secret, signature)) {
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }
  const event = parseCalcomWebhook(rawBody);
  if (!event) return { status: 400, body: { ok: false, error: "unreadable_payload" } };

  try {
    switch (event.trigger) {
      case "BOOKING_CANCELLED":
      case "BOOKING_REJECTED":
        return await applyCancellation(event);
      case "BOOKING_RESCHEDULED":
        return await applyReschedule(event);
      case "BOOKING_NO_SHOW_UPDATED":
        return await applyNoShow(event);
      case "BOOKING_CREATED":
        return await noteCreated(event);
      default:
        return ok({ ignored: event.rawTrigger });
    }
  } catch (err) {
    console.error(
      `[calcom-webhook] ${event.rawTrigger} ${event.uid ?? ""} failed:`,
      (err as Error).message,
    );
    return { status: 500, body: { ok: false, error: "apply_failed" } };
  }
}
