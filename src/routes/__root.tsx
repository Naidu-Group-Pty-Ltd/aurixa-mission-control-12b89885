import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RealtimeNotifications } from "@/lib/realtime-notifications";
import { BrowserPushNotifications } from "@/lib/browser-notifications";
import { NotificationPreferencesSync } from "@/components/notification-preferences-sync";
import { ConfirmProvider } from "@/components/confirm-dialog";
import { registerServiceWorker } from "@/lib/push-subscription";
import { TelephonyProvider } from "@/components/voice/softphone/telephony-provider";
import { SoftphoneOverlay } from "@/components/voice/softphone/softphone-overlay";

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-mono text-7xl font-bold text-primary text-glow">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Signal lost</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for is off-grid.
        </p>
        <div className="mt-6">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Return to base
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * The Aurixa Systems mark, and the ONE place Mission Control names it.
 *
 * Kept beside the head config rather than in a shared module because this app
 * has exactly one consumer of it; the clones have their own copy of the same
 * rule in `src/branding/platformBrand.ts`, for the same reason — one name per
 * deployment, so the artwork is swapped in one file.
 */
const AURIXA_FAVICON = "/brand/aurixa-favicon-192.png";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Aurixa Systems - Mission Control" },
      {
        name: "description",
        content: "Operate a fleet of cloned codebases with cascade-driven updates.",
      },
      { property: "og:title", content: "Aurixa Systems - Mission Control" },
      { name: "twitter:title", content: "Aurixa Systems - Mission Control" },
      {
        property: "og:description",
        content: "Operate a fleet of cloned codebases with cascade-driven updates.",
      },
      {
        name: "twitter:description",
        content: "Operate a fleet of cloned codebases with cascade-driven updates.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/b0e1b502-dd5b-4d05-9849-da602a137a42/id-preview-090a6f95--0fb4d803-5071-4093-be25-5afbcf116476.lovable.app-1776642305633.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/b0e1b502-dd5b-4d05-9849-da602a137a42/id-preview-090a6f95--0fb4d803-5071-4093-be25-5afbcf116476.lovable.app-1776642305633.png",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      /*
        Mission Control declared no icon of any kind, so every operator tab
        showed the browser's blank-page glyph and the whole fleet console was
        indistinguishable from an untitled tab beside the clones it operates.
        Declared explicitly rather than left to a root /favicon.ico, which this
        app does not serve either.

        `AURIXA_FAVICON` is the one place the platform mark is named — the same
        rule the clones follow, so replacing the artwork is one file rather
        than a search across three repositories.
      */
      { rel: "icon", type: "image/png", sizes: "192x192", href: AURIXA_FAVICON },
      { rel: "apple-touch-icon", sizes: "180x180", href: AURIXA_FAVICON },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        // Archivo as a VARIABLE font, both axes as ranges. Google answers this with
        // `font-weight: 400 700; font-stretch: 62% 125%`, which is what lets
        // `.font-display` reach for 125% width. Naming individual widths instead
        // (`@100;125,400;500`) is invalid multi-axis syntax — Google answers 400 and
        // the whole page silently falls back to the system sans.
        href: "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&family=JetBrains+Mono:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
        {/* Pre-hydration theme bootstrap: apply the stored theme before first
            paint so light-mode users don't flash the default dark shell. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('aurixa.theme');var d=document.documentElement;if(t==='light'){d.classList.add('light');d.classList.remove('dark');}else{d.classList.add('dark');d.classList.remove('light');}}catch(e){}})();",
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  useEffect(() => {
    void registerServiceWorker();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={150}>
          <ConfirmProvider>
            <TelephonyProvider>
              <NotificationPreferencesSync />
              <RealtimeNotifications />
              <BrowserPushNotifications />
              <Outlet />
              <SoftphoneOverlay />
              <Toaster />
            </TelephonyProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
