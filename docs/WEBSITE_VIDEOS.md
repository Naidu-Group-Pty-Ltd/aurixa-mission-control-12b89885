# Website videos

The Briefing Room on the Aurixa Systems website — `aurixasystems.com.au/watch` —
is Aurixa's own channel for its explainer and marketing videos. Every video on
it is a listing in Mission Control, at **Growth → Website videos**
(`/website/videos`). A listing is written, given its video and published here;
the website builds its pages from what Mission Control publishes.

Reads are `requireOperator`; every write — copy, media, publishing — is
`requireAdmin`, because a published listing is a public page.

---

## A listing's life

| Status | On the website |
| ------ | -------------- |
| `draft` | Nothing. Only Mission Control can see it. |
| `premiere` | A card in the library marked *Premiering*, with no page, no video and no sitemap entry. |
| `published` | A page at `/watch/<slug>` with its own title, description and link-preview card, in the library, the sitemap and `llms.txt`. |
| `archived` | Nothing. Restorable as a draft. |

A draft with no media can be deleted; anything else is archived instead.

**The rules are the website's.** The website's build drops any listing that
breaks one of its publishing rules (`src/lib/videos/validate.ts` in
aurixa-systems) rather than ship it, so `websiteBriefings.pure.ts` restates
them and the console refuses a publish the website would quietly leave out:

- a summary of 70–320 characters (it is the page's search and link-preview
  description), a one-line kicker, 2–4 takeaways;
- an explore link to one of the website's public pages
  (`WEBSITE_EXPLORE_TARGETS` — add a page there when the website adds one);
- card artwork from the website's brand images (`WEBSITE_ARTWORK`);
- to publish: a stream (HLS, or a progressive MP4), a poster and a running
  time; chapters that start at 0:00, run forward and end inside the video;
  media inside the listing's own folder;
- a disclaimer, if any, is one complete sentence; the transcript is verbatim.

The copy rule the rules cannot check: describe what the video shows, and
claim nothing about the platform that the page it links to does not also say.

A live listing is re-checked on every save, so an edit cannot take a
published video off the website by breaking a rule.

## Media

The video lives in the **website's** Supabase project (moeyytuduycrvvncdtme), in
the public `marketing-media` bucket, at `videos/<slug>/v<n>/`. Mission Control
holds no key to that project, and does not need one:

1. Encode the master with the website's pipeline:
   `npm run video:encode -- master.mov --slug <slug> --tune animation` in
   aurixa-systems (see its `docs/video-briefings.md`). It writes
   `media-build/<slug>/`: a six-rung adaptive ladder, a 720p fallback MP4, a
   poster and a 1200×630 link-preview card, portrait or landscape.
2. On the listing, **Choose folder** → that folder → **Upload and verify**.
   - Mission Control mints an **upload grant**
     (`website_briefing_uploads`): a single-use token for the listing's next
     version folder and exactly the files picked, valid for three hours. Only
     the token's SHA-256 is stored.
   - The browser trades it at the website's `briefing-upload-sign` function,
     which asks Mission Control
     (`POST /api/public/storefront/briefing-upload-grant`) whether the token is
     live and covers those paths, and only then signs **create-only** upload
     URLs.
   - The browser uploads straight to the bucket: media and images first,
     rendition playlists next, the master playlist last, with immutable
     caching on segments and images and a short revalidating TTL on
     playlists. A file already there from an interrupted attempt is skipped.
3. Mission Control then **reads the package back** from the public bucket the
   way a viewer's player will: the master playlist, every rendition and audio
   group it names, the poster, the card and the fallback. Only when all of
   them answer does the listing point at the new version, with the running
   time measured from the stream and the orientation from its largest
   rendition. The grant is then spent.

A new upload is always a **new version folder** (`v2`, `v3` …), granted once and
never again, so the version playing keeps playing until the new one is
verified, and nothing published is ever uploaded over. The slug is fixed once
media exists, because the folder is named after it.

## Rebuilding the website

The website prerenders every page at build time, so publishing — or changing a
live listing, or uploading new media for one — POSTs a **Vercel deploy hook**
and the website is live with the change a couple of minutes later. The build
runs `scripts/sync-briefings.ts`, which reads
`GET /api/public/storefront/briefings` (premiere and published listings only;
a premiere carries no media) into the website's catalogue before any page is
rendered. If Mission Control cannot be read, the build keeps the website's
committed snapshot — a site with yesterday's videos rather than a failed
build, or one with none. A failed read here answers 503, never an empty list,
because the website honours an empty list as "no videos".

**Rebuild website** on the list asks for a build by hand.

### How a rebuild is known to have happened

Vercel does not always answer the hook quickly. On 29 Oct 2026 it took longer
than the 15 seconds Mission Control then waited: the console said the rebuild
had failed, and the production build the hook had started was live 40 seconds
later. So the request now waits 25 seconds and carries an explicit empty body
(`Content-Length: 0`). A request Vercel has not answered by then is
**unconfirmed**, not failed (`website.rebuild_unconfirmed`, with the elapsed
time), because the build often runs anyway. An HTTP refusal or an unreachable
hook is a failure (`website.rebuild_failed`).

The proof is the effect. A Vercel build of the website sends
`X-Aurixa-Build-Env` and `X-Aurixa-Build-Id` when it reads the listings, and
Mission Control records each read (`website.build_read_listings`, rate limited
per address). The line under the heading on the list says when a production
build last read them. A build whose read failed was answered `503` and built
from the website's committed snapshot: the line still names it as the last
rebuild, and says it could not read the listings. It is never shown as a
success, and never hidden behind an older read that succeeded.

### Setting up the hook

1. Vercel → **aurixa-systems** → Settings → Git → **Deploy Hooks**: create one
   for branch `main`.
2. Lovable → Mission Control → Secrets: `WEBSITE_DEPLOY_HOOK_URL` = that URL.
   It is a secret — anyone holding it can start a production build.

Until it is set, nothing is requested, the console says changes reach the
website on its next deploy, and every act still saves.

## The first three

`20261028160200_website_briefings.sql` seeds the three briefings already on
the website, exactly as the website's own catalogue held them, so the first
build that reads from Mission Control publishes what is already published. It
was checked byte for byte: the seeded rows, served by
`toPublicListing` and read by the website's sync, regenerate the website's
committed `briefings.data.ts` unchanged.

## Files

| File | What it is |
| ---- | ---------- |
| `supabase/migrations/20261028160200_website_briefings.sql` | The listings, the upload grants, and the three seeded briefings |
| `src/lib/websiteBriefings.pure.ts` | The rules, the upload plan, reading a stream back, the wire shape |
| `src/lib/websiteBriefingForm.ts` | The editor's form, and the payload Save writes |
| `src/lib/briefingUpload.ts` | The browser's upload: sign, then put phase by phase |
| `src/server/website-briefings.server.ts` | Reads, writes, grants, verification, the rebuild |
| `src/server/website-briefings.functions.ts` | The operator RPCs |
| `src/routes/website.videos.index.tsx`, `src/routes/website.videos.$briefingId.tsx` | The list and the editor |
| `src/routes/api.public.storefront.briefings.ts` | What the website build reads |
| `src/routes/api.public.storefront.briefing-upload-grant.ts` | What the website's signing function asks |
| aurixa-systems `supabase/functions/briefing-upload-sign` | The website's signing function |
| aurixa-systems `scripts/sync-briefings.ts` | The website build's sync |
