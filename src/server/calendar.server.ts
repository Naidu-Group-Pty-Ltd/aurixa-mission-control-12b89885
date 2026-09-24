// The free time of the one person who hosts every Aurixa session, as every
// booking path must read it: Cal.com's answer — the host's schedule, every
// connected calendar, every booking from every path — less the CRM
// appointments Cal.com cannot see.
//
// The voice fleet's `check_availability` and the Stage 3 scheduler on the
// waitlist site both read it through here, so a slot one of them offers is a
// slot the other would offer too.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  CALCOM_DEFAULT_DURATION_MINUTES,
  type CalcomFailure,
  type CalcomKind,
} from "@/server/calcom.pure";
import { fetchCalcomSlots, type CalcomConfig } from "@/server/calcom.server";
import {
  blocksFromAppointments,
  removeBlockedSlots,
  type TimeBlock,
} from "@/server/voiceBooking.pure";

const DAY_MS = 24 * 60 * 60_000;

/**
 * How far ahead to ask. Cal.com enforces the 45-day window on the event type
 * itself, so asking one day past it costs nothing and cannot offer a slot the
 * event type would refuse.
 */
export const CALENDAR_HORIZON_DAYS = 46;

/** How far before the range a CRM read looks, so a long session that started earlier still blocks. */
const CRM_BLOCK_LOOKBACK_MS = 2 * 60 * 60_000;

/**
 * The CRM appointments Cal.com cannot see — booked by hand in the tracker, or
 * before Cal.com was the calendar — as blocks over the range.
 *
 * A read that fails leaves Cal.com's answer standing rather than emptying the
 * calendar: Cal.com is the authority and this is the courtesy check around it,
 * and "nothing is free" said over a database hiccup is a lie that loses a
 * booking.
 */
export async function crmOnlyBlocks(from: Date, to: Date): Promise<TimeBlock[]> {
  const { data, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("starts_at, ends_at, metadata")
    .in("status", ["scheduled", "confirmed"])
    .gte("starts_at", new Date(from.getTime() - CRM_BLOCK_LOOKBACK_MS).toISOString())
    .lte("starts_at", to.toISOString());
  if (error) {
    console.error(
      `[calendar] CRM appointment read failed; offering Cal.com's slots without it: ${error.message}`,
    );
    return [];
  }
  return blocksFromAppointments(data ?? [], CALCOM_DEFAULT_DURATION_MINUTES);
}

export type FreeSlotRead = { ok: true; slots: Date[] } | { ok: false; failure: CalcomFailure };

/** Free starts for one kind of session from now to the horizon, ascending. */
export async function calcomFreeSlots(
  config: CalcomConfig,
  kind: CalcomKind,
  now: Date = new Date(),
): Promise<FreeSlotRead> {
  const end = new Date(now.getTime() + CALENDAR_HORIZON_DAYS * DAY_MS);
  const answer = await fetchCalcomSlots(config, kind, { start: now, end });
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const blocks = await crmOnlyBlocks(now, end);
  return {
    ok: true,
    slots: removeBlockedSlots(
      answer.value.map((s) => s.start).filter((s) => s.getTime() > now.getTime()),
      blocks,
      CALCOM_DEFAULT_DURATION_MINUTES,
    ),
  };
}
