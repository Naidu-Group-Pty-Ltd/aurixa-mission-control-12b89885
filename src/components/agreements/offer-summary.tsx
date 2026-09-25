import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { MODULES } from "@/lib/pricing/aurixa-catalog";
import {
  ADDITIONAL_LINE_LABELS,
  aud,
  gapCountsBySection,
  longDate,
  OFFER_SECTIONS,
  reviewRows,
  sectionOfGap,
  type OfferSection,
  type OfferView,
} from "@/lib/agreements/offerEditor.pure";
import { ordinal } from "@/lib/agreements/subscriptionPricing.pure";
import type { SubscriptionOffer } from "@/lib/agreements/subscriptionOffer.pure";
import {
  provisioningSelectionFromOffer,
  selectionMatches,
} from "@/lib/agreements/subscriptionIssue.pure";
import { a3Item, SUBSCRIPTION_TEMPLATES } from "@/lib/agreements/subscriptionTemplates";

/**
 * Scroll the editor to a section and put the cursor in the first field that
 * still needs something — a gap named without being shown where is a gap an
 * operator hunts for.
 */
function jumpToOfferSection(section: OfferSection): void {
  const panel = document.getElementById(`offer-${section}`);
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  const target =
    panel.querySelector<HTMLElement>("[aria-invalid='true']:not(:disabled)") ??
    panel.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)");
  target?.focus({ preventScroll: true });
}

function Panel({
  label,
  title,
  children,
  className,
}: {
  label: string;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass space-y-3 p-4", className)}>
      <header>
        <p className="label-mono">{label}</p>
        {title && <h2 className="font-display mt-1 text-lg leading-tight">{title}</h2>}
      </header>
      {children}
    </section>
  );
}

function Line({
  label,
  value,
  strong,
  muted,
  note,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  muted?: boolean;
  note?: ReactNode;
}) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("text-sm", muted ? "text-muted-foreground" : "text-foreground/85")}>
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 text-right font-mono tabular-nums",
            strong ? "text-sm font-semibold text-foreground" : "text-xs text-foreground/85",
          )}
        >
          {value}
        </span>
      </div>
      {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/* ───────────────────────────── readiness ───────────────────────────── */

/**
 * What still stops the offer being sent, grouped by the section that clears
 * it. On an issued offer: that it is a record, and what it was issued as.
 */
export function OfferReadiness({
  view,
  issued,
}: {
  view: OfferView;
  /** Set once the offer has been issued; the snapshot's facts. */
  issued: { at: string; documentName: string; signer: string } | null;
}) {
  const counts = useMemo(() => gapCountsBySection(view.gaps), [view.gaps]);
  const bySection = useMemo(() => {
    const out = new Map<OfferSection, string[]>();
    for (const g of view.gaps) {
      const s = sectionOfGap(g.key);
      const list = out.get(s) ?? [];
      if (!list.includes(g.message)) list.push(g.message);
      out.set(s, list);
    }
    return out;
  }, [view.gaps]);

  if (issued) {
    return (
      <Panel label="issued record" title="Issued — a record now">
        <p className="text-sm text-muted-foreground">
          Issued {longDate(issued.at.slice(0, 10))} to {issued.signer} as{" "}
          <span className="font-mono text-xs text-foreground">{issued.documentName}</span>. What
          follows is the commercial snapshot taken at the send; the offer no longer changes.
          Duplicate it to raise a revised offer.
        </p>
        {view.warnings.length > 0 && <Warnings warnings={view.warnings} />}
      </Panel>
    );
  }

  const total = view.gaps.length;
  return (
    <Panel
      label="readiness"
      title={
        total === 0 ? (
          <span className="text-success">Ready to send</span>
        ) : (
          <span>
            {total} {total === 1 ? "thing" : "things"} to complete
          </span>
        )
      }
    >
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every field the agreement prints is complete. Preview the document to read it as the
          customer will, then send it through DocuSign.
        </p>
      ) : (
        <ul className="space-y-2">
          {OFFER_SECTIONS.filter((s) => counts[s.id] > 0).map((s) => (
            <li key={s.id} className="glass-inset spine spine-warn px-3 py-2">
              <button
                type="button"
                onClick={() => jumpToOfferSection(s.id)}
                className="flex w-full items-baseline justify-between gap-2 text-left text-sm font-medium text-foreground hover:underline"
              >
                <span>{s.title}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                  {counts[s.id]}
                </span>
              </button>
              <ul className="mt-1 space-y-0.5">
                {(bySection.get(s.id) ?? []).slice(0, 4).map((m) => (
                  <li key={m} className="text-xs text-muted-foreground">
                    {m}
                  </li>
                ))}
                {(bySection.get(s.id)?.length ?? 0) > 4 && (
                  <li className="text-xs text-muted-foreground">
                    …and {(bySection.get(s.id)?.length ?? 0) - 4} more.
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {view.warnings.length > 0 && <Warnings warnings={view.warnings} />}
    </Panel>
  );
}

function Warnings({ warnings }: { warnings: readonly string[] }) {
  return (
    <div className="space-y-1">
      <p className="label-mono">check before sending</p>
      {warnings.map((w) => (
        <p key={w} className="text-xs text-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

/* ───────────────────────────── price and dates ───────────────────────────── */

/** The price as the agreement states it, and the dates it runs on. */
export function OfferPrice({ view, offer }: { view: OfferView; offer: SubscriptionOffer }) {
  const t = view.totals;
  const committed = offer.term !== "flexible";
  const prepaid = offer.term === "committed_annual";
  const d = view.dates;
  return (
    <Panel label="price · incl. GST" title={`${aud(t.monthlyTotalCents)} / month`}>
      <div className="divide-y divide-border/40">
        <Line label="Standard base" value={aud(t.base.standardMonthlyCents)} />
        {t.base.discountMonthlyCents > 0 && (
          <Line
            label="12-month commitment discount"
            value={`−${aud(t.base.discountMonthlyCents)}`}
            muted
          />
        )}
        <Line
          label={committed ? "Discounted base" : "Base"}
          value={aud(t.base.netMonthlyCents)}
          note={
            prepaid && t.base.annualPrepaymentCents !== null
              ? `Prepaid once a year: ${aud(t.base.annualPrepaymentCents)}.`
              : undefined
          }
        />
        {t.recurringExtrasCents > 0 && (
          <Line label="Seats and modules" value={aud(t.recurringExtrasCents)} />
        )}
        {t.supportCents > 0 && <Line label="Additional support" value={aud(t.supportCents)} />}
        <Line
          label={prepaid ? "Monthly equivalent" : "Each month"}
          value={aud(t.monthlyTotalCents)}
          strong
          note={`Includes GST of ${aud(t.monthlyGstCents)}.`}
        />
        {t.oneOffTotalCents > 0 && <Line label="One-off charges" value={aud(t.oneOffTotalCents)} />}
        <Line
          label="Due at activation"
          value={aud(t.dueAtActivationCents)}
          strong
          note={
            prepaid
              ? "The annual prepayment, the first month of any extras and support, and the one-off charges."
              : "The first monthly payment and the one-off charges."
          }
        />
        <Line
          label={committed ? "Minimum fixed charges" : "Minimum charge"}
          value={aud(t.minimumFixedCents)}
          muted
        />
        {t.postTermMonthlyCents !== null && (
          <Line
            label="After the commitment"
            value={`${aud(t.postTermMonthlyCents)} / month`}
            muted
            note="Month to month at the standard base, with continuing extras."
          />
        )}
      </div>

      <div className="border-t border-border/40 pt-3">
        <p className="label-mono">dates</p>
        {d ? (
          <div className="divide-y divide-border/40">
            <Line label="Activation" value={longDate(d.activation)} />
            <Line
              label="Renews monthly on"
              value={`the ${ordinal(d.anchorDay)}`}
              note={`First cycle ends ${longDate(d.firstCycleEnd)}; next renewal ${longDate(d.nextRenewal)}.`}
            />
            {d.commitmentLastDay && (
              <Line label="Commitment's last day" value={longDate(d.commitmentLastDay)} />
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            Set the planned activation to see the renewal day and the commitment's end.
          </p>
        )}
      </div>
    </Panel>
  );
}

/* ───────────────────────────── provisioning ───────────────────────────── */

export type ProvisioningRowFacts = {
  plan_slug: string | null;
  addon_slugs: string[] | null;
  provision_on_signature: boolean;
  provision_status: string;
  provision_error: string | null;
  /** The agreement's own status; a voided or declined offer provisions nothing. */
  status?: string;
};

/**
 * What a signature on this offer will provision — derived from the offer, so
 * what the customer signs for is what they receive — and whether it is armed.
 */
export function OfferProvisioning({
  offer,
  row,
  unsaved,
  action,
}: {
  offer: SubscriptionOffer;
  row: ProvisioningRowFacts;
  /** The editor holds changes the row has not been told about yet. */
  unsaved: boolean;
  action?: ReactNode;
}) {
  const selection = useMemo(() => provisioningSelectionFromOffer(offer), [offer]);
  const moduleName = (slug: string) => MODULES.find((m) => m.slug === slug)?.name ?? slug;
  const unprovisioned = offer.addons
    .map((l) => a3Item(l.itemKey))
    .filter((i) => i && i.kind === "module" && !i.catalogSlug)
    .map((i) => i!.label);
  const changesSelection = unsaved && !selectionMatches(row, selection);
  // A voided or declined envelope can never be signed, so nothing it
  // selected will be provisioned — whether or not it was armed before it
  // was withdrawn. Saying "until an operator arms it" there offers an act
  // the page no longer has.
  const withdrawn = row.status === "voided" || row.status === "declined";
  const armed = row.provision_on_signature && !withdrawn;

  return (
    <Panel label="on signature" title="Provisioning">
      <div className="divide-y divide-border/40">
        <Line label="Plan" value={SUBSCRIPTION_TEMPLATES[offer.tier].tierName} />
        <Line
          label="Add-ons"
          value={
            selection.addonSlugs.length === 0
              ? "None"
              : `${selection.addonSlugs.length} ${selection.addonSlugs.length === 1 ? "module" : "modules"}`
          }
          note={
            selection.addonSlugs.length > 0
              ? selection.addonSlugs.map(moduleName).join(", ")
              : undefined
          }
        />
        <Line
          label="State"
          value={
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.18em]",
                row.provision_status === "failed"
                  ? "text-destructive"
                  : armed
                    ? "text-info"
                    : "text-muted-foreground",
              )}
            >
              {withdrawn
                ? "withdrawn"
                : row.provision_status === "none"
                  ? armed
                    ? "armed"
                    : "not armed"
                  : row.provision_status}
            </span>
          }
          note={
            withdrawn
              ? "This offer can no longer be signed, so nothing it selected is provisioned. A revised offer carries its own selection."
              : row.provision_status === "failed" && row.provision_error
                ? row.provision_error
                : armed
                  ? "A signature provisions the workspace automatically, once the signed agreement has been retained."
                  : "The selection is recorded; nothing is provisioned until an operator arms it or presses Provision now."
          }
        />
      </div>
      {changesSelection && (
        <p className="text-xs text-warning">
          Saving changes what a signature provisions
          {armed ? " and disarms it — re-arm once the offer is final" : ""}.
        </p>
      )}
      {unprovisioned.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not provisioned automatically — no catalogue module: {unprovisioned.join(", ")}.
        </p>
      )}
      {action}
    </Panel>
  );
}

/* ───────────────────────────── document review ───────────────────────────── */

/**
 * Every field the agreement prints, as it prints it, and Schedule A4's record
 * for each line — read here before the document is previewed or sent.
 */
export function OfferDocumentReview({
  view,
  defaultOpen = false,
}: {
  view: OfferView;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = useMemo(() => reviewRows(view), [view]);
  return (
    <section className="glass p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="offer-document-review"
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="label-mono block">the document</span>
          <span className="font-display mt-1 block text-xl">Every field as it prints</span>
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <div id="offer-document-review" className="mt-4 space-y-6">
          <dl className="divide-y divide-border/40">
            {rows.map((r) => (
              <div key={r.tag} className="grid gap-1 py-2 md:grid-cols-[16rem_1fr] md:gap-4">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd
                  className={cn(
                    "whitespace-pre-wrap text-sm",
                    r.text.trim() ? "text-foreground" : "italic text-muted-foreground",
                  )}
                >
                  {r.text.trim() || "Blank"}
                </dd>
              </div>
            ))}
          </dl>
          {view.records.length > 0 && (
            <div className="space-y-3">
              <p className="label-mono">schedule A4 · additional purchases</p>
              {view.records.map((rec, i) => (
                <div key={`${rec.label}-${i}`} className="glass-inset p-3">
                  <p className="text-sm font-medium text-foreground">
                    A4-{i + 1} · {rec.label}
                  </p>
                  <dl className="mt-2 divide-y divide-border/40">
                    {Object.entries(rec.record).map(([k, v]) => (
                      <div key={k} className="grid gap-1 py-1.5 md:grid-cols-[14rem_1fr] md:gap-4">
                        <dt className="text-xs text-muted-foreground">
                          {ADDITIONAL_LINE_LABELS[k as keyof typeof ADDITIONAL_LINE_LABELS] ?? k}
                        </dt>
                        <dd className="whitespace-pre-wrap text-xs text-foreground">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
