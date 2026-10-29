/**
 * How Website → Videos describes a listing's status and the website's
 * rebuilds. Shared by the list and the editor so the two cannot disagree.
 */
export const STATUS_COPY: Record<
  string,
  { label: string; tone: "default" | "secondary" | "outline" }
> = {
  published: { label: "live on the website", tone: "default" },
  premiere: { label: "premiering", tone: "outline" },
  draft: { label: "draft", tone: "secondary" },
  archived: { label: "archived", tone: "secondary" },
};

const shortTime = (at: string) =>
  new Date(at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

/**
 * The rebuild, said the way it can be known: what was asked of Vercel, and
 * — the proof — when a production build of the website last read the
 * listings. A request Vercel did not confirm is not called a failure, because
 * the build may well have run; the second half of the line settles it.
 */
export function rebuildLine(rebuild: {
  configured: boolean;
  last: { at: string; reason: string | null; outcome?: "requested" | "unconfirmed" } | null;
  built?: { at: string; build: string } | null;
}): string {
  if (!rebuild.configured) {
    return "Website rebuilds are not connected: set WEBSITE_DEPLOY_HOOK_URL, and until then changes reach the website on its next deploy.";
  }
  const built = rebuild.built
    ? ` The live website last rebuilt ${shortTime(rebuild.built.at)} — its build read the listings.`
    : "";
  if (!rebuild.last)
    return `Publishing a change asks the website to rebuild; it is live a couple of minutes later.${built}`;
  const asked =
    rebuild.last.outcome === "unconfirmed"
      ? `Rebuild requested ${shortTime(rebuild.last.at)}; Vercel did not confirm it in time.`
      : `Last rebuild requested ${shortTime(rebuild.last.at)}${rebuild.last.reason ? ` — ${rebuild.last.reason}` : ""}.`;
  return `${asked}${built}`;
}
