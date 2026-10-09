/**
 * What each marketing source needs to be connected, said once for the form
 * that collects it and the server that validates and stores it.
 *
 * Two kinds of field, and the difference is the whole security model of the
 * Connections page:
 *
 * - a SETTING names an account and grants nothing (an ad account id, a channel
 *   id, an API version). It is stored in clear and shown back to the operator.
 * - a SECRET grants access (a token, a key, an OAuth client secret). It is
 *   encrypted by the application before it is stored, it is never returned to
 *   a browser — the page shows a fingerprint — and leaving it blank on a later
 *   save keeps the stored one rather than clearing it.
 *
 * The OAuth client id is a setting: Google publishes it in every consent URL.
 */

export const MARKETING_SOURCES = [
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "youtube_data",
  "youtube_analytics",
] as const;

export type MarketingSource = (typeof MARKETING_SOURCES)[number];

export interface ConnectionField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** What a valid value looks like, for the form and the server alike. */
  pattern?: RegExp;
  /** Said when the pattern refuses a value. */
  invalid?: string;
  help?: string;
  placeholder?: string;
}

export interface SourceDefinition {
  source: MarketingSource;
  label: string;
  /** What connecting it adds to the Marketing pages. */
  provides: string;
  fields: ConnectionField[];
  /** Where the operator gets the credentials. */
  setup: string[];
}

export const SOURCE_DEFINITIONS: Record<MarketingSource, SourceDefinition> = {
  meta_ads: {
    source: "meta_ads",
    label: "Meta Ads",
    provides:
      "Spend, reach, clicks, video plays and lead results for Aurixa's Facebook and Instagram campaigns, by campaign, ad set and ad.",
    fields: [
      {
        key: "ad_account_id",
        label: "Ad account id",
        secret: false,
        required: true,
        pattern: /^(act_)?\d{5,20}$/,
        invalid: "an ad account id is a number, optionally written act_1234567890",
        placeholder: "act_1234567890",
      },
      {
        key: "access_token",
        label: "Access token",
        secret: true,
        required: true,
        help: "A system-user token with ads_read on the ad account. User tokens expire within weeks; a system user's does not.",
      },
      {
        key: "api_version",
        label: "Graph API version",
        secret: false,
        required: false,
        pattern: /^v\d{2}\.0$/,
        invalid: "a Graph API version looks like v25.0",
        placeholder: "v25.0",
        help: "Leave blank for the engine's default.",
      },
    ],
    setup: [
      "Meta Business Settings → Users → System users → add a system user with the ad account assigned.",
      "Generate a token for it with the ads_read permission.",
      "The ad account id is in Ads Manager's account switcher.",
    ],
  },
  google_ads: {
    source: "google_ads",
    label: "Google Ads (YouTube)",
    provides:
      "Spend, TrueView views, view rate, cost per view, video completion and conversions for campaigns running on YouTube.",
    fields: [
      {
        key: "customer_id",
        label: "Customer id",
        secret: false,
        required: true,
        pattern: /^\d{3}-?\d{3}-?\d{4}$/,
        invalid: "a customer id is ten digits, written 123-456-7890",
        placeholder: "123-456-7890",
      },
      {
        key: "login_customer_id",
        label: "Manager account id",
        secret: false,
        required: false,
        pattern: /^\d{3}-?\d{3}-?\d{4}$/,
        invalid: "a manager account id is ten digits, written 123-456-7890",
        help: "Only when access to the customer comes through a manager (MCC) account.",
      },
      {
        key: "developer_token",
        label: "Developer token",
        secret: true,
        required: true,
        help: "From the Google Ads API Center; Basic access or above.",
      },
      {
        key: "client_id",
        label: "OAuth client id",
        secret: false,
        required: true,
        pattern: /\.apps\.googleusercontent\.com$/,
        invalid: "an OAuth client id ends in .apps.googleusercontent.com",
      },
      { key: "client_secret", label: "OAuth client secret", secret: true, required: true },
      {
        key: "refresh_token",
        label: "Refresh token",
        secret: true,
        required: true,
        help: "From a user who can see the customer, consented with the scope https://www.googleapis.com/auth/adwords.",
      },
      {
        key: "api_version",
        label: "API version",
        secret: false,
        required: false,
        pattern: /^v\d{2}$/,
        invalid: "a Google Ads API version looks like v25",
        placeholder: "v25",
        help: "Leave blank for the engine's default.",
      },
    ],
    setup: [
      "Google Ads → Tools → API Center: apply for a developer token.",
      "Google Cloud console: enable the Google Ads API and create an OAuth client.",
      "Consent once as a user with access to the account, offline access, scope adwords; keep the refresh token.",
    ],
  },
  tiktok_ads: {
    source: "tiktok_ads",
    label: "TikTok Ads",
    provides:
      "Spend, plays, two- and six-second holds, completion, engagement, follows and results for Aurixa's TikTok campaigns.",
    fields: [
      {
        key: "advertiser_id",
        label: "Advertiser id",
        secret: false,
        required: true,
        pattern: /^\d{6,25}$/,
        invalid: "an advertiser id is a long number",
      },
      {
        key: "access_token",
        label: "Access token",
        secret: true,
        required: true,
        help: "A TikTok for Business app's long-lived token, authorised by the advertiser with the Ads Management and Reporting scopes.",
      },
    ],
    setup: [
      "TikTok for Business developers: create an app with Ads Management and Reporting.",
      "Have the advertiser authorise it; exchange the auth code for the long-lived access token.",
    ],
  },
  youtube_data: {
    source: "youtube_data",
    label: "YouTube channel",
    provides:
      "The channel's subscribers, lifetime views and every upload. With no history in the API, growth is recorded here day by day.",
    fields: [
      {
        key: "channel_id",
        label: "Channel id",
        secret: false,
        required: true,
        pattern: /^UC[A-Za-z0-9_-]{22}$/,
        invalid: "a channel id starts with UC and is 24 characters long",
        placeholder: "UC…",
      },
      {
        key: "api_key",
        label: "API key",
        secret: true,
        required: true,
        help: "A Google Cloud API key restricted to the YouTube Data API v3.",
      },
    ],
    setup: [
      "Google Cloud console: enable the YouTube Data API v3 and create an API key; restrict it to that API.",
      "The channel id is on YouTube Studio → Settings → Channel → Advanced settings.",
    ],
  },
  youtube_analytics: {
    source: "youtube_analytics",
    label: "YouTube Analytics",
    provides:
      "Each day's views, watch time, subscribers gained and lost, traffic sources and the period's most-watched videos — with the channel owner's consent.",
    fields: [
      {
        key: "client_id",
        label: "OAuth client id",
        secret: false,
        required: true,
        pattern: /\.apps\.googleusercontent\.com$/,
        invalid: "an OAuth client id ends in .apps.googleusercontent.com",
      },
      { key: "client_secret", label: "OAuth client secret", secret: true, required: true },
      {
        key: "refresh_token",
        label: "Refresh token",
        secret: true,
        required: true,
        help: "The channel owner's consent with the scope https://www.googleapis.com/auth/yt-analytics.readonly.",
      },
    ],
    setup: [
      "Google Cloud console: enable the YouTube Analytics API and create an OAuth client.",
      "Have the channel owner consent once, offline access, scope yt-analytics.readonly; keep the refresh token.",
    ],
  },
};

export function isMarketingSource(value: unknown): value is MarketingSource {
  return typeof value === "string" && (MARKETING_SOURCES as readonly string[]).includes(value);
}

/** The fields a source still needs, by key. A stored secret counts as present. */
export function missingFields(
  source: MarketingSource,
  settings: Record<string, string>,
  storedSecrets: ReadonlySet<string>,
): string[] {
  return SOURCE_DEFINITIONS[source].fields
    .filter((f) => f.required)
    .filter((f) => (f.secret ? !storedSecrets.has(f.key) : !(settings[f.key] ?? "").trim()))
    .map((f) => f.key);
}

/**
 * Validate what an operator submitted. Settings and secrets arrive as plain
 * strings; a blank secret means "keep the stored one", a blank setting clears
 * it (and is refused if required). Unknown keys are refused rather than
 * dropped, because a misspelt field saved silently is a connection that
 * "saves" and never works.
 */
export function validateSubmission(
  source: MarketingSource,
  input: { settings: Record<string, string>; secrets: Record<string, string> },
):
  | { ok: true; settings: Record<string, string>; secrets: Record<string, string> }
  | { ok: false; error: string } {
  const def = SOURCE_DEFINITIONS[source];
  const known = new Map(def.fields.map((f) => [f.key, f]));
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input.settings)) {
    const field = known.get(key);
    if (!field || field.secret)
      return { ok: false, error: `${def.label} has no setting called "${key}"` };
    const value = raw.trim();
    if (!value) continue;
    if (field.pattern && !field.pattern.test(value))
      return { ok: false, error: `${field.label}: ${field.invalid ?? "not a valid value"}` };
    settings[key] = value;
  }
  for (const [key, raw] of Object.entries(input.secrets)) {
    const field = known.get(key);
    if (!field || !field.secret)
      return { ok: false, error: `${def.label} has no credential called "${key}"` };
    const value = raw.trim();
    if (!value) continue;
    if (value.length < 8)
      return { ok: false, error: `${field.label}: that is too short to be a credential` };
    if (/\s/.test(value))
      return { ok: false, error: `${field.label}: a credential has no spaces in it` };
    secrets[key] = value;
  }
  return { ok: true, settings, secrets };
}
