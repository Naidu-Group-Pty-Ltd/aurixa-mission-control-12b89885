// A written digest of one channel, on request.
//
// Never on page load: a digest spends a model call, and the figures around it
// are complete without one. The server re-reads the channel and hands the model
// only what it measured; the card says plainly that the words are a model's,
// and every digest is kept on the Briefs tab beside the facts it was given.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { writeMarketingDigest } from "@/lib/marketing.functions";
import { BriefText } from "./brief-text";
import { useMarketingRange } from "./use-marketing-range";

export function DigestCard({
  channel,
  title,
  disabled,
}: {
  channel: "meta_ads" | "youtube_ads" | "tiktok_ads" | "youtube_channel";
  title: string;
  disabled?: boolean;
}) {
  const range = useMarketingRange();
  const writeFn = useServerFn(writeMarketingDigest);
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [covers, setCovers] = useState<string | null>(null);

  const write = async () => {
    setWriting(true);
    setError("");
    try {
      const answer = await writeFn({ data: { ...range.request, channel } });
      setCovers(answer.rangeLabel);
      if (answer.ok) {
        setContent(answer.content);
        qc.invalidateQueries({ queryKey: ["marketing", "reports"] });
      } else {
        setError(answer.error);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "The digest could not be written.";
      setError(message);
      toast.error(message);
    } finally {
      setWriting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            {title}
          </CardTitle>
          <Button
            size="sm"
            variant={content ? "outline" : "default"}
            onClick={write}
            disabled={writing || disabled}
          >
            {writing ? (
              <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-3.5 w-3.5" />
            )}
            {writing ? "Writing…" : content ? "Write again" : "Write digest"}
          </Button>
        </div>
        <CardDescription>
          Written by a model from the figures this page measured, and nothing else.
          {covers && <> Covers {covers}.</>}
        </CardDescription>
      </CardHeader>
      {(content || error || writing) && (
        <CardContent>
          {writing && !content ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-4 animate-pulse bg-muted" />
              ))}
            </div>
          ) : error && !content ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <BriefText text={content} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
