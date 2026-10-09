// Digests and weekly briefs: a model's words about Aurixa's marketing, written
// from facts this server measured, and kept.
//
// The rule the prime's digest answers to holds here unchanged: the model
// writes, it does not measure. Each channel is re-read here — nothing a
// browser sends is treated as a figure — and the engine's `adReportFacts` /
// `youtubeChannelFacts` turn the read into pre-formatted facts, leaving out
// anything the source did not measure. The prompt is the engine's
// `digestPrompt`, which forbids any figure not in the facts.
//
// Every brief is stored in `marketing_reports` WITH the facts it was handed,
// so a brief can always be read beside the numbers it was written from.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { callAi } from "@/server/ai-gateway.server";
import {
  CHANNEL_LABELS,
  adReportFacts,
  deriveRates,
  digestPrompt,
  formatCount,
  formatMoney,
  formatRange,
  ymdOfInstant,
  youtubeChannelFacts,
  type DateRange,
  type DatePreset,
  type DigestFacts,
} from "@/lib/marketing/marketingEngine";
import { buildAdChannel, buildYouTubeOverview, type AdChannel } from "./channels.server";
import { readLeadAttribution } from "./leads.server";

export const MARKETING_BUSINESS = "Aurixa Systems, read by the people who run its marketing";
/** The model every marketing brief is written with; recorded on each one. */
export const MARKETING_MODEL = "google/gemini-3-flash-preview";

export type DigestChannel = AdChannel | "youtube_channel";

export interface WrittenReport {
  id: string | null;
  content: string;
  model: string;
  facts: DigestFacts;
}

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

function aiFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/AI gateway 429/.test(message))
    return "The model provider is rate limiting — try again in a minute.";
  if (/AI gateway 402/.test(message)) return "AI credits are exhausted for this workspace.";
  if (/LOVABLE_API_KEY/.test(message))
    return "The AI gateway is not configured on this deployment.";
  return "The brief could not be written just now. The figures on the page are unaffected.";
}

function dollarsFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** The facts of one channel, re-read here. */
async function channelFacts(
  channel: DigestChannel,
  range: DateRange,
  preset: DatePreset | null,
  today: string,
  timeZone: string,
): Promise<DigestFacts | { unavailable: string }> {
  if (channel === "youtube_channel") {
    const o = await buildYouTubeOverview(range, today, timeZone);
    if (o.sources.data.state !== "ok" || !o.channel)
      return { unavailable: "The YouTube channel could not be read." };
    const t = o.analytics?.totals ?? null;
    const net = o.netSubscribers;
    const videos = o.uploads.videos.length > 0 ? o.uploads.videos : o.recent;
    return youtubeChannelFacts({
      channelTitle: o.channel.title,
      period: formatRange(range),
      subscribers: o.channel.subscribers,
      totalViews: o.channel.totalViews,
      uploadsInPeriod: o.uploads.inRange,
      uploadsPerWeek: o.uploads.perWeek,
      periodViews: t?.views ?? null,
      periodWatchMinutes: t?.watchTimeMinutes ?? null,
      averageViewSeconds: t ? deriveRates(t).averageWatchSeconds : null,
      netSubscribers: net?.value ?? null,
      netSubscribersBasis: net
        ? net.basis === "analytics"
          ? "YouTube Analytics"
          : `from Mission Control's readings over ${net.spanDays ?? "?"} days`
        : null,
      topTrafficSources: o.analytics?.trafficSources ?? [],
      topUploads: videos.slice(0, 8).map((v) => {
        const day = ymdOfInstant(v.publishedAt, timeZone);
        return {
          title: v.name,
          views: v.metrics.views,
          ageDays: day
            ? Math.max(
                0,
                Math.round(
                  (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000,
                ),
              )
            : null,
        };
      }),
      attributedLeads: o.leads ? o.leads.all : undefined,
      signals: o.signals,
      notes: [
        "Subscribers and lifetime views are YouTube’s counters as of today; each upload’s views are its lifetime views.",
        ...(t
          ? [
              "Period views, watch time and subscriber changes come from YouTube Analytics, which lags by up to three days.",
            ]
          : []),
      ],
    });
  }
  const view = await buildAdChannel({
    channel,
    range,
    preset,
    today,
    timeZone,
    level: "campaign",
    drill: {},
  });
  if (!view.report) return { unavailable: `${CHANNEL_LABELS[channel]} could not be read.` };
  const facts = adReportFacts({
    report: view.report,
    signals: view.signals,
    health: view.health,
    previousTotals: view.previousTotals,
    attributedLeads: view.leads ? view.leads.paid : undefined,
  });
  if (view.leads?.deals && view.leads.deals.won > 0) {
    facts.totals.push(
      {
        label: "Deals won from this period’s attributed leads (to date)",
        value: formatCount(view.leads.deals.won),
      },
      {
        label: "Monthly recurring revenue of those won deals",
        value: formatMoney(dollarsFromCents(view.leads.deals.wonMrrCents), "AUD"),
      },
    );
  }
  return facts;
}

async function store(args: {
  kind: "digest" | "weekly_brief";
  channel: DigestChannel | "all";
  range: DateRange;
  content: string;
  facts: DigestFacts;
  userId: string | null;
}): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("marketing_reports")
    .insert({
      kind: args.kind,
      channel: args.channel,
      range_since: args.range.since,
      range_until: args.range.until,
      content: args.content,
      facts: args.facts as unknown as Json,
      model: MARKETING_MODEL,
      created_by: args.userId,
    })
    .select("id")
    .single();
  if (error) {
    // The brief is returned whether or not it was kept; the page says which.
    console.error("[marketing] brief could not be stored", { code: error.code });
    return null;
  }
  return data.id;
}

async function write(facts: DigestFacts, userId: string | null): Promise<string> {
  const prompt = digestPrompt(facts, MARKETING_BUSINESS);
  try {
    const result = await callAi({
      feature: "marketing_digest",
      model: MARKETING_MODEL,
      system: prompt.system,
      prompt: prompt.user,
      userId,
      supabase: supabaseAdmin,
    });
    if (!result.content.trim()) throw new DigestError("The model returned nothing to show.");
    return result.content;
  } catch (error) {
    if (error instanceof DigestError) throw error;
    console.error("[marketing] model call failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
    throw new DigestError(aiFailure(error));
  }
}

export async function writeChannelDigest(args: {
  channel: DigestChannel;
  range: DateRange;
  preset: DatePreset | null;
  today: string;
  timeZone: string;
  userId: string | null;
}): Promise<WrittenReport> {
  const facts = await channelFacts(
    args.channel,
    args.range,
    args.preset,
    args.today,
    args.timeZone,
  );
  if ("unavailable" in facts)
    throw new DigestError(`${facts.unavailable} There is nothing to write a digest from.`);
  const content = await write(facts, args.userId);
  const id = await store({
    kind: "digest",
    channel: args.channel,
    range: args.range,
    content,
    facts,
    userId: args.userId,
  });
  return { id, content, model: MARKETING_MODEL, facts };
}

/**
 * One brief across every connected channel. Each channel's facts are kept
 * under its own name, so the model cannot add Meta's spend to TikTok's — and a
 * channel that could not be read is named as missing rather than left out in
 * silence.
 */
export async function writeWeeklyBrief(args: {
  range: DateRange;
  preset: DatePreset | null;
  today: string;
  timeZone: string;
  userId: string | null;
}): Promise<WrittenReport> {
  const channels: DigestChannel[] = ["meta_ads", "youtube_ads", "tiktok_ads", "youtube_channel"];
  const results = await Promise.all(
    channels.map((c) => channelFacts(c, args.range, args.preset, args.today, args.timeZone)),
  );
  const combined: DigestFacts = {
    channel: "cross-channel marketing",
    period: formatRange(args.range),
    totals: [],
    entities: [],
    findings: [],
    notes: [],
  };
  const missing: string[] = [];
  results.forEach((facts, i) => {
    const label = CHANNEL_LABELS[channels[i]];
    if ("unavailable" in facts) {
      missing.push(label);
      return;
    }
    for (const f of facts.totals)
      combined.totals.push({ label: `${label} — ${f.label}`, value: f.value });
    for (const e of facts.entities.slice(0, 3))
      combined.entities.push({ name: `${label}: ${e.name}`, facts: e.facts });
    for (const f of facts.findings) combined.findings.push({ ...f, title: `${label}: ${f.title}` });
    for (const n of facts.notes) combined.notes.push(`${label}: ${n}`);
  });
  if (combined.totals.length === 0)
    throw new DigestError("No channel could be read, so there is nothing to write a brief from.");

  const leads = await readLeadAttribution(args.range, args.timeZone);
  if (leads.ok) {
    combined.totals.push({
      label: "CRM leads in the period, all channels",
      value: formatCount(leads.summary.total),
    });
    combined.totals.push({
      label: "CRM leads with no channel evidence",
      value: formatCount(leads.summary.byChannel.unknown),
    });
  }
  if (missing.length > 0)
    combined.notes.push(
      `Not read for this brief: ${missing.join(", ")}. Say so; do not describe them.`,
    );
  combined.notes.push(
    "Each channel’s currency and view definition are its own; never add figures across channels.",
  );

  const content = await write(combined, args.userId);
  const id = await store({
    kind: "weekly_brief",
    channel: "all",
    range: args.range,
    content,
    facts: combined,
    userId: args.userId,
  });
  return { id, content, model: MARKETING_MODEL, facts: combined };
}

export interface StoredReport {
  id: string;
  kind: "digest" | "weekly_brief";
  channel: string;
  rangeSince: string;
  rangeUntil: string;
  content: string;
  model: string | null;
  createdAt: string;
}

export async function listReports(limit: number): Promise<StoredReport[]> {
  const { data, error } = await supabaseAdmin
    .from("marketing_reports")
    .select("id, kind, channel, range_since, range_until, content, model, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind as StoredReport["kind"],
    channel: r.channel,
    rangeSince: r.range_since,
    rangeUntil: r.range_until,
    content: r.content,
    model: r.model,
    createdAt: r.created_at,
  }));
}
