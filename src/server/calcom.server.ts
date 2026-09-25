// The network half of the Cal.com integration: every request Mission Control
// makes to Cal.com goes through `calcomRequest`, so authentication, the API
// version header, the timeout and the reading of a refusal live in one place.
//
// Configuration (Mission Control's own environment, never a clone's):
//
//   CALCOM_API_KEY         required — a key minted on the `aurixasystems` Cal.com
//                          account (Settings → Developer → API keys). Absent,
//                          `calcomConfig()` answers null and every caller keeps
//                          its pre-Cal.com behaviour, so deploying this code
//                          before the key is set changes nothing.
//   CALCOM_USERNAME        optional — the account the event types belong to.
//                          Defaults to `aurixasystems`.
//   CALCOM_API_URL         optional — defaults to https://api.cal.com/v2. Only for
//                          an account hosted on another Cal.com region.
//   CALCOM_WEBHOOK_SECRET  read by the webhook route, not here.
//
// Every function returns an outcome rather than throwing: the callers are a
// live phone call and an applicant's booking page, and both need to say
// something true about a failure rather than surface a stack trace.
import {
  CALCOM_API_BASE,
  CALCOM_BOOKINGS_API_VERSION,
  CALCOM_DEFAULT_DURATION_MINUTES,
  CALCOM_DEFAULT_USERNAME,
  CALCOM_EVENT_TYPE_SLUGS,
  CALCOM_SLOTS_API_VERSION,
  buildBookingRequest,
  calcomErrorMessage,
  classifyCalcomFailure,
  isLiveBooking,
  parseBookingResponse,
  parseBookingsListResponse,
  parseSlotsResponse,
  resolveTimeZone,
  type BookingRequestInput,
  type CalcomBooking,
  type CalcomFailure,
  type CalcomKind,
  type CalcomSlot,
} from "@/server/calcom.pure";

/** The version the list endpoint was pinned against (`take`, `data[]`, `pagination`). */
const CALCOM_LIST_API_VERSION = "2024-08-13";

export type CalcomConfig = { apiKey: string; username: string; base: string };

/** Null when no API key is configured — the signal to keep the legacy path. */
export function calcomConfig(
  env: Record<string, string | undefined> = process.env,
): CalcomConfig | null {
  const apiKey = (env.CALCOM_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const base = (env.CALCOM_API_URL ?? "").trim().replace(/\/+$/, "");
  return {
    apiKey,
    username: (env.CALCOM_USERNAME ?? "").trim() || CALCOM_DEFAULT_USERNAME,
    // Only https is accepted, so a typo cannot send the key over plain http.
    base: /^https:\/\//i.test(base) ? base : CALCOM_API_BASE,
  };
}

export type CalcomOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: CalcomFailure; status: number; message: string };

type RequestOptions = {
  method: "GET" | "POST";
  version: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs: number;
};

/** One request. Never throws; a timeout or a dropped connection is status 0. */
async function calcomRequest(
  config: CalcomConfig,
  path: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown; ok: boolean }> {
  const url = new URL(`${config.base}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "cal-api-version": options.version,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // A non-JSON body (a proxy's HTML error page) stays a string, so the
      // classifier still reads its text rather than a parse failure.
    }
    return { status: response.status, body, ok: response.ok };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      status: 0,
      body: aborted
        ? `timed out after ${options.timeoutMs} ms`
        : String((err as Error)?.message ?? err),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function refusal<T>(path: string, status: number, body: unknown): CalcomOutcome<T> {
  const failure = classifyCalcomFailure(status, body);
  const message = calcomErrorMessage(body) || `HTTP ${status}`;
  // The key is never in the body Cal.com returns, so the message is safe to log.
  console.error(`[calcom] ${path} refused: ${failure} (${status}) ${message}`);
  return { ok: false, failure, status, message };
}

/**
 * Free slots for one kind of appointment between two instants.
 *
 * Cal.com applies the schedule, the 24-hour notice and the 45-day window of
 * the event type itself; this only chooses the range to ask about.
 */
export async function fetchCalcomSlots(
  config: CalcomConfig,
  kind: CalcomKind,
  range: { start: Date; end: Date; timeZone?: string | null },
  timeoutMs = 8_000,
): Promise<CalcomOutcome<CalcomSlot[]>> {
  const path = "/slots";
  const result = await calcomRequest(config, path, {
    method: "GET",
    version: CALCOM_SLOTS_API_VERSION,
    query: {
      eventTypeSlug: CALCOM_EVENT_TYPE_SLUGS[kind],
      username: config.username,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      timeZone: resolveTimeZone(range.timeZone),
      format: "range",
    },
    timeoutMs,
  });
  if (!result.ok) return refusal(path, result.status, result.body);
  const slots = parseSlotsResponse(result.body, CALCOM_DEFAULT_DURATION_MINUTES);
  if (!slots) return refusal(path, 502, "unreadable slots answer");
  return { ok: true, value: slots };
}

/**
 * Books one slot. Cal.com re-checks availability and the booking window, so a
 * slot taken since it was offered comes back as `slot_unavailable`.
 */
export async function createCalcomBooking(
  config: CalcomConfig,
  input: Omit<BookingRequestInput, "username">,
  timeoutMs = 15_000,
): Promise<CalcomOutcome<CalcomBooking>> {
  const request = buildBookingRequest({ ...input, username: config.username });
  if (!request.ok) {
    return { ok: false, failure: "invalid_request", status: 400, message: request.reason };
  }
  const path = "/bookings";
  const result = await calcomRequest(config, path, {
    method: "POST",
    version: CALCOM_BOOKINGS_API_VERSION,
    body: request.body,
    timeoutMs,
  });
  if (!result.ok) return refusal(path, result.status, result.body);
  const booking = parseBookingResponse(result.body);
  if (!booking) return refusal(path, 502, "unreadable booking answer");
  return { ok: true, value: booking };
}

/** Moves a booking. Cal.com issues a new uid and emails the attendee the change. */
export async function rescheduleCalcomBooking(
  config: CalcomConfig,
  uid: string,
  start: Date,
  reason: string,
  timeoutMs = 15_000,
): Promise<CalcomOutcome<CalcomBooking>> {
  const path = `/bookings/${encodeURIComponent(uid)}/reschedule`;
  const result = await calcomRequest(config, path, {
    method: "POST",
    version: CALCOM_BOOKINGS_API_VERSION,
    body: { start: start.toISOString(), reschedulingReason: reason.slice(0, 300) },
    timeoutMs,
  });
  if (!result.ok) return refusal(path, result.status, result.body);
  const booking = parseBookingResponse(result.body);
  if (!booking) return refusal(path, 502, "unreadable reschedule answer");
  return { ok: true, value: booking };
}

/** Upcoming bookings on the account, optionally for one attendee. At most 100. */
export async function listUpcomingCalcomBookings(
  config: CalcomConfig,
  filter: { attendeeEmail?: string | null } = {},
  timeoutMs = 8_000,
): Promise<CalcomOutcome<CalcomBooking[]>> {
  const path = "/bookings";
  const result = await calcomRequest(config, path, {
    method: "GET",
    version: CALCOM_LIST_API_VERSION,
    query: {
      status: "upcoming",
      attendeeEmail: filter.attendeeEmail ?? undefined,
      sortStart: "asc",
      take: 100,
    },
    timeoutMs,
  });
  if (!result.ok) return refusal(path, result.status, result.body);
  const bookings = parseBookingsListResponse(result.body);
  if (!bookings) return refusal(path, 502, "unreadable bookings answer");
  return { ok: true, value: bookings.filter(isLiveBooking) };
}

/**
 * A live booking this attendee already holds at this start, or null.
 *
 * The recovery read after an ambiguous failure. A booking request that timed
 * out may still have been written, and a VAPI tool call can be retried; either
 * way, the caller asking again for the same person at the same time is asking
 * for a booking that may already exist, and answering "that slot is taken"
 * about their OWN booking is the worst available reply.
 */
export async function findLiveCalcomBooking(
  config: CalcomConfig,
  attendeeEmail: string,
  start: Date,
): Promise<CalcomBooking | null> {
  const listed = await listUpcomingCalcomBookings(config, { attendeeEmail });
  if (!listed.ok) return null;
  const target = start.getTime();
  return (
    listed.value.find(
      (b) =>
        Math.abs(Date.parse(b.start) - target) < 60_000 &&
        b.attendeeEmails.includes(attendeeEmail.toLowerCase()),
    ) ?? null
  );
}
