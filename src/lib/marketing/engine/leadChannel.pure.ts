/**
 * Which channel a lead came from, read from what the lead record carries.
 *
 * An advertising platform reports what IT counted. A lead in the CRM is what
 * the business actually received. Joining the two — spend from the platform,
 * leads from the CRM — is the only cost per lead that survives a platform
 * over-counting its own conversions, so the classifier is the hinge of every
 * "cost per attributed lead" on the page.
 *
 * THE EVIDENCE IS RANKED, AND THE RANK IS THE RULE
 * ------------------------------------------------
 * 1. A TikTok click id (`ttclid`) is definitive: only TikTok writes it.
 * 2. An explicit `utm_source` naming YouTube or TikTok comes before Google's
 *    click id, because a YouTube ad is a Google Ads campaign — its click
 *    carries a `gclid` — and only the UTM says the click came from YouTube.
 * 3. A referrer on youtube.com or tiktok.com.
 * 4. Meta's `fbclid`, or a Meta campaign id the enrichment recorded.
 * 5. Google's `gclid` / `gbraid` / `wbraid`: Google Ads, placement unknown. A
 *    gclid alone is NEVER read as YouTube — that would credit YouTube with
 *    search clicks.
 * 6. Any other `utm_source`, then the referrer's host, then the CRM's own
 *    free-text source.
 *
 * Every answer names the evidence it rests on, so a reader can see that a
 * lead was put on YouTube because its UTM said so, not because of a guess.
 */
import type { DateRange } from './marketingTypes.pure.ts';
import { rangeContains, ymdOfInstant } from './marketingRange.pure.ts';

export type LeadChannel =
  | 'meta'
  | 'youtube'
  | 'tiktok'
  | 'google_ads'
  | 'organic_search'
  | 'linkedin'
  | 'email'
  | 'referral'
  | 'direct'
  | 'other'
  | 'unknown';

export const LEAD_CHANNEL_LABELS: Record<LeadChannel, string> = {
  meta: 'Meta (Facebook & Instagram)',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  google_ads: 'Google Ads',
  organic_search: 'Organic search',
  linkedin: 'LinkedIn',
  email: 'Email',
  referral: 'Referral',
  direct: 'Direct',
  other: 'Other',
  unknown: 'Unknown',
};

export type LeadEvidence =
  | 'ttclid'
  | 'fbclid'
  | 'gclid'
  | 'meta_campaign'
  | 'utm_source'
  | 'utm_medium'
  | 'referrer'
  | 'crm_source'
  | 'landing_page_only'
  | 'none';

/**
 * The fields a lead record may carry. Both deployments' tables are accepted:
 * the prime's `lead_source_attributions` (`landing_page_url`, `referrer_url`,
 * `ghl_attribution_source`) and Mission Control's `waitlist_leads`
 * (`landing_page`, `referrer`, `source`).
 */
export interface LeadSourceFields {
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  fbclid?: unknown;
  gclid?: unknown;
  ttclid?: unknown;
  meta_campaign_id?: unknown;
  landing_page_url?: unknown;
  landing_page?: unknown;
  conversion_page_url?: unknown;
  referrer_url?: unknown;
  referrer?: unknown;
  ghl_attribution_source?: unknown;
  ghl_last_attribution_source?: unknown;
  source?: unknown;
}

export interface LeadClassification {
  channel: LeadChannel;
  evidence: LeadEvidence;
  /** The campaign the lead names, where it names one (`utm_campaign`). */
  campaign: string | null;
  /**
   * Whether the click was paid for: true for an ad click id or a paid
   * `utm_medium`, false for an organic medium or a plain referral, null where
   * nothing says. Meta's `fbclid` alone is NOT paid — Facebook adds it to
   * every outbound link, organic posts included.
   */
  paid: boolean | null;
}

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'cpm', 'cpv', 'paid', 'paidsocial', 'paid_social', 'paid-social', 'paidsearch', 'paid_search', 'ads', 'ad', 'display', 'video_ads', 'sponsored', 'boosted', 'sem', 'retargeting']);
const ORGANIC_MEDIUMS = new Set(['organic', 'social', 'organic_social', 'organic-social', 'referral', 'email', 'none', '(none)', 'bio', 'profile', 'post', 'description', 'seo']);

/** What the medium says about payment, or null where it says nothing. */
export function paidFromMedium(medium: string): boolean | null {
  const m = medium.toLowerCase().trim();
  if (m === '') return null;
  if (PAID_MEDIUMS.has(m)) return true;
  if (ORGANIC_MEDIUMS.has(m)) return false;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function lower(value: unknown): string {
  return (text(value) ?? '').toLowerCase();
}

function parseUrl(value: unknown): URL | null {
  const t = text(value);
  if (!t) return null;
  try {
    return new URL(t);
  } catch {
    try {
      return new URL(`https://${t}`);
    } catch {
      return null;
    }
  }
}

function hostOf(value: unknown): string | null {
  return parseUrl(value)?.hostname.toLowerCase().replace(/^www\./, '') ?? null;
}

function hostIs(host: string | null, domains: readonly string[]): boolean {
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** A query parameter on any of the URLs the lead carries. */
function urlParam(fields: LeadSourceFields, name: string): string | null {
  for (const candidate of [fields.landing_page_url, fields.landing_page, fields.conversion_page_url]) {
    const url = parseUrl(candidate);
    const v = url?.searchParams.get(name);
    if (v && v.trim() !== '') return v.trim();
  }
  return null;
}

const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];
const TIKTOK_HOSTS = ['tiktok.com', 'tiktokv.com'];
const META_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'messenger.com', 'threads.net'];
const LINKEDIN_HOSTS = ['linkedin.com', 'lnkd.in'];
const SEARCH_HOSTS = ['google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'ecosia.org', 'search.brave.com', 'baidu.com', 'yandex.com'];
const EMAIL_HOSTS = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com'];

/** Google search answers on a country domain (`google.com.au`), so its host is matched by label. */
function isSearchHost(host: string | null): boolean {
  if (!host) return false;
  if (hostIs(host, SEARCH_HOSTS)) return true;
  return /(^|\.)google\.[a-z.]{2,6}$/.test(host);
}

/** A source word, read as a channel. Short tokens are matched whole so `fb` never matches `fbclid-test`. */
export function channelOfSourceWord(word: string, medium = ''): LeadChannel | null {
  const w = word.toLowerCase().trim();
  if (w === '') return null;
  const tokens = w.split(/[^a-z0-9.]+/).filter(Boolean);
  const has = (...t: string[]) => tokens.some((x) => t.includes(x));
  if (w.includes('tiktok') || w.includes('tik tok') || w.includes('tik-tok') || has('tt')) return 'tiktok';
  if (w.includes('youtube') || w.includes('youtu.be') || has('yt')) return 'youtube';
  if (w.includes('facebook') || w.includes('instagram') || w.includes('messenger') || has('fb', 'ig', 'meta', 'insta')) return 'meta';
  if (w.includes('linkedin') || has('lnkd')) return 'linkedin';
  const m = medium.toLowerCase();
  if (w.includes('google') || has('adwords', 'gads', 'pmax')) {
    return m === 'organic' || m === 'seo' ? 'organic_search' : 'google_ads';
  }
  if (has('bing', 'duckduckgo', 'yahoo', 'ecosia')) return m === 'cpc' || m === 'ppc' || m === 'paid' ? 'other' : 'organic_search';
  if (w.includes('newsletter') || w.includes('email') || w.includes('mailchimp') || w.includes('klaviyo') || w.includes('resend')) return 'email';
  return null;
}

/** GoHighLevel's session-source words ("Paid Social", "Organic Search", "Direct traffic"). */
function channelOfCrmWords(value: string): LeadChannel | null {
  const v = value.toLowerCase();
  const named = channelOfSourceWord(v);
  if (named) return named;
  if (v.includes('organic search')) return 'organic_search';
  if (v.includes('direct')) return 'direct';
  if (v.includes('referral')) return 'referral';
  if (v.includes('email')) return 'email';
  return null;
}

export function classifyLeadChannel(fields: LeadSourceFields): LeadClassification {
  const campaign = text(fields.utm_campaign) ?? urlParam(fields, 'utm_campaign');
  const utmSource = lower(fields.utm_source) || (urlParam(fields, 'utm_source') ?? '').toLowerCase();
  const utmMedium = lower(fields.utm_medium) || (urlParam(fields, 'utm_medium') ?? '').toLowerCase();
  const mediumPaid = paidFromMedium(utmMedium);
  const result = (channel: LeadChannel, evidence: LeadEvidence): LeadClassification => {
    // An ad click id is payment by construction; Meta's fbclid is not (see `paid`).
    const byEvidence = evidence === 'ttclid' || evidence === 'gclid' || evidence === 'meta_campaign'
      ? true
      : evidence === 'referrer' || evidence === 'landing_page_only'
        ? false
        : null;
    return { channel, evidence, campaign, paid: byEvidence ?? mediumPaid };
  };

  // 1. TikTok's own click id.
  if (text(fields.ttclid) || urlParam(fields, 'ttclid')) return result('tiktok', 'ttclid');

  // 2. A UTM that names YouTube or TikTok outranks Google's click id.
  const utmChannel = utmSource ? channelOfSourceWord(utmSource, utmMedium) : null;
  if (utmChannel === 'youtube' || utmChannel === 'tiktok') return result(utmChannel, 'utm_source');

  // 3. A referrer on YouTube or TikTok.
  const referrerHost = hostOf(fields.referrer_url) ?? hostOf(fields.referrer);
  if (hostIs(referrerHost, YOUTUBE_HOSTS)) return result('youtube', 'referrer');
  if (hostIs(referrerHost, TIKTOK_HOSTS)) return result('tiktok', 'referrer');

  // 4. Meta's click id, or the campaign the enrichment matched.
  if (text(fields.fbclid) || urlParam(fields, 'fbclid')) return result('meta', 'fbclid');
  if (text(fields.meta_campaign_id)) return result('meta', 'meta_campaign');

  // 5. Google's click ids: Google Ads, placement unknown.
  if (text(fields.gclid) || urlParam(fields, 'gclid') || urlParam(fields, 'gbraid') || urlParam(fields, 'wbraid')) {
    return result('google_ads', 'gclid');
  }

  // 6. Any other UTM source.
  if (utmChannel) return result(utmChannel, 'utm_source');
  if (utmSource) return result('other', 'utm_source');
  if (utmMedium === 'email') return result('email', 'utm_medium');

  // 7. The referrer's host.
  if (hostIs(referrerHost, META_HOSTS)) return result('meta', 'referrer');
  if (hostIs(referrerHost, LINKEDIN_HOSTS)) return result('linkedin', 'referrer');
  if (hostIs(referrerHost, EMAIL_HOSTS)) return result('email', 'referrer');
  if (isSearchHost(referrerHost)) return result('organic_search', 'referrer');

  // 8. The CRM's own words for the source.
  for (const crm of [fields.ghl_attribution_source, fields.ghl_last_attribution_source, fields.source]) {
    const t = text(crm);
    if (!t) continue;
    const c = channelOfCrmWords(t);
    if (c) return result(c, 'crm_source');
  }

  if (referrerHost) {
    const landingHost = hostOf(fields.landing_page_url) ?? hostOf(fields.landing_page);
    // A referrer on the site's own host is navigation, not a source.
    if (landingHost && referrerHost === landingHost) return result('direct', 'landing_page_only');
    return result('referral', 'referrer');
  }
  if (text(fields.landing_page_url) || text(fields.landing_page) || text(fields.conversion_page_url)) {
    return result('direct', 'landing_page_only');
  }
  return result('unknown', 'none');
}

export interface LeadChannelSummary {
  total: number;
  /** Leads the classifier could not place on any channel. */
  unknown: number;
  byChannel: Record<LeadChannel, number>;
  /** Of `byChannel`, the leads whose click was paid for. */
  paidByChannel: Record<LeadChannel, number>;
  /** Of `byChannel`, the leads whose click was organic. The rest said neither. */
  organicByChannel: Record<LeadChannel, number>;
  /** Per channel, the campaigns its leads named (`utm_campaign`), largest first. */
  campaigns: Partial<Record<LeadChannel, Array<{ campaign: string; leads: number }>>>;
  /** How many leads each kind of evidence placed. */
  byEvidence: Partial<Record<LeadEvidence, number>>;
}

function emptyCounts(): Record<LeadChannel, number> {
  return {
    meta: 0,
    youtube: 0,
    tiktok: 0,
    google_ads: 0,
    organic_search: 0,
    linkedin: 0,
    email: 0,
    referral: 0,
    direct: 0,
    other: 0,
    unknown: 0,
  };
}

/**
 * Count the leads that arrived inside a range, by channel.
 *
 * `dateOf` reads the instant the lead arrived; a lead whose date cannot be
 * read is left out of a ranged count rather than placed on an arbitrary day.
 */
export function summariseLeadChannels<T extends LeadSourceFields>(
  leads: readonly T[],
  options: { range?: DateRange; timeZone: string; dateOf: (lead: T) => unknown },
): LeadChannelSummary {
  const byChannel = emptyCounts();
  const paidByChannel = emptyCounts();
  const organicByChannel = emptyCounts();
  const campaignCounts = new Map<LeadChannel, Map<string, number>>();
  const byEvidence: Partial<Record<LeadEvidence, number>> = {};
  let total = 0;
  for (const lead of leads) {
    if (options.range) {
      const day = ymdOfInstant(options.dateOf(lead), options.timeZone);
      if (!day || !rangeContains(options.range, day)) continue;
    }
    const c = classifyLeadChannel(lead);
    total += 1;
    byChannel[c.channel] += 1;
    if (c.paid === true) paidByChannel[c.channel] += 1;
    if (c.paid === false) organicByChannel[c.channel] += 1;
    byEvidence[c.evidence] = (byEvidence[c.evidence] ?? 0) + 1;
    if (c.campaign) {
      const map = campaignCounts.get(c.channel) ?? new Map<string, number>();
      map.set(c.campaign, (map.get(c.campaign) ?? 0) + 1);
      campaignCounts.set(c.channel, map);
    }
  }
  const campaigns: LeadChannelSummary['campaigns'] = {};
  for (const [channel, map] of campaignCounts) {
    campaigns[channel] = [...map.entries()]
      .map(([campaign, n]) => ({ campaign, leads: n }))
      .sort((a, b) => b.leads - a.leads || a.campaign.localeCompare(b.campaign));
  }
  return { total, unknown: byChannel.unknown, byChannel, paidByChannel, organicByChannel, campaigns, byEvidence };
}
