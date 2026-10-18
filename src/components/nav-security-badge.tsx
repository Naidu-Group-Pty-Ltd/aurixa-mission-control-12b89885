import { useFleetSecurityBadge } from "@/lib/use-fleet-security-badge";
import { cn } from "@/lib/utils";

/**
 * Small severity indicator rendered next to the "Security Overview" nav item.
 * - Red pill with count when any critical findings are open (Prime + fleet).
 * - Amber pill with count when only high findings are open.
 * - Nothing when the fleet is clean.
 */
export function NavSecurityBadge() {
  const { totals, isLoading } = useFleetSecurityBadge();
  if (isLoading) return null;
  if (totals.critical === 0 && totals.high === 0) return null;

  const isCritical = totals.critical > 0;
  const value = isCritical ? totals.critical : totals.high;

  return (
    <span
      className={cn(
        "ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none",
        isCritical
          ? "bg-destructive/20 text-destructive ring-1 ring-destructive/40"
          : "bg-warning/20 text-warning ring-1 ring-warning/40",
      )}
      title={
        isCritical
          ? `${totals.critical} critical open finding${totals.critical === 1 ? "" : "s"}`
          : `${totals.high} high open finding${totals.high === 1 ? "" : "s"}`
      }
    >
      {value}
    </span>
  );
}
