/**
 * The access link's page: `https://mobile.aurixasystems.com.au/a/<grant>#t=<ticket>`.
 *
 * Reached only when the OS did not hand the link straight to an installed app
 * (no app yet, a desktop, a mail client's in-app browser). It spends nothing:
 * the ticket stays in the fragment, which never reaches a server, and the only
 * thing the page asks of Mission Control is a preview and — on the Install
 * button — a ten-minute download URL. The claim is the app's alone.
 */
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Loader2, ShieldAlert, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PORTAL_APPS, isMobilePortal } from "@/lib/mobile/portals.pure";
import { buildAppOpenUrl, isActivationTicket } from "@/lib/mobile/tickets.pure";

export const Route = createFileRoute("/a/$grantRef")({
  component: AccessLinkPage,
  head: () => ({
    meta: [
      { title: "Your app — Aurixa Systems" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
});

type Preview = {
  workspaceName: string | null;
  portal: string;
  appLabel: string;
  appReady: boolean;
  blocker: string | null;
  androidAvailable: boolean;
  iosCustomAppUrl: string | null;
};

type Device = "android" | "ios" | "other";

function detectDevice(): Device {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "other";
}

function readTicket(): string | null {
  if (typeof window === "undefined") return null;
  const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
  return isActivationTicket(t) ? t : null;
}

function AccessLinkPage() {
  const { grantRef } = useParams({ from: "/a/$grantRef" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "unreachable">("loading");
  const [ticket, setTicket] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("other");
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    setTicket(readTicket());
    setDevice(detectDevice());
    let cancelled = false;
    fetch(`/api/public/mobile/grants/${encodeURIComponent(grantRef)}`, { cache: "no-store" })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) return setState("invalid");
        if (!r.ok) return setState("unreachable");
        const body = (await r.json()) as { preview: Preview };
        setPreview(body.preview);
        setState("ready");
      })
      .catch(() => !cancelled && setState("unreachable"));
    return () => {
      cancelled = true;
    };
  }, [grantRef]);

  const openUrl = useMemo(() => {
    if (!preview || !isMobilePortal(preview.portal)) return null;
    return buildAppOpenUrl(PORTAL_APPS[preview.portal].androidPackage, grantRef, ticket);
  }, [preview, grantRef, ticket]);

  async function install() {
    setBusy(true);
    setInstallError(null);
    try {
      const r = await fetch("/api/public/mobile/download-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_ref: grantRef, ticket }),
      });
      const body = (await r.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!r.ok || !body.url) {
        setInstallError(body.message ?? "The app could not be fetched. Try again shortly.");
        return;
      }
      window.location.assign(body.url);
    } catch {
      setInstallError("The app could not be fetched. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Card className="glass w-full max-w-md">
        {state === "loading" && (
          <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking your link…
          </CardContent>
        )}
        {state === "invalid" && (
          <CardHeader>
            <CardTitle>This link is not valid</CardTitle>
            <CardDescription>
              It may have been withdrawn. Ask your workspace administrator for a new one, or request
              one at{" "}
              <a className="underline" href="/access">
                the access page
              </a>
              .
            </CardDescription>
          </CardHeader>
        )}
        {state === "unreachable" && (
          <CardHeader>
            <CardTitle>We could not check this link</CardTitle>
            <CardDescription>Nothing has been used. Reload the page to try again.</CardDescription>
          </CardHeader>
        )}
        {state === "ready" && preview && (
          <>
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Smartphone className="h-5 w-5" aria-hidden />
              </div>
              <CardTitle>{preview.appLabel}</CardTitle>
              <CardDescription>
                {preview.workspaceName
                  ? `Your access to ${preview.workspaceName}.`
                  : "Your access to your workspace."}{" "}
                Install the app, then open this same link on this phone.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!preview.appReady && (
                <Alert>
                  <ShieldAlert className="h-4 w-4" aria-hidden />
                  <AlertTitle>This app is not available yet</AlertTitle>
                  <AlertDescription>{preview.blocker}</AlertDescription>
                </Alert>
              )}
              {!ticket && (
                <Alert>
                  <ShieldAlert className="h-4 w-4" aria-hidden />
                  <AlertTitle>This link is incomplete</AlertTitle>
                  <AlertDescription>
                    Open the link exactly as it arrived — the part after the # is your one-time
                    code.
                  </AlertDescription>
                </Alert>
              )}
              {preview.appReady && ticket && device === "android" && (
                <div className="space-y-2">
                  {preview.androidAvailable ? (
                    <Button className="w-full" onClick={install} disabled={busy}>
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Download className="mr-2 h-4 w-4" aria-hidden />
                      )}
                      Install the app
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No Android build has been released yet.
                    </p>
                  )}
                  {openUrl && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href={openUrl}>
                        <ExternalLink className="mr-2 h-4 w-4" aria-hidden /> I have the app — open
                        it
                      </a>
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Android will ask once to allow installs from your browser. The app checks every
                    update against Aurixa's signature before installing it.
                  </p>
                  {installError && <p className="text-sm text-destructive">{installError}</p>}
                </div>
              )}
              {preview.appReady && ticket && device === "ios" && (
                <div className="space-y-2">
                  {preview.iosCustomAppUrl ? (
                    <Button className="w-full" asChild>
                      <a href={preview.iosCustomAppUrl} rel="noreferrer">
                        <Download className="mr-2 h-4 w-4" aria-hidden /> Get the app from Apple
                      </a>
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      The iPhone app is not available for your organisation yet.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Once installed, come back to this email and tap the link again.
                  </p>
                </div>
              )}
              {preview.appReady && ticket && device === "other" && (
                <p className="text-sm text-muted-foreground">
                  Open this link on the phone you will use the app on. Nothing has been used yet, so
                  the link still works there.
                </p>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
