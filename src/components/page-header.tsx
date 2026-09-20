import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard page header — codifies the dominant "mono eyebrow + title +
 * description + actions" pattern used across the app (dashboard, drift,
 * cascades, settings, …) so every screen renders it identically.
 *
 * This mirrors `dashboard.tsx`'s header, which is where it was extracted from.
 *
 * It is NOT a visual no-op on an arbitrary screen, and the comment that used to
 * say so was measured wrong on 20 Sep 2026. Two ways, both against the 44 route
 * files that still hand-roll a `font-display` <h1>:
 *
 *  - the gap. This draws `mt-2` between eyebrow and title; 23 of the 44 draw
 *    `mt-1`, 21 draw no `mt-` at all, and NONE draws `mt-2`. Adoption moves the
 *    title on every page it lands on.
 *  - the tier. `text-[2.125rem]` is hardcoded here and the pages use two sizes —
 *    26 at that, 18 at `text-[1.75rem] leading-[1.1]`, of which 11 are
 *    `settings.*` sub-pages under the settings tab strip and the rest are detail
 *    routes. That is a second level, applied consistently, and this component
 *    cannot express it.
 *
 * `docs/DESIGN_SYSTEM.md` carries the measurement. A `level` prop is the obvious
 * close for the second, and is deliberately not written until a page needs it.
 *
 * Usage:
 *   <PageHeader
 *     eyebrow="fleet-wide"
 *     title="Drift dashboard"
 *     description="All open AI suggestions across the fleet."
 *     actions={<Button>New</Button>}
 *   />
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  icon,
  breadcrumbs,
  className,
}: {
  /** Small mono uppercase kicker above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls (buttons, links). Wrap in a fragment for multiple. */
  actions?: ReactNode;
  /** Optional icon rendered inline before the title. */
  icon?: ReactNode;
  /** Optional composed `<Breadcrumb>` region rendered above the eyebrow. */
  breadcrumbs?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("space-y-4", className)}>
      {breadcrumbs}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="label-mono flex items-center gap-2">
              {/* A hard rule rather than a bullet — the eyebrow is a division
                  marker, and the line says so without adding an object. */}
              <span aria-hidden className="inline-block h-px w-6 bg-border-strong" />
              {eyebrow}
            </p>
          )}
          <h1
            className={cn(
              "font-display mt-2 text-[2.125rem] leading-[1.05]",
              icon && "flex items-center gap-2",
            )}
          >
            {icon}
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2 md:justify-end">{actions}</div>}
      </div>
    </header>
  );
}
