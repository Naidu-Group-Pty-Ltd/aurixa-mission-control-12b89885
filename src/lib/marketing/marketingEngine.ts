/**
 * The marketing engine, as Mission Control imports it.
 *
 * The files under `./engine/` are byte-identical to the prime's
 * `supabase/functions/_shared/marketing/` — the same request builders,
 * normalisers, findings and digest facts — so a cost per view on the prime's
 * Marketing page and on this one is one division made by one implementation.
 * `MARKETING_ENGINE.lock.json` pins the bytes; change the engine in both
 * repositories and regenerate the lock in each
 * (`node scripts/marketing/engine-lock.mjs`).
 */
export * from "./engine/marketingTypes.pure.ts";
export * from "./engine/marketingRange.pure.ts";
export * from "./engine/marketingMetrics.pure.ts";
export * from "./engine/marketingFormat.pure.ts";
export * from "./engine/vendorRequest.pure.ts";
export * from "./engine/googleApi.pure.ts";
export * from "./engine/youtubeData.pure.ts";
export * from "./engine/youtubeAnalytics.pure.ts";
export * from "./engine/googleAdsVideo.pure.ts";
export * from "./engine/tiktokAds.pure.ts";
export * from "./engine/metaAds.pure.ts";
export * from "./engine/leadChannel.pure.ts";
export * from "./engine/channelSignals.pure.ts";
export * from "./engine/channelForecast.pure.ts";
export * from "./engine/channelDigest.pure.ts";
export * from "./engine/crossChannel.pure.ts";
