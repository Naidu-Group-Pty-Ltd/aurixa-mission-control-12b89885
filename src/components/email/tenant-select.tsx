/**
 * Choosing which Microsoft tenant a campaign sends through.
 *
 * The deployment's own tenant is `null` and listed first. A tenant that was
 * removed, or whose credentials are missing, is not offered — but a campaign
 * that already names one still shows it, so the reason it cannot start is
 * visible rather than silently replaced.
 */
import { Link } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { hintLine, useMicrosoftTenants } from "@/components/email/use-microsoft-tenants";

const DEFAULT = "default";

export function TenantSelect({
  value,
  onChange,
  disabled,
  disabledReason,
  id,
}: {
  value: string | null;
  onChange: (tenantId: string | null, label: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  id?: string;
}) {
  const tenantsQuery = useMicrosoftTenants();
  const tenants = tenantsQuery.data?.tenants ?? [];
  const selectable = tenants.filter((tenant) => tenant.configured || tenant.id === value);
  const chosen = tenants.find((tenant) => (tenant.id ?? null) === (value ?? null)) ?? null;
  const missing = value !== null && !tenantsQuery.isLoading && !chosen;

  return (
    <div className="space-y-1">
      <Select
        value={value ?? DEFAULT}
        disabled={disabled || tenantsQuery.isLoading}
        onValueChange={(next) => {
          const tenantId = next === DEFAULT ? null : next;
          const label = tenants.find((tenant) => tenant.id === tenantId)?.label ?? "";
          onChange(tenantId, label);
        }}
      >
        <SelectTrigger id={id} title={disabled ? disabledReason : undefined}>
          <SelectValue placeholder={tenantsQuery.isLoading ? "Reading tenants…" : "Choose"} />
        </SelectTrigger>
        <SelectContent>
          {selectable.map((tenant) => (
            <SelectItem key={tenant.id ?? DEFAULT} value={tenant.id ?? DEFAULT}>
              {tenant.label}
              {tenant.configured ? "" : " — not configured"}
            </SelectItem>
          ))}
          {missing ? <SelectItem value={value}>A removed tenant</SelectItem> : null}
        </SelectContent>
      </Select>
      <p className="font-mono text-[10px] leading-snug text-muted-foreground">
        {disabled && disabledReason
          ? disabledReason
          : chosen
            ? [
                hintLine(chosen),
                chosen.verifyError ? `last check failed: ${chosen.verifyError}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Not configured"
            : missing
              ? "This tenant was removed — choose another."
              : null}{" "}
        <Link
          to="/email"
          search={{ tab: "tenants" }}
          className="underline-offset-2 hover:underline"
        >
          Manage tenants
        </Link>
      </p>
    </div>
  );
}
