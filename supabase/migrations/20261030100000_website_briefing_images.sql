-- @asserts column:website_briefings.media_thumbnail
-- @asserts column:website_briefing_uploads.kind
--
-- Website videos (docs/WEBSITE_VIDEOS.md): a listing's pictures, uploaded on
-- their own.
--
--   1. `website_briefings.media_thumbnail` — the 16:9 thumbnail designed for
--      the video (videos/<slug>/v<n>/thumbnail.jpg, 1920×1080): the website's
--      library card and the theatre's up-next card show it as landscape art,
--      where a portrait reel otherwise shows its 9:16 poster small over a
--      blur of itself. Inside the listing's own folder, like every media
--      field, and its own CHECK, so the rule the website build enforces holds
--      for it too.
--
--   2. `website_briefing_uploads.kind` — what a grant was for. `package` is
--      the encoded video (a stream or MP4, and a poster); `images` is a
--      thumbnail, poster or link-preview card on their own, without
--      re-uploading the stream. Each finishes only through its own act, so an
--      images grant can never point a listing at a stream it does not have.
--      An images upload takes the next version folder like any other, so
--      nothing published is uploaded over, and the media fields may then
--      point into different version folders of the same listing.
--
-- Existing grants were all for packages, which is the default.

alter table public.website_briefings
  add column if not exists media_thumbnail text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'website_briefings_media_thumbnail_folder'
  ) then
    alter table public.website_briefings
      add constraint website_briefings_media_thumbnail_folder
      check (media_thumbnail is null or media_thumbnail like 'videos/' || slug || '/v%');
  end if;
end $$;

comment on column public.website_briefings.media_thumbnail is
  'The 16:9 thumbnail designed for the video (videos/<slug>/v<n>/thumbnail.jpg, 1920x1080), shown on the website''s library and up-next cards. Null: the card shows the poster.';
comment on column public.website_briefings.media_version is
  'The version folder the stream was uploaded into (videos/<slug>/v<n>/). A new upload always goes to a new version. Pictures uploaded on their own (thumbnail, poster, card) have version folders of their own, so a media field may point into a different one.';

alter table public.website_briefing_uploads
  add column if not exists kind text not null default 'package';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'website_briefing_uploads_kind'
  ) then
    alter table public.website_briefing_uploads
      add constraint website_briefing_uploads_kind check (kind in ('package', 'images'));
  end if;
end $$;

comment on column public.website_briefing_uploads.kind is
  'package: the encoded video (a stream or MP4, and a poster). images: a thumbnail, poster or link-preview card on their own. Each is finished only by its own act.';
