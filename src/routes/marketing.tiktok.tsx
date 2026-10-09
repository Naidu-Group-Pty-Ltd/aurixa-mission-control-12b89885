import { createFileRoute } from "@tanstack/react-router";
import { AdChannelView } from "@/components/marketing/ad-channel-view";

// TikTok Ads, from the Business API. TikTok's organic account analytics are not
// here on purpose: they need the creator's own login token, which expires every
// day and needs a person to renew it. Leads from TikTok, organic or paid, are
// still counted on Attribution.
export const Route = createFileRoute("/marketing/tiktok")({
  component: () => (
    <div className="space-y-4">
      <AdChannelView kind="tiktok_ads" />
      <p className="font-mono text-[10px] text-muted-foreground">
        tiktok organic analytics need the creator's own daily login, so they are not read here ·
        leads from tiktok are still counted on attribution
      </p>
    </div>
  ),
  head: () => ({ meta: [{ title: "TikTok Ads — Marketing — Aurixa Systems Mission Control" }] }),
});
