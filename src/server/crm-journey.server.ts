// The client journey's consequences. Stage transitions and appointment
// outcomes are the ONLY sources of outbound voice calls — this module is where
// a tracker event becomes (or refuses to become) a dial, always through
// enqueueOutboundForTrigger and the campaign rules.
//
// The journey-event rows written here keep the prime repo's wire shape
// ({ fromStage, toStage } in metadata), so anything consuming
// platform.client_stage_changed events can read these unmodified.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  operatorBookingNotice,
  planConfirmationEmail,
  type AppointmentConfirmationInput,
} from "@/lib/appointmentConfirmation.pure";
import { notifyOperators } from "@/server/audit.server";
import { defaultMailbox, isGraphConfigured, sendMail } from "@/server/graph-client";
import { enqueueOutboundForTrigger, type EnqueueOutcome } from "@/server/voice.server";

type VoiceTriggerType = Database["public"]["Enums"]["voice_trigger_type"];
type AppointmentKind = Database["public"]["Enums"]["crm_appointment_kind"];

/** Appointment kind -> the triggers fired when it is booked. */
const SCHEDULED_TRIGGERS: Partial<Record<AppointmentKind, VoiceTriggerType[]>> = {
  strategic_review: ["review_confirmation", "session_reminder"],
  discovery_session: ["session_reminder"],
  guided_demo: ["session_reminder"],
  enterprise_consultation: ["session_reminder"],
  kickoff: ["session_reminder"],
};

/** Appointment kind -> the trigger fired when it is marked a no-show. */
const NO_SHOW_TRIGGER: Partial<Record<AppointmentKind, VoiceTriggerType>> = {
  strategic_review: "session_no_show",
  discovery_session: "session_no_show",
  guided_demo: "session_no_show",
  enterprise_consultation: "session_no_show",
  kickoff: "session_no_show",
};

/**
 * Journey stage entered -> the chaser fired. Chasers are stage-guarded: the
 * job carries only_in_stage, and the dispatcher cancels it if the journey has
 * already moved on — a lead who finished the BRQ before the +4h call is never
 * chased about it.
 */
const STAGE_TRIGGER: Record<string, VoiceTriggerType> = {
  applied: "questionnaire_follow_up",
  review_pending: "review_booking_follow_up",
  onboarding: "kickoff_scheduler",
};

const SESSION_LABEL: Partial<Record<AppointmentKind, string>> = {
  strategic_review: "strategic review",
  discovery_session: "platform discovery session",
  guided_demo: "guided demonstration",
  enterprise_consultation: "enterprise requirements consultation",
  kickoff: "onboarding kickoff call",
};

type JourneySubject = {
  journeyId: string;
  accountId: string;
  contactId: string;
  phone: string | null;
  fullName: string;
  firstName: string;
};

async function subjectForJourney(journeyId: string): Promise<JourneySubject | null> {
  const { data, error } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id, account_id, contact_id, crm_contacts(id, first_name, last_name, phone)")
    .eq("id", journeyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const contact = data.crm_contacts as unknown as {
    first_name: string;
    last_name: string | null;
    phone: string | null;
  } | null;
  return {
    journeyId: data.id,
    accountId: data.account_id,
    contactId: data.contact_id,
    phone: contact?.phone ?? null,
    firstName: contact?.first_name ?? "",
    fullName: [contact?.first_name, contact?.last_name].filter(Boolean).join(" "),
  };
}

async function fire(
  trigger: VoiceTriggerType,
  subject: JourneySubject,
  opts?: {
    appointmentId?: string;
    appointmentAt?: Date;
    extras?: Record<string, unknown>;
    actorUserId?: string | null;
    onlyInStage?: string;
  },
): Promise<EnqueueOutcome> {
  if (!subject.phone) return { queued: false, reason: "no_phone" };
  return enqueueOutboundForTrigger({
    triggerType: trigger,
    phone: subject.phone,
    fullName: subject.fullName,
    firstName: subject.firstName,
    accountId: subject.accountId,
    contactId: subject.contactId,
    journeyId: subject.journeyId,
    appointmentId: opts?.appointmentId ?? null,
    appointmentAt: opts?.appointmentAt ?? null,
    extras: opts?.extras,
    createdBy: opts?.actorUserId ?? null,
    onlyInStage: opts?.onlyInStage ?? null,
  });
}

/* ------------------------------- transitions ------------------------------- */

/**
 * Fire the stage-entry chaser for a journey that was CREATED in a stage
 * rather than transitioned into it. transitionJourneyStage only fires when
 * fromStage !== toStage, and since the column default became `applied` a
 * fresh journey already sits in its entry stage — so creation paths
 * (startJourney, the inbound resolve_contact tool) must call this instead.
 * The chaser stays stage-guarded: it cancels itself if the journey has
 * moved on by dial time.
 */
export async function fireStageEntryChaser(
  journeyId: string,
  stage: string,
  actorUserId?: string | null,
): Promise<EnqueueOutcome | null> {
  const trigger = STAGE_TRIGGER[stage];
  if (!trigger) return null;
  const subject = await subjectForJourney(journeyId);
  if (!subject) return null;
  return fire(trigger, subject, { actorUserId: actorUserId ?? null, onlyInStage: stage });
}

export async function transitionJourneyStage(input: {
  journeyId: string;
  toStage: string;
  reason?: string | null;
  source?: "call" | "manual" | "system" | "webhook";
  actorUserId?: string | null;
  callId?: string | null;
}): Promise<{ fromStage: string; toStage: string; dial: EnqueueOutcome | null }> {
  const { data: journey, error } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id, stage_key")
    .eq("id", input.journeyId)
    .maybeSingle();
  if (error) throw error;
  if (!journey) throw new Error("journey_not_found");

  const { data: stage, error: stageError } = await supabaseAdmin
    .from("crm_journey_stages")
    .select("key, is_active")
    .eq("key", input.toStage)
    .maybeSingle();
  if (stageError) throw stageError;
  if (!stage || !stage.is_active) throw new Error("unknown_stage");

  const fromStage = journey.stage_key;
  if (fromStage !== input.toStage) {
    const { error: updateError } = await supabaseAdmin
      .from("crm_client_journeys")
      .update({ stage_key: input.toStage, entered_stage_at: new Date().toISOString() })
      .eq("id", input.journeyId);
    if (updateError) throw updateError;

    const { error: eventError } = await supabaseAdmin.from("crm_journey_events").insert({
      journey_id: input.journeyId,
      from_stage: fromStage,
      to_stage: input.toStage,
      reason: input.reason ?? null,
      source: input.source ?? "manual",
      actor_user_id: input.actorUserId ?? null,
      call_id: input.callId ?? null,
      metadata: { fromStage, toStage: input.toStage } as Json,
    });
    if (eventError) console.error("[journey] event write failed:", eventError.message);
  }

  let dial: EnqueueOutcome | null = null;
  const trigger = STAGE_TRIGGER[input.toStage];
  if (trigger && fromStage !== input.toStage) {
    const subject = await subjectForJourney(input.journeyId);
    if (subject) {
      dial = await fire(trigger, subject, {
        actorUserId: input.actorUserId,
        // Chasers only make sense while the journey is still parked here.
        onlyInStage: input.toStage,
      });
    }
  }
  return { fromStage, toStage: input.toStage, dial };
}

/**
 * An operator-recorded re-engagement signal: queues the nurture call, with an
 * optional context summary the agent is briefed with.
 */
export async function recordJourneySignal(input: {
  journeyId: string;
  kind: "nurture_step";
  summary?: string | null;
  actorUserId?: string | null;
}): Promise<EnqueueOutcome> {
  const subject = await subjectForJourney(input.journeyId);
  if (!subject) return { queued: false, reason: "journey_not_found" };

  const { error } = await supabaseAdmin.from("crm_journey_events").insert({
    journey_id: input.journeyId,
    reason: input.kind,
    source: "system",
    actor_user_id: input.actorUserId ?? null,
    metadata: { kind: input.kind, summary: input.summary ?? null } as Json,
  });
  if (error) console.error("[journey] signal event write failed:", error.message);

  return fire("nurture", subject, {
    extras: input.summary ? { contextSummary: input.summary } : undefined,
    actorUserId: input.actorUserId,
  });
}

/* ------------------------------- appointments ------------------------------ */

type ScheduledAppointment = {
  id: string;
  kind: AppointmentKind;
  starts_at: string;
  timezone: string | null;
  contact_id: string | null;
  metadata: Json | null;
};

/**
 * Tell the caller and the operators that an appointment exists.
 *
 * Composition and the decision to send live in
 * `@/lib/appointmentConfirmation.pure`; this half is the reads, the send and
 * the record of what happened.
 *
 * Three rules hold it. **The operator notice is unconditional** — it is what
 * makes the agent's spoken promise keepable when no address was captured, so
 * an absent email makes it more important rather than less. **The send is
 * never retried**: `sendMail` answers `sent` / `refused` / `throttled` /
 * `unconfirmed` precisely because a failure after the request left the isolate
 * cannot say whether a message exists, and resending on that is the duplicate
 * the whole outcome type was built to prevent. And **nothing here throws** —
 * the booking is already written, so a mailbox fault must cost a log line and
 * a notice, never the appointment.
 */
async function announceAppointment(appointment: ScheduledAppointment): Promise<void> {
  try {
    /*
     * Once per appointment. `onAppointmentScheduled` has two callers — the
     * voice tool and the tracker UI — and nothing stops either running again
     * for a row that already exists. A second notification is noise; a second
     * email is the duplicate `sendMail`'s whole outcome type exists to
     * prevent, so the stamp is the guard.
     *
     * Only a message that actually WENT closes it. A `not_sent`, `refused`,
     * `throttled` or `unconfirmed` stamp leaves this open deliberately:
     * `unconfirmed` is the one case where a resend could duplicate, and it is
     * also the one case where refusing to try again could mean the customer
     * hears nothing at all — so that judgement stays with a person reading the
     * operator notice rather than being silently taken here.
     */
    const priorStamp =
      appointment.metadata && typeof appointment.metadata === "object"
        ? (appointment.metadata as Record<string, unknown>).confirmation_email
        : null;
    if (
      priorStamp &&
      typeof priorStamp === "object" &&
      (priorStamp as Record<string, unknown>).status === "sent"
    ) {
      return;
    }

    let contact: { first_name: string; last_name: string | null; email: string | null } | null =
      null;
    if (appointment.contact_id) {
      const { data, error } = await supabaseAdmin
        .from("crm_contacts")
        .select("first_name, last_name, email")
        .eq("id", appointment.contact_id)
        .maybeSingle();
      if (error) {
        // A failed read is not an absent contact. Say so, then carry on with
        // what is known — the operators still get told a booking happened.
        console.error("[journey] contact read for confirmation failed:", error.message);
      }
      contact = data ?? null;
    }

    const firstName = contact?.first_name ?? "";
    const input: AppointmentConfirmationInput = {
      sessionLabel: SESSION_LABEL[appointment.kind] ?? null,
      startsAt: appointment.starts_at,
      timezone: appointment.timezone ?? "Australia/Sydney",
      firstName,
      fullName: [contact?.first_name, contact?.last_name].filter(Boolean).join(" "),
      email: contact?.email ?? null,
      graphConfigured: isGraphConfigured(),
      mailbox: defaultMailbox(),
    };

    const plan = planConfirmationEmail(input);
    let stamp: Record<string, unknown>;

    if (!plan.send) {
      stamp = { status: "not_sent", reason: plan.reason, at: new Date().toISOString() };
    } else {
      const outcome = await sendMail(plan.mailbox, {
        subject: plan.subject,
        body: { contentType: "HTML", content: plan.html },
        toRecipients: [{ emailAddress: { address: plan.to } }],
      });
      stamp = { status: outcome.kind, to: plan.to, at: new Date().toISOString() };
      if (outcome.kind !== "sent") {
        console.error(
          `[journey] confirmation email for appointment ${appointment.id} came back ` +
            `${outcome.kind}; it is NOT resent, and the operator notice says so`,
        );
      }
    }

    const notice = operatorBookingNotice(input, plan);
    await notifyOperators({
      kind: "crm_appointment_booked",
      severity: "info",
      title: notice.title,
      body: notice.body,
      url: "/crm",
      metadata: { appointment_id: appointment.id, confirmation_email: stamp },
    });

    // Stamped on the row so the fact survives the notification being read and
    // dismissed. `metadata` is merged rather than replaced — it is a shared
    // bag, and the tracker writes to it too.
    const existing =
      appointment.metadata && typeof appointment.metadata === "object"
        ? (appointment.metadata as Record<string, unknown>)
        : {};
    const { error: stampError } = await supabaseAdmin
      .from("crm_appointments")
      .update({ metadata: { ...existing, confirmation_email: stamp } as Json })
      .eq("id", appointment.id);
    if (stampError) {
      console.error("[journey] confirmation stamp failed:", stampError.message);
    }
  } catch (err) {
    console.error("[journey] appointment announcement failed:", (err as Error).message);
  }
}

export async function onAppointmentScheduled(
  appointmentId: string,
  actorUserId?: string | null,
): Promise<EnqueueOutcome | null> {
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, kind, starts_at, timezone, journey_id, contact_id, account_id, metadata")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appointment) return null;

  /*
   * Tell somebody. This sits HERE, above every early return below, for two
   * reasons. It is the seam both booking paths pass through — the voice agent
   * and the tracker UI — so neither can book silently. And the returns below
   * are conditional on a journey and on the kind having triggers, which is
   * exactly how the last silent failure in this function stayed invisible: an
   * appointment with `journey_id: null` skipped everything and said nothing.
   *
   * It never throws. The appointment row is already written by the time we get
   * here, and failing a booking because a mailbox was unreachable would turn a
   * courtesy into an outage.
   */
  await announceAppointment(appointment);

  // Booking an appointment advances the journey to its matching stage.
  if (appointment.journey_id) {
    const stageFor: Partial<Record<AppointmentKind, string>> = {
      strategic_review: "review_booked",
      discovery_session: "pathway",
      guided_demo: "pathway",
      enterprise_consultation: "pathway",
      kickoff: "onboarding",
    };
    const target = stageFor[appointment.kind];
    if (target) {
      try {
        await transitionJourneyStage({
          journeyId: appointment.journey_id,
          toStage: target,
          reason: `appointment_booked:${appointment.kind}`,
          source: "system",
          actorUserId,
        });
      } catch (err) {
        console.error("[journey] stage advance on booking failed:", (err as Error).message);
      }
    }
  }

  const triggers = SCHEDULED_TRIGGERS[appointment.kind] ?? [];
  if (triggers.length === 0 || !appointment.journey_id) return null;
  const subject = await subjectForJourney(appointment.journey_id);
  if (!subject) return null;
  let last: EnqueueOutcome | null = null;
  for (const trigger of triggers) {
    last = await fire(trigger, subject, {
      appointmentId: appointment.id,
      appointmentAt: new Date(appointment.starts_at),
      extras: {
        sessionTime: appointment.starts_at,
        sessionLabel: SESSION_LABEL[appointment.kind],
      },
      actorUserId,
    });
  }
  return last;
}

export async function onAppointmentStatusChange(
  appointmentId: string,
  status: Database["public"]["Enums"]["crm_appointment_status"],
  actorUserId?: string | null,
): Promise<EnqueueOutcome | null> {
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, kind, starts_at, journey_id")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appointment || !appointment.journey_id) return null;

  if (status === "no_show") {
    const trigger = NO_SHOW_TRIGGER[appointment.kind];
    if (!trigger) return null;
    const subject = await subjectForJourney(appointment.journey_id);
    if (!subject) return null;
    return fire(trigger, subject, {
      appointmentId: appointment.id,
      // A no-show call anchors on the *event* (now + delay), but the agent is
      // told the missed time so it can rebook naturally.
      extras: {
        sessionTime: appointment.starts_at,
        sessionLabel: SESSION_LABEL[appointment.kind],
      },
      actorUserId,
    });
  }

  if (status === "canceled") {
    // A canceled appointment revokes any reminder still waiting on it.
    const { error: cancelError } = await supabaseAdmin
      .from("voice_outbound_jobs")
      .update({ status: "canceled", last_error: "appointment_canceled" })
      .eq("appointment_id", appointmentId)
      .in("status", ["pending", "dispatching"]);
    if (cancelError) console.error("[journey] reminder cancel failed:", cancelError.message);
  }
  return null;
}
