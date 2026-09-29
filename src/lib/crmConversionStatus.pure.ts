/**
 * A CRM conversion's status vocabulary and its one-line reading.
 *
 * Shared by the clone page and the server. It lives under `lib/` because the
 * page renders it, and TanStack Start's import protection refuses any client
 * module that imports from `server/`. `src/server/crmConversion.pure.ts`
 * re-exports all of it, so there is one copy.
 */
import { crmModeLabel } from "@/lib/crmMode.pure";

/**
 * `clone_crm_conversions.status`.
 *
 *  - `proposed`  — the slot is claimed; the pull request is being built or is
 *                  open. A row in this state with no pull request is one still
 *                  being proposed, or one whose proposal died.
 *  - `merged`    — the pull request landed; finalising has not completed yet.
 *                  The finaliser is idempotent and retried from here.
 *  - `completed` — the clone's record, functions and pointer have moved.
 *  - `cancelled` — closed unmerged, or withdrawn by an operator. Nothing moved.
 *  - `failed`    — the proposal could not be built, or finalising was refused.
 */
export const CONVERSION_STATUSES = [
  "proposed",
  "merged",
  "completed",
  "cancelled",
  "failed",
] as const;

export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/** A conversion in either of these states holds the clone: one at a time. */
export const OPEN_CONVERSION_STATUSES = [
  "proposed",
  "merged",
] as const satisfies readonly ConversionStatus[];

export function isOpenConversionStatus(status: string | null | undefined): boolean {
  return status === "proposed" || status === "merged";
}

/** One line an operator reads on the clone's page for a conversion row. */
export function describeConversion(row: {
  status: string;
  from_mode: string;
  to_mode: string;
  pr_number: number | null;
  error: string | null;
}): string {
  const arrow = `${crmModeLabel(row.from_mode)} → ${crmModeLabel(row.to_mode)}`;
  const pr = row.pr_number ? ` (pull request #${row.pr_number})` : "";
  switch (row.status) {
    case "proposed":
      return row.pr_number
        ? `${arrow}: proposed${pr} — merge it to convert, close it to cancel.`
        : `${arrow}: being proposed.`;
    case "merged":
      return `${arrow}: merged${pr}; finishing.`;
    case "completed":
      return `${arrow}: completed${pr}.`;
    case "cancelled":
      return `${arrow}: cancelled${pr}${row.error ? ` — ${row.error}` : ""}.`;
    case "failed":
      return `${arrow}: failed${row.error ? ` — ${row.error}` : ""}.`;
    default:
      return `${arrow}: ${row.status}.`;
  }
}
