import { createFileRoute } from "@tanstack/react-router";
import { AdChannelView } from "@/components/marketing/ad-channel-view";

// Meta Ads: Aurixa's Facebook and Instagram campaigns, ad sets and ads.
export const Route = createFileRoute("/marketing/meta")({
  component: () => <AdChannelView kind="meta_ads" />,
  head: () => ({ meta: [{ title: "Meta Ads — Marketing — Aurixa Systems Mission Control" }] }),
});
