import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Search, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  createSubscriptionAgreement,
  searchAgreementClients,
  searchAgreementLeads,
} from "@/lib/agreements.functions";
import { aud, tierSummary } from "@/lib/agreements/offerEditor.pure";
import { formatCount } from "@/lib/agreements/subscriptionPricing.pure";
import {
  SUBSCRIPTION_TIER_SLUGS,
  type SubscriptionTierSlug,
} from "@/lib/agreements/subscriptionTemplates";

export type OfferRecipient =
  | { kind: "lead"; id: string; name: string; email: string; org: string | null }
  | { kind: "contact"; id: string; name: string; email: string; org: string | null };

type Mode = "lead" | "contact" | "none";

/**
 * Raise a Subscription Agreement offer: choose the tier — each is its own
 * approved template — and who it is for. The draft opens in the offer editor,
 * prefilled from the issuing profile and from what Mission Control already
 * knows about the lead.
 *
 * `recipient` preselects a lead (the Leads page opens this from a lead's row);
 * the operator can still pick someone else or nobody.
 */
export function NewSubscriptionDialog({
  open,
  onOpenChange,
  recipient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipient?: OfferRecipient | null;
}) {
  const navigate = useNavigate();
  const [tier, setTier] = useState<SubscriptionTierSlug | null>(null);
  const [mode, setMode] = useState<Mode>("lead");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<OfferRecipient | null>(null);

  useEffect(() => {
    if (!open) return;
    setTier(null);
    setSearch("");
    setPicked(recipient ?? null);
    setMode(recipient?.kind ?? "lead");
  }, [open, recipient]);

  const tiers = useMemo(() => SUBSCRIPTION_TIER_SLUGS.map(tierSummary), []);
  const term = search.trim();

  const leadsQ = useQuery({
    queryKey: ["agreements", "offer-leads", term],
    queryFn: () => searchAgreementLeads({ data: { search: term } }),
    enabled: open && mode === "lead" && term.length >= 2,
  });
  const contactsQ = useQuery({
    queryKey: ["agreements", "clients", term],
    queryFn: () => searchAgreementClients({ data: { search: term } }),
    enabled: open && mode === "contact" && term.length >= 2,
  });

  const results: OfferRecipient[] =
    mode === "lead"
      ? (leadsQ.data?.leads ?? []).map((l) => ({
          kind: "lead" as const,
          id: l.id,
          name: l.name,
          email: l.email,
          org: l.org,
        }))
      : mode === "contact"
        ? (contactsQ.data?.contacts ?? []).map((c) => ({
            kind: "contact" as const,
            id: c.id,
            name: c.name,
            email: c.email,
            org: c.org,
          }))
        : [];
  const searching = mode === "lead" ? leadsQ.isFetching : contactsQ.isFetching;

  const createM = useMutation({
    mutationFn: () => {
      if (!tier) throw new Error("Choose a tier.");
      return createSubscriptionAgreement({
        data: {
          tier,
          leadId: mode === "lead" && picked?.kind === "lead" ? picked.id : undefined,
          contactId: mode === "contact" && picked?.kind === "contact" ? picked.id : undefined,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`Offer ${res.offerReference} prepared`);
      onOpenChange(false);
      void navigate({ to: "/agreements/$agreementId", params: { agreementId: res.id } });
    },
    onError: (err: Error) =>
      toast.error("The offer could not be prepared", { description: err.message }),
  });

  const whoReady = mode === "none" || (picked !== null && picked.kind === mode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Subscription Agreement</DialogTitle>
          <DialogDescription>
            Each tier is its own approved agreement. Choose the one the lead is buying and who it is
            for — the draft opens in the offer editor, where the price, dates and schedules are
            completed before anything is sent.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <p className="label-mono">1 · tier</p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tier">
            {tiers.map((t) => {
              const active = tier === t.tier;
              return (
                <button
                  key={t.tier}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTier(t.tier)}
                  className={cn(
                    "glass-inset spine p-3 text-left transition-colors",
                    active ? "spine-live" : "spine-idle hover:border-border-strong",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-lg">{t.name}</span>
                    {active && <Check className="h-4 w-4 text-info" aria-hidden />}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-foreground">
                    {aud(t.withAmlCents)}{" "}
                    <span className="text-muted-foreground">/ month with AML</span>
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {aud(t.withoutAmlCents)} without AML
                  </p>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t.seats} · {formatCount(t.tokens)} tokens / cycle
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.included.length === 0
                      ? "Optional modules are purchased per line."
                      : `Includes ${t.included.length} modules — ${t.included.slice(0, 3).join(", ")}${t.included.length > 3 ? "…" : ""}`}
                  </p>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Standard monthly base, including GST. A 12-month commitment takes 15% off the base; the
            term, seats, modules and charges are set in the editor.
          </p>
        </section>

        <section className="space-y-3">
          <p className="label-mono">2 · who it is for</p>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Recipient source">
            {(
              [
                { id: "lead", label: "Waitlist lead", icon: UserRound },
                { id: "contact", label: "CRM contact", icon: Users },
                { id: "none", label: "No one yet", icon: null },
              ] as const
            ).map((m) => (
              <Button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                size="sm"
                variant={mode === m.id ? "secondary" : "ghost"}
                onClick={() => {
                  setMode(m.id);
                  setSearch("");
                }}
              >
                {m.icon && <m.icon className="h-3.5 w-3.5" />}
                {m.label}
              </Button>
            ))}
          </div>

          {mode === "none" ? (
            <p className="text-sm text-muted-foreground">
              The offer is prepared blank; the customer and their representative are entered in the
              editor. It will not be linked to a lead or a client record.
            </p>
          ) : (
            <div className="space-y-2">
              {picked && picked.kind === mode && (
                <div className="glass-inset spine spine-ok flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {picked.name || picked.email}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {picked.email}
                      {picked.org ? ` · ${picked.org}` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                    Change
                  </Button>
                </div>
              )}
              {!(picked && picked.kind === mode) && (
                <>
                  <Label htmlFor="offer-recipient-search" className="sr-only">
                    Search
                  </Label>
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      id="offer-recipient-search"
                      value={search}
                      autoFocus
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={
                        mode === "lead"
                          ? "Search leads by name, email or organisation…"
                          : "Search CRM contacts by name or email…"
                      }
                      className="pl-8"
                    />
                  </div>
                  {term.length >= 2 && (
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                      {searching && results.length === 0 ? (
                        <p className="px-1 font-mono text-xs text-muted-foreground">Searching…</p>
                      ) : results.length === 0 ? (
                        <p className="px-1 text-xs text-muted-foreground">
                          Nobody matches “{term}”.
                        </p>
                      ) : (
                        results.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            className="glass-inset flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:border-border-strong"
                            onClick={() => setPicked(r)}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">
                                {r.name || r.email}
                              </span>
                              <span className="block truncate font-mono text-xs text-muted-foreground">
                                {r.email}
                                {r.org ? ` · ${r.org}` : ""}
                              </span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!tier || !whoReady || createM.isPending}
            onClick={() => createM.mutate()}
          >
            {createM.isPending ? "Preparing…" : "Prepare offer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
