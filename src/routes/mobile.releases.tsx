/**
 * Every mobile release, for all six apps, and the only place one is moved.
 *
 * CI registers a candidate and uploads its package; nothing CI can do puts a
 * build on a device. An operator approves it here (an Android candidate is
 * approvable only once its package is uploaded), promotes it to a percentage
 * of installations, pauses it with a reason, resumes it, or withdraws it.
 * A bad build is never edited: it is withdrawn and a HIGHER build replaces it,
 * which is also how a rollback reaches devices.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { listMobileReleases, moveMobileRelease } from "@/lib/mobile.functions";
import { MOBILE_PORTALS, PORTAL_APPS, isMobilePortal } from "@/lib/mobile/portals.pure";

export const Route = createFileRoute("/mobile/releases")({
  head: () => ({ meta: [{ title: "Mobile releases · Aurixa Mission Control" }] }),
  component: MobileReleasesPage,
});

type Refusal = { ok: false; message: string };
const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

const STATE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  candidate: "outline",
  approved: "secondary",
  promoted: "default",
  paused: "secondary",
  withdrawn: "destructive",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

function MobileReleasesPage() {
  const listFn = useServerFn(listMobileReleases);
  const moveFn = useServerFn(moveMobileRelease);
  const [portal, setPortal] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["mobile-releases", portal],
    queryFn: () => listFn({ data: { portal: portal || null } }),
  });

  async function move(
    id: string,
    action: string,
    extra: { percentage?: number; reason?: string } = {},
  ) {
    setBusy(`${id}:${action}`);
    try {
      const r = await moveFn({ data: { releaseId: id, action, ...extra } });
      if (isRefusal(r)) toast.error(r.message);
      else toast.success(`Release is now ${r.state}.`);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const releases = data && !isRefusal(data) ? data.releases : [];

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 basis-80">
            <h1 className="font-display text-[1.75rem] leading-[1.1]">Mobile releases</h1>
            <p className="text-sm text-muted-foreground">
              Packages live in Mission Control's private storage, one bucket per app. Every
              workspace is subscribed from birth; a release reaches its devices only once it is
              promoted here.
            </p>
          </div>
          <label className="text-sm">
            <span className="block text-muted-foreground">App</span>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={portal}
              onChange={(e) => setPortal(e.target.value)}
            >
              <option value="">All six</option>
              {MOBILE_PORTALS.map((p) => (
                <option key={p} value={p}>
                  {PORTAL_APPS[p].label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p className="text-sm text-destructive">
            Releases could not be read: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {data && isRefusal(data) && (
          <p className="text-sm text-destructive">Releases could not be read: {data.message}</p>
        )}
        {data && !isRefusal(data) && releases.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No release has been registered yet. The mobile-release workflow registers a candidate
            and uploads its package.
          </p>
        )}

        <div className="space-y-2">
          {releases.map((r) => {
            const label = isMobilePortal(r.portal) ? PORTAL_APPS[r.portal].label : r.portal;
            const p = Number(pct[r.id] ?? r.rollout?.percentage ?? 10);
            const reason = reasons[r.id] ?? "";
            const b = (a: string) => busy === `${r.id}:${a}`;
            return (
              <div key={r.id} className="glass space-y-2 rounded-lg p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label}</span>
                  <Badge variant="outline">{r.platform}</Badge>
                  <span className="font-mono">
                    {r.version} ({r.build_number})
                  </span>
                  <Badge variant={STATE_VARIANT[r.state] ?? "outline"}>{r.state}</Badge>
                  <Badge variant="outline">{r.channel}</Badge>
                  {r.environment !== "production" && (
                    <Badge variant="outline">{r.environment}</Badge>
                  )}
                  {r.critical && <Badge variant="destructive">critical</Badge>}
                  {r.rollout && (
                    <span className="text-muted-foreground">
                      {r.rollout.paused_at
                        ? `paused at ${r.rollout.percentage}% — ${r.rollout.pause_reason ?? ""}`
                        : `${r.rollout.percentage}% of installations`}
                    </span>
                  )}
                  <span className="text-muted-foreground">{r.installs} installed</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Source {r.source_sha.slice(0, 7)} · registered {when(r.created_at)}
                  {r.platform === "android" &&
                    (r.uploaded_at
                      ? ` · package uploaded ${when(r.uploaded_at)}`
                      : " · package not uploaded yet")}
                  {r.min_supported_build
                    ? ` · oldest build allowed to run: ${r.min_supported_build}`
                    : ""}
                  {r.approved_at ? ` · approved ${when(r.approved_at)}` : ""}
                </div>
                {r.release_notes && <p className="whitespace-pre-line">{r.release_notes}</p>}
                <div className="flex flex-wrap items-end gap-2">
                  {r.state === "candidate" && (
                    <Button size="sm" disabled={b("approve")} onClick={() => move(r.id, "approve")}>
                      Approve
                    </Button>
                  )}
                  {(r.state === "approved" || r.state === "promoted") && (
                    <>
                      <label className="text-xs">
                        <span className="block text-muted-foreground">Rollout %</span>
                        <Input
                          className="h-8 w-20"
                          type="number"
                          min={1}
                          max={100}
                          value={String(p)}
                          onChange={(e) => setPct({ ...pct, [r.id]: e.target.value })}
                        />
                      </label>
                      <Button
                        size="sm"
                        disabled={b("promote")}
                        onClick={() => move(r.id, "promote", { percentage: p })}
                      >
                        {r.state === "promoted" ? "Set rollout" : "Promote"}
                      </Button>
                    </>
                  )}
                  {r.state === "promoted" && (
                    <>
                      <Input
                        className="h-8 min-w-0 flex-1 basis-56"
                        placeholder="Why pause (at least ten characters)"
                        value={reason}
                        onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={reason.trim().length < 10 || b("pause")}
                        onClick={() => move(r.id, "pause", { reason })}
                      >
                        Pause
                      </Button>
                    </>
                  )}
                  {r.state === "paused" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={b("resume")}
                      onClick={() => move(r.id, "resume")}
                    >
                      Resume
                    </Button>
                  )}
                  {r.state !== "withdrawn" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={b("withdraw")}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Withdraw ${label} ${r.version} (${r.build_number})? A withdrawn build is replaced by a higher one, never restored.`,
                          )
                        )
                          void move(r.id, "withdraw");
                      }}
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
