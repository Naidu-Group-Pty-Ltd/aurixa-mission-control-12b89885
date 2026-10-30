import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Gift, Sparkles, AlertTriangle } from "lucide-react";
import { bulkGiftTokens, previewGiftTargets, listGiftCampaigns } from "@/lib/gift-tokens.functions";
import { describeGiftCampaignExpiry } from "@/lib/giftCampaigns.pure";
import { listPlans, listTenants } from "@/lib/tokens.functions";

export const Route = createFileRoute("/settings/gift-tokens")({
  // Nested under /settings (auth already gated by the parent layout).
  component: () => <GiftTokensPage />,
  head: () => ({ meta: [{ title: "Gift Tokens — Aurixa Systems" }] }),
});

type Scope = "all" | "plan" | "tenants";

function GiftTokensPage() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [tenantSearch, setTenantSearch] = useState("");
  const [tokens, setTokens] = useState(1000);
  const [campaignName, setCampaignName] = useState("");
  const [reason, setReason] = useState("Promotional grant");
  const [expiresAt, setExpiresAt] = useState("");
  const [excludeInactive, setExcludeInactive] = useState(true);

  const plansQ = useQuery({ queryKey: ["plans"], queryFn: () => listPlans() });
  const tenantsQ = useQuery({
    queryKey: ["tenants", tenantSearch],
    queryFn: () => listTenants({ data: { search: tenantSearch || undefined, limit: 200 } }),
  });
  const campaignsQ = useQuery({
    queryKey: ["gift-campaigns"],
    queryFn: () => listGiftCampaigns(),
  });

  const preview = useServerFn(previewGiftTargets);
  const previewQ = useQuery({
    queryKey: ["gift-preview", scope, planIds, tenantIds, excludeInactive],
    queryFn: () => {
      const payload =
        scope === "all"
          ? { scope: "all" as const, excludeInactive }
          : scope === "plan"
            ? { scope: "plan" as const, planIds, excludeInactive }
            : { scope: "tenants" as const, tenantIds, excludeInactive };
      return preview({ data: payload });
    },
    enabled:
      scope === "all" ||
      (scope === "plan" && planIds.length > 0) ||
      (scope === "tenants" && tenantIds.length > 0),
  });

  const gift = useServerFn(bulkGiftTokens);
  const mut = useMutation({
    mutationFn: (payload: any) => gift({ data: payload }),
    onSuccess: (res: any) => {
      if (!res.ok) {
        toast.error(`Gift failed: ${res.error}`);
        return;
      }
      toast.success(
        `Gifted ${res.totalTokensIssued.toLocaleString()} tokens to ${res.granted} tenants (${res.campaignId})`,
      );
      if (res.failures?.length) {
        toast.warning(
          `${res.failures.length} tenant(s) failed: ${res.failures[0]?.error ?? "unknown error"}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["gift-campaigns"] });
      qc.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Gift failed"),
  });

  const submit = () => {
    if (!campaignName.trim()) {
      toast.error("Campaign name required");
      return;
    }
    const base = {
      tokensPerTenant: tokens,
      reason,
      campaignName: campaignName.trim(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      excludeInactive,
    };
    const payload =
      scope === "all"
        ? { ...base, scope: "all" as const }
        : scope === "plan"
          ? { ...base, scope: "plan" as const, planIds }
          : { ...base, scope: "tenants" as const, tenantIds };
    if (scope === "plan" && planIds.length === 0) {
      toast.error("Pick at least one plan");
      return;
    }
    if (scope === "tenants" && tenantIds.length === 0) {
      toast.error("Pick at least one tenant");
      return;
    }
    mut.mutate(payload);
  };

  const targetCount = previewQ.data?.count ?? 0;
  const totalToIssue = targetCount * tokens;

  return (
    <div className="space-y-6">
      <div>
        <div className="label-mono flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" /> promotions
        </div>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Gift tokens</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Grant free tokens to tenants for promotions, comps, or one-off goodwill. These bypass the
          payment pipeline and land directly in the recipient's balance.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gift className="h-4 w-4" /> New gift campaign
          </CardTitle>
          <CardDescription>Ledger rows tagged with a campaign id for rollups.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Campaign name</Label>
              <Input
                placeholder="e.g. October launch bonus"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tokens per tenant</Label>
              <Input
                type="number"
                min={1}
                value={tokens}
                onChange={(e) => setTokens(Math.max(1, Number(e.target.value) || 0))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Reason (visible in ledger)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being granted?"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Expires at (optional)</Label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Checkbox
                id="excludeInactive"
                checked={excludeInactive}
                onCheckedChange={(v) => setExcludeInactive(!!v)}
              />
              <Label htmlFor="excludeInactive" className="cursor-pointer font-normal">
                Exclude past-due / canceled tenants
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Target scope</Label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { v: "all", l: "All active tenants" },
                  { v: "plan", l: "By plan" },
                  { v: "tenants", l: "Specific tenants" },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  onClick={() => setScope(o.v)}
                  className={`rounded border px-3 py-1.5 text-sm transition ${
                    scope === o.v
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-surface"
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          {scope === "plan" && (
            <div className="space-y-2">
              <Label>Pick plans</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {(plansQ.data?.plans ?? []).map((p: any) => {
                  const on = planIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() =>
                        setPlanIds((ids) => (on ? ids.filter((i) => i !== p.id) : [...ids, p.id]))
                      }
                      className={`flex items-center justify-between rounded border px-3 py-2 text-left text-sm ${
                        on ? "border-primary bg-primary/10" : "border-border"
                      }`}
                    >
                      <span>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {p.monthly_allowance?.toLocaleString()} tokens/mo
                        </div>
                      </span>
                      {on && <Badge>Selected</Badge>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {scope === "tenants" && (
            <div className="space-y-2">
              <Label>Pick tenants</Label>
              <Input
                placeholder="Search by name or external ref…"
                value={tenantSearch}
                onChange={(e) => setTenantSearch(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto border border-border">
                {(tenantsQ.data?.tenants ?? []).map((t: any) => {
                  const on = tenantIds.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-surface"
                    >
                      <Checkbox
                        checked={on}
                        onCheckedChange={() =>
                          setTenantIds((ids) =>
                            on ? ids.filter((i) => i !== t.id) : [...ids, t.id],
                          )
                        }
                      />
                      <div className="flex-1">
                        <div className="font-medium">{t.display_name ?? t.external_ref}</div>
                        <div className="text-xs text-muted-foreground">
                          {t.external_ref} · {t.status}
                          {t.billing_plans?.name ? ` · ${t.billing_plans.name}` : ""}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {(tenantsQ.data?.tenants ?? []).length === 0 && (
                  <div className="p-4 text-center text-sm text-muted-foreground">No tenants</div>
                )}
              </div>
              {tenantIds.length > 0 && (
                <p className="text-xs text-muted-foreground">{tenantIds.length} selected</p>
              )}
            </div>
          )}

          <div className="border border-border bg-surface p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
              <div className="flex-1 text-sm">
                <div className="font-medium">Preview</div>
                <div className="text-muted-foreground">
                  Will gift{" "}
                  <span className="font-mono text-foreground">{tokens.toLocaleString()}</span>{" "}
                  tokens to <span className="font-mono text-foreground">{targetCount}</span> tenants
                  ={" "}
                  <span className="font-mono text-foreground">{totalToIssue.toLocaleString()}</span>{" "}
                  tokens total.
                </div>
                {previewQ.isError && (
                  <div className="mt-1 text-destructive">
                    Target preview failed
                    {previewQ.error instanceof Error && previewQ.error.message.includes("403")
                      ? " — your account needs an admin role to gift tokens."
                      : `: ${previewQ.error instanceof Error ? previewQ.error.message : "unknown error"}`}
                  </div>
                )}
              </div>
            </div>
          </div>

          <Button
            onClick={submit}
            disabled={mut.isPending || targetCount === 0}
            className="w-full sm:w-auto"
          >
            {mut.isPending
              ? "Gifting…"
              : `Gift ${totalToIssue.toLocaleString()} tokens to ${targetCount} tenants`}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Past campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {(campaignsQ.data?.campaigns ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No promotions yet.</p>
          ) : (
            <div className="space-y-2">
              {(campaignsQ.data?.campaigns ?? []).map((c) => (
                <div
                  key={c.campaignId}
                  className="flex items-center justify-between border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{c.campaignName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {c.campaignId} · {new Date(c.createdAt).toLocaleString()}
                      {c.grantedBy ? ` · by ${c.grantedBy}` : ""}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {describeGiftCampaignExpiry(c.expiry, (iso) =>
                        new Date(iso).toLocaleString(),
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono">{c.totalTokens.toLocaleString()} tokens</div>
                    <div className="text-xs text-muted-foreground">{c.tenants} tenants</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
