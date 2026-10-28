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

export function rebuildLine(rebuild: {
  configured: boolean;
  last: { at: string; reason: string | null } | null;
}): string {
  if (!rebuild.configured) {
    return "Website rebuilds are not connected: set WEBSITE_DEPLOY_HOOK_URL, and until then changes reach the website on its next deploy.";
  }
  if (!rebuild.last)
    return "Publishing a change asks the website to rebuild; it is live a couple of minutes later.";
  const when = new Date(rebuild.last.at).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Last rebuild requested ${when}${rebuild.last.reason ? ` — ${rebuild.last.reason}` : ""}.`;
}
