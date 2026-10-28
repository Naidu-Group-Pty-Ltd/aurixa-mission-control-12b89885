/**
 * The free-trial picker: the platform default, a preset or typed number of
 * days, or a trial offer.
 *
 * Shared by the New Clone wizard and an agreement's provisioning settings, so
 * the two ways a workspace is provisioned offer the same choices and say the
 * same thing about them. The choice resolves through `resolveTrialChoice`,
 * the function the caller arms with, so the summary under the field is the
 * trial the workspace gets.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeWindowHours, GATE_DEFAULT_HOURS } from "@/lib/clonePaymentGate.pure";
import {
  TRIAL_LENGTH_PRESET_DAYS,
  pickableOffers,
  resolveTrialChoice,
  type TrialChoice,
  type TrialOfferSummary,
} from "@/lib/trialOffers.pure";

const DEFAULT_VALUE = "default";
const CUSTOM_VALUE = "custom";
const presetValue = (days: number) => `days:${days}`;
const offerValue = (id: string) => `offer:${id}`;

function selectValueOf(choice: TrialChoice): string {
  if (choice.kind === "default") return DEFAULT_VALUE;
  if (choice.kind === "offer") return offerValue(choice.offerId);
  const n = Number(choice.days);
  return (TRIAL_LENGTH_PRESET_DAYS as readonly number[]).includes(n) && String(n) === choice.days
    ? presetValue(n)
    : CUSTOM_VALUE;
}

export function TrialLengthPicker({
  id,
  value,
  onChange,
  defaultHours,
  offers,
  offersError,
  disabled,
}: {
  id: string;
  value: TrialChoice;
  onChange: (next: TrialChoice) => void;
  /** The live platform default, for the label. Null while it loads. */
  defaultHours: number | null;
  offers: readonly TrialOfferSummary[];
  /** Why the offers could not be listed, if they could not. */
  offersError?: string | null;
  disabled?: boolean;
}) {
  const selected = selectValueOf(value);
  const listed = pickableOffers(offers);
  // An agreement can hold an offer that has since been retired. It stays
  // visible as the current choice, so it is changed deliberately rather than
  // vanishing from a dropdown that then shows nothing.
  const heldOffer =
    value.kind === "offer" && !listed.some((o) => o.id === value.offerId)
      ? offers.find((o) => o.id === value.offerId)
      : undefined;
  const resolved = resolveTrialChoice(value, { offers, defaultHours });

  function pick(next: string) {
    if (next === DEFAULT_VALUE) onChange({ kind: "default" });
    else if (next === CUSTOM_VALUE)
      onChange({ kind: "days", days: value.kind === "days" ? value.days : "" });
    else if (next.startsWith("days:")) onChange({ kind: "days", days: next.slice(5) });
    else if (next.startsWith("offer:")) onChange({ kind: "offer", offerId: next.slice(6) });
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Free trial</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={pick} disabled={disabled}>
          <SelectTrigger id={id} className="w-72" aria-label="Free trial length">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VALUE}>
              Platform default ({describeWindowHours(defaultHours ?? GATE_DEFAULT_HOURS)})
            </SelectItem>
            <SelectGroup>
              <SelectLabel>Length</SelectLabel>
              {TRIAL_LENGTH_PRESET_DAYS.map((days) => (
                <SelectItem key={days} value={presetValue(days)}>
                  {days} days
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_VALUE}>Custom number of days…</SelectItem>
            </SelectGroup>
            {(listed.length > 0 || heldOffer) && (
              <SelectGroup>
                <SelectLabel>Trial offers</SelectLabel>
                {listed.map((offer) => (
                  <SelectItem key={offer.id} value={offerValue(offer.id)}>
                    {offer.label} — {offer.trial_days} days ({offer.code})
                  </SelectItem>
                ))}
                {heldOffer && (
                  <SelectItem value={offerValue(heldOffer.id)}>
                    {heldOffer.label} — retired
                  </SelectItem>
                )}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
        {selected === CUSTOM_VALUE && value.kind === "days" && (
          <Input
            aria-label="Trial length in days"
            inputMode="numeric"
            value={value.days}
            onChange={(e) => onChange({ kind: "days", days: e.target.value })}
            placeholder="Days"
            className="w-24"
            disabled={disabled}
          />
        )}
      </div>
      {resolved.ok ? (
        <p className="text-xs text-muted-foreground">
          {value.kind === "default"
            ? `The platform default as it stands when the workspace is provisioned — ${describeWindowHours(defaultHours ?? GATE_DEFAULT_HOURS)} today.`
            : resolved.offerCode
              ? `${resolved.summary}, from offer ${resolved.offerCode}.`
              : `A ${resolved.days}-day free trial.`}{" "}
          Counted from the moment it is provisioned, and extendable later from Billing → Payment
          Gates.
        </p>
      ) : (
        <p className="text-xs text-destructive">{resolved.error}</p>
      )}
      {offersError && (
        <p className="text-xs text-warning">
          {offersError === "schema_pending"
            ? "Trial offers are not in the database yet, so only lengths can be picked."
            : `Trial offers could not be loaded (${offersError}), so only lengths can be picked.`}
        </p>
      )}
    </div>
  );
}
