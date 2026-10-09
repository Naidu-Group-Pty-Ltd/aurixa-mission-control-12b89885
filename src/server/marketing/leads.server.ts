// Where Aurixa's leads came from, and what they became.
//
// A lead is a `waitlist_leads` row: the form on the marketing site records its
// UTM tags, referrer and landing page, and the marketing engine's one
// classifier (`leadChannel.pure.ts`, the same file the prime's Marketing page
// uses) places it on a channel by its strongest evidence — a click id in the
// landing page, then a UTM tag, then the referrer, then the source word. A
// lead with no evidence is Unknown, never guessed.
//
// A lead becomes revenue through `crm_deals`, joined by the account the lead
// was converted into. Two rules keep that honest:
//
// - **First touch inside the period.** An account with leads on more than one
//   channel in the range is credited to the channel of its EARLIEST lead in
//   the range, once. Crediting every channel would count one deal twice.
// - **Won at any time since.** The deals are those of the period's leads, won
//   whenever they were won — the question is "what did the leads we paid for
//   in September become", not "what closed in September". The page says so.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  addDays,
  classifyLeadChannel,
  rangeContains,
  summariseLeadChannels,
  ymdOfInstant,
  type DateRange,
  type LeadChannel,
  type LeadChannelSummary,
  type LeadClassification,
} from "@/lib/marketing/marketingEngine";

/** More rows than this in one range is not a page a person reads; the answer says it was capped. */
export const LEAD_READ_LIMIT = 10_000;

export interface DealOutcome {
  /** Accounts first touched by this channel in the period that have any deal. */
  accounts: number;
  open: number;
  won: number;
  lost: number;
  /** Sum of expected MRR on won deals, in cents. */
  wonMrrCents: number;
  /** Sum of setup fees on won deals, in cents. */
  wonSetupCents: number;
}

export interface AttributedLead {
  id: string;
  createdAt: string;
  name: string;
  organisation: string | null;
  accountId: string | null;
  stage: number;
  status: string;
  classification: LeadClassification;
}

export type LeadAttribution =
  | {
      ok: true;
      summary: LeadChannelSummary;
      capped: boolean;
      deals: Partial<Record<LeadChannel, DealOutcome>>;
      dealsRead: boolean;
      recent: AttributedLead[];
    }
  | { ok: false; message: string };

const SELECT =
  "id, created_at, first_name, last_name, entity_name, account_id, stage, status, source, utm_source, utm_medium, utm_campaign, landing_page, referrer";

type LeadRow = {
  id: string;
  created_at: string;
  first_name: string;
  last_name: string;
  entity_name: string | null;
  account_id: string | null;
  stage: number;
  status: string;
  source: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  landing_page: string | null;
  referrer: string | null;
};

function emptyOutcome(): DealOutcome {
  return { accounts: 0, open: 0, won: 0, lost: 0, wonMrrCents: 0, wonSetupCents: 0 };
}

export async function readLeadAttribution(
  range: DateRange,
  timeZone: string,
  options: { recent?: number } = {},
): Promise<LeadAttribution> {
  // The range is local days; a day either side in UTC covers every zone, and
  // only the leads whose LOCAL day is inside it are kept.
  const from = `${addDays(range.since, -1)}T00:00:00Z`;
  const to = `${addDays(range.until, 2)}T00:00:00Z`;
  const { data, error } = await supabaseAdmin
    .from("waitlist_leads")
    .select(SELECT)
    .gte("created_at", from)
    .lt("created_at", to)
    .order("created_at", { ascending: true })
    .limit(LEAD_READ_LIMIT);
  if (error) {
    console.error("[marketing] lead read failed", { code: error.code });
    return { ok: false, message: "The leads could not be read." };
  }
  const rows = ((data ?? []) as unknown as LeadRow[]).filter((r) => {
    const day = ymdOfInstant(r.created_at, timeZone);
    return !!day && rangeContains(range, day);
  });
  const summary = summariseLeadChannels(rows, { timeZone, dateOf: (r) => r.created_at });

  // First touch per account, inside the period.
  const firstTouch = new Map<string, LeadChannel>();
  const classified = rows.map((r) => ({ row: r, c: classifyLeadChannel(r) }));
  for (const { row, c } of classified) {
    if (row.account_id && !firstTouch.has(row.account_id))
      firstTouch.set(row.account_id, c.channel);
  }

  const deals: Partial<Record<LeadChannel, DealOutcome>> = {};
  let dealsRead = true;
  const accountIds = [...firstTouch.keys()];
  for (let i = 0; i < accountIds.length; i += 200) {
    const slice = accountIds.slice(i, i + 200);
    const { data: dealRows, error: dealError } = await supabaseAdmin
      .from("crm_deals")
      .select("account_id, won_at, lost_at, expected_mrr_cents, setup_fee_cents")
      .in("account_id", slice);
    if (dealError) {
      console.error("[marketing] deal read failed", { code: dealError.code });
      dealsRead = false;
      break;
    }
    const seenAccounts = new Set<string>();
    for (const d of dealRows ?? []) {
      const channel = firstTouch.get(d.account_id);
      if (!channel) continue;
      const slot = deals[channel] ?? emptyOutcome();
      if (!seenAccounts.has(d.account_id)) {
        slot.accounts += 1;
        seenAccounts.add(d.account_id);
      }
      if (d.won_at) {
        slot.won += 1;
        slot.wonMrrCents += Number(d.expected_mrr_cents ?? 0);
        slot.wonSetupCents += Number(d.setup_fee_cents ?? 0);
      } else if (d.lost_at) {
        slot.lost += 1;
      } else {
        slot.open += 1;
      }
      deals[channel] = slot;
    }
  }

  const recentCount = options.recent ?? 0;
  const recent: AttributedLead[] = classified
    .slice(-recentCount)
    .reverse()
    .map(({ row, c }) => ({
      id: row.id,
      createdAt: row.created_at,
      name: `${row.first_name} ${row.last_name}`.trim(),
      organisation: row.entity_name,
      accountId: row.account_id,
      stage: row.stage,
      status: row.status,
      classification: c,
    }));

  return {
    ok: true,
    summary,
    capped: (data ?? []).length >= LEAD_READ_LIMIT,
    deals,
    dealsRead,
    recent: recentCount > 0 ? recent : [],
  };
}
