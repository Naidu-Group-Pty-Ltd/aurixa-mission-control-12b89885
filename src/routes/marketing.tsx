// The Marketing module: Aurixa Systems' own advertising and the leads it buys.
//
// One layout for every tab, so the range chosen on Overview is the range Meta,
// YouTube and TikTok open on. It is the prime's Marketing module carried across
// (docs/MARKETING.md): the same engine, the same findings, the same digest
// rules — with Mission Control's own accounts, its own leads (waitlist_leads)
// and its own deals (crm_deals).
import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import {
  BarChart3,
  FileText,
  KeyRound,
  Layers,
  Music2,
  PlayCircle,
  Target,
  Users,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { MarketingRangeProvider, RangeControl } from "@/components/marketing/marketing-range";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/marketing")({
  component: () => (
    <ProtectedRoute>
      <MarketingLayout />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Marketing — Aurixa Systems Mission Control" }] }),
});

const TABS = [
  { to: "/marketing", label: "Overview", icon: Layers, exact: true },
  { to: "/marketing/meta", label: "Meta", icon: Target, exact: false },
  { to: "/marketing/youtube", label: "YouTube", icon: PlayCircle, exact: false },
  { to: "/marketing/tiktok", label: "TikTok", icon: Music2, exact: false },
  { to: "/marketing/attribution", label: "Attribution", icon: Users, exact: false },
  { to: "/marketing/briefs", label: "Briefs", icon: FileText, exact: false },
  { to: "/marketing/connections", label: "Connections", icon: KeyRound, exact: false },
] as const;

function MarketingLayout() {
  const loc = useLocation();
  const showRange =
    !loc.pathname.startsWith("/marketing/connections") &&
    !loc.pathname.startsWith("/marketing/briefs");
  return (
    <MarketingRangeProvider>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center bg-accent/15 ring-1 ring-accent/40">
              <BarChart3 className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="label-mono">aurixa systems</p>
              <h1 className="font-display text-[2.125rem] leading-[1.05]">Marketing</h1>
              <p className="text-sm text-muted-foreground">
                Ad performance on Meta, YouTube and TikTok, and the leads and deals it produced.
              </p>
            </div>
          </div>
          {showRange && <RangeControl />}
        </header>

        <nav className="flex overflow-x-auto border border-border" aria-label="Marketing">
          {TABS.map((t) => {
            const active = t.exact
              ? loc.pathname === t.to || loc.pathname === `${t.to}/`
              : loc.pathname.startsWith(t.to);
            const Icon = t.icon;
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "flex shrink-0 items-center justify-center gap-2 border-l border-border px-3 py-2 font-mono text-[10px] tracking-[0.14em] whitespace-nowrap uppercase transition-colors first:border-l-0",
                  active
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </Link>
            );
          })}
        </nav>

        <Outlet />
      </div>
    </MarketingRangeProvider>
  );
}
