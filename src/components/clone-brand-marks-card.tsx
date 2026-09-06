import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  Image as ImageIcon,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCloneBrandMarks, applyBrandProfile } from "@/server/branding.functions";

/**
 * The marks this workspace will actually print.
 *
 * ## Why it is here and not only on the branding page
 *
 * Provisioning a workspace is where somebody asks "has it got a logo yet?", and
 * until now there was nowhere on this page to answer it. The branding page
 * holds the uploads; nothing pointed at it from the clone, and nothing said
 * which of the six marks a workspace was missing.
 *
 * ## What the six are
 *
 * Four dress the interface — the sign-in wordmark, the sidebar, the collapsed
 * sidebar's square icon, the browser tab. Two are for paper: the lockup that
 * prints on ivory and the knockout one for the cover's dark ground. The
 * interface marks and the paper marks are stored in different places on the
 * workspace, which is exactly how a fully branded deployment came to generate
 * documents with no mark on them at all.
 *
 * Absent is not broken. A workspace with no report mark still gets a branded
 * document — the renderer walks `report → sidebar → auth → sidebarIcon` — so
 * nothing here blocks anything, and every row says what it is for rather than
 * demanding a file.
 */
export function CloneBrandMarksCard({ cloneId }: { cloneId: string }) {
  const readMarks = useServerFn(getCloneBrandMarks);
  const applyFn = useServerFn(applyBrandProfile);
  const [applying, setApplying] = useState(false);

  const query = useQuery({
    queryKey: ["clone-brand-marks", cloneId],
    queryFn: () => readMarks({ data: { cloneId } }),
  });

  const result = query.data;

  const apply = async () => {
    if (!result?.ok || !result.assigned || !result.profile) return;
    setApplying(true);
    try {
      const res = await applyFn({ data: { cloneIds: [cloneId], profileId: result.profile.id } });
      if (!res.ok) {
        toast.error(res.error ?? "Could not apply the brand");
        return;
      }
      const outcome = res.results?.[0];
      if (outcome && outcome.ok) {
        // Say what reached the workspace. An apply that mirrored nothing used
        // to report success in exactly the same words as one that mirrored
        // everything.
        toast.success(
          outcome.assetsFailed > 0
            ? `Brand applied — ${outcome.assetsUploaded} mark(s) copied, ${outcome.assetsFailed} failed`
            : `Brand applied — ${outcome.assetsUploaded} mark(s) copied`,
        );
      } else {
        toast.error(outcome && !outcome.ok ? outcome.error : "Could not apply the brand");
      }
      void query.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 basis-[18rem] flex-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="h-4 w-4" aria-hidden /> Brand marks
          </CardTitle>
          <CardDescription>
            The logo this workspace shows, and the lockup its documents print. Uploaded on the brand
            profile, copied into the workspace when the brand is applied.
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Refresh
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/branding">
              <Upload className="mr-1.5 h-4 w-4" aria-hidden /> Upload marks
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {query.isLoading && (
          <p className="text-xs text-muted-foreground">Reading the brand assignment…</p>
        )}

        {result && !result.ok && (
          <p className="text-xs text-warning">
            The brand assignment could not be read: {result.error}. This says nothing about whether
            the workspace has marks — try again.
          </p>
        )}

        {result?.ok && !result.assigned && (
          <p className="text-xs text-muted-foreground">
            No brand profile is assigned to this workspace, so it renders the platform default.
            Create or pick one on the branding page, then apply it here.
          </p>
        )}

        {result?.ok && result.assigned && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {result.status}
              </Badge>
              <span>
                {result.profile
                  ? `${result.profile.name} · v${result.profile.version}`
                  : "profile unavailable"}
              </span>
              {result.appliedAt && (
                <span>· applied {new Date(result.appliedAt).toLocaleString("en-AU")}</span>
              )}
            </div>

            <ul className="space-y-2">
              {result.slots.map((slot) => (
                <li
                  key={slot.field}
                  className="flex items-center gap-3 border border-border bg-surface p-3"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-border bg-background">
                    {slot.url ? (
                      <img src={slot.url} alt="" className="max-h-10 max-w-10 object-contain" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-muted-foreground/60" aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {slot.url ? (
                        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                      ) : (
                        <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />
                      )}
                      {slot.label}
                    </div>
                    <div className="text-xs text-muted-foreground">{slot.purpose}</div>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
                    {slot.url ? "set" : "not set"}
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void apply()} disabled={applying || !result.profile}>
                {applying ? "Applying…" : "Apply to this workspace"}
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/branding">
                  Brand profile <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
                </Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applying copies the marks into the workspace's own <code>branding-assets</code> bucket
              and points its settings at that copy, so it never serves an image from another
              deployment's storage.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
