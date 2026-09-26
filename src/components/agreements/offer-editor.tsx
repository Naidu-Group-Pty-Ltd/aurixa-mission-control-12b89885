import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MoneyInput } from "@/components/agreements/money-input";
import {
  aud,
  communicationsInScope,
  gapCountsBySection,
  gapsByInput,
  longDate,
  OFFER_SECTIONS,
  sectionOfGap,
  serviceMatchesProfile,
  SERVICE_FIELDS,
  tierSummary,
  USAGE_FIELDS,
  withProfileService,
  withProfileUsage,
  type OfferSection,
  type OfferView,
} from "@/lib/agreements/offerEditor.pure";
import {
  COMMITMENT_MONTHS,
  formatCount,
  priceBase,
  readIdentifier,
  type SubscriptionTerm,
} from "@/lib/agreements/subscriptionPricing.pure";
import type {
  AddonLine,
  ComposeGap,
  IssuingProfile,
  RateCard,
  SubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import {
  A3_INCLUDED,
  a3Item,
  EXTRA_SEAT_KEY,
  purchasableItems,
  SUBSCRIPTION_TIER_SLUGS,
} from "@/lib/agreements/subscriptionTemplates";

export type OfferEditorProps = {
  offer: SubscriptionOffer;
  onChange: (next: SubscriptionOffer) => void;
  /** An issued offer, or one being sent: shown, never edited. */
  readOnly: boolean;
  /** The live composition's view (lines and gaps). */
  view: OfferView;
  /** The current issuing profile, for "apply" and the drift notice; null while loading. */
  profile: IssuingProfile | null;
  profileUpdatedAt: string | null;
  rateCard: RateCard | null;
  /**
   * Where `rateCard` came from: the live table (a draft, or a send still
   * running) or the snapshot an issued offer was sent with. The note under
   * the rate card says which, because an issued offer is a record and
   * "read live" would describe a table it no longer follows.
   */
  rateCardFrom?: "live" | "issued";
};

const TERMS: ReadonlyArray<{ id: SubscriptionTerm; label: string; detail: string }> = [
  { id: "flexible", label: "Flexible", detail: "Month to month, no commitment" },
  {
    id: "committed_monthly",
    label: "12 months · monthly",
    detail: "15% off the base; 12 monthly instalments",
  },
  {
    id: "committed_annual",
    label: "12 months · prepaid",
    detail: "15% off the base; the base prepaid once a year",
  },
];

function newLineId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The offer, section by section, in the document's own order. Every input
 * sits beside the gap that names it; every section counts what it still
 * lacks. Nothing here computes a price — the composer does, and the summary
 * beside this shows it.
 */
export function OfferEditor({
  offer,
  onChange,
  readOnly,
  view,
  profile,
  profileUpdatedAt,
  rateCard,
  rateCardFrom = "live",
}: OfferEditorProps) {
  const byInput = useMemo(() => gapsByInput(view.gaps), [view.gaps]);
  const counts = useMemo(() => gapCountsBySection(view.gaps), [view.gaps]);
  const gapsOf = (key: string) => byInput.get(key) ?? [];

  const patch = (p: Partial<SubscriptionOffer>) => onChange({ ...offer, ...p });
  const patchCustomer = (p: Partial<SubscriptionOffer["customer"]>) =>
    onChange({ ...offer, customer: { ...offer.customer, ...p } });
  const patchSignatory = (p: Partial<SubscriptionOffer["signatory"]>) =>
    onChange({ ...offer, signatory: { ...offer.signatory, ...p } });
  const patchUsage = (p: Partial<SubscriptionOffer["usage"]>) =>
    onChange({ ...offer, usage: { ...offer.usage, ...p } });
  const patchService = (p: Partial<SubscriptionOffer["service"]>) =>
    onChange({ ...offer, service: { ...offer.service, ...p } });
  const patchLine = (index: number, p: Partial<AddonLine>) =>
    onChange({
      ...offer,
      addons: offer.addons.map((l, i) => (i === index ? { ...l, ...p } : l)),
    });

  /** Section-level gaps: the ones with no input of their own on the page. */
  const looseGaps = (section: OfferSection, inline: readonly string[]) =>
    view.gaps.filter(
      (g) =>
        sectionOfGap(g.key) === section &&
        !inline.includes(g.key) &&
        !inline.some((k) => byInput.has(k) && gapsOf(k).includes(g.message)) &&
        !/^(addons|oneOffCharges)\.\d+$/.test(g.key),
    );

  const withAml = offer.aml === "with";
  const committed = offer.term !== "flexible";
  const summary = tierSummary(offer.tier);
  const identifier = offer.customer.identifier.trim()
    ? readIdentifier(offer.customer.identifier)
    : null;
  const comms = communicationsInScope(offer);
  const serviceCurrent = profile ? serviceMatchesProfile(offer, profile) : true;

  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-6">
      <legend className="sr-only">Offer</legend>

      {/* ── Order ── */}
      <OfferSectionPanel id="order" gapCount={counts.order}>
        <div className="space-y-2">
          <p className="label-mono">tier</p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tier">
            {SUBSCRIPTION_TIER_SLUGS.map((t) => {
              const s = tierSummary(t);
              const active = offer.tier === t;
              return (
                <ChoiceTile
                  key={t}
                  active={active}
                  onSelect={() => patch({ tier: t })}
                  title={s.name}
                  detail={`${aud(withAml ? s.withAmlCents : s.withoutAmlCents)} / month · ${s.seats}`}
                />
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="label-mono">AML option</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="AML option">
              {(["with", "without"] as const).map((a) => (
                <ChoiceTile
                  key={a}
                  active={offer.aml === a}
                  onSelect={() => patch({ aml: a })}
                  title={a === "with" ? "With AML" : "Without AML"}
                  detail={`${aud(a === "with" ? summary.withAmlCents : summary.withoutAmlCents)} / month`}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="label-mono">term and payment</p>
            <div className="grid gap-2" role="radiogroup" aria-label="Term">
              {TERMS.map((t) => {
                const base = priceBase(offer.tier, withAml, t.id);
                const price =
                  t.id === "committed_annual"
                    ? `${aud(base.annualPrepaymentCents ?? 0)} / year`
                    : `${aud(base.netMonthlyCents)} / month`;
                return (
                  <ChoiceTile
                    key={t.id}
                    compact
                    active={offer.term === t.id}
                    onSelect={() =>
                      patch({
                        term: t.id,
                        // Only a committed term can fix a line (clause 5.4).
                        addons:
                          t.id === "flexible"
                            ? offer.addons.map((l) => ({ ...l, term: "flexible" as const }))
                            : offer.addons,
                      })
                    }
                    title={t.label}
                    detail={`${t.detail} · base ${price}`}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="offer-activation"
            label="Planned activation"
            type="date"
            value={offer.activationDate}
            onChange={(v) => patch({ activationDate: v })}
            gaps={gapsOf("activationDate")}
            hint={
              view.dates
                ? `Renews monthly on day ${view.dates.anchorDay}${view.dates.commitmentLastDay ? `; commitment's last day ${longDate(view.dates.commitmentLastDay)}` : ""}. If paid activation is recorded on another date, every date moves with it (clause 5.3).`
                : "The day paid activation is planned. It cannot be backdated (clause 4.5)."
            }
          />
          <div className="space-y-1.5">
            <TextField
              id="offer-payment-method"
              label="Payment method"
              value={offer.paymentMethod}
              onChange={(v) => patch({ paymentMethod: v })}
              maxLength={300}
              placeholder="Card through Stripe"
              gaps={gapsOf("paymentMethod")}
              hint="Printed in the payment schedule."
            />
            {profile?.defaultPaymentMethod &&
              profile.defaultPaymentMethod.trim() !== offer.paymentMethod.trim() &&
              !readOnly && (
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="h-auto px-0 text-xs"
                  onClick={() => patch({ paymentMethod: profile.defaultPaymentMethod })}
                >
                  Use the profile default — {profile.defaultPaymentMethod}
                </Button>
              )}
          </div>
        </div>
        <LooseGaps gaps={looseGaps("order", ["activationDate", "paymentMethod"])} />
      </OfferSectionPanel>

      {/* ── Customer ── */}
      <OfferSectionPanel id="customer" gapCount={counts.customer}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="offer-legal-name"
            label="Legal name"
            value={offer.customer.legalName}
            onChange={(v) => patchCustomer({ legalName: v })}
            maxLength={300}
            placeholder="Example Property Advisory Pty Ltd"
            gaps={gapsOf("customer.legalName")}
            hint="The contracting entity exactly as registered."
          />
          <TextField
            id="offer-identifier"
            label="ABN, ACN or other identifier"
            value={offer.customer.identifier}
            onChange={(v) => patchCustomer({ identifier: v })}
            maxLength={80}
            placeholder="51 824 753 556"
            gaps={gapsOf("customer.identifier")}
            hint={
              identifier
                ? identifier.kind === "other"
                  ? `Printed as typed — not an ABN or ACN, so not check-digit tested.`
                  : identifier.valid
                    ? `${identifier.display} — check digits pass.`
                    : `${identifier.display} — check digits FAIL.`
                : "Eleven digits read as an ABN, nine as an ACN; both are check-digit tested."
            }
          />
        </div>
        <AreaField
          id="offer-address"
          label="Business address"
          rows={2}
          value={offer.customer.address}
          onChange={(v) => patchCustomer({ address: v })}
          maxLength={500}
          placeholder="Level 2, 10 Sample Road, Parramatta NSW 2150"
          gaps={gapsOf("customer.address")}
          hint="The confirmed business address for notices."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id="offer-notice-email"
            label="Legal notices email"
            type="email"
            value={offer.customer.noticeEmail}
            onChange={(v) => patchCustomer({ noticeEmail: v })}
            maxLength={254}
            placeholder="notices@customer.com.au"
            gaps={gapsOf("customer.noticeEmail")}
          />
          <TextField
            id="offer-billing-contact"
            label="Billing contact"
            optional
            value={offer.customer.billingContact}
            onChange={(v) => patchCustomer({ billingContact: v })}
            maxLength={300}
            placeholder="Same as legal notices"
            gaps={gapsOf("customer.billingContact")}
          />
        </div>
        <LooseGaps
          gaps={looseGaps("customer", [
            "customer.legalName",
            "customer.identifier",
            "customer.address",
            "customer.noticeEmail",
            "customer.billingContact",
          ])}
        />
      </OfferSectionPanel>

      {/* ── Signatory ── */}
      <OfferSectionPanel id="signatory" gapCount={counts.signatory}>
        <p className="text-sm text-muted-foreground">
          The person who accepts for the customer. DocuSign sends the envelope to this address and
          the signature is theirs — confirm they are authorised to bind the customer. No Aurixa
          countersignature is required (clause 1.2).
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <TextField
            id="offer-signatory-name"
            label="Name"
            value={offer.signatory.name}
            onChange={(v) => patchSignatory({ name: v })}
            maxLength={200}
            gaps={gapsOf("signatory.name")}
          />
          <TextField
            id="offer-signatory-role"
            label="Role"
            value={offer.signatory.role}
            onChange={(v) => patchSignatory({ role: v })}
            maxLength={200}
            placeholder="Director"
            gaps={gapsOf("signatory.role")}
          />
          <TextField
            id="offer-signatory-email"
            label="Verified signing email"
            type="email"
            value={offer.signatory.email}
            onChange={(v) => patchSignatory({ email: v })}
            maxLength={254}
            gaps={gapsOf("signatory.email")}
          />
        </div>
        <LooseGaps
          gaps={looseGaps("signatory", ["signatory.name", "signatory.role", "signatory.email"])}
        />
      </OfferSectionPanel>

      {/* ── Purchases ── */}
      <OfferSectionPanel id="purchases" gapCount={counts.purchases}>
        {A3_INCLUDED[offer.tier].length > 0 && (
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground">Included in {summary.name}:</span>{" "}
            {summary.included.join(", ")}. An included item has no separate access fee.
          </p>
        )}

        <div className="glass-inset flex flex-wrap items-center justify-between gap-4 p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Additional user seats</p>
            <p className="font-mono text-xs text-muted-foreground">
              {summary.includedSeats} included + {offer.extraSeats} purchased ={" "}
              {summary.includedSeats + offer.extraSeats} named internal users ·{" "}
              {aud(a3Item(EXTRA_SEAT_KEY)?.referenceMonthlyCents ?? 0)} per seat per month
            </p>
          </div>
          <Stepper
            label="Additional seats"
            value={offer.extraSeats}
            min={0}
            max={500}
            onChange={(n) => patch({ extraSeats: n })}
          />
        </div>

        {offer.addons.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No additional purchases — Schedule A4 prints “No additional purchases.”
          </p>
        ) : (
          <div className="space-y-3">
            {offer.addons.map((line, index) => (
              <AddonLineEditor
                key={line.id}
                line={line}
                index={index}
                committedTerm={committed}
                customerName={offer.customer.legalName}
                monthlyCents={view.lines.find((l) => l.key === line.itemKey)?.monthlyCents ?? null}
                gaps={gapsOf(`addons.${index}`)}
                onChange={(p) => patchLine(index, p)}
                onRemove={() => patch({ addons: offer.addons.filter((_, i) => i !== index) })}
              />
            ))}
          </div>
        )}

        {!readOnly && (
          <AddLinePicker
            offer={offer}
            onAdd={(itemKey) =>
              patch({
                addons: [
                  ...offer.addons,
                  {
                    id: newLineId(),
                    itemKey,
                    quantity: 1,
                    discountMonthlyCents: 0,
                    term: "flexible",
                    purchaser: "",
                    scope: "",
                    usageAndCosts: "",
                    permissions: "",
                  },
                ],
              })
            }
          />
        )}
        <LooseGaps gaps={looseGaps("purchases", [])} />
      </OfferSectionPanel>

      {/* ── Support and one-offs ── */}
      <OfferSectionPanel id="charges" gapCount={counts.charges}>
        <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="offer-support-fee">Additional support / month</Label>
            <MoneyInput
              id="offer-support-fee"
              cents={offer.supportFee.monthlyCents}
              onChange={(c) => patch({ supportFee: { ...offer.supportFee, monthlyCents: c } })}
              disabled={readOnly}
            />
          </div>
          <TextField
            id="offer-support-description"
            label="What it buys"
            value={offer.supportFee.description}
            onChange={(v) => patch({ supportFee: { ...offer.supportFee, description: v } })}
            maxLength={500}
            placeholder="Priority Support (4-hour business-day response)"
            gaps={gapsOf("supportFee.description")}
            hint="Standard Support is always included. An additional support fee is not discounted."
          />
        </div>

        <div className="space-y-2">
          <p className="label-mono">one-off charges · due at activation</p>
          {offer.oneOffCharges.length === 0 && (
            <p className="text-sm text-muted-foreground">No one-off charges.</p>
          )}
          {offer.oneOffCharges.map((charge, i) => {
            const messages = gapsOf(`oneOffCharges.${i}`);
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={`One-off charge ${i + 1} description`}
                    value={charge.description}
                    maxLength={300}
                    placeholder="Onboarding and data migration"
                    onChange={(e) =>
                      patch({
                        oneOffCharges: offer.oneOffCharges.map((c, j) =>
                          j === i ? { ...c, description: e.target.value } : c,
                        ),
                      })
                    }
                    className={cn(messages.length > 0 && "border-destructive")}
                  />
                  <MoneyInput
                    className="w-40 shrink-0"
                    cents={charge.amountCents}
                    disabled={readOnly}
                    onChange={(c) =>
                      patch({
                        oneOffCharges: offer.oneOffCharges.map((x, j) =>
                          j === i ? { ...x, amountCents: c } : x,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove one-off charge ${i + 1}`}
                    onClick={() =>
                      patch({ oneOffCharges: offer.oneOffCharges.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <GapMessages messages={messages} />
              </div>
            );
          })}
          {!readOnly && offer.oneOffCharges.length < 20 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                patch({
                  oneOffCharges: [...offer.oneOffCharges, { description: "", amountCents: 0 }],
                })
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add one-off charge
            </Button>
          )}
        </div>
        <LooseGaps gaps={looseGaps("charges", ["supportFee.description"])} />
      </OfferSectionPanel>

      {/* ── Usage authority ── */}
      <OfferSectionPanel
        id="usage"
        gapCount={counts.usage}
        action={
          profile && !readOnly ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(withProfileUsage(offer, profile))}
              title="Replace every authority below with the issuing profile's"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset to profile
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">
          Schedule A4 records what use is included and what extra spend is authorised. No recorded
          authority means no additional spend; included use continues.
        </p>

        <div className="glass-inset space-y-1 p-3">
          <p className="label-mono">report rate card · fixed jobs</p>
          {rateCard && rateCard.rows.length > 0 ? (
            <>
              <p className="text-sm text-foreground">
                {rateCard.rows
                  .map(
                    (r) =>
                      `${r.name} ${formatCount(r.credit_cost)} ${r.credit_cost === 1 ? "token" : "tokens"}`,
                  )
                  .join(" · ")}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {rateCardFrom === "issued"
                  ? `Rate-card version ${rateCard.version} — as this offer printed it when it was sent.`
                  : `Rate-card version ${rateCard.version} — read live, printed as it stands when the offer is sent.`}
              </p>
            </>
          ) : (
            <p className="text-sm text-destructive">
              The report rate card could not be read, so A4 cannot state each task's token cost.
              Nothing can be sent until it can.
            </p>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {USAGE_FIELDS.map((f) => {
            const outOfScope = (f.when === "aml" && !withAml) || (f.when === "comms" && !comms);
            if (outOfScope) {
              return (
                <div key={f.key} className="space-y-1.5">
                  <Label className="text-muted-foreground">{f.label}</Label>
                  <p className="glass-inset px-3 py-2 text-xs text-muted-foreground">
                    {f.when === "aml"
                      ? f.key === "amlAllowance"
                        ? "Not selected — Without AML"
                        : "Not applicable — no AML check or monitoring spend is authorised"
                      : f.key === "commsAllowance"
                        ? "Not selected — no chargeable email, SMS, voice or recording use is enabled by this offer"
                        : "Not applicable — no extra-use authority; period cap $0.00"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Printed automatically:{" "}
                    {f.when === "aml"
                      ? "the offer is Without AML."
                      : "nothing in this offer sends email, SMS or voice."}
                  </p>
                </div>
              );
            }
            return (
              <AreaField
                key={f.key}
                id={`offer-usage-${f.key}`}
                label={f.label}
                rows={f.rows}
                value={offer.usage[f.key]}
                onChange={(v) => patchUsage({ [f.key]: v })}
                maxLength={f.max}
                hint={f.hint}
                gaps={gapsOf(`usage.${f.key}`)}
              />
            );
          })}
        </div>
        <LooseGaps
          gaps={looseGaps(
            "usage",
            USAGE_FIELDS.map((f) => `usage.${f.key}`),
          ).filter((g) => g.key !== "rateCard")}
        />
      </OfferSectionPanel>

      {/* ── Service disclosures ── */}
      <OfferSectionPanel
        id="service"
        gapCount={counts.service}
        action={
          profile && !readOnly && !serviceCurrent ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange(withProfileService(offer, profile))}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Apply current profile
            </Button>
          ) : null
        }
      >
        {!serviceCurrent && (
          <p className="glass-inset spine spine-warn px-3 py-2 text-sm text-muted-foreground">
            These disclosures differ from the current{" "}
            <Link to="/agreements/issuing-profile" className="text-primary hover:underline">
              issuing profile
            </Link>
            {profileUpdatedAt ? ` (updated ${longDate(profileUpdatedAt.slice(0, 10))})` : ""}. An
            offer keeps the facts it was prepared with until you apply the new ones.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {SERVICE_FIELDS.map((f) => (
            <AreaField
              key={f.key}
              id={`offer-service-${f.key}`}
              label={f.label}
              rows={f.rows}
              value={offer.service[f.key]}
              onChange={(v) => patchService({ [f.key]: v })}
              maxLength={f.max}
              hint={f.hint}
              gaps={gapsOf(`service.${f.key}`)}
            />
          ))}
        </div>
        <LooseGaps
          gaps={looseGaps(
            "service",
            SERVICE_FIELDS.map((f) => `service.${f.key}`),
          )}
        />
      </OfferSectionPanel>

      {/* ── Departures ── */}
      <OfferSectionPanel id="departures" gapCount={counts.departures}>
        <AreaField
          id="offer-special-conditions"
          label="Negotiated departures"
          optional
          rows={4}
          value={offer.specialConditions}
          onChange={(v) => patch({ specialConditions: v })}
          maxLength={4000}
          gaps={gapsOf("specialConditions")}
          hint="Express legal departures from the standard terms. Blank prints “None”. Anything written here is a negotiated term of the agreement — have it approved before sending."
        />
        <AreaField
          id="offer-additional-documents"
          label="Documents supplied with this offer"
          optional
          rows={2}
          value={offer.additionalDocuments}
          onChange={(v) => patch({ additionalDocuments: v })}
          maxLength={1500}
          gaps={gapsOf("additionalDocuments")}
          hint="Beyond the standing list in the service disclosures. Printed under Additional applicable documents."
        />
        <LooseGaps gaps={looseGaps("departures", ["specialConditions", "additionalDocuments"])} />
      </OfferSectionPanel>
    </fieldset>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

function OfferSectionPanel({
  id,
  gapCount,
  action,
  children,
}: {
  id: OfferSection;
  gapCount: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const meta = OFFER_SECTIONS.find((s) => s.id === id)!;
  return (
    <section
      id={`offer-${id}`}
      aria-labelledby={`offer-${id}-title`}
      className="glass scroll-mt-24 space-y-4 p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-mono">{meta.part}</p>
          <h2 id={`offer-${id}-title`} className="font-display mt-1 text-xl">
            {meta.title}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {gapCount > 0 ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
              {gapCount} to complete
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-success">
              complete
            </span>
          )}
          {action}
        </div>
      </header>
      {children}
    </section>
  );
}

function ChoiceTile({
  active,
  onSelect,
  title,
  detail,
  compact,
}: {
  active: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "glass-inset spine text-left transition-colors disabled:cursor-not-allowed",
        compact ? "px-3 py-2" : "p-3",
        active ? "spine-live border-border-strong" : "spine-idle hover:border-border-strong",
      )}
    >
      <span
        className={cn(
          "block text-sm",
          active ? "font-semibold text-foreground" : "text-foreground/85",
        )}
      >
        {title}
      </span>
      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{detail}</span>
    </button>
  );
}

function GapMessages({ messages, id }: { messages: readonly string[]; id?: string }) {
  if (!messages.length) return null;
  return (
    <div id={id} className="space-y-0.5">
      {messages.map((m) => (
        <p key={m} className="text-xs text-destructive">
          {m}
        </p>
      ))}
    </div>
  );
}

function LooseGaps({ gaps }: { gaps: readonly ComposeGap[] }) {
  if (!gaps.length) return null;
  return (
    <div className="glass-inset spine spine-warn space-y-0.5 px-3 py-2">
      {gaps.map((g) => (
        <p key={`${g.key}|${g.message}`} className="text-xs text-destructive">
          {g.message}
        </p>
      ))}
    </div>
  );
}

function FieldLabel({ id, label, optional }: { id: string; label: string; optional?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <Label htmlFor={id}>{label}</Label>
      {optional && <span className="label-mono">optional</span>}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  gaps = [],
  hint,
  placeholder,
  type = "text",
  optional,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  gaps?: readonly string[];
  hint?: string;
  placeholder?: string;
  type?: string;
  optional?: boolean;
  maxLength?: number;
}) {
  const describedBy = [hint ? `${id}-hint` : null, gaps.length ? `${id}-gaps` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} optional={optional} />
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={gaps.length > 0 || undefined}
        aria-describedby={describedBy || undefined}
        className={cn(gaps.length > 0 && "border-destructive")}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <GapMessages id={`${id}-gaps`} messages={gaps} />
    </div>
  );
}

function AreaField({
  id,
  label,
  value,
  onChange,
  gaps = [],
  hint,
  placeholder,
  rows = 2,
  optional,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  gaps?: readonly string[];
  hint?: string;
  placeholder?: string;
  rows?: number;
  optional?: boolean;
  maxLength?: number;
}) {
  const describedBy = [hint ? `${id}-hint` : null, gaps.length ? `${id}-gaps` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} optional={optional} />
      <Textarea
        id={id}
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={gaps.length > 0 || undefined}
        aria-describedby={describedBy || undefined}
        className={cn("min-h-0 rounded-none", gaps.length > 0 && "border-destructive")}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <GapMessages id={`${id}-gaps`} messages={gaps} />
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.trunc(n)));
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label={`Fewer — ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Input
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        className="w-20 text-center font-mono tabular-nums"
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label={`More — ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function AddLinePicker({
  offer,
  onAdd,
}: {
  offer: SubscriptionOffer;
  onAdd: (itemKey: string) => void;
}) {
  // Uncontrolled and re-keyed after each add, so the picker always returns
  // to its placeholder rather than showing the line just added.
  const [round, setRound] = useState(0);
  const taken = new Set(offer.addons.map((l) => l.itemKey));
  const options = purchasableItems(offer.tier).filter((i) => !taken.has(i.key));
  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Every optional module is already on this offer or included in the tier.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        key={round}
        onValueChange={(v) => {
          onAdd(v);
          setRound((r) => r + 1);
        }}
      >
        <SelectTrigger className="w-80" aria-label="Add a module line">
          <SelectValue placeholder="Add an optional module…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((i) => (
            <SelectItem key={i.key} value={i.key}>
              {i.label} — {aud(i.referenceMonthlyCents ?? 0)} / month
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">
        Priced from Schedule A3 of this agreement. Builder / Developer Portal needs its own
        agreement; Lenders is not for sale.
      </span>
    </div>
  );
}

function AddonLineEditor({
  line,
  index,
  committedTerm,
  customerName,
  monthlyCents,
  gaps,
  onChange,
  onRemove,
}: {
  line: AddonLine;
  index: number;
  committedTerm: boolean;
  customerName: string;
  monthlyCents: number | null;
  gaps: readonly string[];
  onChange: (p: Partial<AddonLine>) => void;
  onRemove: () => void;
}) {
  const item = a3Item(line.itemKey);
  const id = `offer-line-${line.id}`;
  const gross = (item?.referenceMonthlyCents ?? 0) * line.quantity;
  return (
    <div
      className={cn("glass-inset spine space-y-3 p-3", gaps.length ? "spine-warn" : "spine-idle")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            A4-{index + 1} · {item?.label ?? line.itemKey}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {aud(item?.referenceMonthlyCents ?? 0)} per month each ·{" "}
            {item?.catalogSlug
              ? `a signature provisions ${item.catalogSlug}`
              : "no catalogue module — not provisioned automatically"}
            {monthlyCents !== null ? ` · line total ${aud(monthlyCents)} / month` : ""}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove ${item?.label ?? "line"}`}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-qty`}>Quantity</Label>
          <Input
            id={`${id}-qty`}
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            value={line.quantity}
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              if (Number.isFinite(n)) onChange({ quantity: Math.max(1, Math.min(999, n)) });
            }}
            className="font-mono tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-discount`}>Accepted discount / month</Label>
          <MoneyInput
            id={`${id}-discount`}
            cents={line.discountMonthlyCents}
            onChange={(c) => onChange({ discountMonthlyCents: c })}
          />
          <p className="text-[11px] text-muted-foreground">Of {aud(gross)} gross per month.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-term`}>Line term</Label>
          <Select
            value={line.term}
            onValueChange={(v) => onChange({ term: v as AddonLine["term"] })}
          >
            <SelectTrigger id={`${id}-term`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="flexible">Flexible — removable next renewal</SelectItem>
              <SelectItem value="committed" disabled={!committedTerm}>
                Committed to the base commitment
              </SelectItem>
            </SelectContent>
          </Select>
          {!committedTerm && (
            <p className="text-[11px] text-muted-foreground">
              Only a {COMMITMENT_MONTHS}-month committed base can fix a line.
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <AreaField
          id={`${id}-scope`}
          label={item?.requiresScope ? "Identified scope (required)" : "Scope and setup"}
          optional={!item?.requiresScope}
          rows={2}
          value={line.scope}
          onChange={(v) => onChange({ scope: v })}
          maxLength={1500}
          placeholder={`Standard ${item?.label ?? "module"} functionality as described in Schedules A3 and B`}
        />
        <TextField
          id={`${id}-purchaser`}
          label="Purchaser"
          optional
          value={line.purchaser}
          onChange={(v) => onChange({ purchaser: v })}
          maxLength={300}
          placeholder={customerName.trim() || "The customer"}
        />
        <AreaField
          id={`${id}-usage`}
          label="Usage and costs"
          optional
          rows={2}
          value={line.usageAndCosts}
          onChange={(v) => onChange({ usageAndCosts: v })}
          maxLength={1500}
          placeholder="Access only; no separate included quota or extra-spend authority"
        />
        <AreaField
          id={`${id}-permissions`}
          label="Permissions and terms"
          optional
          rows={2}
          value={line.permissions}
          onChange={(v) => onChange({ permissions: v })}
          maxLength={1500}
          placeholder="No additional data, partner or regulated-service permissions"
        />
      </div>
      <GapMessages messages={gaps} />
    </div>
  );
}
