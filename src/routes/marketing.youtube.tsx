import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AdChannelView } from "@/components/marketing/ad-channel-view";
import { YouTubeChannelView } from "@/components/marketing/youtube-channel-view";
import { cn } from "@/lib/utils";

// YouTube: the channel itself (organic), and the advertising Google Ads runs
// on YouTube. Separate questions with separate credentials, so each says on its
// own whether it could answer.
export const Route = createFileRoute("/marketing/youtube")({
  component: YouTubePage,
  head: () => ({ meta: [{ title: "YouTube — Marketing — Aurixa Systems Mission Control" }] }),
});

function YouTubePage() {
  const [view, setView] = useState<"channel" | "ads">("channel");
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="YouTube view" className="inline-flex border border-border">
        {(
          [
            ["channel", "Channel"],
            ["ads", "Ads (Google Ads)"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={cn(
              "border-l border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] first:border-l-0",
              view === key
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "channel" ? <YouTubeChannelView /> : <AdChannelView kind="youtube_ads" />}
    </div>
  );
}
