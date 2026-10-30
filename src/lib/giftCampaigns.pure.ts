/**
 * Past gift campaigns, rolled up from the ledger rows they wrote.
 *
 * `bulkGiftTokens` writes one `token_ledger` row per tenant, each tagged with
 * the campaign id and each carrying the expiry the operator set. The "Past
 * campaigns" list read the id, the tokens and the tenant count back and left
 * `expires_at` behind, so an operator who set an expiry could never read it
 * again.
 *
 * One request writes every row of a campaign, so they normally share one
 * expiry. When they do not, which takes a change to the ledger afterwards, the
 * campaign says so and gives the spread, rather than showing one row's value
 * as if it were the campaign's.
 *
 * Client-safe: pure. The server function rolls up with it and the page words
 * the expiry with it.
 */

/** The `token_ledger` columns a campaign is rolled up from. */
export type GiftLedgerRow = {
  source_ref: string | null;
  tokens: number;
  reason: string | null;
  metadata: unknown;
  created_at: string;
  expires_at: string | null;
};

/**
 * When a campaign's grants expire.
 *
 * A null `expires_at` never expires: the balance counts a grant while
 * `expires_at IS NULL OR expires_at > now()`. `mixed` bounds the rows that do
 * expire with `earliest` and `latest`, and counts the ones that never do.
 */
export type GiftCampaignExpiry =
  | { kind: "none" }
  | { kind: "at"; expiresAt: string }
  | { kind: "mixed"; earliest: string; latest: string; neverExpire: number };

export type GiftCampaign = {
  campaignId: string;
  campaignName: string;
  reason: string;
  tenants: number;
  totalTokens: number;
  tokensPerTenant: number;
  createdAt: string;
  grantedBy: string | null;
  expiry: GiftCampaignExpiry;
};

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Each campaign's rows' expiries, compared as instants rather than as spellings. */
type ExpiryTally = { dated: Map<number, string>; neverExpire: number };

function expiryOf(tally: ExpiryTally): GiftCampaignExpiry {
  if (tally.dated.size === 0) return { kind: "none" };
  const instants = [...tally.dated.keys()].sort((a, b) => a - b);
  const earliest = tally.dated.get(instants[0]) as string;
  if (instants.length === 1 && tally.neverExpire === 0) return { kind: "at", expiresAt: earliest };
  const latest = tally.dated.get(instants[instants.length - 1]) as string;
  return { kind: "mixed", earliest, latest, neverExpire: tally.neverExpire };
}

/**
 * One entry per campaign id, in the order the rows arrive: newest first, as
 * `listGiftCampaigns` reads them, so each campaign takes its name, date and
 * operator from its most recent row.
 */
export function rollUpGiftCampaigns(rows: readonly GiftLedgerRow[]): GiftCampaign[] {
  const campaigns = new Map<string, Omit<GiftCampaign, "expiry">>();
  const tallies = new Map<string, ExpiryTally>();
  for (const row of rows) {
    const key = row.source_ref ?? "unknown";
    const existing = campaigns.get(key);
    if (existing) {
      existing.tenants++;
      existing.totalTokens += row.tokens;
    } else {
      campaigns.set(key, {
        campaignId: key,
        campaignName: metadataString(row.metadata, "campaign_name") ?? row.reason ?? "",
        reason: row.reason ?? "",
        tenants: 1,
        totalTokens: row.tokens,
        tokensPerTenant: row.tokens,
        createdAt: row.created_at,
        grantedBy: metadataString(row.metadata, "granted_by"),
      });
      tallies.set(key, { dated: new Map(), neverExpire: 0 });
    }
    const tally = tallies.get(key) as ExpiryTally;
    if (row.expires_at === null) {
      tally.neverExpire++;
    } else {
      const instant = Date.parse(row.expires_at);
      if (!tally.dated.has(instant)) tally.dated.set(instant, row.expires_at);
    }
  }
  return [...campaigns.values()].map((campaign) => ({
    ...campaign,
    expiry: expiryOf(tallies.get(campaign.campaignId) as ExpiryTally),
  }));
}

/** The expiry as a campaign row states it. `formatDate` is the page's own date format. */
export function describeGiftCampaignExpiry(
  expiry: GiftCampaignExpiry,
  formatDate: (iso: string) => string,
): string {
  switch (expiry.kind) {
    case "none":
      return "no expiry";
    case "at":
      return `expires ${formatDate(expiry.expiresAt)}`;
    case "mixed": {
      const dated =
        expiry.earliest === expiry.latest
          ? formatDate(expiry.earliest)
          : `between ${formatDate(expiry.earliest)} and ${formatDate(expiry.latest)}`;
      if (expiry.neverExpire === 0)
        return `expiry differs between its grants: they expire ${dated}`;
      const never =
        expiry.neverExpire === 1 ? "1 has no expiry" : `${expiry.neverExpire} have no expiry`;
      return `expiry differs between its grants: ${never}, the rest expire ${dated}`;
    }
  }
}
