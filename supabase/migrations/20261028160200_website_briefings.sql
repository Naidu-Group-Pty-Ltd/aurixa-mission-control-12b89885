-- @asserts table:website_briefings
-- @asserts table:website_briefing_uploads
-- @asserts column:website_briefings.media_hls
-- @asserts rows:website_briefings>=3
--
-- Website videos (docs/WEBSITE_VIDEOS.md): the Briefing Room listings on the
-- Aurixa Systems website (/watch), written and published from Mission
-- Control instead of from the website's source code.
--
--   1. `website_briefings` — one listing: its copy, chapters, transcript, the
--      media it plays and whether it is live. `draft` and `archived` are
--      Mission Control's alone; `premiere` is a card on the website with no
--      page; `published` is a watchable page. The website's build pulls the
--      premiere and published rows from GET /api/public/storefront/briefings
--      and drops any that break its publishing rules, so the CHECKs here hold
--      only what must never be stored at all: a slug that is not a URL
--      segment, media outside the listing's own folder, and a published row
--      with nothing to play.
--
--   2. `website_briefing_uploads` — a grant to upload one listing's media.
--      The video lives in the website's own Supabase project (the public
--      `marketing-media` bucket), which Mission Control holds no key to. So
--      Mission Control mints a single-use token for one version folder
--      (videos/<slug>/v<n>/) and the files it will hold; the website's
--      `briefing-upload-sign` function asks Mission Control whether the token
--      covers the paths, and signs create-only upload URLs if it does. Only
--      the token's SHA-256 is stored. A version folder is granted once and
--      never again (UNIQUE briefing_id, version), so a published ladder can
--      never be uploaded over.
--
--   3. The three briefings already live on the website, as they are there
--      today, so the first build that reads from Mission Control publishes
--      exactly what is already published.
--
-- Writes go through admin server functions with the service role; operators
-- may read.

create table if not exists public.website_briefings (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  status text not null default 'draft',
  title text not null,
  kicker text not null default '',
  summary text not null default '',
  series text not null default 'platform',
  artwork text not null default '/brand/layer-01-operational-intelligence.webp',
  artwork_position text,
  takeaways text[] not null default '{}',
  explore_label text not null default 'Explore the platform',
  explore_to text not null default '/platform',
  orientation text not null default 'landscape',
  disclaimer text,
  transcript text[] not null default '{}',
  chapters jsonb not null default '[]'::jsonb,
  media_version text,
  media_hls text,
  media_mp4 text,
  media_poster text,
  media_card text,
  media_captions text,
  duration_seconds integer,
  published_on date,
  sort_order integer not null default 100,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamp with time zone not null default now(),
  constraint website_briefings_slug_shape
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  constraint website_briefings_status
    check (status in ('draft', 'premiere', 'published', 'archived')),
  constraint website_briefings_series
    check (series in ('flagship', 'platform', 'growth', 'compliance')),
  constraint website_briefings_orientation
    check (orientation in ('landscape', 'portrait')),
  constraint website_briefings_title_len
    check (char_length(btrim(title)) between 1 and 120),
  constraint website_briefings_artwork_shape
    check (artwork ~ '^/brand/[A-Za-z0-9_.-]+\.(webp|png|jpe?g)$'),
  constraint website_briefings_chapters_array
    check (jsonb_typeof(chapters) = 'array'),
  constraint website_briefings_media_version
    check (media_version is null or media_version ~ '^v[0-9]+$'),
  constraint website_briefings_duration
    check (duration_seconds is null or duration_seconds > 0),
  -- Media plays from the listing's own folder and nowhere else: a path into
  -- another listing's folder would play the wrong video under this title.
  constraint website_briefings_media_folder check (
    (media_hls is null or media_hls like 'videos/' || slug || '/v%')
    and (media_mp4 is null or media_mp4 like 'videos/' || slug || '/v%')
    and (media_poster is null or media_poster like 'videos/' || slug || '/v%')
    and (media_card is null or media_card like 'videos/' || slug || '/v%')
    and (media_captions is null or media_captions like 'videos/' || slug || '/v%')
  ),
  -- Published means there is something to watch, and a date it went up.
  constraint website_briefings_published_is_watchable check (
    status <> 'published'
    or (
      (media_hls is not null or media_mp4 is not null)
      and media_poster is not null
      and duration_seconds is not null
      and published_on is not null
    )
  )
);

create unique index if not exists website_briefings_slug_key
  on public.website_briefings (slug);

create index if not exists idx_website_briefings_live
  on public.website_briefings (sort_order, published_on)
  where status in ('premiere', 'published');

create index if not exists idx_website_briefings_created_by
  on public.website_briefings (created_by);

create index if not exists idx_website_briefings_updated_by
  on public.website_briefings (updated_by);

comment on table public.website_briefings is
  'Briefing Room listings on the Aurixa Systems website (/watch). premiere and published rows are served to the website build by GET /api/public/storefront/briefings; draft and archived are Mission Control''s alone.';
comment on column public.website_briefings.slug is
  'The listing''s URL segment, /watch/<slug>. Never changed once media has been uploaded, because the media folder is named after it.';
comment on column public.website_briefings.media_version is
  'The version folder the media fields point into (videos/<slug>/v<n>/). A new upload always goes to a new version.';
comment on column public.website_briefings.transcript is
  'Transcript paragraphs, verbatim. For a video whose words are on screen rather than spoken, the on-screen text in order.';
comment on column public.website_briefings.chapters is
  'Chapter marks: a JSON array of {"at": seconds, "label": text}, starting at 0 and running forward.';

create table if not exists public.website_briefing_uploads (
  id uuid primary key default gen_random_uuid(),
  briefing_id uuid not null references public.website_briefings(id) on delete cascade,
  version text not null,
  token_sha256 text not null,
  paths text[] not null,
  expires_at timestamp with time zone not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  constraint website_briefing_uploads_version check (version ~ '^v[0-9]+$'),
  constraint website_briefing_uploads_token check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint website_briefing_uploads_paths check (cardinality(paths) between 1 and 2000)
);

create unique index if not exists website_briefing_uploads_token_key
  on public.website_briefing_uploads (token_sha256);

create unique index if not exists website_briefing_uploads_version_key
  on public.website_briefing_uploads (briefing_id, version);

create index if not exists idx_website_briefing_uploads_created_by
  on public.website_briefing_uploads (created_by);

comment on table public.website_briefing_uploads is
  'Single-use grants to upload one website video''s media into one version folder of the website''s marketing-media bucket. The website''s briefing-upload-sign function verifies a grant with Mission Control before signing create-only upload URLs. Only the token''s SHA-256 is stored.';

alter table public.website_briefings enable row level security;
alter table public.website_briefing_uploads enable row level security;

drop policy if exists "Operators read website briefings" on public.website_briefings;
create policy "Operators read website briefings"
  on public.website_briefings for select to authenticated
  using (is_operator(auth.uid()));

drop policy if exists "Operators read website briefing uploads" on public.website_briefing_uploads;
create policy "Operators read website briefing uploads"
  on public.website_briefing_uploads for select to authenticated
  using (is_operator(auth.uid()));

-- The three briefings live on the website on 28 Oct 2026, exactly as the
-- website's own catalogue held them. `do nothing` on a slug that exists, so a
-- re-run never overwrites a listing an operator has edited since.
insert into public.website_briefings (
  slug, status, title, kicker, summary, series, artwork, artwork_position, takeaways,
  explore_label, explore_to, orientation, disclaimer, transcript, chapters,
  media_version, media_hls, media_mp4, media_poster, media_card, media_captions,
  duration_seconds, published_on, sort_order
) values
  (
    $seed$aurixa-operating-system$seed$, 'published', $seed$The Aurixa Operating System$seed$, $seed$Built by property professionals, around how property professionals actually work.$seed$,
    $seed$A two-minute introduction to Aurixa Systems: one connected operating environment where property research, financial analysis, client reporting and partner relationships come together, built by property professionals for property professionals.$seed$,
    $seed$flagship$seed$, $seed$/brand/layer-01-operational-intelligence.webp$seed$, null,
    array[$seed$Research, financial analysis and client reporting run in one connected operating environment instead of across separate platforms.$seed$, $seed$A property moves from financial analysis into a professional report the client can understand.$seed$, $seed$Communication, client relationships and property partners stay connected to the same client journey.$seed$]::text[],
    $seed$Explore the platform$seed$, $seed$/platform$seed$, $seed$portrait$seed$, null,
    array[$seed$Somewhere in Australia, a property opportunity has just appeared. A client wants to know if it's right for them, while there's still time to act.$seed$, $seed$But before you can answer, the research is in one platform, the numbers in another, the client details somewhere else, and the report hasn't even begun.$seed$, $seed$What happens then? The market keeps moving. Your attention is pulled in every direction. And the client is waiting.$seed$, $seed$Aurixa Systems was built by property professionals, for property professionals. We're here, with a connected operating environment designed around how property professionals actually work.$seed$, $seed$Picture a property moving into financial analysis, then into a professional report your client can understand. Picture communication, client relationships and property partners connected to that journey, with Aurixa Agent supporting the work behind it. Not to replace your judgement, but to give it room to lead.$seed$, $seed$Because clients don't pay you to manage software. They trust you to identify opportunities, make sense of complexity and guide the next decision.$seed$, $seed$You can keep asking your team to bridge the gaps between disconnected systems. But why should they have to?$seed$, $seed$Aurixa Systems isn't on the horizon. We've arrived, and the invitation is open. Experience what we've built with a 14-day free trial. Explore the platform, put it alongside the way you work today, and discover what a more connected business could feel like.$seed$, $seed$Don't just take our word for it. Let your own experience make the case. Fourteen days. Your business. Your experience. Your decision.$seed$, $seed$Aurixa Systems: the operating system for modern property professionals.$seed$]::text[],
    $seed$[{"at":0,"label":"A property opportunity"},{"at":10,"label":"Scattered across platforms"},{"at":31,"label":"Built for property professionals"},{"at":46,"label":"From analysis to report"},{"at":55,"label":"Connected relationships"},{"at":69,"label":"Room to lead"},{"at":80,"label":"Beyond disconnected systems"},{"at":88,"label":"The invitation"}]$seed$::jsonb,
    $seed$v1$seed$, $seed$videos/aurixa-operating-system/v1/master.m3u8$seed$, $seed$videos/aurixa-operating-system/v1/fallback-720p.mp4$seed$, $seed$videos/aurixa-operating-system/v1/poster.jpg$seed$, $seed$videos/aurixa-operating-system/v1/card.jpg$seed$, null,
    131, $seed$2026-10-28$seed$::date, 10
  ),
  (
    $seed$compliance-passport$seed$, 'published', $seed$Inside the Compliance Passport$seed$, $seed$One property, six professionals, and a client who no longer has to be the messenger.$seed$,
    $seed$One property, six professionals and the same documents requested again and again. The AML/CTF Compliance Passport keeps identity verification, screening and due diligence in one organised client record, shared with authorised partners through controlled access.$seed$,
    $seed$compliance$seed$, $seed$/brand/layer-05-enterprise-governance.webp$seed$, null,
    array[$seed$Buyer's agent, finance broker, solicitor, accountant, builder and developer stop asking the client for the same evidence one by one.$seed$, $seed$Identity verification, screening and due diligence sit together in one organised client record: the Compliance Passport.$seed$, $seed$With appropriate consent, authorised property partners reach it through controlled access instead of a fresh round of requests.$seed$]::text[],
    $seed$Open the Compliance Passport$seed$, $seed$/compliance-passport$seed$, $seed$portrait$seed$, $seed$Your business remains responsible for its AML/CTF obligations.$seed$,
    array[$seed$One property, six property professionals, and somehow the client becomes the messenger. Sound familiar?$seed$, $seed$The perfect property is found, but the requests keep coming. Another identity check, another document, another explanation. Suddenly, progress feels like paperwork.$seed$, $seed$That's where Aurixa changes the experience. Built by property professionals for property professionals, Aurixa brings property intelligence, financial analysis, reporting, client management, communication and more into one connected operating environment.$seed$, $seed$And here's where it gets exciting. Introducing the Aurixa AML/CTF Compliance Passport. One digital passport, one organised client record, identity verification, screening and due diligence, all in one place.$seed$, $seed$With appropriate consent and controlled access, authorised property partners can securely access the client's Compliance Passport in just a few clicks, supporting legislative compliance while eliminating unnecessary duplication.$seed$, $seed$The result? Less paperwork, less repetition, better-connected professionals and a smoother property journey, without clients constantly providing the same information.$seed$, $seed$And that's just one part of Aurixa Systems. Experience it yourself with a 14-day free trial, and discover what a truly connected business can achieve. Fourteen days. Your business. Your experience. Your decision.$seed$, $seed$Aurixa Systems: the operating system for modern property professionals.$seed$]::text[],
    $seed$[{"at":0,"label":"One client, six professionals"},{"at":9,"label":"The requests keep coming"},{"at":23,"label":"Built for property professionals"},{"at":41,"label":"Introducing the Passport"},{"at":60,"label":"Consent and controlled access"},{"at":76,"label":"The result"},{"at":89,"label":"Experience it yourself"}]$seed$::jsonb,
    $seed$v1$seed$, $seed$videos/compliance-passport/v1/master.m3u8$seed$, $seed$videos/compliance-passport/v1/fallback-720p.mp4$seed$, $seed$videos/compliance-passport/v1/poster.jpg$seed$, $seed$videos/compliance-passport/v1/card.jpg$seed$, null,
    118, $seed$2026-10-28$seed$::date, 20
  ),
  (
    $seed$borrowing-capacity$seed$, 'published', $seed$Borrowing Capacity, in Moments$seed$, $seed$From one client questionnaire to an indicative assessment, scenarios and a report.$seed$,
    $seed$Your client has found the property; can they afford it? From one client questionnaire, Aurixa produces an indicative borrowing capacity assessment, models deposits and purchasing scenarios, generates a professional report and hands over to the finance broker.$seed$,
    $seed$platform$seed$, $seed$/brand/layer-03-financial-modelling.webp$seed$, $seed$30% 25%$seed$,
    array[$seed$One client questionnaire captures and organises the client's information and populates their client card.$seed$, $seed$An indicative borrowing capacity assessment shows estimated purchasing power, deposit requirements and financial commitments.$seed$, $seed$Deposits, financial structures and purchasing scenarios are modelled and turned into a professional report.$seed$, $seed$Assessments and scenarios go to the client's finance broker through the partner portal, without repeating the process.$seed$]::text[],
    $seed$See the serviceability engine$seed$, $seed$/platform#serviceability$seed$, $seed$portrait$seed$, $seed$Illustrative example only: hypothetical client, figures and assumptions. Not a credit assessment or financial advice.$seed$,
    array[$seed$Your client has found the property. The big question? Can they afford it?$seed$, $seed$Traditionally, answering that means chasing documents, juggling spreadsheets, and waiting on internal teams and external partners.$seed$, $seed$With Aurixa Systems, everything changes. One simple client questionnaire captures and organises their information, seamlessly populating their client card.$seed$, $seed$Now, here's where speed meets opportunity. With just one click, Aurixa turns client information into magic, where one aspect allows you to obtain an indicative borrowing capacity assessment, revealing estimated purchasing power, deposit requirements, financial commitments, and key considerations tailored to their specific circumstances. From information to financial insight in moments.$seed$, $seed$And why stop there? Bring their chosen property into focus. Adjust deposits, explore financial structures, model purchasing scenarios, and generate professional reports that turn numbers into meaningful decisions.$seed$, $seed$Ready for the next step? One click, one connected handover. Share assessments and scenarios directly with yours or their allocated finance broker through Aurixa's partner portal, enabling professional review without repeating the entire process.$seed$, $seed$Your client gains clarity and transparency, and the broker gains context. Your business gains momentum.$seed$, $seed$And that's just the beginning. Property intelligence, financial analysis, professional reporting, client and partner collaboration are all connected, with the Aurixa Agent in your arsenal supporting you wherever your business takes you.$seed$, $seed$This means less administration, faster answers, smarter collaboration, and more opportunities to deliver results.$seed$, $seed$Aurixa Systems. Built by property professionals for property professionals. Experience the difference with a 14-day free trial.$seed$]::text[],
    $seed$[{"at":0,"label":"Can they afford it?"},{"at":6,"label":"Chasing documents"},{"at":15,"label":"One simple questionnaire"},{"at":26,"label":"Borrowing capacity in moments"},{"at":53,"label":"Scenarios and reports"},{"at":68,"label":"Handover to the broker"},{"at":93,"label":"Just the beginning"},{"at":110,"label":"What this means"}]$seed$::jsonb,
    $seed$v1$seed$, $seed$videos/borrowing-capacity/v1/master.m3u8$seed$, $seed$videos/borrowing-capacity/v1/fallback-720p.mp4$seed$, $seed$videos/borrowing-capacity/v1/poster.jpg$seed$, $seed$videos/borrowing-capacity/v1/card-2.jpg$seed$, null,
    147, $seed$2026-10-28$seed$::date, 30
  )
on conflict (slug) do nothing;
