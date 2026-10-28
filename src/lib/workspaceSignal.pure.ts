/**
 * Telling a workspace's open dashboards, the moment a message changes, to ask
 * again.
 *
 * Until 28 Oct 2026 a workspace heard about a message only on its next poll —
 * every minute while the tab was in front, every two behind — so a message
 * sent with Send now took anywhere from a tenth of a second to a minute and a
 * half to appear (measured on the prime: 0.1 s, 5.6 s, 6.5 s, 44 s), and a
 * scheduled one appeared up to a minute after its start time.
 *
 * Now Mission Control sends a SIGNAL to each workspace a change reaches, on
 * that workspace's own Supabase Realtime, and every open dashboard there asks
 * for its notices at once (measured on the wire: 190 ms on the prime, 224 ms
 * on NPC Test, from the broadcast to the browser).
 *
 * The signal carries nothing. Not the message, not its title, not who else
 * was sent it — only "ask again". The workspace then reads its notices the
 * way it always has, through its relay, keyed, and Mission Control decides
 * what it is shown. So the channel can be public: anyone holding the
 * workspace's publishable key can listen to it and learn only that something
 * changed, and anyone who sends on it can only make the open dashboards ask
 * a question they would ask on their next check anyway — which the dashboard
 * throttles.
 *
 * Polling stays, as the net under the signal: a dashboard whose socket is
 * down, or a workspace whose Realtime refused the signal, still hears on its
 * next check — every minute while its signal is down, every two while it is
 * up (the workspace's `liveSignal.pure.ts`).
 */
import {
  announcementReachesClone,
  resolveAnnouncementState,
  type AnnouncementFacts,
  type AudienceClone,
} from "./cloneAnnouncements.pure";

/** The Realtime topic every workspace's dashboard listens on. Constant: each
 *  workspace has its own Realtime, so the topic needs no workspace in it. */
export const NOTICE_SIGNAL_TOPIC = "aurixa-systems-notices";
/** The one event sent on it. */
export const NOTICE_SIGNAL_EVENT = "changed";

/** How long Mission Control waits for one workspace's Realtime to accept. */
export const SIGNAL_TIMEOUT_MS = 2_500;

/** Where to send a workspace's signal. */
export interface SignalEndpoint {
  workspaceId: string;
  supabaseUrl: string;
  /** The workspace's PUBLISHABLE (anon) key — shipped in its own browser
   *  bundle, public by design. It satisfies the gateway; it authorises
   *  nothing a stranger could not already do. */
  anonKey: string;
}

/** What a send told the operator: how many workspaces the change reaches, and
 *  how many of their Realtime servers accepted the signal. */
export interface SignalSummary {
  reached: number;
  signalled: number;
  failed: number;
}

export const NO_SIGNAL: SignalSummary = { reached: 0, signalled: 0, failed: 0 };

const SUPABASE_PROJECT_URL = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;

/**
 * A workspace's Supabase URL, normalised, or null where it is not one.
 *
 * Only a Supabase project URL is ever posted to: the URL comes from a row, and
 * a row that held anything else must not turn a message into a request to an
 * arbitrary host.
 */
export function supabaseProjectUrlOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim().replace(/\/+$/, "");
  return SUPABASE_PROJECT_URL.test(url) ? url : null;
}

/** The project URL for a project ref, or null where it is not one. */
export function supabaseUrlForRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !/^[a-z0-9]{20}$/.test(ref)) return null;
  return `https://${ref}.supabase.co`;
}

/** The request that sends one workspace its signal (Realtime's broadcast REST API). */
export function broadcastRequestOf(
  endpoint: Pick<SignalEndpoint, "supabaseUrl" | "anonKey">,
  at: Date,
): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  return {
    url: `${endpoint.supabaseUrl}/realtime/v1/api/broadcast`,
    method: "POST",
    headers: {
      apikey: endpoint.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          topic: NOTICE_SIGNAL_TOPIC,
          event: NOTICE_SIGNAL_EVENT,
          // Nothing about the message. `at` lets a dashboard ignore a signal
          // it has already acted on; it says nothing a listener can use.
          payload: { at: at.toISOString() },
          private: false,
        },
      ],
    }),
  };
}

/**
 * Which workspaces must be told about a change to these rows.
 *
 * Pass the row as it was AND as it is: an edit that narrows a message must
 * reach the workspace that is losing it, or its dashboard keeps showing the
 * message until its next poll. A row that was never published was never
 * served to anyone and is skipped; every other state is included — scheduled
 * (so the dashboard learns when it goes live), archived or expired (so the
 * dashboard drops it).
 */
export function workspacesToSignal(
  rows: ReadonlyArray<
    | Pick<
        AnnouncementFacts,
        "audience_plan_slugs" | "audience_clone_ids" | "audience_match" | "published_at"
      >
    | null
    | undefined
  >,
  roster: readonly AudienceClone[],
): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (!row || !row.published_at) continue;
    for (const workspace of roster) {
      if (announcementReachesClone(row, workspace)) out.add(workspace.id);
    }
  }
  return [...out];
}

/**
 * The next moment this workspace's notices change by themselves — a scheduled
 * message reaching its start, or a live one reaching its end — or null.
 *
 * Sent with the notices so an open dashboard asks again at exactly that
 * moment, instead of on whichever poll comes after it. It says WHEN, never
 * what: the scheduled message itself does not leave this server until it is
 * live.
 */
export function nextChangeAtFor(
  rows: readonly AnnouncementFacts[],
  workspace: AudienceClone,
  now: Date = new Date(),
): string | null {
  let next = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!announcementReachesClone(row, workspace)) continue;
    const state = resolveAnnouncementState(row, now);
    const at =
      state === "scheduled"
        ? Date.parse(row.starts_at ?? "")
        : state === "active" && row.ends_at
          ? Date.parse(row.ends_at)
          : Number.NaN;
    if (Number.isFinite(at) && at > now.getTime() && at < next) next = at;
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : null;
}

/** The operator's one line about a signal, or null when there was nothing to tell. */
export function signalSentence(signal: SignalSummary | null | undefined): string | null {
  if (!signal || signal.reached === 0) return null;
  const n = (k: number) => `${k} workspace${k === 1 ? "" : "s"}`;
  if (signal.signalled === signal.reached) {
    return `Signalled ${signal.reached === 1 ? "the workspace" : `all ${n(signal.reached)}`} — open dashboards update within seconds.`;
  }
  if (signal.signalled === 0) {
    return `No workspace could be signalled just now — open dashboards pick it up on their next check, within a few minutes.`;
  }
  return `Signalled ${signal.signalled} of ${n(signal.reached)} — the rest pick it up on their next check, within a few minutes.`;
}
