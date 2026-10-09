// Every digest and weekly brief a model wrote about Aurixa's marketing, newest
// first. Each was written from facts this server measured, and those facts are
// stored beside it in `marketing_reports`.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, parseISO } from "date-fns";
import { FileText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { RecordRow } from "@/components/record-row";
import { BriefText } from "@/components/marketing/brief-text";
import { listMarketingReports } from "@/lib/marketing.functions";

export const Route = createFileRoute("/marketing/briefs")({
  component: BriefsPage,
  head: () => ({ meta: [{ title: "Briefs — Marketing — Aurixa Systems Mission Control" }] }),
});

const CHANNEL_WORDS: Record<string, string> = {
  all: "All channels",
  meta_ads: "Meta Ads",
  youtube_ads: "YouTube Ads",
  tiktok_ads: "TikTok Ads",
  youtube_channel: "YouTube channel",
};

function day(value: string): string {
  try {
    return format(parseISO(value), "d MMM yyyy");
  } catch {
    return value;
  }
}

function BriefsPage() {
  const listFn = useServerFn(listMarketingReports);
  const q = useQuery({
    queryKey: ["marketing", "reports"],
    queryFn: () => listFn({ data: { limit: 50 } }),
  });
  const [open, setOpen] = useState<string | null>(null);
  const reports = q.data?.reports ?? [];

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {(q.error as Error).message}
      </p>
    );
  }
  if (!q.isLoading && reports.length === 0) {
    return (
      <EmptyState
        icon={<FileText />}
        title="No briefs yet"
        description="Write a weekly brief on Overview, or a digest on any channel's page. Every one is kept here with the facts it was written from."
      />
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Briefs and digests</CardTitle>
        <CardDescription>
          Written by a model from figures Mission Control measured. Open one to read it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {reports.map((r) => (
          <RecordRow
            key={r.id}
            spine={r.kind === "weekly_brief" ? "live" : "idle"}
            className="px-4 py-3"
          >
            <button
              type="button"
              className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
              onClick={() => setOpen((o) => (o === r.id ? null : r.id))}
              aria-expanded={open === r.id}
            >
              <span className="font-medium">
                {r.kind === "weekly_brief" ? "Weekly brief" : "Digest"} ·{" "}
                {CHANNEL_WORDS[r.channel] ?? r.channel}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {day(r.rangeSince)} → {day(r.rangeUntil)} · written {day(r.createdAt)}
                {r.model ? ` · ${r.model}` : ""}
              </span>
            </button>
            {open === r.id && (
              <div className="mt-3">
                <BriefText text={r.content} />
              </div>
            )}
          </RecordRow>
        ))}
      </CardContent>
    </Card>
  );
}
