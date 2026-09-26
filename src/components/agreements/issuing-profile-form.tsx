import { useMemo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  issuingProfileGaps,
  SERVICE_FIELDS,
  USAGE_FIELDS,
  type ProfileGap,
} from "@/lib/agreements/offerEditor.pure";
import { ZERO_AUTHORITY_USAGE, type IssuingProfile } from "@/lib/agreements/subscriptionOffer.pure";

const WEIGHT_TEXT: Record<ProfileGap["weight"], string> = {
  required: "text-warning",
  conditional: "text-warning/80",
  recommended: "text-muted-foreground",
};

const WEIGHT_WORD: Record<ProfileGap["weight"], string> = {
  required: "Needed",
  conditional: "Needed when in scope",
  recommended: "Recommended",
};

/**
 * Aurixa's standing facts — the Schedule E5 disclosures, the section 03
 * routes, the A4 spend authorities and the default payment method — edited
 * once and copied into every offer prepared afterwards.
 */
export function IssuingProfileForm({
  profile,
  onChange,
  readOnly,
}: {
  profile: IssuingProfile;
  onChange: (next: IssuingProfile) => void;
  readOnly: boolean;
}) {
  const gaps = useMemo(() => issuingProfileGaps(profile), [profile]);
  const gapOf = (key: string) => gaps.find((g) => g.key === key) ?? null;

  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-6">
      <legend className="sr-only">Issuing profile</legend>

      <ProfilePanel
        part="Schedule E5 · and section 03"
        title="Service disclosures"
        intro="Printed in every offer exactly as written here. Each is the standing statement for the service as Aurixa runs it today; an offer can still depart from it for one customer."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {SERVICE_FIELDS.map((f) => (
            <ProfileField
              key={f.key}
              id={`profile-service-${f.key}`}
              label={f.label}
              hint={f.hint}
              rows={f.rows}
              max={f.max}
              value={profile.service[f.key]}
              gap={gapOf(`service.${f.key}`)}
              onChange={(v) =>
                onChange({ ...profile, service: { ...profile.service, [f.key]: v } })
              }
            />
          ))}
        </div>
      </ProfilePanel>

      <ProfilePanel
        part="Schedule A4 · authorities"
        title="Usage and spend authority"
        intro="What use is included and what extra spend is authorised, by default. No recorded authority means no additional spend; included use continues. Where the variable-use and buffer rows are blank an offer starts with the agreement's own zero authority, shown greyed below."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {USAGE_FIELDS.map((f) => (
            <ProfileField
              key={f.key}
              id={`profile-usage-${f.key}`}
              label={f.label}
              hint={
                f.when === "aml"
                  ? `${f.hint} Printed only on offers With AML.`
                  : f.when === "comms"
                    ? `${f.hint} Printed only where the offer sends email, SMS or voice — Scale, or a line for Email Copilot, Call Logs or Marketing.`
                    : f.hint
              }
              rows={f.rows}
              max={f.max}
              placeholder={ZERO_AUTHORITY_USAGE[f.key]}
              value={profile.usage[f.key]}
              gap={gapOf(`usage.${f.key}`)}
              onChange={(v) => onChange({ ...profile, usage: { ...profile.usage, [f.key]: v } })}
            />
          ))}
        </div>
      </ProfilePanel>

      <ProfilePanel part="Section 02 · payment" title="Default payment method">
        <div className="max-w-xl">
          <ProfileField
            id="profile-payment-method"
            label="Payment method"
            hint="Printed in each offer's payment schedule unless the offer states another."
            rows={1}
            max={300}
            single
            placeholder="Card through Stripe"
            value={profile.defaultPaymentMethod}
            gap={gapOf("defaultPaymentMethod")}
            onChange={(v) => onChange({ ...profile, defaultPaymentMethod: v })}
          />
        </div>
      </ProfilePanel>
    </fieldset>
  );
}

function ProfilePanel({
  part,
  title,
  intro,
  children,
}: {
  part: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section className="glass space-y-4 p-5">
      <header>
        <p className="label-mono">{part}</p>
        <h2 className="font-display mt-1 text-xl">{title}</h2>
        {intro && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{intro}</p>}
      </header>
      {children}
    </section>
  );
}

function ProfileField({
  id,
  label,
  hint,
  rows,
  max,
  value,
  onChange,
  gap,
  placeholder,
  single,
}: {
  id: string;
  label: string;
  hint: string;
  rows: number;
  max: number;
  value: string;
  onChange: (v: string) => void;
  gap: ProfileGap | null;
  placeholder?: string;
  single?: boolean;
}) {
  const describedBy = [`${id}-hint`, gap ? `${id}-gap` : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {single ? (
        <Input
          id={id}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Textarea
          id={id}
          rows={rows}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-0 rounded-none"
        />
      )}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {gap && (
        <p id={`${id}-gap`} className={cn("text-xs", WEIGHT_TEXT[gap.weight])}>
          {WEIGHT_WORD[gap.weight]} — {gap.note}
        </p>
      )}
    </div>
  );
}
