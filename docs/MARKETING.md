# Marketing — Aurixa Systems' own ad performance

`/marketing` tracks Aurixa's advertising on Meta, YouTube (Google Ads) and
TikTok, Aurixa's YouTube channel, and the leads and deals that advertising
produced. It is the prime's Marketing module (npc-property-dashbord,
`docs/marketing/YOUTUBE_AND_TIKTOK.md`) carried across: the same engine, the
same findings, the same digest rules — reading Mission Control's own accounts,
its own leads (`waitlist_leads`) and its own deals (`crm_deals`).

| Tab | What it shows |
|---|---|
| **Overview** | Every channel side by side from the daily record: spend (per currency), results, paid and all CRM leads, cost per paid lead, deals won and their MRR; the lead mix by channel and the evidence that placed each lead; the **weekly brief**. |
| **Meta** | Facebook and Instagram campaigns, ad sets and ads: spend, impressions, 3-second views, plays and completion, clicks, leads, cost per lead — drill-down, compare, findings, health, period comparison, budget advice, trends, month pacing, campaign budgets, and what the leads became. |
| **YouTube** | **Channel**: subscribers, lifetime views, uploads; with the owner's consent, YouTube Analytics' daily views, watch time, subscribers gained and lost, traffic sources, top videos; growth measured from recorded readings. **Ads**: Google Ads on YouTube placements — spend, TrueView views, view rate, cost per view, quartile completion, conversions. |
| **TikTok** | TikTok Ads: spend, plays, 2s/6s holds, quartile completion, engagement, follows, results, budgets and pacing. |
| **Attribution** | Every channel's leads (paid / organic) and the deals they became; the last fifty leads with the evidence that placed each one, linked to their CRM account. |
| **Briefs** | Every digest and weekly brief a model wrote, with the facts it was written from (stored in `marketing_reports`). |
| **Connections** | The accounts read and the credentials they are read with. Administrators connect, test and remove. |

## How it is built

- **The engine** — `src/lib/marketing/engine/*.pure.ts`, sixteen files
  **byte-identical** to the prime's `supabase/functions/_shared/marketing/`,
  pinned by `MARKETING_ENGINE.lock.json` (the same file in both repositories).
  `marketingEngineLock.test.ts` fails on any byte that differs, on an import
  outside the engine, and on any runtime global. The directory is excluded from
  Prettier and ESLint because it is formatted the prime's way; `tsc` still
  checks it. **Change it in both repositories in the same piece of work** and
  run `node scripts/marketing/engine-lock.mjs` in each — the `engineVersion`
  must match.
- **Server** — `src/server/marketing/`: `connections.server.ts` (encrypted
  credentials), `vendor.server.ts` (the one place a request is performed;
  retries a dropped connection or a 5xx, never a 429), `reads.server.ts` (Meta,
  Google Ads, TikTok, YouTube Data and Analytics, and the probes),
  `leads.server.ts` (attribution and deals), `channels.server.ts` (what each
  page is drawn from), `snapshots.server.ts` (the daily record and its
  recorder), `digests.server.ts` (digests and briefs). Reached through
  `src/lib/_server-shims/marketing.server.ts`, so none of it is bundled for the
  browser.
- **Server functions** — `src/lib/marketing.functions.ts`. Reads and briefs need
  an operator; connecting, testing and removing need an administrator.
- **Tables** (`20261009100000_marketing_module.sql`) —
  `marketing_connections` (service role only; in `SERVICE_ROLE_ONLY`),
  `marketing_channel_snapshots` and `marketing_reports` (operators read, the
  service role writes).
- **Schedule** (`20261009100100_schedule_marketing_snapshots.sql`) —
  `marketing-snapshots-daily` at 19:50 UTC calls `/hooks/marketing-snapshots`.

## Rules that bite

**Credentials are never returned and never stored in clear.** Nothing is stored
unless `CREDENTIALS_ENC_KEY` is set; a save asks the vendor with the submitted
credentials first and stores nothing the vendor refuses; every browser read
returns field names, account identifiers and fingerprints. A blank credential
field on a later save keeps the stored credential.

**Absent is never zero.** Every metric is `number | null`; an unmeasured figure
prints an em dash, is left out of sums and ratios, and is left out of the facts a
brief is written from.

**A "view" is the channel's own word.** A Meta 3-second view, a TrueView view, a
TikTok play and a YouTube Analytics view are different events. Views are compared
within a channel, never across, and **two currencies are never one total**.

**YouTube growth exists only if it was recorded.** The Data API answers lifetime
counters only; every visit to the YouTube tab and the nightly job record the
day's reading, and a day nobody recorded can never be recovered.

**A lead's channel is decided by evidence, strongest first** — a click id in the
landing page URL, then UTM tags, then the referrer, then the form's source word.
None means **Unknown**, never guessed. A click id means paid (except `fbclid`,
which organic Facebook links carry too); otherwise `utm_medium` decides.

**Deals are credited once, to first touch inside the period, won at any time.**
An account whose leads arrived on two channels in the range is credited to its
earliest; its deals are those it has reached since, whenever they were won. The
question is what the leads paid for in a period became, not what closed in it.

**The brief is written from facts the server measured.** Each channel is re-read
on the server; the engine's `adReportFacts` / `youtubeChannelFacts` write the
facts, and `digestPrompt` forbids any figure not in them. The weekly brief keeps
each channel's facts under its own name and names any channel it could not read.
Briefs are written with `callAi` (`feature: marketing_digest`) and logged in
`ai_usage_log`.

**Pacing is month-to-date only**, answered for "This Month", counted to the end
of yesterday, against running campaigns' daily budgets. Lifetime budgets — and
Meta ad-set budgets, which the campaign list does not carry — are not included,
and the note says so. Google Ads has no pacing here rather than pacing from no
budget.

## What is deliberately not here

- **TikTok organic** — it needs the creator's own Login Kit token, which expires
  every 24 hours and is renewed by an interactive login. Leads from TikTok are
  still counted on Attribution.
- **The prime's property-market panels** (industry benchmarks via Perplexity,
  market correlation) — they answer questions about a property buyers' agency's
  market, not Aurixa's.
- **Creative previews and audience breakdowns** — the engine reads performance,
  not creatives or demographic breakdowns; adding them is an engine change, made
  in both repositories.

## The prime's side

The prime meters four new vendor hosts against `YOUTUBE_API_KEY`,
`YOUTUBE_OAUTH_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN` and
`TIKTOK_ADS_ACCESS_TOKEN`. Each names one tenant's own account, so none is ever
forwarded to a clone; the migration records them in `api_provider_rates` as
metered and not billable (as `META_ADS_ACCESS_TOKEN` already is), so a clone's
usage does not land as `unknown_secret`.
