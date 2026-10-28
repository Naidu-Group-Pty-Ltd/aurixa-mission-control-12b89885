/**
 * Trial offers, on Billing → Payment Gates.
 *
 * A trial offer is a named free-trial length — "Partner referral, 30 days" —
 * that can be picked when a workspace is provisioned and shared as a website
 * link. Creating, changing and retiring one is an admin act, enforced on the
 * server; the panel shows the controls to everyone and the server refuses
 * those it should.
 *
 * Changing an offer's length changes what it gives from then on. A workspace
 * already armed with it keeps the trial it was given, because a gate keeps
 * the hours it was armed with and never reads an offer.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Copy, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  createTrialOfferFn,
  getTrialSettings,
  updateTrialOfferFn,
} from "@/server/trial-offers.functions";
import {
  describeTrialDaysError,
  normaliseOfferCode,
  websiteOfferStatus,
  type TrialOfferSummary,
} from "@/lib/trialOffers.pure";
import { normaliseTrialDays } from "@/lib/clonePaymentGate.pure";
import { trialOfferLink } from "@/lib/storefront";

type Result = { ok: boolean; error?: string };

function statusBadge(offer: TrialOfferSummary) {
  const status = websiteOfferStatus(offer);
  if (status === "accepted") return <Badge variant="outline">live on the website</Badge>;
  if (status === "expired") return <Badge variant="secondary">campaign ended</Badge>;
  return <Badge variant="secondary">retired</Badge>;
}

/** `datetime-local` speaks local wall time; the column is a timestamp. */
function toIsoOrNull(local: string): string | null {
  if (!local.trim()) return null;
  const ms = Date.parse(local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "no end";
  return new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

export function TrialOffersPanel() {
  const qc = useQueryClient();
  const settingsFn = useServerFn(getTrialSettings);
  const createFn = useServerFn(createTrialOfferFn);
  const updateFn = useServerFn(updateTrialOfferFn);
  const query = useQuery({ queryKey: ["trial-settings"], queryFn: () => settingsFn() });

  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("30");
  const [ends, setEnds] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const codeParsed = normaliseOfferCode(code);
  const daysParsed = normaliseTrialDays(days);
  const canCreate = codeParsed.ok && daysParsed.ok && label.trim().length >= 2 && !busy;

  async function run(key: string, act: () => Promise<Result>, done: string) {
    setBusy(key);
    try {
      const result = await act();
      if (!result.ok) {
        toast.error(result.error ?? "Could not save");
        return false;
      }
      toast.success(done);
      await qc.invalidateQueries({ queryKey: ["trial-settings"] });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!codeParsed.ok || !daysParsed.ok) return;
    const ok = await run(
      "create",
      () =>
        createFn({
          data: {
            code: codeParsed.code,
            label: label.trim(),
            trialDays: daysParsed.days,
            expiresAt: toIsoOrNull(ends),
            notes: notes.trim() || null,
          },
        }) as Promise<Result>,
      `Trial offer ${codeParsed.code} created`,
    );
    if (ok) {
      setCode("");
      setLabel("");
      setDays("30");
      setEnds("");
      setNotes("");
    }
  }

  const offers = query.data?.offers ?? [];
  const pending = query.data?.offersError === "schema_pending";

  return (
    <div className="glass space-y-5 p-5">
      <div className="space-y-1">
        <p className="label-mono">custom trial periods</p>
        <h2 className="flex items-center gap-2 font-display text-lg">
          <Gift className="h-4 w-4 text-primary" /> Trial offers
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          A named free-trial length to give instead of the platform default. Pick it when
          provisioning a clone or on an agreement&apos;s provisioning settings, or share its website
          link: the trial application then offers that length and carries the code to the lead it
          creates. Changing an offer never moves a trial a workspace already has.
        </p>
      </div>

      {pending && (
        <p className="text-sm text-warning">
          Trial offers are not in the database yet — the migration that adds them has not applied.
        </p>
      )}
      {query.data?.offersError && !pending && (
        <p className="text-sm text-destructive">
          Trial offers could not be read: {query.data.offersError}
        </p>
      )}

      {offers.length > 0 && (
        <ul className="divide-y divide-border/60 border border-border/60">
          {offers.map((offer) => (
            <OfferRow
              key={offer.id}
              offer={offer}
              busy={busy === offer.id}
              onUpdate={(patch, done) =>
                run(
                  offer.id,
                  () => updateFn({ data: { id: offer.id, ...patch } }) as Promise<Result>,
                  done,
                )
              }
            />
          ))}
        </ul>
      )}

      {!pending && (
        <div className="space-y-3 border-t border-border/60 pt-4">
          <p className="text-sm font-medium">New trial offer</p>
          <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)_7rem_13rem]">
            <div className="space-y-1">
              <Label htmlFor="offer-code">Code</Label>
              <Input
                id="offer-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="PARTNER-30"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="offer-label">Name</Label>
              <Input
                id="offer-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Partner referral"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="offer-days">Days</Label>
              <Input
                id="offer-days"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="offer-ends">Website link ends (optional)</Label>
              <Input
                id="offer-ends"
                type="datetime-local"
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="offer-notes">Notes (internal, never shown on the website)</Label>
            <Textarea
              id="offer-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={create} disabled={!canCreate}>
              Create offer
            </Button>
            {code.trim() !== "" && !codeParsed.ok && (
              <span className="text-xs text-destructive">
                A code is 2 to 32 letters, digits or hyphens.
              </span>
            )}
            {!daysParsed.ok && (
              <span className="text-xs text-destructive">
                {describeTrialDaysError(daysParsed.error)}
              </span>
            )}
            {codeParsed.ok && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {trialOfferLink(codeParsed.code)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OfferRow({
  offer,
  busy,
  onUpdate,
}: {
  offer: TrialOfferSummary & { notes?: string | null };
  busy: boolean;
  onUpdate: (
    patch: { trialDays?: number; active?: boolean; label?: string },
    done: string,
  ) => Promise<boolean>;
}) {
  const [days, setDays] = useState(String(offer.trial_days));
  const parsed = normaliseTrialDays(days);
  const link = trialOfferLink(offer.code);

  return (
    <li className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{offer.code}</span>
          <span className="text-sm">{offer.label}</span>
          {statusBadge(offer)}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Website link ends: {formatDate(offer.expires_at)}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(link)
                .then(() => toast.success("Link copied"))
                .catch(() => toast.error("Could not copy — select the link instead"));
            }}
            title="Copy the website link"
          >
            <Copy className="h-3 w-3" /> {link}
          </button>
        </div>
        {offer.notes && <p className="text-xs text-muted-foreground">{offer.notes}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Days for ${offer.code}`}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-20"
          />
          <span className="text-xs text-muted-foreground">days</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !parsed.ok || parsed.days === offer.trial_days}
            onClick={() =>
              parsed.ok &&
              onUpdate({ trialDays: parsed.days }, `${offer.code} now gives ${parsed.days} days`)
            }
          >
            Save
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={offer.active}
            disabled={busy}
            onCheckedChange={(next) =>
              onUpdate(
                { active: next },
                next ? `${offer.code} is live again` : `${offer.code} retired`,
              )
            }
          />
          {offer.active ? "active" : "retired"}
        </label>
      </div>
    </li>
  );
}
