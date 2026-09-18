import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { OverviewTab } from "@/components/billing/overview-tab";
import { TenantsTab } from "@/components/billing/tenants-tab";
import { PlansPacksTab } from "@/components/billing/plans-packs-tab";
import { RatesTab } from "@/components/billing/rates-tab";
import { KeysTab } from "@/components/billing/keys-tab";
import { WebhooksTab } from "@/components/billing/webhooks-tab";

/**
 * The tab is in the URL because other pages have to be able to send an
 * operator here.
 *
 * The Builders Network console is switched on by minting a platform key, and
 * this page's API Keys tab is the one place that mints one. While the tab was
 * `defaultValue="overview"` with no search param, that remedy could not be
 * linked to at all — a link to it silently opened Overview — so the console
 * named the act in prose and left the operator to find the page by its title,
 * which shares no word with what they were trying to do.
 *
 * `fallback` keeps a stale or hand-edited tab from throwing: an unknown value
 * opens Overview, which is what a bookmark from before this change does too.
 */
const TABS = ["overview", "tenants", "plans", "rates", "keys", "webhooks"] as const;

const billingSearchSchema = z.object({
  tab: fallback(z.enum(TABS), "overview").default("overview"),
});

export const Route = createFileRoute("/settings/billing")({
  validateSearch: zodValidator(billingSearchSchema),
  component: BillingDashboard,
  head: () => ({ meta: [{ title: "Billing & Tokens — Mission Control" }] }),
});

function BillingDashboard() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/settings/billing" });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-mono">monetization</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Billing &amp; Tokens</h2>
        </div>
        <Link
          to="/settings"
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          ← back
        </Link>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          // `replace` so moving between tabs does not fill the back button
          // with steps the operator never chose to take.
          navigate({
            search: (prev) => ({ ...prev, tab: next as (typeof TABS)[number] }),
            replace: true,
          })
        }
        className="space-y-4"
      >
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="plans">Plans &amp; Packs</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="tenants">
          <TenantsTab />
        </TabsContent>
        <TabsContent value="plans">
          <PlansPacksTab />
        </TabsContent>
        <TabsContent value="rates">
          <RatesTab />
        </TabsContent>
        <TabsContent value="keys">
          <KeysTab />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
