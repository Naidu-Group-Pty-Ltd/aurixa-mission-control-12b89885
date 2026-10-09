// `marketing_channel_snapshots`: Mission Control's own daily record of every
// marketing channel (migration 20261009100000), and the nightly recorder that
// writes it (/hooks/marketing-snapshots).
//
// The same table and the same rules as the prime's
// `_shared/marketingSnapshots.ts`: metrics hold only what the source measured,
// a later reading of a day replaces the earlier one, and a failed read is never
// an empty table — every read says which of the two it was.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  METRIC_KEYS,
  addDays,
  emptyMetrics,
  readNumber,
  todayIn,
  type DailyPoint,
  type MetricKey,
  type MetricSet,
  type SourceState,
} from "@/lib/marketing/marketingEngine";
import { noteConnectionCheck } from "./connections.server";
import {
  readMetaAccountDaily,
  readTikTokAds,
  readYouTubeAds,
  readYouTubeChannel,
} from "./reads.server";
import type { MarketingSource } from "@/lib/marketing/connectionFields.pure";

export type SnapshotChannel = "youtube_channel" | "youtube_ads" | "tiktok_ads" | "meta_ads";

export interface SnapshotRow {
  channel: SnapshotChannel;
  account_ref: string;
  snapshot_date: string;
  metrics: Record<string, number>;
  currency: string | null;
  source: "page_view" | "scheduled";
}

export interface StoredSnapshot extends SnapshotRow {
  captured_at: string;
}

/** The time zone Mission Control's days are counted in. */
export const MARKETING_TIME_ZONE = "Australia/Sydney";

/** A metric set as stored: measured keys only, so absent stays absent. */
export function storableMetrics(m: MetricSet): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of METRIC_KEYS) {
    const v = m[k];
    if (v !== null && Number.isFinite(v)) out[k] = Math.round(v * 1_000_000) / 1_000_000;
  }
  return out;
}

/** A stored object back into a metric set. A key that is absent, or not a number, is unmeasured. */
export function metricsFromStorage(stored: unknown): MetricSet {
  const out = emptyMetrics();
  if (!stored || typeof stored !== "object") return out;
  const obj = stored as Record<string, unknown>;
  for (const k of METRIC_KEYS) out[k as MetricKey] = readNumber(obj[k]);
  return out;
}

export async function upsertSnapshots(
  rows: readonly SnapshotRow[],
): Promise<{ ok: true; written: number } | { ok: false; message: string }> {
  if (rows.length === 0) return { ok: true, written: 0 };
  const capturedAt = new Date().toISOString();
  const { error } = await supabaseAdmin.from("marketing_channel_snapshots").upsert(
    rows.map((r) => ({ ...r, metrics: r.metrics as Json, captured_at: capturedAt })),
    { onConflict: "channel,account_ref,snapshot_date" },
  );
  if (error) {
    console.error("[marketing] snapshot write failed", { code: error.code });
    return {
      ok: false,
      message: `The reading could not be recorded (${error.code ?? "unknown"}).`,
    };
  }
  return { ok: true, written: rows.length };
}

/** Readings in a range, oldest first. Throws on a failed read: a fault is not an empty history. */
export async function readSnapshots(
  channels: readonly SnapshotChannel[],
  since: string,
  until: string,
): Promise<StoredSnapshot[]> {
  const { data, error } = await supabaseAdmin
    .from("marketing_channel_snapshots")
    .select("channel, account_ref, snapshot_date, metrics, currency, source, captured_at")
    .in("channel", channels as string[])
    .gte("snapshot_date", since)
    .lte("snapshot_date", until)
    .order("snapshot_date", { ascending: true })
    .limit(5000);
  if (error) throw error;
  return (data ?? []) as unknown as StoredSnapshot[];
}

/** Whether any reading exists for an account; null where the table could not be read. */
async function hasAnySnapshot(
  channel: SnapshotChannel,
  accountRef: string,
): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from("marketing_channel_snapshots")
    .select("snapshot_date")
    .eq("channel", channel)
    .eq("account_ref", accountRef)
    .limit(1);
  if (error) return null;
  return Array.isArray(data) && data.length > 0;
}

/** Today's reading of the YouTube channel's lifetime counters, as a snapshot row. */
export function channelReadingRow(
  channel: {
    id: string;
    subscribers: number | null;
    totalViews: number | null;
    videoCount: number | null;
  },
  day: string,
  source: SnapshotRow["source"],
): SnapshotRow {
  const metrics: Record<string, number> = {};
  if (channel.subscribers !== null) metrics.subscribers = channel.subscribers;
  if (channel.totalViews !== null) metrics.totalViews = channel.totalViews;
  if (channel.videoCount !== null) metrics.videoCount = channel.videoCount;
  return {
    channel: "youtube_channel",
    account_ref: channel.id,
    snapshot_date: day,
    metrics,
    currency: null,
    source,
  };
}

// ── The nightly recorder ──────────────────────────────────────────────────────

const RESTATEMENT_DAYS = 7;
const FIRST_RUN_DAYS = 90;

export interface RecorderOutcome {
  channel: SnapshotChannel;
  state: SourceState["state"];
  days: number;
  detail?: string;
}

function dailyRows(
  channel: SnapshotChannel,
  accountRef: string,
  currency: string | null,
  daily: readonly DailyPoint[],
): SnapshotRow[] {
  return daily.map((d) => ({
    channel,
    account_ref: accountRef,
    snapshot_date: d.date,
    metrics: storableMetrics(d.metrics),
    currency,
    source: "scheduled" as const,
  }));
}

async function windowFor(channel: SnapshotChannel, accountRef: string | null, today: string) {
  const known = accountRef ? await hasAnySnapshot(channel, accountRef) : null;
  const days = known === false ? FIRST_RUN_DAYS : RESTATEMENT_DAYS;
  return { since: addDays(today, -days), until: addDays(today, -1) };
}

async function settle(
  channel: SnapshotChannel,
  source: MarketingSource,
  state: SourceState,
  rows: SnapshotRow[],
): Promise<RecorderOutcome> {
  if (state.state === "not_configured")
    return {
      channel,
      state: "not_configured",
      days: 0,
      detail: `missing ${state.missing.join(", ")}`,
    };
  if (state.state !== "ok") {
    const detail = state.state === "error" ? `${state.reason}: ${state.message}` : undefined;
    await noteConnectionCheck(source, detail ?? "The read did not complete.");
    return { channel, state: state.state, days: 0, detail };
  }
  const write = await upsertSnapshots(rows);
  if (!write.ok) return { channel, state: "error", days: 0, detail: write.message };
  await noteConnectionCheck(source, null);
  return { channel, state: "ok", days: write.written };
}

/**
 * One run: today's YouTube counters, and the last seven days of each
 * advertising account (ninety on an account's first run). A source that is not
 * connected is skipped and named; a vendor that fails is recorded as failed,
 * on the connection as well as in the answer, and the run moves on.
 */
export async function recordMarketingSnapshots(): Promise<{
  today: string;
  outcomes: RecorderOutcome[];
}> {
  const today = todayIn(MARKETING_TIME_ZONE);
  const outcomes: RecorderOutcome[] = [];

  const yt = await readYouTubeChannel(null, MARKETING_TIME_ZONE);
  outcomes.push(
    await settle(
      "youtube_channel",
      "youtube_data",
      yt.state,
      yt.channel ? [channelReadingRow(yt.channel, today, "scheduled")] : [],
    ),
  );

  // Each advertising read needs its account id to decide the window, so the
  // window is decided after the account is known: the first read is the
  // restatement window, widened only when no reading of the account exists.
  {
    const probe = await readYouTubeAds(
      { since: addDays(today, -RESTATEMENT_DAYS), until: addDays(today, -1) },
      "campaign",
    );
    let read = probe;
    if (probe.report?.accountRef) {
      const window = await windowFor("youtube_ads", probe.report.accountRef, today);
      if (window.since !== addDays(today, -RESTATEMENT_DAYS))
        read = await readYouTubeAds(window, "campaign");
    }
    outcomes.push(
      await settle(
        "youtube_ads",
        "google_ads",
        read.state,
        read.report?.accountRef
          ? dailyRows(
              "youtube_ads",
              read.report.accountRef,
              read.report.currency,
              read.report.daily,
            )
          : [],
      ),
    );
  }
  {
    const probe = await readTikTokAds(
      { since: addDays(today, -RESTATEMENT_DAYS), until: addDays(today, -1) },
      "campaign",
    );
    let read = probe;
    if (probe.report?.accountRef) {
      const window = await windowFor("tiktok_ads", probe.report.accountRef, today);
      if (window.since !== addDays(today, -RESTATEMENT_DAYS))
        read = await readTikTokAds(window, "campaign");
    }
    outcomes.push(
      await settle(
        "tiktok_ads",
        "tiktok_ads",
        read.state,
        read.report?.accountRef
          ? dailyRows("tiktok_ads", read.report.accountRef, read.report.currency, read.report.daily)
          : [],
      ),
    );
  }
  {
    const probe = await readMetaAccountDaily({
      since: addDays(today, -RESTATEMENT_DAYS),
      until: addDays(today, -1),
    });
    let read = probe;
    if (probe.account) {
      const window = await windowFor("meta_ads", probe.account, today);
      if (window.since !== addDays(today, -RESTATEMENT_DAYS))
        read = await readMetaAccountDaily(window);
    }
    outcomes.push(
      await settle(
        "meta_ads",
        "meta_ads",
        read.state,
        read.account ? dailyRows("meta_ads", read.account, read.currency, read.daily) : [],
      ),
    );
  }

  console.log(
    "[marketing] snapshots recorded",
    JSON.stringify(outcomes.map((o) => ({ channel: o.channel, state: o.state, days: o.days }))),
  );
  return { today, outcomes };
}
