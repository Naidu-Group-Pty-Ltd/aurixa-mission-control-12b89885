/**
 * The marketing engine's vocabulary — one shape for every advertising and
 * video channel the Marketing module reads.
 *
 * ONE ENGINE, TWO REPOSITORIES
 * ----------------------------
 * The files in this directory are byte-identical in the prime
 * (`supabase/functions/_shared/marketing/`) and in Aurixa Mission Control
 * (`src/lib/marketing/engine/`). The prime reads a property agency's own
 * channels; Mission Control reads Aurixa Systems' own. The judgement of what a
 * number means — what counts as a view, when a cost per result may be stated,
 * which lead came from which channel — is the same question in both places, so
 * it is answered once. Each repository pins the bytes it holds against
 * `MARKETING_ENGINE.lock.json`; a change made on one side fails the other's
 * suite until it is carried across.
 *
 * Every module here is pure: no imports outside this directory, no Deno or
 * Node globals, no network. It parses what a vendor answered and decides what
 * may be said about it. The callers fetch.
 *
 * ABSENT IS NEVER ZERO
 * --------------------
 * A metric is `number | null`. `null` means the source did not measure it —
 * a channel that has no notion of "reach", a figure the vendor withheld, a
 * credential that was never configured. Zero means the source measured it and
 * it was zero. The two must never be collapsed: a cost per lead computed over
 * an unmeasured lead count is a fabrication, and a channel that reports no
 * conversions is not a channel that converted nothing.
 */

/** The channels this engine knows how to read. */
export type MarketingChannel =
  | 'meta_ads'
  | 'youtube_channel'
  | 'youtube_ads'
  | 'tiktok_ads';

/** A figure the source measured, or `null` where it did not. Never a stand-in zero. */
export type Measured = number | null;

/**
 * Every figure a channel can report, in units a reader can add.
 *
 * Rates are deliberately absent: a rate cannot be summed across days or
 * campaigns, so the engine carries counts and derives rates from them
 * (`deriveRates`). Where a vendor answers only with a rate — Google Ads'
 * video quartiles are a share of impressions — the parser turns it back into
 * a count against the impressions it was measured over.
 */
export interface MetricSet {
  /** Money spent, in the report's `currency` (whole units, never micros). */
  spend: Measured;
  impressions: Measured;
  reach: Measured;
  clicks: Measured;
  /** The channel's own definition of a view — see `ChannelReport.viewDefinition`. */
  views: Measured;
  /** Video starts, where the channel separates a start from a view. */
  videoPlays: Measured;
  /** Plays that lasted at least two seconds (TikTok). */
  views2s: Measured;
  /** Plays that lasted at least six seconds (TikTok). */
  views6s: Measured;
  /** Plays that reached each quarter of the video. */
  quartile25: Measured;
  quartile50: Measured;
  quartile75: Measured;
  quartile100: Measured;
  /** Total time watched, in minutes. */
  watchTimeMinutes: Measured;
  /** Results of the campaign's optimisation goal (TikTok `result`, Meta leads). */
  results: Measured;
  conversions: Measured;
  /** Conversion value, in `currency`. */
  conversionValue: Measured;
  likes: Measured;
  comments: Measured;
  shares: Measured;
  /** Interactions the vendor counts as engagement and does not break down. */
  engagements: Measured;
  /** New followers or subscribers. */
  follows: Measured;
  /** Followers or subscribers lost. */
  unfollows: Measured;
  profileVisits: Measured;
}

export type MetricKey = keyof MetricSet;

/** The levels a report can describe. `video` is an organic upload. */
export type EntityLevel = 'account' | 'campaign' | 'adgroup' | 'ad' | 'video';

/** One campaign, ad group, ad or video, with its figures over the report's range. */
export interface EntityRow {
  id: string;
  name: string;
  level: EntityLevel;
  /** The campaign an ad group belongs to, or the ad group an ad belongs to. */
  parentId: string | null;
  parentName: string | null;
  /** The vendor's own status word, verbatim. Never translated into a judgement. */
  status: string | null;
  /** The vendor's own objective or campaign type, verbatim. */
  objective: string | null;
  metrics: MetricSet;
  /** Uploads only. ISO 8601 instant. */
  publishedAt: string | null;
  /** Uploads only. */
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  url: string | null;
}

/** The figures for one calendar day, in the account's own time zone. */
export interface DailyPoint {
  /** YYYY-MM-DD. */
  date: string;
  metrics: MetricSet;
}

/** A closed calendar range, both ends inclusive, as YYYY-MM-DD. */
export interface DateRange {
  since: string;
  until: string;
}

/**
 * Why a source did not answer. Each word sends a reader somewhere different:
 * `not_configured` and `credentials_rejected` are this deployment's settings,
 * `quota_exhausted` and `rate_limited` are a wait, `vendor_unavailable` is the
 * vendor, `not_found` is an id that names nothing, and `request_rejected` is
 * the request this engine built — a defect of ours, never the customer's.
 */
export type SourceErrorReason =
  | 'credentials_rejected'
  | 'permission_denied'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'not_found'
  | 'request_rejected'
  | 'vendor_unavailable'
  | 'unreadable_answer'
  | 'unknown';

/** Whether a source answered, and if not, which of the four ways it did not. */
export type SourceState =
  | { state: 'ok' }
  | { state: 'not_configured'; missing: string[] }
  | { state: 'error'; reason: SourceErrorReason; message: string; status: number | null }
  | { state: 'not_requested' };

/** Everything one channel reported over one range, in the engine's vocabulary. */
export interface ChannelReport {
  channel: MarketingChannel;
  /** The vendor's identifier for the account read (channel id, advertiser id). Never a secret. */
  accountRef: string | null;
  accountName: string | null;
  /** ISO 4217, as the vendor states it. Null where the vendor did not say. */
  currency: string | null;
  range: DateRange;
  totals: MetricSet;
  daily: DailyPoint[];
  entities: EntityRow[];
  /** The metrics this source is able to measure at all. Anything else is `null` by construction. */
  measures: MetricKey[];
  /** What `views` means on this channel, in a reader's words. */
  viewDefinition: string | null;
  /** Provenance and limits, written for the person reading the page. */
  notes: string[];
}

/** Severity of a finding, in the order a reader should act on it. */
export type SignalSeverity = 'critical' | 'warning' | 'info';

/** One deterministic finding about one entity or about the whole account. */
export interface ChannelSignal {
  id: string;
  severity: SignalSeverity;
  /** Stable machine word for the rule that fired. */
  rule: string;
  entityId: string | null;
  entityName: string | null;
  title: string;
  description: string;
  /** The figure that tripped the rule, in the unit `unit` names. */
  value: number;
  /** The figure it was compared with. */
  threshold: number;
  unit: 'currency' | 'percent' | 'ratio' | 'count' | 'days';
}

/** One factor of a health score. `null` where the entity cannot be judged on it. */
export interface HealthFactor {
  key: string;
  label: string;
  score: number | null;
  weight: number;
}

/** A 0–100 judgement of one entity, or `null` where too little was measured to judge. */
export interface EntityHealth {
  entityId: string;
  entityName: string;
  score: number | null;
  status: 'healthy' | 'watch' | 'action_needed' | 'not_scored';
  factors: HealthFactor[];
  recommendations: string[];
}
