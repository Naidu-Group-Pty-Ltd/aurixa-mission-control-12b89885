/**
 * Clone announcements — the pure rules, shared by the public route and the
 * operator console so the two can never disagree about who sees what.
 *
 * Three rules carry this module:
 *   * State is DERIVED, never stored (the activation gate's rule): a row's
 *     lifecycle is computed from its timestamps at every read, so no worker
 *     has to move a status and none can go stale.
 *   * NULL audience means everyone. A plan list narrows to those plans, a
 *     clone list narrows to those clones, and the two AND together — and the
 *     matcher the console previews with is the matcher the route serves with.
 *   * The wire projection leaks nothing: a clone is never told which plans or
 *     clones a notice targets, only what to draw. `WIRE_KEYS` exists so a
 *     test can assert the projection's exact surface instead of trusting it.
 */

export type AnnouncementSeverity = "info" | "success" | "warning" | "critical";
export type AnnouncementDisplay = "banner" | "modal";
export type AnnouncementState =
  | "draft"
  | "scheduled"
  | "active"
  | "expired"
  | "archived";

export const ANNOUNCEMENT_SEVERITIES: readonly AnnouncementSeverity[] = [
  "info",
  "success",
  "warning",
  "critical",
] as const;

export const ANNOUNCEMENT_DISPLAYS: readonly AnnouncementDisplay[] = [
  "banner",
  "modal",
] as const;

/** The columns of `clone_announcements` this module reasons over. Structural
 *  on purpose — the route hands it rows, the console hands it drafts. */
export interface AnnouncementFacts {
  id: string;
  title: string;
  body: string;
  link_url: string | null;
  link_label: string | null;
  severity: string;
  display: string;
  dismissible: boolean;
  audience_plan_slugs: string[] | null;
  audience_clone_ids: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  revision: number;
  published_at: string | null;
  archived_at: string | null;
}

/** What audience matching needs to know about a clone. `planSlug` is
 *  `clones.entitled_plan_slug` — the same authority the gate console lists. */
export interface AudienceClone {
  id: string;
  planSlug: string | null;
}

/** Derived lifecycle — never persisted anywhere. */
export function resolveAnnouncementState(
  row: Pick<
    AnnouncementFacts,
    "published_at" | "archived_at" | "starts_at" | "ends_at"
  >,
  now: Date = new Date(),
): AnnouncementState {
  if (row.archived_at) return "archived";
  if (!row.published_at) return "draft";
  if (row.starts_at && Date.parse(row.starts_at) > now.getTime()) {
    return "scheduled";
  }
  if (row.ends_at && Date.parse(row.ends_at) <= now.getTime()) {
    return "expired";
  }
  return "active";
}

/**
 * Does this announcement reach this clone? NULL lists match everyone; a plan
 * list can only match a clone whose entitled plan is known — a clone with no
 * plan on record is excluded from plan-scoped notices rather than guessed at.
 */
export function announcementReachesClone(
  row: Pick<AnnouncementFacts, "audience_plan_slugs" | "audience_clone_ids">,
  clone: AudienceClone,
): boolean {
  if (row.audience_clone_ids && !row.audience_clone_ids.includes(clone.id)) {
    return false;
  }
  if (row.audience_plan_slugs) {
    if (!clone.planSlug) return false;
    if (!row.audience_plan_slugs.includes(clone.planSlug)) return false;
  }
  return true;
}

/** What a clone is allowed to see. Exactly these keys, nothing else. */
export interface CloneAnnouncementWire {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  linkLabel: string | null;
  severity: AnnouncementSeverity;
  display: AnnouncementDisplay;
  dismissible: boolean;
  revision: number;
  publishedAt: string;
}

export const WIRE_KEYS: readonly (keyof CloneAnnouncementWire)[] = [
  "id",
  "title",
  "body",
  "linkUrl",
  "linkLabel",
  "severity",
  "display",
  "dismissible",
  "revision",
  "publishedAt",
] as const;

const isSeverity = (v: string): v is AnnouncementSeverity =>
  (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(v);
const isDisplay = (v: string): v is AnnouncementDisplay =>
  (ANNOUNCEMENT_DISPLAYS as readonly string[]).includes(v);

/**
 * Project a row onto the wire. Unknown vocabulary degrades to the mildest
 * reading (an info banner) rather than throwing — a clone dashboard must
 * render something sane whatever this table comes to hold — and a modal is
 * forced dismissible here as well as by the CHECK constraint, because the
 * projection is the last line before somebody's screen.
 */
export function toCloneWire(row: AnnouncementFacts): CloneAnnouncementWire {
  const display: AnnouncementDisplay = isDisplay(row.display)
    ? row.display
    : "banner";
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    linkLabel: row.link_url ? (row.link_label ?? row.link_url) : null,
    severity: isSeverity(row.severity) ? row.severity : "info",
    display,
    dismissible: display === "modal" ? true : row.dismissible,
    revision: row.revision,
    publishedAt: row.published_at ?? "",
  };
}

/** Newest first, capped — a dashboard is not a feed. */
export const MAX_WIRE_ANNOUNCEMENTS = 20;

export function activeAnnouncementsForClone(
  rows: AnnouncementFacts[],
  clone: AudienceClone,
  now: Date = new Date(),
): CloneAnnouncementWire[] {
  return rows
    .filter((row) => resolveAnnouncementState(row, now) === "active")
    .filter((row) => announcementReachesClone(row, clone))
    .sort(
      (a, b) =>
        (Date.parse(b.published_at ?? "") || 0) -
        (Date.parse(a.published_at ?? "") || 0),
    )
    .slice(0, MAX_WIRE_ANNOUNCEMENTS)
    .map(toCloneWire);
}

/** Console helper: say who a notice reaches, in words. */
export function audienceSummary(
  row: Pick<AnnouncementFacts, "audience_plan_slugs" | "audience_clone_ids">,
  cloneNamesById: Record<string, string> = {},
): string {
  const parts: string[] = [];
  if (row.audience_plan_slugs) {
    parts.push(`plans: ${row.audience_plan_slugs.join(", ")}`);
  }
  if (row.audience_clone_ids) {
    const names = row.audience_clone_ids.map(
      (id) => cloneNamesById[id] ?? `${id.slice(0, 8)}…`,
    );
    parts.push(`clones: ${names.join(", ")}`);
  }
  return parts.length === 0 ? "all clones" : parts.join(" · ");
}

/** One tone per state, in the console's spine vocabulary. */
export function announcementTone(
  state: AnnouncementState,
): "neutral" | "success" | "warning" | "danger" {
  switch (state) {
    case "active":
      return "success";
    case "scheduled":
      return "warning";
    case "expired":
    case "archived":
    case "draft":
      return "neutral";
  }
}

/** One sentence per state, for the row under the title. */
export function describeAnnouncementState(
  row: AnnouncementFacts,
  state: AnnouncementState,
): string {
  switch (state) {
    case "draft":
      return "A draft nobody can see. Publish it to put it in front of its audience.";
    case "scheduled":
      return `Published, waiting for its start time${row.starts_at ? ` (${row.starts_at})` : ""}.`;
    case "active":
      return row.ends_at
        ? "Live on every matching clone dashboard until its end time."
        : "Live on every matching clone dashboard until archived.";
    case "expired":
      return "Past its end time. It no longer renders anywhere; archive it to put it away.";
    case "archived":
      return "Archived. Kept for the record, served to nobody.";
  }
}
